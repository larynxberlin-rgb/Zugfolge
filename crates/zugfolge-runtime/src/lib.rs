//! Produktive In-Process-Grenze zwischen Node und den Rust-Single-Writern.
//!
//! Dieses Crate trifft die betriebliche Entscheidung des M6.7-Stichtags. Die
//! Plattform liefert nur bereits verifizierte Fakten hinein und persistiert
//! Zustand und Ereignisse danach atomar. Es gibt keinen TypeScript-Ersatzpfad.

mod fleet;

pub use fleet::{apply_fleet_command, initialize_fleet_world, verify_fleet_world_state};

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zugfolge_fleet::MobilizationSnapshot;

const INITIALIZE_SCHEMA: &str = "zugfolge-operating-world-initialize/v1";
const STATE_SCHEMA: &str = "zugfolge-operating-world-state/v1";
const TRANSITION_SCHEMA: &str = "zugfolge-operating-transition-command/v1";
const RESULT_SCHEMA: &str = "zugfolge-operating-transition-result/v1";
const FLEET_VERIFICATION_SCHEMA: &str = "zugfolge-fleet-mobilization-verification/v1";

/// Stabiler Fehlercode an der Runtime-Grenze.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeError {
    code: &'static str,
    detail: String,
}

impl RuntimeError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl core::fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl std::error::Error for RuntimeError {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialTrainRun {
    train_run_id: String,
    formation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialLot {
    lot_id: String,
    incumbent_operator_id: String,
    timetable_boundary_s: i64,
    train_runs: Vec<InitialTrainRun>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitializeWorld {
    schema_version: String,
    world_id: String,
    lots: Vec<InitialLot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MobilizationProof {
    source: String,
    verified_by: String,
    fleet_revision: u64,
    snapshot_hash: String,
    formation_ids: Vec<String>,
    personnel_duty_ids: Vec<String>,
    path_reservation_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransitionCommand {
    schema_version: String,
    world_id: String,
    command_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    lot_id: String,
    at_s: i64,
    winner_operator_id: String,
    mobilization_proof: Option<MobilizationProof>,
    public_vehicle_pool: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AssignmentKind {
    Contract,
    PublicOperation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrainAssignment {
    train_run_id: String,
    operator_id: String,
    formation_id: Option<String>,
    assignment_kind: AssignmentKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LotState {
    lot_id: String,
    operator_id: String,
    timetable_boundary_s: i64,
    train_runs: BTreeMap<String, TrainAssignment>,
    livemap_marker: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum TransitionKind {
    SeamlessContinuation,
    OperatorChange,
    PublicOperation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransitionOutcome {
    lot_id: String,
    previous_operator_id: String,
    operator_id: String,
    kind: TransitionKind,
    seamless: bool,
    penalty_required: bool,
    train_run_ids: Vec<String>,
    livemap_marker: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeEvent {
    event_id: String,
    world_id: String,
    event_type: String,
    at_s: i64,
    payload: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessedCommand {
    command_hash: String,
    resulting_revision: u64,
    outcome: TransitionOutcome,
    events: Vec<RuntimeEvent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperatingWorldState {
    schema_version: String,
    world_id: String,
    revision: u64,
    lots: BTreeMap<String, LotState>,
    processed_commands: BTreeMap<String, ProcessedCommand>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransitionResult {
    schema_version: String,
    state: OperatingWorldState,
    state_hash: String,
    outcome: TransitionOutcome,
    events: Vec<RuntimeEvent>,
    idempotent_replay: bool,
}

fn non_empty(value: &str, field: &'static str) -> Result<(), RuntimeError> {
    if value.trim().is_empty() {
        return Err(RuntimeError::new(
            "invalid_input",
            format!("{field} darf nicht leer sein"),
        ));
    }
    Ok(())
}

fn unique_non_empty(values: &[String], field: &'static str) -> Result<(), RuntimeError> {
    if values.is_empty() {
        return Err(RuntimeError::new(
            "incomplete_evidence",
            format!("{field} darf nicht leer sein"),
        ));
    }
    let mut seen = BTreeSet::new();
    for value in values {
        non_empty(value, field)?;
        if !seen.insert(value) {
            return Err(RuntimeError::new(
                "invalid_input",
                format!("{field} enthaelt die Kennung '{value}' doppelt"),
            ));
        }
    }
    Ok(())
}

fn sha256_json<T: Serialize>(value: &T) -> Result<String, RuntimeError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| RuntimeError::new("serialization_failed", error.to_string()))?;
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        write!(&mut hex, "{byte:02x}")
            .map_err(|error| RuntimeError::new("serialization_failed", error.to_string()))?;
    }
    Ok(hex)
}

fn state_hash(state: &OperatingWorldState) -> Result<String, RuntimeError> {
    sha256_json(state)
}

fn initialize(input: InitializeWorld) -> Result<OperatingWorldState, RuntimeError> {
    if input.schema_version != INITIALIZE_SCHEMA {
        return Err(RuntimeError::new(
            "unsupported_schema",
            input.schema_version,
        ));
    }
    non_empty(&input.world_id, "worldId")?;
    if input.lots.is_empty() {
        return Err(RuntimeError::new(
            "invalid_input",
            "mindestens ein Betriebslos ist erforderlich",
        ));
    }
    let mut lots = BTreeMap::new();
    for lot in input.lots {
        non_empty(&lot.lot_id, "lotId")?;
        non_empty(&lot.incumbent_operator_id, "incumbentOperatorId")?;
        if lot.timetable_boundary_s < 0 {
            return Err(RuntimeError::new(
                "invalid_input",
                "timetableBoundaryS darf nicht negativ sein",
            ));
        }
        if lot.train_runs.is_empty() {
            return Err(RuntimeError::new(
                "invalid_input",
                format!("Los '{}' besitzt keine Zugfahrt", lot.lot_id),
            ));
        }
        let mut train_runs = BTreeMap::new();
        for train in lot.train_runs {
            non_empty(&train.train_run_id, "trainRunId")?;
            if let Some(formation_id) = &train.formation_id {
                non_empty(formation_id, "formationId")?;
            }
            let assignment = TrainAssignment {
                train_run_id: train.train_run_id.clone(),
                operator_id: lot.incumbent_operator_id.clone(),
                formation_id: train.formation_id,
                assignment_kind: AssignmentKind::Contract,
            };
            if train_runs
                .insert(train.train_run_id.clone(), assignment)
                .is_some()
            {
                return Err(RuntimeError::new(
                    "invalid_input",
                    format!("Zugfahrt '{}' ist doppelt", train.train_run_id),
                ));
            }
        }
        let lot_id = lot.lot_id.clone();
        if lots
            .insert(
                lot_id.clone(),
                LotState {
                    lot_id,
                    operator_id: lot.incumbent_operator_id,
                    timetable_boundary_s: lot.timetable_boundary_s,
                    train_runs,
                    livemap_marker: None,
                },
            )
            .is_some()
        {
            return Err(RuntimeError::new(
                "invalid_input",
                format!("Los '{}' ist doppelt", lot.lot_id),
            ));
        }
    }
    Ok(OperatingWorldState {
        schema_version: STATE_SCHEMA.to_owned(),
        world_id: input.world_id,
        revision: 0,
        lots,
        processed_commands: BTreeMap::new(),
    })
}

fn proof_is_complete(proof: &MobilizationProof) -> Result<(), RuntimeError> {
    if proof.source != "m5-release" || proof.verified_by != "zugfolge-fleet-mobilization/v1" {
        return Err(RuntimeError::new(
            "incomplete_evidence",
            "Mobilisierungsnachweis stammt nicht aus dem M5-Single-Writer",
        ));
    }
    if proof.snapshot_hash.len() != 64
        || !proof
            .snapshot_hash
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(RuntimeError::new(
            "incomplete_evidence",
            "snapshotHash ist kein kleingeschriebener SHA-256",
        ));
    }
    unique_non_empty(&proof.formation_ids, "formationIds")?;
    unique_non_empty(&proof.personnel_duty_ids, "personnelDutyIds")?;
    unique_non_empty(&proof.path_reservation_ids, "pathReservationIds")?;
    Ok(())
}

fn runtime_event(
    command_id: &str,
    ordinal: usize,
    world_id: &str,
    event_type: &str,
    at_s: i64,
    payload: serde_json::Value,
) -> RuntimeEvent {
    RuntimeEvent {
        event_id: format!("{command_id}:{ordinal}"),
        world_id: world_id.to_owned(),
        event_type: event_type.to_owned(),
        at_s,
        payload,
    }
}

fn apply_transition(
    mut state: OperatingWorldState,
    command: TransitionCommand,
) -> Result<TransitionResult, RuntimeError> {
    if state.schema_version != STATE_SCHEMA || command.schema_version != TRANSITION_SCHEMA {
        return Err(RuntimeError::new(
            "unsupported_schema",
            format!("{} / {}", state.schema_version, command.schema_version),
        ));
    }
    if state.world_id != command.world_id {
        return Err(RuntimeError::new(
            "world_mismatch",
            "Kommando und Zustand gehoeren nicht derselben Welt",
        ));
    }
    non_empty(&command.command_id, "commandId")?;
    non_empty(&command.winner_operator_id, "winnerOperatorId")?;
    let command_hash = sha256_json(&command)?;
    if let Some(processed) = state.processed_commands.get(&command.command_id).cloned() {
        if processed.command_hash != command_hash {
            return Err(RuntimeError::new(
                "idempotency_conflict",
                "commandId wurde bereits mit anderen Nutzdaten verarbeitet",
            ));
        }
        return Ok(TransitionResult {
            schema_version: RESULT_SCHEMA.to_owned(),
            state_hash: state_hash(&state)?,
            state,
            outcome: processed.outcome.clone(),
            events: processed.events.clone(),
            idempotent_replay: true,
        });
    }
    let actual_state_hash = state_hash(&state)?;
    if command.expected_state_hash != actual_state_hash {
        return Err(RuntimeError::new(
            "state_hash_mismatch",
            "persistierter Runtime-Zustand passt nicht zum erwarteten Hash",
        ));
    }
    if state.revision != command.expected_revision {
        return Err(RuntimeError::new(
            "revision_conflict",
            format!(
                "erwartet Revision {}, erhielt {}",
                state.revision, command.expected_revision
            ),
        ));
    }
    let lot = state
        .lots
        .get_mut(&command.lot_id)
        .ok_or_else(|| RuntimeError::new("unknown_lot", command.lot_id.clone()))?;
    if command.at_s != lot.timetable_boundary_s {
        return Err(RuntimeError::new(
            "not_timetable_boundary",
            format!(
                "Betriebsuebergang ist bei {} statt am Stichtag {}",
                command.at_s, lot.timetable_boundary_s
            ),
        ));
    }

    let previous_operator_id = lot.operator_id.clone();
    let (operator_id, kind, seamless, penalty_required, livemap_marker, formations) =
        if command.winner_operator_id == previous_operator_id {
            (
                command.winner_operator_id.clone(),
                TransitionKind::SeamlessContinuation,
                true,
                false,
                None,
                lot.train_runs
                    .values()
                    .map(|assignment| {
                        assignment.formation_id.clone().ok_or_else(|| {
                        RuntimeError::new(
                            "incomplete_evidence",
                            "nahtlose Fortsetzung braucht die bestehende Formation jeder Zugfahrt",
                        )
                    })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )
        } else if let Some(proof) = &command.mobilization_proof {
            proof_is_complete(proof)?;
            (
                command.winner_operator_id.clone(),
                TransitionKind::OperatorChange,
                false,
                false,
                None,
                proof.formation_ids.clone(),
            )
        } else {
            unique_non_empty(&command.public_vehicle_pool, "publicVehiclePool")?;
            (
                "public".to_owned(),
                TransitionKind::PublicOperation,
                false,
                true,
                Some("public-operator".to_owned()),
                command.public_vehicle_pool.clone(),
            )
        };

    for (index, assignment) in lot.train_runs.values_mut().enumerate() {
        assignment.operator_id.clone_from(&operator_id);
        assignment.formation_id = Some(formations[index % formations.len()].clone());
        assignment.assignment_kind = if operator_id == "public" {
            AssignmentKind::PublicOperation
        } else {
            AssignmentKind::Contract
        };
    }
    lot.operator_id.clone_from(&operator_id);
    lot.livemap_marker.clone_from(&livemap_marker);
    let train_run_ids = lot.train_runs.keys().cloned().collect::<Vec<_>>();
    let outcome = TransitionOutcome {
        lot_id: command.lot_id.clone(),
        previous_operator_id: previous_operator_id.clone(),
        operator_id: operator_id.clone(),
        kind,
        seamless,
        penalty_required,
        train_run_ids: train_run_ids.clone(),
        livemap_marker: livemap_marker.clone(),
    };

    let mut events = vec![runtime_event(
        &command.command_id,
        0,
        &command.world_id,
        "operating-duty-ended",
        command.at_s,
        serde_json::json!({
            "worldId": command.world_id,
            "lotId": command.lot_id,
            "operatorId": previous_operator_id,
            "fulfilledUntilS": command.at_s,
        }),
    )];
    events.push(runtime_event(
        &command.command_id,
        1,
        &command.world_id,
        "operating-transition-completed",
        command.at_s,
        serde_json::to_value(&outcome)
            .map_err(|error| RuntimeError::new("serialization_failed", error.to_string()))?,
    ));
    for (index, assignment) in lot.train_runs.values().enumerate() {
        events.push(runtime_event(
            &command.command_id,
            index.saturating_add(2),
            &command.world_id,
            "train-operation-assigned",
            command.at_s,
            serde_json::json!({
                "worldId": command.world_id,
                "lotId": command.lot_id,
                "trainRunId": assignment.train_run_id,
                "operatorId": assignment.operator_id,
                "formationId": assignment.formation_id,
                "assignmentKind": assignment.assignment_kind,
            }),
        ));
    }
    events.push(runtime_event(
        &command.command_id,
        events.len(),
        &command.world_id,
        if livemap_marker.is_some() {
            "livemap-operation-marked"
        } else {
            "livemap-operation-cleared"
        },
        command.at_s,
        serde_json::json!({
            "worldId": command.world_id,
            "lotId": command.lot_id,
            "trainRunIds": train_run_ids,
            "marker": livemap_marker,
        }),
    ));

    state.revision = state
        .revision
        .checked_add(1)
        .ok_or_else(|| RuntimeError::new("revision_overflow", "Runtime-Revision ist erschoepft"))?;
    state.processed_commands.insert(
        command.command_id,
        ProcessedCommand {
            command_hash,
            resulting_revision: state.revision,
            outcome: outcome.clone(),
            events: events.clone(),
        },
    );
    let state_hash = state_hash(&state)?;
    Ok(TransitionResult {
        schema_version: RESULT_SCHEMA.to_owned(),
        state,
        state_hash,
        outcome,
        events,
        idempotent_replay: false,
    })
}

fn parse_json<T: for<'de> Deserialize<'de>>(json: &str) -> Result<T, RuntimeError> {
    serde_json::from_str(json).map_err(|error| RuntimeError::new("invalid_json", error.to_string()))
}

fn to_json<T: Serialize>(value: &T) -> Result<String, RuntimeError> {
    serde_json::to_string(value)
        .map_err(|error| RuntimeError::new("serialization_failed", error.to_string()))
}

/// Initialisiert den unverwechselbaren Betriebszustand einer Welt.
pub fn initialize_operating_world(input_json: &str) -> Result<String, RuntimeError> {
    let state = initialize(parse_json(input_json)?)?;
    let hash = state_hash(&state)?;
    to_json(&serde_json::json!({
        "schemaVersion": "zugfolge-operating-world-initialized/v1",
        "state": state,
        "stateHash": hash,
    }))
}

/// Verifiziert den kanonischen M5-Snapshot mit derselben Rust-Implementierung,
/// die ihn erzeugt, bevor TypeScript ihn persistieren oder referenzieren darf.
pub fn verify_fleet_mobilization_snapshot(input_json: &str) -> Result<String, RuntimeError> {
    let snapshot: MobilizationSnapshot = parse_json(input_json)?;
    let snapshot_hash = snapshot
        .sha256()
        .map_err(|error| RuntimeError::new("invalid_fleet_snapshot", format!("{error:?}")))?;
    to_json(&serde_json::json!({
        "schemaVersion": FLEET_VERIFICATION_SCHEMA,
        "worldId": snapshot.world_id,
        "fleetRevision": snapshot.revision,
        "snapshotHash": snapshot_hash,
    }))
}

/// Verarbeitet genau ein revisioniertes Stichtagskommando im Rust-Single-Writer.
pub fn apply_operating_transition(
    state_json: &str,
    command_json: &str,
) -> Result<String, RuntimeError> {
    let result = apply_transition(parse_json(state_json)?, parse_json(command_json)?)?;
    to_json(&result)
}

#[cfg(test)]
mod tests {
    use super::{
        FLEET_VERIFICATION_SCHEMA, apply_operating_transition, initialize_operating_world,
        verify_fleet_mobilization_snapshot,
    };
    use serde_json::{Value, json};

    const WORLD: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn m5_snapshot_wird_von_rust_kanonisch_verifiziert() {
        let snapshot =
            include_str!("../../zugfolge-fleet/tests/fixtures/mobilization-snapshot-v1.json");
        let expected_hash =
            include_str!("../../zugfolge-fleet/tests/fixtures/mobilization-snapshot-v1.sha256")
                .trim();
        let verified: Value = serde_json::from_str(
            &verify_fleet_mobilization_snapshot(snapshot).expect("M5-Snapshot ist gueltig"),
        )
        .expect("gueltige Verifikation");
        assert_eq!(verified["schemaVersion"], FLEET_VERIFICATION_SCHEMA);
        assert_eq!(verified["snapshotHash"], expected_hash);

        let mut manipulated: Value = serde_json::from_str(snapshot).expect("Fixture ist JSON");
        manipulated["schema"] = json!("zugfolge-fleet-mobilization/v0");
        let error = verify_fleet_mobilization_snapshot(&manipulated.to_string())
            .expect_err("unbekanntes Schema wird abgewiesen");
        assert!(error.to_string().starts_with("invalid_fleet_snapshot:"));
    }

    fn initialized() -> Value {
        let initialized = initialize_operating_world(
            &json!({
                "schemaVersion": "zugfolge-operating-world-initialize/v1",
                "worldId": WORLD,
                "lots": [{
                    "lotId": "lot-s5x",
                    "incumbentOperatorId": "old",
                    "timetableBoundaryS": 604800,
                    "trainRuns": [
                        {"trainRunId": "s5x-1", "formationId": "old-1"},
                        {"trainRunId": "s5x-2", "formationId": "old-2"}
                    ]
                }]
            })
            .to_string(),
        )
        .expect("Initialisierung gelingt");
        serde_json::from_str(&initialized).expect("gueltiges Ergebnis")
    }

    fn command(
        state_hash: &Value,
        id: &str,
        winner: &str,
        proof: Option<Value>,
        public_pool: Value,
    ) -> Value {
        json!({
            "schemaVersion": "zugfolge-operating-transition-command/v1",
            "worldId": WORLD,
            "commandId": id,
            "expectedStateHash": state_hash,
            "expectedRevision": 0,
            "lotId": "lot-s5x",
            "atS": 604800,
            "winnerOperatorId": winner,
            "mobilizationProof": proof,
            "publicVehiclePool": public_pool,
        })
    }

    fn complete_proof() -> Value {
        json!({
            "source": "m5-release",
            "verifiedBy": "zugfolge-fleet-mobilization/v1",
            "fleetRevision": 7,
            "snapshotHash": "a".repeat(64),
            "formationIds": ["new-1", "new-2"],
            "personnelDutyIds": ["duty-1"],
            "pathReservationIds": ["path-1"]
        })
    }

    fn apply(state: &Value, command: &Value) -> Value {
        serde_json::from_str(
            &apply_operating_transition(&state.to_string(), &command.to_string())
                .expect("Uebergang gelingt"),
        )
        .expect("gueltiges Ergebnis")
    }

    #[test]
    fn wiedergewinn_setzt_den_betrieb_nahtlos_fort() {
        let initial = initialized();
        let result = apply(
            &initial["state"],
            &command(&initial["stateHash"], "same", "old", None, json!([])),
        );
        assert_eq!(result["outcome"]["kind"], "seamless-continuation");
        assert_eq!(result["outcome"]["seamless"], true);
        assert_eq!(result["outcome"]["operatorId"], "old");
    }

    #[test]
    fn vollstaendige_mobilisierung_wechselt_alle_zugfahrten() {
        let initial = initialized();
        let result = apply(
            &initial["state"],
            &command(
                &initial["stateHash"],
                "change",
                "new",
                Some(complete_proof()),
                json!([]),
            ),
        );
        assert_eq!(result["outcome"]["kind"], "operator-change");
        assert_eq!(result["outcome"]["operatorId"], "new");
        assert_eq!(
            result["outcome"]["trainRunIds"].as_array().map(Vec::len),
            Some(2)
        );
        assert_eq!(
            result["events"]
                .as_array()
                .expect("Ereignisse")
                .iter()
                .filter(|event| event["eventType"] == "train-operation-assigned")
                .count(),
            2
        );
    }

    #[test]
    fn mobilisierungsfehler_materialisiert_eigenbetrieb_ohne_zugausfall() {
        let initial = initialized();
        let result = apply(
            &initial["state"],
            &command(
                &initial["stateHash"],
                "failed",
                "new",
                None,
                json!(["public-1"]),
            ),
        );
        assert_eq!(result["outcome"]["kind"], "public-operation");
        assert_eq!(result["outcome"]["penaltyRequired"], true);
        assert_eq!(result["outcome"]["livemapMarker"], "public-operator");
        assert_eq!(
            result["outcome"]["trainRunIds"].as_array().map(Vec::len),
            Some(2)
        );
        let trains = result["state"]["lots"]["lot-s5x"]["trainRuns"]
            .as_object()
            .expect("Zugfahrten");
        assert!(trains.values().all(|train| train["operatorId"] == "public"));
        assert!(
            trains
                .values()
                .all(|train| train["formationId"] == "public-1")
        );
    }

    #[test]
    fn leere_eigenbetriebsflotte_verhindert_einen_scheinbaren_erfolg() {
        let initial = initialized();
        let error = apply_operating_transition(
            &initial["state"].to_string(),
            &command(&initial["stateHash"], "failed", "new", None, json!([])).to_string(),
        )
        .expect_err("ohne Fahrzeug keine lueckenlose Uebernahme");
        assert!(error.to_string().starts_with("incomplete_evidence:"));
    }

    #[test]
    fn uebergang_ausserhalb_des_stichtags_bleibt_gesperrt() {
        let initial = initialized();
        let mut invalid = command(
            &initial["stateHash"],
            "early",
            "new",
            Some(complete_proof()),
            json!([]),
        );
        invalid["atS"] = json!(604799);
        let error = apply_operating_transition(&initial["state"].to_string(), &invalid.to_string())
            .expect_err("falscher Zeitpunkt");
        assert!(error.to_string().starts_with("not_timetable_boundary:"));
    }

    #[test]
    fn manipuliertes_zustandsabbild_wird_vor_dem_uebergang_abgewiesen() {
        let initial = initialized();
        let mut manipulated_state = initial["state"].clone();
        manipulated_state["lots"]["lot-s5x"]["operatorId"] = json!("manipulated");
        let transition = command(
            &initial["stateHash"],
            "tampered",
            "new",
            Some(complete_proof()),
            json!([]),
        );
        let error =
            apply_operating_transition(&manipulated_state.to_string(), &transition.to_string())
                .expect_err("Hash und Zustand duerfen nicht auseinanderlaufen");
        assert!(error.to_string().starts_with("state_hash_mismatch:"));
    }

    #[test]
    fn idempotenz_und_replay_liefern_identische_hashes() {
        let initial_a = initialized();
        let initial_b = initialized();
        assert_eq!(initial_a["stateHash"], initial_b["stateHash"]);
        let transition = command(
            &initial_a["stateHash"],
            "change",
            "new",
            Some(complete_proof()),
            json!([]),
        );
        let result_a = apply(&initial_a["state"], &transition);
        let result_b = apply(&initial_b["state"], &transition);
        assert_eq!(result_a["stateHash"], result_b["stateHash"]);
        assert_eq!(result_a["events"], result_b["events"]);

        let retry = apply(&result_a["state"], &transition);
        assert_eq!(retry["idempotentReplay"], true);
        assert_eq!(retry["stateHash"], result_a["stateHash"]);
    }

    #[test]
    fn wiederverwendete_kommando_id_mit_anderen_daten_wird_abgewiesen() {
        let initial = initialized();
        let transition = command(
            &initial["stateHash"],
            "change",
            "new",
            Some(complete_proof()),
            json!([]),
        );
        let result = apply(&initial["state"], &transition);
        let altered = command(
            &result["stateHash"],
            "change",
            "other",
            Some(complete_proof()),
            json!([]),
        );
        let error = apply_operating_transition(&result["state"].to_string(), &altered.to_string())
            .expect_err("Idempotenzkonflikt");
        assert!(error.to_string().starts_with("idempotency_conflict:"));
    }

    #[test]
    fn eigenschaft_jede_materialisierte_zugfahrt_erhaelt_genau_eine_zuweisung() {
        for train_count in 1..=32_u64 {
            let trains = (0..train_count)
                .rev()
                .map(|index| {
                    json!({
                        "trainRunId": format!("generated-{index}"),
                        "formationId": format!("old-{index}"),
                    })
                })
                .collect::<Vec<_>>();
            let initialized: Value = serde_json::from_str(
                &initialize_operating_world(
                    &json!({
                        "schemaVersion": "zugfolge-operating-world-initialize/v1",
                        "worldId": WORLD,
                        "lots": [{
                            "lotId": "lot-s5x",
                            "incumbentOperatorId": "old",
                            "timetableBoundaryS": 604800,
                            "trainRuns": trains,
                        }],
                    })
                    .to_string(),
                )
                .expect("generierte Initialisierung gelingt"),
            )
            .expect("gueltiges Initialisierungsergebnis");
            let result = apply(
                &initialized["state"],
                &command(
                    &initialized["stateHash"],
                    &format!("property-{train_count}"),
                    "new",
                    None,
                    json!(["public-1", "public-2"]),
                ),
            );
            let assignments = result["state"]["lots"]["lot-s5x"]["trainRuns"]
                .as_object()
                .expect("Zuweisungen");
            assert_eq!(assignments.len(), usize::try_from(train_count).unwrap());
            assert!(assignments.values().all(|assignment| {
                assignment["operatorId"] == "public"
                    && assignment["assignmentKind"] == "public-operation"
                    && assignment["formationId"].as_str().is_some()
            }));
        }
    }
}
