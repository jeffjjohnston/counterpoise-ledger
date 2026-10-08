//! Maintenance commands that run outside the HTTP server.
//!
//! `rebuild-lots [--force]` regenerates investment lots and allocations from
//! investment splits, as the server's startup backfill does. It exits 1 on
//! failure, because a deploy that continues after a failed backfill serves
//! zero cost basis with no visible error.
//!
//! `seed [--book-id N | --reset] [--dataset ID] [--today YYYY-MM-DD]` writes
//! a sample dataset. `--dataset` selects the dataset; the default is
//! `household`. `--today` sets the date that the dataset counts back from;
//! the default is today. Without `--book-id`, the command also creates the
//! `admin` user and a book. `--reset` first deletes the database file and
//! creates it again from the migrations; it refuses while a server uses the
//! file.
//!
//! `migrate` creates the database file when it is missing and applies the
//! migrations. It refuses while a server uses the file; the server applies
//! them itself when it starts.
//!
//! `list-books` prints each book with its owner and ID.
//!
//! `import-postgres --from <postgres-url> --to <path>` converts the database
//! of the last PostgreSQL release into a new SQLite file and checks it. See
//! `import_postgres`.
//!
//! `backup [--dir D]` writes a checked copy of the database into D (default
//! `BACKUP_DIR`, else `backups`), as the scheduled backup does. It exits 1
//! when the copy fails `PRAGMA integrity_check`. It also writes the "backup"
//! status record, as the scheduled backup does, but only when the target is
//! the scheduler's directory: no `--dir`, or a `--dir` that is `BACKUP_DIR`
//! (else `/backups`). See `record_backup`.
//!
//! Every command uses the file that `DATABASE_PATH` names, default
//! `data/counterpoise.db`.
//!
//! `import-moneydance <path> --book-id N [options]` imports a Moneydance JSON
//! export into an existing book. One transaction holds the run, so a failure
//! leaves the book as it was.

mod import_moneydance;
mod import_postgres;

use ledger_db::engine::DbPool;
use std::{
    env,
    path::{Path, PathBuf},
    process::ExitCode,
    time::Instant,
};

use scrypt::{Params, scrypt};

type CliResult<T> = Result<T, Box<dyn std::error::Error>>;

/// The database file: `DATABASE_PATH`, default `data/counterpoise.db`.
fn database_path() -> PathBuf {
    env::var_os("DATABASE_PATH")
        .filter(|path| !path.is_empty())
        .map_or_else(|| PathBuf::from("data/counterpoise.db"), PathBuf::from)
}

/// A pool on the existing, migrated database. A server may use the same
/// file at the same time: SQLite serializes the writers.
async fn connect() -> CliResult<DbPool> {
    let path = database_path();
    if !path.exists() {
        return Err(format!(
            "no database at {}; run `ledger-cli migrate` or start the server first",
            path.display()
        )
        .into());
    }
    Ok(ledger_db::connect(&path, false)?)
}

/// Creates the file when it is missing and applies the migrations. Refuses
/// while a server holds the file.
async fn migrate(path: &Path) -> CliResult<()> {
    if let Some(parent) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    let _lock = ledger_db::lock_server(path)?;
    let pool = ledger_db::connect(path, true)?;
    let result = ledger_db::migrate(&pool).await;
    pool.close().await;
    Ok(result?)
}

/// Deletes the database file and its WAL files. Refuses while a server
/// holds the file.
fn delete_database(path: &Path) -> CliResult<()> {
    let _lock = ledger_db::lock_server(path)?;
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        match std::fs::remove_file(PathBuf::from(name)) {
            Err(cause) if cause.kind() != std::io::ErrorKind::NotFound => return Err(cause.into()),
            _ => {}
        }
    }
    Ok(())
}

/// Writes a checked backup. The directory is `--dir D`, else `BACKUP_DIR`,
/// else `backups`.
async fn backup(args: &[String]) -> CliResult<ledger_db::backup::Snapshot> {
    let explicit = match args.iter().position(|arg| arg == "--dir") {
        Some(index) => Some(PathBuf::from(
            args.get(index + 1).ok_or("--dir requires a directory")?,
        )),
        None => None,
    };
    let dir = explicit.clone().unwrap_or_else(|| {
        env::var_os("BACKUP_DIR")
            .filter(|dir| !dir.is_empty())
            .map_or_else(|| PathBuf::from("backups"), PathBuf::from)
    });
    let pool = connect().await?;
    let snapshot = ledger_db::backup::snapshot(&pool, &dir).await;
    pool.close().await;
    if explicit.is_none() || is_scheduler_dir(&dir) {
        record_backup(&snapshot);
    }
    Ok(snapshot?)
}

/// The directory that the scheduled backup writes to: `BACKUP_DIR`, else
/// `/backups`.
fn scheduler_dir() -> PathBuf {
    env::var_os("BACKUP_DIR")
        .filter(|dir| !dir.is_empty())
        .map_or_else(|| PathBuf::from("/backups"), PathBuf::from)
}

/// Whether `dir` is the scheduler's backup directory, by canonical path.
fn is_scheduler_dir(dir: &std::path::Path) -> bool {
    same_directory(dir, &scheduler_dir())
}

fn same_directory(left: &std::path::Path, right: &std::path::Path) -> bool {
    matches!(
        (left.canonicalize(), right.canonicalize()),
        (Ok(left), Ok(right)) if left == right
    )
}

/// Writes the "backup" status record that the scheduled backup writes, so a
/// manual backup shows in `/api/system/status`. It runs only for a backup
/// into the scheduler's own directory (no `--dir`, or a `--dir` that is that
/// directory). A copy in any other directory, such as a snapshot for a
/// development copy, must not replace the record of the scheduled backup.
/// Without a status directory (`job_status::configured_status_dir`), this
/// does nothing. A failure to write is not an error of the backup.
fn record_backup(snapshot: &Result<ledger_db::backup::Snapshot, String>) {
    if let Some(dir) = ledger_db::job_status::configured_status_dir() {
        record_backup_in(&dir, snapshot);
    }
}

fn record_backup_in(dir: &std::path::Path, snapshot: &Result<ledger_db::backup::Snapshot, String>) {
    use ledger_db::job_status::{Status, record_text, write_record};
    let problem = match snapshot {
        Ok(snapshot) => snapshot
            .problem
            .as_ref()
            .map(|problem| format!("integrity_check: {problem}")),
        Err(failure) => Some(failure.clone()),
    };
    // As the scheduled run: a copy that fails its check is a completed run
    // with `verified: false`. Only an error to make the copy is a failure.
    let status = Status {
        ok: snapshot.is_ok(),
        detail: problem.as_deref(),
        bytes: snapshot.as_ref().ok().map(|snapshot| snapshot.bytes),
        verified: snapshot.as_ref().ok().map(|snapshot| snapshot.verified),
        not_configured: false,
    };
    let text = record_text("backup", &status, chrono::Utc::now());
    let _ = write_record(dir, "backup", &text);
}

/// Each book with its owner, as `username | book name | book id`, sorted by
/// user, then book name (English collation), then ID.
async fn list_books() -> CliResult<String> {
    let pool = connect().await?;
    let mut rows: Vec<(String, String, i32)> = sqlx::query_as(
        "SELECT u.username, b.name, b.id FROM books b JOIN users u ON u.id = b.user_id",
    )
    .fetch_all(&pool)
    .await?;
    pool.close().await;
    let compare = ledger_core::collation::compare_names;
    rows.sort_by(|left, right| {
        compare(&left.0, &right.0)
            .then_with(|| compare(&left.1, &right.1))
            .then(left.2.cmp(&right.2))
    });
    Ok(format_books(&rows))
}

fn format_books(rows: &[(String, String, i32)]) -> String {
    if rows.is_empty() {
        return "No books found.".to_owned();
    }
    let headers = ["username", "book name", "book id"];
    let cells: Vec<[String; 3]> = rows
        .iter()
        .map(|(user, book, id)| [user.clone(), book.clone(), id.to_string()])
        .collect();
    let widths: Vec<usize> = (0..3)
        .map(|column| {
            cells
                .iter()
                .map(|row| row[column].chars().count())
                .chain([headers[column].len()])
                .max()
                .unwrap_or(0)
        })
        .collect();
    let line = |row: [&str; 3]| {
        row.iter()
            .zip(&widths)
            .map(|(cell, width)| format!("{cell:<width$}"))
            .collect::<Vec<_>>()
            .join(" | ")
    };
    let divider = widths
        .iter()
        .map(|width| "-".repeat(*width))
        .collect::<Vec<_>>()
        .join("-+-");
    let mut lines = vec![line(headers), divider];
    lines.extend(
        cells
            .iter()
            .map(|row| line([row[0].as_str(), row[1].as_str(), row[2].as_str()])),
    );
    lines.join("\n")
}

async fn rebuild_lots(force: bool) -> CliResult<ledger_db::lots::BackfillResult> {
    let pool = connect().await?;
    let result = ledger_db::lots::backfill_lots(&pool, force).await;
    pool.close().await;
    Ok(result?)
}

/// The `salt:key` hex format of `hashPassword` in `lib/auth.ts`.
fn hash_password(password: &str) -> CliResult<String> {
    let mut salt = [0_u8; 32];
    getrandom::fill(&mut salt)?;
    let params = Params::new(14, 8, 1, 64)?;
    let mut key = [0_u8; 64];
    scrypt(password.as_bytes(), &salt, &params, &mut key)?;
    Ok(format!("{}:{}", hex::encode(salt), hex::encode(key)))
}

/// The value after `--book-id`, or `None` for a full seed. An error holds
/// the message to print.
fn book_id_argument(args: &[String]) -> Result<Option<i32>, String> {
    let Some(index) = args.iter().position(|arg| arg == "--book-id") else {
        return Ok(None);
    };
    let Some(value) = args.get(index + 1) else {
        return Err("Error: --book-id requires a numeric argument".to_owned());
    };
    value
        .parse()
        .map(Some)
        .map_err(|_| format!("Error: invalid book ID \"{value}\""))
}

/// The value after `flag`, or `None` when the flag is absent. An error holds
/// the message to print.
fn flag_value<'a>(args: &'a [String], flag: &str) -> Result<Option<&'a str>, String> {
    let Some(index) = args.iter().position(|arg| arg == flag) else {
        return Ok(None);
    };
    args.get(index + 1)
        .map(|value| Some(value.as_str()))
        .ok_or_else(|| format!("Error: {flag} requires a value"))
}

/// The dataset of `--dataset`, default household.
fn dataset_argument(args: &[String]) -> Result<ledger_db::seed::DemoDataset, String> {
    use ledger_db::seed::DemoDataset;
    match flag_value(args, "--dataset")? {
        None => Ok(DemoDataset::Household),
        Some(id) => DemoDataset::from_id(id).ok_or_else(|| {
            let ids: Vec<&str> = DemoDataset::ALL.iter().map(|d| d.id()).collect();
            format!(
                "Error: unknown dataset \"{id}\". Use one of: {}",
                ids.join(", ")
            )
        }),
    }
}

/// The date of `--today`, default today in the local time zone (`TZ`), the
/// same value as `cp_today()`.
fn today_argument(args: &[String]) -> Result<chrono::NaiveDate, String> {
    match flag_value(args, "--today")? {
        None => Ok(chrono::Local::now().date_naive()),
        Some(text) => chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
            .map_err(|_| format!("Error: invalid date \"{text}\". Use YYYY-MM-DD")),
    }
}

/// Seeds `book_id`, or a new `admin` user and book when it is `None`. One
/// transaction holds the whole run, so a failure leaves no partial book.
async fn seed(
    book_id: Option<i32>,
    dataset: ledger_db::seed::DemoDataset,
    today: chrono::NaiveDate,
) -> CliResult<Result<(), String>> {
    use ledger_db::seed::DemoDataset;
    let pool = connect().await?;
    let mut transaction = ledger_db::locks::begin_pool(&pool).await?;
    let book_id = match book_id {
        Some(book_id) => {
            let name: Option<String> = sqlx::query_scalar("SELECT name FROM books WHERE id = $1")
                .bind(book_id)
                .fetch_optional(&mut *transaction)
                .await?;
            let Some(name) = name else {
                return Ok(Err(format!(
                    "Error: book {book_id} not found. Use 'ledger-cli list-books' to see available books."
                )));
            };
            println!("  Found book '{name}' (id: {book_id})");
            book_id
        }
        None => {
            let now = chrono::Utc::now().naive_utc();
            let user_id: i32 = sqlx::query_scalar(
                "INSERT INTO users (username, password_hash, created_at)
                 VALUES ('admin', $1, $2) RETURNING id",
            )
            .bind(hash_password("password")?)
            .bind(now)
            .fetch_one(&mut *transaction)
            .await?;
            // A trigger adds the creator as the owner of the book.
            let book_name = if dataset == DemoDataset::Household {
                "Family Finances"
            } else {
                dataset.book_name()
            };
            let book_id: i32 = sqlx::query_scalar(
                "INSERT INTO books (user_id, name, created_at, updated_at)
                 VALUES ($1, $2, $3, $3) RETURNING id",
            )
            .bind(user_id)
            .bind(book_name)
            .bind(now)
            .fetch_one(&mut *transaction)
            .await?;
            println!(
                "  Created user 'admin' (password: 'password') and book '{book_name}' (id: {book_id})"
            );
            book_id
        }
    };
    ledger_db::seed::seed_book(&mut transaction, book_id, dataset, today, &mut |line| {
        println!("{line}")
    })
    .await?;
    transaction.commit().await?;
    pool.close().await;
    Ok(Ok(()))
}

/// Imports a Moneydance export. The file is read and checked before the
/// transaction starts, so a bad file cannot clear the book.
async fn import(args: import_moneydance::ImportArgs) -> CliResult<Result<(), String>> {
    let started = Instant::now();
    let options = args.options;
    println!("╔═══════════════════════════════════════════════════════════╗");
    println!("║         Moneydance to Counterpoise Import Tool           ║");
    println!("╚═══════════════════════════════════════════════════════════╝");
    println!("\n⚙️  Import Options:");
    println!("  Book ID: {}", args.book_id);
    println!(
        "  Dry Run: {}",
        if options.dry_run {
            "Yes (no data will be written)"
        } else {
            "No"
        }
    );
    println!("  Overwrite Existing Data: {}", args.overwrite);
    println!("  Import Inactive: {}", options.import_inactive);
    println!("  Import Hidden: {}", options.import_hidden);
    println!("  Verbose: {}", options.verbose);
    if options.dry_run {
        println!("\n⚠️  DRY RUN MODE - No data will be written to database");
    }

    println!("\n📂 Loading {}...", args.file_path);
    let document = match std::fs::read_to_string(&args.file_path)
        .map_err(|error| error.to_string())
        .and_then(|content| serde_json::from_str(&content).map_err(|error| error.to_string()))
    {
        Ok(document) => document,
        Err(error) => return Ok(Err(format!("✗ Failed to load file: {error}"))),
    };
    println!("✓ Loaded in {:.2}s", started.elapsed().as_secs_f64());
    let export = match import_moneydance::Export::from_json(document) {
        Ok(export) => export,
        Err(message) => return Ok(Err(message)),
    };

    let pool = connect().await?;
    let mut transaction = ledger_db::locks::begin_pool(&pool).await?;
    let book: Option<String> = sqlx::query_scalar("SELECT name FROM books WHERE id = $1")
        .bind(args.book_id)
        .fetch_optional(&mut *transaction)
        .await?;
    if book.is_none() {
        return Ok(Err(format!(
            "Error: book {} not found. Use 'ledger-cli list-books' to see available books.",
            args.book_id
        )));
    }
    if args.overwrite && options.dry_run {
        println!("⚠️  --overwrite ignored in dry-run mode");
    } else if args.overwrite {
        println!("\n🧹 --overwrite enabled: clearing existing book data...");
        import_moneydance::overwrite_book(&mut transaction, args.book_id).await?;
        println!("✓ Cleared existing book data");
    }

    let today = chrono::Local::now().date_naive();
    let summary =
        import_moneydance::run_import(&mut transaction, &export, args.book_id, options, today)
            .await?;
    // A dry run writes nothing, and the rollback makes sure of it.
    if options.dry_run {
        transaction.rollback().await?;
    } else {
        transaction.commit().await?;
    }
    pool.close().await;

    println!("\n╔═══════════════════════════════════════════════════════════╗");
    println!("║                    Import Complete!                       ║");
    println!("╚═══════════════════════════════════════════════════════════╝");
    println!("\n📈 Final Statistics:");
    for line in &summary.lines {
        println!("{line}");
    }
    println!("\n⏱️  Total Time: {:.2}s", started.elapsed().as_secs_f64());
    if summary.errors > 0 {
        println!("\n⚠️  {} errors occurred during import", summary.errors);
        println!("See details above for specific error messages");
    }
    if options.dry_run {
        println!("\n✓ Dry run completed successfully");
        println!("  Run without --dry-run to perform actual import");
    } else {
        println!("\n✓ Import completed successfully");
    }
    Ok(Ok(()))
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("rebuild-lots") => {
            let force = args.iter().skip(1).any(|arg| arg == "--force");
            match rebuild_lots(force).await {
                Ok(result) if result.skipped => {
                    println!("Lot rebuild: already populated, skipping.");
                    ExitCode::SUCCESS
                }
                Ok(result) => {
                    println!(
                        "Lot rebuild: {} pair(s) across {} book(s).",
                        result.pairs_rebuilt, result.books_processed
                    );
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("Lot rebuild FAILED: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("migrate") => match migrate(&database_path()).await {
            Ok(()) => {
                println!("Migrations applied to {}.", database_path().display());
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("Migration FAILED: {error}");
                ExitCode::FAILURE
            }
        },
        Some("import-postgres") => {
            let parsed = match import_postgres::parse_args(&args[1..]) {
                Ok(parsed) => parsed,
                Err(message) => {
                    eprintln!("{message}");
                    return ExitCode::from(2);
                }
            };
            match import_postgres::run(&parsed).await {
                Ok(summary) => {
                    print!("{}", summary.text);
                    if summary.ok {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::FAILURE
                    }
                }
                Err(message) => {
                    eprintln!("Conversion refused or FAILED: {message}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("backup") => match backup(&args[1..]).await {
            Ok(snapshot) if snapshot.verified => {
                println!(
                    "Backup written: {} ({} bytes), integrity_check ok.",
                    snapshot.path.display(),
                    snapshot.bytes
                );
                ExitCode::SUCCESS
            }
            Ok(snapshot) => {
                eprintln!(
                    "Backup {} FAILED its check: {}",
                    snapshot.path.display(),
                    snapshot.problem.unwrap_or_default()
                );
                ExitCode::FAILURE
            }
            Err(error) => {
                eprintln!("Backup FAILED: {error}");
                ExitCode::FAILURE
            }
        },
        Some("list-books") => match list_books().await {
            Ok(table) => {
                println!("{table}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("Failed to list books: {error}");
                ExitCode::FAILURE
            }
        },
        Some("seed") => {
            // Parse the book first: `npm run db:seed -- --book-id <id>` also
            // passes --reset, and a reset must never delete the other books.
            let book_id = match book_id_argument(&args[1..]) {
                Ok(book_id) => book_id,
                Err(message) => {
                    eprintln!("{message}");
                    return ExitCode::FAILURE;
                }
            };
            let (dataset, today) = match dataset_argument(&args[1..])
                .and_then(|dataset| Ok((dataset, today_argument(&args[1..])?)))
            {
                Ok(pair) => pair,
                Err(message) => {
                    eprintln!("{message}");
                    return ExitCode::FAILURE;
                }
            };
            let reset = args.iter().skip(1).any(|arg| arg == "--reset");
            if reset && book_id.is_some() {
                println!("  --reset applies only to a full seed; the other books stay as they are");
            } else if reset {
                let path = database_path();
                if let Err(error) = delete_database(&path) {
                    eprintln!("Reset failed: {error}");
                    return ExitCode::FAILURE;
                }
                if let Err(error) = migrate(&path).await {
                    eprintln!("Migration FAILED: {error}");
                    return ExitCode::FAILURE;
                }
                println!("  Reset {}", path.display());
            }
            match seed(book_id, dataset, today).await {
                Ok(Ok(())) => ExitCode::SUCCESS,
                Ok(Err(message)) => {
                    eprintln!("{message}");
                    ExitCode::FAILURE
                }
                Err(error) => {
                    eprintln!("Seed failed: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        Some("import-moneydance") => {
            let rest = &args[1..];
            if import_moneydance::should_show_help(rest) {
                println!("{}", import_moneydance::USAGE);
                return ExitCode::SUCCESS;
            }
            let parsed = match import_moneydance::parse_args(rest) {
                Ok(parsed) => parsed,
                Err(message) => {
                    eprintln!("{message}");
                    return ExitCode::FAILURE;
                }
            };
            match import(parsed).await {
                Ok(Ok(())) => ExitCode::SUCCESS,
                Ok(Err(message)) => {
                    eprintln!("{message}");
                    ExitCode::FAILURE
                }
                Err(error) => {
                    eprintln!("\n❌ Fatal error: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => {
            eprintln!("usage: ledger-cli migrate");
            eprintln!("       ledger-cli rebuild-lots [--force]");
            eprintln!(
                "       ledger-cli seed [--book-id N | --reset] [--dataset ID] [--today YYYY-MM-DD]"
            );
            eprintln!("       ledger-cli list-books");
            eprintln!("       ledger-cli backup [--dir D]");
            eprintln!(
                "       ledger-cli import-postgres --from <postgres-url> --to <path> [--allow-unbalanced]"
            );
            eprintln!("       ledger-cli import-moneydance <path-to-json> --book-id N [options]");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use ledger_db::backup::Snapshot;

    fn read_backup_record(dir: &std::path::Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join("backup.json")).unwrap()).unwrap()
    }

    #[test]
    fn only_the_scheduler_directory_counts_as_the_scheduler_directory() {
        let root =
            std::env::temp_dir().join(format!("counterpoise-cli-dirs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (one, other) = (root.join("one"), root.join("other"));
        std::fs::create_dir_all(&one).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        // A path with `..` resolves to the same directory.
        assert!(super::same_directory(&one, &other.join("..").join("one")));
        assert!(!super::same_directory(&one, &other));
        assert!(!super::same_directory(&one, &root.join("missing")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_manual_backup_writes_the_backup_status_record() {
        let dir =
            std::env::temp_dir().join(format!("counterpoise-cli-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let copy = |verified: bool| {
            Ok(Snapshot {
                path: "counterpoise-x.db".into(),
                bytes: 4096,
                verified,
                problem: (!verified).then(|| "row 3 missing".to_owned()),
            })
        };

        super::record_backup_in(&dir, &copy(true));
        let record = read_backup_record(&dir);
        assert_eq!(record["job"], "backup");
        assert_eq!(record["lastOk"], record["lastRun"]);
        assert_eq!(record["verified"], true);
        assert_eq!(record["bytes"], 4096);
        assert_eq!(record["detail"], serde_json::Value::Null);

        // A copy that fails its check: the run completed, the copy is bad.
        super::record_backup_in(&dir, &copy(false));
        let record = read_backup_record(&dir);
        assert_eq!(record["lastOk"], record["lastRun"]);
        assert_eq!(record["verified"], false);
        assert_eq!(record["detail"], "integrity_check: row 3 missing");

        super::record_backup_in(&dir, &Err("disk full".to_owned()));
        let record = read_backup_record(&dir);
        assert_eq!(record["lastOk"], serde_json::Value::Null);
        assert_eq!(record["detail"], "disk full");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn seed_flags_parse_and_refuse() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            super::dataset_argument(&args(&[])).unwrap(),
            ledger_db::seed::DemoDataset::Household
        );
        assert!(
            super::dataset_argument(&args(&["--dataset", "nope"]))
                .unwrap_err()
                .contains("unknown dataset \"nope\"")
        );
        assert!(
            super::dataset_argument(&args(&["--dataset"]))
                .unwrap_err()
                .contains("--dataset requires a value")
        );
        assert_eq!(
            super::today_argument(&args(&["--today", "2025-12-31"])).unwrap(),
            chrono::NaiveDate::from_ymd_opt(2025, 12, 31).unwrap()
        );
        assert!(
            super::today_argument(&args(&["--today", "12/31/2025"]))
                .unwrap_err()
                .contains("invalid date")
        );
    }
}
