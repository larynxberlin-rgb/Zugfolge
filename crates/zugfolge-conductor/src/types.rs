use serde::{Deserialize, Serialize};
use zugfolge_demand::{ComfortClassV1, DemandEvaluationV1, SpaceNeedsV1, TrainServiceV1};

pub const INPUT_SCHEMA: &str = "conductor-passenger-projection-input/v1";
pub const PROJECTION_SCHEMA: &str = "passenger-projection/v1";
pub const INTERIOR_SCHEMA: &str = "interior-passenger-places/v1";

/// Interne Zustandspins, die der autorisierte Server unabhängig zuliefert.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConductorPassengerBindingV1 {
    pub world_id: String,
    pub period_id: String,
    pub demand_release_id: String,
    pub release_hash: String,
    pub seed_hash: String,
    pub train_run_id: String,
    pub operator_id: String,
    pub manifest_revision: u64,
    pub demand_state_hash: String,
    pub operational_receipt_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteriorPlaceKindV1 {
    Seat,
    Standing,
}

/// Servergeprüfter logischer Fahrgastplatz mit expliziter Innenraumgeometrie.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorPassengerPlaceV1 {
    pub place_id: String,
    pub vehicle_id: String,
    pub x_mm: i64,
    pub y_mm: i64,
    pub comfort_class: ComfortClassV1,
    pub kind: InteriorPlaceKindV1,
    pub space_needs: Vec<SpaceNeedsV1>,
}

/// Welt- und zuggebundene Teilmenge des späteren Innenraumreleases.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorPassengerPlacesV1 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub layout_id: String,
    pub layout_hash: String,
    pub places: Vec<InteriorPassengerPlaceV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectConductorPassengersInputV1 {
    pub schema_version: String,
    pub binding: ConductorPassengerBindingV1,
    pub evaluation: DemandEvaluationV1,
    pub service: TrainServiceV1,
    pub interior: InteriorPassengerPlacesV1,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_projection: Option<PassengerProjectionV1>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PassengerPostureV1 {
    Seated,
    Standing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PassengerActivityV1 {
    Onboard,
    Alighting,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PassengerProjectionPhaseV1 {
    InTransit,
    AtStop,
}

/// Abschließende Sichtbarkeitsliste ohne Fahrausweisfakten oder private Reisekette.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisiblePassengerV1 {
    pub passenger_key: String,
    pub place_id: String,
    pub vehicle_id: String,
    pub x_mm: i64,
    pub y_mm: i64,
    pub comfort_class: ComfortClassV1,
    pub space_needs: SpaceNeedsV1,
    pub posture: PassengerPostureV1,
    pub appearance_variant: u32,
    pub activity: PassengerActivityV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PassengerProjectionV1 {
    pub schema_version: String,
    pub binding: ConductorPassengerBindingV1,
    pub segment_id: String,
    pub from_stop_id: String,
    pub to_stop_id: String,
    pub phase: PassengerProjectionPhaseV1,
    pub current_stop_id: Option<String>,
    pub layout_id: String,
    pub layout_hash: String,
    pub as_of_ms: i64,
    pub passengers: Vec<VisiblePassengerV1>,
    pub state_hash: String,
}
