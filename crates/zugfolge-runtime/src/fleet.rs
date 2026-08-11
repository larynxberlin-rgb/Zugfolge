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
    Duty, DutyRoster, FLEET_MOBILIZATION_SCHEMA, FleetSnapshot, Formation, FormationVehicle,
    MaintenanceDeadline, MaintenanceRule, MaintenanceState, MobilizationAvailability,
    MobilizationCharacteristics, MobilizationDutyStatus, MobilizationFormation,
    MobilizationPathReservation, MobilizationPathStatus, MobilizationPersonnelDuty,
    MobilizationProcurement, MobilizationSnapshot, NeedLimits, PersonnelPool, PlannedService,
    ProcurementChannel, RotationActivity, RotationLeg, RotationPlan, VehicleApproval, VehicleAsset,
    VehicleNeeds, VehicleReadiness, VehicleTechnicalData, validate_timetable_release,
};
use zugfolge_infra::{
    Acceleration, ElectricSystems, Electrification, FleetClass, Length, Mass, PowerSystem,
    ProtectionSystem, Speed, TractionType, TrainCharacteristicsId, TrainProtection,
};

use super::{RuntimeError, parse_json, sha256_json, to_json};

const FLEET_INITIALIZE_SCHEMA: &str = "zugfolge-fleet-world-initialize/v2";
const FLEET_INITIALIZED_SCHEMA: &str = "zugfolge-fleet-world-initialized/v2";
const FLEET_STATE_SCHEMA: &str = "zugfolge-fleet-world-state/v2";
const AUTHORITY_RELEASE_SCHEMA: &str = "zugfolge-fleet-authority-release/v1";
const FORMATION_COMMAND_SCHEMA: &str = "zugfolge-fleet-form-vehicles-command/v2";
const PERSONNEL_DUTY_COMMAND_SCHEMA: &str = "zugfolge-fleet-assign-duty-command/v2";
const PATH_RESERVATION_COMMAND_SCHEMA: &str = "zugfolge-fleet-attach-path-command/v2";
const FLEET_RESULT_SCHEMA: &str = "zugfolge-fleet-command-result/v2";
const FLEET_RECEIPT_SCHEMA: &str = "zugfolge-fleet-command-receipt/v1";
const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;

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
    Electric,
    Diesel,
    Battery,
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
    acceleration_mm_per_s2: i64,
    deceleration_mm_per_s2: i64,
    traction: AuthorityTraction,
    electric_systems: Vec<AuthorityPowerSystem>,
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
    technical: AuthorityTechnicalData,
    passenger: AuthorityPassengerData,
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
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FormationIntent {
    id: String,
    vehicle_ids: Vec<String>,
    path_receipt_id: String,
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
}

impl FleetCommand {
    fn normalize(&mut self) {
        match self {
            Self::Formation(command) => command.vehicle_ids.sort(),
            Self::PersonnelDuty(command) => command.formation_ids.sort(),
            Self::PathReservation(_) => {}
        }
    }

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
            Self::Formation(command) => &command.formation_id,
            Self::PersonnelDuty(command) => &command.personnel_duty_id,
            Self::PathReservation(command) => &command.path_reservation_id,
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

fn normalize_release(release: &mut FleetAuthorityRelease) {
    release.assets.sort_by(|left, right| left.id.cmp(&right.id));
    for asset in &mut release.assets {
        asset.approved_line_ids.sort();
        asset.installed_protection.sort();
        asset.technical.electric_systems.sort();
        asset.passenger.equipment.sort();
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
    if release.schema_version != AUTHORITY_RELEASE_SCHEMA {
        return Err(RuntimeError::new(
            "unsupported_schema",
            release.schema_version.clone(),
        ));
    }
    non_empty(&release.release_id, "authorityRelease.releaseId")?;
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
        {
            return Err(invalid("Authority-Asset besitzt ungueltige IDs oder Jahre"));
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
        if asset.technical.length_mm <= 0
            || asset.technical.mass_kg <= 0
            || asset.technical.maximum_speed_kph == 0
            || asset.technical.acceleration_mm_per_s2 <= 0
            || asset.technical.deceleration_mm_per_s2 <= 0
        {
            return Err(invalid(
                "Authority-Asset besitzt ungueltige technische Daten",
            ));
        }
        if matches!(asset.technical.traction, AuthorityTraction::Electric)
            != !asset.technical.electric_systems.is_empty()
        {
            return Err(invalid(
                "Authority-Asset besitzt inkonsistente elektrische Systeme",
            ));
        }
        if asset.passenger.seats == 0 || asset.passenger.first_class_seats > asset.passenger.seats {
            return Err(invalid("Authority-Asset besitzt ungueltige Fahrgastdaten"));
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

fn traction(technical: &AuthorityTechnicalData) -> Result<TractionType, RuntimeError> {
    match technical.traction {
        AuthorityTraction::Electric => ElectricSystems::from_systems(
            technical.electric_systems.iter().copied().map(Into::into),
        )
        .map(TractionType::Electric)
        .map_err(|error| invalid(format!("ungueltige elektrische Systeme: {error}"))),
        AuthorityTraction::Diesel => Ok(TractionType::Diesel),
        AuthorityTraction::Battery => Ok(TractionType::BatteryElectric),
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

fn technical_data(source: &AuthorityVehicleAsset) -> Result<VehicleTechnicalData, RuntimeError> {
    Ok(VehicleTechnicalData {
        vehicle_type_id: source.vehicle_type_id,
        length: Length::from_millimetres(source.technical.length_mm),
        mass: Mass::from_kilograms(source.technical.mass_kg),
        max_speed: Speed::from_km_h(i64::from(source.technical.maximum_speed_kph)),
        acceleration: Acceleration::from_millimetres_per_second_squared(
            source.technical.acceleration_mm_per_s2,
        ),
        deceleration: Acceleration::from_millimetres_per_second_squared(
            source.technical.deceleration_mm_per_s2,
        ),
        traction: traction(&source.technical)?,
    })
}

fn materialize_formation(
    state: &FleetWorldState,
    intent: &FormationIntent,
) -> Result<MaterializedFormation, RuntimeError> {
    ensure_unique_strings(&intent.vehicle_ids, "formation.vehicleIds")?;
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
        if source.operator_id != receipt.operator_id {
            return Err(invalid(
                "Formation und Trassenbeleg gehoeren nicht demselben EVU",
            ));
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
        vehicles.push(
            FormationVehicle::from_asset(asset, &technical_data(source)?).map_err(|error| {
                invalid(format!("technische Asset-Ableitung scheiterte: {error}"))
            })?,
        );
        sources.push(source);
    }
    let formation = Formation::new(numeric_world_id, stable_numeric_id(&intent.id), vehicles)
        .map_err(|error| invalid(format!("inkompatible Formation: {error}")))?;
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
    let train_characteristics = formation
        .characteristics(
            TrainCharacteristicsId::new(stable_numeric_u32(&intent.id)),
            intent.id.clone(),
        )
        .map_err(|error| {
            invalid(format!(
                "Zugcharakteristik konnte nicht abgeleitet werden: {error}"
            ))
        })?;

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
    let traction = match train_characteristics.traction() {
        TractionType::Electric(_) => zugfolge_fleet::MobilizationTraction::Electric,
        TractionType::Diesel => zugfolge_fleet::MobilizationTraction::Diesel,
        TractionType::BatteryElectric => zugfolge_fleet::MobilizationTraction::Battery,
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
            service_line_ids: receipt.service_line_ids.clone(),
            availability: MobilizationAvailability::Available,
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
                maximum_speed_kph: u16::try_from(train_characteristics.max_speed().km_h())
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
    let formations = state
        .formations
        .iter()
        .map(|(id, intent)| {
            if id != &intent.id {
                return Err(invalid(
                    "Formation stimmt nicht mit ihrem Zustandsschluessel ueberein",
                ));
            }
            materialize_formation(state, intent).map(|materialized| materialized.snapshot)
        })
        .collect::<Result<Vec<_>, _>>()?;
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
    let authority_release_hash = release_hash(&input.authority_release)?;
    let state = FleetWorldState {
        schema_version: FLEET_STATE_SCHEMA.to_owned(),
        world_id: input.world_id,
        revision: 0,
        produced_at: input.produced_at,
        authority_release_hash,
        authority_release: input.authority_release,
        formations: BTreeMap::new(),
        personnel_duties: BTreeMap::new(),
        path_reservations: BTreeMap::new(),
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

fn apply(
    mut state: FleetWorldState,
    command: FleetCommand,
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
    match &command {
        FleetCommand::Formation(command) => {
            let intent = FormationIntent {
                id: command.formation_id.clone(),
                vehicle_ids: command.vehicle_ids.clone(),
                path_receipt_id: command.path_receipt_id.clone(),
            };
            if state.formations.values().any(|existing| {
                existing.id != intent.id
                    && existing
                        .vehicle_ids
                        .iter()
                        .any(|vehicle| intent.vehicle_ids.binary_search(vehicle).is_ok())
            }) {
                return Err(invalid(
                    "Authority-Asset ist bereits einer anderen Formation zugeordnet",
                ));
            }
            materialize_formation(&state, &intent)?;
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
        FleetWorldState, apply_fleet_command, canonical_hash, canonical_json,
        initialize_fleet_world, parse_command, state_hash,
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
        assert_eq!(path["snapshot"]["personnelDuties"][0]["status"], "ready");
        assert_eq!(
            path["snapshot"]["pathReservations"][0]["status"],
            "confirmed"
        );
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
                .contains("\"vehicleIds\":[\"vehicle-\u{e000}\",\"vehicle-\u{10000}\"]")
        );
        assert_eq!(
            canonical_hash(&command).expect("Kommando-Hash"),
            "8f85a082a134e3785918f998b90e8e34c784b163c2ecdf3005a7269aa549da82"
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
}
