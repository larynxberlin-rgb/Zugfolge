//! Source-bound, fail-closed Operational-v2-Preflight fuer den Alpha-Builder.

use std::error::Error;
use std::fs;

use serde_json::Value;
use zugfolge_sim_runtime::operational_runtime::initialize_operational_simulation;

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = std::env::args().skip(1);
    let input_path = arguments
        .next()
        .ok_or("Aufruf: operational_initialization_preflight INITIALIZATION.json ABS_INFRA.json")?;
    let infrastructure_path = arguments
        .next()
        .ok_or("Aufruf: operational_initialization_preflight INITIALIZATION.json ABS_INFRA.json")?;
    if arguments.next().is_some() {
        return Err("Operational-v2-Preflight akzeptiert exakt zwei Argumente".into());
    }

    let initialization_json = fs::read_to_string(&input_path)?;
    let initialized: Value = serde_json::from_str(&initialize_operational_simulation(
        &initialization_json,
        &infrastructure_path,
    )?)?;
    let trains = initialized
        .pointer("/state/world/trains")
        .and_then(Value::as_object)
        .ok_or("Nativer Operational-v2-Preflight besitzt keinen dynamischen Zugzustand")?;
    if !trains.is_empty() || initialized.pointer("/state/world/infra").is_some() {
        return Err(
            "Nativer Operational-v2-Preflight erzeugte keinen kompakten leeren Startzustand".into(),
        );
    }
    let receipt = initialized
        .get("validationReceipt")
        .ok_or("Nativer Operational-v2-Preflight lieferte keinen Validierungsbeleg")?;
    if receipt
        .pointer("/dynamicTrainCount")
        .and_then(Value::as_u64)
        != Some(0)
        || receipt.get("initializationHash") != initialized.get("initializationHash")
        || receipt.get("stateHash") != initialized.get("stateHash")
        || receipt.get("infraRelease") != initialized.pointer("/state/infraRelease")
    {
        return Err(
            "Nativer Operational-v2-Validierungsbeleg ist nicht an Initialisierung und Startzustand gebunden"
                .into(),
        );
    }
    println!("{receipt}");
    Ok(())
}
