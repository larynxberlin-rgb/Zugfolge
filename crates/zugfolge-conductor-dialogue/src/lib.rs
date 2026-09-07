//! Deterministischer, offline freigegebener Sprechblasendialog ohne Tarifoffenlegung.
#![allow(missing_docs)]

mod types;
pub use types::*;
mod engine;
mod validation;
pub use engine::*;
pub use validation::{dialogue_release_hash, validate_dialogue_release};
