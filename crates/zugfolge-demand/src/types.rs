use serde::{Deserialize, Serialize};

pub const INPUT_SCHEMA: &str = "zugfolge-demand-evaluation/v1";
pub const RESULT_SCHEMA: &str = "zugfolge-demand-result/v1";
pub const RELEASE_SCHEMA: &str = "zugfolge-demand-release/v1";

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceEvidenceV1 {
    pub id: String,
    pub url: String,
    pub license: String,
    pub artifact_sha256: String,
    pub rights_approved: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    Observed,
    Balanced,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StationTransitAccessV1 {
    pub station_id: String,
    pub access_ms: i64,
    pub service_interval_ms: i64,
    pub step_free: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandZoneV1 {
    pub id: String,
    pub population: u32,
    pub workplaces: u32,
    pub poi_weight: u32,
    pub stations: Vec<StationTransitAccessV1>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComfortClassV1 {
    Standard,
    Premium,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpaceNeedsV1 {
    Ordinary,
    Wheelchair,
    Bicycle,
    Stroller,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChoiceDimensionV1 {
    Fare,
    Time,
    Transfers,
    Frequency,
    Reliability,
    Comfort,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandProfileV1 {
    pub id: String,
    pub purpose: String,
    pub daily_trips_basis_points: u32,
    pub workplace_weight: u32,
    pub poi_weight: u32,
    pub population_weight: u32,
    pub comfort_class: ComfortClassV1,
    pub space_needs: SpaceNeedsV1,
    pub requires_reservation: bool,
    pub max_fare_cents: i64,
    pub max_journey_ms: i64,
    pub ranking: Vec<ChoiceDimensionV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandDaySliceV1 {
    pub id: String,
    pub start_offset_ms: i64,
    pub end_offset_ms: i64,
    pub share_basis_points: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareCompliancePolicyV1 {
    pub schema_version: String,
    pub valid_basis_points: u32,
    pub unpresentable_basis_points: u32,
    pub provenance: Provenance,
    pub source_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandReleaseV1 {
    pub schema_version: String,
    pub id: String,
    pub provenance: Provenance,
    pub sources: Vec<SourceEvidenceV1>,
    pub zones: Vec<DemandZoneV1>,
    pub profiles: Vec<DemandProfileV1>,
    pub day_slices: Vec<DemandDaySliceV1>,
    pub season_basis_points: u32,
    pub minimum_transfer_ms: i64,
    pub max_transfers: u32,
    pub max_generated_passengers: u32,
    pub max_connections_per_cohort: u32,
    pub fare_compliance: FareCompliancePolicyV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RailModeV1 {
    Spnv,
    Spfv,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrainStopV1 {
    pub stop_id: String,
    pub station_id: String,
    pub arrival_ms: i64,
    pub departure_ms: i64,
    pub passenger_stop: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FareProductV1 {
    pub id: String,
    pub comfort_class: ComfortClassV1,
    pub cents_per_segment: i64,
    pub sales_available: bool,
    pub onboard_sales: bool,
    pub reservation_required: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrainCapacityV1 {
    pub standard_seats: u32,
    pub standard_standing: u32,
    pub premium_seats: u32,
    pub wheelchair_spaces: u32,
    pub bicycle_spaces: u32,
    pub stroller_spaces: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrainServiceV1 {
    pub world_id: String,
    pub train_run_id: String,
    pub operator_id: String,
    pub mode: RailModeV1,
    pub cancelled: bool,
    pub stops: Vec<TrainStopV1>,
    pub fares: Vec<FareProductV1>,
    pub capacity: TrainCapacityV1,
    pub service_interval_ms: i64,
    pub reliability_basis_points: u32,
    pub comfort_basis_points: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlternativeModeV1 {
    Car,
    Coach,
    LocalTransit,
    Walk,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlternativeServiceV1 {
    pub world_id: String,
    pub id: String,
    pub origin_zone_id: String,
    pub destination_zone_id: String,
    pub mode: AlternativeModeV1,
    pub fare_cents: i64,
    pub journey_ms: i64,
    pub service_interval_ms: i64,
    pub reliability_basis_points: u32,
    pub comfort_basis_points: u32,
    pub capacity: u32,
    pub accessible: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandEvaluationInputV1 {
    pub schema_version: String,
    pub world_id: String,
    pub period_id: String,
    pub seed: String,
    pub now_ms: i64,
    pub revision: u64,
    pub window_start_ms: i64,
    pub window_end_ms: i64,
    pub day_slice_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_windows: Option<Vec<DemandGenerationWindowV1>>,
    pub release: DemandReleaseV1,
    pub services: Vec<TrainServiceV1>,
    pub alternatives: Vec<AlternativeServiceV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_evaluation: Option<Box<PreviousDemandEvaluationV1>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operational_progress: Option<DemandOperationalProgressV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandGenerationWindowV1 {
    pub window_start_ms: i64,
    pub window_end_ms: i64,
    pub day_slice_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviousDemandEvaluationV1 {
    pub result: DemandEvaluationV1,
    pub services: Vec<TrainServiceV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandOperationalProgressV1 {
    pub schema_version: String,
    pub world_id: String,
    pub as_of_ms: i64,
    pub receipt_id: String,
    pub trains: Vec<TrainOperationalProgressV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrainOperationalProgressV1 {
    pub train_run_id: String,
    pub stops: Vec<StopOperationalProgressV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopOperationalProgressV1 {
    pub stop_id: String,
    pub actual_arrival_ms: Option<i64>,
    pub actual_departure_ms: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JourneyDemandV1 {
    pub world_id: String,
    pub cohort_id: String,
    pub origin_zone_id: String,
    pub destination_zone_id: String,
    pub profile_id: String,
    pub purpose: String,
    pub passengers: u32,
    pub desired_departure_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChoiceMetricsV1 {
    pub fare_cents: i64,
    pub journey_ms: i64,
    pub transfers: u32,
    pub service_interval_ms: i64,
    pub reliability_basis_points: u32,
    pub comfort_basis_points: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrainChoiceV1 {
    pub train_run_id: String,
    pub mode: RailModeV1,
    pub boarding_stop_id: String,
    pub alighting_stop_id: String,
    pub fare_product_id: String,
    pub fare_cents_per_segment: i64,
    pub reservation_required: bool,
    pub segment_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionChoiceV1 {
    pub world_id: String,
    pub cohort_id: String,
    pub connection_id: String,
    pub alternative_mode: Option<AlternativeModeV1>,
    pub trains: Vec<TrainChoiceV1>,
    pub metrics: ChoiceMetricsV1,
    pub ranking: Vec<ChoiceDimensionV1>,
    pub ordinal_start: u32,
    pub passengers: u32,
    pub journey_status: String,
    pub rejected: Vec<RejectedConnectionV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RejectedConnectionV1 {
    pub connection_id: String,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnservedDemandV1 {
    pub world_id: String,
    pub cohort_id: String,
    pub ordinal_start: u32,
    pub passengers: u32,
    pub reason: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapacityAllocationV1 {
    pub world_id: String,
    pub train_run_id: String,
    pub segment_id: String,
    pub from_stop_id: String,
    pub to_stop_id: String,
    pub operator_id: String,
    pub mode: RailModeV1,
    pub passengers: u32,
    pub seated: u32,
    pub standing: u32,
    pub reserved: u32,
    pub wheelchair: u32,
    pub bicycle: u32,
    pub stroller: u32,
    pub capacity: u32,
    pub forecast_revenue_cents: i64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FareFactV1 {
    Valid,
    ValidUnpresentable,
    Invalid,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestPassengerV1 {
    pub passenger_key: String,
    pub journey_chain_id: String,
    pub boarding_stop_id: String,
    pub alighting_stop_id: String,
    pub demand_segment: String,
    pub comfort_class: ComfortClassV1,
    pub space_needs: SpaceNeedsV1,
    pub fare_fact: FareFactV1,
    pub fare_policy_provenance: Provenance,
    pub reservation_id: Option<String>,
    pub seat_number: Option<u32>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PassengerManifestV1 {
    pub schema_version: String,
    pub world_id: String,
    pub demand_release_id: String,
    pub train_run_id: String,
    pub segment_id: String,
    pub revision: u64,
    pub passengers: Vec<ManifestPassengerV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopPassengerFlowV1 {
    pub world_id: String,
    pub train_run_id: String,
    pub stop_id: String,
    pub boarding: u32,
    pub alighting: u32,
    pub onboard_after: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandTotalsV1 {
    pub generated: u32,
    pub rail: u32,
    pub alternative: u32,
    pub unserved: u32,
    pub stranded: u32,
    pub forecast_revenue_cents: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DemandEvaluationV1 {
    pub schema_version: String,
    pub world_id: String,
    pub period_id: String,
    pub demand_release_id: String,
    pub release_hash: String,
    pub seed_hash: String,
    pub now_ms: i64,
    pub revision: u64,
    pub window_start_ms: i64,
    pub window_end_ms: i64,
    pub generation_windows: Vec<DemandGenerationWindowV1>,
    pub projection_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operational_progress: Option<DemandOperationalProgressV1>,
    pub cohorts: Vec<JourneyDemandV1>,
    pub choices: Vec<ConnectionChoiceV1>,
    pub unserved: Vec<UnservedDemandV1>,
    pub allocations: Vec<CapacityAllocationV1>,
    pub manifests: Vec<PassengerManifestV1>,
    pub journey_seats: Vec<PassengerSeatAssignmentV1>,
    pub stop_flows: Vec<StopPassengerFlowV1>,
    pub totals: DemandTotalsV1,
    pub state_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PassengerSeatAssignmentV1 {
    pub cohort_id: String,
    pub ordinal: u32,
    pub train_run_id: String,
    pub segment_id: String,
    pub seat_number: Option<u32>,
    pub reserved: bool,
}
