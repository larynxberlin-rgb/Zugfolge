//! JSON-Adapter mit stdin/stdout für native Integrationstests und reproduzierbare Belege.
use std::io::{Read, Write};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin()
        .take(128 * 1024 * 1024 + 1)
        .read_to_string(&mut input)?;
    let output = zugfolge_conductor::project_conductor_passengers_json(&input)?;
    std::io::stdout().write_all(output.as_bytes())?;
    Ok(())
}
