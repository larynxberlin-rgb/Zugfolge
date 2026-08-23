//! Persistierbare v2-Grenze fuer die eine autoritative Betriebswirklichkeit.

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zugfolge_sim::operational::{
    AutomaticShuntingNeed, DispatchRequest, MovementKind, OperationalDisruption, OperationalEvent,
    OperationalInfraRelease, OperationalProjection, OperationalWorld, PhysicalVehicle,
    ProjectionKind, TrainMaterialization, VehicleType,
};

use crate::initialization_hash::operational_initialization_hash;

pub const INITIALIZE_SCHEMA: &str = "zugfolge-operational-simulation-initialize/v2";
pub const COMMAND_SCHEMA: &str = "zugfolge-operational-simulation-command/v2";
pub const STATE_SCHEMA: &str = "zugfolge-operational-simulation-state/v2";
pub const INITIALIZED_SCHEMA: &str = "zugfolge-operational-simulation-initialized/v2";
pub const RESTORE_SCHEMA: &str = "zugfolge-operational-simulation-restore/v2";
pub const RESTORED_SCHEMA: &str = "zugfolge-operational-simulation-restored/v2";
pub const RESULT_SCHEMA: &str = "zugfolge-operational-simulation-result/v2";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperationalRuntimeError {
    code: &'static str,
    detail: String,
}

impl OperationalRuntimeError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for OperationalRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.detail)
    }
}

impl Error for OperationalRuntimeError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VehicleTypeInput {
    vehicle_type: VehicleType,
    powered: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FormationInput {
    id: String,
    predecessor_id: Option<String>,
    vehicle_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrainInput {
    id: String,
    train_number: String,
    operator_id: String,
    movement_kind: MovementKind,
    route_version_id: String,
    formation_version_id: String,
    head_route_mm: i64,
    scheduled_departure_ms: Option<i64>,
    public_passenger_stop: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Initialization {
    schema_version: String,
    world_id: String,
    region_id: String,
    now_ms: i64,
    infra_release: OperationalInfraRelease,
    vehicle_types: Vec<VehicleTypeInput>,
    vehicles: Vec<PhysicalVehicle>,
    formations: Vec<FormationInput>,
    trains: Vec<TrainInput>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum CommandPayload {
    Materialize {
        train: TrainInput,
    },
    Retire {
        train_id: String,
    },
    AdvanceTo {
        at_ms: i64,
    },
    Dispatch {
        requests: Vec<DispatchRequest>,
    },
    PlanMotion {
        train_id: String,
    },
    SafeStop {
        train_id: String,
        reason: String,
    },
    ChangeFormation {
        train_id: String,
        formation_id: String,
        vehicle_ids: Vec<String>,
    },
    Reroute {
        train_id: String,
        route_version_id: String,
    },
    AutomaticShunting {
        need: AutomaticShuntingNeed,
    },
    ActivateDisruption {
        disruption_id: String,
        effect: OperationalDisruption,
    },
    ClearDisruption {
        disruption_id: String,
        release_reference: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandEnvelope {
    schema_version: String,
    world_id: String,
    region_id: String,
    command_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    expected_publisher_sequence: u64,
    command: CommandPayload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RestoreEnvelope {
    schema_version: String,
    expected_initialization_hash: String,
    state: RuntimeState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeState {
    schema_version: String,
    initialization_hash: String,
    world: OperationalWorld,
    revision: u64,
    publisher_sequence: u64,
    state_hash: String,
    command_receipts: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InitializedResult {
    schema_version: &'static str,
    state: RuntimeState,
    initialization_hash: String,
    state_hash: String,
    live_map: OperationalProjection,
    rzue: OperationalProjection,
    events: Vec<OperationalEvent>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoredResult {
    schema_version: &'static str,
    state: RuntimeState,
    initialization_hash: String,
    state_hash: String,
    live_map: OperationalProjection,
    rzue: OperationalProjection,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    schema_version: &'static str,
    state: RuntimeState,
    initialization_hash: String,
    state_hash: String,
    live_map: OperationalProjection,
    rzue: OperationalProjection,
    events: Vec<OperationalEvent>,
    applied_command_id: String,
    idempotent_replay: bool,
}

fn decode<T: for<'de> Deserialize<'de>>(
    json: &str,
    name: &str,
) -> Result<T, OperationalRuntimeError> {
    serde_json::from_str(json).map_err(|error| {
        OperationalRuntimeError::new("invalid_json_contract", format!("{name}: {error}"))
    })
}

fn encode<T: Serialize>(value: &T) -> Result<String, OperationalRuntimeError> {
    serde_json::to_string(value)
        .map_err(|error| OperationalRuntimeError::new("serialization_failed", error.to_string()))
}

fn command_hash(command: &CommandPayload) -> Result<String, OperationalRuntimeError> {
    let bytes = serde_json::to_vec(command)
        .map_err(|error| OperationalRuntimeError::new("serialization_failed", error.to_string()))?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn state_hash(
    initialization_hash: &str,
    world: &OperationalWorld,
    revision: u64,
    publisher_sequence: u64,
    command_receipts: &BTreeMap<String, String>,
) -> String {
    let mut hash = Sha256::new();
    hash.update(b"zugfolge-operational-runtime-state/v2\0");
    hash.update(initialization_hash.as_bytes());
    hash.update(world.state_hash().as_bytes());
    hash.update(revision.to_be_bytes());
    hash.update(publisher_sequence.to_be_bytes());
    hash.update(serde_json::to_vec(command_receipts).expect("BTreeMap serialization cannot fail"));
    hash.finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn projections(world: &OperationalWorld) -> (OperationalProjection, OperationalProjection) {
    // Die native Commitgrenze liefert stets den vollstaendigen Regionskopf.
    // Sichtkorridorfilterung erfolgt erst im sequenzierten Streaming-Fanout;
    // aus einem leeren Startintervall darf kein Zug verschwinden.
    let visible_edges = Default::default();
    (
        world.project(ProjectionKind::LiveMap, &visible_edges),
        world.project(ProjectionKind::Rzue, &visible_edges),
    )
}

fn validate_state(state: &RuntimeState) -> Result<(), OperationalRuntimeError> {
    if state.schema_version != STATE_SCHEMA {
        return Err(OperationalRuntimeError::new(
            "unknown_state_schema",
            state.schema_version.clone(),
        ));
    }
    if !is_sha256(&state.initialization_hash) {
        return Err(OperationalRuntimeError::new(
            "invalid_initialization_hash",
            "persistierter v2-Zustand besitzt keine Initialisierungsbindung",
        ));
    }
    if !state.world.events.is_empty() {
        return Err(OperationalRuntimeError::new(
            "non_compact_checkpoint",
            "persistierter v2-Zustand enthaelt Ereignislogbytes",
        ));
    }
    if state.world.commit_sequence != state.revision || state.revision != state.publisher_sequence {
        return Err(OperationalRuntimeError::new(
            "commit_sequence_gap",
            "Commit-, Revisions- und Publishersequenz sind nicht identisch",
        ));
    }
    state.world.verify_invariants().map_err(|error| {
        OperationalRuntimeError::new("unsafe_persisted_state", error.to_string())
    })?;
    if state_hash(
        &state.initialization_hash,
        &state.world,
        state.revision,
        state.publisher_sequence,
        &state.command_receipts,
    ) != state.state_hash
    {
        return Err(OperationalRuntimeError::new(
            "state_hash_mismatch",
            "persistierter operativer Zustand wurde veraendert",
        ));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn materialize(
    world: &mut OperationalWorld,
    train: TrainInput,
) -> Result<(), OperationalRuntimeError> {
    world
        .materialize(TrainMaterialization {
            id: train.id,
            train_number: train.train_number,
            operator_id: train.operator_id,
            movement_kind: train.movement_kind,
            route_version_id: train.route_version_id,
            formation_version_id: train.formation_version_id,
            head_route_mm: train.head_route_mm,
            scheduled_departure_ms: train.scheduled_departure_ms,
            public_passenger_stop: train.public_passenger_stop,
        })
        .map_err(|error| {
            OperationalRuntimeError::new("operational_command_rejected", error.to_string())
        })
}

fn execute(
    world: &mut OperationalWorld,
    command: CommandPayload,
) -> Result<(), OperationalRuntimeError> {
    let rejected = |error: zugfolge_sim::operational::OperationalError| {
        OperationalRuntimeError::new("operational_command_rejected", error.to_string())
    };
    match command {
        CommandPayload::Materialize { train } => materialize(world, train),
        CommandPayload::Retire { train_id } => world.retire_train(&train_id).map_err(rejected),
        CommandPayload::AdvanceTo { at_ms } => world.advance_to(at_ms).map_err(rejected),
        CommandPayload::Dispatch { requests } => world
            .submit_dispatch_requests(&requests)
            .map(|_| ())
            .map_err(rejected),
        CommandPayload::PlanMotion { train_id } => {
            world.plan_motion(&train_id).map(|_| ()).map_err(rejected)
        }
        CommandPayload::SafeStop { train_id, reason } => {
            world.safe_stop(&train_id, &reason).map_err(rejected)
        }
        CommandPayload::ChangeFormation {
            train_id,
            formation_id,
            vehicle_ids,
        } => world
            .change_formation(&train_id, formation_id, vehicle_ids)
            .map_err(rejected),
        CommandPayload::Reroute {
            train_id,
            route_version_id,
        } => world
            .reroute_train(&train_id, &route_version_id)
            .map_err(rejected),
        CommandPayload::AutomaticShunting { need } => world
            .execute_automatic_shunting(&need)
            .map(|_| ())
            .map_err(rejected),
        CommandPayload::ActivateDisruption {
            disruption_id,
            effect,
        } => world
            .activate_disruption(disruption_id, effect)
            .map_err(rejected),
        CommandPayload::ClearDisruption {
            disruption_id,
            release_reference,
        } => world
            .clear_disruption(&disruption_id, &release_reference)
            .map_err(rejected),
    }
}

pub fn initialize_operational_simulation(
    input_json: &str,
) -> Result<String, OperationalRuntimeError> {
    let raw_input: Value = decode(input_json, "OperationalInitialization")?;
    let initialization_hash = operational_initialization_hash(&raw_input).map_err(|detail| {
        OperationalRuntimeError::new("invalid_initialization_hash_input", detail)
    })?;
    let input: Initialization = decode(input_json, "OperationalInitialization")?;
    if input.schema_version != INITIALIZE_SCHEMA {
        return Err(OperationalRuntimeError::new(
            "unknown_initialize_schema",
            input.schema_version,
        ));
    }
    let mut world = OperationalWorld::new(
        input.world_id,
        input.region_id,
        input.now_ms,
        input.infra_release,
    )
    .map_err(|error| {
        OperationalRuntimeError::new("invalid_operational_release", error.to_string())
    })?;
    for input in input.vehicle_types {
        world
            .register_vehicle_type(input.vehicle_type, input.powered)
            .map_err(|error| {
                OperationalRuntimeError::new("invalid_vehicle_type", error.to_string())
            })?;
    }
    for vehicle in input.vehicles {
        world
            .register_vehicle(vehicle)
            .map_err(|error| OperationalRuntimeError::new("invalid_vehicle", error.to_string()))?;
    }
    for formation in input.formations {
        world
            .create_formation(
                formation.id,
                formation.predecessor_id,
                formation.vehicle_ids,
            )
            .map_err(|error| {
                OperationalRuntimeError::new("invalid_formation", error.to_string())
            })?;
    }
    for train in input.trains {
        materialize(&mut world, train)?;
    }
    world
        .verify_invariants()
        .map_err(|error| OperationalRuntimeError::new("unsafe_initial_state", error.to_string()))?;
    let events = std::mem::take(&mut world.events);
    let command_receipts = BTreeMap::new();
    let hash = state_hash(&initialization_hash, &world, 0, 0, &command_receipts);
    let state = RuntimeState {
        schema_version: STATE_SCHEMA.to_owned(),
        initialization_hash: initialization_hash.clone(),
        world,
        revision: 0,
        publisher_sequence: 0,
        state_hash: hash.clone(),
        command_receipts,
    };
    let (live_map, rzue) = projections(&state.world);
    encode(&InitializedResult {
        schema_version: INITIALIZED_SCHEMA,
        events,
        state,
        initialization_hash,
        state_hash: hash,
        live_map,
        rzue,
    })
}

pub fn restore_operational_simulation(input_json: &str) -> Result<String, OperationalRuntimeError> {
    let envelope: RestoreEnvelope = decode(input_json, "OperationalRestore")?;
    if envelope.schema_version != RESTORE_SCHEMA {
        return Err(OperationalRuntimeError::new(
            "unknown_restore_schema",
            envelope.schema_version,
        ));
    }
    if !is_sha256(&envelope.expected_initialization_hash) {
        return Err(OperationalRuntimeError::new(
            "invalid_expected_initialization_hash",
            "Restore besitzt keine gueltige erwartete Initialisierungsbindung",
        ));
    }
    let state = envelope.state;
    validate_state(&state)?;
    if envelope.expected_initialization_hash != state.initialization_hash {
        return Err(OperationalRuntimeError::new(
            "initialization_hash_mismatch",
            "persistierter Zustand gehoert zu einer anderen Initialisierung",
        ));
    }
    let (live_map, rzue) = projections(&state.world);
    encode(&RestoredResult {
        schema_version: RESTORED_SCHEMA,
        initialization_hash: state.initialization_hash.clone(),
        state_hash: state.state_hash.clone(),
        state,
        live_map,
        rzue,
    })
}

pub fn apply_operational_simulation_command(
    state_json: &str,
    command_json: &str,
) -> Result<String, OperationalRuntimeError> {
    let mut state: RuntimeState = decode(state_json, "OperationalState")?;
    validate_state(&state)?;
    let envelope: CommandEnvelope = decode(command_json, "OperationalCommand")?;
    if envelope.schema_version != COMMAND_SCHEMA {
        return Err(OperationalRuntimeError::new(
            "unknown_command_schema",
            envelope.schema_version,
        ));
    }
    if envelope.world_id != state.world.world_id || envelope.region_id != state.world.region_id {
        return Err(OperationalRuntimeError::new(
            "world_region_mismatch",
            "Kommando gehoert nicht zu diesem Single-Writer",
        ));
    }
    let receipt_hash = command_hash(&envelope.command)?;
    if let Some(existing) = state.command_receipts.get(&envelope.command_id) {
        if existing != &receipt_hash {
            return Err(OperationalRuntimeError::new(
                "idempotency_conflict",
                envelope.command_id,
            ));
        }
        let (live_map, rzue) = projections(&state.world);
        return encode(&CommandResult {
            schema_version: RESULT_SCHEMA,
            initialization_hash: state.initialization_hash.clone(),
            state_hash: state.state_hash.clone(),
            state,
            live_map,
            rzue,
            events: Vec::new(),
            applied_command_id: envelope.command_id,
            idempotent_replay: true,
        });
    }
    if envelope.expected_state_hash != state.state_hash
        || envelope.expected_revision != state.revision
        || envelope.expected_publisher_sequence != state.publisher_sequence
    {
        return Err(OperationalRuntimeError::new(
            "optimistic_concurrency_conflict",
            "Hash, Revision oder Publishersequenz ist veraltet",
        ));
    }
    execute(&mut state.world, envelope.command)?;
    state.world.commit_runtime_command().map_err(|error| {
        OperationalRuntimeError::new("commit_sequence_exhausted", error.to_string())
    })?;
    state
        .world
        .processed_command_ids
        .insert(envelope.command_id.clone());
    state
        .world
        .verify_invariants()
        .map_err(|error| OperationalRuntimeError::new("unsafe_result_state", error.to_string()))?;
    state.revision = state.revision.checked_add(1).ok_or_else(|| {
        OperationalRuntimeError::new("revision_exhausted", "operative Revision ist erschoepft")
    })?;
    state.publisher_sequence = state.publisher_sequence.checked_add(1).ok_or_else(|| {
        OperationalRuntimeError::new(
            "publisher_sequence_exhausted",
            "operative Publishersequenz ist erschoepft",
        )
    })?;
    state
        .command_receipts
        .insert(envelope.command_id.clone(), receipt_hash);
    state.state_hash = state_hash(
        &state.initialization_hash,
        &state.world,
        state.revision,
        state.publisher_sequence,
        &state.command_receipts,
    );
    let events = std::mem::take(&mut state.world.events);
    let (live_map, rzue) = projections(&state.world);
    encode(&CommandResult {
        schema_version: RESULT_SCHEMA,
        initialization_hash: state.initialization_hash.clone(),
        state_hash: state.state_hash.clone(),
        state,
        live_map,
        rzue,
        events,
        applied_command_id: envelope.command_id,
        idempotent_replay: false,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use serde_json::{Value, json};
    use zugfolge_sim::operational::{
        Direction, EdgeGeometryPoint, InterlockingRouteTemplate, PhysicalVehicle, RouteLeg,
        RouteVersion, TrackInterval, VehicleCondition,
    };

    use super::*;

    fn set(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn initialization() -> Initialization {
        let route = RouteVersion {
            id: "route:v1".to_owned(),
            template_id: "template:v1".to_owned(),
            predecessor_id: None,
            transition_route_mm: None,
            legs: vec![RouteLeg {
                edge_id: "edge:1".to_owned(),
                direction: Direction::Along,
                edge_entry_mm: 0,
                edge_exit_mm: 100_000,
                route_start_mm: 0,
                block_ids: set(&["block:1"]),
                speed_limit_mmps: 20_000,
                gradient_per_mille: 0,
                required_protection_systems: set(&["pzb"]),
            }],
        };
        let interlocking = InterlockingRouteTemplate {
            id: "interlocking:1".to_owned(),
            route_template_id: "template:v1".to_owned(),
            signal_id: "signal:1".to_owned(),
            movement_kind: MovementKind::Train,
            path_resources: set(&["block:1"]),
            overlap_resources: set(&["overlap:1"]),
            flank_resources: set(&["flank:1"]),
            switch_positions: BTreeMap::from([("switch:1".to_owned(), "straight".to_owned())]),
            authority_end_route_mm: 90_000,
            release_after_tail_route_mm: 80_000,
        };
        Initialization {
            schema_version: INITIALIZE_SCHEMA.to_owned(),
            world_id: "world:1".to_owned(),
            region_id: "region:1".to_owned(),
            now_ms: 0,
            infra_release: OperationalInfraRelease {
                id: "infra:v2".to_owned(),
                directed_edges: BTreeMap::from([("edge:1".to_owned(), 100_000)]),
                edge_geometries: BTreeMap::from([(
                    "edge:1".to_owned(),
                    vec![
                        EdgeGeometryPoint {
                            edge_offset_mm: 0,
                            latitude_e7: 510_000_000,
                            longitude_e7: 120_000_000,
                            bearing_milli_degrees: Some(90_000),
                        },
                        EdgeGeometryPoint {
                            edge_offset_mm: 100_000,
                            latitude_e7: 510_000_000,
                            longitude_e7: 120_100_000,
                            bearing_milli_degrees: None,
                        },
                    ],
                )]),
                route_versions: BTreeMap::from([(route.id.clone(), route)]),
                interlocking_routes: BTreeMap::from([(interlocking.id.clone(), interlocking)]),
                signals: set(&["signal:1"]),
                switches: set(&["switch:1"]),
                block_resources: set(&["block:1", "overlap:1", "flank:1"]),
                platform_intervals: BTreeMap::from([(
                    "platform:1".to_owned(),
                    TrackInterval {
                        edge_id: "edge:1".to_owned(),
                        from_mm: 10_000,
                        to_mm: 30_000,
                        direction: Direction::Along,
                    },
                )]),
                region_boundaries: set(&["boundary:1"]),
                rzue_layout_id: "rzue:v1".to_owned(),
            },
            vehicle_types: vec![VehicleTypeInput {
                powered: true,
                vehicle_type: VehicleType {
                    id: "type:1".to_owned(),
                    role: None,
                    control_stands: None,
                    traction: None,
                    electric_systems: None,
                    length_mm: 10_000,
                    mass_kg: 80_000,
                    maximum_speed_mmps: 20_000,
                    power_watts: 4_000_000,
                    starting_tractive_force_newtons: 200_000,
                    raw_formation_dynamics: None,
                    maximum_acceleration_mmps2: 1_000,
                    service_brake_mmps2: 1_000,
                    emergency_brake_mmps2: 1_500,
                    protection_systems: set(&["pzb"]),
                },
            }],
            vehicles: vec![PhysicalVehicle {
                id: "vehicle:1".to_owned(),
                type_id: "type:1".to_owned(),
                powered: true,
                orientation: Direction::Along,
                condition: VehicleCondition {
                    mechanics_basis_points: 9_500,
                    drive_basis_points: 9_500,
                    brakes_basis_points: 9_500,
                    kilometres_since_maintenance: 0,
                    operating_hours_since_maintenance: 0,
                    open_observations: 0,
                },
                restrictions: BTreeMap::new(),
                history: Vec::new(),
            }],
            formations: vec![FormationInput {
                id: "formation:1".to_owned(),
                predecessor_id: None,
                vehicle_ids: vec!["vehicle:1".to_owned()],
            }],
            trains: vec![TrainInput {
                id: "train:1".to_owned(),
                train_number: "RB 1".to_owned(),
                operator_id: "operator:1".to_owned(),
                movement_kind: MovementKind::Train,
                route_version_id: "route:v1".to_owned(),
                formation_version_id: "formation:1".to_owned(),
                head_route_mm: 20_000,
                scheduled_departure_ms: None,
                public_passenger_stop: false,
            }],
        }
    }

    fn apply_value(state: &Value, command_id: &str, command: Value) -> Value {
        let envelope = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": state["world"]["worldId"],
            "regionId": state["world"]["regionId"],
            "commandId": command_id,
            "expectedStateHash": state["stateHash"],
            "expectedRevision": state["revision"],
            "expectedPublisherSequence": state["publisherSequence"],
            "command": command,
        });
        serde_json::from_str(
            &apply_operational_simulation_command(&state.to_string(), &envelope.to_string())
                .unwrap(),
        )
        .unwrap()
    }

    fn restore_value(
        state: &Value,
        expected_initialization_hash: &Value,
    ) -> Result<Value, OperationalRuntimeError> {
        let restored = restore_operational_simulation(
            &json!({
                "schemaVersion": RESTORE_SCHEMA,
                "expectedInitializationHash": expected_initialization_hash,
                "state": state,
            })
            .to_string(),
        )?;
        serde_json::from_str(&restored)
            .map_err(|error| OperationalRuntimeError::new("invalid_test_result", error.to_string()))
    }

    fn two_day_recurrence_hash() -> (String, Value) {
        let mut input = initialization();
        input.trains[0].head_route_mm = 0;
        input.trains[0].scheduled_departure_ms = Some(0);
        input.trains[0].public_passenger_stop = true;
        let interlocking = input
            .infra_release
            .interlocking_routes
            .get_mut("interlocking:1")
            .unwrap();
        interlocking.authority_end_route_mm = 100_000;
        interlocking.release_after_tail_route_mm = 90_000;
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&input).unwrap()).unwrap(),
        )
        .unwrap();
        let request = |train_id: &str, waiting_since_ms: i64| {
            json!({
                "type": "dispatch",
                "requests": [{
                    "trainId": train_id,
                    "interlockingRouteId": "interlocking:1",
                    "committedRank": 0,
                    "timetableDeviationMs": 0,
                    "passengerImpact": 0,
                    "contractualImpact": 0,
                    "networkImpact": 0,
                    "resourceConsequence": 0,
                    "recoveryRank": 0,
                    "waitingSinceMs": waiting_since_ms
                }]
            })
        };
        let day_ms = 86_400_000_i64;
        let mut result = apply_value(
            &initialized["state"],
            "day:0:dispatch",
            request("train:1", 0),
        );
        result = apply_value(
            &result["state"],
            "day:0:advance",
            json!({ "type": "advance-to", "atMs": day_ms }),
        );
        assert_eq!(result["liveMap"]["trains"][0]["headRouteMm"], 100_000);
        assert_eq!(result["liveMap"]["trains"][0]["motionState"], "standing");
        assert_eq!(result["liveMap"]["routeLocks"], json!([]));
        result = apply_value(
            &result["state"],
            "day:1:retire",
            json!({ "type": "retire", "trainId": "train:1" }),
        );
        result = apply_value(
            &result["state"],
            "day:1:materialize",
            json!({
                "type": "materialize",
                "train": {
                    "id": "train:1:day-1",
                    "trainNumber": "RB 1",
                    "operatorId": "operator:1",
                    "movementKind": "train",
                    "routeVersionId": "route:v1",
                    "formationVersionId": "formation:1",
                    "headRouteMm": 0,
                    "scheduledDepartureMs": day_ms,
                    "publicPassengerStop": true
                }
            }),
        );
        result = apply_value(
            &result["state"],
            "day:1:dispatch",
            request("train:1:day-1", day_ms),
        );
        result = apply_value(
            &result["state"],
            "day:1:advance",
            json!({ "type": "advance-to", "atMs": day_ms * 2 }),
        );
        (result["stateHash"].as_str().unwrap().to_owned(), result)
    }

    #[test]
    fn initializes_one_state_for_livemap_and_rzue_and_restores_hash() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(initialized["schemaVersion"], INITIALIZED_SCHEMA);
        assert_eq!(
            initialized["initializationHash"],
            initialized["state"]["initializationHash"]
        );
        assert_eq!(initialized["state"]["revision"], 0);
        assert_eq!(initialized["state"]["publisherSequence"], 0);
        assert_eq!(initialized["state"]["world"]["commitSequence"], 0);
        assert_eq!(initialized["state"]["world"]["eventSequence"], 2);
        assert!(
            initialized["events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|event| { event["commitSequence"] == 0 })
        );
        assert_eq!(
            initialized["liveMap"]["commitSequence"],
            initialized["rzue"]["commitSequence"]
        );
        assert_eq!(
            initialized["liveMap"]["trains"],
            initialized["rzue"]["trains"]
        );
        let restored =
            restore_value(&initialized["state"], &initialized["initializationHash"]).unwrap();
        assert_eq!(restored["stateHash"], initialized["stateHash"]);
        assert_eq!(
            restored["initializationHash"],
            initialized["initializationHash"]
        );
        assert!(restore_value(&initialized["state"], &json!("f".repeat(64))).is_err());
    }

    #[test]
    fn initialization_hash_binds_world_region_infra_and_formation() {
        let base = initialization();
        let initialized = |input: &Initialization| -> Value {
            serde_json::from_str(
                &initialize_operational_simulation(&encode(input).unwrap()).unwrap(),
            )
            .unwrap()
        };
        let base_hash = initialized(&base)["initializationHash"].clone();

        let mut other_world = base.clone();
        other_world.world_id = "world:2".to_owned();
        let mut other_region = base.clone();
        other_region.region_id = "region:2".to_owned();
        let mut other_infra = base.clone();
        other_infra.infra_release.id = "infra:v3".to_owned();
        let mut other_formation = base.clone();
        other_formation.formations[0].id = "formation:other".to_owned();
        other_formation.trains[0].formation_version_id = "formation:other".to_owned();

        for changed in [other_world, other_region, other_infra, other_formation] {
            assert_ne!(initialized(&changed)["initializationHash"], base_hash);
        }
    }

    #[test]
    fn applies_only_v2_commands_idempotently_and_rejects_add_delay() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let command = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "commandId": "command:dispatch:1",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "command": {
                "type": "dispatch",
                "requests": [{
                    "trainId": "train:1",
                    "interlockingRouteId": "interlocking:1",
                    "committedRank": 0,
                    "timetableDeviationMs": 0,
                    "passengerImpact": 0,
                    "contractualImpact": 0,
                    "networkImpact": 0,
                    "resourceConsequence": 0,
                    "recoveryRank": 0,
                    "waitingSinceMs": 0
                }]
            }
        });
        let applied: Value = serde_json::from_str(
            &apply_operational_simulation_command(
                &initialized["state"].to_string(),
                &command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(applied["idempotentReplay"], false);
        assert_eq!(applied["state"]["revision"], 1);
        assert_eq!(applied["state"]["publisherSequence"], 1);
        assert_eq!(applied["state"]["world"]["commitSequence"], 1);
        let events = applied["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
        assert_eq!(events[0]["eventSequence"], 3);
        assert_eq!(events[1]["eventSequence"], 4);
        assert_eq!(events[2]["eventSequence"], 5);
        assert!(events.iter().all(|event| event["commitSequence"] == 1));
        assert_eq!(
            applied["liveMap"]["commitSequence"],
            applied["rzue"]["commitSequence"]
        );
        let replayed: Value = serde_json::from_str(
            &apply_operational_simulation_command(
                &applied["state"].to_string(),
                &command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(replayed["idempotentReplay"], true);
        assert_eq!(replayed["stateHash"], applied["stateHash"]);
        assert_eq!(replayed["state"]["world"]["commitSequence"], 1);

        let forbidden = command
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<String, Value>>();
        let mut forbidden = Value::Object(forbidden);
        forbidden["command"] = json!({ "type": "add-delay", "trainId": "train:1", "seconds": 120 });
        assert!(
            apply_operational_simulation_command(
                &initialized["state"].to_string(),
                &forbidden.to_string(),
            )
            .is_err()
        );
    }

    #[test]
    fn eventless_advance_still_creates_exactly_one_atomic_commit() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let command = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "commandId": "command:advance:eventless",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "command": { "type": "advance-to", "atMs": 1_000 }
        });
        let applied: Value = serde_json::from_str(
            &apply_operational_simulation_command(
                &initialized["state"].to_string(),
                &command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();

        assert_eq!(applied["state"]["world"]["commitSequence"], 1);
        assert_eq!(applied["state"]["world"]["eventSequence"], 2);
        assert_eq!(applied["state"]["revision"], 1);
        assert_eq!(applied["events"], json!([]));
    }

    #[test]
    fn active_disruption_is_typed_and_identical_in_both_projections() {
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        let command = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "commandId": "command:disruption:1",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "command": {
                "type": "activate-disruption",
                "disruptionId": "disruption:signal",
                "effect": { "signal-failed": { "signalId": "signal:1" } }
            }
        });
        let applied: Value = serde_json::from_str(
            &apply_operational_simulation_command(
                &initialized["state"].to_string(),
                &command.to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        let expected = json!([{
            "disruptionId": "disruption:signal",
            "effect": { "signal-failed": { "signalId": "signal:1" } }
        }]);
        assert_eq!(applied["liveMap"]["activeDisruptions"], expected);
        assert_eq!(
            applied["liveMap"]["activeDisruptions"],
            applied["rzue"]["activeDisruptions"]
        );
        assert_eq!(applied["liveMap"]["commitSequence"], 1);
    }

    #[test]
    fn recurrence_retires_and_rematerializes_safely_across_multiple_days() {
        let (first_hash, first) = two_day_recurrence_hash();
        let (second_hash, second) = two_day_recurrence_hash();

        assert_eq!(first_hash, second_hash);
        assert_eq!(first["state"]["world"]["commitSequence"], 6);
        assert_eq!(first["state"]["revision"], 6);
        assert_eq!(first["liveMap"]["trains"][0]["trainId"], "train:1:day-1");
        assert_eq!(first["liveMap"], second["liveMap"]);
    }

    #[test]
    fn premature_retirement_is_rejected_without_a_commit() {
        let mut input = initialization();
        input.trains[0].head_route_mm = 0;
        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&input).unwrap()).unwrap(),
        )
        .unwrap();
        let envelope = json!({
            "schemaVersion": COMMAND_SCHEMA,
            "worldId": "world:1",
            "regionId": "region:1",
            "commandId": "retire:too-early",
            "expectedStateHash": initialized["stateHash"],
            "expectedRevision": 0,
            "expectedPublisherSequence": 0,
            "command": { "type": "retire", "trainId": "train:1" }
        });

        assert!(
            apply_operational_simulation_command(
                &initialized["state"].to_string(),
                &envelope.to_string(),
            )
            .is_err()
        );
        assert_eq!(initialized["state"]["world"]["commitSequence"], 0);
    }

    #[test]
    fn accepts_the_public_camel_case_command_contract_for_variant_fields() {
        let advance: CommandPayload = serde_json::from_value(json!({
            "type": "advance-to",
            "atMs": 1_000
        }))
        .unwrap();
        assert!(matches!(
            advance,
            CommandPayload::AdvanceTo { at_ms: 1_000 }
        ));

        let disruption: CommandPayload = serde_json::from_value(json!({
            "type": "activate-disruption",
            "disruptionId": "disruption:signal",
            "effect": {
                "signal-failed": { "signalId": "signal:1" }
            }
        }))
        .unwrap();
        assert!(matches!(
            disruption,
            CommandPayload::ActivateDisruption {
                disruption_id,
                effect: OperationalDisruption::SignalFailed { signal_id }
            } if disruption_id == "disruption:signal" && signal_id == "signal:1"
        ));
    }

    #[test]
    fn native_projection_keeps_standing_trains_without_occupied_start_interval() {
        let mut input = initialization();
        let mut second_vehicle = input.vehicles[0].clone();
        second_vehicle.id = "vehicle:2".to_owned();
        input.vehicles.push(second_vehicle);
        input.formations.push(FormationInput {
            id: "formation:2".to_owned(),
            predecessor_id: None,
            vehicle_ids: vec!["vehicle:2".to_owned()],
        });
        input.trains.push(TrainInput {
            id: "train:standing".to_owned(),
            train_number: "RB 0".to_owned(),
            operator_id: "operator:2".to_owned(),
            movement_kind: MovementKind::Train,
            route_version_id: "route:v1".to_owned(),
            formation_version_id: "formation:2".to_owned(),
            head_route_mm: 0,
            scheduled_departure_ms: None,
            public_passenger_stop: false,
        });

        let initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&input).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(initialized["liveMap"]["infraReleaseId"], "infra:v2");
        assert_eq!(
            initialized["liveMap"]["trains"].as_array().unwrap().len(),
            2
        );
        let standing = initialized["liveMap"]["trains"]
            .as_array()
            .unwrap()
            .iter()
            .find(|train| train["trainId"] == "train:standing")
            .unwrap();
        assert_eq!(standing["headGeometry"]["routeMm"], 0);
        assert_eq!(standing["headGeometry"]["edgeId"], "edge:1");
        assert_eq!(standing["motionState"], "standing");
        assert!(standing["tailGeometry"].is_null());
    }

    #[test]
    fn rejects_a_tampered_persisted_world() {
        let mut initialized: Value = serde_json::from_str(
            &initialize_operational_simulation(&encode(&initialization()).unwrap()).unwrap(),
        )
        .unwrap();
        initialized["state"]["world"]["nowMs"] = json!(1);
        assert!(restore_value(&initialized["state"], &initialized["initializationHash"],).is_err());
    }
}
