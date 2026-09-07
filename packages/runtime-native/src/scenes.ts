import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import type { ConductorSceneReleaseV1, ProjectConductorSceneInputV1, SceneProjectionV1 } from "./scene-types.js";

export interface ConductorSceneNativeAddon { projectConductorScene(input: string): string; hashConductorSceneRelease(input: string): string }
export interface ConductorSceneRuntime { project(input: ProjectConductorSceneInputV1): SceneProjectionV1; releaseHash(release: ConductorSceneReleaseV1): string }
export class ConductorSceneError extends Error {
  constructor(readonly code: string) { super("Die belegte Betriebsszene ist nicht verfügbar."); }
}
const fail = (): never => { throw new ConductorSceneError("scene_transport_invalid"); };
type Check = (value: unknown) => void;
const text: Check = (value) => { if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) fail(); };
const hash: Check = (value) => { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(); };
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Check => (value) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail();
};
const natural = integer();
const boolean: Check = (value) => { if (typeof value !== "boolean") fail(); };
const choice = (...values: readonly unknown[]): Check => (value) => { if (!values.includes(value)) fail(); };
const nullable = (check: Check): Check => (value) => { if (value !== null) check(value); };
const array = (check: Check, maximum = 1_000_000): Check => (value) => {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  for (const item of value) check(item);
};
const object = (fields: Readonly<Record<string, Check>>): Check => (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== Object.keys(fields).length || Object.keys(row).some((key) => !Object.hasOwn(fields, key))) fail();
  for (const [key, check] of Object.entries(fields)) check(row[key]);
};
const source = object({ sourceId: text, sourceSha256: hash, rightsEvidenceSha256: hash, provenance: choice("observed", "derived") });
const stationSource = object({ operatingPointId: text, name: text, kind: choice("station", "halt"), category: nullable(integer(1, 7)),
  categorySourceId: nullable(text), platformCount: integer(1, 65535), dailyCalls: nullable(integer(0, 1_000_000)), sourceIds: array(text, 10_000) });
const releaseCheck = object({ schemaVersion: choice("conductor-scene-release/v1"), releaseId: text, infraReleaseId: text, infraReleaseHash: hash,
  policyId: choice("conductor-scenes/v1"), coverage: choice("test-fixture", "release-subset", "release-complete"), sources: array(source, 10_000),
  stations: array(stationSource), routes: array(object({ routeVersionId: text, lengthMm: integer(1), sourceIds: array(text, 10_000),
    urbanity: array(object({ routeMm: natural, urbanityBasisPoints: integer(0, 10_000) })),
    stations: array(object({ operatingPointId: text, platformId: text, platformLabel: nullable(text), fromRouteMm: natural, toRouteMm: natural }), 100_000),
    signals: array(object({ signalId: text, routeMm: natural }), 100_000) })),
  calendar: object({ epochUtcTimeOfDayMs: integer(0, 86_399_999), offsets: array(object({ fromMs: natural, untilMs: natural, utcOffsetMinutes: integer(-840, 840) }), 10_000) }) });
const bindingCheck = object({ worldId: text, periodId: text, operatorId: text, trainRunId: text, regionId: text, infraReleaseId: text,
  infraReleaseHash: hash, sceneReleaseHash: hash, artReleaseId: text, artManifestHash: hash, operationalStateHash: hash,
  commitSequence: natural, validFromMs: natural, validUntilMs: natural });
const projectionCheck = object({ schemaVersion: choice("conductor-scene-projection/v1"), binding: bindingCheck, atMs: natural, routeVersionId: text,
  routeMm: natural, speedMmps: integer(0, 0xffff_ffff), motionState: choice("standing", "moving", "safe-stop"), waitingReason: nullable(text),
  environment: object({ urbanityBasisPoints: integer(0, 10_000), ruralBasisPoints: integer(0, 10_000), suburbanBasisPoints: integer(0, 10_000),
    urbanBasisPoints: integer(0, 10_000), scrollMm: natural, provenance: choice("derived"), assetIds: array(text, 32) }),
  lighting: object({ policyId: choice("conductor-scene-lighting/v1"), localTimeOfDayMs: integer(0, 86_399_999), phase: choice("night", "dawn", "day", "dusk"),
    daylightBasisPoints: integer(2500, 10_000), windowLightBasisPoints: integer(0, 7500) }),
  station: nullable(object({ schemaVersion: choice("station-scene/v1"), operatingPointId: text, name: text, platformId: text, platformLabel: nullable(text),
    size: choice("small", "medium", "large"), category: nullable(integer(1, 7)), classificationProvenance: choice("observed", "derived"),
    classificationPolicyId: text, variant: integer(0, 3), visibilityBasisPoints: integer(0, 10_000), atPlatform: boolean, assetIds: array(text, 5) })),
  signals: array(object({ signalId: text, distanceMm: integer(0, 200_000), aspect: choice("stop", "proceed", "shunting-proceed", "failed"), assetId: nullable(text) }), 100_000),
  visualOnly: choice(true), stateHash: hash });

/** Structure only; source relations and the release hash are still validated by Rust. */
export function parseConductorSceneRelease(value: unknown): ConductorSceneReleaseV1 { releaseCheck(value); return structuredClone(value) as ConductorSceneReleaseV1; }
/** Strict public whitelist with byte-integrity check; private fields cannot piggyback on scenes. */
export function parseSceneProjection(value: unknown): SceneProjectionV1 {
  projectionCheck(value);
  const projection = value as SceneProjectionV1;
  if (projection.environment.ruralBasisPoints + projection.environment.suburbanBasisPoints + projection.environment.urbanBasisPoints !== 10_000
    || projection.environment.scrollMm !== projection.routeMm
    || projection.lighting.daylightBasisPoints + projection.lighting.windowLightBasisPoints !== 10_000
    || createHash("sha256").update(JSON.stringify({ ...projection, stateHash: "" })).digest("hex") !== projection.stateHash) fail();
  return projection;
}
function nativeFailure(error: unknown): ConductorSceneError {
  const message = error instanceof Error ? error.message : "";
  const code = /^scene_[a-z0-9_]+$/u.test(message) ? message : "scene_native_failed";
  return new ConductorSceneError(code);
}
export function conductorSceneRuntimeFromAddon(addon: ConductorSceneNativeAddon): ConductorSceneRuntime {
  return Object.freeze({
    project(input: ProjectConductorSceneInputV1): SceneProjectionV1 {
      let json: string;
      try { json = addon.projectConductorScene(JSON.stringify(input)); } catch (error) { throw nativeFailure(error); }
      if (typeof json !== "string" || json.length > 64 * 1024 * 1024) return fail();
      let decoded: unknown;
      try { decoded = JSON.parse(json); } catch { return fail(); }
      const output = parseSceneProjection(decoded);
      for (const key of Object.keys(input.binding) as (keyof typeof input.binding)[]) if (output.binding[key] !== input.binding[key]) fail();
      const train = input.operational.trains.find((item) => item.trainId === input.binding.trainRunId);
      if (output.atMs !== input.sampleAtMs || output.routeVersionId !== train?.routeVersionId) fail();
      return output;
    },
    releaseHash(release: ConductorSceneReleaseV1): string {
      parseConductorSceneRelease(release);
      let result: string;
      try { result = addon.hashConductorSceneRelease(JSON.stringify(release)); } catch (error) { throw nativeFailure(error); }
      hash(result); return result;
    },
  });
}
export function loadConductorSceneRuntime(addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"]): ConductorSceneRuntime {
  if (addonPath === undefined || !isAbsolute(addonPath)) throw new ConductorSceneError("scene_addon_path_invalid");
  let addon: unknown;
  try { addon = createRequire(import.meta.url)(addonPath); } catch { throw new ConductorSceneError("scene_addon_load_failed"); }
  if (!addon || typeof addon !== "object" || ["projectConductorScene", "hashConductorSceneRelease"].some((key) => typeof Reflect.get(addon, key) !== "function"))
    throw new ConductorSceneError("scene_addon_exports_missing");
  return conductorSceneRuntimeFromAddon(addon as ConductorSceneNativeAddon);
}
