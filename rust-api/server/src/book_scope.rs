//! Proof types for book access, after the idea of "Ghosts of Departed
//! Proofs".
//!
//! This module does the checks, and it is the only module that makes the
//! proofs:
//!
//! - `BookAccess<L>`: the caller has at least the level `L` in the book.
//!   Each helper that writes book data demands one. Only a scheduled job
//!   gets one without a member (`BookAccess::for_system_job`).
//! - `InBook<T>`: the row `id` of table `T` is in the book.
//! - `ProvedSplits` and `ProvedInvestmentSplits`: a split list that a write
//!   helper can insert.
//!
//! The fields are private, so code outside this module cannot forge a proof.
//! A helper that demands a proof thus cannot get a value that skipped the
//! check. A proof is true at the time of its check, so keep it in the
//! request that made it.

use crate::{
    book_auth::{AccessLevel, AuthenticatedBook, denial},
    error::ApiError,
    routes::{payees::normalize_name, transactions::now_millis},
    transaction_input::{InvestmentSplitInput, SplitInput},
};
use ledger_core::accounting::validate_splits;
use ledger_db::store::{self, Sql, params};
use std::{collections::HashSet, marker::PhantomData};

// ---------------------------------------------------------------------------
// Access levels
// ---------------------------------------------------------------------------

/// The level of a member who can read the book: every role.
#[derive(Debug)]
pub(crate) enum Read {}

/// The level of a member who can change the book: an owner or an editor.
#[derive(Debug)]
pub(crate) enum Write {}

/// The level of an owner of the book.
#[derive(Debug)]
pub(crate) enum Owner {}

/// Proof that the caller has at least the level `L` in this book.
///
/// The lifetime keeps a proof in the request that made it. A proof holds
/// only two values, so `detach` can copy it into a callback that must own
/// its values.
#[derive(Debug)]
pub(crate) struct BookAccess<'a, L> {
    book_id: i32,
    /// `None` for a scheduled job, which has no user.
    user_id: Option<i32>,
    _request: PhantomData<&'a AuthenticatedBook>,
    _level: PhantomData<L>,
}

impl<L> BookAccess<'_, L> {
    fn new(book_id: i32, user_id: Option<i32>) -> Self {
        Self {
            book_id,
            user_id,
            _request: PhantomData,
            _level: PhantomData,
        }
    }

    pub(crate) fn book_id(&self) -> i32 {
        self.book_id
    }

    /// The signed-in user. `None` for a scheduled job.
    pub(crate) fn user_id(&self) -> Option<i32> {
        self.user_id
    }

    /// The same proof, without the borrow of the request. Use it only to
    /// move a proof into a callback that must own its values, such as the
    /// background task, or a run that holds a lease.
    pub(crate) fn detach(&self) -> BookAccess<'static, L> {
        BookAccess::new(self.book_id, self.user_id)
    }
}

impl BookAccess<'static, Write> {
    /// Write access for a scheduled job, which has no signed-in user. Only
    /// the jobs that `scheduler/mod.rs` and the `/api/cron/*` routes run may call
    /// this: the Plaid sync, the recurring rules, the TypeSafe cleanup and the weekly review. A
    /// route that a member calls gets its access from `authenticate_book`,
    /// never from this function.
    pub(crate) fn for_system_job(book_id: i32) -> Self {
        Self::new(book_id, None)
    }
}

impl<'a> From<BookAccess<'a, Owner>> for BookAccess<'a, Write> {
    fn from(access: BookAccess<'a, Owner>) -> Self {
        Self::new(access.book_id, access.user_id)
    }
}

impl<'a> From<BookAccess<'a, Write>> for BookAccess<'a, Read> {
    fn from(access: BookAccess<'a, Write>) -> Self {
        Self::new(access.book_id, access.user_id)
    }
}

impl AuthenticatedBook {
    /// Every member can read, so this cannot fail.
    pub(crate) fn read(&self) -> BookAccess<'_, Read> {
        BookAccess::new(self.book_id(), Some(self.user_id()))
    }

    /// Checks the role in memory. It does not query the database again. The
    /// refusal is the same 403 that `authenticate_book` gives.
    pub(crate) fn write(&self) -> Result<BookAccess<'_, Write>, ApiError> {
        self.at_level(AccessLevel::Write)
    }

    /// As `write`, for an owner-only operation.
    pub(crate) fn owner(&self) -> Result<BookAccess<'_, Owner>, ApiError> {
        self.at_level(AccessLevel::Owner)
    }

    fn at_level<L>(&self, level: AccessLevel) -> Result<BookAccess<'_, L>, ApiError> {
        if self.role().satisfies(level) {
            Ok(BookAccess::new(self.book_id(), Some(self.user_id())))
        } else {
            Err(denial(Some(self.role()), level))
        }
    }
}

// ---------------------------------------------------------------------------
// Book-scoped IDs
// ---------------------------------------------------------------------------

mod sealed {
    pub(crate) trait Sealed {}
}

/// A table with an `id` and a `book_id` column. The trait is sealed: the
/// name goes into SQL, so only this module names the tables.
pub(crate) trait Table: sealed::Sealed {
    const NAME: &'static str;
}

macro_rules! tables {
    ($($marker:ident => $name:literal),* $(,)?) => {$(
        #[derive(Clone, Copy, Debug, Eq, PartialEq)]
        pub(crate) enum $marker {}
        impl sealed::Sealed for $marker {}
        impl Table for $marker {
            const NAME: &'static str = $name;
        }
    )*};
}

tables! {
    Account => "accounts",
    Payee => "payees",
    RecurringRule => "recurring_rules",
    Security => "securities",
}

/// Proof that the row `id` of table `T` is in the book `book_id`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InBook<T> {
    id: i32,
    book_id: i32,
    _table: PhantomData<T>,
}

impl<T> InBook<T> {
    fn new(id: i32, book_id: i32) -> Self {
        Self {
            id,
            book_id,
            _table: PhantomData,
        }
    }

    pub(crate) fn id(&self) -> i32 {
        self.id
    }

    /// A test value that no check made. Only a test build has it.
    #[cfg(test)]
    pub(crate) fn unchecked(id: i32, book_id: i32) -> Self {
        Self::new(id, book_id)
    }
}

/// First-seen order without repeats, as `[...new Set(ids)]`.
fn unique(ids: &[i32]) -> Vec<i32> {
    let mut seen = HashSet::new();
    ids.iter().copied().filter(|id| seen.insert(*id)).collect()
}

/// The row `id` of `T`, if it is in the book of `access`.
pub(crate) fn row_in_book<T: Table, L>(
    sql: &impl Sql,
    access: &BookAccess<'_, L>,
    id: i32,
) -> Result<Option<InBook<T>>, store::Error> {
    let found: Option<i32> = sql.query_optional(
        &format!("SELECT id FROM {} WHERE id = ?1 AND book_id = ?2", T::NAME),
        &params![id, access.book_id()],
    )?;
    Ok(found.map(|id| InBook::new(id, access.book_id())))
}

/// The rows `ids` of `T`, without repeats and in first-seen order. `None`
/// when one or more of them is not in the book of `access`.
pub(crate) fn rows_in_book<T: Table, L>(
    sql: &impl Sql,
    access: &BookAccess<'_, L>,
    ids: &[i32],
) -> Result<Option<Vec<InBook<T>>>, store::Error> {
    let ids = unique(ids);
    if ids.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let found: HashSet<i32> = sql
        .query::<i32>(
            &format!(
                "SELECT id FROM {} WHERE book_id = ?1 AND id {}",
                T::NAME,
                ledger_db::sql::in_integers("?2")
            ),
            &params![access.book_id(), ledger_db::sql::json_array(&ids)],
        )?
        .into_iter()
        .collect();
    if found.len() != ids.len() {
        return Ok(None);
    }
    Ok(Some(
        ids.into_iter()
            .map(|id| InBook::new(id, access.book_id()))
            .collect(),
    ))
}

/// One account of a transaction's splits, with the columns that the split
/// rules read.
#[derive(Debug)]
pub(crate) struct SplitAccount {
    pub(crate) account: InBook<Account>,
    pub(crate) subtype: Option<String>,
    pub(crate) is_investment_cash: bool,
    /// The parent, only when the parent is an investment account in the
    /// same book. The foreign key of `accounts.parent_id` is book-scoped,
    /// and the query checks the book again.
    pub(crate) investment_parent: Option<InBook<Account>>,
}

/// The accounts `ids`, without repeats and in ID order. `None` when one or
/// more of them is not in the book of `access`.
pub(crate) fn split_accounts<L>(
    sql: &impl Sql,
    access: &BookAccess<'_, L>,
    ids: &[i32],
) -> Result<Option<Vec<SplitAccount>>, store::Error> {
    #[derive(ledger_db::store::FromRow)]
    struct Row {
        id: i32,
        subtype: Option<String>,
        is_investment_cash: bool,
        investment_parent_id: Option<i32>,
    }
    let ids = unique(ids);
    if ids.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let book_id = access.book_id();
    let rows: Vec<Row> = sql.query(
        &format!(
            "SELECT a.id, a.subtype, a.is_investment_cash,
                CASE WHEN p.subtype = 'investment' THEN p.id ELSE NULL END AS investment_parent_id
         FROM accounts a
         LEFT JOIN accounts p ON p.id = a.parent_id AND p.book_id = ?1
         WHERE a.book_id = ?1 AND a.id {in2}
         ORDER BY a.id",
            in2 = ledger_db::sql::in_integers("?2")
        ),
        &params![book_id, ledger_db::sql::json_array(&ids)],
    )?;
    if rows.len() != ids.len() {
        return Ok(None);
    }
    Ok(Some(
        rows.into_iter()
            .map(|row| SplitAccount {
                account: InBook::new(row.id, book_id),
                subtype: row.subtype,
                is_investment_cash: row.is_investment_cash,
                investment_parent: row.investment_parent_id.map(|id| InBook::new(id, book_id)),
            })
            .collect(),
    ))
}

/// The payee of the book whose name matches `name` without letter case. A
/// payee name is matched without case ("IKEA" and "Ikea" are one payee); where
/// case variants still exist, the exact spelling wins, then the oldest payee.
/// `name` is already normalized.
pub(crate) fn find_payee_by_name(
    sql: &impl Sql,
    book_id: i32,
    name: &str,
) -> Result<Option<i32>, store::Error> {
    sql.query_optional(
        "SELECT id FROM payees WHERE book_id = ?1 AND name_fold = ?2
         ORDER BY name = ?3 DESC, id LIMIT 1",
        &params![book_id, ledger_db::folds::fold(name), name],
    )
}

/// `resolvePayeeId`: a case-insensitive match (`find_payee_by_name`), or a
/// new payee. The upsert covers a concurrent insert of the same name between
/// the two statements.
pub(crate) fn resolve_payee(
    sql: &impl Sql,
    access: &BookAccess<'_, Write>,
    payee_name: &str,
) -> Result<Option<InBook<Payee>>, store::Error> {
    let book_id = access.book_id();
    let name = normalize_name(payee_name);
    if name.is_empty() {
        return Ok(None);
    }
    let existing = find_payee_by_name(sql, book_id, &name)?;
    if existing.is_some() {
        return Ok(existing.map(|id| InBook::new(id, book_id)));
    }
    let inserted: Option<i32> = sql.query_optional(
        "INSERT INTO payees (name, book_id, created_at, name_fold) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (name, book_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id",
        &params![&name, book_id, now_millis(), ledger_db::folds::fold(&name)],
    )?;
    Ok(inserted.map(|id| InBook::new(id, book_id)))
}

// ---------------------------------------------------------------------------
// Proved splits
// ---------------------------------------------------------------------------

/// Splits that passed `validate_splits` (critical accounting rule 1): each
/// amount is in the int4 range, and the amounts sum to zero. The accounts
/// are not checked yet.
#[derive(Debug)]
pub(crate) struct BalancedSplits<'a> {
    splits: &'a [SplitInput],
}

impl<'a> BalancedSplits<'a> {
    pub(crate) fn new(splits: &'a [SplitInput]) -> Option<Self> {
        let amounts: Vec<i64> = splits.iter().map(|split| split.amount).collect();
        validate_splits(&amounts).then_some(Self { splits })
    }
}

/// Splits that sum to zero, each on an account of this book.
#[derive(Debug)]
pub(crate) struct ProvedSplits {
    book_id: i32,
    rows: Vec<(InBook<Account>, i32)>,
}

impl ProvedSplits {
    /// `None` when a split's account is not in `accounts`, or when
    /// `accounts` are of another book.
    pub(crate) fn new(
        access: &BookAccess<'_, Write>,
        balanced: BalancedSplits<'_>,
        accounts: &[SplitAccount],
    ) -> Option<Self> {
        let accounts: Vec<InBook<Account>> =
            accounts.iter().map(|account| account.account).collect();
        Self::on_accounts(access, balanced, &accounts)
    }

    /// As `new`, for a write that needs only the account proofs of
    /// `rows_in_book`, such as the template splits of a recurring rule.
    pub(crate) fn on_accounts(
        access: &BookAccess<'_, Write>,
        balanced: BalancedSplits<'_>,
        accounts: &[InBook<Account>],
    ) -> Option<Self> {
        let book_id = access.book_id();
        let rows = balanced
            .splits
            .iter()
            .map(|split| {
                let account = accounts.iter().copied().find(|account| {
                    account.book_id == book_id && i64::from(account.id) == split.account_id
                })?;
                // validate_splits keeps each amount in the int4 range.
                Some((account, i32::try_from(split.amount).ok()?))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self { book_id, rows })
    }

    pub(crate) fn book_id(&self) -> i32 {
        self.book_id
    }

    /// The account and the amount of each split, in the order sent.
    pub(crate) fn rows(&self) -> &[(InBook<Account>, i32)] {
        &self.rows
    }

    /// The `[account_id, amount]` row of each split, in the order sent, as JSON, to bind for
    /// `ledger_db::sql::json_rows`: `#0` is the account, `#1` the amount.
    pub(crate) fn json_rows(&self) -> String {
        let rows: Vec<(i32, i32)> = self
            .rows()
            .iter()
            .map(|(account, amount)| (account.id(), *amount))
            .collect();
        ledger_db::sql::json_array(&rows)
    }
}

/// Investment splits whose securities, and whose investment account, are in
/// this book. The route checks the values and the actions before.
#[derive(Debug)]
pub(crate) struct ProvedInvestmentSplits<'a> {
    book_id: i32,
    splits: Vec<(&'a InvestmentSplitInput, InBook<Security>)>,
    account: Option<InBook<Account>>,
}

impl<'a> ProvedInvestmentSplits<'a> {
    /// `None` when a split's security is not in `securities`, or when a proof
    /// is of another book.
    pub(crate) fn new(
        access: &BookAccess<'_, Write>,
        splits: &'a [InvestmentSplitInput],
        securities: &[InBook<Security>],
        account: Option<InBook<Account>>,
    ) -> Option<Self> {
        let book_id = access.book_id();
        if account.is_some_and(|account| account.book_id != book_id) {
            return None;
        }
        let splits = splits
            .iter()
            .map(|split| {
                let security = securities.iter().copied().find(|security| {
                    security.book_id == book_id && i64::from(security.id) == split.security_id
                })?;
                Some((split, security))
            })
            .collect::<Option<Vec<_>>>()?;
        Some(Self {
            book_id,
            splits,
            account,
        })
    }

    pub(crate) fn book_id(&self) -> i32 {
        self.book_id
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.splits.is_empty()
    }

    /// Each split as sent, with its security, in the order sent.
    pub(crate) fn splits(&self) -> &[(&'a InvestmentSplitInput, InBook<Security>)] {
        &self.splits
    }

    /// The brokerage account of a buy or a sell, or the parent of the
    /// investment-cash leg. `None` for a dividend into a plain bank account.
    pub(crate) fn account(&self) -> Option<InBook<Account>> {
        self.account
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::book_auth::BookRole;
    use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};
    use ledger_core::accounting::InvestmentAction;
    use serde_json::json;

    const NOW: &str = "2025-01-01T00:00:00.000Z";

    async fn refusal(result: Result<impl std::fmt::Debug, ApiError>) -> (StatusCode, String) {
        let response = result.unwrap_err().into_response();
        let status = response.status();
        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn levels_match_authenticate_book() {
        let viewer = AuthenticatedBook::unchecked(1, 1, BookRole::Viewer);
        let editor = AuthenticatedBook::unchecked(1, 1, BookRole::Editor);
        let owner = AuthenticatedBook::unchecked(1, 1, BookRole::Owner);
        assert_eq!(viewer.read().book_id(), 1);
        assert_eq!(
            refusal(viewer.write()).await,
            (
                StatusCode::FORBIDDEN,
                r#"{"error":"You have read-only access to this book"}"#.into()
            )
        );
        assert!(editor.write().is_ok());
        assert_eq!(
            refusal(editor.owner()).await,
            (
                StatusCode::FORBIDDEN,
                r#"{"error":"Only an owner can do this"}"#.into()
            )
        );
        let write: BookAccess<'_, Write> = owner.owner().unwrap().into();
        let read: BookAccess<'_, Read> = write.into();
        assert_eq!(read.user_id(), Some(1));

        // A scheduled job writes with no user. Its proof is of one book.
        let job = BookAccess::for_system_job(3);
        assert_eq!((job.book_id(), job.user_id()), (3, None));
        let detached: BookAccess<'static, Write> = owner.write().unwrap().detach();
        assert_eq!((detached.book_id(), detached.user_id()), (1, Some(1)));
    }

    /// Two books. Each has a bank account, an investment account, its cash
    /// sub-account, and a security. Returns the database and the account
    /// IDs of each book: (bank, investment, cash, security).
    fn two_books() -> (ledger_db::Database, [[i32; 4]; 2]) {
        let database = ledger_db::Database::open_in_memory().unwrap();
        ledger_db::migrate(&database).unwrap();
        database
            .execute(
                "INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'u', 'x', ?1)",
                &params![NOW],
            )
            .unwrap();
        let mut ids = [[0; 4]; 2];
        for (index, book_id) in [1, 2].into_iter().enumerate() {
            database
                .execute(
                    "INSERT INTO books (id, user_id, name, created_at, updated_at)
                     VALUES (?1, 1, 'b', ?2, ?2)",
                    &params![book_id, NOW],
                )
                .unwrap();
            let account = |name: &str, subtype: &str, parent: Option<i32>| -> i32 {
                database
                    .query_row(
                        "INSERT INTO accounts (book_id, name, type, subtype, parent_id,
                           is_investment_cash, created_at, updated_at)
                         VALUES (?1, ?2, 'asset', ?3, ?4, ?5, ?6, ?6) RETURNING id",
                        &params![book_id, name, subtype, parent, parent.is_some(), NOW],
                    )
                    .unwrap()
            };
            let bank = account("Bank", "bank", None);
            let investment = account("Brokerage", "investment", None);
            let cash = account("Brokerage Cash", "cash", Some(investment));
            let security: i32 = database
                .query_row(
                    "INSERT INTO securities (book_id, name, symbol, security_type, created_at)
                     VALUES (?1, 'Fund', 'F', 'fund', ?2) RETURNING id",
                    &params![book_id, NOW],
                )
                .unwrap();
            ids[index] = [bank, investment, cash, security];
        }
        (database, ids)
    }

    #[tokio::test]
    async fn rows_of_another_book_give_no_proof() {
        let (database, [mine, theirs]) = two_books();
        let pool = &database;
        let book = AuthenticatedBook::unchecked(1, 1, BookRole::Editor);
        let access = book.read();

        let proof = row_in_book::<Account, _>(pool, &access, mine[0])
            .unwrap()
            .unwrap();
        assert_eq!((proof.id(), proof.book_id), (mine[0], 1));
        assert!(
            row_in_book::<Account, _>(pool, &access, theirs[0])
                .unwrap()
                .is_none()
        );
        // The table of the marker is the table that is read.
        assert!(
            row_in_book::<Security, _>(pool, &access, mine[3])
                .unwrap()
                .is_some()
        );

        let proofs = rows_in_book::<Account, _>(pool, &access, &[mine[1], mine[0], mine[1]])
            .unwrap()
            .unwrap();
        assert_eq!(
            proofs.iter().map(InBook::id).collect::<Vec<_>>(),
            vec![mine[1], mine[0]]
        );
        assert!(
            rows_in_book::<Account, _>(pool, &access, &[mine[0], theirs[0]])
                .unwrap()
                .is_none()
        );
        assert_eq!(
            rows_in_book::<Account, _>(pool, &access, &[])
                .unwrap()
                .unwrap()
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn split_accounts_prove_the_account_and_the_investment_parent() {
        let (database, [mine, theirs]) = two_books();
        let pool = &database;
        let book = AuthenticatedBook::unchecked(1, 1, BookRole::Editor);
        let access = book.write().unwrap();

        let accounts = split_accounts(pool, &access, &[mine[2], mine[0], mine[2]])
            .unwrap()
            .unwrap();
        assert_eq!(
            accounts
                .iter()
                .map(|account| account.account.id())
                .collect::<Vec<_>>(),
            vec![mine[0], mine[2]]
        );
        let cash = &accounts[1];
        assert!(cash.is_investment_cash);
        assert_eq!(
            cash.investment_parent.map(|parent| parent.id()),
            Some(mine[1])
        );
        assert!(
            split_accounts(pool, &access, &[mine[0], theirs[0]])
                .unwrap()
                .is_none()
        );

        // A proof of book 1 does not unlock a write in book 2.
        let other_book = AuthenticatedBook::unchecked(2, 1, BookRole::Editor);
        let other = other_book.write().unwrap();
        let splits = [
            SplitInput {
                account_id: i64::from(mine[0]),
                amount: 500,
            },
            SplitInput {
                account_id: i64::from(mine[2]),
                amount: -500,
            },
        ];
        let balanced = || BalancedSplits::new(&splits).unwrap();
        let proved = ProvedSplits::new(&access, balanced(), &accounts).unwrap();
        assert_eq!(proved.book_id(), 1);
        assert_eq!(
            proved
                .rows()
                .iter()
                .map(|(account, amount)| (account.id(), *amount))
                .collect::<Vec<_>>(),
            vec![(mine[0], 500), (mine[2], -500)]
        );
        assert!(ProvedSplits::new(&other, balanced(), &accounts).is_none());
        // Each split needs its own account proof.
        assert!(ProvedSplits::new(&access, balanced(), &accounts[..1]).is_none());
    }

    #[tokio::test]
    async fn template_splits_and_payees_are_proved_in_the_book() {
        let (database, [mine, theirs]) = two_books();
        let pool = &database;
        let book = AuthenticatedBook::unchecked(1, 1, BookRole::Editor);
        let access = book.write().unwrap();
        let split = |account_id: i32, amount| SplitInput {
            account_id: i64::from(account_id),
            amount,
        };

        // The recurring routes prove template splits with the account
        // proofs of `rows_in_book` only.
        let accounts = rows_in_book::<Account, _>(pool, &access, &[mine[0], mine[2]])
            .unwrap()
            .unwrap();
        let splits = [split(mine[0], 700), split(mine[2], -700)];
        let proved =
            ProvedSplits::on_accounts(&access, BalancedSplits::new(&splits).unwrap(), &accounts)
                .unwrap();
        assert_eq!(
            proved
                .rows()
                .iter()
                .map(|(account, amount)| (account.id(), *amount))
                .collect::<Vec<_>>(),
            vec![(mine[0], 700), (mine[2], -700)]
        );
        let foreign = [split(theirs[0], 700), split(mine[2], -700)];
        assert!(
            ProvedSplits::on_accounts(&access, BalancedSplits::new(&foreign).unwrap(), &accounts)
                .is_none()
        );

        // A payee by name: a case-insensitive match, or a new payee, always
        // in the book of the access.
        let payee = resolve_payee(pool, &access, "  Corner   Shop ")
            .unwrap()
            .unwrap();
        assert_eq!(payee.book_id, 1);
        let again = resolve_payee(pool, &access, "corner shop").unwrap();
        assert_eq!(again, Some(payee));
        assert!(resolve_payee(pool, &access, "   ").unwrap().is_none());
        let other_book = AuthenticatedBook::unchecked(2, 1, BookRole::Editor);
        let other = other_book.write().unwrap();
        let theirs = resolve_payee(pool, &other, "Corner Shop").unwrap().unwrap();
        assert_ne!(theirs.id(), payee.id());
        assert!(
            row_in_book::<Payee, _>(pool, &access, theirs.id())
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn unbalanced_splits_give_no_proof() {
        let split = |amount| SplitInput {
            account_id: 1,
            amount,
        };
        assert!(BalancedSplits::new(&[split(500), split(-400)]).is_none());
        assert!(BalancedSplits::new(&[split(i64::from(i32::MAX) + 1), split(-1)]).is_none());
        assert!(BalancedSplits::new(&[split(500), split(-500)]).is_some());
    }

    #[tokio::test]
    async fn investment_splits_need_securities_of_the_book() {
        let (database, [mine, theirs]) = two_books();
        let pool = &database;
        let book = AuthenticatedBook::unchecked(1, 1, BookRole::Owner);
        let access = book.write().unwrap();
        let split = |security_id: i32| InvestmentSplitInput {
            raw: json!({}),
            security_id: i64::from(security_id),
            action: InvestmentAction::Buy,
            shares_micros: 1_000_000,
            price_micros: 1_000_000,
            fees_cents: None,
            split_numerator: None,
            split_denominator: None,
        };
        let securities = rows_in_book::<Security, _>(pool, &access, &[mine[3]])
            .unwrap()
            .unwrap();
        let account = row_in_book::<Account, _>(pool, &access, mine[1]).unwrap();
        let splits = [split(mine[3])];
        let proved = ProvedInvestmentSplits::new(&access, &splits, &securities, account).unwrap();
        assert_eq!(proved.account().map(|account| account.id()), Some(mine[1]));
        assert_eq!(proved.splits()[0].1.id(), mine[3]);
        assert!(
            ProvedInvestmentSplits::new(&access, &[split(theirs[3])], &securities, account)
                .is_none()
        );
        let other_book = AuthenticatedBook::unchecked(2, 1, BookRole::Owner);
        let other = other_book.write().unwrap();
        assert!(ProvedInvestmentSplits::new(&other, &splits, &[], None).is_none());
        assert!(ProvedInvestmentSplits::new(&other, &[], &[], account).is_none());
    }
}
