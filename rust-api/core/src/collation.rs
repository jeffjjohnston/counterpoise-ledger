//! Name ordering matching JavaScript's default English `localeCompare`.

use std::{cmp::Ordering, sync::OnceLock};

use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use icu_locale::locale;

pub fn compare_names(left: &str, right: &str) -> Ordering {
    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(locale!("en-US").into(), CollatorOptions::default())
                .expect("compiled English collation data")
        })
        .compare(left, right)
}
