//! Name ordering matching JavaScript's default English `localeCompare`.
//!
//! The server compares with ICU collation data, which is compiled in. That
//! data is about 1.2 MB of code, more than the rest of this crate. The
//! browser copy of the crate (the `wasm` feature on `wasm32`) does not carry
//! it: it calls `localeCompare` of the browser, which is the order that the
//! ICU data copies. `tests/lib/wasm-module.test.ts` checks the size of the
//! module and the order.
//!
//! A Worker is `wasm32` without the `wasm` feature, so it compares with the
//! ICU data, as the native server does.

use std::cmp::Ordering;

#[cfg(not(all(feature = "wasm", target_arch = "wasm32")))]
pub fn compare_names(left: &str, right: &str) -> Ordering {
    use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
    use icu_locale::locale;
    use std::sync::OnceLock;

    static COLLATOR: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
    COLLATOR
        .get_or_init(|| {
            Collator::try_new(locale!("en-US").into(), CollatorOptions::default())
                .expect("compiled English collation data")
        })
        .compare(left, right)
}

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod browser {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        /// A JavaScript string, to call its `localeCompare`.
        #[wasm_bindgen(js_name = String)]
        pub(super) type Text;

        #[wasm_bindgen(method, js_name = localeCompare)]
        pub(super) fn locale_compare(this: &Text, other: &str, locale: &str) -> i32;
    }
}

/// The locale is given, so the order does not depend on the language of the
/// browser: it is the server's order.
#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub fn compare_names(left: &str, right: &str) -> Ordering {
    use wasm_bindgen::{JsCast, JsValue};

    let text: browser::Text = JsValue::from_str(left).unchecked_into();
    text.locale_compare(right, "en-US").cmp(&0)
}
