//! Autoritativer, revisionierter M5-Single-Writer.
//!
//! Die Plattform friert einmal serververtrauenswuerdige Quellfakten ein.
//! Folgekommandos enthalten nur IDs und Einsatzabsichten. Status,
//! Zugcharakteristik und der M5->M6-Snapshot werden ausschliesslich hieraus
//! abgeleitet; fertige Mobilisierungs-DTOs sind kein Kommandoformat.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zugfolge_fleet::{
    ControlStandConfiguration, Duty, DutyRoster, FLEET_MOBILIZATION_SCHEMA, FleetSnapshot,
    Formation, FormationDynamics, FormationVehicle, MaintenanceDeadline, MaintenanceRule,
    MaintenanceState, MobilizationAvailability, MobilizationCharacteristics,
    MobilizationDutyStatus, MobilizationFormation, MobilizationPathReservation,
    MobilizationPathStatus, MobilizationPersonnelDuty, MobilizationProcurement,
    MobilizationSnapshot, NeedLimits, PersonnelPool, PlannedService, ProcurementChannel,
    RotationActivity, RotationLeg, RotationPlan, VehicleApproval, VehicleAsset,
    VehicleConfigurationFacts, VehicleConfigurationV1, VehicleNeeds, VehicleOrientation,
    VehicleReadiness, VehicleTechnicalData, validate_timetable_release,
};
use zugfolge_infra::{
    Acceleration, ElectricSystems, Electrification, FleetClass, Force, Length, Mass, Power,
    PowerSystem, ProtectionSystem, Speed, TractionType, TrainCharacteristicsId, TrainProtection,
};
use zugfolge_sim::operational::{
    FORMATION_DYNAMICS_BASIS_POINTS, FormationDynamicsDerivationInput,
    MAX_FORMATION_ACCELERATION_MMPS2, MAX_FORMATION_BRAKE_MMPS2, derive_formation_dynamics,
};

use super::{RuntimeError, parse_json, sha256_json, to_json};

const FLEET_INITIALIZE_SCHEMA: &str = "zugfolge-fleet-world-initialize/v2";
const FLEET_INITIALIZED_SCHEMA: &str = "zugfolge-fleet-world-initialized/v2";
const FLEET_STATE_SCHEMA: &str = "zugfolge-fleet-world-state/v2";
const FLEET_STATE_VERIFICATION_SCHEMA: &str = "zugfolge-fleet-world-state-verification/v1";
const AUTHORITY_RELEASE_SCHEMA_V1: &str = "zugfolge-fleet-authority-release/v1";
const AUTHORITY_RELEASE_SCHEMA_V2: &str = "zugfolge-fleet-authority-release/v2";
const FORMATION_COMMAND_SCHEMA: &str = "zugfolge-fleet-form-vehicles-command/v2";
const PERSONNEL_DUTY_COMMAND_SCHEMA: &str = "zugfolge-fleet-assign-duty-command/v2";
const PATH_RESERVATION_COMMAND_SCHEMA: &str = "zugfolge-fleet-attach-path-command/v2";
const ASSET_TRANSFER_COMMAND_SCHEMA: &str = "zugfolge-fleet-transfer-asset-command/v1";
const MAINTENANCE_COMMAND_SCHEMA: &str = "zugfolge-fleet-schedule-maintenance-command/v1";
const FLEET_RESULT_SCHEMA: &str = "zugfolge-fleet-command-result/v2";
const FLEET_RECEIPT_SCHEMA: &str = "zugfolge-fleet-command-receipt/v1";
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const BASIS_POINTS_MAX: u16 = FORMATION_DYNAMICS_BASIS_POINTS;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityProcurementChannel {
    NewBuild,
    Leasing,
    Used,
}

impl From<AuthorityProcurementChannel> for ProcurementChannel {
    fn from(value: AuthorityProcurementChannel) -> Self {
        match value {
            AuthorityProcurementChannel::NewBuild => Self::NewBuild,
            AuthorityProcurementChannel::Leasing => Self::Leasing,
            AuthorityProcurementChannel::Used => Self::Used,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityProtectionSystem {
    Pzb,
    Lzb,
    EtcsLevel1,
    EtcsLevel2,
}

impl From<AuthorityProtectionSystem> for ProtectionSystem {
    fn from(value: AuthorityProtectionSystem) -> Self {
        match value {
            AuthorityProtectionSystem::Pzb => Self::Pzb,
            AuthorityProtectionSystem::Lzb => Self::Lzb,
            AuthorityProtectionSystem::EtcsLevel1 => Self::EtcsLevel1,
            AuthorityProtectionSystem::EtcsLevel2 => Self::EtcsLevel2,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityPowerSystem {
    Ac15kv,
    Ac25kv,
    Dc750v,
    Dc1500v,
    Dc3000v,
}

impl From<AuthorityPowerSystem> for PowerSystem {
    fn from(value: AuthorityPowerSystem) -> Self {
        match value {
            AuthorityPowerSystem::Ac15kv => Self::Ac15kV,
            AuthorityPowerSystem::Ac25kv => Self::Ac25kV,
            AuthorityPowerSystem::Dc750v => Self::Dc750V,
            AuthorityPowerSystem::Dc1500v => Self::Dc1500V,
            AuthorityPowerSystem::Dc3000v => Self::Dc3000V,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityTraction {
    Unpowered,
    Electric,
    Diesel,
    Battery,
}

/// Assetlokale, versionierte Betriebseinschraenkung aus Fleet Authority v2.
/// Die externe Darstellung entspricht bewusst dem Operational-Vertrag.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityVehicleRestriction {
    PowerBasisPoints(u16),
    MaximumSpeed(u32),
    ServiceBrake(u32),
    EmergencyBrake(u32),
    ProtectionUnavailable(AuthorityProtectionSystem),
    DoorAvailabilityBasisPoints(u16),
    Immobilized,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityVehicleRole {
    #[default]
    PoweredUnit,
    Locomotive,
    Coach,
    ControlCar,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityControlStands {
    front: bool,
    rear: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityOrientation {
    #[default]
    Along,
    Against,
}

impl Default for AuthorityControlStands {
    fn default() -> Self {
        Self {
            front: true,
            rear: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityElectrification {
    Unelectrified,
    OverheadAc15kv,
    OverheadAc25kv,
    OverheadDc1500v,
    OverheadDc3000v,
}

impl From<AuthorityElectrification> for Electrification {
    fn from(value: AuthorityElectrification) -> Self {
        match value {
            AuthorityElectrification::Unelectrified => Self::Unelectrified,
            AuthorityElectrification::OverheadAc15kv => Self::Overhead(PowerSystem::Ac15kV),
            AuthorityElectrification::OverheadAc25kv => Self::Overhead(PowerSystem::Ac25kV),
            AuthorityElectrification::OverheadDc1500v => Self::Overhead(PowerSystem::Dc1500V),
            AuthorityElectrification::OverheadDc3000v => Self::Overhead(PowerSystem::Dc3000V),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AuthorityPathDecision {
    Confirmed,
    Requested,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityMaintenanceDeadline {
    kind: String,
    due_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityTechnicalData {
    length_mm: i64,
    mass_kg: i64,
    maximum_speed_kph: u16,
    /// V2 bindet die technische Ganzzahlgeschwindigkeit explizit. V1 wird
    /// weiterhin aus km/h mit der historischen Aufrundung materialisiert.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    maximum_speed_mmps: Option<i64>,
    /// Legacy-Referenzprofil. Neue Katalogdaten dürfen die Werte auslassen
    /// und liefern die Fahrdynamik erst für die konkrete Formation.
    #[serde(default)]
    acceleration_mm_per_s2: i64,
    /// Legacy-Referenzprofil; siehe `acceleration_mm_per_s2`.
    #[serde(default)]
    deceleration_mm_per_s2: i64,
    #[serde(default)]
    continuous_power_kw: i64,
    #[serde(default)]
    starting_tractive_effort_kn: i64,
    #[serde(default)]
    brake_weight_kg: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    maximum_acceleration_cap_mmps2: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    service_brake_cap_mmps2: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    emergency_brake_multiplier_basis_points: Option<u16>,
    traction: AuthorityTraction,
    electric_systems: Vec<AuthorityPowerSystem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    role: Option<AuthorityVehicleRole>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    control_stands: Option<AuthorityControlStands>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityPassengerData {
    seats: u32,
    first_class_seats: u32,
    accessible: bool,
    bicycle_places: u16,
    wheelchair_places: u16,
    equipment: Vec<String>,
    operating_cost_cents_per_train_km: u32,
    replacement_plan: bool,
}

/// Operativer Zustandsvektor des Katalog-Seeds. Er ist absichtlich nicht mit
/// dem anders geschnittenen fuenfteiligen Fahrzeugmarkt-Zustand gleichgesetzt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityVehicleCondition {
    mechanics_basis_points: u16,
    drive_basis_points: u16,
    brakes_basis_points: u16,
    kilometres_since_maintenance: u64,
    operating_hours_since_maintenance: u64,
    open_observations: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityVehicleAsset {
    id: String,
    numeric_id: u64,
    operator_id: String,
    vehicle_type_id: u64,
    class_designation: String,
    trade_name: String,
    build_year: u16,
    acquisition_year: u16,
    procurement_channel: AuthorityProcurementChannel,
    approved_line_ids: Vec<String>,
    maintenance_deadlines: Vec<AuthorityMaintenanceDeadline>,
    installed_protection: Vec<AuthorityProtectionSystem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    orientation: Option<AuthorityOrientation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    condition: Option<AuthorityVehicleCondition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restrictions: Option<BTreeMap<String, AuthorityVehicleRestriction>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    history: Option<Vec<String>>,
    technical: AuthorityTechnicalData,
    passenger: AuthorityPassengerData,
    /// Vollständige M5-Konfiguration; fehlende Altdaten werden nicht ergänzt.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "zugfolge_fleet::deserialize_optional_vehicle_configuration"
    )]
    vehicle_configuration: Option<VehicleConfigurationV1>,
    delivered_at: u64,
    retired_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityPersonnelPool {
    id: String,
    numeric_id: u64,
    operator_id: String,
    capacity_seconds: u32,
    minimum_rest_seconds: u32,
    class_designations: Vec<String>,
    path_receipt_ids: Vec<String>,
    qualification_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityPathReceipt {
    id: String,
    numeric_route_id: u64,
    operator_id: String,
    service_line_ids: Vec<String>,
    decision: AuthorityPathDecision,
    valid_from: u64,
    valid_until: u64,
    platform_lengths_mm: Vec<i64>,
    electrifications: Vec<AuthorityElectrification>,
    required_protection: Vec<AuthorityProtectionSystem>,
    approved_classes: Vec<String>,
    planner_state_hash: String,
    conflict_check_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetAuthorityRelease {
    schema_version: String,
    release_id: String,
    reference_year: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    economy_release_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    economy_release_sha256: Option<String>,
    assets: Vec<AuthorityVehicleAsset>,
    personnel_pools: Vec<AuthorityPersonnelPool>,
    path_receipts: Vec<AuthorityPathReceipt>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitializeFleetWorld {
    schema_version: String,
    world_id: String,
    produced_at: u64,
    authority_release: FleetAuthorityRelease,
    /// Vollstaendiger Eigenbetriebsbestand bei Weltsimulationssekunde null.
    /// Optional und damit rueckwaertskompatibel fuer bestehende M5-Aufrufer.
    #[serde(default)]
    formations: Vec<FormationIntent>,
    #[serde(default)]
    personnel_duties: Vec<PersonnelDutyIntent>,
    #[serde(default)]
    path_reservations: Vec<PathReservationIntent>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FormationIntent {
    id: String,
    vehicle_ids: Vec<String>,
    path_receipt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dynamics: Option<AuthorityFormationDynamics>,
}

/// Das serverautoritativ abgeleitete, formationsbezogene Bewegungsprofil. Es
/// gehört nicht in den Stammdatensatz einer Lokomotive, weil deren wirksame
/// Beschleunigung und Bremsung von der gekuppelten Gesamtmasse und
/// Bremsstellung abhängen.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthorityFormationDynamics {
    acceleration_mm_per_s2: i64,
    deceleration_mm_per_s2: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersonnelDutyIntent {
    id: String,
    personnel_pool_id: String,
    formation_ids: Vec<String>,
    path_receipt_id: String,
    valid_from: u64,
    valid_until: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathReservationIntent {
    id: String,
    path_receipt_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AssetTransferType {
    Sale,
    RentalStart,
    RentalReturn,
    Reversal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetHolding {
    owner_operator_id: String,
    holder_operator_id: String,
    lessor_operator_id: Option<String>,
    contract_id: Option<String>,
    valid_until_s: Option<u64>,
    history_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceAssignment {
    formation_id: String,
    facility_id: String,
    starts_at_s: u64,
    ends_at_s: u64,
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
    formation_id: String,
    vehicle_ids: Vec<String>,
    path_receipt_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dynamics: Option<AuthorityFormationDynamics>,
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
    personnel_duty_id: String,
    personnel_pool_id: String,
    formation_ids: Vec<String>,
    path_receipt_id: String,
    valid_from: u64,
    valid_until: u64,
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
    path_reservation_id: String,
    path_receipt_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetTransferCommand {
    schema_version: String,
    world_id: String,
    command_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    at_s: u64,
    vehicle_id: String,
    transfer_type: AssetTransferType,
    from_owner_operator_id: String,
    to_owner_operator_id: String,
    from_holder_operator_id: String,
    to_holder_operator_id: String,
    lessor_operator_id: Option<String>,
    contract_id: Option<String>,
    valid_until_s: Option<u64>,
    transfer_receipt_hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceCommand {
    schema_version: String,
    world_id: String,
    command_id: String,
    expected_state_hash: String,
    expected_revision: u64,
    at_s: u64,
    formation_id: String,
    facility_id: String,
    starts_at_s: u64,
    ends_at_s: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandHeader {
    schema_version: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(untagged)]
enum FleetCommand {
    Formation(FormationCommand),
    PersonnelDuty(PersonnelDutyCommand),
    PathReservation(PathReservationCommand),
    AssetTransfer(AssetTransferCommand),
    Maintenance(MaintenanceCommand),
}

impl FleetCommand {
    fn normalize(&mut self) {
        match self {
            // Die v2-Reihung ist semantisch und bleibt Zugspitze -> Zugschluss.
            // V1 wird erst mit Kenntnis des gebundenen Authority-Releases im
            // Single-Writer kompatibel sortiert.
            Self::Formation(_) => {}
            Self::PersonnelDuty(command) => command.formation_ids.sort(),
            Self::PathReservation(_) => {}
            Self::AssetTransfer(_) => {}
            Self::Maintenance(_) => {}
        }
    }

    fn normalize_for_authority(&mut self, authority_v2: bool) {
        self.normalize();
        if !authority_v2 {
            if let Self::Formation(command) = self {
                command.vehicle_ids.sort();
            }
        }
    }

    fn world_id(&self) -> &str {
        match self {
            Self::Formation(command) => &command.world_id,
            Self::PersonnelDuty(command) => &command.world_id,
            Self::PathReservation(command) => &command.world_id,
            Self::AssetTransfer(command) => &command.world_id,
            Self::Maintenance(command) => &command.world_id,
        }
    }

    fn command_id(&self) -> &str {
        match self {
            Self::Formation(command) => &command.command_id,
            Self::PersonnelDuty(command) => &command.command_id,
            Self::PathReservation(command) => &command.command_id,
            Self::AssetTransfer(command) => &command.command_id,
            Self::Maintenance(command) => &command.command_id,
        }
    }

    const fn expected_revision(&self) -> u64 {
        match self {
            Self::Formation(command) => command.expected_revision,
            Self::PersonnelDuty(command) => command.expected_revision,
            Self::PathReservation(command) => command.expected_revision,
            Self::AssetTransfer(command) => command.expected_revision,
            Self::Maintenance(command) => command.expected_revision,
        }
    }

    fn expected_state_hash(&self) -> &str {
        match self {
            Self::Formation(command) => &command.expected_state_hash,
            Self::PersonnelDuty(command) => &command.expected_state_hash,
            Self::PathReservation(command) => &command.expected_state_hash,
            Self::AssetTransfer(command) => &command.expected_state_hash,
            Self::Maintenance(command) => &command.expected_state_hash,
        }
    }

    const fn at_s(&self) -> u64 {
        match self {
            Self::Formation(command) => command.at_s,
            Self::PersonnelDuty(command) => command.at_s,
            Self::PathReservation(command) => command.at_s,
            Self::AssetTransfer(command) => command.at_s,
            Self::Maintenance(command) => command.at_s,
        }
    }

    fn entity_kind(&self) -> &'static str {
        match self {
            Self::Formation(_) => "formation",
            Self::PersonnelDuty(_) => "personnel-duty",
            Self::PathReservation(_) => "path-reservation",
            Self::AssetTransfer(_) => "asset-holding",
            Self::Maintenance(_) => "maintenance-assignment",
        }
    }

    fn entity_id(&self) -> &str {
        match self {
            Self::Formation(command) => &command.formation_id,
            Self::PersonnelDuty(command) => &command.personnel_duty_id,
            Self::PathReservation(command) => &command.path_reservation_id,
            Self::AssetTransfer(command) => &command.vehicle_id,
            Self::Maintenance(command) => &command.formation_id,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetWorldState {
    schema_version: String,
    world_id: String,
    revision: u64,
    produced_at: u64,
    authority_release_hash: String,
    authority_release: FleetAuthorityRelease,
    formations: BTreeMap<String, FormationIntent>,
    personnel_duties: BTreeMap<String, PersonnelDutyIntent>,
    path_reservations: BTreeMap<String, PathReservationIntent>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    asset_holdings: BTreeMap<String, AssetHolding>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    maintenance_assignments: BTreeMap<String, MaintenanceAssignment>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FleetCommandReceipt {
    schema_version: String,
    world_id: String,
    command_id: String,
    command_hash: String,
    canonical_command_json: String,
    resulting_revision: u64,
    entity_kind: String,
    entity_id: String,
    resulting_state_hash: String,
    resulting_snapshot_hash: String,
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
struct FleetWorldStateVerification {
    schema_version: &'static str,
    world_id: String,
    revision: u64,
    produced_at: u64,
    authority_release_hash: String,
    state_hash: String,
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
    command_receipt: FleetCommandReceipt,
    applied_command_id: String,
    entity_kind: String,
    entity_id: String,
    idempotent_replay: bool,
}

struct MaterializedFormation {
    snapshot: MobilizationFormation,
    formation: Formation,
    authoritative_dynamics: Option<AuthorityFormationDynamics>,
}

fn invalid(detail: impl Into<String>) -> RuntimeError {
    RuntimeError::new("invalid_fleet_authority", detail)
}

fn non_empty(value: &str, field: &'static str) -> Result<(), RuntimeError> {
    if value.trim().is_empty() {
        return Err(invalid(format!("{field} darf nicht leer sein")));
    }
    Ok(())
}

fn safe_integer(value: u64, field: &'static str) -> Result<(), RuntimeError> {
    if value > MAX_SAFE_JSON_INTEGER {
        return Err(invalid(format!(
            "{field} liegt ausserhalb sicherer JSON-Ganzzahlen"
        )));
    }
    Ok(())
}

fn validate_authority_condition(condition: &AuthorityVehicleCondition) -> Result<(), RuntimeError> {
    if condition.mechanics_basis_points > BASIS_POINTS_MAX
        || condition.drive_basis_points > BASIS_POINTS_MAX
        || condition.brakes_basis_points > BASIS_POINTS_MAX
    {
        return Err(invalid(format!(
            "Authority-v2-Assetzustand ueberschreitet {BASIS_POINTS_MAX} Basispunkte"
        )));
    }
    safe_integer(
        condition.kilometres_since_maintenance,
        "authorityRelease.assets[].condition.kilometresSinceMaintenance",
    )?;
    safe_integer(
        condition.operating_hours_since_maintenance,
        "authorityRelease.assets[].condition.operatingHoursSinceMaintenance",
    )?;
    Ok(())
}

fn validate_authority_history(history: &[String]) -> Result<(), RuntimeError> {
    for entry in history {
        if entry.trim().is_empty() || entry.trim() != entry {
            return Err(invalid(
                "authorityRelease.assets[].history[] muss nichtleer und randfrei sein",
            ));
        }
    }
    Ok(())
}

fn sim_time(value: u64, field: &'static str) -> Result<i64, RuntimeError> {
    safe_integer(value, field)?;
    i64::try_from(value).map_err(|_| invalid(format!("{field} ist keine Simulationszeit")))
}

fn sha256(value: &str, field: &'static str) -> Result<(), RuntimeError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(format!("{field} ist kein SHA-256")));
    }
    Ok(())
}

fn maximum_speed_mmps_floor(maximum_speed_kph: u16) -> i64 {
    i64::from(maximum_speed_kph).saturating_mul(1_000_000) / 3_600
}

const fn display_km_h_ceil(speed: Speed) -> i64 {
    speed
        .millimetres_per_second()
        .saturating_mul(3_600)
        .saturating_add(999_999)
        / 1_000_000
}

fn stable_numeric_id(value: &str) -> u64 {
    let digest = Sha256::digest(value.as_bytes());
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    u64::from_be_bytes(bytes).max(1)
}

fn stable_numeric_u32(value: &str) -> u32 {
    let digest = Sha256::digest(value.as_bytes());
    let mut bytes = [0_u8; 4];
    bytes.copy_from_slice(&digest[..4]);
    u32::from_be_bytes(bytes).max(1)
}

fn canonical_json<T: Serialize>(value: &T) -> Result<String, RuntimeError> {
    let canonical = serde_json::to_value(value)
        .map_err(|error| RuntimeError::new("serialization_failed", error.to_string()))?;
    serde_json::to_string(&canonical)
        .map_err(|error| RuntimeError::new("serialization_failed", error.to_string()))
}

fn canonical_hash<T: Serialize>(value: &T) -> Result<String, RuntimeError> {
    let canonical = canonical_json(value)?;
    let mut hex = String::with_capacity(64);
    use std::fmt::Write as _;
    for byte in Sha256::digest(canonical.as_bytes()) {
        write!(&mut hex, "{byte:02x}")
            .map_err(|error| RuntimeError::new("serialization_failed", error.to_string()))?;
    }
    Ok(hex)
}

fn initial_asset_holding_history_hash(
    release_id: &str,
    asset: &AuthorityVehicleAsset,
) -> Result<String, RuntimeError> {
    match (&asset.condition, &asset.history) {
        (Some(condition), Some(history)) => canonical_hash(&(
            "fleet-asset-holding-initial/v2",
            release_id,
            &asset.id,
            &asset.operator_id,
            condition,
            history,
        )),
        (None, None) => canonical_hash(&(
            "fleet-asset-holding/v1",
            release_id,
            &asset.id,
            &asset.operator_id,
        )),
        _ => Err(invalid(
            "Authority-Asset muss condition und history gemeinsam liefern",
        )),
    }
}

fn ensure_unique_strings(values: &[String], field: &'static str) -> Result<(), RuntimeError> {
    if values.is_empty() {
        return Err(invalid(format!("{field} darf nicht leer sein")));
    }
    for value in values {
        non_empty(value, field)?;
    }
    if values.windows(2).any(|window| window[0] >= window[1]) {
        return Err(invalid(format!(
            "{field} enthaelt Duplikate oder ist nicht kanonisch UTF-8-sortiert"
        )));
    }
    Ok(())
}

fn ensure_unique_strings_preserving_order(
    values: &[String],
    field: &'static str,
) -> Result<(), RuntimeError> {
    if values.is_empty() {
        return Err(invalid(format!("{field} darf nicht leer sein")));
    }
    let mut seen = BTreeSet::new();
    for value in values {
        non_empty(value, field)?;
        if !seen.insert(value) {
            return Err(invalid(format!("{field} enthaelt Duplikate")));
        }
    }
    Ok(())
}

fn normalize_release(release: &mut FleetAuthorityRelease) {
    release.assets.sort_by(|left, right| left.id.cmp(&right.id));
    for asset in &mut release.assets {
        asset.approved_line_ids.sort();
        asset.installed_protection.sort();
        asset.technical.electric_systems.sort();
        asset.passenger.equipment.sort();
        if let Some(configuration) = &mut asset.vehicle_configuration {
            configuration.normalize();
        }
        asset
            .maintenance_deadlines
            .sort_by(|left, right| left.kind.cmp(&right.kind));
    }
    release
        .personnel_pools
        .sort_by(|left, right| left.id.cmp(&right.id));
    for pool in &mut release.personnel_pools {
        pool.class_designations.sort();
        pool.path_receipt_ids.sort();
    }
    release
        .path_receipts
        .sort_by(|left, right| left.id.cmp(&right.id));
    for receipt in &mut release.path_receipts {
        receipt.service_line_ids.sort();
        receipt.platform_lengths_mm.sort();
        receipt.electrifications.sort();
        receipt.required_protection.sort();
        receipt.approved_classes.sort();
    }
}

fn validate_release(release: &FleetAuthorityRelease) -> Result<(), RuntimeError> {
    let authority_v2 = match release.schema_version.as_str() {
        AUTHORITY_RELEASE_SCHEMA_V1 => false,
        AUTHORITY_RELEASE_SCHEMA_V2 => true,
        _ => {
            return Err(RuntimeError::new(
                "unsupported_schema",
                release.schema_version.clone(),
            ));
        }
    };
    non_empty(&release.release_id, "authorityRelease.releaseId")?;
    if authority_v2 {
        let economy_release_id = release
            .economy_release_id
            .as_deref()
            .ok_or_else(|| invalid("Authority-v2-Release besitzt keine EconomyRelease-ID"))?;
        non_empty(economy_release_id, "authorityRelease.economyReleaseId")?;
        let economy_release_sha256 = release
            .economy_release_sha256
            .as_deref()
            .ok_or_else(|| invalid("Authority-v2-Release besitzt keinen EconomyRelease-SHA-256"))?;
        sha256(
            economy_release_sha256,
            "authorityRelease.economyReleaseSha256",
        )?;
    }
    if release.reference_year == 0 || release.assets.is_empty() {
        return Err(invalid(
            "Authority-Release besitzt keine Referenzepoche oder Assets",
        ));
    }
    if release
        .assets
        .windows(2)
        .any(|items| items[0].id == items[1].id)
        || release
            .assets
            .iter()
            .map(|asset| asset.numeric_id)
            .collect::<BTreeSet<_>>()
            .len()
            != release.assets.len()
    {
        return Err(invalid("Authority-Release enthaelt doppelte Fahrzeug-IDs"));
    }
    for asset in &release.assets {
        non_empty(&asset.id, "authorityRelease.assets[].id")?;
        non_empty(&asset.operator_id, "authorityRelease.assets[].operatorId")?;
        if asset.numeric_id == 0
            || asset.vehicle_type_id == 0
            || asset.build_year > asset.acquisition_year
            || asset.build_year > release.reference_year
            || (authority_v2 && asset.acquisition_year > release.reference_year)
        {
            return Err(invalid("Authority-Asset besitzt ungueltige IDs oder Jahre"));
        }
        if authority_v2 {
            safe_integer(asset.numeric_id, "authorityRelease.assets[].numericId")?;
            safe_integer(
                asset.vehicle_type_id,
                "authorityRelease.assets[].vehicleTypeId",
            )?;
        }
        safe_integer(asset.delivered_at, "authorityRelease.assets[].deliveredAt")?;
        safe_integer(asset.retired_at, "authorityRelease.assets[].retiredAt")?;
        if asset.retired_at <= asset.delivered_at {
            return Err(invalid(
                "Authority-Asset besitzt kein positives Verfuegbarkeitsfenster",
            ));
        }
        ensure_unique_strings(
            &asset.approved_line_ids,
            "authorityRelease.assets[].approvedLineIds",
        )?;
        if asset
            .installed_protection
            .windows(2)
            .any(|items| items[0] == items[1])
            || asset
                .technical
                .electric_systems
                .windows(2)
                .any(|items| items[0] == items[1])
        {
            return Err(invalid(
                "Authority-Asset besitzt doppelte technische Ausstattungsfakten",
            ));
        }
        for equipment in &asset.passenger.equipment {
            non_empty(equipment, "authorityRelease.assets[].passenger.equipment")?;
        }
        if asset
            .passenger
            .equipment
            .windows(2)
            .any(|items| items[0] == items[1])
        {
            return Err(invalid(
                "Authority-Asset besitzt doppelte Fahrgastausstattung",
            ));
        }
        if asset.maintenance_deadlines.is_empty()
            || asset
                .maintenance_deadlines
                .windows(2)
                .any(|items| items[0].kind == items[1].kind)
        {
            return Err(invalid(
                "Authority-Asset besitzt keine eindeutigen Wartungsfristen",
            ));
        }
        for deadline in &asset.maintenance_deadlines {
            non_empty(
                &deadline.kind,
                "authorityRelease.assets[].maintenanceDeadlines[].kind",
            )?;
            safe_integer(
                deadline.due_at,
                "authorityRelease.assets[].maintenanceDeadlines[].dueAt",
            )?;
        }
        // Beschleunigung und Bremsvermögen sind bei einer Lokomotive keine
        // festen Fahrzeugwerte: Sie hängen vom gekuppelten Wagenpark ab.
        // Alte Releases dürfen dafür weiter ein Referenzprofil führen; neue
        // Katalogdaten dürfen beide Werte mit null auslassen, wenn Leistung
        // und Anfahrzugkraft als physische Grundlage vorhanden sind. Der
        // Dienst erhält dann ein separates FormationDynamics-Profil.
        let unpowered = matches!(asset.technical.traction, AuthorityTraction::Unpowered);
        let has_legacy_dynamics = asset.technical.acceleration_mm_per_s2 > 0
            && asset.technical.deceleration_mm_per_s2 > 0;
        let missing_legacy_dynamics = asset.technical.acceleration_mm_per_s2 == 0
            && asset.technical.deceleration_mm_per_s2 == 0;
        let has_raw_propulsion = asset.technical.continuous_power_kw > 0
            && asset.technical.starting_tractive_effort_kn > 0;
        let has_complete_raw_caps = asset.technical.maximum_acceleration_cap_mmps2.is_some()
            && asset.technical.service_brake_cap_mmps2.is_some()
            && asset
                .technical
                .emergency_brake_multiplier_basis_points
                .is_some();
        let omits_raw_caps = asset.technical.maximum_acceleration_cap_mmps2.is_none()
            && asset.technical.service_brake_cap_mmps2.is_none()
            && asset
                .technical
                .emergency_brake_multiplier_basis_points
                .is_none();
        if asset.technical.length_mm <= 0
            || asset.technical.mass_kg <= 0
            || asset.technical.maximum_speed_kph == 0
            || (!unpowered && !has_legacy_dynamics && !missing_legacy_dynamics)
            || (!unpowered && missing_legacy_dynamics && !has_raw_propulsion)
            || (unpowered
                && (asset.technical.acceleration_mm_per_s2 != 0
                    || asset.technical.deceleration_mm_per_s2 != 0))
            || asset.technical.continuous_power_kw < 0
            || asset.technical.starting_tractive_effort_kn < 0
            || asset.technical.brake_weight_kg < 0
            || (authority_v2
                && (asset.technical.brake_weight_kg == 0
                    || !has_complete_raw_caps
                    || (!unpowered && !has_raw_propulsion)
                    || (unpowered
                        && (asset.technical.continuous_power_kw != 0
                            || asset.technical.starting_tractive_effort_kn != 0
                            || asset.technical.maximum_acceleration_cap_mmps2 != Some(0)))))
            || (!authority_v2 && !omits_raw_caps)
        {
            return Err(invalid(
                "Authority-Asset besitzt ungueltige technische Daten",
            ));
        }
        if authority_v2
            && asset.technical.maximum_speed_mmps
                != Some(maximum_speed_mmps_floor(asset.technical.maximum_speed_kph))
        {
            return Err(invalid(
                "Authority-v2-Asset besitzt keine exakt abgerundete maximumSpeedMmps",
            ));
        }
        if authority_v2 {
            let reference = authority_type_reference_dynamics(&asset.technical)?;
            if has_legacy_dynamics
                && (asset.technical.acceleration_mm_per_s2
                    != i64::from(reference.acceleration_mmps2)
                    || asset.technical.deceleration_mm_per_s2
                        != i64::from(reference.service_brake_mmps2))
            {
                return Err(invalid(
                    "Authority-v2-Referenzprofil weicht von seinen gebundenen Rohwerten ab",
                ));
            }
        }
        let role = authority_role(&asset.technical, authority_v2)?;
        let control_stands = authority_control_stands(&asset.technical, authority_v2)?;
        authority_orientation(asset, authority_v2)?;
        match (&asset.condition, &asset.history) {
            (Some(condition), Some(history)) if authority_v2 => {
                validate_authority_condition(condition)?;
                validate_authority_history(history)?;
            }
            (Some(_), Some(_)) => {
                return Err(invalid(
                    "Authority-v1-Asset darf condition und history nicht vorwegnehmen",
                ));
            }
            (None, None) if authority_v2 => {
                return Err(invalid(
                    "Authority-v2-Asset besitzt keine expliziten condition und history",
                ));
            }
            (None, None) => {}
            _ => {
                return Err(invalid(
                    "Authority-Asset muss condition und history gemeinsam liefern",
                ));
            }
        }
        if authority_v2 {
            let restrictions = asset.restrictions.as_ref().ok_or_else(|| {
                invalid("Authority-v2-Asset besitzt keine expliziten restrictions")
            })?;
            for (restriction_id, restriction) in restrictions {
                non_empty(restriction_id, "authorityRelease.assets[].restrictions key")?;
                match restriction {
                    AuthorityVehicleRestriction::PowerBasisPoints(value) => {
                        if *value == 0 || *value > BASIS_POINTS_MAX {
                            return Err(invalid(format!(
                                "Authority-v2-Leistungsrestriktion '{restriction_id}' liegt nicht in 1..={BASIS_POINTS_MAX} Basispunkten"
                            )));
                        }
                    }
                    AuthorityVehicleRestriction::DoorAvailabilityBasisPoints(value) => {
                        if *value > BASIS_POINTS_MAX {
                            return Err(invalid(format!(
                                "Authority-v2-Restriktion '{restriction_id}' ueberschreitet {BASIS_POINTS_MAX} Basispunkte"
                            )));
                        }
                    }
                    AuthorityVehicleRestriction::MaximumSpeed(value)
                    | AuthorityVehicleRestriction::ServiceBrake(value)
                    | AuthorityVehicleRestriction::EmergencyBrake(value) => {
                        if *value == 0 {
                            return Err(invalid(format!(
                                "Authority-v2-Restriktion '{restriction_id}' besitzt einen Nullwert"
                            )));
                        }
                    }
                    AuthorityVehicleRestriction::ProtectionUnavailable(_)
                    | AuthorityVehicleRestriction::Immobilized => {}
                }
            }
        } else if asset.restrictions.is_some() {
            return Err(invalid(
                "Authority-v1-Asset darf keine v2-restrictions vorwegnehmen",
            ));
        }
        let requires_electric_systems = match asset.technical.traction {
            AuthorityTraction::Electric => true,
            AuthorityTraction::Battery => authority_v2,
            AuthorityTraction::Diesel | AuthorityTraction::Unpowered => false,
        };
        if requires_electric_systems == asset.technical.electric_systems.is_empty() {
            return Err(invalid(
                "Authority-Asset besitzt zur Traktion inkonsistente elektrische Systeme",
            ));
        }
        if asset
            .installed_protection
            .contains(&AuthorityProtectionSystem::Lzb)
            && !asset
                .installed_protection
                .contains(&AuthorityProtectionSystem::Pzb)
        {
            return Err(invalid(
                "LZB darf nur zusammen mit PZB im Authority-Asset stehen",
            ));
        }
        let has_baseline_protection = asset.installed_protection.iter().any(|system| {
            matches!(
                system,
                AuthorityProtectionSystem::Pzb
                    | AuthorityProtectionSystem::EtcsLevel1
                    | AuthorityProtectionSystem::EtcsLevel2
            )
        });
        if role != AuthorityVehicleRole::Coach && !has_baseline_protection {
            return Err(invalid(
                "Fuehrendes oder angetriebenes Authority-Asset besitzt weder PZB noch ETCS",
            ));
        }
        match role {
            AuthorityVehicleRole::Coach => {
                if asset.technical.traction != AuthorityTraction::Unpowered
                    || control_stands.front
                    || control_stands.rear
                {
                    return Err(invalid(
                        "Reisezugwagen muss nicht angetrieben und ohne Fuehrerstand sein",
                    ));
                }
            }
            AuthorityVehicleRole::ControlCar => {
                if asset.technical.traction != AuthorityTraction::Unpowered
                    || (!control_stands.front && !control_stands.rear)
                {
                    return Err(invalid(
                        "Steuerwagen braucht mindestens einen Fuehrerstand und keine Traktion",
                    ));
                }
            }
            AuthorityVehicleRole::Locomotive | AuthorityVehicleRole::PoweredUnit => {
                if asset.technical.traction == AuthorityTraction::Unpowered
                    || (authority_v2 && !control_stands.front && !control_stands.rear)
                {
                    return Err(invalid(
                        "Angetriebenes Authority-v2-Asset braucht Traktion und Fuehrerstand",
                    ));
                }
            }
        }
        if (role != AuthorityVehicleRole::Locomotive && asset.passenger.seats == 0)
            || asset.passenger.first_class_seats > asset.passenger.seats
        {
            return Err(invalid("Authority-Asset besitzt ungueltige Fahrgastdaten"));
        }
        if let Some(configuration) = &asset.vehicle_configuration {
            configuration
                .validate_against(VehicleConfigurationFacts {
                    length_mm: asset.technical.length_mm,
                    seats: asset.passenger.seats,
                    first_class_seats: asset.passenger.first_class_seats,
                    bicycle_places: asset.passenger.bicycle_places,
                    wheelchair_places: asset.passenger.wheelchair_places,
                    accessible: asset.passenger.accessible,
                })
                .and_then(|()| configuration.validate_equipment(&asset.passenger.equipment))
                .map_err(|error| {
                    invalid(format!("M5-Fahrzeugkonfiguration ist ungültig: {error}"))
                })?;
        }
    }
    if release
        .personnel_pools
        .windows(2)
        .any(|items| items[0].id == items[1].id)
        || release
            .personnel_pools
            .iter()
            .map(|pool| pool.numeric_id)
            .collect::<BTreeSet<_>>()
            .len()
            != release.personnel_pools.len()
    {
        return Err(invalid("Authority-Release enthaelt doppelte Personalpools"));
    }
    for pool in &release.personnel_pools {
        non_empty(&pool.id, "authorityRelease.personnelPools[].id")?;
        non_empty(
            &pool.operator_id,
            "authorityRelease.personnelPools[].operatorId",
        )?;
        sha256(
            &pool.qualification_hash,
            "authorityRelease.personnelPools[].qualificationHash",
        )?;
        ensure_unique_strings(
            &pool.class_designations,
            "authorityRelease.personnelPools[].classDesignations",
        )?;
        ensure_unique_strings(
            &pool.path_receipt_ids,
            "authorityRelease.personnelPools[].pathReceiptIds",
        )?;
        if pool.numeric_id == 0 || pool.capacity_seconds == 0 {
            return Err(invalid("Authority-Personalpool besitzt keine Kapazitaet"));
        }
        if authority_v2 {
            safe_integer(
                pool.numeric_id,
                "authorityRelease.personnelPools[].numericId",
            )?;
        }
    }
    if release
        .path_receipts
        .windows(2)
        .any(|items| items[0].id == items[1].id)
        || release
            .path_receipts
            .iter()
            .map(|receipt| receipt.numeric_route_id)
            .collect::<BTreeSet<_>>()
            .len()
            != release.path_receipts.len()
    {
        return Err(invalid("Authority-Release enthaelt doppelte Trassenbelege"));
    }
    for receipt in &release.path_receipts {
        non_empty(&receipt.id, "authorityRelease.pathReceipts[].id")?;
        non_empty(
            &receipt.operator_id,
            "authorityRelease.pathReceipts[].operatorId",
        )?;
        sha256(
            &receipt.planner_state_hash,
            "authorityRelease.pathReceipts[].plannerStateHash",
        )?;
        sha256(
            &receipt.conflict_check_hash,
            "authorityRelease.pathReceipts[].conflictCheckHash",
        )?;
        ensure_unique_strings(
            &receipt.service_line_ids,
            "authorityRelease.pathReceipts[].serviceLineIds",
        )?;
        ensure_unique_strings(
            &receipt.approved_classes,
            "authorityRelease.pathReceipts[].approvedClasses",
        )?;
        if receipt
            .electrifications
            .windows(2)
            .any(|items| items[0] == items[1])
            || receipt
                .required_protection
                .windows(2)
                .any(|items| items[0] == items[1])
        {
            return Err(invalid(
                "Authority-Trassenbeleg besitzt doppelte technische Freigaben",
            ));
        }
        safe_integer(
            receipt.valid_from,
            "authorityRelease.pathReceipts[].validFrom",
        )?;
        safe_integer(
            receipt.valid_until,
            "authorityRelease.pathReceipts[].validUntil",
        )?;
        if receipt.numeric_route_id == 0
            || receipt.valid_until <= receipt.valid_from
            || receipt.platform_lengths_mm.is_empty()
            || receipt
                .platform_lengths_mm
                .iter()
                .any(|length| *length <= 0)
            || receipt.electrifications.is_empty()
        {
            return Err(invalid(
                "Authority-Trassenbeleg ist technisch unvollstaendig",
            ));
        }
        if authority_v2 {
            safe_integer(
                receipt.numeric_route_id,
                "authorityRelease.pathReceipts[].numericRouteId",
            )?;
            for length in &receipt.platform_lengths_mm {
                safe_integer(
                    u64::try_from(*length).map_err(|_| {
                        invalid(
                            "authorityRelease.pathReceipts[].platformLengthsMm[] muss positiv sein",
                        )
                    })?,
                    "authorityRelease.pathReceipts[].platformLengthsMm[]",
                )?;
            }
        }
    }
    Ok(())
}

fn release_hash(release: &FleetAuthorityRelease) -> Result<String, RuntimeError> {
    sha256_json(release)
}

fn parse_command(json: &str) -> Result<FleetCommand, RuntimeError> {
    let header: CommandHeader = parse_json(json)?;
    let mut command = match header.schema_version.as_str() {
        FORMATION_COMMAND_SCHEMA => parse_json(json).map(FleetCommand::Formation),
        PERSONNEL_DUTY_COMMAND_SCHEMA => parse_json(json).map(FleetCommand::PersonnelDuty),
        PATH_RESERVATION_COMMAND_SCHEMA => parse_json(json).map(FleetCommand::PathReservation),
        ASSET_TRANSFER_COMMAND_SCHEMA => parse_json(json).map(FleetCommand::AssetTransfer),
        MAINTENANCE_COMMAND_SCHEMA => parse_json(json).map(FleetCommand::Maintenance),
        schema => Err(RuntimeError::new("unsupported_schema", schema)),
    }?;
    command.normalize();
    Ok(command)
}

fn state_hash(state: &FleetWorldState) -> Result<String, RuntimeError> {
    sha256_json(state)
}

fn receipt_by_id<'a>(
    release: &'a FleetAuthorityRelease,
    id: &str,
) -> Result<&'a AuthorityPathReceipt, RuntimeError> {
    release
        .path_receipts
        .binary_search_by(|receipt| receipt.id.as_str().cmp(id))
        .ok()
        .map(|index| &release.path_receipts[index])
        .ok_or_else(|| invalid(format!("unbekannter Trassenbeleg '{id}'")))
}

fn confirmed_receipt<'a>(
    release: &'a FleetAuthorityRelease,
    id: &str,
) -> Result<&'a AuthorityPathReceipt, RuntimeError> {
    let receipt = receipt_by_id(release, id)?;
    if receipt.decision != AuthorityPathDecision::Confirmed {
        return Err(invalid(format!("Trassenbeleg '{id}' ist nicht bestaetigt")));
    }
    Ok(receipt)
}

fn traction(
    technical: &AuthorityTechnicalData,
    authority_v2: bool,
) -> Result<TractionType, RuntimeError> {
    match technical.traction {
        AuthorityTraction::Unpowered => Ok(TractionType::Unpowered),
        AuthorityTraction::Electric => ElectricSystems::from_systems(
            technical.electric_systems.iter().copied().map(Into::into),
        )
        .map(TractionType::Electric)
        .map_err(|error| invalid(format!("ungueltige elektrische Systeme: {error}"))),
        AuthorityTraction::Diesel => Ok(TractionType::Diesel),
        AuthorityTraction::Battery if authority_v2 => ElectricSystems::from_systems(
            technical.electric_systems.iter().copied().map(Into::into),
        )
        .map(TractionType::BatteryElectricWithSystems)
        .map_err(|error| invalid(format!("ungueltige Batterie-Ladesysteme: {error}"))),
        AuthorityTraction::Battery => Ok(TractionType::BatteryElectric),
    }
}

fn vehicle_role(role: AuthorityVehicleRole) -> zugfolge_fleet::VehicleRole {
    match role {
        AuthorityVehicleRole::Locomotive => zugfolge_fleet::VehicleRole::Locomotive,
        AuthorityVehicleRole::PoweredUnit => zugfolge_fleet::VehicleRole::PoweredUnit,
        AuthorityVehicleRole::Coach => zugfolge_fleet::VehicleRole::Coach,
        AuthorityVehicleRole::ControlCar => zugfolge_fleet::VehicleRole::ControlCar,
    }
}

fn authority_role(
    technical: &AuthorityTechnicalData,
    authority_v2: bool,
) -> Result<AuthorityVehicleRole, RuntimeError> {
    technical
        .role
        .or_else(|| (!authority_v2).then(AuthorityVehicleRole::default))
        .ok_or_else(|| invalid("Authority-v2-Asset besitzt keine explizite Fahrzeugrolle"))
}

fn authority_control_stands(
    technical: &AuthorityTechnicalData,
    authority_v2: bool,
) -> Result<AuthorityControlStands, RuntimeError> {
    technical
        .control_stands
        .or_else(|| (!authority_v2).then(AuthorityControlStands::default))
        .ok_or_else(|| invalid("Authority-v2-Asset besitzt keine expliziten Fuehrerstaende"))
}

fn authority_orientation(
    asset: &AuthorityVehicleAsset,
    authority_v2: bool,
) -> Result<AuthorityOrientation, RuntimeError> {
    asset
        .orientation
        .or_else(|| (!authority_v2).then(AuthorityOrientation::default))
        .ok_or_else(|| invalid("Authority-v2-Asset besitzt keine explizite orientation"))
}

const fn vehicle_orientation(orientation: AuthorityOrientation) -> VehicleOrientation {
    match orientation {
        AuthorityOrientation::Along => VehicleOrientation::Along,
        AuthorityOrientation::Against => VehicleOrientation::Against,
    }
}

fn fleet_snapshot(
    release: &FleetAuthorityRelease,
    numeric_world_id: u64,
) -> Result<FleetSnapshot, RuntimeError> {
    let assets = release
        .assets
        .iter()
        .map(|source| {
            let approvals = source
                .approved_line_ids
                .iter()
                .map(|line| VehicleApproval::new(line.clone()))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| invalid(format!("ungueltige Fahrzeugzulassung: {error}")))?;
            let deadlines = source
                .maintenance_deadlines
                .iter()
                .map(|deadline| {
                    MaintenanceDeadline::new(
                        deadline.kind.clone(),
                        sim_time(deadline.due_at, "maintenanceDeadline.dueAt")?,
                    )
                    .map_err(|error| invalid(format!("ungueltige Wartungsfrist: {error}")))
                })
                .collect::<Result<Vec<_>, _>>()?;
            VehicleAsset::from_authority_release(
                &release.release_id,
                numeric_world_id,
                source.numeric_id,
                source.vehicle_type_id,
                FleetClass::new(source.class_designation.clone())
                    .map_err(|error| invalid(format!("ungueltige Baureihe: {error}")))?,
                source.trade_name.clone(),
                source.build_year,
                source.acquisition_year,
                source.procurement_channel.into(),
                approvals,
                deadlines,
                TrainProtection::from_systems(
                    source.installed_protection.iter().copied().map(Into::into),
                ),
            )
            .map_err(|error| invalid(format!("ungueltiges Authority-Asset: {error}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    FleetSnapshot::from_authority_release(numeric_world_id, &release.release_id, assets)
        .map_err(|error| invalid(format!("ungueltiger Authority-Flottensnapshot: {error}")))
}

fn technical_data(
    source: &AuthorityVehicleAsset,
    authority_v2: bool,
) -> Result<VehicleTechnicalData, RuntimeError> {
    let max_speed = if authority_v2 {
        Speed::from_millimetres_per_second(
            source
                .technical
                .maximum_speed_mmps
                .ok_or_else(|| invalid("Authority-v2-Asset besitzt keine maximumSpeedMmps"))?,
        )
    } else {
        Speed::from_km_h(i64::from(source.technical.maximum_speed_kph))
    };
    let role = authority_role(&source.technical, authority_v2)?;
    let control_stands = authority_control_stands(&source.technical, authority_v2)?;
    Ok(VehicleTechnicalData {
        vehicle_type_id: source.vehicle_type_id,
        length: Length::from_millimetres(source.technical.length_mm),
        mass: Mass::from_kilograms(source.technical.mass_kg),
        max_speed,
        acceleration: Acceleration::from_millimetres_per_second_squared(
            source.technical.acceleration_mm_per_s2,
        ),
        deceleration: Acceleration::from_millimetres_per_second_squared(
            source.technical.deceleration_mm_per_s2,
        ),
        continuous_power: Power::from_kilowatts(source.technical.continuous_power_kw),
        starting_tractive_effort: Force::from_kilonewtons(
            source.technical.starting_tractive_effort_kn,
        ),
        brake_weight: Mass::from_kilograms(source.technical.brake_weight_kg),
        traction: traction(&source.technical, authority_v2)?,
        role: vehicle_role(role),
        control_stands: ControlStandConfiguration {
            front: control_stands.front,
            rear: control_stands.rear,
        },
    })
}

fn apply_vehicle_restrictions(
    source: &AuthorityVehicleAsset,
    authority_v2: bool,
    vehicle: &mut FormationVehicle,
) -> Result<(), RuntimeError> {
    if !authority_v2 {
        return Ok(());
    }
    let restrictions = source
        .restrictions
        .as_ref()
        .ok_or_else(|| invalid("Authority-v2-Asset besitzt keine expliziten restrictions"))?;
    for restriction in restrictions.values() {
        match restriction {
            AuthorityVehicleRestriction::PowerBasisPoints(basis_points) => {
                let scaled = vehicle
                    .continuous_power
                    .kilowatts()
                    .checked_mul(i64::from(*basis_points))
                    .ok_or_else(|| invalid("Leistungsrestriktion ist uebergelaufen"))?
                    / i64::from(BASIS_POINTS_MAX);
                vehicle.continuous_power = Power::from_kilowatts(scaled);
            }
            AuthorityVehicleRestriction::MaximumSpeed(maximum_speed_mmps) => {
                vehicle.max_speed =
                    vehicle
                        .max_speed
                        .min(Speed::from_millimetres_per_second(i64::from(
                            *maximum_speed_mmps,
                        )));
            }
            AuthorityVehicleRestriction::ServiceBrake(brake_mmps2) => {
                vehicle.deceleration =
                    vehicle
                        .deceleration
                        .min(Acceleration::from_millimetres_per_second_squared(
                            i64::from(*brake_mmps2),
                        ));
            }
            AuthorityVehicleRestriction::ProtectionUnavailable(system) => {
                let unavailable: ProtectionSystem = (*system).into();
                let available = vehicle
                    .protection
                    .systems()
                    .filter(|candidate| *candidate != unavailable)
                    .collect::<Vec<_>>();
                vehicle.protection = TrainProtection::from_systems(available);
            }
            AuthorityVehicleRestriction::Immobilized => {
                vehicle.immobilized = true;
                if vehicle.traction != TractionType::Unpowered {
                    vehicle.protection = TrainProtection::from_systems([]);
                }
            }
            // Fleet fuehrt heute kein separates Schnellbremsfeld. Die
            // Restriktion bleibt im Authority-Asset erhalten; das
            // serverautoritativ abgeleitete Formationsprofil transportiert den
            // wirksamen Servicebremswert.
            AuthorityVehicleRestriction::EmergencyBrake(_)
            | AuthorityVehicleRestriction::DoorAvailabilityBasisPoints(_) => {}
        }
    }
    if vehicle.traction != TractionType::Unpowered && vehicle.continuous_power.kilowatts() == 0 {
        // Authority-v1 durfte seine Leistung auslassen und blieb historisch
        // dennoch eigenfahrfaehig. Nur v2 kann hierher gelangen: Dort ist die
        // Rohleistung positiv verpflichtend, null entsteht also erst durch
        // eine wirksame PowerBasisPoints-Restriktion.
        vehicle.immobilized = true;
        vehicle.protection = TrainProtection::from_systems([]);
    }
    Ok(())
}

fn formation_dynamics(
    source: AuthorityFormationDynamics,
) -> Result<FormationDynamics, RuntimeError> {
    FormationDynamics::new(
        Acceleration::from_millimetres_per_second_squared(source.acceleration_mm_per_s2),
        Acceleration::from_millimetres_per_second_squared(source.deceleration_mm_per_s2),
    )
    .map_err(|_| invalid("Formations-Fahrprofil besitzt keine positiven Werte"))
}

fn authority_type_reference_dynamics(
    technical: &AuthorityTechnicalData,
) -> Result<zugfolge_sim::operational::DerivedFormationDynamics, RuntimeError> {
    let total_mass_kg = u64::try_from(technical.mass_kg)
        .map_err(|_| invalid("Authority-v2-Masse ist nicht positiv darstellbar"))?;
    let total_brake_weight_kg = u64::try_from(technical.brake_weight_kg)
        .map_err(|_| invalid("Authority-v2-Bremsgewicht ist nicht positiv darstellbar"))?;
    let starting_tractive_effort_kn = u64::try_from(technical.starting_tractive_effort_kn)
        .map_err(|_| invalid("Authority-v2-Anfahrzugkraft ist nicht positiv darstellbar"))?;
    let effective_starting_tractive_force_newtons = starting_tractive_effort_kn
        .checked_mul(1_000)
        .ok_or_else(|| invalid("Authority-v2-Anfahrzugkraft ist uebergelaufen"))?;
    let maximum_acceleration_cap_mmps2 = u32::try_from(
        technical
            .maximum_acceleration_cap_mmps2
            .ok_or_else(|| invalid("Authority-v2-Asset besitzt keinen Beschleunigungs-Cap"))?,
    )
    .map_err(|_| invalid("Authority-v2-Beschleunigungs-Cap ist ungueltig"))?;
    let service_brake_cap_mmps2 = u32::try_from(
        technical
            .service_brake_cap_mmps2
            .ok_or_else(|| invalid("Authority-v2-Asset besitzt keinen Betriebsbrems-Cap"))?,
    )
    .map_err(|_| invalid("Authority-v2-Betriebsbrems-Cap ist ungueltig"))?;
    derive_formation_dynamics(FormationDynamicsDerivationInput {
        total_mass_kg,
        effective_starting_tractive_force_newtons,
        total_brake_weight_kg,
        maximum_acceleration_cap_mmps2,
        service_brake_cap_mmps2,
        emergency_brake_multiplier_basis_points: technical
            .emergency_brake_multiplier_basis_points
            .ok_or_else(|| {
                invalid("Authority-v2-Asset besitzt keinen Schnellbremsmultiplikator")
            })?,
    })
    .map_err(|error| invalid(format!("Authority-v2-Rohdynamik ist ungueltig: {error:?}")))
}

fn authoritative_formation_dynamics(
    sources: &[&AuthorityVehicleAsset],
    formation: &Formation,
) -> Result<Option<AuthorityFormationDynamics>, RuntimeError> {
    if sources.len() != formation.vehicles().len() || sources.is_empty() {
        return Err(invalid(
            "Authority-v2-Formation besitzt keine eindeutige Rohwertzuordnung",
        ));
    }
    let mut total_mass_kg = 0_u64;
    let mut total_brake_weight_kg = 0_u64;
    let mut effective_starting_tractive_force_newtons = 0_u64;
    let mut maximum_acceleration_cap_mmps2 = u32::MAX;
    let mut service_brake_cap_mmps2 = u32::MAX;
    let mut emergency_brake_multiplier_basis_points = u16::MAX;
    let mut restricted_service_brake_mmps2 = u32::MAX;
    let mut restricted_emergency_brake_mmps2 = u32::MAX;
    let mut has_usable_drive = false;

    for (source, vehicle) in sources.iter().zip(formation.vehicles()) {
        let technical = &source.technical;
        let mass_kg = u64::try_from(technical.mass_kg)
            .map_err(|_| invalid("Authority-v2-Formationsmasse ist ungueltig"))?;
        let brake_weight_kg = u64::try_from(technical.brake_weight_kg)
            .map_err(|_| invalid("Authority-v2-Formationsbremsgewicht ist ungueltig"))?;
        total_mass_kg = total_mass_kg
            .checked_add(mass_kg)
            .ok_or_else(|| invalid("Authority-v2-Formationsmasse ist uebergelaufen"))?;
        total_brake_weight_kg = total_brake_weight_kg
            .checked_add(brake_weight_kg)
            .ok_or_else(|| invalid("Authority-v2-Formationsbremsgewicht ist uebergelaufen"))?;
        let service_cap = u32::try_from(
            technical
                .service_brake_cap_mmps2
                .ok_or_else(|| invalid("Authority-v2-Asset besitzt keinen Betriebsbrems-Cap"))?,
        )
        .map_err(|_| invalid("Authority-v2-Betriebsbrems-Cap ist ungueltig"))?;
        service_brake_cap_mmps2 = service_brake_cap_mmps2.min(service_cap);
        emergency_brake_multiplier_basis_points = emergency_brake_multiplier_basis_points.min(
            technical
                .emergency_brake_multiplier_basis_points
                .ok_or_else(|| {
                    invalid("Authority-v2-Asset besitzt keinen Schnellbremsmultiplikator")
                })?,
        );
        if vehicle.traction != TractionType::Unpowered
            && !vehicle.immobilized
            && vehicle.continuous_power.kilowatts() > 0
        {
            has_usable_drive = true;
            let force_newtons = u64::try_from(technical.starting_tractive_effort_kn)
                .map_err(|_| invalid("Authority-v2-Anfahrzugkraft ist ungueltig"))?
                .checked_mul(1_000)
                .ok_or_else(|| invalid("Authority-v2-Anfahrzugkraft ist uebergelaufen"))?;
            effective_starting_tractive_force_newtons = effective_starting_tractive_force_newtons
                .checked_add(force_newtons)
                .ok_or_else(|| {
                    invalid("Authority-v2-Formationsanfahrzugkraft ist uebergelaufen")
                })?;
            let acceleration_cap =
                u32::try_from(technical.maximum_acceleration_cap_mmps2.ok_or_else(|| {
                    invalid("Authority-v2-Asset besitzt keinen Beschleunigungs-Cap")
                })?)
                .map_err(|_| invalid("Authority-v2-Beschleunigungs-Cap ist ungueltig"))?;
            maximum_acceleration_cap_mmps2 = maximum_acceleration_cap_mmps2.min(acceleration_cap);
        }
        for restriction in source
            .restrictions
            .as_ref()
            .into_iter()
            .flat_map(|restrictions| restrictions.values())
        {
            match restriction {
                AuthorityVehicleRestriction::ServiceBrake(limit) => {
                    restricted_service_brake_mmps2 = restricted_service_brake_mmps2.min(*limit);
                }
                AuthorityVehicleRestriction::EmergencyBrake(limit) => {
                    restricted_emergency_brake_mmps2 = restricted_emergency_brake_mmps2.min(*limit);
                }
                _ => {}
            }
        }
    }
    let maximum_acceleration_cap_mmps2 = if has_usable_drive {
        maximum_acceleration_cap_mmps2
    } else {
        0
    };
    let derived = derive_formation_dynamics(FormationDynamicsDerivationInput {
        total_mass_kg,
        effective_starting_tractive_force_newtons,
        total_brake_weight_kg,
        maximum_acceleration_cap_mmps2,
        service_brake_cap_mmps2,
        emergency_brake_multiplier_basis_points,
    })
    .map_err(|error| {
        invalid(format!(
            "Authority-v2-Formationsrohdynamik ist ungueltig: {error:?}"
        ))
    })?;
    let service_brake_mmps2 = derived
        .service_brake_mmps2
        .min(restricted_service_brake_mmps2);
    let emergency_brake_mmps2 = derived
        .emergency_brake_mmps2
        .min(restricted_emergency_brake_mmps2);
    if service_brake_mmps2 == 0
        || emergency_brake_mmps2 == 0
        || emergency_brake_mmps2 <= service_brake_mmps2
        || emergency_brake_mmps2 > MAX_FORMATION_BRAKE_MMPS2
        || (has_usable_drive
            && (derived.acceleration_mmps2 == 0
                || derived.acceleration_mmps2 > MAX_FORMATION_ACCELERATION_MMPS2))
    {
        return Err(invalid(
            "Authority-v2-Restriktionen erzeugen keine sichere Formationsdynamik",
        ));
    }
    if !has_usable_drive {
        return Ok(None);
    }
    Ok(Some(AuthorityFormationDynamics {
        acceleration_mm_per_s2: i64::from(derived.acceleration_mmps2),
        deceleration_mm_per_s2: i64::from(service_brake_mmps2),
    }))
}

fn materialize_formation(
    state: &FleetWorldState,
    intent: &FormationIntent,
) -> Result<MaterializedFormation, RuntimeError> {
    let authority_v2 = state.authority_release.schema_version == AUTHORITY_RELEASE_SCHEMA_V2;
    if authority_v2 {
        ensure_unique_strings_preserving_order(&intent.vehicle_ids, "formation.vehicleIds")?;
    } else {
        ensure_unique_strings(&intent.vehicle_ids, "formation.vehicleIds")?;
    }
    let receipt = confirmed_receipt(&state.authority_release, &intent.path_receipt_id)?;
    if state.produced_at < receipt.valid_from || state.produced_at >= receipt.valid_until {
        return Err(invalid(
            "Trassenbeleg ist zum Zustandszeitpunkt nicht gueltig",
        ));
    }
    let numeric_world_id = stable_numeric_id(&state.world_id);
    let fleet = fleet_snapshot(&state.authority_release, numeric_world_id)?;
    let mut sources = Vec::new();
    let mut vehicles = Vec::new();
    for vehicle_id in &intent.vehicle_ids {
        let source = state
            .authority_release
            .assets
            .binary_search_by(|asset| asset.id.as_str().cmp(vehicle_id))
            .ok()
            .map(|index| &state.authority_release.assets[index])
            .ok_or_else(|| invalid(format!("unbekanntes Authority-Asset '{vehicle_id}'")))?;
        let holding = state.asset_holdings.get(vehicle_id).ok_or_else(|| {
            invalid(format!(
                "Authority-Asset '{vehicle_id}' besitzt keinen Halterzustand"
            ))
        })?;
        if holding.holder_operator_id != receipt.operator_id {
            return Err(invalid(
                "Formation und Trassenbeleg gehoeren nicht demselben EVU",
            ));
        }
        if holding
            .valid_until_s
            .is_some_and(|valid_until| state.produced_at >= valid_until)
        {
            return Err(invalid(format!(
                "Mietbindung von Authority-Asset '{vehicle_id}' ist abgelaufen"
            )));
        }
        let available_until = source
            .maintenance_deadlines
            .iter()
            .map(|deadline| deadline.due_at)
            .chain([source.retired_at])
            .min()
            .ok_or_else(|| invalid("Authority-Asset besitzt kein Verfuegbarkeitsende"))?;
        if state.produced_at < source.delivered_at || state.produced_at >= available_until {
            return Err(invalid(format!(
                "Authority-Asset '{vehicle_id}' ist nicht verfuegbar"
            )));
        }
        if !receipt
            .service_line_ids
            .iter()
            .all(|line| source.approved_line_ids.binary_search(line).is_ok())
        {
            return Err(invalid(format!(
                "Authority-Asset '{vehicle_id}' ist nicht fuer alle Linien zugelassen"
            )));
        }
        let asset = fleet.vehicle(source.numeric_id).ok_or_else(|| {
            invalid(format!(
                "Authority-Asset '{vehicle_id}' fehlt im FleetSnapshot"
            ))
        })?;
        let technical = technical_data(source, authority_v2)?;
        let mut vehicle = if authority_v2 {
            FormationVehicle::from_asset_with_orientation(
                asset,
                &technical,
                vehicle_orientation(authority_orientation(source, true)?),
            )
        } else {
            FormationVehicle::from_asset(asset, &technical)
        }
        .map_err(|error| invalid(format!("technische Asset-Ableitung scheiterte: {error}")))?;
        apply_vehicle_restrictions(source, authority_v2, &mut vehicle)?;
        vehicles.push(vehicle);
        sources.push(source);
    }
    let formation = if authority_v2 {
        Formation::new_authoritative(numeric_world_id, stable_numeric_id(&intent.id), vehicles)
    } else {
        Formation::new(numeric_world_id, stable_numeric_id(&intent.id), vehicles)
    }
    .map_err(|error| invalid(format!("inkompatible Formation: {error}")))?;
    let authoritative_dynamics = if authority_v2 {
        let expected = authoritative_formation_dynamics(&sources, &formation)?;
        if intent
            .dynamics
            .is_some_and(|provided| Some(provided) != expected)
        {
            return Err(invalid(
                "caller-supplied FormationDynamics weicht von der Authority-Rohableitung ab",
            ));
        }
        expected
    } else {
        intent.dynamics
    };
    let platform_lengths = receipt
        .platform_lengths_mm
        .iter()
        .copied()
        .map(Length::from_millimetres)
        .collect::<Vec<_>>();
    let electrifications = receipt
        .electrifications
        .iter()
        .copied()
        .map(Into::into)
        .collect::<Vec<_>>();
    let required =
        TrainProtection::from_systems(receipt.required_protection.iter().copied().map(Into::into));
    let approved_classes = receipt
        .approved_classes
        .iter()
        .map(|class| {
            FleetClass::new(class.clone())
                .map_err(|error| invalid(format!("ungueltige Trassen-Baureihe: {error}")))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let train_characteristics = if formation.can_move_under_own_power() {
        formation
            .check_operating_route(
                &platform_lengths,
                &electrifications,
                &required,
                &approved_classes,
            )
            .map_err(|error| {
                invalid(format!(
                    "Formation ist mit der Trasse inkompatibel: {error}"
                ))
            })?;
        let characteristics_id = TrainCharacteristicsId::new(stable_numeric_u32(&intent.id));
        let characteristics = match authoritative_dynamics {
            Some(dynamics) => formation.characteristics_with_dynamics(
                characteristics_id,
                intent.id.clone(),
                formation_dynamics(dynamics)?,
            ),
            None => formation.characteristics(characteristics_id, intent.id.clone()),
        }
        .map_err(|error| {
            invalid(format!(
                "Zugcharakteristik konnte nicht abgeleitet werden: {error}"
            ))
        })?;
        Some(characteristics)
    } else {
        None
    };

    let seats = sources
        .iter()
        .try_fold(0_u32, |sum, source| sum.checked_add(source.passenger.seats))
        .ok_or_else(|| invalid("Sitzplatzsumme ist uebergelaufen"))?;
    let first_class_seats = sources
        .iter()
        .try_fold(0_u32, |sum, source| {
            sum.checked_add(source.passenger.first_class_seats)
        })
        .ok_or_else(|| invalid("Erste-Klasse-Summe ist uebergelaufen"))?;
    let first_class_basis_points = u16::try_from(
        u64::from(first_class_seats)
            .saturating_mul(10_000)
            .checked_div(u64::from(seats))
            .unwrap_or(0),
    )
    .map_err(|_| invalid("Erste-Klasse-Anteil ist ungueltig"))?;
    let bicycle_places = sources
        .iter()
        .try_fold(0_u16, |sum, source| {
            sum.checked_add(source.passenger.bicycle_places)
        })
        .ok_or_else(|| invalid("Fahrradplatzsumme ist uebergelaufen"))?;
    let wheelchair_places = sources
        .iter()
        .try_fold(0_u16, |sum, source| {
            sum.checked_add(source.passenger.wheelchair_places)
        })
        .ok_or_else(|| invalid("Rollstuhlplatzsumme ist uebergelaufen"))?;
    let operating_cost = sources
        .iter()
        .try_fold(0_u32, |sum, source| {
            sum.checked_add(source.passenger.operating_cost_cents_per_train_km)
        })
        .ok_or_else(|| invalid("Betriebskostensumme ist uebergelaufen"))?;
    let available_from = sources
        .iter()
        .map(|source| source.delivered_at)
        .max()
        .unwrap_or(0);
    let available_until = sources
        .iter()
        .flat_map(|source| {
            source
                .maintenance_deadlines
                .iter()
                .map(|deadline| deadline.due_at)
                .chain([source.retired_at])
        })
        .chain([receipt.valid_until])
        .min()
        .ok_or_else(|| invalid("Formation besitzt kein Verfuegbarkeitsende"))?;
    let mut equipment = sources[0]
        .passenger
        .equipment
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    for source in sources.iter().skip(1) {
        let available = source
            .passenger
            .equipment
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        equipment.retain(|item| available.contains(item));
    }
    let traction = match train_characteristics
        .as_ref()
        .map(|characteristics| characteristics.traction())
        .or_else(|| formation.physical_traction())
    {
        None | Some(TractionType::Unpowered) => zugfolge_fleet::MobilizationTraction::Unpowered,
        Some(TractionType::Electric(_)) => zugfolge_fleet::MobilizationTraction::Electric,
        Some(TractionType::Diesel) => zugfolge_fleet::MobilizationTraction::Diesel,
        Some(TractionType::BatteryElectric | TractionType::BatteryElectricWithSystems(_)) => {
            zugfolge_fleet::MobilizationTraction::Battery
        }
    };
    let vehicle_age_years = sources
        .iter()
        .map(|source| {
            state
                .authority_release
                .reference_year
                .saturating_sub(source.build_year)
        })
        .max()
        .unwrap_or(0);
    Ok(MaterializedFormation {
        snapshot: MobilizationFormation {
            id: intent.id.clone(),
            operator_id: receipt.operator_id.clone(),
            vehicle_ids: intent.vehicle_ids.clone(),
            path_receipt_id: Some(intent.path_receipt_id.clone()),
            service_line_ids: receipt.service_line_ids.clone(),
            // Mobilization-v1 besitzt noch keinen eigenen "immobilized"-
            // Status. Maintenance ist deshalb der konservative technische
            // Sperrstatus fuer einen physisch angetriebenen, aber vollstaendig
            // gesperrten/auf 0 kW gerasterten Verband; er behauptet hier
            // keinen bereits geplanten Werkstattauftrag. Ein reiner Wagenpark
            // bleibt dagegen Available + Unpowered.
            availability: if formation.can_move_under_own_power()
                || formation.physical_traction().is_none()
            {
                MobilizationAvailability::Available
            } else {
                MobilizationAvailability::Maintenance
            },
            procurement: MobilizationProcurement::Delivered,
            available_from,
            available_until,
            characteristics: MobilizationCharacteristics {
                seats,
                first_class_basis_points,
                accessible: sources.iter().all(|source| source.passenger.accessible),
                bicycle_places,
                wheelchair_places,
                equipment: equipment.into_iter().collect(),
                vehicle_age_years,
                maximum_speed_kph: u16::try_from(
                    train_characteristics
                        .as_ref()
                        .map(|characteristics| {
                            if state.authority_release.schema_version == AUTHORITY_RELEASE_SCHEMA_V2
                            {
                                display_km_h_ceil(characteristics.max_speed())
                            } else {
                                characteristics.max_speed().km_h()
                            }
                        })
                        .unwrap_or_else(|| {
                            formation
                                .vehicles()
                                .iter()
                                .map(|vehicle| vehicle.max_speed)
                                .min()
                                .map(|speed| {
                                    if authority_v2 {
                                        display_km_h_ceil(speed)
                                    } else {
                                        speed.km_h()
                                    }
                                })
                                .unwrap_or(0)
                        }),
                )
                .map_err(|_| invalid("abgeleitete Vmax passt nicht in u16"))?,
                operating_cost_cents_per_train_km: operating_cost,
                homologated_line_ids: receipt.service_line_ids.clone(),
                maintenance_valid_until: available_until,
                traction,
                replacement_plan: sources
                    .iter()
                    .all(|source| source.passenger.replacement_plan),
            },
        },
        formation,
        authoritative_dynamics,
    })
}

fn materialize_duty(
    state: &FleetWorldState,
    intent: &PersonnelDutyIntent,
) -> Result<MobilizationPersonnelDuty, RuntimeError> {
    ensure_unique_strings(&intent.formation_ids, "personnelDuty.formationIds")?;
    if intent.valid_until <= intent.valid_from {
        return Err(invalid("Personaldienst besitzt kein positives Zeitfenster"));
    }
    let receipt = confirmed_receipt(&state.authority_release, &intent.path_receipt_id)?;
    if intent.valid_from < receipt.valid_from || intent.valid_until > receipt.valid_until {
        return Err(invalid(
            "Personaldienst liegt ausserhalb des bestaetigten Trassenfensters",
        ));
    }
    let pool_source = state
        .authority_release
        .personnel_pools
        .binary_search_by(|pool| pool.id.as_str().cmp(&intent.personnel_pool_id))
        .ok()
        .map(|index| &state.authority_release.personnel_pools[index])
        .ok_or_else(|| {
            invalid(format!(
                "unbekannter Personalpool '{}'",
                intent.personnel_pool_id
            ))
        })?;
    if pool_source.operator_id != receipt.operator_id
        || pool_source
            .path_receipt_ids
            .binary_search(&intent.path_receipt_id)
            .is_err()
    {
        return Err(invalid(
            "Personalpool ist fuer EVU oder Trasse nicht qualifiziert",
        ));
    }
    let classes = pool_source
        .class_designations
        .iter()
        .map(|class| {
            FleetClass::new(class.clone())
                .map_err(|error| invalid(format!("ungueltige Personal-Baureihe: {error}")))
        })
        .collect::<Result<BTreeSet<_>, _>>()?;
    let routes = pool_source
        .path_receipt_ids
        .iter()
        .map(|id| receipt_by_id(&state.authority_release, id).map(|item| item.numeric_route_id))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let pool = PersonnelPool {
        world_id: stable_numeric_id(&state.world_id),
        id: pool_source.numeric_id,
        capacity_seconds: pool_source.capacity_seconds,
        minimum_rest_seconds: pool_source.minimum_rest_seconds,
        classes,
        routes,
    };
    let materialized = intent
        .formation_ids
        .iter()
        .map(|id| {
            let formation = state
                .formations
                .get(id)
                .ok_or_else(|| invalid(format!("unbekannte Formation '{id}'")))?;
            materialize_formation(state, formation)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if materialized
        .iter()
        .any(|formation| formation.snapshot.operator_id != pool_source.operator_id)
    {
        return Err(invalid(
            "Personaldienst und Formation gehoeren nicht demselben EVU",
        ));
    }
    if materialized
        .iter()
        .any(|formation| !formation.formation.can_move_under_own_power())
    {
        return Err(invalid(
            "Wagenpark ohne Lok darf abgestellt oder ueberfuehrt, aber nicht als Dienst eingeplant werden",
        ));
    }
    let first_class = materialized
        .first()
        .and_then(|formation| formation.formation.vehicles().first())
        .map(|vehicle| vehicle.class.clone())
        .ok_or_else(|| invalid("Personaldienst besitzt keine Formation"))?;
    if materialized.iter().any(|formation| {
        formation
            .formation
            .vehicles()
            .iter()
            .any(|vehicle| !pool.classes.contains(&vehicle.class))
    }) {
        return Err(invalid(
            "Personalpool ist fuer eine Formation nicht qualifiziert",
        ));
    }
    let mut roster = DutyRoster::default();
    let starts_at = sim_time(intent.valid_from, "personnelDuty.validFrom")?;
    let ends_at = sim_time(intent.valid_until, "personnelDuty.validUntil")?;
    roster
        .assign(
            &pool,
            Duty {
                pool_id: pool.id,
                starts_at,
                ends_at,
                class: first_class,
                route_id: receipt.numeric_route_id,
            },
        )
        .map_err(|error| invalid(format!("unqualifizierter Personaldienst: {error}")))?;
    let mut rotations = RotationPlan::default();
    let services = materialized
        .iter()
        .map(|formation| PlannedService {
            formation_id: formation.formation.id,
            personnel_pool_id: pool.id,
            starts_at,
            ends_at,
        })
        .collect::<Vec<_>>();
    for service in &services {
        rotations
            .add(RotationLeg {
                formation_id: service.formation_id,
                location_from: receipt.numeric_route_id,
                location_to: receipt.numeric_route_id,
                starts_at: service.starts_at,
                ends_at: service.ends_at,
                activity: RotationActivity::Service,
            })
            .map_err(|error| invalid(format!("Dienst-Umlauf ist ungueltig: {error}")))?;
    }
    let maintenance = vec![
        MaintenanceState {
            elapsed_seconds: 0,
            distance_km: 0,
            last_level: None,
        };
        services.len()
    ];
    let rules = vec![Vec::<MaintenanceRule>::new(); services.len()];
    let readiness = services
        .iter()
        .enumerate()
        .map(|(index, service)| VehicleReadiness {
            vehicle_id: service.formation_id,
            maintenance: &maintenance[index],
            maintenance_rules: &rules[index],
            needs: VehicleNeeds::default(),
            limits: NeedLimits {
                energy_milli: u64::MAX,
                sand_milli: u64::MAX,
                fresh_water_milli: u64::MAX,
                waste_milli: u64::MAX,
                interior_soil: u64::MAX,
                exterior_soil: u64::MAX,
            },
        })
        .collect::<Vec<_>>();
    validate_timetable_release(&services, &rotations, &roster, &readiness)
        .map_err(|error| invalid(format!("Fahrplanfreigabe fuer Dienst scheiterte: {error}")))?;
    Ok(MobilizationPersonnelDuty {
        id: intent.id.clone(),
        operator_id: pool_source.operator_id.clone(),
        formation_ids: intent.formation_ids.clone(),
        path_receipt_id: Some(intent.path_receipt_id.clone()),
        status: MobilizationDutyStatus::Ready,
        valid_from: intent.valid_from,
        valid_until: intent.valid_until,
    })
}

fn materialize_path(
    state: &FleetWorldState,
    intent: &PathReservationIntent,
) -> Result<MobilizationPathReservation, RuntimeError> {
    let receipt = confirmed_receipt(&state.authority_release, &intent.path_receipt_id)?;
    Ok(MobilizationPathReservation {
        id: intent.id.clone(),
        operator_id: receipt.operator_id.clone(),
        path_receipt_id: Some(intent.path_receipt_id.clone()),
        service_line_ids: receipt.service_line_ids.clone(),
        status: MobilizationPathStatus::Confirmed,
        valid_from: receipt.valid_from,
        valid_until: receipt.valid_until,
    })
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
    let mut authority = state.authority_release.clone();
    normalize_release(&mut authority);
    validate_release(&authority)?;
    let actual_release_hash = release_hash(&authority)?;
    if authority != state.authority_release || actual_release_hash != state.authority_release_hash {
        return Err(invalid(
            "Authority-Release oder Release-Hash im Zustand wurde manipuliert",
        ));
    }
    let mut formations = state
        .formations
        .iter()
        .map(|(id, intent)| {
            if id != &intent.id {
                return Err(invalid(
                    "Formation stimmt nicht mit ihrem Zustandsschluessel ueberein",
                ));
            }
            let materialized = materialize_formation(state, intent)?;
            if state.authority_release.schema_version == AUTHORITY_RELEASE_SCHEMA_V2
                && intent.dynamics != materialized.authoritative_dynamics
            {
                return Err(invalid(
                    "persistierte Authority-v2-Formation besitzt nicht ihre Rohwertableitung",
                ));
            }
            Ok(materialized.snapshot)
        })
        .collect::<Result<Vec<_>, _>>()?;
    for formation in &mut formations {
        if state.maintenance_assignments.values().any(|assignment| {
            assignment.formation_id == formation.id
                && assignment.starts_at_s <= state.produced_at
                && state.produced_at < assignment.ends_at_s
        }) {
            formation.availability = MobilizationAvailability::Maintenance;
        }
    }
    let personnel_duties = state
        .personnel_duties
        .iter()
        .map(|(id, intent)| {
            if id != &intent.id {
                return Err(invalid(
                    "Personaldienst stimmt nicht mit seinem Zustandsschluessel ueberein",
                ));
            }
            materialize_duty(state, intent)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let path_reservations = state
        .path_reservations
        .iter()
        .map(|(id, intent)| {
            if id != &intent.id {
                return Err(invalid(
                    "Trassenreservierung stimmt nicht mit ihrem Zustandsschluessel ueberein",
                ));
            }
            materialize_path(state, intent)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let snapshot = MobilizationSnapshot {
        schema: FLEET_MOBILIZATION_SCHEMA.to_owned(),
        world_id: state.world_id.clone(),
        revision: state.revision,
        produced_at: state.produced_at,
        formations,
        personnel_duties,
        path_reservations,
    };
    snapshot
        .validate()
        .map_err(|error| invalid(format!("abgeleiteter Snapshot ist ungueltig: {error:?}")))?;
    Ok(snapshot)
}

fn snapshot_hash(snapshot: &MobilizationSnapshot) -> Result<String, RuntimeError> {
    snapshot
        .sha256()
        .map_err(|error| invalid(format!("Snapshothash scheiterte: {error:?}")))
}

fn initialized(mut input: InitializeFleetWorld) -> Result<FleetWorldInitialized, RuntimeError> {
    if input.schema_version != FLEET_INITIALIZE_SCHEMA {
        return Err(RuntimeError::new(
            "unsupported_schema",
            input.schema_version,
        ));
    }
    non_empty(&input.world_id, "worldId")?;
    safe_integer(input.produced_at, "producedAt")?;
    normalize_release(&mut input.authority_release);
    validate_release(&input.authority_release)?;
    if input.authority_release.schema_version == AUTHORITY_RELEASE_SCHEMA_V2
        && input.authority_release.assets.iter().any(|asset| {
            asset.delivered_at > input.produced_at
                || input.produced_at >= asset.retired_at
                || asset
                    .maintenance_deadlines
                    .iter()
                    .any(|deadline| deadline.due_at <= input.produced_at)
        })
    {
        return Err(invalid(
            "Authority-v2 enthaelt am Initialisierungsstichtag ein noch nicht geliefertes, ausgemustertes oder ueberfaelliges Asset",
        ));
    }
    if input.authority_release.schema_version == AUTHORITY_RELEASE_SCHEMA_V1 {
        for formation in &mut input.formations {
            formation.vehicle_ids.sort();
        }
    }
    input
        .formations
        .sort_by(|left, right| left.id.cmp(&right.id));
    for duty in &mut input.personnel_duties {
        duty.formation_ids.sort();
    }
    input
        .personnel_duties
        .sort_by(|left, right| left.id.cmp(&right.id));
    input
        .path_reservations
        .sort_by(|left, right| left.id.cmp(&right.id));
    let authority_release_hash = release_hash(&input.authority_release)?;
    let asset_holdings = input
        .authority_release
        .assets
        .iter()
        .map(|asset| {
            Ok((
                asset.id.clone(),
                AssetHolding {
                    owner_operator_id: asset.operator_id.clone(),
                    holder_operator_id: asset.operator_id.clone(),
                    lessor_operator_id: None,
                    contract_id: None,
                    valid_until_s: None,
                    history_hash: initial_asset_holding_history_hash(
                        &input.authority_release.release_id,
                        asset,
                    )?,
                },
            ))
        })
        .collect::<Result<BTreeMap<_, _>, RuntimeError>>()?;
    let mut state = FleetWorldState {
        schema_version: FLEET_STATE_SCHEMA.to_owned(),
        world_id: input.world_id,
        revision: 0,
        produced_at: input.produced_at,
        authority_release_hash,
        authority_release: input.authority_release,
        formations: BTreeMap::new(),
        personnel_duties: BTreeMap::new(),
        path_reservations: BTreeMap::new(),
        asset_holdings,
        maintenance_assignments: BTreeMap::new(),
    };
    for mut intent in input.formations {
        if state.formations.contains_key(&intent.id) {
            return Err(invalid("doppelte initiale Formation"));
        }
        if state.formations.values().any(|existing| {
            existing
                .vehicle_ids
                .iter()
                .any(|vehicle| intent.vehicle_ids.contains(vehicle))
        }) {
            return Err(invalid(
                "Authority-Asset ist mehreren initialen Formationen zugeordnet",
            ));
        }
        let materialized = materialize_formation(&state, &intent)?;
        if state.authority_release.schema_version == AUTHORITY_RELEASE_SCHEMA_V2 {
            intent.dynamics = materialized.authoritative_dynamics;
        }
        state.formations.insert(intent.id.clone(), intent);
    }
    for intent in input.personnel_duties {
        if state.personnel_duties.contains_key(&intent.id) {
            return Err(invalid("doppelter initialer Personaldienst"));
        }
        materialize_duty(&state, &intent)?;
        state.personnel_duties.insert(intent.id.clone(), intent);
    }
    for intent in input.path_reservations {
        if state.path_reservations.contains_key(&intent.id) {
            return Err(invalid("doppelte initiale Trassenreservierung"));
        }
        materialize_path(&state, &intent)?;
        state.path_reservations.insert(intent.id.clone(), intent);
    }
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
    receipt: FleetCommandReceipt,
    idempotent_replay: bool,
) -> Result<FleetCommandResult, RuntimeError> {
    let snapshot = snapshot(&state)?;
    Ok(FleetCommandResult {
        schema_version: FLEET_RESULT_SCHEMA,
        state_hash: state_hash(&state)?,
        snapshot_hash: snapshot_hash(&snapshot)?,
        state,
        snapshot,
        command_receipt: receipt,
        applied_command_id: command.command_id().to_owned(),
        entity_kind: command.entity_kind().to_owned(),
        entity_id: command.entity_id().to_owned(),
        idempotent_replay,
    })
}

fn validate_replay_receipt(
    state: &FleetWorldState,
    command: &FleetCommand,
    command_hash: &str,
    canonical_command_json: &str,
    receipt: &FleetCommandReceipt,
) -> Result<(), RuntimeError> {
    if receipt.schema_version != FLEET_RECEIPT_SCHEMA
        || receipt.world_id != state.world_id
        || receipt.command_id != command.command_id()
        || receipt.command_hash != command_hash
        || receipt.canonical_command_json != canonical_command_json
        || receipt.entity_kind != command.entity_kind()
        || receipt.entity_id != command.entity_id()
        || receipt.resulting_revision == 0
        || receipt.resulting_revision != state.revision
    {
        return Err(RuntimeError::new(
            "idempotency_conflict",
            "persistierte Fleet-Receipt passt nicht zum kanonischen Kommando",
        ));
    }
    sha256(&receipt.resulting_state_hash, "receipt.resultingStateHash")?;
    sha256(
        &receipt.resulting_snapshot_hash,
        "receipt.resultingSnapshotHash",
    )?;
    let actual_state_hash = state_hash(state)?;
    let actual_snapshot_hash = snapshot_hash(&snapshot(state)?)?;
    if receipt.resulting_state_hash != actual_state_hash
        || receipt.resulting_snapshot_hash != actual_snapshot_hash
    {
        return Err(RuntimeError::new(
            "idempotency_conflict",
            "persistierte Fleet-Receipt bindet nicht den historischen Checkpoint",
        ));
    }
    Ok(())
}

fn apply_asset_transfer(
    state: &mut FleetWorldState,
    command: &AssetTransferCommand,
) -> Result<(), RuntimeError> {
    non_empty(&command.vehicle_id, "vehicleId")?;
    non_empty(&command.from_owner_operator_id, "fromOwnerOperatorId")?;
    non_empty(&command.to_owner_operator_id, "toOwnerOperatorId")?;
    non_empty(&command.from_holder_operator_id, "fromHolderOperatorId")?;
    non_empty(&command.to_holder_operator_id, "toHolderOperatorId")?;
    sha256(&command.transfer_receipt_hash, "transferReceiptHash")?;
    if !state
        .authority_release
        .assets
        .iter()
        .any(|asset| asset.id == command.vehicle_id)
    {
        return Err(invalid(format!(
            "unbekanntes Authority-Asset '{}'",
            command.vehicle_id
        )));
    }
    if state
        .formations
        .values()
        .any(|formation| formation.vehicle_ids.contains(&command.vehicle_id))
    {
        return Err(invalid("Authority-Asset ist in einer Formation gebunden"));
    }
    let current = state
        .asset_holdings
        .get(&command.vehicle_id)
        .ok_or_else(|| invalid("Authority-Asset besitzt keinen Halterzustand"))?;
    if current.owner_operator_id != command.from_owner_operator_id
        || current.holder_operator_id != command.from_holder_operator_id
    {
        return Err(RuntimeError::new(
            "asset_holding_conflict",
            "Eigentuemer oder Halter passt nicht zum autoritativen Zustand",
        ));
    }
    match command.transfer_type {
        AssetTransferType::Sale => {
            if command.from_owner_operator_id == command.to_owner_operator_id
                || command.to_owner_operator_id != command.to_holder_operator_id
                || command.lessor_operator_id.is_some()
                || command.contract_id.is_some()
                || command.valid_until_s.is_some()
                || current.lessor_operator_id.is_some()
            {
                return Err(invalid(
                    "Verkauf besitzt ungueltige Halter- oder Vertragsangaben",
                ));
            }
        }
        AssetTransferType::RentalStart => {
            if command.from_owner_operator_id != command.to_owner_operator_id
                || command.from_holder_operator_id == command.to_holder_operator_id
                || command.lessor_operator_id.as_deref()
                    != Some(command.from_owner_operator_id.as_str())
                || command.contract_id.as_deref().is_none_or(str::is_empty)
                || command
                    .valid_until_s
                    .is_none_or(|until| until <= command.at_s)
                || current.lessor_operator_id.is_some()
            {
                return Err(invalid(
                    "Mietbeginn besitzt ungueltige Halter- oder Vertragsangaben",
                ));
            }
        }
        AssetTransferType::RentalReturn => {
            if current.lessor_operator_id.as_deref() != Some(command.to_holder_operator_id.as_str())
                || command.from_owner_operator_id != command.to_owner_operator_id
                || command.to_holder_operator_id != command.to_owner_operator_id
                || command.lessor_operator_id.is_some()
                || command.contract_id.is_some()
                || command.valid_until_s.is_some()
            {
                return Err(invalid("Mietende passt nicht zum laufenden Halterzustand"));
            }
        }
        AssetTransferType::Reversal => {
            if command.lessor_operator_id.is_some()
                || command.contract_id.is_some()
                || command.valid_until_s.is_some()
            {
                return Err(invalid(
                    "Rueckabwicklung darf keine neue Mietbindung anlegen",
                ));
            }
        }
    }
    if let Some(until) = command.valid_until_s {
        safe_integer(until, "validUntilS")?;
    }
    let history_hash = canonical_hash(&(
        "fleet-asset-holding/v1",
        &command.vehicle_id,
        &current.history_hash,
        command.transfer_type,
        &command.from_owner_operator_id,
        &command.to_owner_operator_id,
        &command.from_holder_operator_id,
        &command.to_holder_operator_id,
        &command.lessor_operator_id,
        &command.contract_id,
        command.valid_until_s,
        command.at_s,
        &command.transfer_receipt_hash,
    ))?;
    state.asset_holdings.insert(
        command.vehicle_id.clone(),
        AssetHolding {
            owner_operator_id: command.to_owner_operator_id.clone(),
            holder_operator_id: command.to_holder_operator_id.clone(),
            lessor_operator_id: command.lessor_operator_id.clone(),
            contract_id: command.contract_id.clone(),
            valid_until_s: command.valid_until_s,
            history_hash,
        },
    );
    Ok(())
}

fn apply_maintenance(
    state: &mut FleetWorldState,
    command: &MaintenanceCommand,
) -> Result<(), RuntimeError> {
    non_empty(&command.formation_id, "formationId")?;
    non_empty(&command.facility_id, "facilityId")?;
    safe_integer(command.starts_at_s, "startsAtS")?;
    safe_integer(command.ends_at_s, "endsAtS")?;
    if command.starts_at_s < command.at_s || command.ends_at_s <= command.starts_at_s {
        return Err(invalid(
            "Werkstattauftrag besitzt kein gueltiges Zeitfenster",
        ));
    }
    if !state.formations.contains_key(&command.formation_id) {
        return Err(invalid(
            "Formation ist im autoritativen Flottenzustand unbekannt",
        ));
    }
    if state.maintenance_assignments.values().any(|assignment| {
        assignment.formation_id != command.formation_id
            && assignment.facility_id == command.facility_id
            && command.starts_at_s < assignment.ends_at_s
            && assignment.starts_at_s < command.ends_at_s
    }) {
        return Err(RuntimeError::new(
            "facility_contention",
            "Werkstatt ist im angefragten Zeitraum bereits belegt",
        ));
    }
    if state
        .maintenance_assignments
        .get(&command.formation_id)
        .is_some_and(|assignment| {
            command.starts_at_s < assignment.ends_at_s && assignment.starts_at_s < command.ends_at_s
        })
    {
        return Err(RuntimeError::new(
            "maintenance_conflict",
            "Formation besitzt bereits einen ueberlappenden Werkstattauftrag",
        ));
    }
    state.maintenance_assignments.insert(
        command.formation_id.clone(),
        MaintenanceAssignment {
            formation_id: command.formation_id.clone(),
            facility_id: command.facility_id.clone(),
            starts_at_s: command.starts_at_s,
            ends_at_s: command.ends_at_s,
        },
    );
    Ok(())
}

fn hydrate_legacy_asset_holdings(state: &mut FleetWorldState) -> Result<(), RuntimeError> {
    if state.authority_release.schema_version == AUTHORITY_RELEASE_SCHEMA_V2 {
        let authority_ids = state
            .authority_release
            .assets
            .iter()
            .map(|asset| asset.id.as_str())
            .collect::<BTreeSet<_>>();
        let holding_ids = state
            .asset_holdings
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>();
        if holding_ids != authority_ids {
            return Err(invalid(
                "Authority-v2-Zustand muss fuer jedes und nur jedes Asset einen Halterzustand bewahren",
            ));
        }
        for holding in state.asset_holdings.values() {
            sha256(&holding.history_hash, "state.assetHoldings[].historyHash")?;
        }
        return Ok(());
    }
    if !state.asset_holdings.is_empty() {
        return Ok(());
    }
    for asset in &state.authority_release.assets {
        state.asset_holdings.insert(
            asset.id.clone(),
            AssetHolding {
                owner_operator_id: asset.operator_id.clone(),
                holder_operator_id: asset.operator_id.clone(),
                lessor_operator_id: None,
                contract_id: None,
                valid_until_s: None,
                history_hash: initial_asset_holding_history_hash(
                    &state.authority_release.release_id,
                    asset,
                )?,
            },
        );
    }
    Ok(())
}

fn validate_persisted_state_relations(state: &FleetWorldState) -> Result<(), RuntimeError> {
    let mut bound_vehicle_ids = BTreeSet::new();
    for formation in state.formations.values() {
        for vehicle_id in &formation.vehicle_ids {
            if !bound_vehicle_ids.insert(vehicle_id) {
                return Err(invalid(
                    "Authority-Asset ist mehreren persistierten Formationen zugeordnet",
                ));
            }
        }
    }

    for (vehicle_id, holding) in &state.asset_holdings {
        non_empty(vehicle_id, "state.assetHoldings[].vehicleId")?;
        non_empty(
            &holding.owner_operator_id,
            "state.assetHoldings[].ownerOperatorId",
        )?;
        non_empty(
            &holding.holder_operator_id,
            "state.assetHoldings[].holderOperatorId",
        )?;
        sha256(&holding.history_hash, "state.assetHoldings[].historyHash")?;
        if let Some(valid_until_s) = holding.valid_until_s {
            safe_integer(valid_until_s, "state.assetHoldings[].validUntilS")?;
        }
        match (
            holding.lessor_operator_id.as_deref(),
            holding.contract_id.as_deref(),
            holding.valid_until_s,
        ) {
            (None, None, None) => {}
            (Some(lessor), Some(contract_id), Some(_)) => {
                non_empty(lessor, "state.assetHoldings[].lessorOperatorId")?;
                non_empty(contract_id, "state.assetHoldings[].contractId")?;
                if lessor != holding.owner_operator_id
                    || holding.holder_operator_id == holding.owner_operator_id
                {
                    return Err(invalid(
                        "persistierte Mietbindung besitzt widerspruechliche Eigentuemer- oder Halterdaten",
                    ));
                }
            }
            _ => {
                return Err(invalid("persistierte Mietbindung ist unvollstaendig"));
            }
        }
    }

    for (formation_id, assignment) in &state.maintenance_assignments {
        if formation_id != &assignment.formation_id || !state.formations.contains_key(formation_id)
        {
            return Err(invalid(
                "Instandhaltungsauftrag stimmt nicht mit seiner Formation oder seinem Zustandsschluessel ueberein",
            ));
        }
        non_empty(
            &assignment.facility_id,
            "state.maintenanceAssignments[].facilityId",
        )?;
        safe_integer(
            assignment.starts_at_s,
            "state.maintenanceAssignments[].startsAtS",
        )?;
        safe_integer(
            assignment.ends_at_s,
            "state.maintenanceAssignments[].endsAtS",
        )?;
        if assignment.ends_at_s <= assignment.starts_at_s {
            return Err(invalid(
                "persistierter Instandhaltungsauftrag besitzt kein gueltiges Zeitfenster",
            ));
        }
    }
    let assignments = state.maintenance_assignments.values().collect::<Vec<_>>();
    for (index, left) in assignments.iter().enumerate() {
        if assignments.iter().skip(index + 1).any(|right| {
            left.facility_id == right.facility_id
                && left.starts_at_s < right.ends_at_s
                && right.starts_at_s < left.ends_at_s
        }) {
            return Err(invalid(
                "persistierte Instandhaltungsauftraege belegen dieselbe Werkstatt ueberlappend",
            ));
        }
    }
    Ok(())
}

fn verify_world_state(
    mut state: FleetWorldState,
    expected_state_hash: &str,
) -> Result<FleetWorldStateVerification, RuntimeError> {
    sha256(expected_state_hash, "expectedStateHash")?;
    let actual_state_hash = state_hash(&state)?;
    if actual_state_hash != expected_state_hash {
        return Err(RuntimeError::new(
            "state_hash_mismatch",
            "persistierter Flottenzustand passt nicht zum erwarteten Hash",
        ));
    }
    hydrate_legacy_asset_holdings(&mut state)?;
    validate_persisted_state_relations(&state)?;
    let snapshot = snapshot(&state)?;
    let actual_snapshot_hash = snapshot_hash(&snapshot)?;
    Ok(FleetWorldStateVerification {
        schema_version: FLEET_STATE_VERIFICATION_SCHEMA,
        world_id: state.world_id,
        revision: state.revision,
        produced_at: state.produced_at,
        authority_release_hash: state.authority_release_hash,
        state_hash: actual_state_hash,
        snapshot_hash: actual_snapshot_hash,
    })
}

fn apply(
    mut state: FleetWorldState,
    mut command: FleetCommand,
    replay_receipt: Option<FleetCommandReceipt>,
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
    command.normalize_for_authority(
        state.authority_release.schema_version == AUTHORITY_RELEASE_SCHEMA_V2,
    );
    non_empty(command.command_id(), "commandId")?;
    non_empty(command.entity_id(), "entityId")?;
    safe_integer(command.expected_revision(), "expectedRevision")?;
    safe_integer(command.at_s(), "atS")?;
    let canonical_command_json = canonical_json(&command)?;
    let command_hash = canonical_hash(&command)?;
    if let Some(receipt) = replay_receipt {
        validate_replay_receipt(
            &state,
            &command,
            &command_hash,
            &canonical_command_json,
            &receipt,
        )?;
        return command_result(state, &command, receipt, true);
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
    state.produced_at = command.at_s();
    hydrate_legacy_asset_holdings(&mut state)?;
    match &command {
        FleetCommand::Formation(command) => {
            let mut intent = FormationIntent {
                id: command.formation_id.clone(),
                vehicle_ids: command.vehicle_ids.clone(),
                path_receipt_id: command.path_receipt_id.clone(),
                dynamics: command.dynamics,
            };
            if state.formations.values().any(|existing| {
                existing.id != intent.id
                    && existing
                        .vehicle_ids
                        .iter()
                        .any(|vehicle| intent.vehicle_ids.contains(vehicle))
            }) {
                return Err(invalid(
                    "Authority-Asset ist bereits einer anderen Formation zugeordnet",
                ));
            }
            let materialized = materialize_formation(&state, &intent)?;
            if state.authority_release.schema_version == AUTHORITY_RELEASE_SCHEMA_V2 {
                intent.dynamics = materialized.authoritative_dynamics;
            }
            state.formations.insert(intent.id.clone(), intent);
        }
        FleetCommand::PersonnelDuty(command) => {
            let intent = PersonnelDutyIntent {
                id: command.personnel_duty_id.clone(),
                personnel_pool_id: command.personnel_pool_id.clone(),
                formation_ids: command.formation_ids.clone(),
                path_receipt_id: command.path_receipt_id.clone(),
                valid_from: command.valid_from,
                valid_until: command.valid_until,
            };
            materialize_duty(&state, &intent)?;
            state.personnel_duties.insert(intent.id.clone(), intent);
        }
        FleetCommand::PathReservation(command) => {
            let intent = PathReservationIntent {
                id: command.path_reservation_id.clone(),
                path_receipt_id: command.path_receipt_id.clone(),
            };
            materialize_path(&state, &intent)?;
            state.path_reservations.insert(intent.id.clone(), intent);
        }
        FleetCommand::AssetTransfer(command) => apply_asset_transfer(&mut state, command)?,
        FleetCommand::Maintenance(command) => apply_maintenance(&mut state, command)?,
    }
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or_else(|| RuntimeError::new("revision_overflow", "Flottenrevision ist erschoepft"))?;
    let snapshot = snapshot(&state)?;
    let resulting_state_hash = state_hash(&state)?;
    let resulting_snapshot_hash = snapshot_hash(&snapshot)?;
    let receipt = FleetCommandReceipt {
        schema_version: FLEET_RECEIPT_SCHEMA.to_owned(),
        world_id: state.world_id.clone(),
        command_id: command.command_id().to_owned(),
        command_hash,
        canonical_command_json,
        resulting_revision: state.revision,
        entity_kind: command.entity_kind().to_owned(),
        entity_id: command.entity_id().to_owned(),
        resulting_state_hash,
        resulting_snapshot_hash,
    };
    command_result(state, &command, receipt, false)
}

/// Initialisiert einen weltgebundenen M5-Zustand aus eingefrorenen Quellen.
pub fn initialize_fleet_world(input_json: &str) -> Result<String, RuntimeError> {
    to_json(&initialized(parse_json(input_json)?)?)
}

/// Revalidiert einen persistierten M5-Checkpoint samt eingebettetem Release,
/// allen Intent-Beziehungen und seinem erwarteten Zustandshash.
pub fn verify_fleet_world_state(
    state_json: &str,
    expected_state_hash: &str,
) -> Result<String, RuntimeError> {
    let state: FleetWorldState = parse_json(state_json)?;
    to_json(&verify_world_state(state, expected_state_hash)?)
}

/// Wendet ein Intent-Kommando an; eine persistierte Receipt autorisiert Replay.
pub fn apply_fleet_command(
    state_json: &str,
    command_json: &str,
    replay_receipt_json: Option<&str>,
) -> Result<String, RuntimeError> {
    let state: FleetWorldState = parse_json(state_json)?;
    let command = parse_command(command_json)?;
    let receipt = replay_receipt_json.map(parse_json).transpose()?;
    to_json(&apply(state, command, receipt)?)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{
        FleetWorldState, FormationIntent, MAX_SAFE_JSON_INTEGER, apply_fleet_command,
        canonical_hash, canonical_json, initialize_fleet_world, materialize_formation,
        maximum_speed_mmps_floor, parse_command, state_hash, technical_data,
        verify_fleet_world_state,
    };

    const WORLD: &str = "11111111-1111-4111-8111-111111111111";

    fn authority_release() -> Value {
        json!({
            "schemaVersion": "zugfolge-fleet-authority-release/v1",
            "releaseId": "synthetic-m5-authority-v1",
            "referenceYear": 2026,
            "assets": [
                {
                    "id": "vehicle-1", "numericId": 1, "operatorId": "operator-1",
                    "vehicleTypeId": 101, "classDesignation": "ET1", "tradeName": "Testzug",
                    "buildYear": 2024, "acquisitionYear": 2025, "procurementChannel": "leasing",
                    "approvedLineIds": ["S1"],
                    "maintenanceDeadlines": [{"kind": "inspection", "dueAt": 1000}],
                    "installedProtection": ["pzb"],
                    "technical": {"lengthMm": 70000, "massKg": 120000, "maximumSpeedKph": 160, "accelerationMmPerS2": 800, "decelerationMmPerS2": 900, "traction": "electric", "electricSystems": ["ac15kv"]},
                    "passenger": {"seats": 120, "firstClassSeats": 12, "accessible": true, "bicyclePlaces": 8, "wheelchairPlaces": 2, "equipment": ["pis"], "operatingCostCentsPerTrainKm": 700, "replacementPlan": true},
                    "deliveredAt": 0, "retiredAt": 1000
                },
                {
                    "id": "vehicle-2", "numericId": 3, "operatorId": "operator-1",
                    "vehicleTypeId": 101, "classDesignation": "ET1", "tradeName": "Testzug 2",
                    "buildYear": 2024, "acquisitionYear": 2025, "procurementChannel": "new-build",
                    "approvedLineIds": ["S1"],
                    "maintenanceDeadlines": [{"kind": "inspection", "dueAt": 1000}],
                    "installedProtection": ["pzb"],
                    "technical": {"lengthMm": 70000, "massKg": 120000, "maximumSpeedKph": 160, "accelerationMmPerS2": 800, "decelerationMmPerS2": 900, "traction": "electric", "electricSystems": ["ac15kv"]},
                    "passenger": {"seats": 120, "firstClassSeats": 12, "accessible": true, "bicyclePlaces": 8, "wheelchairPlaces": 2, "equipment": ["pis"], "operatingCostCentsPerTrainKm": 700, "replacementPlan": true},
                    "deliveredAt": 0, "retiredAt": 1000
                },
                {
                    "id": "vehicle-diesel", "numericId": 2, "operatorId": "operator-1",
                    "vehicleTypeId": 102, "classDesignation": "VT1", "tradeName": "Dieseltestzug",
                    "buildYear": 2023, "acquisitionYear": 2025, "procurementChannel": "used",
                    "approvedLineIds": ["S1"],
                    "maintenanceDeadlines": [{"kind": "inspection", "dueAt": 1000}],
                    "installedProtection": ["pzb"],
                    "technical": {"lengthMm": 50000, "massKg": 80000, "maximumSpeedKph": 140, "accelerationMmPerS2": 600, "decelerationMmPerS2": 800, "traction": "diesel", "electricSystems": []},
                    "passenger": {"seats": 80, "firstClassSeats": 0, "accessible": true, "bicyclePlaces": 4, "wheelchairPlaces": 1, "equipment": ["pis"], "operatingCostCentsPerTrainKm": 900, "replacementPlan": true},
                    "deliveredAt": 0, "retiredAt": 1000
                }
            ],
            "personnelPools": [{
                "id": "pool-1", "numericId": 1, "operatorId": "operator-1",
                "capacitySeconds": 500, "minimumRestSeconds": 10,
                "classDesignations": ["ET1"], "pathReceiptIds": ["path-confirmed"],
                "qualificationHash": "a".repeat(64)
            }],
            "pathReceipts": [
                {"id": "path-confirmed", "numericRouteId": 1, "operatorId": "operator-1", "serviceLineIds": ["S1"], "decision": "confirmed", "validFrom": 0, "validUntil": 1000, "platformLengthsMm": [150000], "electrifications": ["overhead-ac15kv"], "requiredProtection": ["pzb"], "approvedClasses": ["ET1"], "plannerStateHash": "b".repeat(64), "conflictCheckHash": "c".repeat(64)},
                {"id": "path-requested", "numericRouteId": 2, "operatorId": "operator-1", "serviceLineIds": ["S1"], "decision": "requested", "validFrom": 0, "validUntil": 1000, "platformLengthsMm": [150000], "electrifications": ["overhead-ac15kv"], "requiredProtection": ["pzb"], "approvedClasses": ["ET1"], "plannerStateHash": "d".repeat(64), "conflictCheckHash": "e".repeat(64)},
                {"id": "path-foreign", "numericRouteId": 3, "operatorId": "operator-2", "serviceLineIds": ["S1"], "decision": "confirmed", "validFrom": 0, "validUntil": 1000, "platformLengthsMm": [150000], "electrifications": ["overhead-ac15kv"], "requiredProtection": ["pzb"], "approvedClasses": ["ET1"], "plannerStateHash": "f".repeat(64), "conflictCheckHash": "1".repeat(64)}
            ]
        })
    }

    fn authority_release_v2() -> Value {
        let mut release = authority_release();
        release["schemaVersion"] = json!("zugfolge-fleet-authority-release/v2");
        release["releaseId"] = json!("synthetic-m5-authority-v2");
        release["economyReleaseId"] = json!("synthetic-economy-v1");
        release["economyReleaseSha256"] = json!("2".repeat(64));
        for asset in release["assets"]
            .as_array_mut()
            .expect("synthetischer Release besitzt Assets")
        {
            let maximum_speed_kph = u16::try_from(
                asset["technical"]["maximumSpeedKph"]
                    .as_u64()
                    .expect("synthetisches Asset besitzt Vmax"),
            )
            .expect("synthetische Vmax passt in u16");
            asset["technical"]["maximumSpeedMmps"] =
                json!(maximum_speed_mmps_floor(maximum_speed_kph));
            asset["technical"]["role"] = json!("powered-unit");
            asset["technical"]["controlStands"] = json!({"front": true, "rear": true});
            asset["technical"]["continuousPowerKw"] = json!(3_000);
            asset["technical"]["startingTractiveEffortKn"] = json!(200);
            asset["technical"]["brakeWeightKg"] = asset["technical"]["massKg"].clone();
            asset["technical"]["maximumAccelerationCapMmps2"] =
                asset["technical"]["accelerationMmPerS2"].clone();
            asset["technical"]["serviceBrakeCapMmps2"] =
                asset["technical"]["decelerationMmPerS2"].clone();
            asset["technical"]["emergencyBrakeMultiplierBasisPoints"] = json!(15_000);
            asset["orientation"] = json!("along");
            asset["condition"] = json!({
                "mechanicsBasisPoints": 10_000,
                "driveBasisPoints": 10_000,
                "brakesBasisPoints": 10_000,
                "kilometresSinceMaintenance": 0,
                "operatingHoursSinceMaintenance": 0,
                "openObservations": 0
            });
            asset["restrictions"] = json!({});
            asset["history"] = json!([]);
        }
        release
    }

    fn initialize() -> Value {
        serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": authority_release()
                })
                .to_string(),
            )
            .expect("Flottenwelt wird initialisiert"),
        )
        .expect("gueltiges Initialisierungsergebnis")
    }

    fn formation_command(initial: &Value, command_id: &str) -> Value {
        json!({
            "schemaVersion": "zugfolge-fleet-form-vehicles-command/v2",
            "worldId": WORLD,
            "commandId": command_id,
            "expectedStateHash": initial["stateHash"],
            "expectedRevision": initial["state"]["revision"],
            "atS": 11,
            "formationId": "formation-1",
            "vehicleIds": ["vehicle-1"],
            "pathReceiptId": "path-confirmed"
        })
    }

    fn apply(state: &Value, command: &Value, receipt: Option<&Value>) -> Value {
        let receipt_json = receipt.map(Value::to_string);
        serde_json::from_str(
            &apply_fleet_command(
                &state.to_string(),
                &command.to_string(),
                receipt_json.as_deref(),
            )
            .expect("Flottenkommando gelingt"),
        )
        .expect("gueltiges Kommandoergebnis")
    }

    #[test]
    fn m5_konfiguration_kommt_vom_compiler_und_bleibt_nach_formation_und_restore_gepinnt() {
        use zugfolge_fleet::release_catalog::{
            compile_vehicle_catalog, parse_source_catalog, parse_world_seed,
        };
        let source = parse_source_catalog(include_str!(
            "../../zugfolge-fleet/tests/fixtures/vehicle-catalog-source-v2-interior.json"
        ))
        .unwrap();
        let seed = parse_world_seed(include_str!(
            "../../zugfolge-fleet/tests/fixtures/vehicle-world-seed-v3-interior.json"
        ))
        .unwrap();
        let compilation = compile_vehicle_catalog(&source, &seed).unwrap();
        let initialization = json!({
            "schemaVersion": "zugfolge-fleet-world-initialize/v2",
            "worldId": seed.world_id, "producedAt": seed.produced_at,
            "authorityRelease": compilation.fleet_authority
        });
        let initialized: Value =
            serde_json::from_str(&initialize_fleet_world(&initialization.to_string()).unwrap())
                .unwrap();
        // Öffentlicher Compiler-v2-Typ und privater Runtime-Typ müssen denselben
        // kompakten Authority-Hash liefern, damit nachgelagerte Projektionen pinnen.
        assert_eq!(
            initialized["state"]["authorityReleaseHash"],
            super::sha256_json(&compilation.fleet_authority).unwrap()
        );
        for asset in &compilation.fleet_authority.assets {
            let actual = initialized["state"]["authorityRelease"]["assets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|value| value["id"] == asset.id)
                .unwrap();
            assert_eq!(
                actual["vehicleConfiguration"],
                serde_json::to_value(&asset.vehicle_configuration).unwrap()
            );
        }
        let command = json!({
            "schemaVersion": "zugfolge-fleet-form-vehicles-command/v2",
            "worldId": seed.world_id, "commandId": "fixture-interior-formation-command",
            "expectedStateHash": initialized["stateHash"], "expectedRevision": 0,
            "atS": seed.produced_at + 1, "formationId": "fixture-interior-formation-1",
            "vehicleIds": ["fixture-interior-vehicle-1"], "pathReceiptId": "fixture-path-1"
        });
        let formed = apply(&initialized["state"], &command, None);
        assert_eq!(
            formed["state"]["authorityRelease"],
            initialized["state"]["authorityRelease"]
        );
        assert_eq!(
            formed["snapshot"]["formations"][0]["characteristics"]["seats"],
            120
        );
        let verified: Value = serde_json::from_str(
            &verify_fleet_world_state(
                &formed["state"].to_string(),
                formed["stateHash"].as_str().unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(verified["stateHash"], formed["stateHash"]);
        assert_eq!(verified["snapshotHash"], formed["snapshotHash"]);
        let mut tampered = formed["state"].clone();
        tampered["authorityRelease"]["assets"][0]["vehicleConfiguration"]["interior"]["toilets"] =
            json!(3);
        assert!(
            verify_fleet_world_state(&tampered.to_string(), formed["stateHash"].as_str().unwrap())
                .is_err()
        );
        let resealed: FleetWorldState = serde_json::from_value(tampered).unwrap();
        assert!(
            verify_fleet_world_state(
                &serde_json::to_string(&resealed).unwrap(),
                &state_hash(&resealed).unwrap()
            )
            .is_err()
        );
    }

    #[test]
    fn m5_konfiguration_wird_auch_an_der_native_grenze_fachlich_revalidiert() {
        let mut config: Value = serde_json::from_str(include_str!(
            "../../zugfolge-fleet/tests/fixtures/vehicle-world-seed-v3-interior.json"
        ))
        .unwrap();
        let mut valid = config["assets"][0]["vehicleConfiguration"].take();
        valid["interior"]["firstClassSeats"] = json!(12);
        valid["interior"]["secondClassSeats"] = json!(108);
        valid["interior"]["multipurpose"]["bicycles"] = json!(8);
        valid["interior"]["amenities"] = json!(["passenger_information"]);
        for (pointer, value) in [
            ("/structural/bodyLengthMm", json!(1)),
            ("/structural/doorCountPerSide", json!(0)),
            ("/interior/secondClassSeats", json!(109)),
            ("/interior/multipurpose/wheelchairs", json!(3)),
            ("/interior/accessibleToilets", json!(3)),
            ("/interior/amenities", json!(["wifi", "wifi"])),
        ] {
            let mut release = authority_release_v2();
            let mut invalid_config = valid.clone();
            *invalid_config.pointer_mut(pointer).unwrap() = value;
            release["assets"][0]["vehicleConfiguration"] = invalid_config;
            let error = initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD, "producedAt": 10, "authorityRelease": release
                })
                .to_string(),
            )
            .unwrap_err();
            assert!(
                error.to_string().contains("M5-Fahrzeugkonfiguration"),
                "{pointer}: {error}"
            );
        }
    }

    #[test]
    fn fleet_authority_v1_bleibt_ohne_v2_felder_und_mit_legacy_vmax_gueltig() {
        let initialized = initialize();
        assert_eq!(
            initialized["state"]["authorityRelease"]["schemaVersion"],
            "zugfolge-fleet-authority-release/v1"
        );
        assert!(
            initialized["state"]["authorityRelease"]
                .get("economyReleaseId")
                .is_none()
        );
        assert!(
            initialized["state"]["authorityRelease"]["assets"][0]["technical"]
                .get("maximumSpeedMmps")
                .is_none()
        );
        assert!(
            initialized["state"]["authorityRelease"]["assets"][0]["technical"]
                .get("role")
                .is_none()
        );
        assert!(
            initialized["state"]["authorityRelease"]["assets"][0]["technical"]
                .get("controlStands")
                .is_none()
        );
        assert!(
            initialized["state"]["authorityRelease"]["assets"][0]
                .get("orientation")
                .is_none()
        );
        let state: FleetWorldState =
            serde_json::from_value(initialized["state"].clone()).expect("v1-Zustand bleibt lesbar");
        assert_eq!(
            technical_data(&state.authority_release.assets[0], false)
                .expect("v1-Technik wird abgeleitet")
                .max_speed
                .millimetres_per_second(),
            44_445
        );

        let mut battery = authority_release();
        battery["assets"][0]["technical"]["traction"] = json!("battery");
        battery["assets"][0]["technical"]["electricSystems"] = json!([]);
        let battery: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": battery
                })
                .to_string(),
            )
            .expect("v1-Batterie ohne Netzsystem bleibt rueckwaertskompatibel"),
        )
        .expect("gueltiges v1-Batterie-Ergebnis");
        let result = apply(
            &battery["state"],
            &formation_command(&battery, "formation:v1-battery"),
            None,
        );
        assert_eq!(
            result["snapshot"]["formations"][0]["characteristics"]["traction"],
            "battery"
        );
    }

    #[test]
    fn fleet_authority_v2_nutzt_floor_mmps_und_zeigt_volle_kmh_an() {
        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": authority_release_v2()
                })
                .to_string(),
            )
            .expect("v2-Authority-Release wird initialisiert"),
        )
        .expect("gueltiges v2-Initialisierungsergebnis");
        assert_eq!(
            initialized["state"]["authorityRelease"]["economyReleaseId"],
            "synthetic-economy-v1"
        );
        let state: FleetWorldState =
            serde_json::from_value(initialized["state"].clone()).expect("v2-Zustand ist lesbar");
        assert_eq!(
            technical_data(&state.authority_release.assets[0], true)
                .expect("v2-Technik wird abgeleitet")
                .max_speed
                .millimetres_per_second(),
            44_444
        );

        let result = apply(
            &initialized["state"],
            &formation_command(&initialized, "formation:v2-speed"),
            None,
        );
        assert_eq!(
            result["snapshot"]["formations"][0]["characteristics"]["maximumSpeedKph"],
            160
        );
    }

    #[test]
    fn fleet_authority_v2_verlangt_economy_bindung_und_exakte_floor_vmax() {
        let initialize_error = |release: Value| {
            initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect_err("ungueltiger v2-Release muss scheitern")
            .to_string()
        };

        let mut missing_economy_id = authority_release_v2();
        missing_economy_id
            .as_object_mut()
            .expect("Release ist ein Objekt")
            .remove("economyReleaseId");
        assert!(initialize_error(missing_economy_id).contains("EconomyRelease-ID"));

        let mut missing_economy_sha = authority_release_v2();
        missing_economy_sha
            .as_object_mut()
            .expect("Release ist ein Objekt")
            .remove("economyReleaseSha256");
        assert!(initialize_error(missing_economy_sha).contains("EconomyRelease-SHA-256"));

        let mut invalid_economy_sha = authority_release_v2();
        invalid_economy_sha["economyReleaseSha256"] = json!("A".repeat(64));
        assert!(initialize_error(invalid_economy_sha).contains("kein SHA-256"));

        let mut missing_mmps = authority_release_v2();
        missing_mmps["assets"][0]["technical"]
            .as_object_mut()
            .expect("Technik ist ein Objekt")
            .remove("maximumSpeedMmps");
        assert!(initialize_error(missing_mmps).contains("maximumSpeedMmps"));

        let mut rounded_up_mmps = authority_release_v2();
        rounded_up_mmps["assets"][0]["technical"]["maximumSpeedMmps"] = json!(44_445);
        assert!(initialize_error(rounded_up_mmps).contains("maximumSpeedMmps"));

        let mut missing_role = authority_release_v2();
        missing_role["assets"][0]["technical"]
            .as_object_mut()
            .expect("Technik ist ein Objekt")
            .remove("role");
        assert!(initialize_error(missing_role).contains("Fahrzeugrolle"));

        let mut missing_control_stands = authority_release_v2();
        missing_control_stands["assets"][0]["technical"]
            .as_object_mut()
            .expect("Technik ist ein Objekt")
            .remove("controlStands");
        assert!(initialize_error(missing_control_stands).contains("Fuehrerstaende"));

        let mut missing_orientation = authority_release_v2();
        missing_orientation["assets"][0]
            .as_object_mut()
            .expect("Asset ist ein Objekt")
            .remove("orientation");
        assert!(initialize_error(missing_orientation).contains("orientation"));
    }

    #[test]
    fn fleet_v2_bewahrt_nichtlexikographische_reihung_von_spitze_bis_schluss() {
        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": authority_release_v2()
                })
                .to_string(),
            )
            .expect("v2-Authority-Release wird initialisiert"),
        )
        .expect("gueltige v2-Flottenwelt");
        let mut command = formation_command(&initialized, "formation:v2-order");
        command["vehicleIds"] = json!(["vehicle-2", "vehicle-1"]);

        let result = apply(&initialized["state"], &command, None);
        assert_eq!(
            result["state"]["formations"]["formation-1"]["vehicleIds"],
            json!(["vehicle-2", "vehicle-1"])
        );
        assert_eq!(
            result["snapshot"]["formations"][0]["vehicleIds"],
            json!(["vehicle-2", "vehicle-1"])
        );
        assert!(
            result["commandReceipt"]["canonicalCommandJson"]
                .as_str()
                .expect("Receipt besitzt kanonisches Kommando")
                .contains("\"vehicleIds\":[\"vehicle-2\",\"vehicle-1\"]")
        );
    }

    #[test]
    fn fleet_v2_lehnt_fuehrenden_reisezugwagen_vor_lokomotive_ab() {
        let mut release = authority_release_v2();
        let leading = &mut release["assets"][0];
        leading["technical"]["traction"] = json!("unpowered");
        leading["technical"]["electricSystems"] = json!([]);
        leading["technical"]["accelerationMmPerS2"] = json!(0);
        leading["technical"]["decelerationMmPerS2"] = json!(0);
        leading["technical"]["continuousPowerKw"] = json!(0);
        leading["technical"]["startingTractiveEffortKn"] = json!(0);
        leading["technical"]["maximumAccelerationCapMmps2"] = json!(0);
        leading["technical"]["role"] = json!("coach");
        leading["technical"]["controlStands"] = json!({"front": false, "rear": false});
        leading["installedProtection"] = json!([]);
        release["assets"][1]["technical"]["role"] = json!("locomotive");

        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect("v2-Lok-Wagen-Release wird initialisiert"),
        )
        .expect("gueltige v2-Flottenwelt");
        let mut command = formation_command(&initialized, "formation:leading-coach");
        command["vehicleIds"] = json!(["vehicle-1", "vehicle-2"]);

        let error = apply_fleet_command(
            &initialized["state"].to_string(),
            &command.to_string(),
            None,
        )
        .expect_err("fahrfaehige v2-Formation braucht Fuehrerstand an der Spitze");
        assert!(error.to_string().contains("MissingLeadingControlStand"));
    }

    #[test]
    fn fleet_v2_wertet_gegenorientierten_steuerwagen_am_zugschluss_physisch_aus() {
        let mut release = authority_release_v2();
        release["assets"][0]["technical"]["role"] = json!("locomotive");
        release["assets"][0]["technical"]["controlStands"] = json!({"front": true, "rear": false});
        let control_car = &mut release["assets"][1];
        control_car["technical"]["traction"] = json!("unpowered");
        control_car["technical"]["electricSystems"] = json!([]);
        control_car["technical"]["accelerationMmPerS2"] = json!(0);
        control_car["technical"]["decelerationMmPerS2"] = json!(0);
        control_car["technical"]["continuousPowerKw"] = json!(0);
        control_car["technical"]["startingTractiveEffortKn"] = json!(0);
        control_car["technical"]["maximumAccelerationCapMmps2"] = json!(0);
        control_car["technical"]["role"] = json!("control-car");
        control_car["technical"]["controlStands"] = json!({"front": true, "rear": false});
        control_car["orientation"] = json!("against");

        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect("v2-Wendezug-Release wird initialisiert"),
        )
        .expect("gueltige v2-Flottenwelt");
        let state: FleetWorldState =
            serde_json::from_value(initialized["state"].clone()).expect("v2-Zustand ist lesbar");
        let materialized = materialize_formation(
            &state,
            &FormationIntent {
                id: "formation:against-control-car".to_owned(),
                vehicle_ids: vec!["vehicle-1".to_owned(), "vehicle-2".to_owned()],
                path_receipt_id: "path-confirmed".to_owned(),
                dynamics: None,
            },
        )
        .expect("gegenorientierter Steuerwagen ist ein gueltiger Wendezugschluss");
        assert!(materialized.formation.has_front_control_stand());
        assert!(materialized.formation.has_rear_control_stand());
        assert!(materialized.formation.supports_direct_reversal());
    }

    #[test]
    fn fleet_authority_v2_validiert_elektrische_systeme_nach_traktion() {
        let initialize_result = |release: Value| {
            initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
        };

        let mut battery = authority_release_v2();
        battery["assets"][0]["technical"]["traction"] = json!("battery");
        initialize_result(battery).expect("v2-Batterie mit elektrischem System ist gueltig");

        let mut battery_without_system = authority_release_v2();
        battery_without_system["assets"][0]["technical"]["traction"] = json!("battery");
        battery_without_system["assets"][0]["technical"]["electricSystems"] = json!([]);
        assert!(
            initialize_result(battery_without_system)
                .expect_err("v2-Batterie braucht ein elektrisches System")
                .to_string()
                .contains("elektrische Systeme")
        );

        let mut electric_without_system = authority_release_v2();
        electric_without_system["assets"][0]["technical"]["electricSystems"] = json!([]);
        assert!(
            initialize_result(electric_without_system)
                .expect_err("E-Traktion braucht ein elektrisches System")
                .to_string()
                .contains("elektrische Systeme")
        );

        let mut diesel_with_system = authority_release_v2();
        diesel_with_system["assets"][2]["technical"]["electricSystems"] = json!(["ac15kv"]);
        assert!(
            initialize_result(diesel_with_system)
                .expect_err("Diesel darf kein elektrisches System tragen")
                .to_string()
                .contains("elektrische Systeme")
        );

        let mut unpowered_with_system = authority_release_v2();
        let technical = &mut unpowered_with_system["assets"][2]["technical"];
        technical["traction"] = json!("unpowered");
        technical["electricSystems"] = json!(["ac15kv"]);
        technical["accelerationMmPerS2"] = json!(0);
        technical["decelerationMmPerS2"] = json!(0);
        technical["continuousPowerKw"] = json!(0);
        technical["startingTractiveEffortKn"] = json!(0);
        technical["maximumAccelerationCapMmps2"] = json!(0);
        technical["role"] = json!("coach");
        technical["controlStands"] = json!({"front": false, "rear": false});
        assert!(
            initialize_result(unpowered_with_system)
                .expect_err("unpowered Asset darf kein elektrisches System tragen")
                .to_string()
                .contains("elektrische Systeme")
        );
    }

    #[test]
    fn fleet_authority_v2_batterie_prueft_systeme_bis_zur_strecke() {
        let initialize_release = |release: Value| -> Value {
            serde_json::from_str(
                &initialize_fleet_world(
                    &json!({
                        "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                        "worldId": WORLD,
                        "producedAt": 10,
                        "authorityRelease": release
                    })
                    .to_string(),
                )
                .expect("v2-Batterie-Release wird initialisiert"),
            )
            .expect("gueltiges Initialisierungsergebnis")
        };

        let mut compatible = authority_release_v2();
        compatible["assets"][0]["technical"]["traction"] = json!("battery");
        compatible["pathReceipts"][0]["electrifications"] =
            json!(["unelectrified", "overhead-ac15kv"]);
        let compatible = initialize_release(compatible);
        let result = apply(
            &compatible["state"],
            &formation_command(&compatible, "formation:battery-compatible"),
            None,
        );
        assert_eq!(
            result["snapshot"]["formations"][0]["characteristics"]["traction"],
            "battery"
        );

        let mut incompatible = authority_release_v2();
        incompatible["assets"][0]["technical"]["traction"] = json!("battery");
        incompatible["pathReceipts"][0]["electrifications"] = json!(["overhead-ac25kv"]);
        let incompatible = initialize_release(incompatible);
        let command = formation_command(&incompatible, "formation:battery-incompatible");
        let error = apply_fleet_command(
            &incompatible["state"].to_string(),
            &command.to_string(),
            None,
        )
        .expect_err("AC15-Batterie darf nicht unter AC25 als kompatibel gelten");
        assert!(error.to_string().contains("IncompatibleElectrification"));
    }

    #[test]
    fn fleet_authority_v2_verlangt_vollstaendige_typisierte_restriktionen() {
        let mut release = authority_release_v2();
        release["assets"][0]
            .as_object_mut()
            .expect("Asset ist ein Objekt")
            .remove("restrictions");
        let error = initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": WORLD,
                "producedAt": 10,
                "authorityRelease": release
            })
            .to_string(),
        )
        .expect_err("Authority-v2 ohne restrictions muss fail-closed scheitern");
        assert!(error.to_string().contains("restrictions"));
    }

    #[test]
    fn fleet_authority_v2_restriktionen_und_beschaffungsjahr_sind_fail_closed() {
        let initialize_error = |release: Value| {
            initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect_err("ungueltiger v2-Vertrag muss scheitern")
            .to_string()
        };

        for restriction in [
            json!({"invalid": {"power-basis-points": 0}}),
            json!({"invalid": {"power-basis-points": 10_001}}),
            json!({"invalid": {"maximum-speed": 0}}),
            json!({"invalid": {"service-brake": 0}}),
            json!({"invalid": {"emergency-brake": 0}}),
            json!({"invalid": {"door-availability-basis-points": 10_001}}),
        ] {
            let mut release = authority_release_v2();
            release["assets"][0]["restrictions"] = restriction;
            let _error = initialize_error(release);
        }

        let mut unknown = authority_release_v2();
        unknown["assets"][0]["restrictions"] = json!({"invalid": {"unknown-effect": 1}});
        assert!(initialize_error(unknown).contains("invalid_json"));

        let mut future_acquisition = authority_release_v2();
        future_acquisition["assets"][0]["acquisitionYear"] = json!(2027);
        assert!(initialize_error(future_acquisition).contains("Jahre"));
    }

    #[test]
    fn fleet_authority_v2_prueft_auch_unformierte_assets_am_stichtag() {
        let initialize_error = |release: Value| {
            initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect_err("nicht verfuegbares unformiertes Asset muss scheitern")
            .to_string()
        };

        let mut not_delivered = authority_release_v2();
        not_delivered["assets"][2]["deliveredAt"] = json!(11);
        assert!(initialize_error(not_delivered).contains("Initialisierungsstichtag"));

        let mut retired = authority_release_v2();
        retired["assets"][2]["retiredAt"] = json!(10);
        assert!(initialize_error(retired).contains("Initialisierungsstichtag"));

        let mut overdue = authority_release_v2();
        overdue["assets"][2]["maintenanceDeadlines"][0]["dueAt"] = json!(10);
        assert!(initialize_error(overdue).contains("Initialisierungsstichtag"));
    }

    #[test]
    fn fleet_authority_v2_wertet_restriktionen_assetlokal_aus() {
        let mut release = authority_release_v2();
        release["assets"][0]["restrictions"] = json!({
            "doors": {"door-availability-basis-points": 1000},
            "emergency": {"emergency-brake": 1000},
            "third-power": {"power-basis-points": 3333},
            "service": {"service-brake": 600},
            "speed": {"maximum-speed": 30000}
        });
        release["assets"][0]["technical"]["continuousPowerKw"] = json!(3000);
        release["assets"][1]["restrictions"] = json!({"immobilized": "immobilized"});
        release["assets"][1]["technical"]["continuousPowerKw"] = json!(3000);
        release["assets"][2]["restrictions"] = json!({});
        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect("typisierte v2-Restriktionen werden akzeptiert"),
        )
        .expect("gueltige initialisierte Restriktionswelt");
        let state: FleetWorldState =
            serde_json::from_value(initialized["state"].clone()).expect("v2-Zustand ist lesbar");
        let materialized = materialize_formation(
            &state,
            &FormationIntent {
                id: "formation:restricted".to_owned(),
                vehicle_ids: vec!["vehicle-1".to_owned(), "vehicle-2".to_owned()],
                path_receipt_id: "path-confirmed".to_owned(),
                dynamics: None,
            },
        )
        .expect("ein gesunder Antrieb haelt die Formation mobil");
        let characteristics = materialized
            .formation
            .characteristics(
                zugfolge_infra::TrainCharacteristicsId::new(77),
                "restricted formation",
            )
            .expect("Restriktionen ergeben gueltige Zugcharakteristik");
        assert_eq!(characteristics.max_speed().millimetres_per_second(), 30_000);
        assert_eq!(characteristics.continuous_power().kilowatts(), 999);
        assert_eq!(
            characteristics
                .acceleration()
                .millimetres_per_second_squared(),
            800,
            "Power-BP darf Beschleunigung nicht faelschlich skalieren"
        );
        assert_eq!(
            characteristics
                .deceleration()
                .millimetres_per_second_squared(),
            600
        );
    }

    #[test]
    fn fleet_authority_v2_behandelt_vollgesperrten_antrieb_und_wagenpark_getrennt() {
        let initialize_release = |release: Value| -> Value {
            serde_json::from_str(
                &initialize_fleet_world(
                    &json!({
                        "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                        "worldId": WORLD,
                        "producedAt": 10,
                        "authorityRelease": release
                    })
                    .to_string(),
                )
                .expect("v2-Release wird initialisiert"),
            )
            .expect("gueltiges Initialisierungsergebnis")
        };

        let mut immobilized = authority_release_v2();
        immobilized["assets"][0]["restrictions"] = json!({
            "immobilized": "immobilized",
            "speed": {"maximum-speed": 30_000}
        });
        let immobilized = initialize_release(immobilized);
        let immobilized_result = apply(
            &immobilized["state"],
            &formation_command(&immobilized, "formation:immobilized"),
            None,
        );
        let immobilized_snapshot = &immobilized_result["snapshot"]["formations"][0];
        assert_eq!(immobilized_snapshot["availability"], "maintenance");
        assert_eq!(
            immobilized_snapshot["characteristics"]["traction"], "electric",
            "temporaere Immobilisierung darf die physische Traktion nicht umschreiben"
        );
        assert_eq!(
            immobilized_snapshot["characteristics"]["maximumSpeedKph"],
            108
        );
        assert!(
            immobilized_result["state"]["formations"]["formation-1"]
                .get("dynamics")
                .is_none()
        );

        let mut wagon = authority_release_v2();
        wagon["assets"][0]["installedProtection"] = json!([]);
        wagon["assets"][0]["technical"]["traction"] = json!("unpowered");
        wagon["assets"][0]["technical"]["electricSystems"] = json!([]);
        wagon["assets"][0]["technical"]["accelerationMmPerS2"] = json!(0);
        wagon["assets"][0]["technical"]["decelerationMmPerS2"] = json!(0);
        wagon["assets"][0]["technical"]["continuousPowerKw"] = json!(0);
        wagon["assets"][0]["technical"]["startingTractiveEffortKn"] = json!(0);
        wagon["assets"][0]["technical"]["maximumAccelerationCapMmps2"] = json!(0);
        wagon["assets"][0]["technical"]["role"] = json!("coach");
        wagon["assets"][0]["technical"]["controlStands"] = json!({"front": false, "rear": false});
        let wagon = initialize_release(wagon);
        let wagon_result = apply(
            &wagon["state"],
            &formation_command(&wagon, "formation:wagon"),
            None,
        );
        let wagon_snapshot = &wagon_result["snapshot"]["formations"][0];
        assert_eq!(wagon_snapshot["availability"], "available");
        assert_eq!(wagon_snapshot["characteristics"]["traction"], "unpowered");
    }

    #[test]
    fn nullgerasterter_antrieb_ist_gesperrt_und_umgeht_keine_mischtraktion() {
        let mut release = authority_release_v2();
        release["assets"][0]["technical"]["continuousPowerKw"] = json!(1);
        release["assets"][0]["restrictions"] =
            json!({"near-total-power-loss": {"power-basis-points": 1}});
        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect("Nullraster-Release wird initialisiert"),
        )
        .unwrap();
        let state: FleetWorldState = serde_json::from_value(initialized["state"].clone()).unwrap();
        let materialized = materialize_formation(
            &state,
            &FormationIntent {
                id: "formation:null-power".to_owned(),
                vehicle_ids: vec!["vehicle-1".to_owned()],
                path_receipt_id: "path-confirmed".to_owned(),
                dynamics: None,
            },
        )
        .expect("vollgesperrte Formation bleibt als Wagenpark materialisierbar");
        assert!(!materialized.formation.can_move_under_own_power());
        assert_eq!(
            materialized.snapshot.availability,
            zugfolge_fleet::MobilizationAvailability::Maintenance
        );
        assert_eq!(
            materialized.snapshot.characteristics.traction,
            zugfolge_fleet::MobilizationTraction::Electric
        );

        let mut mixed_intent = formation_command(&initialized, "formation:mixed-immobilized");
        mixed_intent["vehicleIds"] = json!(["vehicle-1", "vehicle-diesel"]);
        let error = apply_fleet_command(
            &initialized["state"].to_string(),
            &mixed_intent.to_string(),
            None,
        )
        .expect_err("gesperrte E-Traktion darf Diesel-Mischtraktion nicht kaschieren");
        assert!(error.to_string().contains("IncompatibleTraction"));
    }

    #[test]
    fn protection_unavailable_wirkt_nur_an_der_aktiven_spitze() {
        let mut release = authority_release_v2();
        release["assets"][0]["restrictions"] =
            json!({"pzb-failure": {"protection-unavailable": "pzb"}});
        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .unwrap(),
        )
        .unwrap();

        let mut failed_tip = formation_command(&initialized, "formation:failed-tip");
        failed_tip["vehicleIds"] = json!(["vehicle-1", "vehicle-2"]);
        let error = apply_fleet_command(
            &initialized["state"].to_string(),
            &failed_tip.to_string(),
            None,
        )
        .expect_err("ausgefallene Zugsicherung an der aktiven Spitze muss scheitern");
        assert!(error.to_string().contains("MissingProtection"));

        let mut healthy_tip = formation_command(&initialized, "formation:healthy-tip");
        healthy_tip["vehicleIds"] = json!(["vehicle-2", "vehicle-1"]);
        apply_fleet_command(
            &initialized["state"].to_string(),
            &healthy_tip.to_string(),
            None,
        )
        .expect("hintere ausgefallene Zugsicherung ist an der gesunden Spitze nicht aktiv");
    }

    #[test]
    fn immobilized_entfernt_nicht_den_schutz_eines_unpowered_steuerwagens() {
        let mut release = authority_release_v2();
        let control_car = &mut release["assets"][0];
        control_car["technical"]["traction"] = json!("unpowered");
        control_car["technical"]["electricSystems"] = json!([]);
        control_car["technical"]["accelerationMmPerS2"] = json!(0);
        control_car["technical"]["decelerationMmPerS2"] = json!(0);
        control_car["technical"]["continuousPowerKw"] = json!(0);
        control_car["technical"]["startingTractiveEffortKn"] = json!(0);
        control_car["technical"]["maximumAccelerationCapMmps2"] = json!(0);
        control_car["technical"]["role"] = json!("control-car");
        control_car["technical"]["controlStands"] = json!({"front": true, "rear": false});
        control_car["restrictions"] = json!({"availability": "immobilized"});
        release["assets"][1]["technical"]["role"] = json!("locomotive");

        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect("unpowered Steuerwagen darf seine Zugsicherung behalten"),
        )
        .expect("gueltiger v2-Zustand");

        let mut command = formation_command(&initialized, "formation:immobilized-control-car");
        command["vehicleIds"] = json!(["vehicle-1", "vehicle-2"]);
        apply_fleet_command(
            &initialized["state"].to_string(),
            &command.to_string(),
            None,
        )
        .expect("Immobilized am unpowered Steuerwagen darf die aktive PZB nicht entfernen");
    }

    #[test]
    fn authority_v2_hydriert_keine_fehlenden_halterzustaende() {
        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": authority_release_v2()
                })
                .to_string(),
            )
            .unwrap(),
        )
        .unwrap();

        for tamper in ["missing", "partial", "foreign", "bad-hash"] {
            let mut state = initialized["state"].clone();
            match tamper {
                "missing" => {
                    state.as_object_mut().unwrap().remove("assetHoldings");
                }
                "partial" => {
                    state["assetHoldings"]
                        .as_object_mut()
                        .unwrap()
                        .remove("vehicle-2");
                }
                "foreign" => {
                    state["assetHoldings"]["foreign"] = state["assetHoldings"]["vehicle-1"].clone();
                }
                "bad-hash" => state["assetHoldings"]["vehicle-1"]["historyHash"] = json!("bad"),
                _ => unreachable!(),
            }
            let decoded: FleetWorldState = serde_json::from_value(state.clone()).unwrap();
            let mut command = formation_command(&initialized, &format!("formation:{tamper}"));
            command["expectedStateHash"] = json!(state_hash(&decoded).unwrap());
            let error = apply_fleet_command(&state.to_string(), &command.to_string(), None)
                .expect_err("manipulierter v2-Halterzustand muss fail-closed scheitern");
            assert!(
                error.to_string().contains("Halterzustand")
                    || error.to_string().contains("SHA-256")
            );
        }

        let legacy = initialize();
        let mut legacy_state = legacy["state"].clone();
        legacy_state
            .as_object_mut()
            .unwrap()
            .remove("assetHoldings");
        let decoded: FleetWorldState = serde_json::from_value(legacy_state.clone()).unwrap();
        let mut command = formation_command(&legacy, "formation:legacy-hydration");
        command["expectedStateHash"] = json!(state_hash(&decoded).unwrap());
        apply_fleet_command(&legacy_state.to_string(), &command.to_string(), None)
            .expect("Authority-v1 ohne persistierte Holdings bleibt kompatibel");
    }

    #[test]
    fn fleet_authority_v2_begrenzt_alle_externen_numerischen_ids() {
        let initialize_error = |release: Value| {
            initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect_err("unsichere numerische ID muss scheitern")
            .to_string()
        };
        let unsafe_id = MAX_SAFE_JSON_INTEGER + 1;

        let mut asset_id = authority_release_v2();
        asset_id["assets"][0]["numericId"] = json!(unsafe_id);
        assert!(initialize_error(asset_id).contains("sicherer JSON-Ganzzahlen"));

        let mut type_id = authority_release_v2();
        type_id["assets"][0]["vehicleTypeId"] = json!(unsafe_id);
        assert!(initialize_error(type_id).contains("sicherer JSON-Ganzzahlen"));

        let mut pool_id = authority_release_v2();
        pool_id["personnelPools"][0]["numericId"] = json!(unsafe_id);
        assert!(initialize_error(pool_id).contains("sicherer JSON-Ganzzahlen"));

        let mut route_id = authority_release_v2();
        route_id["pathReceipts"][0]["numericRouteId"] = json!(unsafe_id);
        assert!(initialize_error(route_id).contains("sicherer JSON-Ganzzahlen"));

        let mut platform_length = authority_release_v2();
        platform_length["pathReceipts"][0]["platformLengthsMm"] = json!([unsafe_id]);
        assert!(initialize_error(platform_length).contains("sicherer JSON-Ganzzahlen"));
    }

    #[test]
    fn fleet_authority_v2_verlangt_und_validiert_condition_und_history() {
        let initialize_error = |release: Value| {
            initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect_err("ungueltiger v2-Assetzustand muss scheitern")
            .to_string()
        };

        let mut missing_condition = authority_release_v2();
        missing_condition["assets"][0]
            .as_object_mut()
            .unwrap()
            .remove("condition");
        assert!(initialize_error(missing_condition).contains("condition und history"));

        let mut missing_history = authority_release_v2();
        missing_history["assets"][0]
            .as_object_mut()
            .unwrap()
            .remove("history");
        assert!(initialize_error(missing_history).contains("condition und history"));

        let mut invalid_condition = authority_release_v2();
        invalid_condition["assets"][0]["condition"]["driveBasisPoints"] = json!(10_001);
        assert!(initialize_error(invalid_condition).contains("10000 Basispunkte"));

        let mut unsafe_counter = authority_release_v2();
        unsafe_counter["assets"][0]["condition"]["kilometresSinceMaintenance"] =
            json!(MAX_SAFE_JSON_INTEGER + 1);
        assert!(initialize_error(unsafe_counter).contains("sicherer JSON-Ganzzahlen"));

        let mut invalid_history = authority_release_v2();
        invalid_history["assets"][0]["history"] = json!([" entered-world"]);
        assert!(initialize_error(invalid_history).contains("nichtleer und randfrei"));

        let mut premature_v1 = authority_release();
        premature_v1["assets"][0]["condition"] = json!({
            "mechanicsBasisPoints": 10_000,
            "driveBasisPoints": 10_000,
            "brakesBasisPoints": 10_000,
            "kilometresSinceMaintenance": 0,
            "operatingHoursSinceMaintenance": 0,
            "openObservations": 0
        });
        premature_v1["assets"][0]["history"] = json!([]);
        assert!(initialize_error(premature_v1).contains("darf condition und history nicht"));

        initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": WORLD,
                "producedAt": 10,
                "authorityRelease": authority_release()
            })
            .to_string(),
        )
        .expect("Authority-v1 bleibt ohne condition und history ladbar");
    }

    #[test]
    fn initialer_halterhash_bindet_seed_zustand_und_lebenslauf() {
        let initialize_release = |release: Value| -> Value {
            serde_json::from_str(
                &initialize_fleet_world(
                    &json!({
                        "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                        "worldId": WORLD,
                        "producedAt": 10,
                        "authorityRelease": release
                    })
                    .to_string(),
                )
                .expect("Authority-v2 wird initialisiert"),
            )
            .expect("Initialisierung liefert JSON")
        };

        let mut base = authority_release_v2();
        base["assets"][0]["history"] = json!(["entered-world", "condition-recorded"]);
        let first = initialize_release(base.clone());
        let repeated = initialize_release(base.clone());
        assert_eq!(
            first["state"]["assetHoldings"]["vehicle-1"]["historyHash"],
            repeated["state"]["assetHoldings"]["vehicle-1"]["historyHash"]
        );

        let mut changed_condition = base.clone();
        changed_condition["assets"][0]["condition"]["driveBasisPoints"] = json!(9_999);
        let changed_condition = initialize_release(changed_condition);
        assert_ne!(
            first["state"]["assetHoldings"]["vehicle-1"]["historyHash"],
            changed_condition["state"]["assetHoldings"]["vehicle-1"]["historyHash"]
        );

        base["assets"][0]["history"] = json!(["condition-recorded", "entered-world"]);
        let changed_history = initialize_release(base);
        assert_ne!(
            first["state"]["assetHoldings"]["vehicle-1"]["historyHash"],
            changed_history["state"]["assetHoldings"]["vehicle-1"]["historyHash"]
        );
    }

    #[test]
    fn snapshot_wird_aus_authority_fakten_statt_command_dto_abgeleitet() {
        let initial = initialize();
        let command = formation_command(&initial, "formation:create");
        let result = apply(&initial["state"], &command, None);
        assert_eq!(
            result["snapshot"]["formations"][0]["availability"],
            "available"
        );
        assert_eq!(
            result["snapshot"]["formations"][0]["procurement"],
            "delivered"
        );
        assert_eq!(
            result["snapshot"]["formations"][0]["characteristics"]["seats"],
            120
        );
        assert_eq!(
            result["snapshot"]["formations"][0]["characteristics"]["maximumSpeedKph"],
            160
        );
        assert_eq!(result["state"]["processedCommands"], Value::Null);

        for forged_field in ["availability", "procurement", "characteristics"] {
            let mut forged = command.clone();
            forged[forged_field] = json!("forged");
            let error =
                apply_fleet_command(&initial["state"].to_string(), &forged.to_string(), None)
                    .expect_err("abgeleitete Felder sind keine Kommandoeingabe");
            assert!(error.to_string().starts_with("invalid_json:"));
        }
    }

    #[test]
    fn rohe_lokdaten_erfordern_und_akzeptieren_ein_formationsfahrprofil() {
        let mut release = authority_release();
        let technical = &mut release["assets"][0]["technical"];
        technical["accelerationMmPerS2"] = json!(0);
        technical["decelerationMmPerS2"] = json!(0);
        technical["continuousPowerKw"] = json!(5_600);
        technical["startingTractiveEffortKn"] = json!(300);
        let initial: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect("rohe Fahrzeugdaten sind ein gültiger Katalogeintrag"),
        )
        .expect("gültige initialisierte Welt");

        let without_profile = formation_command(&initial, "raw:without-profile");
        let error = apply_fleet_command(
            &initial["state"].to_string(),
            &without_profile.to_string(),
            None,
        )
        .expect_err("eine formationsabhängige Lok braucht ein Fahrprofil");
        assert!(error.to_string().contains("MissingFormationDynamics"));

        let mut with_profile = formation_command(&initial, "raw:with-profile");
        with_profile["dynamics"] = json!({
            "accelerationMmPerS2": 600,
            "decelerationMmPerS2": 700
        });
        let result = apply(&initial["state"], &with_profile, None);
        assert_eq!(
            result["snapshot"]["formations"][0]["characteristics"]["maximumSpeedKph"],
            160
        );
    }

    #[test]
    fn authority_v2_leitet_lok_wagen_und_doppeltraktion_serverseitig_ab() {
        let prepare_locomotive = |technical: &mut Value| {
            technical["accelerationMmPerS2"] = json!(0);
            technical["decelerationMmPerS2"] = json!(0);
            technical["continuousPowerKw"] = json!(4_000);
            technical["startingTractiveEffortKn"] = json!(200);
            technical["brakeWeightKg"] = json!(60_000);
            technical["maximumAccelerationCapMmps2"] = json!(2_000);
            technical["serviceBrakeCapMmps2"] = json!(8_000);
            technical["emergencyBrakeMultiplierBasisPoints"] = json!(15_000);
            technical["role"] = json!("locomotive");
            technical["controlStands"] = json!({"front": true, "rear": true});
        };
        let initialize_release = |release: Value, formations: Value| -> Value {
            serde_json::from_str(
                &initialize_fleet_world(
                    &json!({
                        "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                        "worldId": WORLD,
                        "producedAt": 10,
                        "authorityRelease": release,
                        "formations": formations
                    })
                    .to_string(),
                )
                .expect("Authority-v2-Rohformation wird initialisiert"),
            )
            .expect("Initialisierung liefert JSON")
        };

        let mut locomotive_only_release = authority_release_v2();
        prepare_locomotive(&mut locomotive_only_release["assets"][0]["technical"]);
        let locomotive_only = initialize_release(locomotive_only_release, json!([]));
        let locomotive_only_result = apply(
            &locomotive_only["state"],
            &formation_command(&locomotive_only, "raw-v2:locomotive-only"),
            None,
        );
        assert_eq!(
            locomotive_only_result["state"]["formations"]["formation-1"]["dynamics"],
            json!({"accelerationMmPerS2": 1_666, "decelerationMmPerS2": 4_903})
        );

        let mut loaded_release = authority_release_v2();
        prepare_locomotive(&mut loaded_release["assets"][0]["technical"]);
        let coach = &mut loaded_release["assets"][1];
        coach["installedProtection"] = json!([]);
        coach["technical"]["traction"] = json!("unpowered");
        coach["technical"]["electricSystems"] = json!([]);
        coach["technical"]["accelerationMmPerS2"] = json!(0);
        coach["technical"]["decelerationMmPerS2"] = json!(0);
        coach["technical"]["continuousPowerKw"] = json!(0);
        coach["technical"]["startingTractiveEffortKn"] = json!(0);
        coach["technical"]["brakeWeightKg"] = json!(120_000);
        coach["technical"]["maximumAccelerationCapMmps2"] = json!(0);
        coach["technical"]["serviceBrakeCapMmps2"] = json!(8_000);
        coach["technical"]["emergencyBrakeMultiplierBasisPoints"] = json!(15_000);
        coach["technical"]["role"] = json!("coach");
        coach["technical"]["controlStands"] = json!({"front": false, "rear": false});

        let loaded_initial = initialize_release(loaded_release.clone(), json!([]));
        let mut loaded_command = formation_command(&loaded_initial, "raw-v2:loaded-command");
        loaded_command["vehicleIds"] = json!(["vehicle-1", "vehicle-2"]);
        let loaded_result = apply(&loaded_initial["state"], &loaded_command, None);
        let expected_loaded = json!({"accelerationMmPerS2": 833, "decelerationMmPerS2": 7_354});
        assert_eq!(
            loaded_result["state"]["formations"]["formation-1"]["dynamics"],
            expected_loaded
        );
        assert!(
            loaded_result["state"]["formations"]["formation-1"]["dynamics"]
                ["accelerationMmPerS2"]
                .as_i64()
                < locomotive_only_result["state"]["formations"]["formation-1"]["dynamics"]
                    ["accelerationMmPerS2"]
                    .as_i64()
        );

        let initialized_with_formation = initialize_release(
            loaded_release,
            json!([{
                "id": "formation:initial-loaded",
                "vehicleIds": ["vehicle-1", "vehicle-2"],
                "pathReceiptId": "path-confirmed"
            }]),
        );
        assert_eq!(
            initialized_with_formation["state"]["formations"]["formation:initial-loaded"]["dynamics"],
            expected_loaded
        );

        let mut manipulated = formation_command(&loaded_initial, "raw-v2:manipulated");
        manipulated["vehicleIds"] = json!(["vehicle-1", "vehicle-2"]);
        manipulated["dynamics"] = json!({"accelerationMmPerS2": 834, "decelerationMmPerS2": 7_354});
        assert!(
            apply_fleet_command(
                &loaded_initial["state"].to_string(),
                &manipulated.to_string(),
                None,
            )
            .expect_err("Caller darf Authority-Dynamik nicht manipulieren")
            .to_string()
            .contains("caller-supplied FormationDynamics")
        );

        let mut double_release = authority_release_v2();
        prepare_locomotive(&mut double_release["assets"][0]["technical"]);
        prepare_locomotive(&mut double_release["assets"][1]["technical"]);
        let double_initial = initialize_release(double_release, json!([]));
        let mut double_command = formation_command(&double_initial, "raw-v2:double");
        double_command["vehicleIds"] = json!(["vehicle-1", "vehicle-2"]);
        let double_result = apply(&double_initial["state"], &double_command, None);
        assert_eq!(
            double_result["state"]["formations"]["formation-1"]["dynamics"],
            json!({"accelerationMmPerS2": 1_666, "decelerationMmPerS2": 4_903})
        );
    }

    #[test]
    fn authority_v2_rohdynamikfelder_sind_vollstaendig_und_reproduzierbar() {
        let initialize_result = |release: Value| {
            initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
        };
        let mut missing = authority_release_v2();
        missing["assets"][0]["technical"]
            .as_object_mut()
            .unwrap()
            .remove("serviceBrakeCapMmps2");
        assert!(
            initialize_result(missing)
                .expect_err("partieller Rohblock ist ungueltig")
                .to_string()
                .contains("technische Daten")
        );

        let mut zero_brake_weight = authority_release_v2();
        zero_brake_weight["assets"][0]["technical"]["brakeWeightKg"] = json!(0);
        assert!(initialize_result(zero_brake_weight).is_err());

        let mut manipulated_reference = authority_release_v2();
        manipulated_reference["assets"][0]["technical"]["accelerationMmPerS2"] = json!(799);
        assert!(
            initialize_result(manipulated_reference)
                .expect_err("Referenzprofil muss aus Rohwerten folgen")
                .to_string()
                .contains("Referenzprofil")
        );
    }

    #[test]
    fn authority_fuehrendes_fahrzeug_ohne_pzb_oder_etcs_wird_abgewiesen() {
        let mut release = authority_release();
        release["assets"][0]["installedProtection"] = json!([]);
        let error = initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": WORLD,
                "producedAt": 10,
                "authorityRelease": release
            })
            .to_string(),
        )
        .expect_err("Fuehrendes Fahrzeug ohne Basissicherung");
        assert!(error.to_string().contains("weder PZB noch ETCS"));
    }

    #[test]
    fn authority_lzb_braucht_pzb_etcs_darf_allein_stehen() {
        let mut lzb_ohne_pzb = authority_release();
        lzb_ohne_pzb["assets"][0]["installedProtection"] = json!(["lzb"]);
        let error = initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": WORLD,
                "producedAt": 10,
                "authorityRelease": lzb_ohne_pzb
            })
            .to_string(),
        )
        .expect_err("LZB ohne PZB darf nicht importiert werden");
        assert!(error.to_string().contains("LZB darf nur zusammen mit PZB"));

        let mut etcs_allein = authority_release();
        etcs_allein["assets"][0]["installedProtection"] = json!(["etcs-level2"]);
        initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": WORLD,
                "producedAt": 10,
                "authorityRelease": etcs_allein
            })
            .to_string(),
        )
        .expect("ETCS darf PZB nicht voraussetzen");
    }

    #[test]
    fn unpowered_wagenpark_bleibt_planbar_aber_nicht_dienstfaehig() {
        let mut release = authority_release();
        release["assets"][0]["technical"]["traction"] = json!("unpowered");
        release["assets"][0]["technical"]["electricSystems"] = json!([]);
        release["assets"][0]["technical"]["accelerationMmPerS2"] = json!(0);
        release["assets"][0]["technical"]["decelerationMmPerS2"] = json!(0);
        release["assets"][0]["technical"]["role"] = json!("coach");
        release["assets"][0]["technical"]["controlStands"] = json!({"front": false, "rear": false});
        release["assets"][0]["installedProtection"] = json!([]);
        let initial: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": release
                })
                .to_string(),
            )
            .expect("Wagenpark wird initialisiert"),
        )
        .expect("gueltiges Wagenpark-Ergebnis");
        let formed = apply(
            &initial["state"],
            &formation_command(&initial, "formation:coach-park"),
            None,
        );
        assert_eq!(
            formed["snapshot"]["formations"][0]["characteristics"]["traction"],
            "unpowered"
        );
        let duty = json!({
            "schemaVersion": "zugfolge-fleet-assign-duty-command/v2",
            "worldId": WORLD,
            "commandId": "duty:coach-park",
            "expectedStateHash": formed["stateHash"],
            "expectedRevision": 1,
            "atS": 12,
            "personnelDutyId": "duty-coach-park",
            "personnelPoolId": "pool-1",
            "formationIds": ["formation-1"],
            "pathReceiptId": "path-confirmed",
            "validFrom": 20,
            "validUntil": 200
        });
        let error = apply_fleet_command(&formed["state"].to_string(), &duty.to_string(), None)
            .expect_err("Wagenpark ohne Lok darf keinen Dienst bilden");
        assert!(error.to_string().contains("Wagenpark ohne Lok"));
    }

    #[test]
    fn sekundaermarkt_uebertraegt_halter_authoritativ_und_sperrt_doppelbindung() {
        let initial = initialize();
        let transfer = apply(
            &initial["state"],
            &json!({
                "schemaVersion": "zugfolge-fleet-transfer-asset-command/v1",
                "worldId": WORLD,
                "commandId": "market:transfer-1",
                "expectedStateHash": initial["stateHash"],
                "expectedRevision": 0,
                "atS": 11,
                "vehicleId": "vehicle-1",
                "transferType": "sale",
                "fromOwnerOperatorId": "operator-1",
                "toOwnerOperatorId": "operator-2",
                "fromHolderOperatorId": "operator-1",
                "toHolderOperatorId": "operator-2",
                "lessorOperatorId": null,
                "contractId": null,
                "validUntilS": null,
                "transferReceiptHash": "9".repeat(64)
            }),
            None,
        );
        assert_eq!(
            transfer["state"]["assetHoldings"]["vehicle-1"]["ownerOperatorId"],
            "operator-2"
        );
        assert_eq!(transfer["entityKind"], "asset-holding");

        let old_operator = json!({
            "schemaVersion": "zugfolge-fleet-form-vehicles-command/v2",
            "worldId": WORLD, "commandId": "formation:old",
            "expectedStateHash": transfer["stateHash"], "expectedRevision": 1,
            "atS": 12, "formationId": "formation-old", "vehicleIds": ["vehicle-1"],
            "pathReceiptId": "path-confirmed"
        });
        assert!(
            apply_fleet_command(
                &transfer["state"].to_string(),
                &old_operator.to_string(),
                None
            )
            .expect_err("Altbetreiber darf Fahrzeug nicht mehr bilden")
            .to_string()
            .contains("nicht demselben EVU")
        );

        let new_operator = json!({
            "schemaVersion": "zugfolge-fleet-form-vehicles-command/v2",
            "worldId": WORLD, "commandId": "formation:new",
            "expectedStateHash": transfer["stateHash"], "expectedRevision": 1,
            "atS": 12, "formationId": "formation-new", "vehicleIds": ["vehicle-1"],
            "pathReceiptId": "path-foreign"
        });
        let formed = apply(&transfer["state"], &new_operator, None);
        assert_eq!(
            formed["snapshot"]["formations"][0]["operatorId"],
            "operator-2"
        );

        let bound_transfer = json!({
            "schemaVersion": "zugfolge-fleet-transfer-asset-command/v1",
            "worldId": WORLD, "commandId": "market:double",
            "expectedStateHash": formed["stateHash"], "expectedRevision": 2, "atS": 13,
            "vehicleId": "vehicle-1", "transferType": "sale",
            "fromOwnerOperatorId": "operator-2", "toOwnerOperatorId": "operator-1",
            "fromHolderOperatorId": "operator-2", "toHolderOperatorId": "operator-1",
            "lessorOperatorId": null, "contractId": null, "validUntilS": null,
            "transferReceiptHash": "8".repeat(64)
        });
        assert!(
            apply_fleet_command(
                &formed["state"].to_string(),
                &bound_transfer.to_string(),
                None
            )
            .expect_err("gebundenes Fahrzeug bleibt unverkaeuflich")
            .to_string()
            .contains("Formation gebunden")
        );
    }

    #[test]
    fn sekundaermarkt_erkennt_gebundenes_asset_auch_in_unsortierter_v2_formation() {
        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": authority_release_v2()
                })
                .to_string(),
            )
            .expect("v2-Authority-Release wird initialisiert"),
        )
        .expect("gueltige v2-Flottenwelt");
        let mut formation = formation_command(&initialized, "formation:unsorted-transfer");
        formation["vehicleIds"] = json!(["vehicle-2", "vehicle-1"]);
        let formed = apply(&initialized["state"], &formation, None);
        let transfer = json!({
            "schemaVersion": "zugfolge-fleet-transfer-asset-command/v1",
            "worldId": WORLD,
            "commandId": "market:unsorted-bound",
            "expectedStateHash": formed["stateHash"],
            "expectedRevision": 1,
            "atS": 12,
            "vehicleId": "vehicle-2",
            "transferType": "sale",
            "fromOwnerOperatorId": "operator-1",
            "toOwnerOperatorId": "operator-2",
            "fromHolderOperatorId": "operator-1",
            "toHolderOperatorId": "operator-2",
            "lessorOperatorId": null,
            "contractId": null,
            "validUntilS": null,
            "transferReceiptHash": "7".repeat(64)
        });

        let error = apply_fleet_command(&formed["state"].to_string(), &transfer.to_string(), None)
            .expect_err("auch ein unsortiert gebundenes v2-Asset bleibt unverkaeuflich");
        assert!(error.to_string().contains("Formation gebunden"));
    }

    #[test]
    fn alter_v2_checkpoint_wird_beim_naechsten_kommando_rueckwaertskompatibel_erweitert() {
        let initial = initialize();
        let mut legacy_state = initial["state"].clone();
        legacy_state
            .as_object_mut()
            .expect("Zustandsobjekt")
            .remove("assetHoldings");
        let parsed: FleetWorldState =
            serde_json::from_value(legacy_state.clone()).expect("alter v2-Zustand");
        let legacy_hash = state_hash(&parsed).expect("alter Hash bleibt berechenbar");
        let command = json!({
            "schemaVersion": "zugfolge-fleet-form-vehicles-command/v2",
            "worldId": WORLD, "commandId": "legacy:formation",
            "expectedStateHash": legacy_hash, "expectedRevision": 0, "atS": 11,
            "formationId": "legacy-formation", "vehicleIds": ["vehicle-1"],
            "pathReceiptId": "path-confirmed"
        });
        let result = apply(&legacy_state, &command, None);
        assert_eq!(
            result["state"]["assetHoldings"]["vehicle-1"]["holderOperatorId"],
            "operator-1"
        );
    }

    #[test]
    fn formation_dienst_und_trasse_bilden_einen_vollstaendigen_snapshot() {
        let initial = initialize();
        let formation = apply(
            &initial["state"],
            &formation_command(&initial, "formation:create"),
            None,
        );
        let duty = apply(
            &formation["state"],
            &json!({
                "schemaVersion": "zugfolge-fleet-assign-duty-command/v2", "worldId": WORLD,
                "commandId": "duty:create", "expectedStateHash": formation["stateHash"],
                "expectedRevision": 1, "atS": 12, "personnelDutyId": "duty-1",
                "personnelPoolId": "pool-1", "formationIds": ["formation-1"],
                "pathReceiptId": "path-confirmed", "validFrom": 20, "validUntil": 200
            }),
            None,
        );
        let path = apply(
            &duty["state"],
            &json!({
                "schemaVersion": "zugfolge-fleet-attach-path-command/v2", "worldId": WORLD,
                "commandId": "path:create", "expectedStateHash": duty["stateHash"],
                "expectedRevision": 2, "atS": 13, "pathReservationId": "path-1",
                "pathReceiptId": "path-confirmed"
            }),
            None,
        );
        assert_eq!(path["snapshot"]["revision"], 3);
        assert_eq!(
            path["snapshot"]["formations"][0]["pathReceiptId"],
            "path-confirmed"
        );
        assert_eq!(path["snapshot"]["personnelDuties"][0]["status"], "ready");
        assert_eq!(
            path["snapshot"]["personnelDuties"][0]["pathReceiptId"],
            "path-confirmed"
        );
        assert_eq!(
            path["snapshot"]["pathReservations"][0]["status"],
            "confirmed"
        );
        assert_eq!(
            path["snapshot"]["pathReservations"][0]["pathReceiptId"],
            "path-confirmed"
        );
    }

    #[test]
    fn eigenbetriebs_bootstrap_ist_bei_simulationssekunde_null_vollstaendig() {
        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 0,
                    "authorityRelease": authority_release(),
                    "formations": [{
                        "id": "formation-public-1",
                        "vehicleIds": ["vehicle-1"],
                        "pathReceiptId": "path-confirmed",
                        "dynamics": { "accelerationMmPerS2": 900, "decelerationMmPerS2": 900 }
                    }],
                    "personnelDuties": [{
                        "id": "duty-public-1",
                        "personnelPoolId": "pool-1",
                        "formationIds": ["formation-public-1"],
                        "pathReceiptId": "path-confirmed",
                        "validFrom": 0,
                        "validUntil": 200
                    }],
                    "pathReservations": [{
                        "id": "reservation-public-1",
                        "pathReceiptId": "path-confirmed"
                    }]
                })
                .to_string(),
            )
            .expect("vollstaendiger Eigenbetrieb wird initialisiert"),
        )
        .expect("gueltiges Initialisierungsergebnis");

        assert_eq!(initialized["state"]["revision"], 0);
        assert_eq!(
            initialized["snapshot"]["formations"][0]["id"],
            "formation-public-1"
        );
        assert_eq!(
            initialized["snapshot"]["personnelDuties"][0]["status"],
            "ready"
        );
        assert_eq!(
            initialized["snapshot"]["pathReservations"][0]["status"],
            "confirmed"
        );
    }

    #[test]
    fn eigenbetriebs_bootstrap_verhindert_doppelte_fahrzeugbindung() {
        let error = initialize_fleet_world(
            &json!({
                "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                "worldId": WORLD,
                "producedAt": 0,
                "authorityRelease": authority_release(),
                "formations": [
                    { "id": "formation-a", "vehicleIds": ["vehicle-1"], "pathReceiptId": "path-confirmed" },
                    { "id": "formation-b", "vehicleIds": ["vehicle-1"], "pathReceiptId": "path-confirmed" }
                ]
            })
            .to_string(),
        )
        .expect_err("ein Asset darf nicht doppelt gebunden werden");
        assert!(error.to_string().contains("mehreren initialen Formationen"));
    }

    #[test]
    fn unbekannte_inkompatible_und_nicht_autorisierte_quellen_scheitern() {
        let initial = initialize();
        let mut unknown = formation_command(&initial, "unknown");
        unknown["vehicleIds"] = json!(["unknown"]);
        assert!(
            apply_fleet_command(&initial["state"].to_string(), &unknown.to_string(), None)
                .expect_err("unbekanntes Asset")
                .to_string()
                .contains("unbekanntes Authority-Asset")
        );

        let mut incompatible = formation_command(&initial, "incompatible");
        incompatible["vehicleIds"] = json!(["vehicle-1", "vehicle-diesel"]);
        assert!(
            apply_fleet_command(
                &initial["state"].to_string(),
                &incompatible.to_string(),
                None
            )
            .expect_err("inkompatible Formation")
            .to_string()
            .contains("inkompatible Formation")
        );

        for receipt in ["path-requested", "path-foreign"] {
            let mut invalid = formation_command(&initial, receipt);
            invalid["pathReceiptId"] = json!(receipt);
            assert!(
                apply_fleet_command(&initial["state"].to_string(), &invalid.to_string(), None)
                    .is_err()
            );
        }
    }

    #[test]
    fn unqualifizierter_dienst_und_abgeleitete_statusfelder_scheitern() {
        let initial = initialize();
        let formation = apply(
            &initial["state"],
            &formation_command(&initial, "formation:create"),
            None,
        );
        let base = json!({
            "schemaVersion": "zugfolge-fleet-assign-duty-command/v2", "worldId": WORLD,
            "commandId": "duty:create", "expectedStateHash": formation["stateHash"],
            "expectedRevision": 1, "atS": 12, "personnelDutyId": "duty-1",
            "personnelPoolId": "pool-1", "formationIds": ["formation-1"],
            "pathReceiptId": "path-foreign", "validFrom": 20, "validUntil": 200
        });
        assert!(
            apply_fleet_command(&formation["state"].to_string(), &base.to_string(), None)
                .expect_err("fremde Trasse")
                .to_string()
                .contains("qualifiziert")
        );
        let mut forged_ready = base.clone();
        forged_ready["pathReceiptId"] = json!("path-confirmed");
        forged_ready["ready"] = json!(true);
        assert!(
            apply_fleet_command(
                &formation["state"].to_string(),
                &forged_ready.to_string(),
                None
            )
            .expect_err("Dienstbereitschaft ist kein Intent-Feld")
            .to_string()
            .starts_with("invalid_json:")
        );

        let forged_confirmed = json!({
            "schemaVersion": "zugfolge-fleet-attach-path-command/v2",
            "worldId": WORLD,
            "commandId": "path:create",
            "expectedStateHash": formation["stateHash"],
            "expectedRevision": 1,
            "atS": 12,
            "pathReservationId": "path-1",
            "pathReceiptId": "path-confirmed",
            "confirmed": true
        });
        assert!(
            apply_fleet_command(
                &formation["state"].to_string(),
                &forged_confirmed.to_string(),
                None
            )
            .expect_err("Trassenbestaetigung ist kein Intent-Feld")
            .to_string()
            .starts_with("invalid_json:")
        );
    }

    #[test]
    fn receipt_replay_ist_kanonisch_und_state_bleibt_kompakt() {
        let initial = initialize();
        let mut command = formation_command(&initial, "formation:create");
        command["vehicleIds"] = json!(["vehicle-1", "vehicle-2"]);
        let result = apply(&initial["state"], &command, None);
        let initial_state_hash = initial["stateHash"]
            .as_str()
            .expect("Initialisierung liefert State-Hash");
        let reordered = format!(
            concat!(
                "{{\"vehicleIds\":[\"vehicle-2\",\"vehicle-1\"],\"worldId\":\"{}\",",
                "\"schemaVersion\":\"zugfolge-fleet-form-vehicles-command/v2\",",
                "\"pathReceiptId\":\"path-confirmed\",\"formationId\":\"formation-1\",",
                "\"expectedRevision\":0,\"expectedStateHash\":\"{}\",",
                "\"commandId\":\"formation:create\",\"atS\":11}}"
            ),
            WORLD, initial_state_hash
        );
        let replay: Value = serde_json::from_str(
            &apply_fleet_command(
                &result["state"].to_string(),
                &reordered,
                Some(&result["commandReceipt"].to_string()),
            )
            .expect("semantisch gleiches Kommando wird wiedererkannt"),
        )
        .expect("gueltiges Replay-Ergebnis");
        assert_eq!(replay["idempotentReplay"], true);
        assert_eq!(replay["stateHash"], result["stateHash"]);
        assert!(replay["state"].get("processedCommands").is_none());
        assert_eq!(
            replay["commandReceipt"]["canonicalCommandJson"],
            result["commandReceipt"]["canonicalCommandJson"]
        );

        let later = apply(
            &result["state"],
            &json!({
                "schemaVersion": "zugfolge-fleet-attach-path-command/v2",
                "worldId": WORLD,
                "commandId": "path:create",
                "expectedStateHash": result["stateHash"],
                "expectedRevision": 1,
                "atS": 12,
                "pathReservationId": "path-1",
                "pathReceiptId": "path-confirmed"
            }),
            None,
        );
        let mixed = apply_fleet_command(
            &later["state"].to_string(),
            &reordered,
            Some(&result["commandReceipt"].to_string()),
        )
        .expect_err("alte Receipt darf keinen neueren Zustand quittieren");
        assert!(mixed.to_string().starts_with("idempotency_conflict:"));

        let mut altered = command;
        altered["pathReceiptId"] = json!("path-requested");
        let conflict = apply_fleet_command(
            &result["state"].to_string(),
            &altered.to_string(),
            Some(&result["commandReceipt"].to_string()),
        )
        .expect_err("Receipt bindet kanonisches Kommando");
        assert!(conflict.to_string().starts_with("idempotency_conflict:"));
    }

    #[test]
    fn command_kanonform_hat_denselben_utf8_golden_hash_wie_typescript() {
        let command = parse_command(
            &json!({
                "schemaVersion": "zugfolge-fleet-form-vehicles-command/v2",
                "worldId": WORLD,
                "commandId": "canonical",
                "expectedStateHash": "d".repeat(64),
                "expectedRevision": 0,
                "atS": 1,
                "formationId": "formation-canonical",
                "vehicleIds": ["vehicle-\u{10000}", "vehicle-\u{e000}"],
                "pathReceiptId": "path-confirmed"
            })
            .to_string(),
        )
        .expect("kanonisches Testkommando");
        assert!(
            canonical_json(&command)
                .expect("Kanonform")
                .contains("\"vehicleIds\":[\"vehicle-\u{10000}\",\"vehicle-\u{e000}\"]")
        );
        assert_eq!(
            canonical_hash(&command).expect("Kommando-Hash"),
            "2a98a0cfbd0eaf9204466da423b36a4207e5f96c8c545e5e854ded55161699ee"
        );

        let transfer = parse_command(
            &json!({
                "schemaVersion": "zugfolge-fleet-transfer-asset-command/v1",
                "worldId": WORLD,
                "commandId": "market:transfer-1",
                "expectedStateHash": "d".repeat(64),
                "expectedRevision": 0,
                "atS": 120,
                "vehicleId": "vehicle-1",
                "transferType": "sale",
                "fromOwnerOperatorId": "operator-1",
                "toOwnerOperatorId": "operator-2",
                "fromHolderOperatorId": "operator-1",
                "toHolderOperatorId": "operator-2",
                "lessorOperatorId": null,
                "contractId": null,
                "validUntilS": null,
                "transferReceiptHash": "a".repeat(64)
            })
            .to_string(),
        )
        .expect("kanonisches Marktkommando");
        assert_eq!(
            canonical_hash(&transfer).expect("Marktkommando-Hash"),
            "c5c122a872b156518a2df5c0e107648d074850efcd400f196fdeb0f00bf31dcb"
        );
    }

    #[test]
    fn authority_release_hash_und_weltbindung_werden_vor_jedem_command_geprueft() {
        let initial = initialize();
        let command = formation_command(&initial, "formation:create");
        let mut tampered_state = initial["state"].clone();
        tampered_state["authorityRelease"]["assets"][0]["passenger"]["seats"] = json!(999);
        let decoded: FleetWorldState = serde_json::from_value(tampered_state.clone())
            .expect("syntaktisch gueltiger manipulierter Zustand");
        let mut command_for_tampered_state = command.clone();
        command_for_tampered_state["expectedStateHash"] =
            json!(state_hash(&decoded).expect("manipulierter Zustand ist hashbar"));
        let error = apply_fleet_command(
            &tampered_state.to_string(),
            &command_for_tampered_state.to_string(),
            None,
        )
        .expect_err("manipulierte Quellfakten duerfen nicht neu gehasht werden");
        assert!(error.to_string().contains("manipuliert"));

        let mut foreign = command;
        foreign["worldId"] = json!("22222222-2222-4222-8222-222222222222");
        let error = apply_fleet_command(&initial["state"].to_string(), &foreign.to_string(), None)
            .expect_err("fremde Welt wird abgewiesen");
        assert!(error.to_string().starts_with("world_mismatch:"));
    }

    #[test]
    fn persistierter_fleet_zustand_wird_vollstaendig_und_hashgebunden_revalidiert() {
        let initialized: Value = serde_json::from_str(
            &initialize_fleet_world(
                &json!({
                    "schemaVersion": "zugfolge-fleet-world-initialize/v2",
                    "worldId": WORLD,
                    "producedAt": 10,
                    "authorityRelease": authority_release_v2(),
                    "formations": [{
                        "id": "formation-verified",
                        "vehicleIds": ["vehicle-1"],
                        "pathReceiptId": "path-confirmed"
                    }]
                })
                .to_string(),
            )
            .expect("v2-Zustand wird initialisiert"),
        )
        .expect("gueltige Initialisierung");
        let verified: Value = serde_json::from_str(
            &verify_fleet_world_state(
                &initialized["state"].to_string(),
                initialized["stateHash"].as_str().expect("Zustandshash"),
            )
            .expect("unveraenderter Checkpoint wird verifiziert"),
        )
        .expect("gueltige Verifikation");
        assert_eq!(
            verified["schemaVersion"],
            "zugfolge-fleet-world-state-verification/v1"
        );
        assert_eq!(verified["worldId"], WORLD);
        assert_eq!(verified["stateHash"], initialized["stateHash"]);
        assert_eq!(verified["snapshotHash"], initialized["snapshotHash"]);
        assert_eq!(
            verified["authorityReleaseHash"],
            initialized["state"]["authorityReleaseHash"]
        );

        let mut tampered = initialized["state"].clone();
        tampered["authorityRelease"]["assets"][0]["technical"]["electricSystems"] =
            json!(["ac25kv"]);
        let error = verify_fleet_world_state(
            &tampered.to_string(),
            initialized["stateHash"].as_str().expect("Zustandshash"),
        )
        .expect_err("unveraenderter Hash darf manipulierte Stromsysteme nicht decken");
        assert!(error.to_string().starts_with("state_hash_mismatch:"));

        let decoded: FleetWorldState =
            serde_json::from_value(tampered.clone()).expect("syntaktischer Zustand");
        let forged_hash = state_hash(&decoded).expect("manipulierter Zustand ist hashbar");
        let error = verify_fleet_world_state(&tampered.to_string(), &forged_hash)
            .expect_err("Neuhashen darf den eingebetteten Release-Hash nicht umgehen");
        assert!(error.to_string().contains("manipuliert"));
    }

    #[test]
    fn werkstattauftrag_markiert_formation_und_ist_idempotent() {
        let initial = initialize();
        let formed = apply(
            &initial["state"],
            &formation_command(&initial, "formation:maintenance"),
            None,
        );
        let command = json!({
            "schemaVersion": "zugfolge-fleet-schedule-maintenance-command/v1",
            "worldId": WORLD,
            "commandId": "maintenance:formation-1",
            "expectedStateHash": formed["stateHash"],
            "expectedRevision": formed["state"]["revision"],
            "atS": 12,
            "formationId": "formation-1",
            "facilityId": "public-workshop",
            "startsAtS": 12,
            "endsAtS": 120
        });
        let maintained = apply(&formed["state"], &command, None);
        assert_eq!(
            maintained["snapshot"]["formations"][0]["availability"],
            "maintenance"
        );
        assert_eq!(
            maintained["commandReceipt"]["entityKind"],
            "maintenance-assignment"
        );

        let replay = apply(
            &maintained["state"],
            &command,
            Some(&maintained["commandReceipt"]),
        );
        assert_eq!(replay["idempotentReplay"], true);
        assert_eq!(replay["stateHash"], maintained["stateHash"]);

        let mut unknown = command;
        unknown["commandId"] = json!("maintenance:unknown");
        unknown["formationId"] = json!("formation-unknown");
        unknown["expectedStateHash"] = maintained["stateHash"].clone();
        unknown["expectedRevision"] = maintained["state"]["revision"].clone();
        let error =
            apply_fleet_command(&maintained["state"].to_string(), &unknown.to_string(), None)
                .expect_err("unbekannte Formation darf nicht in die Werkstatt");
        assert!(error.to_string().contains("unbekannt"));
    }
}
