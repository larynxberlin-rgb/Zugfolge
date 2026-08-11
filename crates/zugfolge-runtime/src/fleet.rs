//! Revisionierter Rust-Single-Writer fuer den M5-Mobilisierungsstand.
//!
//! TypeScript liefert ausschliesslich versionierte Fachkommandos. Der
//! persistierbare Zustand, sein Hash und der M5->M6-Snapshot entstehen hier.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use zugfolge_fleet::{
    FLEET_MOBILIZATION_SCHEMA, MobilizationFormation, MobilizationPathReservation,
    MobilizationPersonnelDuty, MobilizationSnapshot,
};

use super::{RuntimeError, parse_json, sha256_json, to_json};

const FLEET_INITIALIZE_SCHEMA: &str = "zugfolge-fleet-world-initialize/v1";
const FLEET_INITIALIZED_SCHEMA: &str = "zugfolge-fleet-world-initialized/v1";
const FLEET_STATE_SCHEMA: &str = "zugfolge-fleet-world-state/v1";
const FORMATION_COMMAND_SCHEMA: &str = "zugfolge-fleet-formation-command/v1";
const PERSONNEL_DUTY_COMMAND_SCHEMA: &str = "zugfolge-fleet-personnel-duty-command/v1";
const PATH_RESERVATION_COMMAND_SCHEMA: &str = "zugfolge-fleet-path-reservation-command/v1";
const FLEET_RESULT_SCHEMA: &str = "zugfolge-fleet-command-result/v1";
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitializeFleetWorld {
    schema_version: String,
    world_id: String,
    produced_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FormationCommand {
    schema_version: String,
    world_id: String,
    command_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    at_s: u64,
    formation: MobilizationFormation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersonnelDutyCommand {
    schema_version: String,
    world_id: String,
    command_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    at_s: u64,
    personnel_duty: MobilizationPersonnelDuty,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathReservationCommand {
    schema_version: String,
    world_id: String,
    command_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    at_s: u64,
    path_reservation: MobilizationPathReservation,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandHeader {
    schema_version: String,
}

#[derive(Clone, Debug, Serialize)]
enum FleetCommand {
    Formation(FormationCommand),
    PersonnelDuty(PersonnelDutyCommand),
    PathReservation(PathReservationCommand),
}

impl FleetCommand {
    fn world_id(&self) -> &str {
        match self {
            Self::Formation(command) => &command.world_id,
            Self::PersonnelDuty(command) => &command.world_id,
            Self::PathReservation(command) => &command.world_id,
        }
    }

    fn command_id(&self) -> &str {
        match self {
            Self::Formation(command) => &command.command_id,
            Self::PersonnelDuty(command) => &command.command_id,
            Self::PathReservation(command) => &command.command_id,
        }
    }

    const fn expected_revision(&self) -> u64 {
        match self {
            Self::Formation(command) => command.expected_revision,
            Self::PersonnelDuty(command) => command.expected_revision,
            Self::PathReservation(command) => command.expected_revision,
        }
    }

    fn expected_state_hash(&self) -> &str {
        match self {
            Self::Formation(command) => &command.expected_state_hash,
            Self::PersonnelDuty(command) => &command.expected_state_hash,
            Self::PathReservation(command) => &command.expected_state_hash,
        }
    }

    const fn at_s(&self) -> u64 {
        match self {
            Self::Formation(command) => command.at_s,
            Self::PersonnelDuty(command) => command.at_s,
            Self::PathReservation(command) => command.at_s,
        }
    }

    fn entity_kind(&self) -> &'static str {
        match self {
            Self::Formation(_) => "formation",
            Self::PersonnelDuty(_) => "personnel-duty",
            Self::PathReservation(_) => "path-reservation",
        }
    }

    fn entity_id(&self) -> &str {
        match self {
            Self::Formation(command) => &command.formation.id,
            Self::PersonnelDuty(command) => &command.personnel_duty.id,
            Self::PathReservation(command) => &command.path_reservation.id,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessedFleetCommand {
    command_hash: String,
    resulting_revision: u64,
    entity_kind: String,
    entity_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetWorldState {
    schema_version: String,
    world_id: String,
    revision: u64,
    produced_at: u64,
    formations: BTreeMap<String, MobilizationFormation>,
    personnel_duties: BTreeMap<String, MobilizationPersonnelDuty>,
    path_reservations: BTreeMap<String, MobilizationPathReservation>,
    processed_commands: BTreeMap<String, ProcessedFleetCommand>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FleetWorldInitialized {
    schema_version: &'static str,
    state: FleetWorldState,
    state_hash: String,
    snapshot: MobilizationSnapshot,
    snapshot_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FleetCommandResult {
    schema_version: &'static str,
    state: FleetWorldState,
    state_hash: String,
    snapshot: MobilizationSnapshot,
    snapshot_hash: String,
    applied_command_id: String,
    entity_kind: String,
    entity_id: String,
    idempotent_replay: bool,
}

fn non_empty(value: &str, field: &'static str) -> Result<(), RuntimeError> {
    if value.trim().is_empty() {
        return Err(RuntimeError::new(
            "invalid_fleet_command",
            format!("{field} darf nicht leer sein"),
        ));
    }
    Ok(())
}

fn safe_integer(value: u64, field: &'static str) -> Result<(), RuntimeError> {
    if value > MAX_SAFE_JSON_INTEGER {
        return Err(RuntimeError::new(
            "invalid_fleet_command",
            format!("{field} liegt ausserhalb sicherer JSON-Ganzzahlen"),
        ));
    }
    Ok(())
}

fn parse_command(json: &str) -> Result<FleetCommand, RuntimeError> {
    let header: CommandHeader = parse_json(json)?;
    match header.schema_version.as_str() {
        FORMATION_COMMAND_SCHEMA => parse_json(json).map(FleetCommand::Formation),
        PERSONNEL_DUTY_COMMAND_SCHEMA => parse_json(json).map(FleetCommand::PersonnelDuty),
        PATH_RESERVATION_COMMAND_SCHEMA => parse_json(json).map(FleetCommand::PathReservation),
        schema => Err(RuntimeError::new("unsupported_schema", schema)),
    }
}

fn normalize_strings(values: &mut [String]) {
    values.sort();
}

fn normalize_formation(mut formation: MobilizationFormation) -> MobilizationFormation {
    normalize_strings(&mut formation.vehicle_ids);
    normalize_strings(&mut formation.service_line_ids);
    normalize_strings(&mut formation.characteristics.equipment);
    normalize_strings(&mut formation.characteristics.homologated_line_ids);
    formation
}

fn normalize_personnel_duty(mut duty: MobilizationPersonnelDuty) -> MobilizationPersonnelDuty {
    normalize_strings(&mut duty.formation_ids);
    duty
}

fn normalize_path_reservation(
    mut reservation: MobilizationPathReservation,
) -> MobilizationPathReservation {
    normalize_strings(&mut reservation.service_line_ids);
    reservation
}

fn state_hash(state: &FleetWorldState) -> Result<String, RuntimeError> {
    sha256_json(state)
}

fn snapshot(state: &FleetWorldState) -> Result<MobilizationSnapshot, RuntimeError> {
    if state.schema_version != FLEET_STATE_SCHEMA {
        return Err(RuntimeError::new(
            "unsupported_schema",
            state.schema_version.clone(),
        ));
    }
    non_empty(&state.world_id, "worldId")?;
    safe_integer(state.revision, "revision")?;
    safe_integer(state.produced_at, "producedAt")?;
    for (id, formation) in &state.formations {
        if id != &formation.id {
            return Err(RuntimeError::new(
                "invalid_fleet_state",
                "Formation stimmt nicht mit ihrem Zustandsschluessel ueberein",
            ));
        }
    }
    for (id, duty) in &state.personnel_duties {
        if id != &duty.id {
            return Err(RuntimeError::new(
                "invalid_fleet_state",
                "Personaldienst stimmt nicht mit seinem Zustandsschluessel ueberein",
            ));
        }
        for formation_id in &duty.formation_ids {
            let formation = state.formations.get(formation_id).ok_or_else(|| {
                RuntimeError::new(
                    "invalid_fleet_state",
                    format!("Personaldienst verweist auf unbekannte Formation '{formation_id}'"),
                )
            })?;
            if formation.operator_id != duty.operator_id {
                return Err(RuntimeError::new(
                    "invalid_fleet_state",
                    "Personaldienst und Formation gehoeren nicht demselben EVU",
                ));
            }
        }
    }
    for (id, reservation) in &state.path_reservations {
        if id != &reservation.id {
            return Err(RuntimeError::new(
                "invalid_fleet_state",
                "Trassenreservierung stimmt nicht mit ihrem Zustandsschluessel ueberein",
            ));
        }
    }
    for (command_id, processed) in &state.processed_commands {
        non_empty(command_id, "processedCommands")?;
        if processed.resulting_revision > state.revision {
            return Err(RuntimeError::new(
                "invalid_fleet_state",
                "Kommandoquittung verweist auf eine zukuenftige Revision",
            ));
        }
    }
    let snapshot = MobilizationSnapshot {
        schema: FLEET_MOBILIZATION_SCHEMA.to_owned(),
        world_id: state.world_id.clone(),
        revision: state.revision,
        produced_at: state.produced_at,
        formations: state.formations.values().cloned().collect(),
        personnel_duties: state.personnel_duties.values().cloned().collect(),
        path_reservations: state.path_reservations.values().cloned().collect(),
    };
    snapshot
        .validate()
        .map_err(|error| RuntimeError::new("invalid_fleet_state", format!("{error:?}")))?;
    Ok(snapshot)
}

fn snapshot_hash(snapshot: &MobilizationSnapshot) -> Result<String, RuntimeError> {
    snapshot
        .sha256()
        .map_err(|error| RuntimeError::new("invalid_fleet_state", format!("{error:?}")))
}

fn initialized(input: InitializeFleetWorld) -> Result<FleetWorldInitialized, RuntimeError> {
    if input.schema_version != FLEET_INITIALIZE_SCHEMA {
        return Err(RuntimeError::new(
            "unsupported_schema",
            input.schema_version,
        ));
    }
    non_empty(&input.world_id, "worldId")?;
    safe_integer(input.produced_at, "producedAt")?;
    let state = FleetWorldState {
        schema_version: FLEET_STATE_SCHEMA.to_owned(),
        world_id: input.world_id,
        revision: 0,
        produced_at: input.produced_at,
        formations: BTreeMap::new(),
        personnel_duties: BTreeMap::new(),
        path_reservations: BTreeMap::new(),
        processed_commands: BTreeMap::new(),
    };
    let snapshot = snapshot(&state)?;
    Ok(FleetWorldInitialized {
        schema_version: FLEET_INITIALIZED_SCHEMA,
        state_hash: state_hash(&state)?,
        snapshot_hash: snapshot_hash(&snapshot)?,
        state,
        snapshot,
    })
}

fn command_result(
    state: FleetWorldState,
    command: &FleetCommand,
    idempotent_replay: bool,
) -> Result<FleetCommandResult, RuntimeError> {
    let snapshot = snapshot(&state)?;
    Ok(FleetCommandResult {
        schema_version: FLEET_RESULT_SCHEMA,
        state_hash: state_hash(&state)?,
        snapshot_hash: snapshot_hash(&snapshot)?,
        state,
        snapshot,
        applied_command_id: command.command_id().to_owned(),
        entity_kind: command.entity_kind().to_owned(),
        entity_id: command.entity_id().to_owned(),
        idempotent_replay,
    })
}

fn apply(
    mut state: FleetWorldState,
    command: FleetCommand,
) -> Result<FleetCommandResult, RuntimeError> {
    if state.schema_version != FLEET_STATE_SCHEMA {
        return Err(RuntimeError::new(
            "unsupported_schema",
            state.schema_version.clone(),
        ));
    }
    if state.world_id != command.world_id() {
        return Err(RuntimeError::new(
            "world_mismatch",
            "Flottenkommando und Zustand gehoeren nicht derselben Welt",
        ));
    }
    non_empty(command.command_id(), "commandId")?;
    non_empty(command.entity_id(), "entityId")?;
    safe_integer(command.expected_revision(), "expectedRevision")?;
    safe_integer(command.at_s(), "atS")?;
    let command_hash = sha256_json(&command)?;
    if let Some(processed) = state.processed_commands.get(command.command_id()) {
        if processed.command_hash != command_hash {
            return Err(RuntimeError::new(
                "idempotency_conflict",
                "commandId wurde bereits mit anderen Flottendaten verarbeitet",
            ));
        }
        return command_result(state, &command, true);
    }
    let actual_state_hash = state_hash(&state)?;
    if command.expected_state_hash() != actual_state_hash {
        return Err(RuntimeError::new(
            "state_hash_mismatch",
            "persistierter Flottenzustand passt nicht zum erwarteten Hash",
        ));
    }
    if command.expected_revision() != state.revision {
        return Err(RuntimeError::new(
            "revision_conflict",
            format!(
                "erwartet Revision {}, erhielt {}",
                command.expected_revision(),
                state.revision
            ),
        ));
    }
    if command.at_s() < state.produced_at {
        return Err(RuntimeError::new(
            "time_regression",
            "Flottenkommando liegt vor dem aktuellen Zustandszeitpunkt",
        ));
    }
    match command.clone() {
        FleetCommand::Formation(command) => {
            let formation = normalize_formation(command.formation);
            state.formations.insert(formation.id.clone(), formation);
        }
        FleetCommand::PersonnelDuty(command) => {
            let duty = normalize_personnel_duty(command.personnel_duty);
            state.personnel_duties.insert(duty.id.clone(), duty);
        }
        FleetCommand::PathReservation(command) => {
            let reservation = normalize_path_reservation(command.path_reservation);
            state
                .path_reservations
                .insert(reservation.id.clone(), reservation);
        }
    }
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or_else(|| RuntimeError::new("revision_overflow", "Flottenrevision ist erschoepft"))?;
    state.produced_at = command.at_s();
    state.processed_commands.insert(
        command.command_id().to_owned(),
        ProcessedFleetCommand {
            command_hash,
            resulting_revision: state.revision,
            entity_kind: command.entity_kind().to_owned(),
            entity_id: command.entity_id().to_owned(),
        },
    );
    command_result(state, &command, false)
}

/// Initialisiert einen leeren, weltgebundenen M5-Single-Writer-Zustand.
pub fn initialize_fleet_world(input_json: &str) -> Result<String, RuntimeError> {
    to_json(&initialized(parse_json(input_json)?)?)
}

/// Verarbeitet genau ein versioniertes Flottenkommando und materialisiert M5.
pub fn apply_fleet_command(state_json: &str, command_json: &str) -> Result<String, RuntimeError> {
    let state: FleetWorldState = parse_json(state_json)?;
    let command = parse_command(command_json)?;
    to_json(&apply(state, command)?)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{apply_fleet_command, initialize_fleet_world};

    const WORLD: &str = "11111111-1111-4111-8111-111111111111";

    fn initialize() -> Value {
        serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v1",
                    "worldId": WORLD,
                    "producedAt": 10
                })
                .to_string(),
            )
            .expect("Flottenwelt wird initialisiert"),
        )
        .expect("gueltiges Initialisierungsergebnis")
    }

    fn formation_command(initial: &Value, command_id: &str) -> Value {
        json!({
            "schemaVersion": "zugfolge-fleet-formation-command/v1",
            "worldId": WORLD,
            "commandId": command_id,
            "expectedStateHash": initial["stateHash"],
            "expectedRevision": initial["state"]["revision"],
            "atS": 11,
            "formation": {
                "id": "formation-1",
                "operatorId": "operator-1",
                "vehicleIds": ["vehicle-2", "vehicle-1"],
                "serviceLineIds": ["S1"],
                "availability": "available",
                "procurement": "delivered",
                "availableFrom": 0,
                "availableUntil": 100,
                "characteristics": {
                    "seats": 120,
                    "firstClassBasisPoints": 0,
                    "accessible": true,
                    "bicyclePlaces": 4,
                    "wheelchairPlaces": 1,
                    "equipment": ["wifi", "pis"],
                    "vehicleAgeYears": 1,
                    "maximumSpeedKph": 160,
                    "operatingCostCentsPerTrainKm": 700,
                    "homologatedLineIds": ["S1"],
                    "maintenanceValidUntil": 100,
                    "traction": "electric",
                    "replacementPlan": true
                }
            }
        })
    }

    fn apply(state: &Value, command: &Value) -> Value {
        serde_json::from_str(
            &apply_fleet_command(&state.to_string(), &command.to_string())
                .expect("Flottenkommando gelingt"),
        )
        .expect("gueltiges Kommandoergebnis")
    }

    #[test]
    fn snapshot_entsteht_ausschliesslich_aus_revisioniertem_rust_zustand() {
        let initial = initialize();
        let command = formation_command(&initial, "formation:create");
        let result = apply(&initial["state"], &command);
        assert_eq!(result["state"]["revision"], 1);
        assert_eq!(result["snapshot"]["revision"], 1);
        assert_eq!(result["snapshot"]["formations"][0]["id"], "formation-1");
        assert_eq!(
            result["snapshot"]["formations"][0]["vehicleIds"],
            json!(["vehicle-1", "vehicle-2"])
        );
        assert_ne!(result["stateHash"], initial["stateHash"]);

        let mut injected = command;
        injected["snapshot"] = json!({ "worldId": "forged" });
        let error = apply_fleet_command(&initial["state"].to_string(), &injected.to_string())
            .expect_err("angeliefertes Snapshot-JSON ist kein Flottenkommando");
        assert!(error.to_string().starts_with("invalid_json:"));
    }

    #[test]
    fn formation_personal_und_trasse_bilden_einen_vollstaendigen_snapshot() {
        let initial = initialize();
        let formation = apply(
            &initial["state"],
            &formation_command(&initial, "formation:create"),
        );
        let duty_command = json!({
            "schemaVersion": "zugfolge-fleet-personnel-duty-command/v1",
            "worldId": WORLD,
            "commandId": "duty:create",
            "expectedStateHash": formation["stateHash"],
            "expectedRevision": 1,
            "atS": 12,
            "personnelDuty": {
                "id": "duty-1",
                "operatorId": "operator-1",
                "formationIds": ["formation-1"],
                "status": "ready",
                "validFrom": 0,
                "validUntil": 100
            }
        });
        let duty = apply(&formation["state"], &duty_command);
        let path_command = json!({
            "schemaVersion": "zugfolge-fleet-path-reservation-command/v1",
            "worldId": WORLD,
            "commandId": "path:create",
            "expectedStateHash": duty["stateHash"],
            "expectedRevision": 2,
            "atS": 13,
            "pathReservation": {
                "id": "path-1",
                "operatorId": "operator-1",
                "serviceLineIds": ["S1"],
                "status": "confirmed",
                "validFrom": 0,
                "validUntil": 100
            }
        });
        let path = apply(&duty["state"], &path_command);
        assert_eq!(path["snapshot"]["revision"], 3);
        assert_eq!(path["snapshot"]["personnelDuties"][0]["id"], "duty-1");
        assert_eq!(path["snapshot"]["pathReservations"][0]["id"], "path-1");
    }

    #[test]
    fn replay_weltisolation_und_idempotenzkonflikt_sind_hart() {
        let initial = initialize();
        let command = formation_command(&initial, "formation:create");
        let result = apply(&initial["state"], &command);
        let replay = apply(&result["state"], &command);
        assert_eq!(replay["idempotentReplay"], true);
        assert_eq!(replay["stateHash"], result["stateHash"]);
        assert_eq!(replay["snapshotHash"], result["snapshotHash"]);

        let mut altered = command.clone();
        altered["formation"]["operatorId"] = json!("other");
        let conflict = apply_fleet_command(&result["state"].to_string(), &altered.to_string())
            .expect_err("Kommando-ID ist an Nutzdaten gebunden");
        assert!(conflict.to_string().starts_with("idempotency_conflict:"));

        let mut foreign = formation_command(&initial, "foreign");
        foreign["worldId"] = json!("22222222-2222-4222-8222-222222222222");
        let mismatch = apply_fleet_command(&initial["state"].to_string(), &foreign.to_string())
            .expect_err("Weltisolation ist bindend");
        assert!(mismatch.to_string().starts_with("world_mismatch:"));
    }

    #[test]
    fn utf8_byteordnung_ist_nicht_locale_oder_utf16_abhaengig() {
        let initial = initialize();
        let mut command = formation_command(&initial, "unicode");
        command["formation"]["vehicleIds"] = json!(["id-\u{10000}", "id-\u{e000}"]);
        let result = apply(&initial["state"], &command);
        assert_eq!(
            result["snapshot"]["formations"][0]["vehicleIds"],
            json!(["id-\u{e000}", "id-\u{10000}"])
        );
    }
}
