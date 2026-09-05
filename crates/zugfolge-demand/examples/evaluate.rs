//! Reproduzierbare, ausdrücklich synthetische Pilotregion-Auswertung.
fn main() -> Result<(), zugfolge_demand::DemandError> {
    println!(
        "{}",
        zugfolge_demand::evaluate_demand_json(include_str!("evaluation.json"))?
    );
    Ok(())
}
