//! Maintenance commands that run outside the HTTP server.
//!
//! `rebuild-lots [--force]` regenerates investment lots and allocations from
//! investment splits, as `scripts/rebuild-lots.ts` does. It exits 1 on
//! failure, because a deploy that continues after a failed backfill serves
//! zero cost basis with no visible error.
//!
//! `seed [--book-id N]` writes the sample dataset. Without `--book-id`, it
//! also creates the `admin` user and the "Family Finances" book. It does not
//! reset the schema or run migrations: `npm run db:seed` does both first,
//! because Drizzle is the only migrator.
//!
//! `import-moneydance <path> --book-id N [options]` imports a Moneydance JSON
//! export into an existing book. One transaction holds the run, so a failure
//! leaves the book as it was.

mod import_moneydance;

use std::{env, process::ExitCode, time::Instant};

use scrypt::{Params, scrypt};
use sqlx::PgPool;

const DEFAULT_DATABASE_URL: &str =
    "postgresql://counterpoise:counterpoise@localhost:5432/counterpoise_dev";

type CliResult<T> = Result<T, Box<dyn std::error::Error>>;

/// The zone `CURRENT_DATE` must use: the same zone as the Node process that
/// shares this database.
fn time_zone() -> Result<String, iana_time_zone::GetTimezoneError> {
    match env::var("TZ") {
        Ok(zone) if !zone.is_empty() => Ok(zone),
        _ => iana_time_zone::get_timezone(),
    }
}

async fn connect() -> CliResult<PgPool> {
    let database_url = env::var("DATABASE_URL")
        .ok()
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| DEFAULT_DATABASE_URL.to_owned());
    Ok(ledger_db::connect(&database_url, &time_zone()?).await?)
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

/// Seeds `book_id`, or a new `admin` user and book when it is `None`. One
/// transaction holds the whole run, so a failure leaves no partial book.
async fn seed(book_id: Option<i32>) -> CliResult<Result<(), String>> {
    let pool = connect().await?;
    let mut transaction = pool.begin().await?;
    let book_id = match book_id {
        Some(book_id) => {
            let name: Option<String> = sqlx::query_scalar("SELECT name FROM books WHERE id = $1")
                .bind(book_id)
                .fetch_optional(&mut *transaction)
                .await?;
            let Some(name) = name else {
                return Ok(Err(format!(
                    "Error: book {book_id} not found. Use 'npm run db:list-books' to see available books."
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
            let book_id: i32 = sqlx::query_scalar(
                "INSERT INTO books (user_id, name, created_at, updated_at)
                 VALUES ($1, 'Family Finances', $2, $2) RETURNING id",
            )
            .bind(user_id)
            .bind(now)
            .fetch_one(&mut *transaction)
            .await?;
            println!(
                "  Created user 'admin' (password: 'password') and book 'Family Finances' (id: {book_id})"
            );
            book_id
        }
    };
    let today = chrono::Local::now().date_naive();
    ledger_db::seed::seed_book(&mut transaction, book_id, today, &mut |line| {
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
    let mut transaction = pool.begin().await?;
    let book: Option<String> = sqlx::query_scalar("SELECT name FROM books WHERE id = $1")
        .bind(args.book_id)
        .fetch_optional(&mut *transaction)
        .await?;
    if book.is_none() {
        return Ok(Err(format!(
            "Error: book {} not found. Use 'npm run db:list-books' to see available books.",
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
        Some("seed") => {
            let book_id = match book_id_argument(&args[1..]) {
                Ok(book_id) => book_id,
                Err(message) => {
                    eprintln!("{message}");
                    return ExitCode::FAILURE;
                }
            };
            match seed(book_id).await {
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
            eprintln!("usage: ledger-cli rebuild-lots [--force]");
            eprintln!("       ledger-cli seed [--book-id N]");
            eprintln!("       ledger-cli import-moneydance <path-to-json> --book-id N [options]");
            ExitCode::from(2)
        }
    }
}
