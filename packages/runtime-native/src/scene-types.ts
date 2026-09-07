import type { OperationalProjection, OperationalSignalAspect } from "./operational-simulation.js";

export type SceneProvenance = "observed" | "derived";
export type StationSceneSize = "small" | "medium" | "large";
export interface SceneSourceV1 { readonly sourceId: string; readonly sourceSha256: string; readonly rightsEvidenceSha256: string; readonly provenance: SceneProvenance }
export interface SceneStationV1 {
  readonly operatingPointId: string; readonly name: string; readonly kind: "station" | "halt";
  readonly category: number | null; readonly categorySourceId: string | null;
  readonly platformCount: number; readonly dailyCalls: number | null; readonly sourceIds: readonly string[];
}
export interface SceneRouteV1 {
  readonly routeVersionId: string; readonly lengthMm: number; readonly sourceIds: readonly string[];
  readonly urbanity: readonly { readonly routeMm: number; readonly urbanityBasisPoints: number }[];
  readonly stations: readonly { readonly operatingPointId: string; readonly platformId: string; readonly platformLabel: string | null; readonly fromRouteMm: number; readonly toRouteMm: number }[];
  readonly signals: readonly { readonly signalId: string; readonly routeMm: number }[];
}
export interface SceneCalendarV1 {
  readonly epochUtcTimeOfDayMs: number;
  readonly offsets: readonly { readonly fromMs: number; readonly untilMs: number; readonly utcOffsetMinutes: number }[];
}
export interface ConductorSceneReleaseV1 {
  readonly schemaVersion: "conductor-scene-release/v1"; readonly releaseId: string; readonly infraReleaseId: string; readonly infraReleaseHash: string;
  readonly policyId: "conductor-scenes/v1"; readonly coverage: "test-fixture" | "release-subset" | "release-complete";
  readonly sources: readonly SceneSourceV1[]; readonly stations: readonly SceneStationV1[]; readonly routes: readonly SceneRouteV1[]; readonly calendar: SceneCalendarV1;
}
export interface ConductorSceneBindingV1 {
  readonly worldId: string; readonly periodId: string; readonly operatorId: string; readonly trainRunId: string; readonly regionId: string;
  readonly infraReleaseId: string; readonly infraReleaseHash: string; readonly sceneReleaseHash: string; readonly artReleaseId: string;
  readonly artManifestHash: string; readonly operationalStateHash: string; readonly commitSequence: number; readonly validFromMs: number; readonly validUntilMs: number;
}
export interface ProjectConductorSceneInputV1 {
  readonly schemaVersion: "conductor-scene-input/v1"; readonly binding: ConductorSceneBindingV1;
  readonly sceneRelease: ConductorSceneReleaseV1; readonly operational: OperationalProjection; readonly sampleAtMs: number;
}
export interface StationSceneV1 {
  readonly schemaVersion: "station-scene/v1"; readonly operatingPointId: string; readonly name: string; readonly platformId: string; readonly platformLabel: string | null;
  readonly size: StationSceneSize; readonly category: number | null; readonly classificationProvenance: SceneProvenance; readonly classificationPolicyId: string;
  readonly variant: number; readonly visibilityBasisPoints: number; readonly atPlatform: boolean; readonly assetIds: readonly string[];
}
export interface SceneProjectionV1 {
  readonly schemaVersion: "conductor-scene-projection/v1"; readonly binding: ConductorSceneBindingV1; readonly atMs: number; readonly routeVersionId: string;
  readonly routeMm: number; readonly speedMmps: number; readonly motionState: "standing" | "moving" | "safe-stop"; readonly waitingReason: string | null;
  readonly environment: { readonly urbanityBasisPoints: number; readonly ruralBasisPoints: number; readonly suburbanBasisPoints: number; readonly urbanBasisPoints: number;
    readonly scrollMm: number; readonly provenance: "derived"; readonly assetIds: readonly string[] };
  readonly lighting: { readonly policyId: "conductor-scene-lighting/v1"; readonly localTimeOfDayMs: number; readonly phase: "night" | "dawn" | "day" | "dusk";
    readonly daylightBasisPoints: number; readonly windowLightBasisPoints: number };
  readonly station: StationSceneV1 | null;
  readonly signals: readonly { readonly signalId: string; readonly distanceMm: number; readonly aspect: OperationalSignalAspect; readonly assetId: string | null }[];
  readonly visualOnly: true; readonly stateHash: string;
}
