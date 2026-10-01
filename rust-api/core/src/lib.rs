//! Pure accounting and domain logic shared by the server and browser WASM.

#![forbid(unsafe_code)]

pub mod accounting;
pub mod accounts;
pub mod collation;
pub mod expression;
pub mod formatters;
pub mod investments;
pub mod js;
pub mod lots;
pub mod names;
pub mod recurring;

#[cfg(feature = "wasm")]
mod wasm;
