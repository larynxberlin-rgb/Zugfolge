use serde::{Deserialize, Serialize};
use zugfolge_demand::{
    ComfortClassV1, DemandEvaluationV1, SpaceNeedsV1, TrainCapacityV1, TrainServiceV1,
};
use zugfolge_fleet::{
    MobilizationSnapshot, VehicleConfigurationV1, release_catalog::FleetAuthorityRelease,
};

use crate::{
    ConductorPassengerBindingV1, InteriorPlaceKindV1, PassengerActivityV1, PassengerPostureV1,
    PassengerProjectionPhaseV1,
};

pub const LAYOUT_INPUT_SCHEMA: &str = "conductor-interior-layout-input/v1";
pub const LAYOUT_SCHEMA: &str = "interior-layout/v1";
pub const GEOMETRY_POLICY_SCHEMA: &str = "conductor-interior-geometry-policy/v1";
pub const INTERIOR_V2_SCHEMA: &str = "interior-passenger-places/v2";
pub const PROJECTION_V2_SCHEMA: &str = "passenger-projection/v2";
pub const PROJECTION_INPUT_V2_SCHEMA: &str = "conductor-passenger-projection-input/v2";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteriorDeckIdV1 {
    Main,
    Lower,
    Upper,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorPointV1 {
    pub vehicle_id: String,
    pub body_id: String,
    pub deck_id: InteriorDeckIdV1,
    pub x_mm: i64,
    pub y_mm: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorRectV1 {
    pub x_mm: i64,
    pub y_mm: i64,
    pub length_mm: i64,
    pub width_mm: i64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorLayoutBindingV1 {
    pub world_id: String,
    pub period_id: String,
    pub operator_id: String,
    pub formation_id: String,
    pub formation_revision: u64,
    pub fleet_state_hash: String,
    pub fleet_authority_release_id: String,
    pub fleet_authority_release_hash: String,
    pub mobilization_snapshot_hash: String,
    pub geometry_policy_hash: String,
    pub art_release_id: String,
    pub art_manifest_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorStairGeometryV1 {
    pub stair_id: String,
    pub from_deck_id: InteriorDeckIdV1,
    pub to_deck_id: InteriorDeckIdV1,
    pub at_mm: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorBodyGeometryV1 {
    pub body_id: String,
    pub length_mm: u32,
    pub width_mm: u32,
    pub deck_ids: Vec<InteriorDeckIdV1>,
    pub entrance_deck_id: InteriorDeckIdV1,
    pub door_positions_mm: Vec<u32>,
    pub stairs: Vec<InteriorStairGeometryV1>,
    pub gap_after_mm: u32,
    pub front_gangway: bool,
    pub rear_gangway: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorVehicleGeometryV1 {
    pub vehicle_type_id: u64,
    pub configuration_hash: Option<String>,
    pub art_family: String,
    pub bodies: Vec<InteriorBodyGeometryV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorGeometryPolicyV1 {
    pub schema_version: String,
    pub policy_id: String,
    pub vehicle_types: Vec<InteriorVehicleGeometryV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildInteriorLayoutInputV1 {
    pub schema_version: String,
    pub binding: InteriorLayoutBindingV1,
    pub authority_release: FleetAuthorityRelease,
    pub mobilization: MobilizationSnapshot,
    pub geometry_policy: InteriorGeometryPolicyV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorPassengerPlaceV2 {
    pub place_id: String,
    pub vehicle_id: String,
    pub body_id: String,
    pub deck_id: InteriorDeckIdV1,
    pub x_mm: i64,
    pub y_mm: i64,
    pub comfort_class: ComfortClassV1,
    pub kind: InteriorPlaceKindV1,
    pub space_needs: Vec<SpaceNeedsV1>,
}

/// Zusätzliche exklusive Raumressource; zählt niemals als weiterer Fahrgastplatz.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorSpecialBayV1 {
    pub space_id: String,
    pub vehicle_id: String,
    pub body_id: String,
    pub deck_id: InteriorDeckIdV1,
    pub x_mm: i64,
    pub y_mm: i64,
    pub space_need: SpaceNeedsV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorPassengerPlacesV2 {
    pub schema_version: String,
    pub world_id: String,
    pub train_run_id: String,
    pub layout_id: String,
    pub source_layout_hash: String,
    pub layout_hash: String,
    pub places: Vec<InteriorPassengerPlaceV2>,
    pub special_bays: Vec<InteriorSpecialBayV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisiblePassengerV2 {
    pub passenger_key: String,
    pub place_id: String,
    pub space_id: Option<String>,
    pub vehicle_id: String,
    pub body_id: String,
    pub deck_id: InteriorDeckIdV1,
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
pub struct PassengerProjectionV2 {
    pub schema_version: String,
    pub binding: ConductorPassengerBindingV1,
    pub segment_id: String,
    pub from_stop_id: String,
    pub to_stop_id: String,
    pub phase: PassengerProjectionPhaseV1,
    pub current_stop_id: Option<String>,
    pub layout_id: String,
    pub source_layout_hash: String,
    pub layout_hash: String,
    pub as_of_ms: i64,
    pub passengers: Vec<VisiblePassengerV2>,
    pub state_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectConductorPassengersInputV2 {
    pub schema_version: String,
    pub binding: ConductorPassengerBindingV1,
    pub evaluation: DemandEvaluationV1,
    pub service: TrainServiceV1,
    pub interior: InteriorPassengerPlacesV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_projection: Option<PassengerProjectionV2>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteriorObstacleKindV1 {
    Wall,
    Cab,
    Seat,
    Toilet,
    AccessibleToilet,
    Stair,
    Bicycle,
    Stroller,
    Wheelchair,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorObstacleV1 {
    pub obstacle_id: String,
    pub vehicle_id: String,
    pub body_id: String,
    pub deck_id: InteriorDeckIdV1,
    pub kind: InteriorObstacleKindV1,
    pub rect: InteriorRectV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorNodeV1 {
    pub node_id: String,
    pub point: InteriorPointV1,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteriorEdgeKindV1 {
    Walk,
    Stair,
    Gangway,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorEdgeV1 {
    pub edge_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub kind: InteriorEdgeKindV1,
    pub length_mm: u64,
    pub wheelchair_accessible: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteriorInteractionKindV1 {
    Passenger,
    Door,
    Toilet,
    AccessibleToilet,
    Cab,
    Stair,
    Bicycle,
    Stroller,
    Wheelchair,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorInteractionV1 {
    pub interaction_id: String,
    pub kind: InteriorInteractionKindV1,
    pub target_id: String,
    pub node_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorDoorV1 {
    pub door_id: String,
    pub vehicle_id: String,
    pub body_id: String,
    pub deck_id: InteriorDeckIdV1,
    pub side: String,
    pub rect: InteriorRectV1,
    pub node_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InteriorSeatFacingV1 {
    Forward,
    Backward,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorSeatV1 {
    pub place_id: String,
    pub obstacle_id: String,
    pub facing: InteriorSeatFacingV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorBodyV1 {
    pub body_id: String,
    pub vehicle_id: String,
    pub length_mm: u32,
    pub width_mm: u32,
    pub vehicle_offset_mm: u32,
    pub formation_offset_mm: u64,
    pub reversed: bool,
    pub deck_ids: Vec<InteriorDeckIdV1>,
    pub entrance_deck_id: InteriorDeckIdV1,
    pub passenger_accessible: bool,
    pub front_gangway: bool,
    pub rear_gangway: bool,
    pub gap_after_mm: u32,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorVehicleV1 {
    pub vehicle_id: String,
    pub vehicle_type_id: u64,
    pub configuration: Option<VehicleConfigurationV1>,
    pub configuration_hash: Option<String>,
    pub art_family: String,
    pub capacity: TrainCapacityV1,
    pub bodies: Vec<InteriorBodyV1>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorLayoutV1 {
    pub schema_version: String,
    pub binding: InteriorLayoutBindingV1,
    pub layout_id: String,
    pub layout_hash: String,
    pub capacity: TrainCapacityV1,
    pub vehicles: Vec<InteriorVehicleV1>,
    pub passenger_places: Vec<InteriorPassengerPlaceV2>,
    pub special_bays: Vec<InteriorSpecialBayV1>,
    pub obstacles: Vec<InteriorObstacleV1>,
    pub nodes: Vec<InteriorNodeV1>,
    pub edges: Vec<InteriorEdgeV1>,
    pub interactions: Vec<InteriorInteractionV1>,
    pub doors: Vec<InteriorDoorV1>,
    pub seats: Vec<InteriorSeatV1>,
    pub entrance_node_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorLayoutIssueV1 {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vehicle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindInteriorPassengerPlacesInputV1 {
    pub schema_version: String,
    pub layout: InteriorLayoutV1,
    pub train_run_id: String,
    pub service: TrainServiceV1,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FindInteriorPathInputV1 {
    pub schema_version: String,
    pub layout: InteriorLayoutV1,
    pub expected_layout_hash: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub wheelchair: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorPathV1 {
    pub schema_version: String,
    pub layout_hash: String,
    pub node_ids: Vec<String>,
    pub edge_ids: Vec<String>,
    pub length_mm: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckInteriorMovementInputV1 {
    pub schema_version: String,
    pub layout: InteriorLayoutV1,
    pub expected_layout_hash: String,
    pub from: InteriorPointV1,
    pub to: InteriorPointV1,
    pub transition_edge_id: Option<String>,
    pub wheelchair: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InteriorMovementResultV1 {
    pub schema_version: String,
    pub layout_hash: String,
    pub allowed: bool,
    pub issue: Option<String>,
}
