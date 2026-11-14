//! Tests of migration 0019, which makes three tables again to give CHECK
//! constraints to four status columns. They show that the migration changes
//! only the CHECK clauses, keeps every row and ID counter, refuses each value
//! outside the sets, and leaves the file as it was when a row holds one.

use crate::{
    migrations::{migrate_with, through},
    store::{Database, Sql, params},
    testing::TempDatabase,
};

/// The last migration before the CHECK constraints, and the one with them.
const BEFORE: i64 = 18;
const AFTER: i64 = 19;

/// One column that migration 0019 constrains.
struct Check {
    table: &'static str,
    column: &'static str,
    /// The new clause as `plain` gives it: no whitespace.
    clause: &'static str,
    allowed: &'static [&'static str],
    /// The column also takes NULL.
    nullable: bool,
}

const CHECKS: [Check; 4] = [
    Check {
        table: "issue_reports",
        column: "status",
        clause: "CHECK(statusIN('new','resolved','wontfix'))",
        allowed: &["new", "resolved", "wontfix"],
        nullable: false,
    },
    Check {
        table: "typesafe_evaluations",
        column: "status",
        clause: "CHECK(statusIN('pending','ready','skipped','error','stale'))",
        allowed: &["pending", "ready", "skipped", "error", "stale"],
        nullable: false,
    },
    Check {
        table: "plaid_transaction_reconciliation",
        column: "resolution_status",
        clause: "CHECK(resolution_statusIN('pending','matched','created','ignored'))",
        allowed: &["pending", "matched", "created", "ignored"],
        nullable: false,
    },
    Check {
        table: "plaid_transaction_reconciliation",
        column: "review_reason",
        clause: "CHECK(review_reasonIN('plaid_modified','plaid_removed'))",
        allowed: &["plaid_modified", "plaid_removed"],
        nullable: true,
    },
];

/// The tables that the migration makes again.
const REBUILT: [&str; 3] = [
    "issue_reports",
    "typesafe_evaluations",
    "plaid_transaction_reconciliation",
];

/// The tables whose rows the migration reads or writes, and the two that
/// record its side effects: the ID counters and the change counts.
const WATCHED: [&str; 6] = [
    "issue_reports",
    "typesafe_evaluations",
    "typesafe_decisions",
    "plaid_transaction_reconciliation",
    "sqlite_sequence",
    "change_marks",
];

/// Values that no set holds. The test also gives each column the values of
/// the other columns' sets.
const REFUSED: [&str; 5] = ["", "bogus", "PENDING", " new", "done"];

/// The columns of a staged Plaid row without its ID.
const PLAID_COLUMNS: &str = "book_id, plaid_account_link_id, plaid_transaction_id, date,
    authorized_date, amount_cents, name, merchant_name, original_description, pending,
    pending_transaction_id, iso_currency_code, unofficial_currency_code, category_primary,
    category_detailed, raw_json, resolution_status, review_reason, review_metadata_json,
    matched_transaction_id, resolved_at, first_seen_at, last_seen_at, created_at, updated_at,
    merchant_key";

/// SQL text without whitespace and without the quotes that `ALTER TABLE ...
/// RENAME` puts around the new name.
fn plain(sql: &str) -> String {
    sql.chars()
        .filter(|c| !c.is_whitespace() && *c != '"')
        .collect()
}

fn lines(database: &Database, sql: &str) -> Vec<String> {
    database.query(sql, &[]).unwrap()
}

/// The whole schema, one line for each column, foreign key, index and
/// schema object. A column, a foreign key and an index are given as SQLite
/// reads them (the `table_xinfo`, `foreign_key_list`, `index_list` and
/// `index_xinfo` pragmas), so a difference in the text only does not show.
/// A trigger, an index and a table are also given with their text. The text
/// of a rebuilt table goes through `plain`; all other text is exact.
fn describe(database: &Database) -> Vec<String> {
    let mut all = lines(
        database,
        "SELECT concat_ws('|', 'column', m.name, c.cid, c.name, c.type, c.\"notnull\",
                coalesce(c.dflt_value, 'NULL'), c.pk, c.hidden)
         FROM sqlite_schema m, pragma_table_xinfo(m.name) c
         WHERE m.type = 'table' ORDER BY m.name, c.cid",
    );
    all.extend(lines(
        database,
        "SELECT concat_ws('|', 'foreign key', m.name, f.id, f.seq, f.\"table\", f.\"from\",
                coalesce(f.\"to\", ''), f.on_update, f.on_delete, f.\"match\")
         FROM sqlite_schema m, pragma_foreign_key_list(m.name) f
         WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq",
    ));
    all.extend(lines(
        database,
        "SELECT concat_ws('|', 'index', m.name, i.name, i.\"unique\", i.origin, i.partial,
                (SELECT group_concat(concat_ws(' ', x.seqno, x.cid, coalesce(x.name, ''),
                                               x.\"desc\", coalesce(x.coll, ''), x.key), ',')
                 FROM pragma_index_xinfo(i.name) x))
         FROM sqlite_schema m, pragma_index_list(m.name) i
         WHERE m.type = 'table' ORDER BY m.name, i.name",
    ));
    let objects: Vec<(String, String, String, String)> = database
        .query(
            "SELECT type, name, tbl_name, coalesce(sql, '') FROM sqlite_schema
             ORDER BY type, name",
            &[],
        )
        .unwrap();
    all.extend(objects.into_iter().map(|(kind, name, table, sql)| {
        let sql = if kind == "table" && REBUILT.contains(&name.as_str()) {
            plain(&sql)
        } else {
            sql
        };
        format!("{kind}|{name}|{table}|{sql}")
    }));
    all
}

/// Every row of `table`, each value as SQL's `quote()` prints it, so that
/// NULL, text and a number stay different.
fn rows(database: &Database, table: &str) -> Vec<String> {
    let columns: Vec<String> = database
        .query(
            "SELECT name FROM pragma_table_info(?1) ORDER BY cid",
            &params![table],
        )
        .unwrap();
    let values = columns
        .iter()
        .map(|column| format!("quote(\"{column}\")"))
        .collect::<Vec<_>>()
        .join(", ");
    lines(
        database,
        &format!("SELECT concat_ws('|', {values}) FROM \"{table}\" ORDER BY 1"),
    )
}

fn watched_rows(database: &Database) -> Vec<(&'static str, Vec<String>)> {
    WATCHED
        .iter()
        .map(|table| (*table, rows(database, table)))
        .collect()
}

fn count(database: &Database, sql: &str) -> i64 {
    database.query_row(sql, &[]).unwrap()
}

fn version(database: &Database) -> i64 {
    count(database, "SELECT max(version) FROM schema_migrations")
}

/// Fills the file with the sample book, and with rows that hold each
/// allowed value of each column. Each rebuilt table also gets a row that is
/// deleted again, so that its ID counter is past its largest ID.
fn fill(database: &Database) {
    database
        .exec_batch(
            "INSERT INTO users (id, username, password_hash, created_at)
               VALUES (1, 'u', 'h', '2025-01-01 00:00:00');
             INSERT INTO books (id, user_id, name, created_at, updated_at)
               VALUES (1, 1, 'B', '2025-01-01 00:00:00', '2025-01-01 00:00:00');",
        )
        .unwrap();
    database
        .transaction(|tx| {
            crate::seed::seed_book(
                tx,
                1,
                crate::seed::DemoDataset::Household,
                chrono::NaiveDate::from_ymd_opt(2026, 9, 15).unwrap(),
                &mut |_| {},
            )
        })
        .unwrap();
    database
        .exec_batch(&format!(
            "INSERT INTO issue_reports
               (user_id, description, type, page, status, created_at, github_issue_number)
             VALUES (1, 'a', 'bug', '/p', 'new', '2026-01-01 00:00:00', NULL),
                    (1, 'b', 'improvement', '/p', 'resolved', '2026-01-02 00:00:00', 7),
                    (1, 'c', 'other', '/p', 'wontfix', '2026-01-03 00:00:00', NULL),
                    (1, 'gone', 'bug', '/p', 'new', '2026-01-04 00:00:00', NULL);
             DELETE FROM issue_reports WHERE description = 'gone';

             INSERT INTO typesafe_evaluations
               (book_id, reconciliation_id, link_id, revision, fingerprint, attempt, snapshot,
                status, started_at)
             VALUES (1, 1, 1, 1, 'f1', 'a1', '{{}}', 'pending', '2026-01-01 00:00:00.000'),
                    (1, 2, 1, 1, 'f2', 'a2', '{{}}', 'ready', '2026-01-01 00:00:00.000'),
                    (1, 3, 1, 1, 'f3', 'a3', '{{}}', 'skipped', '2026-01-01 00:00:00.000'),
                    (1, 4, 1, 1, 'f4', 'a4', '{{}}', 'error', '2026-01-01 00:00:00.000'),
                    (1, 5, 1, 1, 'f5', 'a5', '{{}}', 'stale', '2026-01-01 00:00:00.000'),
                    (1, 6, 1, 1, 'gone', 'a6', '{{}}', 'ready', '2026-01-01 00:00:00.000');
             DELETE FROM typesafe_evaluations WHERE fingerprint = 'gone';
             INSERT INTO typesafe_decisions
               (book_id, reconciliation_id, evaluation_id, action, decided_at)
             VALUES (1, 1, 1, 'match', '2026-01-01 00:00:00.000'),
                    (1, 2, 2, 'create', '2026-01-01 00:00:00.000'),
                    (1, 3, NULL, 'ignore', '2026-01-01 00:00:00.000');

             UPDATE plaid_transaction_reconciliation SET resolution_status = 'matched'
               WHERE plaid_transaction_id = 'demo_txn_001';
             UPDATE plaid_transaction_reconciliation
               SET resolution_status = 'created', review_reason = 'plaid_removed'
               WHERE plaid_transaction_id = 'demo_txn_002';
             UPDATE plaid_transaction_reconciliation SET resolution_status = 'ignored'
               WHERE plaid_transaction_id = 'demo_txn_004';
             INSERT INTO plaid_transaction_reconciliation ({PLAID_COLUMNS})
               SELECT {} FROM plaid_transaction_reconciliation
               WHERE plaid_transaction_id = 'demo_txn_001';
             DELETE FROM plaid_transaction_reconciliation WHERE plaid_transaction_id = 'gone';",
            PLAID_COLUMNS.replace("plaid_transaction_id", "'gone'")
        ))
        .unwrap();
    // The sample book must give every value of the Plaid columns a row.
    assert_eq!(
        lines(
            database,
            "SELECT DISTINCT resolution_status FROM plaid_transaction_reconciliation ORDER BY 1"
        ),
        ["created", "ignored", "matched", "pending"]
    );
    assert_eq!(
        lines(
            database,
            "SELECT DISTINCT coalesce(review_reason, 'NULL')
             FROM plaid_transaction_reconciliation ORDER BY 1"
        ),
        ["NULL", "plaid_modified", "plaid_removed"]
    );
}

fn migrate_to_after(database: &Database) -> Result<(), crate::migrations::MigrateError> {
    migrate_with(database, &through(AFTER))
}

/// The schema before and after the migration differs in the four CHECK
/// clauses and in nothing else: the same columns in the same order, the
/// same defaults, indexes, triggers and foreign keys, in every table.
#[test]
fn the_migration_changes_only_the_check_clauses() {
    let file = TempDatabase::at_version(BEFORE);
    let database = file.database();
    let before = describe(database);
    migrate_to_after(database).unwrap();
    assert_eq!(version(database), AFTER);
    let after = describe(database);

    // Three lines differ: the text of the three tables.
    let changed: Vec<&String> = after.iter().filter(|line| !before.contains(line)).collect();
    let mut expected: Vec<String> = REBUILT
        .iter()
        .map(|table| format!("table|{table}|{table}|"))
        .collect();
    expected.sort();
    let mut prefixes: Vec<String> = changed
        .iter()
        .map(|line| line[..=line.rfind('|').unwrap()].to_owned())
        .collect();
    prefixes.sort();
    assert_eq!(prefixes, expected);
    assert_eq!(before.len(), after.len());

    // Without the four new clauses, the new schema is the old schema.
    let mut removed = 0;
    let without_checks: Vec<String> = after
        .iter()
        .map(|line| {
            let mut line = line.clone();
            for check in &CHECKS {
                if line.starts_with(&format!("table|{}|", check.table)) {
                    assert_eq!(line.matches(check.clause).count(), 1, "{}", check.clause);
                    line = line.replace(check.clause, "");
                    removed += 1;
                }
            }
            line
        })
        .collect();
    assert_eq!(removed, CHECKS.len());
    assert_eq!(before, without_checks);
    for check in &CHECKS {
        assert!(before.iter().all(|line| !line.contains(check.clause)));
    }

    // The side table of the migration is gone, and so are the `_new` names.
    assert_eq!(
        count(
            database,
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE instr(name, '_new') > 0 OR instr(name, '_0019') > 0
                OR instr(sql, '_new') > 0 OR instr(sql, '_0019') > 0"
        ),
        0
    );
}

/// The migration keeps every row, every ID counter and every change count,
/// and the foreign key of `typesafe_decisions` points at the new table.
#[test]
fn the_migration_keeps_the_rows_and_the_id_counters() {
    let file = TempDatabase::at_version(BEFORE);
    let database = file.database();
    fill(database);
    let before = watched_rows(database);
    let changes = count(database, "SELECT COUNT(*) FROM transaction_changes");
    for table in REBUILT {
        assert!(!rows(database, table).is_empty(), "{table} has no row");
    }

    migrate_to_after(database).unwrap();
    assert_eq!(version(database), AFTER);
    assert_eq!(watched_rows(database), before);
    assert_eq!(
        count(database, "SELECT COUNT(*) FROM transaction_changes"),
        changes
    );
    assert_eq!(
        count(database, "SELECT COUNT(*) FROM pragma_foreign_key_check"),
        0
    );
    assert_eq!(
        lines(database, "SELECT * FROM pragma_integrity_check"),
        ["ok"]
    );

    // A new row does not get the ID of the row that was deleted.
    let next = |table: &str| -> i64 {
        database
            .query_row(
                "SELECT seq + 1 FROM sqlite_sequence WHERE name = ?1",
                &params![table],
            )
            .unwrap()
    };
    let report = next("issue_reports");
    assert_eq!(report, 5);
    assert_eq!(
        count(
            database,
            "INSERT INTO issue_reports (user_id, description, page, created_at)
             VALUES (1, 'd', '/p', '2026-01-05 00:00:00') RETURNING id"
        ),
        report
    );
    let evaluation = next("typesafe_evaluations");
    assert_eq!(evaluation, 7);
    assert_eq!(
        count(
            database,
            "INSERT INTO typesafe_evaluations
               (book_id, reconciliation_id, link_id, revision, fingerprint, attempt, snapshot,
                status, started_at)
             VALUES (1, 7, 1, 1, 'f7', 'a7', '{}', 'pending', '2026-01-01 00:00:00.000')
             RETURNING id"
        ),
        evaluation
    );
    let staged = next("plaid_transaction_reconciliation");
    assert_eq!(
        count(
            database,
            "SELECT max(id) + 2 FROM plaid_transaction_reconciliation"
        ),
        staged
    );
    assert_eq!(
        count(
            database,
            &format!(
                "INSERT INTO plaid_transaction_reconciliation ({PLAID_COLUMNS})
                 SELECT {} FROM plaid_transaction_reconciliation
                 WHERE plaid_transaction_id = 'demo_txn_001' RETURNING id",
                PLAID_COLUMNS.replace("plaid_transaction_id", "'new'")
            )
        ),
        staged
    );

    // The defaults are the old ones.
    assert_eq!(
        lines(
            database,
            "SELECT status || '/' || type FROM issue_reports WHERE description = 'd'"
        ),
        ["new/bug"]
    );

    // The delete of an evaluation still deletes its decisions, and only
    // them.
    database
        .execute("DELETE FROM typesafe_evaluations WHERE id = 1", &[])
        .unwrap();
    assert_eq!(
        lines(
            database,
            "SELECT quote(evaluation_id) FROM typesafe_decisions ORDER BY id"
        ),
        ["2", "NULL"]
    );
}

/// Each column takes each value of its set, in an insert and in an update,
/// and refuses a value outside the set.
#[test]
fn each_column_takes_its_set_and_refuses_other_values() {
    let file = TempDatabase::at_version(AFTER);
    let database = file.database();
    fill(database);
    let mut fingerprint = 100;
    let mut insert = |check: &Check, value: Option<&str>| -> Result<u64, crate::store::Error> {
        fingerprint += 1;
        match (check.table, check.column) {
            ("issue_reports", _) => database.execute(
                "INSERT INTO issue_reports (user_id, description, page, status, created_at)
                 VALUES (1, 'x', '/p', ?1, '2026-02-01 00:00:00')",
                &params![value],
            ),
            ("typesafe_evaluations", _) => database.execute(
                "INSERT INTO typesafe_evaluations
                   (book_id, reconciliation_id, link_id, revision, fingerprint, attempt,
                    snapshot, status, started_at)
                 VALUES (1, 9, 1, 1, ?2, 'a', '{}', ?1, '2026-02-01 00:00:00.000')",
                &params![value, format!("g{fingerprint}")],
            ),
            (_, column) => database.execute(
                &format!(
                    "INSERT INTO plaid_transaction_reconciliation ({PLAID_COLUMNS})
                     SELECT {} FROM plaid_transaction_reconciliation
                     WHERE plaid_transaction_id = 'demo_txn_005'",
                    PLAID_COLUMNS
                        .replace("plaid_transaction_id", "?2")
                        .replace(&format!(" {column},"), " ?1,")
                ),
                &params![value, format!("g{fingerprint}")],
            ),
        }
    };
    let update = |check: &Check, value: Option<&str>| {
        database.execute(
            &format!(
                "UPDATE {0} SET {1} = ?1 WHERE id = (SELECT min(id) FROM {0})",
                check.table, check.column
            ),
            &params![value],
        )
    };
    let refused = |result: Result<u64, crate::store::Error>, check: &Check, value: &str| {
        let error = result.expect_err(&format!("{}.{} took {value:?}", check.table, check.column));
        assert!(
            error.to_string().starts_with("CHECK constraint failed"),
            "{}.{} = {value:?}: {error}",
            check.table,
            check.column
        );
    };

    for check in &CHECKS {
        for value in check.allowed {
            assert_eq!(insert(check, Some(*value)).unwrap(), 1, "{value}");
            assert_eq!(update(check, Some(*value)).unwrap(), 1, "{value}");
            let stored = count(
                database,
                &format!(
                    "SELECT COUNT(*) FROM {} WHERE {} = '{value}'",
                    check.table, check.column
                ),
            );
            assert!(stored >= 2, "{value}: {stored}");
        }
        if check.nullable {
            assert_eq!(insert(check, None).unwrap(), 1);
            assert_eq!(update(check, None).unwrap(), 1);
        }
        // The values of the other columns' sets are refused too.
        let others = CHECKS
            .iter()
            .flat_map(|other| other.allowed.iter().copied())
            .filter(|value| !check.allowed.contains(value));
        for value in REFUSED.into_iter().chain(others) {
            refused(insert(check, Some(value)), check, value);
            refused(update(check, Some(value)), check, value);
        }
    }
}

/// A row with a value outside a set stops the migration. Nothing of it
/// stays: the version, the schema and the rows are as they were.
#[test]
fn a_value_outside_a_set_stops_the_migration_and_changes_nothing() {
    for check in &CHECKS {
        let file = TempDatabase::at_version(BEFORE);
        let database = file.database();
        fill(database);
        database
            .execute(
                &format!(
                    "UPDATE {0} SET {1} = 'bogus' WHERE id = (SELECT max(id) FROM {0})",
                    check.table, check.column
                ),
                &[],
            )
            .unwrap();
        let schema = describe(database);
        let before = watched_rows(database);

        let error = migrate_to_after(database).unwrap_err().to_string();
        assert!(
            error.starts_with("CHECK constraint failed"),
            "{}.{}: {error}",
            check.table,
            check.column
        );
        assert_eq!(version(database), BEFORE);
        assert_eq!(describe(database), schema);
        assert_eq!(watched_rows(database), before);

        // With the value corrected, the same file migrates.
        database
            .execute(
                &format!(
                    "UPDATE {} SET {} = ?1 WHERE {1} = 'bogus'",
                    check.table, check.column
                ),
                &params![check.allowed[0]],
            )
            .unwrap();
        migrate_to_after(database).unwrap();
        assert_eq!(version(database), AFTER);
    }
}
