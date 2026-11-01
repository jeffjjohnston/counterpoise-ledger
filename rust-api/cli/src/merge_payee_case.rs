//! `merge-payee-case --book-id N [--keep NAME]... [--apply]`: merges the
//! payees of a book whose names differ only by letter case ("PayPal" and
//! "Paypal") into one payee. The app matches payee names without letter case,
//! so such a group is one payee that the Moneydance import split.
//!
//! In each group, the kept payee is the one whose exact name a `--keep`
//! gives, else the one with the most transactions (then the lowest ID). The
//! transactions and the recurring rules of the other payees move to it, and
//! the other payees are deleted. Without `--apply` the command only prints the
//! plan. One database transaction holds the merge.

use ledger_db::Database;
use ledger_db::store::{self, Sql, params};
use std::collections::HashMap;

pub struct Options {
    pub book_id: i32,
    pub keep: Vec<String>,
    pub apply: bool,
}

struct Payee {
    id: i64,
    name: String,
    transactions: i64,
}

struct Group {
    kept: Payee,
    merged: Vec<Payee>,
}

/// The value after each `--keep`, the book, and `--apply`.
pub fn parse_args(args: &[String]) -> Result<Options, String> {
    let mut book_id = None;
    let mut keep = Vec::new();
    let mut apply = false;
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--book-id" => {
                let value = args
                    .get(index + 1)
                    .ok_or("Error: --book-id requires a numeric argument")?;
                book_id = Some(
                    value
                        .parse()
                        .map_err(|_| format!("Error: invalid book ID \"{value}\""))?,
                );
                index += 1;
            }
            "--keep" => {
                let value = args
                    .get(index + 1)
                    .ok_or("Error: --keep requires a payee name")?;
                keep.push(value.clone());
                index += 1;
            }
            "--apply" => apply = true,
            other => return Err(format!("Error: unknown argument \"{other}\"")),
        }
        index += 1;
    }
    Ok(Options {
        book_id: book_id.ok_or("Error: --book-id is required")?,
        keep,
        apply,
    })
}

/// The groups of the book, with the kept payee chosen. An error names a
/// `--keep` that is not the exact name of a payee in a group.
fn plan(payees: Vec<Payee>, keep: &[String]) -> Result<Vec<Group>, String> {
    let mut groups: HashMap<String, Vec<Payee>> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    for payee in payees {
        let key = payee.name.to_lowercase();
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(payee);
    }
    let mut used = vec![false; keep.len()];
    let mut plan = Vec::new();
    for key in order {
        let mut members = groups.remove(&key).unwrap_or_default();
        if members.len() < 2 {
            continue;
        }
        let named = keep
            .iter()
            .position(|name| members.iter().any(|payee| &payee.name == name));
        let kept_index = match named {
            Some(position) => {
                used[position] = true;
                members
                    .iter()
                    .position(|payee| payee.name == keep[position])
                    .unwrap_or(0)
            }
            None => {
                // The most transactions, then the lowest ID.
                let mut best = 0;
                for (index, payee) in members.iter().enumerate() {
                    let current = &members[best];
                    if payee.transactions > current.transactions
                        || (payee.transactions == current.transactions && payee.id < current.id)
                    {
                        best = index;
                    }
                }
                best
            }
        };
        let kept = members.remove(kept_index);
        plan.push(Group {
            kept,
            merged: members,
        });
    }
    if let Some(position) = used.iter().position(|used| !used) {
        return Err(format!(
            "Error: --keep \"{}\" is not the exact name of a payee in a group of case variants",
            keep[position]
        ));
    }
    plan.sort_by(|a, b| a.kept.name.cmp(&b.kept.name));
    Ok(plan)
}

/// Prints the plan, and applies it with `--apply`. An `Err` string is a
/// message for the user; the outer error is a database failure.
pub fn run(database: &Database, options: &Options) -> Result<Result<(), String>, store::Error> {
    let book_id = options.book_id;
    let exists: Option<i32> =
        database.query_optional("SELECT id FROM books WHERE id = ?1", &params![book_id])?;
    if exists.is_none() {
        return Ok(Err(format!(
            "Error: book {book_id} not found. Use 'ledger-cli list-books' to see available books."
        )));
    }
    database.transaction(|tx| merge(tx, options))
}

fn merge(tx: &impl Sql, options: &Options) -> Result<Result<(), String>, store::Error> {
    let book_id = options.book_id;
    let rows: Vec<(i64, String, i64)> = tx.query(
        "SELECT p.id, p.name,
                (SELECT COUNT(*) FROM transactions t WHERE t.payee_id = p.id)
         FROM payees p WHERE p.book_id = ?1 ORDER BY p.id",
        &params![book_id],
    )?;
    let payees = rows
        .into_iter()
        .map(|(id, name, transactions)| Payee {
            id,
            name,
            transactions,
        })
        .collect();
    let groups = match plan(payees, &options.keep) {
        Ok(groups) => groups,
        Err(message) => return Ok(Err(message)),
    };
    println!(
        "Book {book_id}: {} group(s) of payees that differ only by letter case.",
        groups.len()
    );
    for group in &groups {
        let merged: Vec<String> = group
            .merged
            .iter()
            .map(|payee| format!("\"{}\" ({} tx)", payee.name, payee.transactions))
            .collect();
        println!(
            "  keep \"{}\" ({} tx) <- {}",
            group.kept.name,
            group.kept.transactions,
            merged.join(", ")
        );
    }
    if !options.apply {
        println!("DRY RUN: nothing was changed. Add --apply to merge.");
        return Ok(Ok(()));
    }
    let mut moved = 0;
    for group in &groups {
        for payee in &group.merged {
            for statement in [
                "UPDATE transactions SET payee_id = ?1 WHERE payee_id = ?2 AND book_id = ?3",
                "UPDATE recurring_rules SET payee_id = ?1 WHERE payee_id = ?2 AND book_id = ?3",
                "UPDATE typesafe_entry_evaluations SET payee_id = ?1 WHERE payee_id = ?2 AND book_id = ?3",
            ] {
                moved += tx.execute(statement, &params![group.kept.id, payee.id, book_id])?;
            }
            tx.execute(
                "DELETE FROM payees WHERE id = ?1 AND book_id = ?2",
                &params![payee.id, book_id],
            )?;
        }
    }
    let deleted: usize = groups.iter().map(|group| group.merged.len()).sum();
    println!("Merged: {deleted} payee(s) deleted, {moved} row(s) moved to the kept payees.");
    Ok(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payee(id: i64, name: &str, transactions: i64) -> Payee {
        Payee {
            id,
            name: name.into(),
            transactions,
        }
    }

    #[test]
    fn the_plan_keeps_the_most_used_spelling_or_the_named_one() {
        let payees = || {
            vec![
                payee(1, "PayPal", 9),
                payee(2, "Paypal", 7),
                payee(3, "Groupon", 2),
                payee(4, "GroupOn", 2),
                payee(5, "Alone", 1),
            ]
        };
        let groups = plan(payees(), &[]).unwrap();
        let kept: Vec<&str> = groups
            .iter()
            .map(|group| group.kept.name.as_str())
            .collect();
        assert_eq!(kept, ["Groupon", "PayPal"], "a tie keeps the lowest ID");
        let groups = plan(payees(), &["GroupOn".into()]).unwrap();
        assert_eq!(groups[0].kept.name, "GroupOn");
        assert!(plan(payees(), &["GROUPON".into()]).is_err());
        assert!(plan(payees(), &["Alone".into()]).is_err());
    }
}
