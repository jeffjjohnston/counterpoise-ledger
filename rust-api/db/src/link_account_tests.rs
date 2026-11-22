//! Tests of migration 0020, which adds the account that a link was made on
//! (`plaid_transaction_reconciliation.linked_account_id`). The migration
//! fills it for each link that exists, from the current mapping of the bank
//! account, and leaves it NULL on each row that links nothing.

use crate::{
    migrations::{migrate_with, through},
    store::{Sql, params},
    testing::TempDatabase,
};

const BEFORE: i64 = 19;
const AFTER: i64 = 20;

#[test]
fn the_migration_fills_the_account_of_each_link() {
    let file = TempDatabase::at_version(BEFORE);
    let database = file.database();
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
    // The seed's bank account and a transaction on its mapped account.
    let (link_id, account_id): (i32, i32) = database
        .query_row(
            "SELECT id, counterpoise_account_id FROM plaid_accounts ORDER BY id LIMIT 1",
            &[],
        )
        .unwrap();
    // Two transactions: one link can join a transaction only once.
    let transactions: Vec<i32> = database
        .query(
            "SELECT DISTINCT transaction_id FROM transaction_splits WHERE account_id = ?1
             ORDER BY transaction_id LIMIT 2",
            &params![account_id],
        )
        .unwrap();
    let rows: Vec<i32> = database
        .query(
            "SELECT id FROM plaid_transaction_reconciliation
             WHERE plaid_account_link_id = ?1 ORDER BY id LIMIT 4",
            &params![link_id],
        )
        .unwrap();
    let [matched, created, ignored, pending] = rows[..] else {
        panic!("the seed has 4 staged rows on its bank account: {rows:?}");
    };
    for (id, status, linked) in [
        (matched, "matched", Some(transactions[0])),
        (created, "created", Some(transactions[1])),
        (ignored, "ignored", None),
        (pending, "pending", None),
    ] {
        database
            .execute(
                "UPDATE plaid_transaction_reconciliation
                 SET resolution_status = ?2, matched_transaction_id = ?3, review_reason = NULL
                 WHERE id = ?1",
                &params![id, status, linked],
            )
            .unwrap();
    }

    migrate_with(database, &through(AFTER)).unwrap();

    let stored: Vec<(i32, Option<i32>)> = database
        .query(
            "SELECT id, linked_account_id FROM plaid_transaction_reconciliation
             WHERE plaid_account_link_id = ?1 ORDER BY id",
            &params![link_id],
        )
        .unwrap();
    for (id, linked_account_id) in stored {
        let expected = (id == matched || id == created).then_some(account_id);
        assert_eq!(linked_account_id, expected, "row {id}");
    }
}
