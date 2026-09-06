//! Prozessgrenze für Integrationstests; der Simulationskern selbst kennt keine Ein-/Ausgabe.
use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin()
        .take(16 * 1024 * 1024 + 1)
        .read_to_string(&mut input)?;
    println!("{}", zugfolge_demand::evaluate_demand_json(&input)?);
    Ok(())
}
