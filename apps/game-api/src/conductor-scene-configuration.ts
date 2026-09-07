import { parseConductorSceneRelease, type ConductorSceneReleaseV1, type ConductorSceneRuntime } from "@zugfolge/runtime-native";
import { createHash } from "node:crypto";
import { readLocalDeploymentFile as localRegularFile } from "./conductor-deployment-files.js";

const HASH = /^[a-f0-9]{64}$/u;
const FAILURE = "Das gepinnte Szenendeployment oder seine ursprüngliche Infrastrukturbindung ist ungültig.";
function check(value: unknown): asserts value { if (!value) throw new Error(FAILURE); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  check(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key)));
  return row;
}
function text(value: unknown): string { check(typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)); return value; }
function digest(value: unknown): string { check(typeof value === "string" && HASH.test(value)); return value; }
function natural(value: unknown): number { check(Number.isSafeInteger(value) && Number(value) >= 0); return Number(value); }
function list(value: unknown, maximum: number): unknown[] { check(Array.isArray(value) && value.length > 0 && value.length <= maximum); return value; }

function json(bytes: Buffer): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
function bytesHash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export interface ConductorScenePeriod {
  readonly periodId: string; readonly validFromMs: number; readonly validUntilMs: number;
  readonly regionId: string; readonly infraReleaseId: string; readonly infraReleaseHash: string;
  readonly artReleaseId: string; readonly artManifestHash: string;
  readonly sceneReleaseHash: string; readonly sceneRelease: ConductorSceneReleaseV1;
}
export interface ConductorSceneDeployment {
  period(worldId: string, periodId: string, regionId: string, nowMs: number,
    infraReleaseId: string, infraReleaseHash: string): ConductorScenePeriod | undefined;
}
class VerifiedSceneDeployment implements ConductorSceneDeployment {
  readonly #worldId: string;
  readonly #periods: readonly ConductorScenePeriod[];
  constructor(worldId: string, periods: ConductorScenePeriod[]) { this.#worldId = worldId; this.#periods = periods; Object.freeze(this); }
  period(worldId: string, periodId: string, regionId: string, nowMs: number, infraReleaseId: string, infraReleaseHash: string): ConductorScenePeriod | undefined {
    if (worldId !== this.#worldId || !Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
    const period = this.#periods.find((row) => row.periodId === periodId && row.regionId === regionId
      && row.validFromMs <= nowMs && nowMs < row.validUntilMs && row.infraReleaseId === infraReleaseId && row.infraReleaseHash === infraReleaseHash);
    return period === undefined ? undefined : structuredClone(period);
  }
}

/** Independent deployment pins; no trust, file paths or scene data are accepted from the browser. */
export async function loadConductorSceneDeployment(input: {
  readonly path: string; readonly expectedSha256: string; readonly worldId: string;
  readonly runtime: Pick<ConductorSceneRuntime, "releaseHash">;
  /** Only explicit local test callers may attach the separately labelled fictional source corpus. */
  readonly allowTestFixtures?: true;
}): Promise<ConductorSceneDeployment> {
  try {
    const bytes = await localRegularFile(input.path, 4 * 1024 * 1024);
    check(bytesHash(bytes) === digest(input.expectedSha256));
    const root = record(json(bytes), ["schemaVersion", "worldId", "periods"]);
    check(root["schemaVersion"] === "conductor-scene-deployment/v1" && text(root["worldId"]) === input.worldId);
    const periods: ConductorScenePeriod[] = [];
    const intervalIds = new Set<string>();
    const intervals: { from: number; until: number }[] = [];
    for (const item of list(root["periods"], 64)) {
      const row = record(item, ["periodId", "validFromMs", "validUntilMs", "artReleaseId", "artManifestHash", "regions"]);
      const periodId = text(row["periodId"]), validFromMs = natural(row["validFromMs"]), validUntilMs = natural(row["validUntilMs"]);
      check(validFromMs < validUntilMs && !intervalIds.has(periodId) && !intervals.some((old) => validFromMs < old.until && old.from < validUntilMs));
      intervalIds.add(periodId); intervals.push({ from: validFromMs, until: validUntilMs });
      const artReleaseId = text(row["artReleaseId"]), artManifestHash = digest(row["artManifestHash"]);
      const regionIds = new Set<string>();
      for (const inputRegion of list(row["regions"], 256)) {
        const region = record(inputRegion, ["regionId", "infraReleaseId", "infraReleaseHash", "sceneReleasePath", "sceneFileSha256", "sceneReleaseHash"]);
        const regionId = text(region["regionId"]), infraReleaseId = text(region["infraReleaseId"]), infraReleaseHash = digest(region["infraReleaseHash"]);
        check(!regionIds.has(regionId)); regionIds.add(regionId);
        const sceneBytes = await localRegularFile(region["sceneReleasePath"], 64 * 1024 * 1024);
        check(bytesHash(sceneBytes) === digest(region["sceneFileSha256"]));
        const sceneRelease = parseConductorSceneRelease(json(sceneBytes)), sceneReleaseHash = digest(region["sceneReleaseHash"]);
        check(sceneRelease.infraReleaseId === infraReleaseId && sceneRelease.infraReleaseHash === infraReleaseHash
          && (sceneRelease.coverage !== "test-fixture" || input.allowTestFixtures === true)
          && input.runtime.releaseHash(sceneRelease) === sceneReleaseHash
          && sceneRelease.calendar.offsets[0]!.fromMs <= validFromMs && sceneRelease.calendar.offsets.at(-1)!.untilMs >= validUntilMs);
        periods.push({ periodId, validFromMs, validUntilMs, regionId, infraReleaseId, infraReleaseHash,
          artReleaseId, artManifestHash, sceneReleaseHash, sceneRelease });
      }
    }
    return new VerifiedSceneDeployment(input.worldId, periods);
  } catch { throw new Error(FAILURE); }
}
