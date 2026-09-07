import { createHash } from "node:crypto";
import { readLocalDeploymentFile } from "./conductor-deployment-files.js";
import { controlJson, controlRecord, controlText, type ControlRecord, type FareControlRuntime } from "./conductor-control-runtime.js";

export interface ConductorControlPeriod {
  readonly periodId: string; readonly validFromMs: number; readonly validUntilMs: number;
  readonly economyReleaseHash: string; readonly inspectionPolicy: ControlRecord;
  readonly policeResponseModel: ControlRecord; readonly journeys: readonly ControlRecord[];
}
export interface ConductorControlDeployment {
  resolve(worldId: string, periodId: string, nowMs: number): ConductorControlPeriod | undefined;
}
export class ConductorControlConfigurationError extends Error {
  constructor() { super("conductor_control_configuration_invalid"); this.name = "ConductorControlConfigurationError"; }
}
function fail(): never { throw new ConductorControlConfigurationError(); }
function exact(row: ControlRecord, fields: readonly string[]): void {
  if (Object.keys(row).length !== fields.length || fields.some((key) => !Object.hasOwn(row, key))) fail();
}
function hash(value: unknown): string { const valueText = controlText(value); if (!/^[a-f0-9]{64}$/u.test(valueText)) fail(); return valueText; }
class Deployment implements ConductorControlDeployment {
  readonly #worldId: string; readonly #periods: ReadonlyMap<string, string>;
  constructor(worldId: string, periods: ReadonlyMap<string, string>) { this.#worldId = worldId; this.#periods = new Map(periods); Object.freeze(this); }
  resolve(worldId: string, periodId: string, nowMs: number): ConductorControlPeriod | undefined {
    if (worldId !== this.#worldId || !Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
    const json = this.#periods.get(periodId); if (json === undefined) return undefined;
    const value = JSON.parse(json) as ConductorControlPeriod;
    return nowMs >= value.validFromMs && nowMs < value.validUntilMs ? value : undefined;
  }
}
/** Unabhängiger Deploymentpin, weder HTTP-Eingabe noch Vertrauen aus den Nutzdaten. */
export function parseConductorControlDeployment(input: {
  readonly bytes: Uint8Array; readonly expectedSha256: string; readonly worldId: string; readonly runtime: FareControlRuntime;
}): ConductorControlDeployment {
  try {
    const bytes = Buffer.from(input.bytes);
    if (bytes.length > 16 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== hash(input.expectedSha256)) fail();
    const body = controlRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); controlJson(body);
    exact(body, ["schemaVersion", "worldId", "periods"]);
    if (body["schemaVersion"] !== "conductor-control-deployment/v1" || body["worldId"] !== input.worldId || !Array.isArray(body["periods"]) || body["periods"].length > 256) fail();
    const periods = new Map<string, string>();
    for (const source of body["periods"]) {
      const row = controlRecord(source); exact(row, ["periodId", "validFromMs", "validUntilMs", "economyReleaseHash", "inspectionPolicy", "policeResponseModel", "journeys"]);
      const periodId = controlText(row["periodId"]); const from = row["validFromMs"], until = row["validUntilMs"];
      if (typeof from !== "number" || typeof until !== "number" || from < 0 || until <= from || periods.has(periodId)) fail();
      hash(row["economyReleaseHash"]);
      const policy = controlRecord(row["inspectionPolicy"]), model = controlRecord(row["policeResponseModel"]);
      if (policy["worldId"] !== input.worldId || policy["periodId"] !== periodId || input.runtime.policyHash(policy) !== hash(policy["contentHash"])
        || model["worldId"] !== input.worldId || input.runtime.modelHash(model) !== hash(model["contentHash"])) fail();
      if (!Array.isArray(row["journeys"]) || row["journeys"].length > 100_000) fail(); const ids = new Set<string>(), paths = new Set<string>();
      for (const sourceJourney of row["journeys"]) {
        const journey = controlRecord(sourceJourney); const id = controlText(journey["evidenceId"]);
        const path = controlJson([journey["trainRunId"], journey["boardingStopId"], journey["alightingStopId"]]);
        if (journey["worldId"] !== input.worldId || journey["periodId"] !== periodId || ids.has(id) || paths.has(path)
          || input.runtime.journeyHash(journey) !== hash(journey["contentHash"])) fail();
        ids.add(id); paths.add(path);
      }
      periods.set(periodId, controlJson(row));
    }
    if (periods.size === 0) fail(); return new Deployment(input.worldId, periods);
  } catch { return fail(); }
}
export async function loadConductorControlDeployment(input: {
  readonly path: string; readonly expectedSha256: string; readonly worldId: string; readonly runtime: FareControlRuntime;
}): Promise<ConductorControlDeployment> {
  try { return parseConductorControlDeployment({ ...input, bytes: await readLocalDeploymentFile(input.path, 16 * 1024 * 1024) }); }
  catch { return fail(); }
}
