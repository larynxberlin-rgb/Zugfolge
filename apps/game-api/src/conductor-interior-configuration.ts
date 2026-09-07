import { loadArtAtlasFromDirectory, parseArtAtlasSignature, parseArtAtlasWorldPin, VEHICLE_VARIANTS, type ArtAtlasWorldPinV1, type LoadedArtAtlas } from "@zugfolge/conductor-art";
import type { InteriorGeometryPolicyV1 } from "@zugfolge/runtime-native";
import { createHash, createPublicKey } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const FAILURE = "Das gepinnte Innenraumdeployment oder sein unabhängiges Grafikvertrauen ist ungültig.";
function check(value: unknown): asserts value { if (!value) throw new Error(FAILURE); }
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  if (keys !== undefined) check(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key)));
  return row;
}
function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number { check(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum); return Number(value); }
function id(value: unknown): string { check(typeof value === "string" && ID.test(value)); return value; }
function list(value: unknown, maximum: number): unknown[] { check(Array.isArray(value) && value.length > 0 && value.length <= maximum); return value; }
function localPath(value: unknown): string { check(typeof value === "string" && isAbsolute(value) && !value.startsWith("\\\\") && !value.startsWith("//") && !value.includes("\0")); return value; }

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const file = await open(localPath(path), "r");
  try {
    const before = await file.stat();
    check(before.isFile() && before.size > 0 && before.size <= limit);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    check(length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs);
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

/** Nur der Transport wird hier geprüft; fachliche Maße und Hashbildung bleiben im Rust-Kern. */
function geometry(value: unknown): InteriorGeometryPolicyV1 {
  const policy = record(value, ["schemaVersion", "policyId", "vehicleTypes"]);
  check(policy["schemaVersion"] === "conductor-interior-geometry-policy/v1"); id(policy["policyId"]);
  for (const input of list(policy["vehicleTypes"], 4096)) {
    const vehicle = record(input, ["vehicleTypeId", "configurationHash", "artFamily", "bodies"]);
    check(integer(vehicle["vehicleTypeId"], 0xffff_ffff) > 0);
    check(vehicle["configurationHash"] === null || typeof vehicle["configurationHash"] === "string" && HASH.test(vehicle["configurationHash"]));
    check(VEHICLE_VARIANTS.some((variant) => variant.id === vehicle["artFamily"]));
    for (const inputBody of list(vehicle["bodies"], 128)) {
      const body = record(inputBody, ["bodyId", "lengthMm", "widthMm", "deckIds", "entranceDeckId", "doorPositionsMm", "stairs", "gapAfterMm", "frontGangway", "rearGangway"]);
      id(body["bodyId"]); integer(body["lengthMm"], 0xffff_ffff); integer(body["widthMm"], 0xffff_ffff); integer(body["gapAfterMm"], 0xffff_ffff);
      const decks = list(body["deckIds"], 3);
      check(decks.every((deck) => ["main", "lower", "upper"].includes(String(deck))) && decks.includes(body["entranceDeckId"]));
      check(typeof body["frontGangway"] === "boolean" && typeof body["rearGangway"] === "boolean");
      check(Array.isArray(body["doorPositionsMm"]) && body["doorPositionsMm"].length <= 256);
      for (const at of body["doorPositionsMm"]) integer(at, 0xffff_ffff);
      check(Array.isArray(body["stairs"]) && body["stairs"].length <= 128);
      for (const inputStair of body["stairs"]) {
        const stair = record(inputStair, ["stairId", "fromDeckId", "toDeckId", "atMm"]);
        id(stair["stairId"]); integer(stair["atMm"], 0xffff_ffff);
        check(decks.includes(stair["fromDeckId"]) && decks.includes(stair["toDeckId"]));
      }
    }
  }
  return structuredClone(value) as InteriorGeometryPolicyV1;
}

export interface ConductorInteriorPeriod {
  readonly periodId: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
  readonly geometryPolicy: InteriorGeometryPolicyV1;
  readonly geometryPolicyHash: string;
  readonly artPin: ArtAtlasWorldPinV1;
  readonly atlas: LoadedArtAtlas;
}
export interface ConductorInteriorDeployment {
  period(worldId: string, periodId: string, nowMs: number): ConductorInteriorPeriod | undefined;
}

class VerifiedInteriorDeployment implements ConductorInteriorDeployment {
  readonly #worldId: string;
  readonly #periods: readonly ConductorInteriorPeriod[];
  constructor(worldId: string, periods: ConductorInteriorPeriod[]) { this.#worldId = worldId; this.#periods = periods; Object.freeze(this); }
  period(worldId: string, periodId: string, nowMs: number): ConductorInteriorPeriod | undefined {
    if (worldId !== this.#worldId || !Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
    const period = this.#periods.find((row) => row.periodId === periodId && row.validFromMs <= nowMs && nowMs < row.validUntilMs);
    return period === undefined ? undefined : { ...period, geometryPolicy: structuredClone(period.geometryPolicy), artPin: structuredClone(period.artPin) };
  }
}

/** Pfad, Bytepin und Schlüsselring kommen ausschließlich aus der Serverkonfiguration. */
export async function loadConductorInteriorDeployment(input: {
  path: string; expectedSha256: string; trustedKeysPath: string; worldId: string;
}): Promise<ConductorInteriorDeployment> {
  try {
    const bytes = await readBounded(input.path, 16 * 1024 * 1024);
    check(HASH.test(input.expectedSha256) && createHash("sha256").update(bytes).digest("hex") === input.expectedSha256);
    const root = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), ["schemaVersion", "worldId", "periods"]);
    check(root["schemaVersion"] === "conductor-interior-deployment/v1" && id(root["worldId"]) === input.worldId);
    const keys = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(input.trustedKeysPath, 1024 * 1024))));
    check(Object.keys(keys).length > 0 && Object.keys(keys).length <= 64);
    const trustedKeys = new Map<string, string>();
    for (const [keyId, pem] of Object.entries(keys)) {
      id(keyId); check(typeof pem === "string" && pem.length <= 16_384 && /^-----BEGIN PUBLIC KEY-----\r?\n/.test(pem));
      check(createPublicKey(pem).asymmetricKeyType === "ed25519"); trustedKeys.set(keyId, pem);
    }
    const periods: ConductorInteriorPeriod[] = [];
    for (const inputPeriod of list(root["periods"], 64)) {
      const row = record(inputPeriod, ["periodId", "validFromMs", "validUntilMs", "geometryPolicy", "geometryPolicyHash", "artPin", "artSignature", "artDirectory"]);
      const periodId = id(row["periodId"]), validFromMs = integer(row["validFromMs"]), validUntilMs = integer(row["validUntilMs"]);
      check(validFromMs < validUntilMs && !periods.some((other) => other.periodId === periodId || validFromMs < other.validUntilMs && other.validFromMs < validUntilMs));
      const geometryPolicy = geometry(row["geometryPolicy"]), geometryPolicyHash = row["geometryPolicyHash"];
      check(typeof geometryPolicyHash === "string" && HASH.test(geometryPolicyHash));
      const artPin = parseArtAtlasWorldPin(row["artPin"]), signature = parseArtAtlasSignature(row["artSignature"]);
      check(artPin.worldId === input.worldId);
      const atlas = await loadArtAtlasFromDirectory({ directory: localPath(row["artDirectory"]), worldId: input.worldId, expectedPin: artPin, signature, trustedKeys });
      periods.push({ periodId, validFromMs, validUntilMs, geometryPolicy, geometryPolicyHash, artPin, atlas });
    }
    return new VerifiedInteriorDeployment(input.worldId, periods);
  } catch { throw new Error(FAILURE); }
}

/** Nur vollständig restaurierte und gleich weit bestätigte Regionalzustände ergeben eine Weltzeit. */
export function committedInteriorTime(worldId: string, expected: readonly { worldId: string; regionId: string }[], ready: readonly { worldId: string; regionId: string; nowMs: number }[]): number | undefined {
  const regions = expected.filter((row) => row.worldId === worldId);
  if (regions.length === 0) return undefined;
  const times = regions.map((region) => ready.find((row) => row.worldId === worldId && row.regionId === region.regionId)?.nowMs);
  const first = times[0];
  return first !== undefined && Number.isSafeInteger(first) && first >= 0 && times.every((at) => at === first) ? first : undefined;
}
