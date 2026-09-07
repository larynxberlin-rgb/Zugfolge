//! Begrenzter Zweiregionenadapter; Persistenz und Autorisierung liegen beim Weltwriter.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    schema_version: String,
    source: RestoreEnvelope,
    target: RestoreEnvelope,
    handover_id: String,
    train_run_id: String,
    protected_resources: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultStates {
    schema_version: &'static str,
    source_prepared: RuntimeState,
    target_accepted: RuntimeState,
    source_finished: RuntimeState,
    source_events: Vec<OperationalEvent>,
    target_events: Vec<OperationalEvent>,
}

fn invalid() -> OperationalRuntimeError {
    OperationalRuntimeError::new(
        "operational_handover_invalid",
        "Die gebundene Regionsuebergabe konnte nicht bestaetigt werden",
    )
}

fn restored(
    envelope: RestoreEnvelope,
    path: &str,
) -> Result<RuntimeState, OperationalRuntimeError> {
    if envelope.schema_version != RESTORE_SCHEMA
        || !is_sha256(&envelope.expected_initialization_hash)
        || envelope.expected_initialization_hash != envelope.state.initialization_hash
    {
        return Err(invalid());
    }
    let mut state = envelope.state;
    validate_state(&state)?;
    ensure_encoded_within_budget(
        &state,
        MAX_OPERATIONAL_STATE_JSON_BYTES,
        "operational_handover_state_budget_exceeded",
        "OperationalState",
    )?;
    let infrastructure = infrastructure_for_binding(&state.infra_release, path)?;
    state
        .world
        .attach_infrastructure(infrastructure)
        .map_err(|_| invalid())?;
    Ok(state)
}

fn seal(
    state: &mut RuntimeState,
    id: &str,
    phase: &str,
    payload_hash: &str,
) -> Result<Vec<OperationalEvent>, OperationalRuntimeError> {
    state
        .world
        .commit_runtime_command()
        .map_err(|_| invalid())?;
    state.revision = state.revision.checked_add(1).ok_or_else(invalid)?;
    state.publisher_sequence = state
        .publisher_sequence
        .checked_add(1)
        .ok_or_else(invalid)?;
    let receipt_id = format!("region-handover:{id}:{phase}");
    if state.command_receipts.contains_key(&receipt_id) {
        return Err(invalid());
    }
    insert_bounded_command_receipt(
        &mut state.command_receipts,
        receipt_id,
        payload_hash.to_owned(),
        state.revision,
    );
    state.state_hash = state_hash(
        &state.initialization_hash,
        &state.infra_release,
        &state.world,
        state.revision,
        state.publisher_sequence,
        &state.command_receipts,
        &state.passenger_stop_templates,
    );
    let events = std::mem::take(&mut state.world.events);
    validate_state(state)?;
    ensure_encoded_within_budget(
        state,
        MAX_OPERATIONAL_STATE_JSON_BYTES,
        "operational_handover_state_budget_exceeded",
        "OperationalState",
    )?;
    Ok(events)
}

/// Führt die vorhandenen drei Übergabeschritte auf unabhängig geprüften Köpfen aus.
/// Der Weltwriter speichert ausschließlich das endgültige Paar atomar gegen beide Vorgänger.
pub fn handover_operational_simulation(
    input_json: &str,
    infrastructure_path: &str,
) -> Result<String, OperationalRuntimeError> {
    fn run(input_json: &str, path: &str) -> Result<String, OperationalRuntimeError> {
        reject_json_over_budget(
            input_json,
            2 * MAX_RESTORE_JSON_BYTES + MAX_COMMAND_JSON_BYTES,
            "operational_handover_budget_exceeded",
            "OperationalHandover",
        )?;
        let raw: Value = decode(input_json, "OperationalHandover")?;
        reject_embedded_static_infrastructure(raw.pointer("/source/state/world"))?;
        reject_embedded_static_infrastructure(raw.pointer("/target/state/world"))?;
        let input: Input = decode(input_json, "OperationalHandover")?;
        if input.schema_version != "zugfolge-operational-handover-input/v1"
            || input.handover_id.is_empty()
            || input.handover_id.len() > 200
            || input.train_run_id.is_empty()
            || input.train_run_id.len() > 512
            || input.protected_resources.is_empty()
            || input.protected_resources.len() > 4096
        {
            return Err(invalid());
        }
        let mut source = restored(input.source, path)?;
        let mut target = restored(input.target, path)?;
        if source.infra_release != target.infra_release
            || source.world.world_id != target.world.world_id
            || source.world.region_id == target.world.region_id
            || source.world.now_ms != target.world.now_ms
        {
            return Err(invalid());
        }
        let mut handover = source
            .world
            .begin_handover(
                &input.handover_id,
                &input.train_run_id,
                &target.world.region_id,
                input.protected_resources,
            )
            .map_err(|_| invalid())?;
        let mut source_events = seal(
            &mut source,
            &input.handover_id,
            "prepare",
            &handover.payload_hash,
        )?;
        let source_prepared = source.clone();
        // Nur die echte signierte Vorlage dieser Fahrt wird mit ihrem Betriebszustand übernommen.
        if let Some(stops) = &handover.train.passenger_stops {
            let key = &stops.plan.service_id;
            let binding = source
                .passenger_stop_templates
                .get(key)
                .ok_or_else(invalid)?;
            if target
                .passenger_stop_templates
                .get(key)
                .is_some_and(|other| other != binding)
            {
                return Err(invalid());
            }
            target
                .passenger_stop_templates
                .insert(key.clone(), binding.clone());
        }
        target
            .world
            .accept_handover(&mut handover)
            .map_err(|_| invalid())?;
        let target_events = seal(
            &mut target,
            &input.handover_id,
            "accept",
            &handover.payload_hash,
        )?;
        source
            .world
            .finish_handover(&handover)
            .map_err(|_| invalid())?;
        source_events.extend(seal(
            &mut source,
            &input.handover_id,
            "finish",
            &handover.payload_hash,
        )?);
        encode_with_budget(
            &ResultStates {
                schema_version: "zugfolge-operational-handover-result/v1",
                source_prepared,
                target_accepted: target,
                source_finished: source,
                source_events,
                target_events,
            },
            3 * MAX_BATCH_RESULT_JSON_BYTES,
            "operational_handover_result_budget_exceeded",
        )
    }
    // Keine JSON-Ausschnitte, Pfade oder Quellbelege verlassen die Transportgrenze.
    run(input_json, infrastructure_path).map_err(|_| invalid())
}
