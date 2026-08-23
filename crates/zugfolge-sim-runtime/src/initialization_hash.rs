//! Kanonischer, sprachuebergreifender Hash des signierten v2-Startvertrags.

use std::fmt::Write as _;

use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const INITIALIZATION_HASH_SCHEMA: &str = "zugfolge-operational-simulation-initialization/v2";
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn canonical_json(value: &Value, output: &mut String) -> Result<(), String> {
    match value {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::Number(value) => {
            let integer = value
                .as_i64()
                .ok_or_else(|| "Initialisierung enthaelt keine sichere Ganzzahl".to_owned())?;
            if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&integer) {
                return Err("Initialisierung enthaelt keine sichere Ganzzahl".to_owned());
            }
            write!(output, "{integer}").expect("String-Schreiben kann nicht fehlschlagen");
        }
        Value::String(value) => output.push_str(
            &serde_json::to_string(value)
                .map_err(|error| format!("String konnte nicht kanonisiert werden: {error}"))?,
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_json(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            output.push('{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).map_err(|error| {
                    format!("Schluessel konnte nicht kanonisiert werden: {error}")
                })?);
                output.push(':');
                canonical_json(value, output)?;
            }
            output.push('}');
        }
    }
    Ok(())
}

pub fn operational_initialization_hash<T: Serialize>(value: &T) -> Result<String, String> {
    let value = serde_json::to_value(value)
        .map_err(|error| format!("Initialisierung konnte nicht serialisiert werden: {error}"))?;
    let envelope = json!({ "schema": INITIALIZATION_HASH_SCHEMA, "value": value });
    let mut canonical = String::new();
    canonical_json(&envelope, &mut canonical)?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn matches_the_typescript_alpha_canonical_hash_contract() {
        let left = json!({ "z": 1, "a": [true, null, "x"] });
        let right = json!({ "a": [true, null, "x"], "z": 1 });
        let expected = "01e75c93e27076c800ed46c0f1c3199bf322ead14e2a4439e4e14a2898b6ebf6";
        assert_eq!(operational_initialization_hash(&left).unwrap(), expected);
        assert_eq!(operational_initialization_hash(&right).unwrap(), expected);
    }

    #[test]
    fn rejects_numbers_that_typescript_cannot_represent_exactly() {
        assert!(operational_initialization_hash(&json!(9_007_199_254_740_992_i64)).is_err());
        assert!(operational_initialization_hash(&json!(1.5)).is_err());
    }
}
