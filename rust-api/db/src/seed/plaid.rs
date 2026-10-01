//! The demo Plaid connection: one card, with reconciliation rows that the
//! Sync page shows.

use chrono::{Days, NaiveDate};

use super::window::format_date;
use super::{SeedError, SeedResult, Seeder};

/// A Plaid row that matches no transaction in the book.
pub(super) struct Unmatched {
    pub name: &'static str,
    pub merchant: &'static str,
    pub original_description: &'static str,
    pub amount_cents: i64,
}

/// The card and the bank of one dataset's Plaid demo.
pub(super) struct PlaidDemo {
    pub card: i32,
    /// Part of the item ID and the access token: `demo_item_{slug}_{book}`.
    pub slug: &'static str,
    /// Part of the Plaid account ID: `demo_acct_{account_slug}_{book}`.
    pub account_slug: &'static str,
    pub institution: &'static str,
    pub account_name: &'static str,
    pub official_name: &'static str,
    pub mask: &'static str,
    /// Dated `today - 3` and `today - 2`.
    pub unmatched: [Unmatched; 2],
}

struct CardCharge {
    date: String,
    description: Option<String>,
    amount: i32,
}

impl CardCharge {
    fn upper(&self) -> String {
        self.description
            .as_deref()
            .map_or_else(|| "PURCHASE".to_owned(), str::to_uppercase)
    }
}

struct Reconciliation {
    transaction_id: &'static str,
    date: String,
    authorized_date: Option<String>,
    amount_cents: i64,
    name: String,
    merchant_name: Option<String>,
    original_description: String,
    review_reason: Option<&'static str>,
}

/// A demo Plaid connection on the card of `demo`, with reconciliation rows
/// that the Sync page shows: two strong matches, a weak match, two rows with
/// no match, and one row to review.
pub(super) async fn seed_plaid(
    seeder: &mut Seeder<'_>,
    demo: &PlaidDemo,
    today: NaiveDate,
) -> SeedResult<()> {
    (seeder.log)("  Seeding Plaid sync demo data...");
    let book_id = seeder.book_id;

    // The transaction ID breaks a tie between two charges on one date.
    let recent: Vec<CardCharge> = sqlx::query_as::<_, (String, Option<String>, i32)>(
        "SELECT t.date, t.description, s.amount
         FROM transactions t
         JOIN transaction_splits s ON s.transaction_id = t.id
         WHERE s.account_id = $1 AND t.book_id = $2 AND s.amount < 0
         ORDER BY t.date DESC, t.id DESC
         LIMIT 5",
    )
    .bind(demo.card)
    .bind(book_id)
    .fetch_all(&mut *seeder.connection)
    .await?
    .into_iter()
    .map(|(date, description, amount)| CardCharge {
        date,
        description,
        amount,
    })
    .collect();

    // plaid_tokens.item_id and plaid_accounts.plaid_account_id are unique in
    // the whole table, as real Plaid IDs are. The book ID in each value lets
    // one database hold more than one seeded book.
    let token_id: i32 = sqlx::query_scalar(
        "INSERT INTO plaid_tokens
           (book_id, financial_institution, item_id, access_token, is_demo, created_at, updated_at)
         VALUES ($1, $2, $3, $4, true, $5, $5)
         RETURNING id",
    )
    .bind(book_id)
    .bind(demo.institution)
    .bind(format!("demo_item_{}_{book_id}", demo.slug))
    .bind(format!("demo_access_token_{}_{book_id}", demo.slug))
    .bind(seeder.now)
    .fetch_one(&mut *seeder.connection)
    .await?;
    // is_demo keeps the scheduled sync away from this connection. Plaid can
    // only refuse its token.

    let link_id: i32 = sqlx::query_scalar(
        "INSERT INTO plaid_accounts
           (book_id, token_id, plaid_account_id, name, official_name, mask, type, subtype,
            counterpoise_account_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'credit', 'credit card', $7, $8, $8)
         RETURNING id",
    )
    .bind(book_id)
    .bind(token_id)
    .bind(format!("demo_acct_{}_{book_id}", demo.account_slug))
    .bind(demo.account_name)
    .bind(demo.official_name)
    .bind(demo.mask)
    .bind(demo.card)
    .bind(seeder.now)
    .fetch_one(&mut *seeder.connection)
    .await?;

    // Plaid gives a charge as a positive amount.
    let mut items = Vec::new();
    if let [first, second, third, ..] = recent.as_slice() {
        items.push(Reconciliation {
            transaction_id: "demo_txn_001",
            date: first.date.clone(),
            authorized_date: Some(first.date.clone()),
            amount_cents: -i64::from(first.amount),
            name: format!("{} #1234", first.upper()),
            merchant_name: first.description.clone(),
            original_description: format!("{} STORE 1234", first.upper()),
            review_reason: None,
        });
        let day_before = NaiveDate::parse_from_str(&second.date, "%Y-%m-%d")
            .map_err(|cause| SeedError::Invalid(format!("Bad date {}: {cause}", second.date)))?
            - Days::new(1);
        let day_before = format_date(day_before);
        items.push(Reconciliation {
            transaction_id: "demo_txn_002",
            date: day_before.clone(),
            authorized_date: Some(day_before),
            amount_cents: -i64::from(second.amount),
            name: format!("{} #567", second.upper()),
            merchant_name: second.description.clone(),
            original_description: format!("{} 567", second.upper()),
            review_reason: None,
        });
        // A weak match: the amount is 29 cents off.
        items.push(Reconciliation {
            transaction_id: "demo_txn_003",
            date: third.date.clone(),
            authorized_date: Some(third.date.clone()),
            amount_cents: -i64::from(third.amount) + 29,
            name: format!("{} MODIFIED", third.upper()),
            merchant_name: third.description.clone(),
            original_description: format!("{} MODIFIED", third.upper()),
            review_reason: None,
        });
    }
    for (index, (id, row)) in ["demo_txn_004", "demo_txn_005"]
        .into_iter()
        .zip(&demo.unmatched)
        .enumerate()
    {
        items.push(Reconciliation {
            transaction_id: id,
            date: format_date(today - Days::new(3 - index as u64)),
            authorized_date: None,
            amount_cents: row.amount_cents,
            name: row.name.to_owned(),
            merchant_name: Some(row.merchant.to_owned()),
            original_description: row.original_description.to_owned(),
            review_reason: None,
        });
    }
    if let Some(fourth) = recent.get(3) {
        items.push(Reconciliation {
            transaction_id: "demo_txn_006",
            date: fourth.date.clone(),
            authorized_date: Some(fourth.date.clone()),
            amount_cents: -i64::from(fourth.amount),
            name: format!("{} REVISED", fourth.upper()),
            merchant_name: fourth.description.clone(),
            original_description: format!("{} REVISED", fourth.upper()),
            review_reason: Some("plaid_modified"),
        });
    }

    for item in &items {
        sqlx::query(
            "INSERT INTO plaid_transaction_reconciliation
               (book_id, plaid_account_link_id, plaid_transaction_id, date, authorized_date,
                amount_cents, name, merchant_name, original_description, pending, raw_json,
                resolution_status, review_reason, first_seen_at, last_seen_at, created_at,
                updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, '{}', 'pending', $10,
                     $11, $11, $11, $11)",
        )
        .bind(book_id)
        .bind(link_id)
        .bind(item.transaction_id)
        .bind(&item.date)
        .bind(&item.authorized_date)
        .bind(i32::try_from(item.amount_cents).map_err(|_| {
            SeedError::Invalid(format!("Plaid amount too large: {}", item.amount_cents))
        })?)
        .bind(&item.name)
        .bind(&item.merchant_name)
        .bind(&item.original_description)
        .bind(item.review_reason)
        .bind(seeder.now)
        .execute(&mut *seeder.connection)
        .await?;
    }
    (seeder.log)(&format!("  Plaid reconciliation items: {}", items.len()));
    Ok(())
}
