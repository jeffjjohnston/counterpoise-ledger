use super::window::{date, format_date};
use super::*;
use crate::store::{Database, Sql, params};
use crate::testing::TempDatabase;
use chrono::Datelike;
use unicode_segmentation::UnicodeSegmentation;

/// The hash of the household rows at 2025-12-31, before the dates became
/// relative. Tasks that only move code must not change it.
const HOUSEHOLD_2025_12_31: &str = "cb8b0b074ca4eb6b";

#[test]
fn mulberry32_matches_javascript() {
    // The first draws of mulberry32(42) in Node.
    let mut rand = Mulberry32::new(42);
    let draws: Vec<f64> = (0..3).map(|_| rand.next()).collect();
    assert_eq!(
        draws,
        [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]
    );
}

#[test]
fn js_round_takes_a_half_up() {
    assert_eq!(js_round(2.5), 3.0);
    assert_eq!(js_round(-2.5), -2.0);
    assert_eq!(js_round(-2.6), -3.0);
    assert_eq!(js_round(0.49999999999999994), 0.0);
}

/// A migrated database with one user and `count` books, IDs 1 to `count`.
fn database_with_books(count: i32) -> TempDatabase {
    let file = TempDatabase::new();
    let database = file.database();
    database
        .exec_batch(
            "INSERT INTO users (id, username, password_hash, created_at)
             VALUES (1, 'u', 'h', '2025-01-01 00:00:00')",
        )
        .unwrap();
    for id in 1..=count {
        database
            .execute(
                "INSERT INTO books (id, user_id, name, created_at, updated_at)
                 VALUES (?1, 1, 'B', '2025-01-01 00:00:00', '2025-01-01 00:00:00')",
                &params![id],
            )
            .unwrap();
    }
    file
}

/// FNV-1a over every row of the book, table by table in name order and
/// row by row in `id` order. A table without `id` is in the order of all its
/// columns. Columns that end in `_at` are timestamps
/// and are left out. `transaction_changes` is a log that the triggers write,
/// not seed data, so it is left out too. `plaid_link_sessions` holds the
/// Plaid Hosted Link sessions of the Sync page, which the seed never writes,
/// so it is left out and the hashes stay as before migration 0005. The
/// weekly review and TypeSafe entry tables hold no seed data either.
fn dump_hash(database: &Database, book_id: i32) -> String {
    let tables: Vec<String> = database
        .query(
        "SELECT m.name FROM sqlite_master m
         WHERE m.type = 'table'
           AND m.name NOT IN ('transaction_changes', 'plaid_link_sessions', 'weekly_reviews', 'weekly_review_items',
                              'typesafe_entry_evaluations', 'typesafe_entry_outcomes')
           AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'book_id')
         ORDER BY m.name",
            &[],
        )
        .unwrap();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |text: &str| {
        for byte in text.bytes().chain(*b"\n") {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    };
    for table in tables {
        let columns: Vec<String> = database
            .query(
                "SELECT name FROM pragma_table_info(?1) WHERE name NOT LIKE '%\\_at' ESCAPE '\\' ORDER BY cid",
                &params![&table],
            )
            .unwrap();
        let select = columns
            .iter()
            .map(|column| format!("quote({column})"))
            .collect::<Vec<_>>()
            .join(" || '|' || ");
        // Order by `id`. A table without `id` is ordered by all its columns.
        let has_id: bool = database
            .query_row::<i32>(
                "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name = 'id'",
                &params![&table],
            )
            .unwrap()
            > 0;

        let order_by = if has_id {
            "id".to_string()
        } else {
            // There is no `id`. Use all columns that are not timestamps.
            columns
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        };

        let query_str =
            format!("SELECT {select} FROM \"{table}\" WHERE book_id = ?1 ORDER BY {order_by}");
        let rows: Vec<String> = database.query(&query_str, &params![book_id]).unwrap();
        feed(&table);
        for row in rows {
            feed(&row);
        }
    }
    format!("{hash:016x}")
}

#[test]
fn the_household_rows_at_2025_12_31_do_not_change() {
    let database = database_with_books(1);
    database
        .database()
        .transaction(|sql| {
            seed_book(
                sql,
                1,
                DemoDataset::Household,
                date(2025, 12, 31),
                &mut |_| {},
            )
        })
        .unwrap();
    let actual = dump_hash(database.database(), 1);
    assert_eq!(actual, HOUSEHOLD_2025_12_31, "actual hash: {actual}");
}

/// The hash of the household rows at 2026-09-15.
const HOUSEHOLD_2026_09_15: &str = "2e8ec5f012b1b59e";

#[test]
fn the_household_rows_at_2026_09_15_do_not_change() {
    let database = database_with_books(1);
    database
        .database()
        .transaction(|sql| {
            seed_book(
                sql,
                1,
                DemoDataset::Household,
                date(2026, 9, 15),
                &mut |_| {},
            )
        })
        .unwrap();
    let actual = dump_hash(database.database(), 1);
    assert_eq!(actual, HOUSEHOLD_2026_09_15, "actual hash: {actual}");
}

/// The paycheck rule follows the cadence of the seeded paychecks. At
/// 2026-10-03 the last paycheck is 2026-10-02, so the rule is 14 days later.
#[test]
fn the_paycheck_rule_follows_the_seeded_cadence() {
    let database = database_with_books(1);
    database
        .database()
        .transaction(|sql| {
            seed_book(
                sql,
                1,
                DemoDataset::Household,
                date(2026, 10, 3),
                &mut |_| {},
            )
        })
        .unwrap();
    let last: String = database
        .database()
        .query_row(
            "SELECT MAX(date) FROM transactions
             WHERE book_id = 1 AND description LIKE 'Paycheck - Meridian%' ESCAPE '\\'",
            &[],
        )
        .unwrap();
    let next: String = database
        .database()
        .query_row(
            "SELECT next_date FROM recurring_rules
             WHERE book_id = 1 AND name = 'Paycheck - Meridian Health'",
            &[],
        )
        .unwrap();
    let parse = |text: &str| NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap();
    assert_eq!(parse(&last), date(2026, 10, 2));
    assert_eq!(parse(&next), parse(&last) + chrono::Days::new(14));
    assert!(parse(&next) > date(2026, 10, 3));
}

/// A mid-month day, the 1st of a month, the last and the first day of a
/// year, and a leap day.
const TODAYS: [(i32, u32, u32); 5] = [
    (2026, 9, 15),
    (2026, 10, 1),
    (2026, 12, 31),
    (2027, 1, 1),
    (2028, 2, 29),
];

fn count(database: &Database, sql: &str, book_id: i32, today: &str) -> i64 {
    database.query_row(sql, &params![book_id, today]).unwrap()
}

/// The rules that every dataset keeps, for one seeded book.
fn check_invariants(database: &Database, book_id: i32, today: NaiveDate) {
    let today_text = format_date(today);
    let first_of_month = format_date(today.with_day(1).unwrap());
    let at = |what: &str| format!("book {book_id}, today {today_text}: {what}");

    let unbalanced = count(
        database,
        "SELECT COUNT(*) FROM (SELECT transaction_id FROM transaction_splits
           WHERE book_id = ?1 AND ?2 = ?2 GROUP BY transaction_id HAVING SUM(amount) <> 0)",
        book_id,
        &today_text,
    );
    assert_eq!(unbalanced, 0, "{}", at("unbalanced transactions"));

    for (table, column) in [
        ("transactions", "date"),
        ("security_prices", "price_date"),
        ("plaid_transaction_reconciliation", "date"),
    ] {
        let future = count(
            database,
            &format!("SELECT COUNT(*) FROM {table} WHERE book_id = ?1 AND {column} > ?2"),
            book_id,
            &today_text,
        );
        assert_eq!(future, 0, "{}", at(&format!("{table} after today")));
    }

    let this_month: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM transactions WHERE book_id = ?1 AND date >= ?2",
            &params![book_id, &first_of_month],
        )
        .unwrap();
    assert!(this_month > 0, "{}", at("no transaction this month"));

    let sells = count(
        database,
        "SELECT COUNT(*) FROM investment_splits WHERE book_id = ?1 AND ?2 = ?2 AND action = 'sell'",
        book_id,
        &today_text,
    );
    assert!(sells > 0, "{}", at("no sell"));
    let unallocated = count(
        database,
        "SELECT COUNT(*) FROM investment_splits s
         WHERE s.book_id = ?1 AND ?2 = ?2 AND s.action = 'sell'
           AND NOT EXISTS (SELECT 1 FROM investment_lot_allocations a WHERE a.sell_split_id = s.id)",
        book_id,
        &today_text,
    );
    assert_eq!(unallocated, 0, "{}", at("sells without lot allocations"));

    let rules = count(
        database,
        "SELECT COUNT(*) FROM recurring_rules WHERE book_id = ?1 AND ?2 = ?2",
        book_id,
        &today_text,
    );
    assert!(rules > 0, "{}", at("no recurring rule"));
    let early_rules = count(
        database,
        "SELECT COUNT(*) FROM recurring_rules WHERE book_id = ?1 AND next_date <= ?2",
        book_id,
        &today_text,
    );
    assert_eq!(early_rules, 0, "{}", at("rules due on or before today"));

    let icons: Vec<String> = database
        .query(
            "SELECT icon FROM accounts WHERE book_id = ?1 AND parent_id IS NULL AND icon IS NOT NULL",
            &params![book_id],
        )
        .unwrap();
    let mut unique = icons.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(
        unique.len(),
        icons.len(),
        "{}",
        at("two top-level icons are the same")
    );
    for icon in &icons {
        assert_eq!(
            icon.graphemes(true).count(),
            1,
            "{}",
            at(&format!("icon {icon:?}"))
        );
    }
}

/// Seeds one book for each of `TODAYS` into one database, so the books of
/// one dataset must also live side by side, then checks each book.
fn every_today_keeps_the_invariants(dataset: DemoDataset) {
    let database = database_with_books(TODAYS.len() as i32);
    for (index, (year, month, day)) in TODAYS.into_iter().enumerate() {
        let book_id = index as i32 + 1;
        let today = date(year, month, day);
        database
            .database()
            .transaction(|sql| seed_book(sql, book_id, dataset, today, &mut |_| {}))
            .unwrap_or_else(|cause| panic!("{} at {today}: {cause}", dataset.id()));
        check_invariants(database.database(), book_id, today);
    }
}

#[test]
fn the_household_keeps_the_invariants_on_every_today() {
    every_today_keeps_the_invariants(DemoDataset::Household);
}

/// The hash of the single dataset at 2026-09-15.
const SINGLE_2026_09_15: &str = "009a982d4b966c29";

#[test]
fn the_single_rows_at_2026_09_15_do_not_change() {
    let database = database_with_books(1);
    database
        .database()
        .transaction(|sql| seed_book(sql, 1, DemoDataset::Single, date(2026, 9, 15), &mut |_| {}))
        .unwrap();
    let actual = dump_hash(database.database(), 1);
    assert_eq!(actual, SINGLE_2026_09_15, "actual hash: {actual}");
}

#[test]
fn the_single_dataset_keeps_the_invariants_on_every_today() {
    every_today_keeps_the_invariants(DemoDataset::Single);
}

/// A paycheck whose date moves past `today` is not written. 2026-10-31 is a
/// Saturday. Its paycheck moves to Monday 2026-11-02.
#[test]
fn a_paycheck_that_moves_past_today_is_skipped() {
    let database = database_with_books(2);
    for (book_id, today) in [(1, date(2026, 10, 31)), (2, date(2026, 8, 31))] {
        database
            .database()
            .transaction(|sql| seed_book(sql, book_id, DemoDataset::Single, today, &mut |_| {}))
            .unwrap();
        check_invariants(database.database(), book_id, today);
    }
    let last_paycheck = |book_id: i32| {
        database.database().query_row::<String>(
            "SELECT MAX(date) FROM transactions WHERE book_id = ?1 AND description LIKE 'Paycheck%' ESCAPE '\\'",
            &params![book_id],
        )
    };
    assert_eq!(last_paycheck(1).unwrap(), "2026-10-15");
    // 2026-08-31 is a Monday, so its paycheck is on the day.
    assert_eq!(last_paycheck(2).unwrap(), "2026-08-31");
}

#[test]
fn every_dataset_has_a_unique_id_and_book_name() {
    let mut ids: Vec<_> = DemoDataset::ALL.iter().map(|d| d.id()).collect();
    let mut names: Vec<_> = DemoDataset::ALL.iter().map(|d| d.book_name()).collect();
    ids.sort_unstable();
    names.sort_unstable();
    ids.dedup();
    names.dedup();
    assert_eq!(ids.len(), DemoDataset::ALL.len());
    assert_eq!(names.len(), DemoDataset::ALL.len());
    for dataset in DemoDataset::ALL {
        assert_eq!(DemoDataset::from_id(dataset.id()), Some(dataset));
        assert!(dataset.months() <= 36);
    }
    assert_eq!(DemoDataset::from_id("SINGLE"), None);
}
