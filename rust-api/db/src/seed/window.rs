//! The dates of a dataset.

use chrono::{Datelike, Days, Months, NaiveDate};

pub(super) fn date(year: i32, month: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(year, month, day).expect("seed dates are valid")
}

pub(super) fn last_day_of_month(year: i32, month: u32) -> u32 {
    let first = date(year, month, 1);
    (first + Months::new(1) - Days::new(1)).day()
}

pub(super) fn format_date(value: NaiveDate) -> String {
    value.format("%Y-%m-%d").to_string()
}

/// The months of a dataset: `months` months that end with the month of
/// `today`. No row of a dataset has a date after `today`.
#[derive(Clone, Copy, Debug)]
pub(super) struct Window {
    pub today: NaiveDate,
    /// The first day of the first month.
    pub start: NaiveDate,
    pub months: u32,
}

impl Window {
    pub fn new(today: NaiveDate, months: u32) -> Self {
        assert!(months >= 1, "a window has at least one month");
        let first = today.with_day(1).expect("every month has a day 1");
        Self {
            today,
            start: first - Months::new(months - 1),
            months,
        }
    }

    /// The opening balances go on the day before the first month.
    pub fn opening_date(&self) -> NaiveDate {
        self.start - Days::new(1)
    }

    /// `(index, year, month)` of each month, oldest first. `month` is 1 to 12.
    pub fn months(&self) -> impl Iterator<Item = (usize, i32, u32)> {
        let start = self.start;
        (0..self.months).map(move |index| {
            let first = start + Months::new(index);
            (index as usize, first.year(), first.month())
        })
    }

    /// `day` of the month, clamped to the last day of the month. `None`
    /// when that date is after `today`.
    pub fn on(&self, year: i32, month: u32, day: u32) -> Option<NaiveDate> {
        let value = date(year, month, day.min(last_day_of_month(year, month)));
        (value <= self.today).then_some(value)
    }

    /// The index of the month that holds `value`, or `None` outside the
    /// window.
    pub fn month_index(&self, value: NaiveDate) -> Option<usize> {
        let index = (value.year() - self.start.year()) * 12 + value.month() as i32
            - self.start.month() as i32;
        (0..self.months as i32)
            .contains(&index)
            .then_some(index as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_ends_with_the_month_of_today() {
        let window = Window::new(date(2025, 12, 31), 36);
        assert_eq!(window.start, date(2023, 1, 1));
        assert_eq!(window.opening_date(), date(2022, 12, 31));
        let months: Vec<_> = window.months().collect();
        assert_eq!(months.len(), 36);
        assert_eq!(months[0], (0, 2023, 1));
        assert_eq!(months[35], (35, 2025, 12));
        assert_eq!(window.month_index(date(2024, 2, 29)), Some(13));
        assert_eq!(window.month_index(date(2026, 1, 1)), None);
        assert_eq!(window.month_index(date(2022, 12, 31)), None);
    }

    #[test]
    fn on_clamps_the_day_and_refuses_the_future() {
        let window = Window::new(date(2028, 2, 29), 24);
        assert_eq!(window.start, date(2026, 3, 1));
        assert_eq!(window.on(2028, 2, 31), Some(date(2028, 2, 29)));
        assert_eq!(window.on(2027, 2, 31), Some(date(2027, 2, 28)));
        let first = Window::new(date(2026, 10, 1), 36);
        assert_eq!(first.on(2026, 10, 1), Some(date(2026, 10, 1)));
        assert_eq!(first.on(2026, 10, 2), None);
    }
}
