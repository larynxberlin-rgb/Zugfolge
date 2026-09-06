//! Streng belegter Fahrzeugquellkatalog und deterministischer Release-Compiler.
//!
//! Der Quellkatalog ist weltunabhängig. Ein separater Welt-Seed bindet seine
//! Typen an konkrete Assets, Formationen, Personalpools und Trassenbelege. Der
//! Compiler erzeugt daraus sowohl den bestehenden Fleet-Authority-Vertrag als
//! auch das physische Inventar für Operational v2. Alle Eingaben sind strikt,
//! ganzzahlig und ohne Zugriff auf Uhr, Datenbank oder externe Dienste.

#![allow(
    missing_docs,
    reason = "die öffentlichen Schemafelder sind der maschinenlesbare Transportvertrag"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;

use crate::{VehicleConfigurationFacts, VehicleConfigurationV1};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zugfolge_infra::FleetClass;
use zugfolge_sim::operational::{
    Direction, FORMATION_DYNAMICS_BASIS_POINTS, FormationDynamicsDerivationInput,
    FormationPerformance, MAX_FORMATION_ACCELERATION_MMPS2, MAX_FORMATION_BRAKE_MMPS2,
    OperationalControlStands, OperationalPowerSystem, OperationalVehicleRole,
    OperationalVehicleTraction, PhysicalVehicle, VehicleCondition, VehicleRestriction, VehicleType,
    VehicleTypeRawFormationDynamics, derive_formation_dynamics,
};

pub const SOURCE_CATALOG_SCHEMA: &str = "zugfolge-vehicle-catalog-source/v2";
pub const WORLD_SEED_SCHEMA: &str = "zugfolge-vehicle-world-seed/v3";
pub const COMPILED_CATALOG_SCHEMA: &str = "zugfolge-vehicle-catalog/v3";
pub const OPERATIONAL_INVENTORY_SCHEMA: &str = "zugfolge-operational-vehicle-inventory/v2";
pub const COMPILE_RECEIPT_SCHEMA: &str = "zugfolge-vehicle-catalog-compile-receipt/v4";
pub const FLEET_AUTHORITY_SCHEMA: &str = "zugfolge-fleet-authority-release/v2";
pub const FLEET_AUTHORITY_CATALOG_SCHEMA: &str = "zugfolge-fleet-authority-release-catalog/v1";
pub const OPERATIONAL_PROFILE_SCHEMA: &str = "zugfolge-derived-operational-profile/v2";
pub const ECONOMY_PROJECTION_SCHEMA: &str = "zugfolge-vehicle-economy-projection/v2";
pub const ECONOMY_RELEASE_SCHEMA: &str = "economy-release/v1";
pub const COMPILER_VERSION: &str = "zugfolge-vehicle-catalog-compiler/v4";

const MAX_SAFE_JSON_INTEGER: u64 = 9_007_199_254_740_991;
const BASIS_POINTS_MAX: u16 = FORMATION_DYNAMICS_BASIS_POINTS;
const MAX_CONTINUOUS_POWER_KW: u32 = 100_000;
const MAX_STARTING_TRACTIVE_EFFORT_KN: u32 = 5_000;
const MAX_ACCELERATION_MMPS2: u32 = MAX_FORMATION_ACCELERATION_MMPS2;
const MAX_BRAKE_MMPS2: u32 = MAX_FORMATION_BRAKE_MMPS2;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidenced<T> {
    pub value: T,
    pub kind: EvidenceKind,
    pub confidence_basis_points: u16,
    pub method: String,
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceDeclaration {
    pub kind: EvidenceKind,
    pub confidence_basis_points: u16,
    pub method: String,
    pub source_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceKind {
    PublishedFact,
    DeterministicDerivation,
    GameAssumption,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SourceRightsStatus {
    Freigegeben,
    Entwicklung,
    Pruefung,
    Gesperrt,
    Ausgeschlossen,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRightsDecision {
    pub status: SourceRightsStatus,
    pub decided_at: String,
    pub reviewer: String,
    pub reference: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEvidenceSource {
    pub id: String,
    pub title: String,
    pub url: String,
    pub license: String,
    pub retrieved_at: String,
    pub content_sha256: String,
    pub rights_decision: SourceRightsDecision,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VehicleRole {
    PoweredUnit,
    Locomotive,
    Coach,
    ControlCar,
}

impl VehicleRole {
    fn is_powered(self) -> bool {
        matches!(self, Self::PoweredUnit | Self::Locomotive)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VehicleTraction {
    Unpowered,
    Electric,
    Diesel,
    Battery,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VehicleProtectionSystem {
    Pzb,
    Lzb,
    EtcsLevel1,
    EtcsLevel2,
}

impl VehicleProtectionSystem {
    fn operational_name(self) -> &'static str {
        match self {
            Self::Pzb => "pzb",
            Self::Lzb => "lzb",
            Self::EtcsLevel1 => "etcs-level1",
            Self::EtcsLevel2 => "etcs-level2",
        }
    }

    fn is_baseline(self) -> bool {
        matches!(self, Self::Pzb | Self::EtcsLevel1 | Self::EtcsLevel2)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VehiclePowerSystem {
    Ac15kv,
    Ac25kv,
    Dc750v,
    Dc1500v,
    Dc3000v,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProtectionFitment {
    FactoryOption,
    Retrofit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct YearSpan {
    pub from: u16,
    pub to: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlStands {
    pub front: bool,
    pub rear: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceTechnicalFacts {
    pub length_mm: Evidenced<u32>,
    pub mass_kg: Evidenced<u64>,
    pub maximum_speed_kph: Evidenced<u16>,
    pub continuous_power_kw: Evidenced<u32>,
    pub starting_tractive_effort_kn: Evidenced<u32>,
    pub brake_weight_kg: Evidenced<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceOperationalProfile {
    pub schema_version: String,
    pub maximum_acceleration_cap_mmps2: Evidenced<u32>,
    pub service_brake_cap_mmps2: Evidenced<u32>,
    pub emergency_brake_multiplier_basis_points: Evidenced<u16>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourcePassengerFacts {
    pub seats: Evidenced<u32>,
    pub first_class_seats: Evidenced<u32>,
    pub accessible: Evidenced<bool>,
    pub bicycle_places: Evidenced<u16>,
    pub wheelchair_places: Evidenced<u16>,
    pub equipment: Evidenced<Vec<String>>,
    pub replacement_plan: Evidenced<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceMarkets {
    pub new_build: Evidenced<YearSpan>,
    pub leasing: Evidenced<YearSpan>,
    pub used: Evidenced<YearSpan>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceProtectionOption {
    pub system: VehicleProtectionSystem,
    pub fitment: ProtectionFitment,
    pub years: YearSpan,
    pub evidence: EvidenceDeclaration,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceVehicleType {
    pub type_id: String,
    pub numeric_id: u64,
    pub class_designation: Evidenced<String>,
    pub trade_name: Evidenced<String>,
    pub construction_years: Evidenced<YearSpan>,
    pub role: Evidenced<VehicleRole>,
    pub traction: Evidenced<VehicleTraction>,
    pub control_stands: Evidenced<ControlStands>,
    pub electric_systems: Evidenced<Vec<VehiclePowerSystem>>,
    pub standard_protection: Evidenced<Vec<VehicleProtectionSystem>>,
    pub protection_options: Vec<SourceProtectionOption>,
    pub markets: SourceMarkets,
    pub technical: SourceTechnicalFacts,
    pub operational_profile: SourceOperationalProfile,
    pub passenger: SourcePassengerFacts,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleSourceCatalog {
    pub schema_version: String,
    pub release_id: String,
    pub reference_year: u16,
    pub sources: Vec<CatalogEvidenceSource>,
    pub vehicle_types: Vec<SourceVehicleType>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcurementChannel {
    NewBuild,
    Leasing,
    Used,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityMaintenanceDeadline {
    pub kind: String,
    pub due_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeedVehicleAsset {
    pub id: String,
    pub numeric_id: u64,
    pub operator_id: String,
    pub type_id: String,
    pub build_year: u16,
    pub acquisition_year: u16,
    pub procurement_channel: ProcurementChannel,
    pub approved_line_ids: Vec<String>,
    pub maintenance_deadlines: Vec<AuthorityMaintenanceDeadline>,
    pub installed_protection: Vec<VehicleProtectionSystem>,
    pub delivered_at: u64,
    pub retired_at: u64,
    pub orientation: Direction,
    pub condition: VehicleCondition,
    #[serde(default)]
    pub restrictions: BTreeMap<String, VehicleRestriction>,
    #[serde(default)]
    pub history: Vec<String>,
    /// Vollständige Konfiguration dieses konkreten Weltassets; kein Typdefault.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::deserialize_optional_vehicle_configuration"
    )]
    pub vehicle_configuration: Option<VehicleConfigurationV1>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeedFormation {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predecessor_id: Option<String>,
    pub vehicle_ids: Vec<String>,
    pub path_receipt_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthorityPathDecision {
    Confirmed,
    Requested,
    Rejected,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthorityElectrification {
    Unelectrified,
    OverheadAc15kv,
    OverheadAc25kv,
    OverheadDc1500v,
    OverheadDc3000v,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityPersonnelPool {
    pub id: String,
    pub numeric_id: u64,
    pub operator_id: String,
    pub capacity_seconds: u32,
    pub minimum_rest_seconds: u32,
    pub class_designations: Vec<String>,
    pub path_receipt_ids: Vec<String>,
    pub qualification_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityPathReceipt {
    pub id: String,
    pub numeric_route_id: u64,
    pub operator_id: String,
    pub service_line_ids: Vec<String>,
    pub decision: AuthorityPathDecision,
    pub valid_from: u64,
    pub valid_until: u64,
    pub platform_lengths_mm: Vec<i64>,
    pub electrifications: Vec<AuthorityElectrification>,
    pub required_protection: Vec<VehicleProtectionSystem>,
    pub approved_classes: Vec<String>,
    pub planner_state_hash: String,
    pub conflict_check_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleWorldSeed {
    pub schema_version: String,
    pub seed_id: String,
    pub catalog_release_id: String,
    pub authority_release_id: String,
    pub operational_release_id: String,
    pub world_id: String,
    pub produced_at: u64,
    pub economy: VehicleEconomyProjection,
    pub assets: Vec<SeedVehicleAsset>,
    pub formations: Vec<SeedFormation>,
    pub personnel_pools: Vec<AuthorityPersonnelPool>,
    pub path_receipts: Vec<AuthorityPathReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleEconomyProjection {
    pub schema_version: String,
    pub release: EconomyReleaseDocument,
    pub operating_costs: Vec<VehicleOperatingCost>,
    pub projection_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleOperatingCost {
    pub type_id: String,
    pub cents_per_train_km: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EconomyReleaseDocument {
    pub schema: String,
    pub version: String,
    pub rates: EconomyReleaseRates,
    pub rules: EconomyReleaseRules,
    pub tender_profiles: Vec<EconomyTenderProfile>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::deserialize_optional_fare_inspection"
    )]
    pub fare_inspection: Option<crate::FareInspectionEconomyV1>,
    pub checksum: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EconomyReleaseRates {
    pub track_per_train_km_cents: String,
    pub station_per_stop_cents: String,
    pub facility_per_hour_cents: String,
    pub energy_per_kwh_cents: String,
    pub personnel_per_hour_cents: String,
    pub administration_per_period_cents: String,
    pub vehicle_per_period_cents: String,
    pub overnight_stabling_per_period_cents: String,
    pub protection_equipment_per_period_cents: String,
    pub late_interest_basis_points: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EconomyReleaseRules {
    pub quality_baseline_punctuality_basis_points: u64,
    pub points_per_extra_seat: u64,
    pub points_per_punctuality_basis_point: u64,
    pub points_per_additional_stop: u64,
    pub requirement_focus_maximum_points: u64,
    pub contract_bonus_cents_per_period: String,
    pub penalty_rates: EconomyPenaltyRates,
    pub penalty_focus_multiplier_basis_points: u64,
    pub public_operation_surcharge_basis_points: u64,
    pub failed_package_fee_step_basis_points: u64,
    pub failed_package_reduction_step_basis_points: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EconomyPenaltyRates {
    pub punctuality: String,
    pub cancellation: String,
    pub seats: String,
    pub connections: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EconomyRequirementFocus {
    Capacity,
    Comfort,
    Bicycle,
    Accessibility,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EconomyPenaltyFocus {
    Punctuality,
    Cancellation,
    Seats,
    Connections,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EconomySpecialConditionKind {
    AdditionalStop,
    MaximumAge,
    Traction,
    ReplacementPlan,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EconomyTractionKind {
    Electric,
    Diesel,
    Battery,
    Hydrogen,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EconomySpecialCondition {
    #[serde(rename = "type")]
    pub kind: EconomySpecialConditionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_additional_stops: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_age_years: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed: Option<Vec<EconomyTractionKind>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EconomyScoringWeights {
    pub price: u64,
    pub quality: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EconomyTenderProfile {
    pub id: String,
    pub weights: EconomyScoringWeights,
    pub requirement_focus: EconomyRequirementFocus,
    pub penalty_focus: EconomyPenaltyFocus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub special_condition: Option<EconomySpecialCondition>,
    pub viability_surcharge_basis_points: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledCatalogSource {
    pub id: String,
    pub title: String,
    pub url: String,
    pub license: String,
    pub retrieved_at: String,
    pub content_sha256: String,
    pub rights_decision: SourceRightsDecision,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledFieldEvidence {
    pub kind: EvidenceKind,
    pub confidence_basis_points: u16,
    pub method: String,
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledTechnicalFacts {
    pub length_mm: u32,
    pub mass_kg: u64,
    pub maximum_speed_kph: u16,
    pub continuous_power_kw: u32,
    pub starting_tractive_effort_kn: u32,
    pub brake_weight_kg: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledOperationalProfile {
    pub schema_version: String,
    pub input_sha256: String,
    pub maximum_acceleration_cap_mmps2: u32,
    pub service_brake_cap_mmps2: u32,
    pub emergency_brake_multiplier_basis_points: u16,
    pub maximum_acceleration_mmps2: u32,
    pub service_brake_mmps2: u32,
    pub emergency_brake_mmps2: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledPassengerFacts {
    pub seats: u32,
    pub first_class_seats: u32,
    pub accessible: bool,
    pub bicycle_places: u16,
    pub wheelchair_places: u16,
    pub equipment: Vec<String>,
    pub replacement_plan: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledMarkets {
    pub new_build: YearSpan,
    pub leasing: YearSpan,
    pub used: YearSpan,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledProtectionOption {
    pub system: VehicleProtectionSystem,
    pub fitment: ProtectionFitment,
    pub years: YearSpan,
    pub evidence: CompiledFieldEvidence,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledVehicleType {
    pub type_id: String,
    pub numeric_id: u64,
    pub class_designation: String,
    pub trade_name: String,
    pub construction_years: YearSpan,
    pub role: VehicleRole,
    pub traction: VehicleTraction,
    pub control_stands: ControlStands,
    pub electric_systems: Vec<VehiclePowerSystem>,
    pub standard_protection: Vec<VehicleProtectionSystem>,
    pub protection_options: Vec<CompiledProtectionOption>,
    pub markets: CompiledMarkets,
    pub technical: CompiledTechnicalFacts,
    pub operational_profile: CompiledOperationalProfile,
    pub passenger: CompiledPassengerFacts,
    pub evidence: BTreeMap<String, CompiledFieldEvidence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompiledVehicleCatalogRelease {
    pub schema_version: String,
    pub release_id: String,
    pub reference_year: u16,
    pub sources: Vec<CompiledCatalogSource>,
    pub vehicle_types: Vec<CompiledVehicleType>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityTechnicalData {
    pub length_mm: i64,
    pub mass_kg: i64,
    pub maximum_speed_kph: u16,
    pub maximum_speed_mmps: i64,
    pub acceleration_mm_per_s2: i64,
    pub deceleration_mm_per_s2: i64,
    pub continuous_power_kw: i64,
    pub starting_tractive_effort_kn: i64,
    pub brake_weight_kg: i64,
    pub maximum_acceleration_cap_mmps2: i64,
    pub service_brake_cap_mmps2: i64,
    pub emergency_brake_multiplier_basis_points: u16,
    pub traction: VehicleTraction,
    pub electric_systems: Vec<VehiclePowerSystem>,
    pub role: VehicleRole,
    pub control_stands: ControlStands,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityPassengerData {
    pub seats: u32,
    pub first_class_seats: u32,
    pub accessible: bool,
    pub bicycle_places: u16,
    pub wheelchair_places: u16,
    pub equipment: Vec<String>,
    pub operating_cost_cents_per_train_km: u32,
    pub replacement_plan: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorityVehicleAsset {
    pub id: String,
    pub numeric_id: u64,
    pub operator_id: String,
    pub vehicle_type_id: u64,
    pub class_designation: String,
    pub trade_name: String,
    pub build_year: u16,
    pub acquisition_year: u16,
    pub procurement_channel: ProcurementChannel,
    pub approved_line_ids: Vec<String>,
    pub maintenance_deadlines: Vec<AuthorityMaintenanceDeadline>,
    pub installed_protection: Vec<VehicleProtectionSystem>,
    /// Physische Ausrichtung innerhalb der autoritativen Reihung.
    pub orientation: Direction,
    /// Operativer, sechsteiliger Ist-Zustand des konkreten Assets.
    pub condition: VehicleCondition,
    /// Vollstaendige assetlokale Betriebseinschraenkungen. Die Map entspricht
    /// bytegenau der Operational-Projektion und bleibt damit getrennt von den
    /// unveraenderten statischen Typ- und Ausstattungsfakten.
    pub restrictions: BTreeMap<String, VehicleRestriction>,
    /// Reihenfolgestabiler Lebenslauf aus dem Welt-Seed.
    pub history: Vec<String>,
    pub technical: AuthorityTechnicalData,
    pub passenger: AuthorityPassengerData,
    /// Geprüfte, verlustfrei aus dem Welt-Seed übernommene M5-Konfiguration.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::deserialize_optional_vehicle_configuration"
    )]
    pub vehicle_configuration: Option<VehicleConfigurationV1>,
    pub delivered_at: u64,
    pub retired_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetAuthorityRelease {
    pub schema_version: String,
    pub release_id: String,
    pub reference_year: u16,
    pub economy_release_id: String,
    pub economy_release_sha256: String,
    pub assets: Vec<AuthorityVehicleAsset>,
    pub personnel_pools: Vec<AuthorityPersonnelPool>,
    pub path_receipts: Vec<AuthorityPathReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalFormation {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub predecessor_id: Option<String>,
    pub vehicle_ids: Vec<String>,
    pub path_receipt_id: String,
    pub performance: FormationPerformance,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalVehicleType {
    pub powered: bool,
    pub vehicle_type: VehicleType,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationalVehicleInventory {
    pub schema_version: String,
    pub release_id: String,
    pub world_id: String,
    pub catalog_release_id: String,
    pub vehicle_types: Vec<OperationalVehicleType>,
    pub vehicles: Vec<PhysicalVehicle>,
    pub formations: Vec<OperationalFormation>,
}

/// Weltbindung eines Fleet-Authority-Releases im deploybaren Serverformat.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetAuthorityReleaseCatalogEntry {
    pub world_id: String,
    /// Seed-Zeitpunkt, zu dem der Authority-Release fachlich validiert wurde.
    /// Der Game-API-Loader muss exakt diesen Wert fuer die Initialisierung
    /// verwenden; ein stiller Rueckfall auf Simulationssekunde null ist nur
    /// fuer historische Authority-v1-Kataloge zulaessig.
    pub produced_at: u64,
    pub authority_release: FleetAuthorityRelease,
}

/// Atomarer Single-World-Wrapper fuer den Game-API-Authority-Loader.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetAuthorityReleaseCatalog {
    pub schema_version: String,
    pub entries: Vec<FleetAuthorityReleaseCatalogEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleCatalogCompileReceipt {
    pub schema_version: String,
    pub compiler_version: String,
    pub source_catalog_release_id: String,
    pub world_seed_id: String,
    pub world_id: String,
    pub produced_at: u64,
    pub economy_release_id: String,
    pub economy_release_sha256: String,
    pub economy_projection_sha256: String,
    pub source_catalog_sha256: String,
    pub world_seed_sha256: String,
    pub compiled_catalog_sha256: String,
    pub fleet_authority_sha256: String,
    pub fleet_authority_catalog_sha256: String,
    pub operational_inventory_sha256: String,
    pub output_set_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VehicleCatalogCompilation {
    pub catalog: CompiledVehicleCatalogRelease,
    pub fleet_authority: FleetAuthorityRelease,
    pub fleet_authority_catalog: FleetAuthorityReleaseCatalog,
    pub operational_inventory: OperationalVehicleInventory,
    pub receipt: VehicleCatalogCompileReceipt,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogCompileError {
    Json(String),
    Invalid(String),
}

impl fmt::Display for CatalogCompileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Json(message) => write!(formatter, "ungueltiges JSON: {message}"),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl Error for CatalogCompileError {}

impl From<serde_json::Error> for CatalogCompileError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error.to_string())
    }
}

pub fn parse_source_catalog(json: &str) -> Result<VehicleSourceCatalog, CatalogCompileError> {
    serde_json::from_str(json).map_err(Into::into)
}

pub fn parse_world_seed(json: &str) -> Result<VehicleWorldSeed, CatalogCompileError> {
    serde_json::from_str(json).map_err(Into::into)
}

pub fn compile_vehicle_catalog_json(
    source_catalog_json: &str,
    world_seed_json: &str,
) -> Result<VehicleCatalogCompilation, CatalogCompileError> {
    let source = parse_source_catalog(source_catalog_json)?;
    let seed = parse_world_seed(world_seed_json)?;
    compile_vehicle_catalog(&source, &seed)
}

pub fn compile_vehicle_catalog(
    source: &VehicleSourceCatalog,
    seed: &VehicleWorldSeed,
) -> Result<VehicleCatalogCompilation, CatalogCompileError> {
    let mut source = source.clone();
    let mut seed = seed.clone();
    normalize_source_catalog(&mut source)?;
    normalize_world_seed(&mut seed)?;
    let source_catalog_sha256 = hash_json(&source)?;
    let world_seed_sha256 = hash_json(&seed)?;
    let catalog = compile_type_release(&source)?;
    let (fleet_authority, operational_inventory) = compile_world(&catalog, &seed)?;
    let fleet_authority_catalog = FleetAuthorityReleaseCatalog {
        schema_version: FLEET_AUTHORITY_CATALOG_SCHEMA.to_owned(),
        entries: vec![FleetAuthorityReleaseCatalogEntry {
            world_id: seed.world_id.clone(),
            produced_at: seed.produced_at,
            authority_release: fleet_authority.clone(),
        }],
    };
    let economy_projection_sha256 = recompute_vehicle_economy_projection_sha256(&seed.economy)?;
    let compiled_catalog_sha256 = hash_json(&catalog)?;
    let fleet_authority_sha256 = hash_json(&fleet_authority)?;
    let fleet_authority_catalog_sha256 = hash_json(&fleet_authority_catalog)?;
    let operational_inventory_sha256 = hash_json(&operational_inventory)?;
    let output_set_sha256 = output_set_hash(OutputSetHash {
        schema_version: COMPILE_RECEIPT_SCHEMA,
        compiler_version: COMPILER_VERSION,
        source_catalog_release_id: &source.release_id,
        world_seed_id: &seed.seed_id,
        world_id: &seed.world_id,
        produced_at: seed.produced_at,
        economy_release_id: &seed.economy.release.version,
        source_catalog_sha256: &source_catalog_sha256,
        world_seed_sha256: &world_seed_sha256,
        economy_release_sha256: &seed.economy.release.checksum,
        economy_projection_sha256: &economy_projection_sha256,
        compiled_catalog_sha256: &compiled_catalog_sha256,
        fleet_authority_sha256: &fleet_authority_sha256,
        fleet_authority_catalog_sha256: &fleet_authority_catalog_sha256,
        operational_inventory_sha256: &operational_inventory_sha256,
    })?;
    let receipt = VehicleCatalogCompileReceipt {
        schema_version: COMPILE_RECEIPT_SCHEMA.to_owned(),
        compiler_version: COMPILER_VERSION.to_owned(),
        source_catalog_release_id: source.release_id.clone(),
        world_seed_id: seed.seed_id.clone(),
        world_id: seed.world_id.clone(),
        produced_at: seed.produced_at,
        economy_release_id: seed.economy.release.version.clone(),
        economy_release_sha256: seed.economy.release.checksum.clone(),
        economy_projection_sha256,
        source_catalog_sha256,
        world_seed_sha256,
        compiled_catalog_sha256,
        fleet_authority_sha256,
        fleet_authority_catalog_sha256,
        operational_inventory_sha256,
        output_set_sha256,
    };
    let compilation = VehicleCatalogCompilation {
        catalog,
        fleet_authority,
        fleet_authority_catalog,
        operational_inventory,
        receipt,
    };
    validate_compilation(&compilation)?;
    Ok(compilation)
}

pub fn to_pretty_json<T: Serialize>(value: &T) -> Result<String, CatalogCompileError> {
    let mut json = serde_json::to_string_pretty(value)?;
    json.push('\n');
    Ok(json)
}

fn normalize_source_catalog(source: &mut VehicleSourceCatalog) -> Result<(), CatalogCompileError> {
    source.sources.sort_by(|left, right| left.id.cmp(&right.id));
    reject_adjacent_duplicates_by(&source.sources, "sources[].id", |item| item.id.as_str())?;
    source
        .vehicle_types
        .sort_by(|left, right| left.type_id.cmp(&right.type_id));
    reject_adjacent_duplicates_by(&source.vehicle_types, "vehicleTypes[].typeId", |item| {
        item.type_id.as_str()
    })?;
    for vehicle_type in &mut source.vehicle_types {
        normalize_evidenced(&mut vehicle_type.class_designation, "classDesignation")?;
        normalize_evidenced(&mut vehicle_type.trade_name, "tradeName")?;
        normalize_evidenced(&mut vehicle_type.construction_years, "constructionYears")?;
        normalize_evidenced(&mut vehicle_type.role, "role")?;
        normalize_evidenced(&mut vehicle_type.traction, "traction")?;
        normalize_evidenced(&mut vehicle_type.control_stands, "controlStands")?;
        normalize_evidenced(&mut vehicle_type.electric_systems, "electricSystems")?;
        vehicle_type.electric_systems.value.sort();
        reject_adjacent_duplicates(
            &vehicle_type.electric_systems.value,
            "electricSystems.value",
        )?;
        normalize_evidenced(&mut vehicle_type.standard_protection, "standardProtection")?;
        vehicle_type.standard_protection.value.sort();
        reject_adjacent_duplicates(
            &vehicle_type.standard_protection.value,
            "standardProtection.value",
        )?;
        vehicle_type.protection_options.sort_by_key(|option| {
            (
                option.system,
                option.fitment,
                option.years.from,
                option.years.to,
            )
        });
        for option in &mut vehicle_type.protection_options {
            normalize_evidence_declaration(&mut option.evidence, "protectionOptions[].evidence")?;
        }
        normalize_evidenced(&mut vehicle_type.markets.new_build, "markets.newBuild")?;
        normalize_evidenced(&mut vehicle_type.markets.leasing, "markets.leasing")?;
        normalize_evidenced(&mut vehicle_type.markets.used, "markets.used")?;
        normalize_evidenced(&mut vehicle_type.technical.length_mm, "technical.lengthMm")?;
        normalize_evidenced(&mut vehicle_type.technical.mass_kg, "technical.massKg")?;
        normalize_evidenced(
            &mut vehicle_type.technical.maximum_speed_kph,
            "technical.maximumSpeedKph",
        )?;
        normalize_evidenced(
            &mut vehicle_type.technical.continuous_power_kw,
            "technical.continuousPowerKw",
        )?;
        normalize_evidenced(
            &mut vehicle_type.technical.starting_tractive_effort_kn,
            "technical.startingTractiveEffortKn",
        )?;
        normalize_evidenced(
            &mut vehicle_type.technical.brake_weight_kg,
            "technical.brakeWeightKg",
        )?;
        normalize_evidenced(
            &mut vehicle_type
                .operational_profile
                .maximum_acceleration_cap_mmps2,
            "operationalProfile.maximumAccelerationCapMmps2",
        )?;
        normalize_evidenced(
            &mut vehicle_type.operational_profile.service_brake_cap_mmps2,
            "operationalProfile.serviceBrakeCapMmps2",
        )?;
        normalize_evidenced(
            &mut vehicle_type
                .operational_profile
                .emergency_brake_multiplier_basis_points,
            "operationalProfile.emergencyBrakeMultiplierBasisPoints",
        )?;
        normalize_evidenced(&mut vehicle_type.passenger.seats, "passenger.seats")?;
        normalize_evidenced(
            &mut vehicle_type.passenger.first_class_seats,
            "passenger.firstClassSeats",
        )?;
        normalize_evidenced(
            &mut vehicle_type.passenger.accessible,
            "passenger.accessible",
        )?;
        normalize_evidenced(
            &mut vehicle_type.passenger.bicycle_places,
            "passenger.bicyclePlaces",
        )?;
        normalize_evidenced(
            &mut vehicle_type.passenger.wheelchair_places,
            "passenger.wheelchairPlaces",
        )?;
        normalize_evidenced(&mut vehicle_type.passenger.equipment, "passenger.equipment")?;
        vehicle_type.passenger.equipment.value.sort();
        reject_adjacent_duplicates(
            &vehicle_type.passenger.equipment.value,
            "passenger.equipment.value",
        )?;
        normalize_evidenced(
            &mut vehicle_type.passenger.replacement_plan,
            "passenger.replacementPlan",
        )?;
    }
    Ok(())
}

fn normalize_evidenced<T>(
    evidenced: &mut Evidenced<T>,
    field: &str,
) -> Result<(), CatalogCompileError> {
    evidenced.source_ids.sort();
    reject_adjacent_duplicates(&evidenced.source_ids, &format!("{field}.sourceIds"))
}

fn normalize_evidence_declaration(
    evidence: &mut EvidenceDeclaration,
    field: &str,
) -> Result<(), CatalogCompileError> {
    evidence.source_ids.sort();
    reject_adjacent_duplicates(&evidence.source_ids, &format!("{field}.sourceIds"))
}

fn normalize_world_seed(seed: &mut VehicleWorldSeed) -> Result<(), CatalogCompileError> {
    seed.economy
        .release
        .tender_profiles
        .sort_by(|left, right| left.id.cmp(&right.id));
    reject_adjacent_duplicates_by(
        &seed.economy.release.tender_profiles,
        "economy.release.tenderProfiles[].id",
        |item| item.id.as_str(),
    )?;
    seed.economy
        .operating_costs
        .sort_by(|left, right| left.type_id.cmp(&right.type_id));
    reject_adjacent_duplicates_by(
        &seed.economy.operating_costs,
        "economy.operatingCosts[].typeId",
        |item| item.type_id.as_str(),
    )?;
    seed.assets.sort_by(|left, right| left.id.cmp(&right.id));
    reject_adjacent_duplicates_by(&seed.assets, "assets[].id", |item| item.id.as_str())?;
    for asset in &mut seed.assets {
        if let Some(configuration) = &mut asset.vehicle_configuration {
            configuration.normalize();
        }
        asset.approved_line_ids.sort();
        reject_adjacent_duplicates(&asset.approved_line_ids, "assets[].approvedLineIds")?;
        asset
            .maintenance_deadlines
            .sort_by(|left, right| left.kind.cmp(&right.kind));
        reject_adjacent_duplicates_by(
            &asset.maintenance_deadlines,
            "assets[].maintenanceDeadlines[].kind",
            |item| item.kind.as_str(),
        )?;
        asset.installed_protection.sort();
        reject_adjacent_duplicates(&asset.installed_protection, "assets[].installedProtection")?;
    }
    seed.formations
        .sort_by(|left, right| left.id.cmp(&right.id));
    reject_adjacent_duplicates_by(&seed.formations, "formations[].id", |item| item.id.as_str())?;
    for formation in &seed.formations {
        reject_duplicates_preserving_order(&formation.vehicle_ids, "formations[].vehicleIds")?;
    }
    seed.personnel_pools
        .sort_by(|left, right| left.id.cmp(&right.id));
    reject_adjacent_duplicates_by(&seed.personnel_pools, "personnelPools[].id", |item| {
        item.id.as_str()
    })?;
    for pool in &mut seed.personnel_pools {
        pool.class_designations.sort();
        reject_adjacent_duplicates(
            &pool.class_designations,
            "personnelPools[].classDesignations",
        )?;
        pool.path_receipt_ids.sort();
        reject_adjacent_duplicates(&pool.path_receipt_ids, "personnelPools[].pathReceiptIds")?;
    }
    seed.path_receipts
        .sort_by(|left, right| left.id.cmp(&right.id));
    reject_adjacent_duplicates_by(&seed.path_receipts, "pathReceipts[].id", |item| {
        item.id.as_str()
    })?;
    for receipt in &mut seed.path_receipts {
        receipt.service_line_ids.sort();
        reject_adjacent_duplicates(&receipt.service_line_ids, "pathReceipts[].serviceLineIds")?;
        receipt.platform_lengths_mm.sort();
        reject_adjacent_duplicates(
            &receipt.platform_lengths_mm,
            "pathReceipts[].platformLengthsMm",
        )?;
        receipt.electrifications.sort();
        reject_adjacent_duplicates(&receipt.electrifications, "pathReceipts[].electrifications")?;
        receipt.required_protection.sort();
        reject_adjacent_duplicates(
            &receipt.required_protection,
            "pathReceipts[].requiredProtection",
        )?;
        receipt.approved_classes.sort();
        reject_adjacent_duplicates(&receipt.approved_classes, "pathReceipts[].approvedClasses")?;
    }
    Ok(())
}

fn reject_adjacent_duplicates<T: PartialEq>(
    values: &[T],
    field: &str,
) -> Result<(), CatalogCompileError> {
    if values.windows(2).any(|pair| pair[0] == pair[1]) {
        return invalid(format!("{field} enthaelt Duplikate"));
    }
    Ok(())
}

fn reject_adjacent_duplicates_by<'a, T>(
    values: &'a [T],
    field: &str,
    key: impl Fn(&'a T) -> &'a str,
) -> Result<(), CatalogCompileError> {
    if values.windows(2).any(|pair| key(&pair[0]) == key(&pair[1])) {
        return invalid(format!("{field} enthaelt Duplikate"));
    }
    Ok(())
}

fn reject_duplicates_preserving_order<T: Ord>(
    values: &[T],
    field: &str,
) -> Result<(), CatalogCompileError> {
    let mut seen = BTreeSet::new();
    if values.iter().any(|item| !seen.insert(item)) {
        return invalid(format!("{field} enthaelt Duplikate"));
    }
    Ok(())
}

fn compile_type_release(
    source: &VehicleSourceCatalog,
) -> Result<CompiledVehicleCatalogRelease, CatalogCompileError> {
    require_schema(
        &source.schema_version,
        SOURCE_CATALOG_SCHEMA,
        "source catalog",
    )?;
    require_identifier(&source.release_id, "releaseId")?;
    if source.reference_year == 0 {
        return invalid("referenceYear muss positiv sein");
    }
    if source.sources.is_empty() || source.vehicle_types.is_empty() {
        return invalid("Quellkatalog braucht Quellen und Fahrzeugtypen");
    }

    let mut source_by_id = BTreeMap::new();
    for catalog_source in &source.sources {
        validate_source(catalog_source)?;
        if source_by_id
            .insert(catalog_source.id.as_str(), catalog_source)
            .is_some()
        {
            return invalid(format!("doppelte Quellenkennung '{}'", catalog_source.id));
        }
    }

    let mut numeric_ids = BTreeSet::new();
    let mut class_by_type = BTreeMap::new();
    let mut used_sources = BTreeSet::new();
    let mut compiled_types = Vec::with_capacity(source.vehicle_types.len());
    for vehicle_type in &source.vehicle_types {
        require_identifier(&vehicle_type.type_id, "vehicleTypes[].typeId")?;
        require_safe_positive(vehicle_type.numeric_id, "vehicleTypes[].numericId")?;
        if !numeric_ids.insert(vehicle_type.numeric_id) {
            return invalid(format!(
                "doppelte numerische Typkennung {}",
                vehicle_type.numeric_id
            ));
        }
        let compiled = compile_vehicle_type(vehicle_type, &source_by_id, &mut used_sources)?;
        if let Some(existing) =
            class_by_type.insert(compiled.type_id.clone(), compiled.class_designation.clone())
        {
            return invalid(format!(
                "Typ '{}' wurde mehrfach als '{}' und '{}' definiert",
                compiled.type_id, existing, compiled.class_designation
            ));
        }
        compiled_types.push(compiled);
    }
    let all_sources: BTreeSet<_> = source_by_id.keys().copied().collect();
    if used_sources != all_sources {
        let unused = all_sources
            .difference(&used_sources)
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        return invalid(format!("ungenutzte freigegebene Quellen: {unused}"));
    }
    let sources = source
        .sources
        .iter()
        .map(|item| CompiledCatalogSource {
            id: item.id.clone(),
            title: item.title.clone(),
            url: item.url.clone(),
            license: item.license.clone(),
            retrieved_at: item.retrieved_at.clone(),
            content_sha256: item.content_sha256.clone(),
            rights_decision: item.rights_decision.clone(),
        })
        .collect();
    Ok(CompiledVehicleCatalogRelease {
        schema_version: COMPILED_CATALOG_SCHEMA.to_owned(),
        release_id: source.release_id.clone(),
        reference_year: source.reference_year,
        sources,
        vehicle_types: compiled_types,
    })
}

fn validate_source(source: &CatalogEvidenceSource) -> Result<(), CatalogCompileError> {
    require_identifier(&source.id, "sources[].id")?;
    require_non_empty(&source.title, "sources[].title")?;
    if !source.url.starts_with("https://") || source.url.chars().any(char::is_whitespace) {
        return invalid(format!(
            "Quelle '{}' braucht eine gueltige HTTPS-Fundstelle",
            source.id
        ));
    }
    require_non_empty(&source.license, "sources[].license")?;
    validate_date(&source.retrieved_at, "sources[].retrievedAt")?;
    validate_sha256(&source.content_sha256, "sources[].contentSha256")?;
    if source.rights_decision.status != SourceRightsStatus::Freigegeben {
        return invalid(format!(
            "Quelle '{}' ist nicht freigegeben ({:?})",
            source.id, source.rights_decision.status
        ));
    }
    validate_date(
        &source.rights_decision.decided_at,
        "sources[].rightsDecision.decidedAt",
    )?;
    if source.rights_decision.decided_at < source.retrieved_at {
        return invalid(format!(
            "Quelle '{}': Rechteentscheidung liegt vor dem Quellenabruf",
            source.id
        ));
    }
    require_non_empty(
        &source.rights_decision.reviewer,
        "sources[].rightsDecision.reviewer",
    )?;
    require_non_empty(
        &source.rights_decision.reference,
        "sources[].rightsDecision.reference",
    )?;
    Ok(())
}

fn compile_vehicle_type<'a>(
    source: &SourceVehicleType,
    sources: &BTreeMap<&'a str, &CatalogEvidenceSource>,
    used_sources: &mut BTreeSet<&'a str>,
) -> Result<CompiledVehicleType, CatalogCompileError> {
    let mut evidence = BTreeMap::new();
    record_evidence(
        "classDesignation",
        &source.class_designation,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "tradeName",
        &source.trade_name,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "constructionYears",
        &source.construction_years,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence("role", &source.role, sources, used_sources, &mut evidence)?;
    record_evidence(
        "traction",
        &source.traction,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "controlStands",
        &source.control_stands,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "electricSystems",
        &source.electric_systems,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "standardProtection",
        &source.standard_protection,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "markets.newBuild",
        &source.markets.new_build,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "markets.leasing",
        &source.markets.leasing,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "markets.used",
        &source.markets.used,
        sources,
        used_sources,
        &mut evidence,
    )?;
    let mut compiled_options = Vec::with_capacity(source.protection_options.len());
    for (index, option) in source.protection_options.iter().enumerate() {
        let field = format!("protectionOptions[{index}]");
        let compiled_evidence =
            validate_evidence_declaration(&field, &option.evidence, sources, used_sources)?;
        compiled_options.push(CompiledProtectionOption {
            system: option.system,
            fitment: option.fitment,
            years: option.years,
            evidence: compiled_evidence.clone(),
        });
        evidence.insert(field, compiled_evidence);
    }
    record_evidence(
        "technical.lengthMm",
        &source.technical.length_mm,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "technical.massKg",
        &source.technical.mass_kg,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "technical.maximumSpeedKph",
        &source.technical.maximum_speed_kph,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "technical.continuousPowerKw",
        &source.technical.continuous_power_kw,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "technical.startingTractiveEffortKn",
        &source.technical.starting_tractive_effort_kn,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "technical.brakeWeightKg",
        &source.technical.brake_weight_kg,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "operationalProfile.maximumAccelerationCapMmps2",
        &source.operational_profile.maximum_acceleration_cap_mmps2,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "operationalProfile.serviceBrakeCapMmps2",
        &source.operational_profile.service_brake_cap_mmps2,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "operationalProfile.emergencyBrakeMultiplierBasisPoints",
        &source
            .operational_profile
            .emergency_brake_multiplier_basis_points,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "passenger.seats",
        &source.passenger.seats,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "passenger.firstClassSeats",
        &source.passenger.first_class_seats,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "passenger.accessible",
        &source.passenger.accessible,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "passenger.bicyclePlaces",
        &source.passenger.bicycle_places,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "passenger.wheelchairPlaces",
        &source.passenger.wheelchair_places,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "passenger.equipment",
        &source.passenger.equipment,
        sources,
        used_sources,
        &mut evidence,
    )?;
    record_evidence(
        "passenger.replacementPlan",
        &source.passenger.replacement_plan,
        sources,
        used_sources,
        &mut evidence,
    )?;

    validate_type_facts(source)?;
    let operational_profile = derive_source_operational_profile(source)?;
    Ok(CompiledVehicleType {
        type_id: source.type_id.clone(),
        numeric_id: source.numeric_id,
        class_designation: source.class_designation.value.clone(),
        trade_name: source.trade_name.value.clone(),
        construction_years: source.construction_years.value,
        role: source.role.value,
        traction: source.traction.value,
        control_stands: source.control_stands.value,
        electric_systems: source.electric_systems.value.clone(),
        standard_protection: source.standard_protection.value.clone(),
        protection_options: compiled_options,
        markets: CompiledMarkets {
            new_build: source.markets.new_build.value,
            leasing: source.markets.leasing.value,
            used: source.markets.used.value,
        },
        technical: CompiledTechnicalFacts {
            length_mm: source.technical.length_mm.value,
            mass_kg: source.technical.mass_kg.value,
            maximum_speed_kph: source.technical.maximum_speed_kph.value,
            continuous_power_kw: source.technical.continuous_power_kw.value,
            starting_tractive_effort_kn: source.technical.starting_tractive_effort_kn.value,
            brake_weight_kg: source.technical.brake_weight_kg.value,
        },
        operational_profile,
        passenger: CompiledPassengerFacts {
            seats: source.passenger.seats.value,
            first_class_seats: source.passenger.first_class_seats.value,
            accessible: source.passenger.accessible.value,
            bicycle_places: source.passenger.bicycle_places.value,
            wheelchair_places: source.passenger.wheelchair_places.value,
            equipment: source.passenger.equipment.value.clone(),
            replacement_plan: source.passenger.replacement_plan.value,
        },
        evidence,
    })
}

fn record_evidence<'a, T>(
    field: &str,
    source: &Evidenced<T>,
    sources: &BTreeMap<&'a str, &CatalogEvidenceSource>,
    used_sources: &mut BTreeSet<&'a str>,
    output: &mut BTreeMap<String, CompiledFieldEvidence>,
) -> Result<(), CatalogCompileError> {
    let compiled = validate_evidence_fields(
        field,
        source.kind,
        source.confidence_basis_points,
        &source.method,
        &source.source_ids,
        sources,
        used_sources,
    )?;
    if output.insert(field.to_owned(), compiled).is_some() {
        return invalid(format!("doppelter Evidenzpfad '{field}'"));
    }
    Ok(())
}

fn validate_evidence_declaration<'a>(
    field: &str,
    source: &EvidenceDeclaration,
    sources: &BTreeMap<&'a str, &CatalogEvidenceSource>,
    used_sources: &mut BTreeSet<&'a str>,
) -> Result<CompiledFieldEvidence, CatalogCompileError> {
    validate_evidence_fields(
        field,
        source.kind,
        source.confidence_basis_points,
        &source.method,
        &source.source_ids,
        sources,
        used_sources,
    )
}

fn validate_evidence_fields<'a>(
    field: &str,
    kind: EvidenceKind,
    confidence_basis_points: u16,
    method: &str,
    source_ids: &[String],
    sources: &BTreeMap<&'a str, &CatalogEvidenceSource>,
    used_sources: &mut BTreeSet<&'a str>,
) -> Result<CompiledFieldEvidence, CatalogCompileError> {
    if confidence_basis_points == 0 || confidence_basis_points > BASIS_POINTS_MAX {
        return invalid(format!(
            "{field}.confidenceBasisPoints muss zwischen 1 und {BASIS_POINTS_MAX} liegen"
        ));
    }
    require_non_empty(method, &format!("{field}.method"))?;
    match kind {
        EvidenceKind::PublishedFact => {
            if source_ids.is_empty() {
                return invalid(format!("{field} besitzt keinen Quellenbeleg"));
            }
            for source_id in source_ids {
                let Some((known_id, known)) = sources.get_key_value(source_id.as_str()) else {
                    return invalid(format!(
                        "{field} referenziert unbekannte Quelle '{source_id}'"
                    ));
                };
                if known.rights_decision.status != SourceRightsStatus::Freigegeben {
                    return invalid(format!(
                        "{field} referenziert nicht freigegebene Quelle '{source_id}'"
                    ));
                }
                used_sources.insert(*known_id);
            }
        }
        EvidenceKind::DeterministicDerivation => {
            return invalid(format!(
                "{field} behauptet eine nicht registrierte deterministische Ableitung; Quellfelder duerfen nur published-fact oder game-assumption verwenden"
            ));
        }
        EvidenceKind::GameAssumption => {
            if !source_ids.is_empty() {
                return invalid(format!(
                    "{field} ist eine Spielannahme und darf keine Fremdquelle vortaeuschen"
                ));
            }
        }
    }
    Ok(CompiledFieldEvidence {
        kind,
        confidence_basis_points,
        method: method.to_owned(),
        source_ids: source_ids.to_vec(),
    })
}

fn validate_type_facts(source: &SourceVehicleType) -> Result<(), CatalogCompileError> {
    require_non_empty(
        &source.class_designation.value,
        "vehicleTypes[].classDesignation.value",
    )?;
    FleetClass::new(source.class_designation.value.clone()).map_err(|error| {
        CatalogCompileError::Invalid(format!(
            "Typ '{}' besitzt ungueltige classDesignation: {error}",
            source.type_id
        ))
    })?;
    require_non_empty(&source.trade_name.value, "vehicleTypes[].tradeName.value")?;
    if source.trade_name.kind != EvidenceKind::GameAssumption
        || !source.trade_name.source_ids.is_empty()
    {
        return invalid(format!(
            "Typ '{}': tradeName muss eine unbelegte game-assumption gemaess E6 sein",
            source.type_id
        ));
    }
    let years = source.construction_years.value;
    if years.from == 0 || years.from > years.to {
        return invalid(format!(
            "Typ '{}' besitzt ungueltige Baujahre",
            source.type_id
        ));
    }
    let technical = &source.technical;
    if !(1_000..=500_000).contains(&technical.length_mm.value) {
        return invalid(format!(
            "Typ '{}' besitzt unplausible lengthMm-Einheit",
            source.type_id
        ));
    }
    if !(1_000..=2_000_000).contains(&technical.mass_kg.value) {
        return invalid(format!(
            "Typ '{}' besitzt unplausible massKg-Einheit",
            source.type_id
        ));
    }
    if !(1..=500).contains(&technical.maximum_speed_kph.value) {
        return invalid(format!(
            "Typ '{}' besitzt unplausible maximumSpeedKph-Einheit",
            source.type_id
        ));
    }
    if technical.brake_weight_kg.value == 0 || technical.brake_weight_kg.value > 4_000_000 {
        return invalid(format!(
            "Typ '{}' besitzt unplausibles Bremsgewicht",
            source.type_id
        ));
    }
    if technical.continuous_power_kw.value > MAX_CONTINUOUS_POWER_KW {
        return invalid(format!(
            "Typ '{}' besitzt unplausible continuousPowerKw-Einheit",
            source.type_id
        ));
    }
    if technical.starting_tractive_effort_kn.value > MAX_STARTING_TRACTIVE_EFFORT_KN {
        return invalid(format!(
            "Typ '{}' besitzt unplausible startingTractiveEffortKn-Einheit",
            source.type_id
        ));
    }
    if source.operational_profile.schema_version != OPERATIONAL_PROFILE_SCHEMA {
        return invalid(format!(
            "Typ '{}' nutzt unbekanntes Ableitungsprofil '{}'",
            source.type_id, source.operational_profile.schema_version
        ));
    }
    let powered = source.role.value.is_powered();
    if powered != (source.traction.value != VehicleTraction::Unpowered) {
        return invalid(format!(
            "Typ '{}' widerspricht Rolle und Traktionsart",
            source.type_id
        ));
    }
    let has_cab = source.control_stands.value.front || source.control_stands.value.rear;
    match source.role.value {
        VehicleRole::Coach if has_cab => {
            return invalid(format!(
                "Reisezugwagen '{}' darf keinen Fuehrerstand besitzen",
                source.type_id
            ));
        }
        VehicleRole::ControlCar if !has_cab => {
            return invalid(format!(
                "Steuerwagen '{}' braucht mindestens einen Fuehrerstand",
                source.type_id
            ));
        }
        VehicleRole::PoweredUnit | VehicleRole::Locomotive if !has_cab => {
            return invalid(format!(
                "angetriebener Typ '{}' braucht mindestens einen Fuehrerstand",
                source.type_id
            ));
        }
        _ => {}
    }
    let needs_electric_system = matches!(
        source.traction.value,
        VehicleTraction::Electric | VehicleTraction::Battery
    );
    if needs_electric_system == source.electric_systems.value.is_empty() {
        return invalid(format!(
            "Typ '{}' besitzt inkonsistente elektrische Systeme",
            source.type_id
        ));
    }
    let raw_power = technical.continuous_power_kw.value;
    let tractive_effort = technical.starting_tractive_effort_kn.value;
    if powered {
        if raw_power == 0 || tractive_effort == 0 {
            return invalid(format!(
                "angetriebener Typ '{}' braucht Leistung und Anfahrzugkraft",
                source.type_id
            ));
        }
    } else if raw_power != 0 || tractive_effort != 0 {
        return invalid(format!(
            "nicht angetriebener Typ '{}' darf keine Antriebswerte besitzen",
            source.type_id
        ));
    }
    let profile = derive_source_operational_profile(source)?;
    if profile.service_brake_mmps2 == 0
        || profile.emergency_brake_mmps2 <= profile.service_brake_mmps2
    {
        return invalid(format!(
            "Typ '{}' braucht getrennte positive Betriebs- und Schnellbremswerte",
            source.type_id
        ));
    }
    validate_protection(
        &source.standard_protection.value,
        source.role.value != VehicleRole::Coach,
        &format!("Typ '{}'", source.type_id),
    )?;
    for (name, market) in [
        ("new-build", source.markets.new_build.value),
        ("leasing", source.markets.leasing.value),
        ("used", source.markets.used.value),
    ] {
        if market.from == 0 || market.from > market.to {
            return invalid(format!(
                "Typ '{}' besitzt ungueltiges {name}-Marktfenster",
                source.type_id
            ));
        }
    }
    let new_build = source.markets.new_build.value;
    if new_build.from < years.from || new_build.to > years.to {
        return invalid(format!(
            "Typ '{}': new-build-Marktfenster muss innerhalb constructionYears liegen",
            source.type_id
        ));
    }
    let mut option_keys = BTreeSet::new();
    for option in &source.protection_options {
        if option.years.from == 0 || option.years.from > option.years.to {
            return invalid(format!(
                "Typ '{}' besitzt ungueltiges Zugsicherungs-Optionsfenster",
                source.type_id
            ));
        }
        if option.fitment == ProtectionFitment::FactoryOption
            && (option.years.from < years.from || option.years.to > years.to)
        {
            return invalid(format!(
                "Typ '{}': factory-option muss innerhalb constructionYears liegen",
                source.type_id
            ));
        }
        if source.standard_protection.value.contains(&option.system) {
            return invalid(format!(
                "Typ '{}': Zugsicherungsoption {:?} dupliziert Serienausruestung",
                source.type_id, option.system
            ));
        }
        if !option_keys.insert((option.system, option.fitment)) {
            return invalid(format!(
                "Typ '{}' besitzt doppelte Zugsicherungsoption",
                source.type_id
            ));
        }
        if option.system == VehicleProtectionSystem::Lzb
            && !source
                .standard_protection
                .value
                .contains(&VehicleProtectionSystem::Pzb)
        {
            return invalid(format!(
                "Typ '{}': LZB-Option erfordert serienmaessiges PZB",
                source.type_id
            ));
        }
    }
    if source.passenger.first_class_seats.value > source.passenger.seats.value {
        return invalid(format!(
            "Typ '{}' besitzt mehr Erste-Klasse- als Gesamtplaetze",
            source.type_id
        ));
    }
    if source.role.value != VehicleRole::Locomotive && source.passenger.seats.value == 0 {
        return invalid(format!(
            "nichtlokomotiver Typ '{}' braucht Fahrgastplaetze",
            source.type_id
        ));
    }
    for equipment in &source.passenger.equipment.value {
        require_identifier(equipment, "passenger.equipment.value[]")?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OperationalProfileInput {
    role: VehicleRole,
    mass_kg: u64,
    starting_tractive_effort_kn: u32,
    brake_weight_kg: u64,
    maximum_acceleration_cap_mmps2: u32,
    service_brake_cap_mmps2: u32,
    emergency_brake_multiplier_basis_points: u16,
}

fn derive_source_operational_profile(
    source: &SourceVehicleType,
) -> Result<CompiledOperationalProfile, CatalogCompileError> {
    let profile = &source.operational_profile;
    for (field, kind) in [
        (
            "maximumAccelerationCapMmps2",
            profile.maximum_acceleration_cap_mmps2.kind,
        ),
        ("serviceBrakeCapMmps2", profile.service_brake_cap_mmps2.kind),
        (
            "emergencyBrakeMultiplierBasisPoints",
            profile.emergency_brake_multiplier_basis_points.kind,
        ),
    ] {
        if kind != EvidenceKind::GameAssumption {
            return invalid(format!(
                "Typ '{}': operationalProfile.{field} muss eine sichtbare Spielannahme sein",
                source.type_id
            ));
        }
    }
    let acceleration_cap = profile.maximum_acceleration_cap_mmps2.value;
    let service_cap = profile.service_brake_cap_mmps2.value;
    let emergency_multiplier = profile.emergency_brake_multiplier_basis_points.value;
    let powered = source.role.value.is_powered();
    if (powered && !(1..=MAX_ACCELERATION_MMPS2).contains(&acceleration_cap))
        || (!powered && acceleration_cap != 0)
        || !(1..=MAX_BRAKE_MMPS2).contains(&service_cap)
        || !(10_001..=30_000).contains(&emergency_multiplier)
    {
        return invalid(format!(
            "Typ '{}' besitzt unplausible Operational-Profilparameter",
            source.type_id
        ));
    }

    derive_operational_profile(
        source.role.value,
        source.technical.mass_kg.value,
        source.technical.starting_tractive_effort_kn.value,
        source.technical.brake_weight_kg.value,
        acceleration_cap,
        service_cap,
        emergency_multiplier,
    )
}

fn derive_operational_profile(
    role: VehicleRole,
    mass_kg: u64,
    starting_tractive_effort_kn: u32,
    brake_weight_kg: u64,
    acceleration_cap: u32,
    service_cap: u32,
    emergency_multiplier: u16,
) -> Result<CompiledOperationalProfile, CatalogCompileError> {
    let powered = role.is_powered();
    if mass_kg == 0
        || brake_weight_kg == 0
        || (powered && starting_tractive_effort_kn == 0)
        || (!powered && starting_tractive_effort_kn != 0)
        || (powered && !(1..=MAX_ACCELERATION_MMPS2).contains(&acceleration_cap))
        || (!powered && acceleration_cap != 0)
        || !(1..=MAX_BRAKE_MMPS2).contains(&service_cap)
        || !(10_001..=30_000).contains(&emergency_multiplier)
    {
        return invalid("Operational-Profil besitzt unplausible Ableitungseingaben");
    }
    let input = OperationalProfileInput {
        role,
        mass_kg,
        starting_tractive_effort_kn,
        brake_weight_kg,
        maximum_acceleration_cap_mmps2: acceleration_cap,
        service_brake_cap_mmps2: service_cap,
        emergency_brake_multiplier_basis_points: emergency_multiplier,
    };
    let effective_starting_tractive_force_newtons = u64::from(input.starting_tractive_effort_kn)
        .checked_mul(1_000)
        .ok_or_else(|| {
            CatalogCompileError::Invalid(
                "Anfahrzugkraft laeuft bei der Umrechnung ueber".to_owned(),
            )
        })?;
    let derived = derive_formation_dynamics(FormationDynamicsDerivationInput {
        total_mass_kg: input.mass_kg,
        effective_starting_tractive_force_newtons,
        total_brake_weight_kg: input.brake_weight_kg,
        maximum_acceleration_cap_mmps2: acceleration_cap,
        service_brake_cap_mmps2: service_cap,
        emergency_brake_multiplier_basis_points: emergency_multiplier,
    })
    .map_err(|error| {
        CatalogCompileError::Invalid(format!(
            "Operational-Profil besitzt unplausible abgeleitete Fahrdynamik: {error:?}"
        ))
    })?;
    Ok(CompiledOperationalProfile {
        schema_version: OPERATIONAL_PROFILE_SCHEMA.to_owned(),
        input_sha256: hash_json(&input)?,
        maximum_acceleration_cap_mmps2: acceleration_cap,
        service_brake_cap_mmps2: service_cap,
        emergency_brake_multiplier_basis_points: emergency_multiplier,
        maximum_acceleration_mmps2: derived.acceleration_mmps2,
        service_brake_mmps2: derived.service_brake_mmps2,
        emergency_brake_mmps2: derived.emergency_brake_mmps2,
    })
}

fn compile_world(
    catalog: &CompiledVehicleCatalogRelease,
    seed: &VehicleWorldSeed,
) -> Result<(FleetAuthorityRelease, OperationalVehicleInventory), CatalogCompileError> {
    require_schema(&seed.schema_version, WORLD_SEED_SCHEMA, "world seed")?;
    require_identifier(&seed.seed_id, "seedId")?;
    require_identifier(&seed.authority_release_id, "authorityReleaseId")?;
    require_identifier(&seed.operational_release_id, "operationalReleaseId")?;
    require_canonical_uuid(&seed.world_id, "worldId")?;
    require_safe_integer(seed.produced_at, "producedAt")?;
    if seed.catalog_release_id != catalog.release_id {
        return invalid(format!(
            "World-Seed bindet Katalog '{}', Compiler erhielt '{}'",
            seed.catalog_release_id, catalog.release_id
        ));
    }
    if seed.assets.is_empty() {
        return invalid("World-Seed braucht konkrete Assets");
    }

    let type_by_id: BTreeMap<_, _> = catalog
        .vehicle_types
        .iter()
        .map(|item| (item.type_id.as_str(), item))
        .collect();
    let classes: BTreeSet<_> = catalog
        .vehicle_types
        .iter()
        .map(|item| item.class_designation.as_str())
        .collect();
    let economy_costs = validate_economy_projection(&seed.economy, &seed.assets, &type_by_id)?;
    validate_path_receipts(&seed.path_receipts, &classes)?;
    let receipt_by_id: BTreeMap<_, _> = seed
        .path_receipts
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    validate_personnel_pools(&seed.personnel_pools, &classes, &receipt_by_id)?;

    let operational_types = catalog
        .vehicle_types
        .iter()
        .map(operational_vehicle_type)
        .collect::<Result<Vec<_>, _>>()?;
    let mut numeric_asset_ids = BTreeSet::new();
    let mut authority_assets = Vec::with_capacity(seed.assets.len());
    let mut physical_vehicles = Vec::with_capacity(seed.assets.len());
    let mut seed_asset_by_id = BTreeMap::new();
    for asset in &seed.assets {
        if seed_asset_by_id.insert(asset.id.as_str(), asset).is_some() {
            return invalid(format!("doppelte Assetkennung '{}'", asset.id));
        }
        if !numeric_asset_ids.insert(asset.numeric_id) {
            return invalid(format!(
                "doppelte numerische Assetkennung {}",
                asset.numeric_id
            ));
        }
        let vehicle_type = type_by_id.get(asset.type_id.as_str()).ok_or_else(|| {
            CatalogCompileError::Invalid(format!(
                "Asset '{}' referenziert unbekannten Typ '{}'",
                asset.id, asset.type_id
            ))
        })?;
        validate_seed_asset(
            asset,
            vehicle_type,
            catalog.reference_year,
            seed.produced_at,
        )?;
        let operating_cost = *economy_costs.get(asset.type_id.as_str()).ok_or_else(|| {
            CatalogCompileError::Invalid(format!(
                "Asset '{}' besitzt keinen EconomyRelease-Fahrzeugkostensatz",
                asset.id
            ))
        })?;
        authority_assets.push(authority_asset(asset, vehicle_type, operating_cost)?);
        physical_vehicles.push(physical_vehicle(asset, vehicle_type)?);
    }

    let operational_type_by_id: BTreeMap<_, _> = operational_types
        .iter()
        .map(|item| (item.vehicle_type.id.as_str(), item))
        .collect();
    let physical_by_id: BTreeMap<_, _> = physical_vehicles
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let mut assigned_vehicles = BTreeSet::new();
    let mut formations = Vec::with_capacity(seed.formations.len());
    for formation in &seed.formations {
        require_identifier(&formation.id, "formations[].id")?;
        if formation.vehicle_ids.is_empty() {
            return invalid(format!("Formation '{}' ist leer", formation.id));
        }
        if formation.predecessor_id.as_deref() == Some(formation.id.as_str()) {
            return invalid(format!(
                "Formation '{}' darf nicht ihr eigener Vorgaenger sein",
                formation.id
            ));
        }
        let receipt = receipt_by_id
            .get(formation.path_receipt_id.as_str())
            .ok_or_else(|| {
                CatalogCompileError::Invalid(format!(
                    "Formation '{}' referenziert unbekannten Trassenbeleg '{}'",
                    formation.id, formation.path_receipt_id
                ))
            })?;
        if receipt.decision != AuthorityPathDecision::Confirmed
            || seed.produced_at < receipt.valid_from
            || seed.produced_at >= receipt.valid_until
        {
            return invalid(format!(
                "Formation '{}' besitzt keinen gueltigen bestaetigten Trassenbeleg",
                formation.id
            ));
        }
        let mut powered_configuration: Option<(&str, VehicleTraction, &[VehiclePowerSystem])> =
            None;
        let mut formation_seats = 0_u32;
        let mut formation_first_class_seats = 0_u32;
        let mut formation_bicycle_places = 0_u16;
        let mut formation_wheelchair_places = 0_u16;
        let mut formation_operating_cost = 0_u32;
        for vehicle_id in &formation.vehicle_ids {
            require_identifier(vehicle_id, "formations[].vehicleIds[]")?;
            if !assigned_vehicles.insert(vehicle_id.as_str()) {
                return invalid(format!(
                    "Asset '{vehicle_id}' ist mehreren Formationen zugeordnet"
                ));
            }
            let asset = seed_asset_by_id.get(vehicle_id.as_str()).ok_or_else(|| {
                CatalogCompileError::Invalid(format!(
                    "Formation '{}' referenziert unbekanntes Asset '{vehicle_id}'",
                    formation.id
                ))
            })?;
            let vehicle_type = type_by_id.get(asset.type_id.as_str()).ok_or_else(|| {
                CatalogCompileError::Invalid(format!(
                    "Asset '{}' verlor seine Katalogtyp-Bindung",
                    asset.id
                ))
            })?;
            if vehicle_type.traction != VehicleTraction::Unpowered {
                if let Some((first_asset_id, traction, electric_systems)) = powered_configuration {
                    if traction != vehicle_type.traction
                        || electric_systems != vehicle_type.electric_systems.as_slice()
                    {
                        return invalid(format!(
                            "Formation '{}' mischt angetriebene Assets '{}' und '{}' mit unterschiedlicher Traktion oder Stromsystemmenge",
                            formation.id, first_asset_id, asset.id
                        ));
                    }
                } else {
                    powered_configuration = Some((
                        asset.id.as_str(),
                        vehicle_type.traction,
                        vehicle_type.electric_systems.as_slice(),
                    ));
                }
            }
            formation_seats = formation_seats
                .checked_add(vehicle_type.passenger.seats)
                .ok_or_else(|| {
                    CatalogCompileError::Invalid(format!(
                        "Formation '{}' laesst die Fleet-Sitzplatzsumme ueberlaufen",
                        formation.id
                    ))
                })?;
            formation_first_class_seats = formation_first_class_seats
                .checked_add(vehicle_type.passenger.first_class_seats)
                .ok_or_else(|| {
                    CatalogCompileError::Invalid(format!(
                        "Formation '{}' laesst die Fleet-Erste-Klasse-Summe ueberlaufen",
                        formation.id
                    ))
                })?;
            formation_bicycle_places = formation_bicycle_places
                .checked_add(vehicle_type.passenger.bicycle_places)
                .ok_or_else(|| {
                    CatalogCompileError::Invalid(format!(
                        "Formation '{}' laesst die Fleet-Fahrradplatzsumme ueberlaufen",
                        formation.id
                    ))
                })?;
            formation_wheelchair_places = formation_wheelchair_places
                .checked_add(vehicle_type.passenger.wheelchair_places)
                .ok_or_else(|| {
                    CatalogCompileError::Invalid(format!(
                        "Formation '{}' laesst die Fleet-Rollstuhlplatzsumme ueberlaufen",
                        formation.id
                    ))
                })?;
            formation_operating_cost = formation_operating_cost
                .checked_add(*economy_costs.get(asset.type_id.as_str()).ok_or_else(|| {
                    CatalogCompileError::Invalid(format!(
                        "Asset '{}' verlor seinen EconomyRelease-Fahrzeugkostensatz",
                        asset.id
                    ))
                })?)
                .ok_or_else(|| {
                    CatalogCompileError::Invalid(format!(
                        "Formation '{}' laesst die Fleet-Betriebskostensumme ueberlaufen",
                        formation.id
                    ))
                })?;
        }
        let performance = derive_formation_performance(
            &formation.id,
            &formation.vehicle_ids,
            &physical_by_id,
            &operational_type_by_id,
        )?;
        if performance.mobile {
            for vehicle_id in &formation.vehicle_ids {
                let asset = seed_asset_by_id.get(vehicle_id.as_str()).ok_or_else(|| {
                    CatalogCompileError::Invalid(format!(
                        "Formation '{}' referenziert unbekanntes Asset '{vehicle_id}'",
                        formation.id
                    ))
                })?;
                let vehicle_type = type_by_id.get(asset.type_id.as_str()).ok_or_else(|| {
                    CatalogCompileError::Invalid(format!(
                        "Asset '{}' verlor seine Katalogtyp-Bindung",
                        asset.id
                    ))
                })?;
                validate_asset_against_receipt(asset, vehicle_type, receipt)?;
            }
            if receipt
                .platform_lengths_mm
                .iter()
                .any(|length| *length < i64::from(performance.length_mm))
            {
                return invalid(format!(
                    "Formation '{}' ist laenger als mindestens ein freigegebener Bahnsteig",
                    formation.id
                ));
            }
            for required in &receipt.required_protection {
                if !performance
                    .protection_systems
                    .contains(required.operational_name())
                {
                    return invalid(format!(
                        "Formation '{}' erfuellt die geforderte Zugsicherung {:?} nicht",
                        formation.id, required
                    ));
                }
            }
        }
        formations.push(OperationalFormation {
            id: formation.id.clone(),
            predecessor_id: formation.predecessor_id.clone(),
            vehicle_ids: formation.vehicle_ids.clone(),
            path_receipt_id: formation.path_receipt_id.clone(),
            performance,
        });
    }
    let fleet_authority = FleetAuthorityRelease {
        schema_version: FLEET_AUTHORITY_SCHEMA.to_owned(),
        release_id: seed.authority_release_id.clone(),
        reference_year: catalog.reference_year,
        economy_release_id: seed.economy.release.version.clone(),
        economy_release_sha256: seed.economy.release.checksum.clone(),
        assets: authority_assets,
        personnel_pools: seed.personnel_pools.clone(),
        path_receipts: seed.path_receipts.clone(),
    };
    let operational_inventory = OperationalVehicleInventory {
        schema_version: OPERATIONAL_INVENTORY_SCHEMA.to_owned(),
        release_id: seed.operational_release_id.clone(),
        world_id: seed.world_id.clone(),
        catalog_release_id: catalog.release_id.clone(),
        vehicle_types: operational_types,
        vehicles: physical_vehicles,
        formations,
    };
    Ok((fleet_authority, operational_inventory))
}

fn validate_seed_asset(
    asset: &SeedVehicleAsset,
    vehicle_type: &CompiledVehicleType,
    reference_year: u16,
    produced_at: u64,
) -> Result<(), CatalogCompileError> {
    if let Some(configuration) = &asset.vehicle_configuration {
        validate_vehicle_configuration(configuration, vehicle_type)?;
    }
    require_identifier(&asset.id, "assets[].id")?;
    require_safe_positive(asset.numeric_id, "assets[].numericId")?;
    require_identifier(&asset.operator_id, "assets[].operatorId")?;
    if !vehicle_type.construction_years.from.le(&asset.build_year)
        || !asset.build_year.le(&vehicle_type.construction_years.to)
    {
        return invalid(format!(
            "Asset '{}' besitzt Baujahr ausserhalb des Typfensters",
            asset.id
        ));
    }
    if asset.acquisition_year < asset.build_year {
        return invalid(format!(
            "Asset '{}' wurde vor seinem Baujahr beschafft",
            asset.id
        ));
    }
    if asset.build_year > reference_year || asset.acquisition_year > reference_year {
        return invalid(format!(
            "Asset '{}' besitzt Bau- oder Beschaffungsjahr nach dem Katalog-Referenzjahr",
            asset.id
        ));
    }
    let market = match asset.procurement_channel {
        ProcurementChannel::NewBuild => vehicle_type.markets.new_build,
        ProcurementChannel::Leasing => vehicle_type.markets.leasing,
        ProcurementChannel::Used => vehicle_type.markets.used,
    };
    if asset.acquisition_year < market.from || asset.acquisition_year > market.to {
        return invalid(format!(
            "Asset '{}' liegt ausserhalb seines Beschaffungsfensters",
            asset.id
        ));
    }
    if asset.delivered_at >= asset.retired_at
        || produced_at < asset.delivered_at
        || produced_at >= asset.retired_at
    {
        return invalid(format!(
            "Asset '{}' ist zum Seed-Zeitpunkt nicht aktiv",
            asset.id
        ));
    }
    require_safe_integer(asset.delivered_at, "assets[].deliveredAt")?;
    require_safe_integer(asset.retired_at, "assets[].retiredAt")?;
    if asset.approved_line_ids.is_empty() || asset.maintenance_deadlines.is_empty() {
        return invalid(format!(
            "Asset '{}' braucht Zulassungslinien und Wartungsfristen",
            asset.id
        ));
    }
    for line in &asset.approved_line_ids {
        require_identifier(line, "assets[].approvedLineIds[]")?;
    }
    for deadline in &asset.maintenance_deadlines {
        require_identifier(&deadline.kind, "assets[].maintenanceDeadlines[].kind")?;
        require_safe_integer(deadline.due_at, "assets[].maintenanceDeadlines[].dueAt")?;
        if deadline.due_at <= produced_at {
            return invalid(format!(
                "Asset '{}' besitzt bereits faellige Wartungsfrist '{}'",
                asset.id, deadline.kind
            ));
        }
    }
    for standard in &vehicle_type.standard_protection {
        if !asset.installed_protection.contains(standard) {
            return invalid(format!(
                "Asset '{}' fehlt serienmaessige Zugsicherung {:?}",
                asset.id, standard
            ));
        }
    }
    for installed in &asset.installed_protection {
        if vehicle_type.standard_protection.contains(installed) {
            continue;
        }
        let option_available = vehicle_type.protection_options.iter().any(|option| {
            if option.system != *installed {
                return false;
            }
            let relevant_year = match option.fitment {
                ProtectionFitment::FactoryOption => asset.build_year,
                ProtectionFitment::Retrofit => asset.acquisition_year,
            };
            option.years.from <= relevant_year && relevant_year <= option.years.to
        });
        if !option_available {
            return invalid(format!(
                "Asset '{}' installiert fuer Typ '{}' nicht freigegebene Zugsicherung {:?}",
                asset.id, asset.type_id, installed
            ));
        }
    }
    validate_protection(
        &asset.installed_protection,
        vehicle_type.role != VehicleRole::Coach,
        &format!("Asset '{}'", asset.id),
    )?;
    validate_condition(&asset.condition, &asset.id)?;
    validate_restrictions(&asset.restrictions, vehicle_type, &asset.id)?;
    for history in &asset.history {
        require_non_empty(history, "assets[].history[]")?;
    }
    Ok(())
}

fn validate_vehicle_configuration(
    configuration: &VehicleConfigurationV1,
    vehicle_type: &CompiledVehicleType,
) -> Result<(), CatalogCompileError> {
    configuration
        .validate_against(VehicleConfigurationFacts {
            length_mm: i64::from(vehicle_type.technical.length_mm),
            seats: vehicle_type.passenger.seats,
            first_class_seats: vehicle_type.passenger.first_class_seats,
            bicycle_places: vehicle_type.passenger.bicycle_places,
            wheelchair_places: vehicle_type.passenger.wheelchair_places,
            accessible: vehicle_type.passenger.accessible,
        })
        .and_then(|()| configuration.validate_equipment(&vehicle_type.passenger.equipment))
        .map_err(|error| {
            CatalogCompileError::Invalid(format!("M5-Fahrzeugkonfiguration ist ungültig: {error}"))
        })
}

fn validate_condition(condition: &VehicleCondition, id: &str) -> Result<(), CatalogCompileError> {
    for (name, value) in [
        ("mechanicsBasisPoints", condition.mechanics_basis_points),
        ("driveBasisPoints", condition.drive_basis_points),
        ("brakesBasisPoints", condition.brakes_basis_points),
    ] {
        if value > BASIS_POINTS_MAX {
            return invalid(format!(
                "Asset '{id}' ueberschreitet bei {name} {BASIS_POINTS_MAX} Basispunkte"
            ));
        }
    }
    require_safe_integer(
        condition.kilometres_since_maintenance,
        "assets[].condition.kilometresSinceMaintenance",
    )?;
    require_safe_integer(
        condition.operating_hours_since_maintenance,
        "assets[].condition.operatingHoursSinceMaintenance",
    )?;
    Ok(())
}

fn validate_restrictions(
    restrictions: &BTreeMap<String, VehicleRestriction>,
    vehicle_type: &CompiledVehicleType,
    id: &str,
) -> Result<(), CatalogCompileError> {
    for (restriction_id, restriction) in restrictions {
        require_identifier(restriction_id, "assets[].restrictions key")?;
        match restriction {
            VehicleRestriction::PowerBasisPoints(value) => {
                if *value == 0 || *value > BASIS_POINTS_MAX {
                    return invalid(format!(
                        "Asset '{id}' besitzt bei Restriktion '{restriction_id}' keine Leistungsbasispunkte in 1..={BASIS_POINTS_MAX}"
                    ));
                }
            }
            VehicleRestriction::DoorAvailabilityBasisPoints(value) => {
                if *value > BASIS_POINTS_MAX {
                    return invalid(format!(
                        "Asset '{id}' ueberschreitet bei Restriktion '{restriction_id}' {BASIS_POINTS_MAX} Basispunkte"
                    ));
                }
            }
            VehicleRestriction::MaximumSpeed(value)
            | VehicleRestriction::ServiceBrake(value)
            | VehicleRestriction::EmergencyBrake(value) => {
                if *value == 0 {
                    return invalid(format!(
                        "Asset '{id}' besitzt Nullwert in Restriktion '{restriction_id}'"
                    ));
                }
            }
            VehicleRestriction::ProtectionUnavailable(system) => {
                if !supported_protection(vehicle_type)
                    .iter()
                    .any(|item| item.operational_name() == system)
                {
                    return invalid(format!(
                        "Asset '{id}' sperrt unbekannte Zugsicherung '{system}'"
                    ));
                }
            }
            VehicleRestriction::Immobilized => {}
        }
    }
    Ok(())
}

fn effective_restrictions(
    asset: &SeedVehicleAsset,
    vehicle_type: &CompiledVehicleType,
) -> Result<BTreeMap<String, VehicleRestriction>, CatalogCompileError> {
    let mut restrictions = asset.restrictions.clone();
    for protection in supported_protection(vehicle_type) {
        if !asset.installed_protection.contains(&protection) {
            let restriction_id = format!(
                "catalog-protection-unavailable:{}",
                protection.operational_name()
            );
            if restrictions
                .insert(
                    restriction_id.clone(),
                    VehicleRestriction::ProtectionUnavailable(
                        protection.operational_name().to_owned(),
                    ),
                )
                .is_some()
            {
                return invalid(format!(
                    "Asset '{}' kollidiert mit Compiler-Restriktion '{restriction_id}'",
                    asset.id
                ));
            }
        }
    }
    Ok(restrictions)
}

fn authority_asset(
    asset: &SeedVehicleAsset,
    vehicle_type: &CompiledVehicleType,
    operating_cost_cents_per_train_km: u32,
) -> Result<AuthorityVehicleAsset, CatalogCompileError> {
    let technical = &vehicle_type.technical;
    Ok(AuthorityVehicleAsset {
        id: asset.id.clone(),
        numeric_id: asset.numeric_id,
        operator_id: asset.operator_id.clone(),
        vehicle_type_id: vehicle_type.numeric_id,
        class_designation: vehicle_type.class_designation.clone(),
        trade_name: vehicle_type.trade_name.clone(),
        build_year: asset.build_year,
        acquisition_year: asset.acquisition_year,
        procurement_channel: asset.procurement_channel,
        approved_line_ids: asset.approved_line_ids.clone(),
        maintenance_deadlines: asset.maintenance_deadlines.clone(),
        installed_protection: asset.installed_protection.clone(),
        orientation: asset.orientation,
        condition: asset.condition.clone(),
        restrictions: effective_restrictions(asset, vehicle_type)?,
        history: asset.history.clone(),
        technical: AuthorityTechnicalData {
            length_mm: i64::from(technical.length_mm),
            mass_kg: i64::try_from(technical.mass_kg).map_err(|_| {
                CatalogCompileError::Invalid("massKg passt nicht in Fleet Authority v2".to_owned())
            })?,
            maximum_speed_kph: technical.maximum_speed_kph,
            maximum_speed_mmps: i64::from(kilometres_per_hour_to_mmps(
                technical.maximum_speed_kph,
            )?),
            // Ein untrennbarer Triebzug kann sein belegtes Typfahrprofil direkt
            // tragen. Bei Lokomotiven bleiben Beschleunigung und Bremsung
            // formationsabhaengig und damit im Typ-Asset absichtlich null.
            acceleration_mm_per_s2: if vehicle_type.role == VehicleRole::PoweredUnit {
                i64::from(vehicle_type.operational_profile.maximum_acceleration_mmps2)
            } else {
                0
            },
            deceleration_mm_per_s2: if vehicle_type.role == VehicleRole::PoweredUnit {
                i64::from(vehicle_type.operational_profile.service_brake_mmps2)
            } else {
                0
            },
            continuous_power_kw: i64::from(technical.continuous_power_kw),
            starting_tractive_effort_kn: i64::from(technical.starting_tractive_effort_kn),
            brake_weight_kg: i64::try_from(technical.brake_weight_kg).map_err(|_| {
                CatalogCompileError::Invalid(
                    "brakeWeightKg passt nicht in Fleet Authority v2".to_owned(),
                )
            })?,
            maximum_acceleration_cap_mmps2: i64::from(
                vehicle_type
                    .operational_profile
                    .maximum_acceleration_cap_mmps2,
            ),
            service_brake_cap_mmps2: i64::from(
                vehicle_type.operational_profile.service_brake_cap_mmps2,
            ),
            emergency_brake_multiplier_basis_points: vehicle_type
                .operational_profile
                .emergency_brake_multiplier_basis_points,
            traction: vehicle_type.traction,
            electric_systems: vehicle_type.electric_systems.clone(),
            role: vehicle_type.role,
            control_stands: vehicle_type.control_stands,
        },
        passenger: AuthorityPassengerData {
            seats: vehicle_type.passenger.seats,
            first_class_seats: vehicle_type.passenger.first_class_seats,
            accessible: vehicle_type.passenger.accessible,
            bicycle_places: vehicle_type.passenger.bicycle_places,
            wheelchair_places: vehicle_type.passenger.wheelchair_places,
            equipment: vehicle_type.passenger.equipment.clone(),
            operating_cost_cents_per_train_km,
            replacement_plan: vehicle_type.passenger.replacement_plan,
        },
        vehicle_configuration: asset.vehicle_configuration.clone(),
        delivered_at: asset.delivered_at,
        retired_at: asset.retired_at,
    })
}

fn operational_vehicle_type(
    source: &CompiledVehicleType,
) -> Result<OperationalVehicleType, CatalogCompileError> {
    let maximum_speed_mmps = kilometres_per_hour_to_mmps(source.technical.maximum_speed_kph)?;
    let power_watts = u64::from(source.technical.continuous_power_kw)
        .checked_mul(1_000)
        .ok_or_else(|| CatalogCompileError::Invalid("powerWatt-Ueberlauf".to_owned()))?;
    let starting_tractive_force_newtons = source
        .technical
        .starting_tractive_effort_kn
        .checked_mul(1_000)
        .ok_or_else(|| CatalogCompileError::Invalid("tractiveForce-Ueberlauf".to_owned()))?;
    let protection_systems = supported_protection(source)
        .into_iter()
        .map(|item| item.operational_name().to_owned())
        .collect();
    let vehicle_type = VehicleType {
        id: source.type_id.clone(),
        role: Some(operational_role(source.role)),
        control_stands: Some(OperationalControlStands {
            front: source.control_stands.front,
            rear: source.control_stands.rear,
        }),
        traction: Some(operational_traction(source.traction)),
        electric_systems: Some(
            source
                .electric_systems
                .iter()
                .copied()
                .map(operational_power_system)
                .collect(),
        ),
        length_mm: source.technical.length_mm,
        mass_kg: source.technical.mass_kg,
        maximum_speed_mmps,
        power_watts,
        starting_tractive_force_newtons,
        raw_formation_dynamics: Some(VehicleTypeRawFormationDynamics {
            brake_weight_kg: source.technical.brake_weight_kg,
            maximum_acceleration_cap_mmps2: source
                .operational_profile
                .maximum_acceleration_cap_mmps2,
            service_brake_cap_mmps2: source.operational_profile.service_brake_cap_mmps2,
            emergency_brake_multiplier_basis_points: source
                .operational_profile
                .emergency_brake_multiplier_basis_points,
        }),
        maximum_acceleration_mmps2: source.operational_profile.maximum_acceleration_mmps2,
        service_brake_mmps2: source.operational_profile.service_brake_mmps2,
        emergency_brake_mmps2: source.operational_profile.emergency_brake_mmps2,
        protection_systems,
    };
    vehicle_type
        .validate(source.role.is_powered())
        .map_err(|error| {
            CatalogCompileError::Invalid(format!(
                "Operational-v2-Typ '{}' ist unvollstaendig: {error}",
                source.type_id
            ))
        })?;
    Ok(OperationalVehicleType {
        powered: source.role.is_powered(),
        vehicle_type,
    })
}

fn operational_role(role: VehicleRole) -> OperationalVehicleRole {
    match role {
        VehicleRole::PoweredUnit => OperationalVehicleRole::PoweredUnit,
        VehicleRole::Locomotive => OperationalVehicleRole::Locomotive,
        VehicleRole::Coach => OperationalVehicleRole::Coach,
        VehicleRole::ControlCar => OperationalVehicleRole::ControlCar,
    }
}

fn operational_traction(traction: VehicleTraction) -> OperationalVehicleTraction {
    match traction {
        VehicleTraction::Unpowered => OperationalVehicleTraction::Unpowered,
        VehicleTraction::Electric => OperationalVehicleTraction::Electric,
        VehicleTraction::Diesel => OperationalVehicleTraction::Diesel,
        VehicleTraction::Battery => OperationalVehicleTraction::Battery,
    }
}

fn operational_power_system(system: VehiclePowerSystem) -> OperationalPowerSystem {
    match system {
        VehiclePowerSystem::Ac15kv => OperationalPowerSystem::Ac15kv,
        VehiclePowerSystem::Ac25kv => OperationalPowerSystem::Ac25kv,
        VehiclePowerSystem::Dc750v => OperationalPowerSystem::Dc750v,
        VehiclePowerSystem::Dc1500v => OperationalPowerSystem::Dc1500v,
        VehiclePowerSystem::Dc3000v => OperationalPowerSystem::Dc3000v,
    }
}

fn physical_vehicle(
    asset: &SeedVehicleAsset,
    vehicle_type: &CompiledVehicleType,
) -> Result<PhysicalVehicle, CatalogCompileError> {
    Ok(PhysicalVehicle {
        id: asset.id.clone(),
        type_id: asset.type_id.clone(),
        powered: vehicle_type.role.is_powered(),
        orientation: asset.orientation,
        condition: asset.condition.clone(),
        restrictions: effective_restrictions(asset, vehicle_type)?,
        history: asset.history.clone(),
    })
}

fn supported_protection(source: &CompiledVehicleType) -> Vec<VehicleProtectionSystem> {
    let mut systems = source.standard_protection.clone();
    systems.extend(source.protection_options.iter().map(|option| option.system));
    systems.sort();
    systems.dedup();
    systems
}

fn validate_path_receipts(
    receipts: &[AuthorityPathReceipt],
    classes: &BTreeSet<&str>,
) -> Result<(), CatalogCompileError> {
    let mut numeric_ids = BTreeSet::new();
    for receipt in receipts {
        require_identifier(&receipt.id, "pathReceipts[].id")?;
        require_safe_positive(receipt.numeric_route_id, "pathReceipts[].numericRouteId")?;
        if !numeric_ids.insert(receipt.numeric_route_id) {
            return invalid(format!(
                "doppelte numerische Trassenkennung {}",
                receipt.numeric_route_id
            ));
        }
        require_identifier(&receipt.operator_id, "pathReceipts[].operatorId")?;
        if receipt.service_line_ids.is_empty()
            || receipt.platform_lengths_mm.is_empty()
            || receipt.electrifications.is_empty()
            || receipt.approved_classes.is_empty()
        {
            return invalid(format!(
                "Trassenbeleg '{}' ist fachlich unvollstaendig",
                receipt.id
            ));
        }
        if receipt.valid_from >= receipt.valid_until {
            return invalid(format!(
                "Trassenbeleg '{}' besitzt kein positives Zeitfenster",
                receipt.id
            ));
        }
        require_safe_integer(receipt.valid_from, "pathReceipts[].validFrom")?;
        require_safe_integer(receipt.valid_until, "pathReceipts[].validUntil")?;
        for line in &receipt.service_line_ids {
            require_identifier(line, "pathReceipts[].serviceLineIds[]")?;
        }
        for value in &receipt.platform_lengths_mm {
            if *value <= 0 {
                return invalid(format!(
                    "Trassenbeleg '{}' besitzt ungueltige platformLengthsMm",
                    receipt.id
                ));
            }
            require_safe_integer(
                u64::try_from(*value).map_err(|_| {
                    CatalogCompileError::Invalid(format!(
                        "Trassenbeleg '{}' besitzt ungueltige platformLengthsMm",
                        receipt.id
                    ))
                })?,
                "pathReceipts[].platformLengthsMm[]",
            )?;
        }
        validate_protection(
            &receipt.required_protection,
            false,
            &format!("Trassenbeleg '{}'", receipt.id),
        )?;
        for class in &receipt.approved_classes {
            if !classes.contains(class.as_str()) {
                return invalid(format!(
                    "Trassenbeleg '{}' genehmigt unbekannte Baureihe '{class}'",
                    receipt.id
                ));
            }
        }
        validate_sha256(
            &receipt.planner_state_hash,
            "pathReceipts[].plannerStateHash",
        )?;
        validate_sha256(
            &receipt.conflict_check_hash,
            "pathReceipts[].conflictCheckHash",
        )?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EconomyReleaseChecksumBody<'a> {
    schema: &'a str,
    version: &'a str,
    rates: &'a EconomyReleaseRates,
    rules: &'a EconomyReleaseRules,
    tender_profiles: &'a [EconomyTenderProfile],
    #[serde(skip_serializing_if = "Option::is_none")]
    fare_inspection: Option<&'a crate::FareInspectionEconomyV1>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VehicleEconomyProjectionHash<'a> {
    schema_version: &'a str,
    economy_release_schema: &'a str,
    economy_release_version: &'a str,
    economy_release_checksum: &'a str,
    operating_costs: &'a [VehicleOperatingCost],
}

pub fn recompute_economy_release_checksum(
    release: &EconomyReleaseDocument,
) -> Result<String, CatalogCompileError> {
    let mut tender_profiles = release.tender_profiles.clone();
    tender_profiles.sort_by(|left, right| left.id.cmp(&right.id));
    let body = EconomyReleaseChecksumBody {
        schema: &release.schema,
        version: &release.version,
        rates: &release.rates,
        rules: &release.rules,
        tender_profiles: &tender_profiles,
        fare_inspection: release.fare_inspection.as_ref(),
    };
    let value = serde_json::to_value(body)?;
    let canonical = canonical_economy_json(&value)?;
    Ok(lower_hex(&Sha256::digest(canonical.as_bytes())))
}

pub fn recompute_vehicle_economy_projection_sha256(
    projection: &VehicleEconomyProjection,
) -> Result<String, CatalogCompileError> {
    recompute_vehicle_economy_projection_sha256_from_parts(
        &projection.release.schema,
        &projection.release.version,
        &projection.release.checksum,
        &projection.operating_costs,
    )
}

fn recompute_vehicle_economy_projection_sha256_from_parts(
    release_schema: &str,
    release_version: &str,
    release_checksum: &str,
    costs: &[VehicleOperatingCost],
) -> Result<String, CatalogCompileError> {
    let mut operating_costs = costs.to_vec();
    operating_costs.sort_by(|left, right| left.type_id.cmp(&right.type_id));
    hash_json(&VehicleEconomyProjectionHash {
        schema_version: ECONOMY_PROJECTION_SCHEMA,
        economy_release_schema: release_schema,
        economy_release_version: release_version,
        economy_release_checksum: release_checksum,
        operating_costs: &operating_costs,
    })
}

fn canonical_economy_json(value: &serde_json::Value) -> Result<String, CatalogCompileError> {
    match value {
        serde_json::Value::Null => Ok("null".to_owned()),
        serde_json::Value::Bool(value) => Ok(value.to_string()),
        serde_json::Value::Number(value) if value.is_i64() || value.is_u64() => {
            Ok(value.to_string())
        }
        serde_json::Value::Number(_) => {
            invalid("EconomyRelease-Checksum akzeptiert keine Gleitkommazahlen")
        }
        serde_json::Value::String(value) => Ok(serde_json::to_string(value)?),
        serde_json::Value::Array(values) => {
            let values = values
                .iter()
                .map(canonical_economy_json)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", values.join(",")))
        }
        serde_json::Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            let entries = entries
                .into_iter()
                .map(|(key, value)| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key)?,
                        canonical_economy_json(value)?
                    ))
                })
                .collect::<Result<Vec<String>, CatalogCompileError>>()?;
            Ok(format!("{{{}}}", entries.join(",")))
        }
    }
}

fn validate_non_negative_decimal(value: &str, field: &str) -> Result<(), CatalogCompileError> {
    let canonical = !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'));
    if !canonical {
        return invalid(format!(
            "{field} muss eine kanonische nichtnegative Dezimalzahl sein"
        ));
    }
    Ok(())
}

fn validate_economy_special_condition(
    condition: &EconomySpecialCondition,
    field: &str,
) -> Result<(), CatalogCompileError> {
    let exact = match condition.kind {
        EconomySpecialConditionKind::AdditionalStop => {
            condition.minimum_additional_stops.is_some()
                && condition.maximum_age_years.is_none()
                && condition.allowed.is_none()
        }
        EconomySpecialConditionKind::MaximumAge => {
            condition.minimum_additional_stops.is_none()
                && condition.maximum_age_years.is_some()
                && condition.allowed.is_none()
        }
        EconomySpecialConditionKind::Traction => {
            condition.minimum_additional_stops.is_none()
                && condition.maximum_age_years.is_none()
                && condition
                    .allowed
                    .as_ref()
                    .is_some_and(|allowed| !allowed.is_empty())
        }
        EconomySpecialConditionKind::ReplacementPlan => {
            condition.minimum_additional_stops.is_none()
                && condition.maximum_age_years.is_none()
                && condition.allowed.is_none()
        }
    };
    if !exact {
        return invalid(format!(
            "{field} besitzt keine zum Typ passende EconomyRelease-Auflage"
        ));
    }
    if let Some(minimum) = condition.minimum_additional_stops {
        require_safe_positive(minimum, &format!("{field}.minimumAdditionalStops"))?;
    }
    if let Some(maximum) = condition.maximum_age_years {
        require_safe_integer(maximum, &format!("{field}.maximumAgeYears"))?;
    }
    Ok(())
}

pub fn validate_economy_release_document(
    release: &EconomyReleaseDocument,
) -> Result<(), CatalogCompileError> {
    require_schema(&release.schema, ECONOMY_RELEASE_SCHEMA, "EconomyRelease")?;
    require_identifier(&release.version, "economy.release.version")?;
    if release
        .fare_inspection
        .as_ref()
        .is_some_and(|rules| !rules.validate())
    {
        return invalid("EconomyRelease enthält ungültige Fahrkartenkontrollregeln");
    }
    validate_sha256(&release.checksum, "economy.release.checksum")?;
    for (field, value) in [
        (
            "economy.release.rates.trackPerTrainKmCents",
            &release.rates.track_per_train_km_cents,
        ),
        (
            "economy.release.rates.stationPerStopCents",
            &release.rates.station_per_stop_cents,
        ),
        (
            "economy.release.rates.facilityPerHourCents",
            &release.rates.facility_per_hour_cents,
        ),
        (
            "economy.release.rates.energyPerKwhCents",
            &release.rates.energy_per_kwh_cents,
        ),
        (
            "economy.release.rates.personnelPerHourCents",
            &release.rates.personnel_per_hour_cents,
        ),
        (
            "economy.release.rates.administrationPerPeriodCents",
            &release.rates.administration_per_period_cents,
        ),
        (
            "economy.release.rates.vehiclePerPeriodCents",
            &release.rates.vehicle_per_period_cents,
        ),
        (
            "economy.release.rates.overnightStablingPerPeriodCents",
            &release.rates.overnight_stabling_per_period_cents,
        ),
        (
            "economy.release.rates.protectionEquipmentPerPeriodCents",
            &release.rates.protection_equipment_per_period_cents,
        ),
        (
            "economy.release.rules.contractBonusCentsPerPeriod",
            &release.rules.contract_bonus_cents_per_period,
        ),
        (
            "economy.release.rules.penaltyRates.punctuality",
            &release.rules.penalty_rates.punctuality,
        ),
        (
            "economy.release.rules.penaltyRates.cancellation",
            &release.rules.penalty_rates.cancellation,
        ),
        (
            "economy.release.rules.penaltyRates.seats",
            &release.rules.penalty_rates.seats,
        ),
        (
            "economy.release.rules.penaltyRates.connections",
            &release.rules.penalty_rates.connections,
        ),
    ] {
        validate_non_negative_decimal(value, field)?;
    }
    for (field, value) in [
        (
            "economy.release.rates.lateInterestBasisPoints",
            release.rates.late_interest_basis_points,
        ),
        (
            "economy.release.rules.qualityBaselinePunctualityBasisPoints",
            release.rules.quality_baseline_punctuality_basis_points,
        ),
        (
            "economy.release.rules.pointsPerExtraSeat",
            release.rules.points_per_extra_seat,
        ),
        (
            "economy.release.rules.pointsPerPunctualityBasisPoint",
            release.rules.points_per_punctuality_basis_point,
        ),
        (
            "economy.release.rules.pointsPerAdditionalStop",
            release.rules.points_per_additional_stop,
        ),
        (
            "economy.release.rules.requirementFocusMaximumPoints",
            release.rules.requirement_focus_maximum_points,
        ),
        (
            "economy.release.rules.penaltyFocusMultiplierBasisPoints",
            release.rules.penalty_focus_multiplier_basis_points,
        ),
        (
            "economy.release.rules.publicOperationSurchargeBasisPoints",
            release.rules.public_operation_surcharge_basis_points,
        ),
        (
            "economy.release.rules.failedPackageFeeStepBasisPoints",
            release.rules.failed_package_fee_step_basis_points,
        ),
        (
            "economy.release.rules.failedPackageReductionStepBasisPoints",
            release.rules.failed_package_reduction_step_basis_points,
        ),
    ] {
        require_safe_integer(value, field)?;
    }
    if release.tender_profiles.len() < 2 {
        return invalid("EconomyRelease braucht mindestens zwei Vergabeprofile");
    }
    let mut profile_ids = BTreeSet::new();
    for profile in &release.tender_profiles {
        require_identifier(&profile.id, "economy.release.tenderProfiles[].id")?;
        if !profile_ids.insert(profile.id.as_str()) {
            return invalid(format!(
                "EconomyRelease besitzt doppeltes Vergabeprofil '{}'",
                profile.id
            ));
        }
        require_safe_integer(
            profile.weights.price,
            "economy.release.tenderProfiles[].weights.price",
        )?;
        require_safe_integer(
            profile.weights.quality,
            "economy.release.tenderProfiles[].weights.quality",
        )?;
        if profile.weights.price.checked_add(profile.weights.quality)
            != Some(u64::from(BASIS_POINTS_MAX))
        {
            return invalid(format!(
                "EconomyRelease-Vergabeprofil '{}' besitzt keine 10.000 Gewichtungspunkte",
                profile.id
            ));
        }
        require_safe_integer(
            profile.viability_surcharge_basis_points,
            "economy.release.tenderProfiles[].viabilitySurchargeBasisPoints",
        )?;
        if let Some(condition) = &profile.special_condition {
            validate_economy_special_condition(
                condition,
                "economy.release.tenderProfiles[].specialCondition",
            )?;
        }
    }
    let expected = recompute_economy_release_checksum(release)?;
    if release.checksum != expected {
        return invalid(format!(
            "EconomyRelease-Checksum bindet nicht den gelieferten Inhalt; erwartet wird '{expected}'"
        ));
    }
    Ok(())
}

fn validate_economy_projection(
    projection: &VehicleEconomyProjection,
    assets: &[SeedVehicleAsset],
    vehicle_types: &BTreeMap<&str, &CompiledVehicleType>,
) -> Result<BTreeMap<String, u32>, CatalogCompileError> {
    require_schema(
        &projection.schema_version,
        ECONOMY_PROJECTION_SCHEMA,
        "vehicle economy projection",
    )?;
    validate_economy_release_document(&projection.release)?;
    validate_sha256(&projection.projection_sha256, "economy.projectionSha256")?;
    let expected_type_ids = assets
        .iter()
        .map(|asset| asset.type_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut costs = BTreeMap::new();
    for cost in &projection.operating_costs {
        require_identifier(&cost.type_id, "economy.operatingCosts[].typeId")?;
        if !vehicle_types.contains_key(cost.type_id.as_str()) {
            return invalid(format!(
                "EconomyRelease-Fahrzeugkostensatz referenziert unbekannten Typ '{}'",
                cost.type_id
            ));
        }
        if cost.cents_per_train_km == 0 {
            return invalid(format!(
                "EconomyRelease-Fahrzeugkostensatz fuer Typ '{}' muss positiv sein",
                cost.type_id
            ));
        }
        if costs
            .insert(cost.type_id.clone(), cost.cents_per_train_km)
            .is_some()
        {
            return invalid(format!(
                "doppelter EconomyRelease-Fahrzeugkostensatz fuer Typ '{}'",
                cost.type_id
            ));
        }
    }
    let actual_type_ids = costs.keys().map(String::as_str).collect::<BTreeSet<_>>();
    if actual_type_ids != expected_type_ids {
        return invalid(
            "EconomyRelease-Fahrzeugkostensaetze muessen exakt die Asset-Typen des Welt-Seeds abdecken",
        );
    }
    let expected_projection_sha256 = recompute_vehicle_economy_projection_sha256(projection)?;
    if projection.projection_sha256 != expected_projection_sha256 {
        return invalid(format!(
            "Economy-Projektions-SHA-256 bindet nicht EconomyRelease und Fahrzeugkosten; erwartet wird '{expected_projection_sha256}'"
        ));
    }
    Ok(costs)
}

fn validate_personnel_pools(
    pools: &[AuthorityPersonnelPool],
    classes: &BTreeSet<&str>,
    receipts: &BTreeMap<&str, &AuthorityPathReceipt>,
) -> Result<(), CatalogCompileError> {
    let mut numeric_ids = BTreeSet::new();
    for pool in pools {
        require_identifier(&pool.id, "personnelPools[].id")?;
        require_safe_positive(pool.numeric_id, "personnelPools[].numericId")?;
        if !numeric_ids.insert(pool.numeric_id) {
            return invalid(format!(
                "doppelte numerische Personalpoolkennung {}",
                pool.numeric_id
            ));
        }
        require_identifier(&pool.operator_id, "personnelPools[].operatorId")?;
        if pool.capacity_seconds == 0
            || pool.minimum_rest_seconds == 0
            || pool.class_designations.is_empty()
            || pool.path_receipt_ids.is_empty()
        {
            return invalid(format!("Personalpool '{}' ist unvollstaendig", pool.id));
        }
        for class in &pool.class_designations {
            if !classes.contains(class.as_str()) {
                return invalid(format!(
                    "Personalpool '{}' qualifiziert unbekannte Baureihe '{class}'",
                    pool.id
                ));
            }
        }
        for receipt_id in &pool.path_receipt_ids {
            let receipt = receipts.get(receipt_id.as_str()).ok_or_else(|| {
                CatalogCompileError::Invalid(format!(
                    "Personalpool '{}' referenziert unbekannten Trassenbeleg '{receipt_id}'",
                    pool.id
                ))
            })?;
            if receipt.operator_id != pool.operator_id {
                return invalid(format!(
                    "Personalpool '{}' und Trassenbeleg '{}' gehoeren verschiedenen EVU",
                    pool.id, receipt.id
                ));
            }
        }
        validate_sha256(
            &pool.qualification_hash,
            "personnelPools[].qualificationHash",
        )?;
    }
    Ok(())
}

fn validate_asset_against_receipt(
    asset: &SeedVehicleAsset,
    vehicle_type: &CompiledVehicleType,
    receipt: &AuthorityPathReceipt,
) -> Result<(), CatalogCompileError> {
    if asset.operator_id != receipt.operator_id {
        return invalid(format!(
            "Asset '{}' und Trassenbeleg '{}' gehoeren verschiedenen EVU",
            asset.id, receipt.id
        ));
    }
    if !receipt
        .approved_classes
        .contains(&vehicle_type.class_designation)
    {
        return invalid(format!(
            "Trassenbeleg '{}' genehmigt Baureihe '{}' von Asset '{}' nicht",
            receipt.id, vehicle_type.class_designation, asset.id
        ));
    }
    if !receipt
        .service_line_ids
        .iter()
        .all(|line| asset.approved_line_ids.contains(line))
    {
        return invalid(format!(
            "Asset '{}' ist nicht fuer alle Linien von Trassenbeleg '{}' zugelassen",
            asset.id, receipt.id
        ));
    }
    let incompatible_electrification = receipt.electrifications.iter().any(|electrification| {
        let supported_overhead = vehicle_type
            .electric_systems
            .iter()
            .any(|system| electrification_for(*system) == Some(*electrification));
        match vehicle_type.traction {
            VehicleTraction::Electric => !supported_overhead,
            VehicleTraction::Battery => {
                *electrification != AuthorityElectrification::Unelectrified && !supported_overhead
            }
            VehicleTraction::Diesel | VehicleTraction::Unpowered => false,
        }
    });
    if incompatible_electrification {
        return invalid(format!(
            "Asset '{}' beherrscht nicht alle Elektrifizierungen von Trassenbeleg '{}'",
            asset.id, receipt.id
        ));
    }
    Ok(())
}

fn electrification_for(system: VehiclePowerSystem) -> Option<AuthorityElectrification> {
    match system {
        VehiclePowerSystem::Ac15kv => Some(AuthorityElectrification::OverheadAc15kv),
        VehiclePowerSystem::Ac25kv => Some(AuthorityElectrification::OverheadAc25kv),
        // Der heutige Fleet-Authority-v1-Trassenvertrag kennt keine
        // Stromschiene. Ein solcher Typ darf daher nicht still als
        // unelektrifiziert freigegeben werden.
        VehiclePowerSystem::Dc750v => None,
        VehiclePowerSystem::Dc1500v => Some(AuthorityElectrification::OverheadDc1500v),
        VehiclePowerSystem::Dc3000v => Some(AuthorityElectrification::OverheadDc3000v),
    }
}

fn derive_formation_performance(
    formation_id: &str,
    vehicle_ids: &[String],
    vehicles: &BTreeMap<&str, &PhysicalVehicle>,
    vehicle_types: &BTreeMap<&str, &OperationalVehicleType>,
) -> Result<FormationPerformance, CatalogCompileError> {
    let mut length = 0_u64;
    let mut mass = 0_u64;
    let mut maximum_speed = u32::MAX;
    let mut power = 0_u64;
    let mut acceleration = 0_u32;
    let mut service_brake = u32::MAX;
    let mut emergency_brake = u32::MAX;
    let mut raw_starting_tractive_force = 0_u64;
    let mut raw_brake_weight = 0_u64;
    let mut raw_acceleration_cap = u32::MAX;
    let mut raw_service_brake_cap = u32::MAX;
    let mut raw_emergency_brake_multiplier = u16::MAX;
    let mut restricted_service_brake = u32::MAX;
    let mut restricted_emergency_brake = u32::MAX;
    let mut legacy_powered_protection: Option<BTreeSet<String>> = None;
    let mut front_tip_protection = BTreeSet::new();
    let mut front_control_stand_available = false;
    let mut rear_control_stand_available = false;
    let mut explicit_metadata: Option<bool> = None;
    let mut has_usable_drive = false;
    for (index, vehicle_id) in vehicle_ids.iter().enumerate() {
        let vehicle = vehicles.get(vehicle_id.as_str()).ok_or_else(|| {
            CatalogCompileError::Invalid(format!(
                "Formation '{formation_id}' referenziert unbekanntes Operational-Asset '{vehicle_id}'"
            ))
        })?;
        let kind = vehicle_types.get(vehicle.type_id.as_str()).ok_or_else(|| {
            CatalogCompileError::Invalid(format!(
                "Operational-Asset '{vehicle_id}' referenziert unbekannten Typ '{}'",
                vehicle.type_id
            ))
        })?;
        if kind.powered != vehicle.powered {
            return invalid(format!(
                "Operational-Asset '{vehicle_id}' widerspricht dem powered-Bit seines Typs"
            ));
        }
        let kind = &kind.vehicle_type;
        let vehicle_has_explicit_metadata = kind.role.is_some();
        match explicit_metadata {
            None => explicit_metadata = Some(vehicle_has_explicit_metadata),
            Some(expected) if expected != vehicle_has_explicit_metadata => {
                return invalid(format!(
                    "Formation '{formation_id}' mischt explizite und alte Operational-Metadaten"
                ));
            }
            Some(_) => {}
        }
        kind.validate(vehicle.powered).map_err(|error| {
            CatalogCompileError::Invalid(format!(
                "Operational-Typ '{}' ist ungueltig: {error}",
                kind.id
            ))
        })?;
        length = length
            .checked_add(u64::from(kind.length_mm))
            .ok_or_else(|| {
                CatalogCompileError::Invalid("Formationslaenge laeuft ueber".to_owned())
            })?;
        mass = mass.checked_add(kind.mass_kg).ok_or_else(|| {
            CatalogCompileError::Invalid("Formationsmasse laeuft ueber".to_owned())
        })?;
        if vehicle_has_explicit_metadata {
            let raw = kind
                .raw_formation_dynamics
                .expect("validierter expliziter Typ besitzt Rohdynamik");
            raw_brake_weight = raw_brake_weight
                .checked_add(raw.brake_weight_kg)
                .ok_or_else(|| {
                    CatalogCompileError::Invalid("Formationsbremsgewicht laeuft ueber".to_owned())
                })?;
            raw_service_brake_cap = raw_service_brake_cap.min(raw.service_brake_cap_mmps2);
            raw_emergency_brake_multiplier =
                raw_emergency_brake_multiplier.min(raw.emergency_brake_multiplier_basis_points);
        }
        maximum_speed = maximum_speed.min(kind.maximum_speed_mmps);
        service_brake = service_brake.min(kind.service_brake_mmps2);
        emergency_brake = emergency_brake.min(kind.emergency_brake_mmps2);
        let mut vehicle_power = kind.power_watts;
        let mut vehicle_protection = kind.protection_systems.clone();
        let mut immobilized = false;
        for restriction in vehicle.restrictions.values() {
            match restriction {
                VehicleRestriction::PowerBasisPoints(basis_points) => {
                    if vehicle.powered {
                        // Fleet Authority transportiert ganze kW. Das Raster
                        // wird vor jeder assetlokalen Basispunktrestriktion
                        // angewandt und danach wieder in Watt projiziert.
                        vehicle_power = (vehicle_power / 1_000)
                            .checked_mul(u64::from(*basis_points))
                            .ok_or_else(|| {
                                CatalogCompileError::Invalid(
                                    "Leistungsrestriktion laeuft ueber".to_owned(),
                                )
                            })?
                            / u64::from(BASIS_POINTS_MAX)
                            * 1_000;
                    }
                }
                VehicleRestriction::MaximumSpeed(speed) => {
                    maximum_speed = maximum_speed.min(*speed);
                }
                VehicleRestriction::ServiceBrake(brake) => {
                    service_brake = service_brake.min(*brake);
                    restricted_service_brake = restricted_service_brake.min(*brake);
                }
                VehicleRestriction::EmergencyBrake(brake) => {
                    emergency_brake = emergency_brake.min(*brake);
                    restricted_emergency_brake = restricted_emergency_brake.min(*brake);
                }
                VehicleRestriction::ProtectionUnavailable(system) => {
                    vehicle_protection.remove(system);
                }
                VehicleRestriction::DoorAvailabilityBasisPoints(_) => {}
                VehicleRestriction::Immobilized => immobilized = true,
            }
        }
        if vehicle.powered && (immobilized || vehicle_power == 0) {
            vehicle_protection.clear();
        }
        if let Some(control_stands) = kind.control_stands {
            if index == 0 {
                front_control_stand_available = match vehicle.orientation {
                    Direction::Along => control_stands.front,
                    Direction::Against => control_stands.rear,
                };
                front_tip_protection = vehicle_protection.clone();
            }
            if index + 1 == vehicle_ids.len() {
                rear_control_stand_available = match vehicle.orientation {
                    Direction::Along => control_stands.rear,
                    Direction::Against => control_stands.front,
                };
            }
        }
        if vehicle.powered && !immobilized && vehicle_power > 0 {
            has_usable_drive = true;
            power = power.checked_add(vehicle_power).ok_or_else(|| {
                CatalogCompileError::Invalid("Formationsleistung laeuft ueber".to_owned())
            })?;
            if vehicle_has_explicit_metadata {
                // PowerBasisPoints wirkt auf dem ganzen Authority-kW-Raster.
                // Bei positiver Restleistung bleibt die separat belegte
                // Anfahrzugkraft erhalten; null kW oder Immobilized nimmt den
                // Antrieb vollstaendig aus der Rohsumme.
                raw_starting_tractive_force = raw_starting_tractive_force
                    .checked_add(u64::from(kind.starting_tractive_force_newtons))
                    .ok_or_else(|| {
                        CatalogCompileError::Invalid(
                            "Formationsanfahrzugkraft laeuft ueber".to_owned(),
                        )
                    })?;
                raw_acceleration_cap = raw_acceleration_cap.min(
                    kind.raw_formation_dynamics
                        .expect("validierter expliziter Typ besitzt Rohdynamik")
                        .maximum_acceleration_cap_mmps2,
                );
            } else {
                acceleration = acceleration
                    .checked_add(kind.maximum_acceleration_mmps2)
                    .ok_or_else(|| {
                        CatalogCompileError::Invalid(
                            "Formationsbeschleunigung laeuft ueber".to_owned(),
                        )
                    })?;
            }
            legacy_powered_protection = Some(match legacy_powered_protection {
                None => vehicle_protection,
                Some(existing) => existing
                    .intersection(&vehicle_protection)
                    .cloned()
                    .collect(),
            });
        }
    }
    if explicit_metadata.unwrap_or(false) {
        let raw_acceleration_cap = if has_usable_drive {
            raw_acceleration_cap
        } else {
            0
        };
        let derived = derive_formation_dynamics(FormationDynamicsDerivationInput {
            total_mass_kg: mass,
            effective_starting_tractive_force_newtons: raw_starting_tractive_force,
            total_brake_weight_kg: raw_brake_weight,
            maximum_acceleration_cap_mmps2: raw_acceleration_cap,
            service_brake_cap_mmps2: raw_service_brake_cap,
            emergency_brake_multiplier_basis_points: raw_emergency_brake_multiplier,
        })
        .map_err(|error| {
            CatalogCompileError::Invalid(format!(
                "Formation '{formation_id}' besitzt keine ableitbare Rohdynamik: {error:?}"
            ))
        })?;
        acceleration = derived.acceleration_mmps2;
        service_brake = derived.service_brake_mmps2.min(restricted_service_brake);
        emergency_brake = derived
            .emergency_brake_mmps2
            .min(restricted_emergency_brake);
    }
    if service_brake == 0
        || emergency_brake == 0
        || emergency_brake <= service_brake
        || maximum_speed == 0
    {
        return invalid(format!(
            "Formation '{formation_id}' besitzt ungueltige Fahrdynamik"
        ));
    }
    let length_mm = u32::try_from(length).map_err(|_| {
        CatalogCompileError::Invalid(format!(
            "Formation '{formation_id}' passt nicht in lengthMm"
        ))
    })?;
    let protection_systems = if explicit_metadata.unwrap_or(false) {
        if has_usable_drive && !front_control_stand_available {
            return invalid(format!(
                "Formation '{formation_id}' besitzt keinen nutzbaren Fuehrerstand an der Zugspitze"
            ));
        }
        if front_control_stand_available {
            front_tip_protection
        } else {
            BTreeSet::new()
        }
    } else {
        front_control_stand_available = has_usable_drive;
        rear_control_stand_available = has_usable_drive;
        legacy_powered_protection.unwrap_or_default()
    };
    Ok(FormationPerformance {
        length_mm,
        mass_kg: mass,
        maximum_speed_mmps: maximum_speed,
        power_watts: power,
        acceleration_mmps2: acceleration,
        service_brake_mmps2: service_brake,
        emergency_brake_mmps2: emergency_brake,
        front_control_stand_available,
        rear_control_stand_available,
        protection_systems,
        mobile: has_usable_drive,
    })
}

fn validate_protection(
    systems: &[VehicleProtectionSystem],
    baseline_required: bool,
    subject: &str,
) -> Result<(), CatalogCompileError> {
    if systems.contains(&VehicleProtectionSystem::Lzb)
        && !systems.contains(&VehicleProtectionSystem::Pzb)
    {
        return invalid(format!("{subject}: LZB erfordert PZB"));
    }
    if baseline_required && !systems.iter().any(|system| system.is_baseline()) {
        return invalid(format!(
            "{subject} besitzt weder PZB noch eine ETCS-Grundausruestung"
        ));
    }
    Ok(())
}

fn kilometres_per_hour_to_mmps(value: u16) -> Result<u32, CatalogCompileError> {
    // km/h * 1_000_000 mm/km / 3_600 s/h = km/h * 2_500 / 9.
    // Die Projektion rundet sicherheitsgerichtet ab: Eine veroeffentlichte
    // Vmax darf im Operational-Vertrag niemals auch nur minimal steigen.
    let numerator = u64::from(value).checked_mul(2_500).ok_or_else(|| {
        CatalogCompileError::Invalid("Geschwindigkeitsumrechnung laeuft ueber".to_owned())
    })?;
    u32::try_from(numerator / 9)
        .map_err(|_| CatalogCompileError::Invalid("maximumSpeedMmps passt nicht in u32".to_owned()))
}

fn require_schema(actual: &str, expected: &str, subject: &str) -> Result<(), CatalogCompileError> {
    if actual != expected {
        return invalid(format!(
            "{subject} nutzt Schema '{actual}', erwartet wird '{expected}'"
        ));
    }
    Ok(())
}

fn require_identifier(value: &str, field: &str) -> Result<(), CatalogCompileError> {
    let valid = !value.is_empty()
        && value.len() <= 160
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':' | '/')
        });
    if !valid {
        return invalid(format!("{field} besitzt keine stabile Kennung"));
    }
    Ok(())
}

fn require_canonical_uuid(value: &str, field: &str) -> Result<(), CatalogCompileError> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'),
        });
    if !valid {
        return invalid(format!(
            "{field} muss eine kleingeschriebene kanonische UUID sein"
        ));
    }
    Ok(())
}

fn require_non_empty(value: &str, field: &str) -> Result<(), CatalogCompileError> {
    if value.trim().is_empty() || value.trim() != value {
        return invalid(format!("{field} muss nichtleer und randfrei sein"));
    }
    Ok(())
}

fn require_safe_positive(value: u64, field: &str) -> Result<(), CatalogCompileError> {
    if value == 0 {
        return invalid(format!("{field} muss positiv sein"));
    }
    require_safe_integer(value, field)
}

fn require_safe_integer(value: u64, field: &str) -> Result<(), CatalogCompileError> {
    if value > MAX_SAFE_JSON_INTEGER {
        return invalid(format!(
            "{field} ueberschreitet den sicheren JSON-Ganzzahlbereich"
        ));
    }
    Ok(())
}

fn validate_sha256(value: &str, field: &str) -> Result<(), CatalogCompileError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return invalid(format!("{field} muss ein kleingeschriebener SHA-256 sein"));
    }
    Ok(())
}

fn validate_date(value: &str, field: &str) -> Result<(), CatalogCompileError> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return invalid(format!("{field} muss YYYY-MM-DD sein"));
    }
    let parse = |part: &[u8]| -> Option<u32> {
        part.iter().try_fold(0_u32, |number, byte| {
            byte.is_ascii_digit().then(|| {
                number
                    .saturating_mul(10)
                    .saturating_add(u32::from(*byte - b'0'))
            })
        })
    };
    let Some(year) = parse(&bytes[0..4]) else {
        return invalid(format!("{field} muss YYYY-MM-DD sein"));
    };
    let Some(month) = parse(&bytes[5..7]) else {
        return invalid(format!("{field} muss YYYY-MM-DD sein"));
    };
    let Some(day) = parse(&bytes[8..10]) else {
        return invalid(format!("{field} muss YYYY-MM-DD sein"));
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0 || day == 0 || day > max_day {
        return invalid(format!("{field} ist kein gueltiges Kalenderdatum"));
    }
    Ok(())
}

fn invalid<T>(message: impl Into<String>) -> Result<T, CatalogCompileError> {
    Err(CatalogCompileError::Invalid(message.into()))
}

fn hash_json<T: Serialize>(value: &T) -> Result<String, CatalogCompileError> {
    // Dieselbe normalisierte UTF-8-Darstellung wird von der CLI als Datei
    // publiziert. Receipt-Hashes sind damit direkt per sha256sum pruefbar und
    // nicht bloss Hashes einer unsichtbaren In-Memory-Serialisierung.
    let bytes = to_pretty_json(value)?;
    Ok(lower_hex(&Sha256::digest(bytes.as_bytes())))
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputSetHash<'a> {
    schema_version: &'a str,
    compiler_version: &'a str,
    source_catalog_release_id: &'a str,
    world_seed_id: &'a str,
    world_id: &'a str,
    produced_at: u64,
    economy_release_id: &'a str,
    source_catalog_sha256: &'a str,
    world_seed_sha256: &'a str,
    economy_release_sha256: &'a str,
    economy_projection_sha256: &'a str,
    compiled_catalog_sha256: &'a str,
    fleet_authority_sha256: &'a str,
    fleet_authority_catalog_sha256: &'a str,
    operational_inventory_sha256: &'a str,
}

fn output_set_hash(input: OutputSetHash<'_>) -> Result<String, CatalogCompileError> {
    hash_json(&input)
}

fn validate_compiled_evidence(
    field: &str,
    evidence: &CompiledFieldEvidence,
    source_ids: &BTreeSet<&str>,
) -> Result<(), CatalogCompileError> {
    if evidence.confidence_basis_points == 0 || evidence.confidence_basis_points > BASIS_POINTS_MAX
    {
        return invalid(format!(
            "{field}.confidenceBasisPoints muss zwischen 1 und {BASIS_POINTS_MAX} liegen"
        ));
    }
    require_non_empty(&evidence.method, &format!("{field}.method"))?;
    match evidence.kind {
        EvidenceKind::PublishedFact => {
            if evidence.source_ids.is_empty() {
                return invalid(format!("{field} besitzt keinen Quellenbeleg"));
            }
            let mut seen = BTreeSet::new();
            for source_id in &evidence.source_ids {
                if !source_ids.contains(source_id.as_str()) {
                    return invalid(format!(
                        "{field} referenziert unbekannte kompilierte Quelle '{source_id}'"
                    ));
                }
                if !seen.insert(source_id.as_str()) {
                    return invalid(format!(
                        "{field} referenziert kompilierte Quelle '{source_id}' mehrfach"
                    ));
                }
            }
        }
        EvidenceKind::DeterministicDerivation => {
            return invalid(format!(
                "{field} behauptet eine nicht registrierte deterministische Ableitung"
            ));
        }
        EvidenceKind::GameAssumption => {
            if !evidence.source_ids.is_empty() {
                return invalid(format!(
                    "{field} ist eine Spielannahme und darf keine Fremdquelle vortaeuschen"
                ));
            }
        }
    }
    Ok(())
}

pub fn validate_compilation(
    compilation: &VehicleCatalogCompilation,
) -> Result<(), CatalogCompileError> {
    require_schema(
        &compilation.catalog.schema_version,
        COMPILED_CATALOG_SCHEMA,
        "compiled catalog",
    )?;
    require_schema(
        &compilation.fleet_authority.schema_version,
        FLEET_AUTHORITY_SCHEMA,
        "fleet authority",
    )?;
    require_schema(
        &compilation.fleet_authority_catalog.schema_version,
        FLEET_AUTHORITY_CATALOG_SCHEMA,
        "fleet authority catalog",
    )?;
    require_schema(
        &compilation.operational_inventory.schema_version,
        OPERATIONAL_INVENTORY_SCHEMA,
        "operational inventory",
    )?;
    require_schema(
        &compilation.receipt.schema_version,
        COMPILE_RECEIPT_SCHEMA,
        "compile receipt",
    )?;
    if compilation.receipt.compiler_version != COMPILER_VERSION {
        return invalid(format!(
            "Compile-Receipt nutzt unbekannten Compiler '{}'",
            compilation.receipt.compiler_version
        ));
    }
    require_canonical_uuid(&compilation.receipt.world_id, "compileReceipt.worldId")?;
    require_safe_integer(compilation.receipt.produced_at, "compileReceipt.producedAt")?;
    let [catalog_entry] = compilation.fleet_authority_catalog.entries.as_slice() else {
        return invalid("Fleet-Authority-Katalog muss genau eine Welt enthalten");
    };
    require_canonical_uuid(
        &catalog_entry.world_id,
        "fleetAuthorityCatalog.entries[0].worldId",
    )?;
    if catalog_entry.world_id != compilation.receipt.world_id
        || catalog_entry.produced_at != compilation.receipt.produced_at
        || catalog_entry.authority_release != compilation.fleet_authority
    {
        return invalid(
            "Fleet-Authority-Katalog bindet nicht exakt Welt und Einzel-Authority des Compilers",
        );
    }
    require_identifier(
        &compilation.fleet_authority.economy_release_id,
        "fleetAuthority.economyReleaseId",
    )?;
    validate_sha256(
        &compilation.fleet_authority.economy_release_sha256,
        "fleetAuthority.economyReleaseSha256",
    )?;
    if compilation.receipt.source_catalog_release_id != compilation.catalog.release_id
        || compilation.operational_inventory.catalog_release_id != compilation.catalog.release_id
        || compilation.receipt.world_id != compilation.operational_inventory.world_id
        || compilation.receipt.economy_release_id != compilation.fleet_authority.economy_release_id
        || compilation.receipt.economy_release_sha256
            != compilation.fleet_authority.economy_release_sha256
    {
        return invalid("Katalog-, Welt- oder Receipt-Bindung ist inkonsistent");
    }
    let mut compiled_source_ids = BTreeSet::new();
    for source in &compilation.catalog.sources {
        if !compiled_source_ids.insert(source.id.as_str()) {
            return invalid("kompilierter Katalog besitzt doppelte Quellenkennungen");
        }
        validate_source(&CatalogEvidenceSource {
            id: source.id.clone(),
            title: source.title.clone(),
            url: source.url.clone(),
            license: source.license.clone(),
            retrieved_at: source.retrieved_at.clone(),
            content_sha256: source.content_sha256.clone(),
            rights_decision: source.rights_decision.clone(),
        })?;
    }
    for field in [
        &compilation.receipt.source_catalog_sha256,
        &compilation.receipt.world_seed_sha256,
        &compilation.receipt.economy_release_sha256,
        &compilation.receipt.economy_projection_sha256,
        &compilation.receipt.compiled_catalog_sha256,
        &compilation.receipt.fleet_authority_sha256,
        &compilation.receipt.fleet_authority_catalog_sha256,
        &compilation.receipt.operational_inventory_sha256,
        &compilation.receipt.output_set_sha256,
    ] {
        validate_sha256(field, "compileReceipt hash")?;
    }
    let catalog_hash = hash_json(&compilation.catalog)?;
    let authority_hash = hash_json(&compilation.fleet_authority)?;
    let authority_catalog_hash = hash_json(&compilation.fleet_authority_catalog)?;
    let operational_hash = hash_json(&compilation.operational_inventory)?;
    if catalog_hash != compilation.receipt.compiled_catalog_sha256
        || authority_hash != compilation.receipt.fleet_authority_sha256
        || authority_catalog_hash != compilation.receipt.fleet_authority_catalog_sha256
        || operational_hash != compilation.receipt.operational_inventory_sha256
        || output_set_hash(OutputSetHash {
            schema_version: COMPILE_RECEIPT_SCHEMA,
            compiler_version: COMPILER_VERSION,
            source_catalog_release_id: &compilation.receipt.source_catalog_release_id,
            world_seed_id: &compilation.receipt.world_seed_id,
            world_id: &compilation.receipt.world_id,
            produced_at: compilation.receipt.produced_at,
            economy_release_id: &compilation.receipt.economy_release_id,
            source_catalog_sha256: &compilation.receipt.source_catalog_sha256,
            world_seed_sha256: &compilation.receipt.world_seed_sha256,
            economy_release_sha256: &compilation.receipt.economy_release_sha256,
            economy_projection_sha256: &compilation.receipt.economy_projection_sha256,
            compiled_catalog_sha256: &catalog_hash,
            fleet_authority_sha256: &authority_hash,
            fleet_authority_catalog_sha256: &authority_catalog_hash,
            operational_inventory_sha256: &operational_hash,
        })? != compilation.receipt.output_set_sha256
    {
        return invalid("Compile-Receipt erkennt manipulierte Ausgabe");
    }

    let mut type_by_string = BTreeMap::new();
    let mut type_by_numeric = BTreeMap::new();
    for vehicle_type in &compilation.catalog.vehicle_types {
        for (field, evidence) in &vehicle_type.evidence {
            validate_compiled_evidence(
                &format!("Katalogtyp '{}'.evidence.{field}", vehicle_type.type_id),
                evidence,
                &compiled_source_ids,
            )?;
        }
        for option in &vehicle_type.protection_options {
            validate_compiled_evidence(
                &format!(
                    "Katalogtyp '{}'.protectionOptions.{:?}",
                    vehicle_type.type_id, option.system
                ),
                &option.evidence,
                &compiled_source_ids,
            )?;
        }
        let expected_profile = derive_operational_profile(
            vehicle_type.role,
            vehicle_type.technical.mass_kg,
            vehicle_type.technical.starting_tractive_effort_kn,
            vehicle_type.technical.brake_weight_kg,
            vehicle_type
                .operational_profile
                .maximum_acceleration_cap_mmps2,
            vehicle_type.operational_profile.service_brake_cap_mmps2,
            vehicle_type
                .operational_profile
                .emergency_brake_multiplier_basis_points,
        )?;
        if vehicle_type.operational_profile != expected_profile {
            return invalid(format!(
                "Katalogtyp '{}' besitzt kein reproduzierbares Operational-Profil",
                vehicle_type.type_id
            ));
        }
        if type_by_string
            .insert(vehicle_type.type_id.as_str(), vehicle_type)
            .is_some()
            || type_by_numeric
                .insert(vehicle_type.numeric_id, vehicle_type)
                .is_some()
        {
            return invalid("kompilierter Katalog besitzt doppelte Typkennungen");
        }
    }
    if compilation.catalog.vehicle_types.len()
        != compilation.operational_inventory.vehicle_types.len()
    {
        return invalid("Operational-Inventar enthaelt nicht exakt alle Katalogtypen");
    }
    let mut operational_type_by_id = BTreeMap::new();
    for actual in &compilation.operational_inventory.vehicle_types {
        let source = type_by_string
            .get(actual.vehicle_type.id.as_str())
            .ok_or_else(|| {
                CatalogCompileError::Invalid(format!(
                    "Operational-Typ '{}' fehlt im Katalog",
                    actual.vehicle_type.id
                ))
            })?;
        let expected = operational_vehicle_type(source)?;
        if &expected != actual {
            return invalid(format!(
                "Operational-Typ '{}' weicht von der Katalogprojektion ab",
                actual.vehicle_type.id
            ));
        }
        if operational_type_by_id
            .insert(actual.vehicle_type.id.as_str(), actual)
            .is_some()
        {
            return invalid("Operational-Inventar besitzt doppelte Typkennungen");
        }
    }

    if compilation.fleet_authority.assets.len() != compilation.operational_inventory.vehicles.len()
    {
        return invalid("Fleet Authority und Operational-Inventar enthalten andere Assetmengen");
    }
    let mut authority_by_id = BTreeMap::new();
    let mut authority_numeric_ids = BTreeSet::new();
    let mut economy_cost_by_type = BTreeMap::new();
    for asset in &compilation.fleet_authority.assets {
        let vehicle_type = type_by_numeric.get(&asset.vehicle_type_id).ok_or_else(|| {
            CatalogCompileError::Invalid(format!(
                "Authority-Asset '{}' referenziert unbekannte numerische Typkennung {}",
                asset.id, asset.vehicle_type_id
            ))
        })?;
        let expected_acceleration = if vehicle_type.role == VehicleRole::PoweredUnit {
            i64::from(vehicle_type.operational_profile.maximum_acceleration_mmps2)
        } else {
            0
        };
        let expected_deceleration = if vehicle_type.role == VehicleRole::PoweredUnit {
            i64::from(vehicle_type.operational_profile.service_brake_mmps2)
        } else {
            0
        };
        if asset.class_designation != vehicle_type.class_designation
            || asset.trade_name != vehicle_type.trade_name
            || asset.technical.length_mm != i64::from(vehicle_type.technical.length_mm)
            || u64::try_from(asset.technical.mass_kg).ok() != Some(vehicle_type.technical.mass_kg)
            || asset.technical.maximum_speed_kph != vehicle_type.technical.maximum_speed_kph
            || asset.technical.maximum_speed_mmps
                != i64::from(kilometres_per_hour_to_mmps(
                    vehicle_type.technical.maximum_speed_kph,
                )?)
            || asset.technical.continuous_power_kw
                != i64::from(vehicle_type.technical.continuous_power_kw)
            || asset.technical.starting_tractive_effort_kn
                != i64::from(vehicle_type.technical.starting_tractive_effort_kn)
            || u64::try_from(asset.technical.brake_weight_kg).ok()
                != Some(vehicle_type.technical.brake_weight_kg)
            || asset.technical.maximum_acceleration_cap_mmps2
                != i64::from(
                    vehicle_type
                        .operational_profile
                        .maximum_acceleration_cap_mmps2,
                )
            || asset.technical.service_brake_cap_mmps2
                != i64::from(vehicle_type.operational_profile.service_brake_cap_mmps2)
            || asset.technical.emergency_brake_multiplier_basis_points
                != vehicle_type
                    .operational_profile
                    .emergency_brake_multiplier_basis_points
            || asset.technical.acceleration_mm_per_s2 != expected_acceleration
            || asset.technical.deceleration_mm_per_s2 != expected_deceleration
            || asset.technical.role != vehicle_type.role
            || asset.technical.traction != vehicle_type.traction
            || asset.technical.control_stands != vehicle_type.control_stands
            || asset.technical.electric_systems != vehicle_type.electric_systems
            || asset.passenger.seats != vehicle_type.passenger.seats
            || asset.passenger.first_class_seats != vehicle_type.passenger.first_class_seats
            || asset.passenger.accessible != vehicle_type.passenger.accessible
            || asset.passenger.bicycle_places != vehicle_type.passenger.bicycle_places
            || asset.passenger.wheelchair_places != vehicle_type.passenger.wheelchair_places
            || asset.passenger.equipment != vehicle_type.passenger.equipment
            || asset.passenger.operating_cost_cents_per_train_km == 0
            || asset.passenger.replacement_plan != vehicle_type.passenger.replacement_plan
        {
            return invalid(format!(
                "Authority-Asset '{}' weicht vom gebundenen Katalogtyp ab",
                asset.id
            ));
        }
        if let Some(previous) = economy_cost_by_type.insert(
            asset.vehicle_type_id,
            asset.passenger.operating_cost_cents_per_train_km,
        ) {
            if previous != asset.passenger.operating_cost_cents_per_train_km {
                return invalid(format!(
                    "Authority-Assets des Typs {} besitzen verschiedene EconomyRelease-Kostensaetze",
                    asset.vehicle_type_id
                ));
            }
        }
        validate_authority_asset_protection(asset, vehicle_type)?;
        if let Some(configuration) = &asset.vehicle_configuration {
            validate_vehicle_configuration(configuration, vehicle_type)?;
        }
        validate_condition(&asset.condition, &asset.id)?;
        validate_restrictions(&asset.restrictions, vehicle_type, &asset.id)?;
        for history in &asset.history {
            require_non_empty(history, "fleetAuthority.assets[].history[]")?;
        }
        if !authority_numeric_ids.insert(asset.numeric_id) {
            return invalid("Fleet Authority besitzt doppelte numerische Assetkennungen");
        }
        if authority_by_id.insert(asset.id.as_str(), asset).is_some() {
            return invalid("Fleet Authority besitzt doppelte Assetkennungen");
        }
    }
    let authority_costs = economy_cost_by_type
        .iter()
        .map(|(numeric_type_id, cost)| {
            let vehicle_type = type_by_numeric.get(numeric_type_id).ok_or_else(|| {
                CatalogCompileError::Invalid(format!(
                    "Economy-Kostensatz referenziert unbekannte numerische Typkennung {numeric_type_id}"
                ))
            })?;
            Ok(VehicleOperatingCost {
                type_id: vehicle_type.type_id.clone(),
                cents_per_train_km: *cost,
            })
        })
        .collect::<Result<Vec<_>, CatalogCompileError>>()?;
    let authority_projection_sha256 = recompute_vehicle_economy_projection_sha256_from_parts(
        ECONOMY_RELEASE_SCHEMA,
        &compilation.receipt.economy_release_id,
        &compilation.receipt.economy_release_sha256,
        &authority_costs,
    )?;
    if authority_projection_sha256 != compilation.receipt.economy_projection_sha256 {
        return invalid(
            "Compile-Receipt bindet den Economy-Projektionshash nicht an die Authority-Fahrzeugkosten",
        );
    }
    let mut physical_by_id = BTreeMap::new();
    for vehicle in &compilation.operational_inventory.vehicles {
        let authority = authority_by_id.get(vehicle.id.as_str()).ok_or_else(|| {
            CatalogCompileError::Invalid(format!(
                "Operational-Asset '{}' fehlt in Fleet Authority",
                vehicle.id
            ))
        })?;
        let catalog_type = type_by_numeric
            .get(&authority.vehicle_type_id)
            .ok_or_else(|| {
                CatalogCompileError::Invalid(format!(
                    "Authority-Asset '{}' verlor seine Katalogtyp-Bindung",
                    authority.id
                ))
            })?;
        if vehicle.type_id != catalog_type.type_id
            || vehicle.powered != catalog_type.role.is_powered()
            || vehicle.orientation != authority.orientation
            || vehicle.condition != authority.condition
            || vehicle.restrictions != authority.restrictions
            || vehicle.history != authority.history
        {
            return invalid(format!(
                "Operational-Asset '{}' weicht von Fleet Authority ab",
                vehicle.id
            ));
        }
        validate_operational_protection_projection(vehicle, authority, catalog_type)?;
        if physical_by_id
            .insert(vehicle.id.as_str(), vehicle)
            .is_some()
        {
            return invalid("Operational-Inventar besitzt doppelte Assetkennungen");
        }
    }
    let mut formation_ids = BTreeSet::new();
    let mut formed_vehicle_ids = BTreeSet::new();
    let mut receipt_by_id = BTreeMap::new();
    for receipt in &compilation.fleet_authority.path_receipts {
        if receipt_by_id.insert(receipt.id.as_str(), receipt).is_some() {
            return invalid("Fleet Authority besitzt doppelte Trassenbelegkennungen");
        }
    }
    for formation in &compilation.operational_inventory.formations {
        if !formation_ids.insert(formation.id.as_str()) {
            return invalid("Operational-Inventar besitzt doppelte Formationskennungen");
        }
        let Some(receipt) = receipt_by_id.get(formation.path_receipt_id.as_str()) else {
            return invalid(format!(
                "Operational-Formation '{}' referenziert unbekannten Authority-Trassenbeleg '{}'",
                formation.id, formation.path_receipt_id
            ));
        };
        if receipt.decision != AuthorityPathDecision::Confirmed {
            return invalid(format!(
                "Operational-Formation '{}' referenziert unbestaetigten Trassenbeleg '{}'",
                formation.id, formation.path_receipt_id
            ));
        }
        for vehicle_id in &formation.vehicle_ids {
            if !formed_vehicle_ids.insert(vehicle_id.as_str()) {
                return invalid(format!(
                    "Operational-Asset '{vehicle_id}' ist mehrfach formiert"
                ));
            }
        }
        let expected = derive_formation_performance(
            &formation.id,
            &formation.vehicle_ids,
            &physical_by_id,
            &operational_type_by_id,
        )?;
        if formation.performance != expected {
            return invalid(format!(
                "Formation '{}' besitzt manipulierte Leistungswerte",
                formation.id
            ));
        }
    }
    Ok(())
}

pub fn validate_compilation_against_inputs(
    source: &VehicleSourceCatalog,
    seed: &VehicleWorldSeed,
    compilation: &VehicleCatalogCompilation,
) -> Result<(), CatalogCompileError> {
    validate_compilation(compilation)?;
    let mut normalized_source = source.clone();
    let mut normalized_seed = seed.clone();
    normalize_source_catalog(&mut normalized_source)?;
    normalize_world_seed(&mut normalized_seed)?;
    if hash_json(&normalized_source)? != compilation.receipt.source_catalog_sha256
        || hash_json(&normalized_seed)? != compilation.receipt.world_seed_sha256
    {
        return invalid("Compile-Receipt bindet nicht die vorgelegten Eingaben");
    }
    if normalized_source.release_id != compilation.receipt.source_catalog_release_id
        || normalized_seed.seed_id != compilation.receipt.world_seed_id
        || normalized_seed.world_id != compilation.receipt.world_id
        || normalized_seed.produced_at != compilation.receipt.produced_at
        || normalized_seed.economy.release.version != compilation.receipt.economy_release_id
        || normalized_seed.economy.release.checksum != compilation.receipt.economy_release_sha256
        || recompute_vehicle_economy_projection_sha256(&normalized_seed.economy)?
            != compilation.receipt.economy_projection_sha256
    {
        return invalid("Compile-Receipt besitzt inkonsistente Eingabekennungen");
    }
    let expected = compile_vehicle_catalog(source, seed)?;
    if &expected != compilation {
        return invalid("Kompilierung weicht von der deterministischen Eingabeprojektion ab");
    }
    Ok(())
}

fn validate_authority_asset_protection(
    asset: &AuthorityVehicleAsset,
    vehicle_type: &CompiledVehicleType,
) -> Result<(), CatalogCompileError> {
    let market = match asset.procurement_channel {
        ProcurementChannel::NewBuild => vehicle_type.markets.new_build,
        ProcurementChannel::Leasing => vehicle_type.markets.leasing,
        ProcurementChannel::Used => vehicle_type.markets.used,
    };
    if asset.acquisition_year < market.from || asset.acquisition_year > market.to {
        return invalid(format!(
            "Authority-Asset '{}' liegt ausserhalb des Katalog-Marktfensters",
            asset.id
        ));
    }
    for standard in &vehicle_type.standard_protection {
        if !asset.installed_protection.contains(standard) {
            return invalid(format!(
                "Authority-Asset '{}' fehlt serienmaessige Zugsicherung {:?}",
                asset.id, standard
            ));
        }
    }
    for installed in &asset.installed_protection {
        if vehicle_type.standard_protection.contains(installed) {
            continue;
        }
        let valid_option = vehicle_type.protection_options.iter().any(|option| {
            if option.system != *installed {
                return false;
            }
            let year = match option.fitment {
                ProtectionFitment::FactoryOption => asset.build_year,
                ProtectionFitment::Retrofit => asset.acquisition_year,
            };
            option.years.from <= year && year <= option.years.to
        });
        if !valid_option {
            return invalid(format!(
                "Authority-Asset '{}' traegt nicht freigegebene Zugsicherung {:?}",
                asset.id, installed
            ));
        }
    }
    validate_protection(
        &asset.installed_protection,
        vehicle_type.role != VehicleRole::Coach,
        &format!("Authority-Asset '{}'", asset.id),
    )
}

fn validate_operational_protection_projection(
    vehicle: &PhysicalVehicle,
    authority: &AuthorityVehicleAsset,
    vehicle_type: &CompiledVehicleType,
) -> Result<(), CatalogCompileError> {
    let supported = supported_protection(vehicle_type);
    for system in &supported {
        let restriction_id = format!(
            "catalog-protection-unavailable:{}",
            system.operational_name()
        );
        let expected = (!authority.installed_protection.contains(system)).then(|| {
            VehicleRestriction::ProtectionUnavailable(system.operational_name().to_owned())
        });
        if vehicle.restrictions.get(&restriction_id) != expected.as_ref() {
            return invalid(format!(
                "Operational-Asset '{}' bildet konkrete Zugsicherung {:?} nicht exakt ab",
                vehicle.id, system
            ));
        }
    }
    for restriction_id in vehicle.restrictions.keys() {
        if let Some(system) = restriction_id.strip_prefix("catalog-protection-unavailable:") {
            if !supported
                .iter()
                .any(|candidate| candidate.operational_name() == system)
            {
                return invalid(format!(
                    "Operational-Asset '{}' besitzt unbekannte Katalog-Zugsicherungsrestriktion '{restriction_id}'",
                    vehicle.id
                ));
            }
        }
    }
    Ok(())
}
