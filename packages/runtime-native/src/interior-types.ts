import type { FleetAuthorityRelease, NativeFleetMobilizationSnapshot } from "./index.js";
import type { ConductorPassengerBindingV1, PassengerComfortClass, PassengerProjectionV1, PassengerSpaceNeeds } from "./conductor.js";
import type { M5VehicleConfigurationV1 } from "./vehicle-configuration.js";

export type InteriorDeckId = "main" | "lower" | "upper";
export interface InteriorPointV1 {
  readonly vehicleId: string; readonly bodyId: string; readonly deckId: InteriorDeckId;
  readonly xMm: number; readonly yMm: number;
}
export interface InteriorRectV1 { readonly xMm: number; readonly yMm: number; readonly lengthMm: number; readonly widthMm: number }
export interface InteriorLayoutBindingV1 {
  readonly worldId: string; readonly periodId: string; readonly operatorId: string;
  readonly formationId: string; readonly formationRevision: number; readonly fleetStateHash: string;
  readonly fleetAuthorityReleaseId: string; readonly fleetAuthorityReleaseHash: string;
  readonly mobilizationSnapshotHash: string; readonly geometryPolicyHash: string;
  readonly artReleaseId: string; readonly artManifestHash: string;
}
export interface InteriorStairGeometryV1 {
  readonly stairId: string; readonly fromDeckId: InteriorDeckId; readonly toDeckId: InteriorDeckId; readonly atMm: number;
}
export interface InteriorBodyGeometryV1 {
  readonly bodyId: string; readonly lengthMm: number; readonly widthMm: number;
  readonly deckIds: readonly InteriorDeckId[]; readonly entranceDeckId: InteriorDeckId;
  readonly doorPositionsMm: readonly number[]; readonly stairs: readonly InteriorStairGeometryV1[];
  readonly gapAfterMm: number; readonly frontGangway: boolean; readonly rearGangway: boolean;
}
export interface InteriorVehicleGeometryV1 {
  readonly vehicleTypeId: number; readonly configurationHash: string | null; readonly artFamily: string;
  readonly bodies: readonly InteriorBodyGeometryV1[];
}
export interface InteriorGeometryPolicyV1 {
  readonly schemaVersion: "conductor-interior-geometry-policy/v1";
  readonly policyId: string; readonly vehicleTypes: readonly InteriorVehicleGeometryV1[];
}
export interface BuildInteriorLayoutInputV1 {
  readonly schemaVersion: "conductor-interior-layout-input/v1";
  readonly binding: InteriorLayoutBindingV1; readonly authorityRelease: FleetAuthorityRelease;
  readonly mobilization: NativeFleetMobilizationSnapshot; readonly geometryPolicy: InteriorGeometryPolicyV1;
}
export interface InteriorCapacityV1 {
  readonly standardSeats: number; readonly standardStanding: number; readonly premiumSeats: number;
  readonly wheelchairSpaces: number; readonly bicycleSpaces: number; readonly strollerSpaces: number;
}
export interface InteriorPassengerPlaceV2 extends InteriorPointV1 {
  readonly placeId: string; readonly comfortClass: PassengerComfortClass;
  readonly kind: "seat" | "standing"; readonly spaceNeeds: readonly PassengerSpaceNeeds[];
}
export interface InteriorSpecialBayV1 extends InteriorPointV1 { readonly spaceId: string; readonly spaceNeed: PassengerSpaceNeeds }
export interface InteriorPassengerPlacesV2 {
  readonly schemaVersion: "interior-passenger-places/v2";
  readonly worldId: string; readonly trainRunId: string; readonly layoutId: string;
  readonly sourceLayoutHash: string; readonly layoutHash: string;
  readonly places: readonly InteriorPassengerPlaceV2[]; readonly specialBays: readonly InteriorSpecialBayV1[];
}
export interface VisiblePassengerV2 extends InteriorPointV1 {
  readonly passengerKey: string; readonly placeId: string; readonly spaceId: string | null;
  readonly comfortClass: PassengerComfortClass; readonly spaceNeeds: PassengerSpaceNeeds;
  readonly posture: "seated" | "standing"; readonly appearanceVariant: number; readonly activity: "onboard" | "alighting";
}
export interface PassengerProjectionV2 extends Omit<PassengerProjectionV1, "schemaVersion" | "passengers"> {
  readonly schemaVersion: "passenger-projection/v2"; readonly sourceLayoutHash: string;
  readonly passengers: readonly VisiblePassengerV2[];
}
export interface ProjectConductorPassengersInputV2 {
  readonly schemaVersion: "conductor-passenger-projection-input/v2"; readonly binding: ConductorPassengerBindingV1;
  readonly evaluation: Readonly<Record<string, unknown>>; readonly service: Readonly<Record<string, unknown>>;
  readonly interior: InteriorPassengerPlacesV2; readonly previousProjection?: PassengerProjectionV2;
}
export interface InteriorBodyV1 {
  readonly bodyId: string; readonly vehicleId: string; readonly lengthMm: number; readonly widthMm: number;
  readonly vehicleOffsetMm: number; readonly formationOffsetMm: number; readonly reversed: boolean;
  readonly deckIds: readonly InteriorDeckId[]; readonly entranceDeckId: InteriorDeckId;
  readonly passengerAccessible: boolean; readonly frontGangway: boolean; readonly rearGangway: boolean; readonly gapAfterMm: number;
}
export interface InteriorVehicleV1 {
  readonly vehicleId: string; readonly vehicleTypeId: number; readonly configuration: M5VehicleConfigurationV1 | null;
  readonly configurationHash: string | null; readonly artFamily: string;
  readonly capacity: InteriorCapacityV1; readonly bodies: readonly InteriorBodyV1[];
}
export interface InteriorObstacleV1 extends Omit<InteriorPointV1, "xMm" | "yMm"> {
  readonly obstacleId: string;
  readonly kind: "wall" | "cab" | "seat" | "toilet" | "accessible_toilet" | "stair" | "bicycle" | "stroller" | "wheelchair";
  readonly rect: InteriorRectV1;
}
export interface InteriorNodeV1 { readonly nodeId: string; readonly point: InteriorPointV1 }
export interface InteriorEdgeV1 {
  readonly edgeId: string; readonly fromNodeId: string; readonly toNodeId: string;
  readonly kind: "walk" | "stair" | "gangway"; readonly lengthMm: number; readonly wheelchairAccessible: boolean;
}
export interface InteriorInteractionV1 {
  readonly interactionId: string; readonly kind: "passenger" | "door" | "toilet" | "accessible_toilet" | "cab" | "stair" | "bicycle" | "stroller" | "wheelchair";
  readonly targetId: string; readonly nodeId: string;
}
export interface InteriorDoorV1 extends Omit<InteriorPointV1, "xMm" | "yMm"> {
  readonly doorId: string; readonly side: "left" | "right"; readonly rect: InteriorRectV1; readonly nodeId: string;
}
export interface InteriorSeatV1 { readonly placeId: string; readonly obstacleId: string; readonly facing: "forward" | "backward" }
export interface InteriorLayoutV1 {
  readonly schemaVersion: "interior-layout/v1"; readonly binding: InteriorLayoutBindingV1;
  readonly layoutId: string; readonly layoutHash: string; readonly capacity: InteriorCapacityV1;
  readonly vehicles: readonly InteriorVehicleV1[]; readonly passengerPlaces: readonly InteriorPassengerPlaceV2[];
  readonly specialBays: readonly InteriorSpecialBayV1[]; readonly obstacles: readonly InteriorObstacleV1[];
  readonly nodes: readonly InteriorNodeV1[]; readonly edges: readonly InteriorEdgeV1[];
  readonly interactions: readonly InteriorInteractionV1[]; readonly doors: readonly InteriorDoorV1[];
  readonly seats: readonly InteriorSeatV1[]; readonly entranceNodeId: string;
}
export interface BindInteriorPassengerPlacesInputV1 {
  readonly schemaVersion: "conductor-interior-bind-input/v1"; readonly layout: InteriorLayoutV1;
  readonly trainRunId: string; readonly service: Readonly<Record<string, unknown>>;
}
export interface FindInteriorPathInputV1 {
  readonly schemaVersion: "conductor-interior-path-input/v1"; readonly layout: InteriorLayoutV1;
  readonly expectedLayoutHash: string; readonly fromNodeId: string; readonly toNodeId: string; readonly wheelchair: boolean;
}
export interface InteriorPathV1 {
  readonly schemaVersion: "interior-path/v1"; readonly layoutHash: string;
  readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[]; readonly lengthMm: number;
}
export interface CheckInteriorMovementInputV1 {
  readonly schemaVersion: "conductor-interior-movement-input/v1"; readonly layout: InteriorLayoutV1;
  readonly expectedLayoutHash: string; readonly from: InteriorPointV1; readonly to: InteriorPointV1;
  readonly transitionEdgeId: string | null; readonly wheelchair: boolean;
}
export interface InteriorMovementResultV1 {
  readonly schemaVersion: "interior-movement-result/v1"; readonly layoutHash: string;
  readonly allowed: boolean; readonly issue: string | null;
}
