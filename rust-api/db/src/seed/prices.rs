//! Security prices.

use chrono::NaiveDate;
use sqlx::QueryBuilder;

use super::window::{Window, format_date};
use super::{SeedError, SeedResult, Seeder, js_round};
use crate::engine::Db;

// Month-end prices in cents, oldest first. A window of N months uses the
// last N values.
#[rustfmt::skip]
pub(super) const VTI_PRICES: [i64; 36] = [
    19400, 19650, 19380, 20020, 20210, 20850, 21340, 21060, 20530, 21170, 21890, 22250,
    22510, 22840, 23370, 23690, 24020, 24560, 24930, 25280, 24850, 25540, 26010, 26480,
    26230, 26750, 27080, 27510, 27240, 27890, 28350, 28020, 27680, 28240, 28810, 29250,
];
#[rustfmt::skip]
pub(super) const VXUS_PRICES: [i64; 36] = [
    5280, 5340, 5190, 5370, 5280, 5420, 5560, 5430, 5290, 5380, 5510, 5580,
    5640, 5720, 5810, 5890, 5970, 6050, 6140, 6080, 5950, 6090, 6210, 6300,
    6250, 6380, 6450, 6530, 6410, 6570, 6680, 6620, 6500, 6640, 6780, 6850,
];
#[rustfmt::skip]
pub(super) const BND_PRICES: [i64; 36] = [
    7320, 7280, 7350, 7390, 7310, 7260, 7190, 7150, 7080, 7140, 7280, 7350,
    7380, 7420, 7460, 7430, 7390, 7450, 7510, 7560, 7520, 7580, 7630, 7680,
    7710, 7750, 7790, 7830, 7800, 7860, 7910, 7950, 7920, 7980, 8030, 8080,
];
#[rustfmt::skip]
pub(super) const AGG_PRICES: [i64; 36] = [
    9840, 9780, 9860, 9910, 9830, 9770, 9690, 9640, 9570, 9650, 9790, 9860,
    9900, 9950, 10000, 9970, 9920, 9980, 10050, 10110, 10070, 10130, 10190, 10250,
    10280, 10330, 10380, 10420, 10390, 10450, 10510, 10560, 10520, 10580, 10640, 10700,
];

/// The months that each price curve holds.
const CURVE_MONTHS: usize = 36;

#[derive(Clone, Copy)]
pub(super) struct Security {
    pub id: i32,
    pub symbol: &'static str,
    prices: &'static [i64; CURVE_MONTHS],
    window: Window,
}

impl Security {
    pub fn new(
        id: i32,
        symbol: &'static str,
        prices: &'static [i64; CURVE_MONTHS],
        window: Window,
    ) -> Self {
        assert!(
            window.months as usize <= CURVE_MONTHS,
            "a price curve holds {CURVE_MONTHS} months"
        );
        Self {
            id,
            symbol,
            prices,
            window,
        }
    }

    /// The month-end price, in micros, of the month that holds `date`. Month
    /// `i` of an `N`-month window uses value `36 - N + i`, so the last month
    /// of each window gets the latest price.
    pub fn price_micros(&self, date: NaiveDate) -> SeedResult<i64> {
        self.window
            .month_index(date)
            .map(|index| CURVE_MONTHS - self.window.months as usize + index)
            .and_then(|index| self.prices.get(index))
            .map(|cents| cents * 10_000)
            .ok_or_else(|| {
                SeedError::Invalid(format!("No price for security {} on {date}", self.id))
            })
    }
}

/// The 401(k) employee limit of `year`, in cents.
pub(super) fn limit_401k(year: i32) -> i64 {
    match year {
        ..=2023 => 2_250_000,
        2024 => 2_300_000,
        2025 => 2_350_000,
        _ => 2_450_000,
    }
}

/// The IRA limit of `year`, in cents.
pub(super) fn limit_ira(year: i32) -> i64 {
    match year {
        ..=2023 => 650_000,
        2024 | 2025 => 700_000,
        _ => 750_000,
    }
}

pub(super) async fn seed_prices(
    seeder: &mut Seeder<'_>,
    securities: &[Security],
    window: Window,
) -> SeedResult<()> {
    let mut rows: Vec<(i32, String, i64)> =
        Vec::with_capacity(securities.len() * window.months as usize);
    for security in securities {
        for (index, year, month) in window.months() {
            let cents = security.prices[CURVE_MONTHS - window.months as usize + index];
            // The month of today has no month end yet, so its price is
            // dated today.
            let price_date = window.on(year, month, 31).unwrap_or(window.today);
            // Noise of plus or minus 0.5 percent from the generator.
            let noise = 1.0 + (seeder.rand.next() - 0.5) * 0.01;
            let price_cents = js_round(cents as f64 * noise) as i64;
            rows.push((security.id, format_date(price_date), price_cents * 10_000));
        }
    }
    let book_id = seeder.book_id;
    let mut insert = QueryBuilder::<Db>::new(
        "INSERT INTO security_prices (book_id, security_id, price_date, price_micros, source) ",
    );
    insert.push_values(&rows, |mut row, (security_id, price_date, price_micros)| {
        row.push_bind(book_id)
            .push_bind(*security_id)
            .push_bind(price_date.clone())
            .push_bind(*price_micros)
            .push_bind("seed");
    });
    insert.build().execute(&mut *seeder.connection).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seed::window::date;

    #[test]
    fn the_last_month_gets_the_latest_price() {
        let short = Security::new(1, "VTI", &VTI_PRICES, Window::new(date(2026, 9, 15), 24));
        assert_eq!(
            short.price_micros(date(2026, 9, 1)).unwrap(),
            29_250 * 10_000
        );
        assert_eq!(
            short.price_micros(date(2024, 10, 31)).unwrap(),
            22_510 * 10_000
        );
        assert!(short.price_micros(date(2024, 9, 30)).is_err());
        let full = Security::new(1, "VTI", &VTI_PRICES, Window::new(date(2025, 12, 31), 36));
        assert_eq!(
            full.price_micros(date(2023, 1, 6)).unwrap(),
            19_400 * 10_000
        );
    }

    #[test]
    fn limits_use_the_latest_known_year() {
        assert_eq!(limit_401k(2022), 2_250_000);
        assert_eq!(limit_401k(2025), 2_350_000);
        assert_eq!(limit_401k(2030), 2_450_000);
        assert_eq!(limit_ira(2023), 650_000);
        assert_eq!(limit_ira(2025), 700_000);
        assert_eq!(limit_ira(2026), 750_000);
    }
}
