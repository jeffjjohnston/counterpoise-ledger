//! The schema migrations: the numbered files of `rust-api/db/migrations/`,
//! embedded in each binary, and the runner that applies them.
//!
//! The table `schema_migrations` records each applied file with the SHA-384
//! of its text. The runner refuses to start when an applied file has changed
//! or is gone, so a file is never edited after it ran. A database that sqlx
//! migrated has its rows in `_sqlx_migrations`, with the same checksums; the
//! first run copies them, so the file upgrades in place.

use crate::store::{Database, Error, Sql, params};
use sha2::{Digest, Sha384};
use std::fmt;

/// One migration file: `<version>_<description>.sql`.
#[derive(Clone, Copy, Debug)]
pub struct Migration {
    pub version: i64,
    /// The file name after the version, with spaces for underscores, as
    /// sqlx recorded it.
    pub description: &'static str,
    pub sql: &'static str,
}

impl Migration {
    /// The SHA-384 of the file's text, as sqlx computed it.
    pub fn checksum(&self) -> Vec<u8> {
        Sha384::digest(self.sql.as_bytes()).to_vec()
    }
}

/// Every migration file, in version order (`build.rs` writes the list).
pub static MIGRATIONS: &[Migration] = include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

/// Why the runner refused the database.
#[derive(Debug)]
pub enum MigrateError {
    /// An applied file has a different text now.
    Changed {
        version: i64,
    },
    /// An applied version has no file in this binary: the database is newer
    /// than the binary.
    Missing {
        version: i64,
    },
    /// sqlx recorded a migration that failed part way.
    Dirty {
        version: i64,
    },
    Database(Error),
}

impl fmt::Display for MigrateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Changed { version } => write!(
                f,
                "migration {version} was applied, but its file has changed since; \
                 restore the file and add the change as a new migration"
            ),
            Self::Missing { version } => write!(
                f,
                "migration {version} was applied, but this binary has no such file; \
                 the database is newer than the binary"
            ),
            Self::Dirty { version } => write!(
                f,
                "migration {version} failed part way (_sqlx_migrations.success = 0); \
                 restore a backup"
            ),
            Self::Database(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for MigrateError {}

impl From<Error> for MigrateError {
    fn from(error: Error) -> Self {
        Self::Database(error)
    }
}

const CREATE: &str = "CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    description TEXT NOT NULL,
    checksum BLOB NOT NULL,
    applied_at TEXT NOT NULL
)";

/// Applies the migrations that the file does not have yet, each in its own
/// write transaction with its `schema_migrations` row. Refuses, and applies
/// nothing, when an applied file has changed or is missing.
pub fn migrate(database: &Database) -> Result<(), MigrateError> {
    migrate_with(database, MIGRATIONS)
}

pub(crate) fn migrate_with(
    database: &Database,
    migrations: &[Migration],
) -> Result<(), MigrateError> {
    let applied = database.transaction(|tx| -> Result<Vec<(i64, Vec<u8>)>, MigrateError> {
        tx.exec_batch(CREATE)?;
        adopt_sqlx_rows(tx)?;
        Ok(tx.query(
            "SELECT version, checksum FROM schema_migrations ORDER BY version",
            &[],
        )?)
    })?;
    for (version, checksum) in &applied {
        match migrations
            .iter()
            .find(|migration| migration.version == *version)
        {
            None => return Err(MigrateError::Missing { version: *version }),
            Some(migration) if migration.checksum() != *checksum => {
                return Err(MigrateError::Changed { version: *version });
            }
            Some(_) => {}
        }
    }
    for migration in migrations {
        if applied
            .iter()
            .any(|(version, _)| *version == migration.version)
        {
            continue;
        }
        database.transaction(|tx| {
            tx.exec_batch(migration.sql)?;
            tx.execute(
                "INSERT INTO schema_migrations (version, description, checksum, applied_at)
                 VALUES (?1, ?2, ?3, ?4)",
                &params![
                    migration.version,
                    migration.description,
                    migration.checksum(),
                    chrono::Utc::now().naive_utc()
                ],
            )?;
            Ok::<_, Error>(())
        })?;
    }
    Ok(())
}

/// Copies the rows of sqlx's `_sqlx_migrations`, once, into an empty
/// `schema_migrations`. sqlx's checksum is the same SHA-384, so the copied
/// rows verify as they did under sqlx. A row that sqlx marked failed stops
/// the run, as sqlx stopped. The sqlx table stays, unread.
fn adopt_sqlx_rows(tx: &impl Sql) -> Result<(), MigrateError> {
    let has_sqlx: i64 = tx.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = '_sqlx_migrations'",
        &[],
    )?;
    let adopted: i64 = tx.query_row("SELECT COUNT(*) FROM schema_migrations", &[])?;
    if has_sqlx == 0 || adopted > 0 {
        return Ok(());
    }
    let dirty: Option<i64> = tx.query_optional(
        "SELECT version FROM _sqlx_migrations WHERE NOT success ORDER BY version",
        &[],
    )?;
    if let Some(version) = dirty {
        return Err(MigrateError::Dirty { version });
    }
    tx.execute(
        "INSERT INTO schema_migrations (version, description, checksum, applied_at)
         SELECT version, description, checksum, installed_on FROM _sqlx_migrations",
        &[],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file name under the temporary directory, removed when it drops.
    struct TempPath(std::path::PathBuf);

    impl Drop for TempPath {
        fn drop(&mut self) {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(crate::database::sidecar(&self.0, suffix));
            }
        }
    }

    impl std::ops::Deref for TempPath {
        type Target = std::path::Path;

        fn deref(&self) -> &std::path::Path {
            &self.0
        }
    }

    fn temp_path(name: &str) -> TempPath {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = TempPath(std::env::temp_dir().join(format!(
            "counterpoise-migrate-{name}-{}-{}.db",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )));
        drop(TempPath(path.0.clone()));
        path
    }

    fn versions(database: &Database) -> Vec<i64> {
        database
            .query(
                "SELECT version FROM schema_migrations ORDER BY version",
                &[],
            )
            .unwrap()
    }

    #[test]
    fn the_files_are_embedded_in_version_order() {
        assert!(MIGRATIONS.len() >= 13);
        assert_eq!(MIGRATIONS[0].version, 1);
        assert_eq!(MIGRATIONS[0].description, "baseline");
        assert!(
            MIGRATIONS
                .windows(2)
                .all(|pair| pair[0].version < pair[1].version)
        );
    }

    #[test]
    fn a_new_file_gets_every_migration_once() {
        let path = temp_path("new");
        let database = Database::open(&path, true).unwrap();
        migrate(&database).unwrap();
        let all: Vec<i64> = MIGRATIONS
            .iter()
            .map(|migration| migration.version)
            .collect();
        assert_eq!(versions(&database), all);
        // A second run applies nothing and refuses nothing.
        migrate(&database).unwrap();
        assert_eq!(versions(&database), all);
        let books: i64 = database
            .query_row("SELECT COUNT(*) FROM books", &[])
            .unwrap();
        assert_eq!(books, 0);
    }

    /// The rows that sqlx 0.8 wrote in `_sqlx_migrations` for migrations 1
    /// to 13, as the releases before this runner recorded them.
    const SQLX_ROWS: [(i64, &str, &str); 13] = [
        (
            1,
            "baseline",
            "A0AB31BB5DAC059CC1B485E94300C77547F1E5F7A867BE50BC091E0901B64CF7AA579BC17EF180C469ECD37D74758989",
        ),
        (
            2,
            "splits book account index",
            "85C18B68E101A5CECCFAFE3671684078FDFDAA86CD0E0B5B2B30894981F758A11E0A02EB2FC63885D4DEBE33A9A92409",
        ),
        (
            3,
            "transaction changes",
            "488851287BC2EC7EAD365F56459435835F052893D3FC83A782B5015DC44B94D584B7A50F22069C8EF8C4170A228B609F",
        ),
        (
            4,
            "mcp oauth",
            "DD47A0B0B8499B5415E08B1B27D70ED4BBAFFF67FFF9546CE1E65DDD2E1177B77FBBB6E679222386224E69E3F46AF4AF",
        ),
        (
            5,
            "plaid link sessions",
            "D405A83912B02BFC16DE9A352A8E33245705C694E68E2731ABC5122116484D954DBA56A4DF3B1419058024241FE30F6C",
        ),
        (
            6,
            "book reference checks",
            "A784E286F6583F1630EE99EC7DE77E98A86AFF83811E16FCC1B8E343E109A88D2CC01F6B32ABEB4EF7B4DEC9C274A31A",
        ),
        (
            7,
            "weekly review",
            "D8CCDF5195B09B8872AA700D5B1BFF4AA74C1127F64974783E01CB91A7DA539160610F0CBD4303BD545B149FEAE21949",
        ),
        (
            8,
            "typesafe entry",
            "D1EC927407584810F4797F6AAC746B0655D4FDFBF56FDF88807EF95BD57C0C35EBC213EB796D9C2320B1A66347B86342",
        ),
        (
            9,
            "payee name nocase",
            "11449BA4DEEA7755FA438DA37B9522361A4C3443F8C0FD87382C464A05D55C12F2AFE3BF84271902330EC812E1391103",
        ),
        (
            10,
            "issue report github",
            "AD65F1B6F4D9C6459B8F96570F37BDDF08870CD644CC4048D0F1EC7278BBC7948F21C9EB026BAC155119997DD5EF0D48",
        ),
        (
            11,
            "plaid token key",
            "3D4F49FE9C5F77BF94307E436C875B7A004FDBF8E6AFAF20FA7E5B9E715BF9357846AA394A0B32CA54A70DC3BF5CBA19",
        ),
        (
            12,
            "folded columns",
            "BB4615FC4BDD4A2D670BDE1A5796DA74BEA64ED6C5EC9D8A7373468DFE27EEC0FC8B7C9F64AF799125CB0ACF5A46E0AD",
        ),
        (
            13,
            "plaid merchant key",
            "4F8CFA034195708AAE93F35FAD2B344835FC956E4860B4D05F3CAC378769028F24AC64BC420B462254934794A6E02852",
        ),
    ];

    /// A file that sqlx migrated upgrades in place: the runner copies its
    /// rows, verifies them with the same checksums, and applies only what is
    /// new.
    #[test]
    fn a_file_that_sqlx_migrated_upgrades_in_place() {
        let path = temp_path("sqlx");
        let database = Database::open(&path, true).unwrap();
        // The file as the previous releases left it: the schema of the
        // migrations that sqlx ran, and its table of them.
        database
            .exec_batch(
                "CREATE TABLE _sqlx_migrations (
                    version BIGINT PRIMARY KEY,
                    description TEXT NOT NULL,
                    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    success BOOLEAN NOT NULL,
                    checksum BLOB NOT NULL,
                    execution_time BIGINT NOT NULL
                )",
            )
            .unwrap();
        for (version, description, checksum) in SQLX_ROWS {
            let file = MIGRATIONS.iter().find(|m| m.version == version).unwrap();
            database.exec_batch(file.sql).unwrap();
            database
                .execute(
                    "INSERT INTO _sqlx_migrations
                       (version, description, success, checksum, execution_time)
                     VALUES (?1, ?2, true, unhex(?3), 1)",
                    &params![version, description, checksum],
                )
                .unwrap();
        }

        migrate(&database).unwrap();
        let all: Vec<i64> = MIGRATIONS
            .iter()
            .map(|migration| migration.version)
            .collect();
        assert_eq!(versions(&database), all);
        let copied: Vec<(i64, String, Vec<u8>)> = database
            .query(
                "SELECT m.version, m.description, m.checksum FROM schema_migrations m
                 JOIN _sqlx_migrations s ON s.version = m.version
                 WHERE s.checksum = m.checksum AND s.description = m.description",
                &[],
            )
            .unwrap();
        assert_eq!(copied.len(), SQLX_ROWS.len());
        for (version, description, checksum) in copied {
            let file = MIGRATIONS.iter().find(|m| m.version == version).unwrap();
            assert_eq!(
                (description.as_str(), checksum),
                (file.description, file.checksum())
            );
        }
    }

    #[test]
    fn a_changed_or_missing_file_is_refused() {
        let path = temp_path("changed");
        let database = Database::open(&path, true).unwrap();
        let first = [
            Migration {
                version: 1,
                description: "one",
                sql: "CREATE TABLE one (id INTEGER PRIMARY KEY);",
            },
            Migration {
                version: 2,
                description: "two",
                sql: "CREATE TABLE two (id INTEGER PRIMARY KEY);",
            },
        ];
        migrate_with(&database, &first).unwrap();

        let mut changed = first;
        changed[1].sql = "CREATE TABLE two (id INTEGER PRIMARY KEY, x TEXT);";
        let error = migrate_with(&database, &changed).unwrap_err();
        assert!(
            matches!(error, MigrateError::Changed { version: 2 }),
            "{error}"
        );

        let error = migrate_with(&database, &first[..1]).unwrap_err();
        assert!(
            matches!(error, MigrateError::Missing { version: 2 }),
            "{error}"
        );

        // A failing migration leaves no row and no half-applied schema.
        let mut broken = first.to_vec();
        broken.push(Migration {
            version: 3,
            description: "three",
            sql: "CREATE TABLE three (id INTEGER PRIMARY KEY); INSERT INTO nowhere VALUES (1);",
        });
        assert!(migrate_with(&database, &broken).is_err());
        assert_eq!(versions(&database), [1, 2]);
        let three: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'three'",
                &[],
            )
            .unwrap();
        assert_eq!(three, 0);
    }

    #[test]
    fn a_failed_sqlx_migration_is_refused() {
        let path = temp_path("dirty");
        let database = Database::open(&path, true).unwrap();
        database
            .exec_batch(
                "CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL,
                   installed_on TIMESTAMP NOT NULL, success BOOLEAN NOT NULL,
                   checksum BLOB NOT NULL, execution_time BIGINT NOT NULL);
                 INSERT INTO _sqlx_migrations VALUES (1, 'one', '2026-01-01 00:00:00', 0, x'00', 1);",
            )
            .unwrap();
        let error = migrate_with(&database, &[]).unwrap_err();
        assert!(
            matches!(error, MigrateError::Dirty { version: 1 }),
            "{error}"
        );
    }
}
