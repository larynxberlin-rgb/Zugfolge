import { loadDialogueReleaseForWorld, parseDialogueSignature, parseDialogueWorldPin, type DialogueReleaseValidator } from "@zugfolge/conductor-dialogue";
import type { ConductorSessionPolicyV1, ConductorSessionRuntime } from "@zugfolge/runtime-native";
import { createHash, createPublicKey } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { readLocalDeploymentFile } from "./conductor-deployment-files.js";
import type { ConductorSessionReleaseCatalog } from "./conductor-session-service.js";

const HASH = /^[a-f0-9]{64}$/u;
const FAILURE = "Das gepinnte Sitzungsdeployment oder sein unabhängiges Dialogvertrauen ist ungültig.";
function check(value: unknown): asserts value { if (!value) throw new Error(FAILURE); }
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value));
  const row = value as Record<string, unknown>;
  if (keys) check(Object.keys(row).length === keys.length && keys.every((key) => Object.hasOwn(row, key)));
  return row;
}
function text(value: unknown): string {
  check(typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 500 && !/\p{Cc}/u.test(value)); return value;
}
function hash(value: unknown): string { check(typeof value === "string" && HASH.test(value)); return value; }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  check(Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum); return Number(value);
}
function list(value: unknown, maximum: number): unknown[] { check(Array.isArray(value) && value.length > 0 && value.length <= maximum); return value; }
function json(bytes: Buffer): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
function directory(value: unknown): string {
  const path = text(value); check(isAbsolute(path) && !path.startsWith("\\\\") && !path.startsWith("//") && !path.split(/[\\/]/u).includes("..")); return path;
}

/** These transport bounds mirror validate_policy; the native policyHash method alone has no range checks. */
function policy(value: unknown, worldId: string, periodId: string, runtime: Pick<ConductorSessionRuntime, "policyHash">): ConductorSessionPolicyV1 {
  const row = object(value, ["schemaVersion", "policyId", "revision", "worldId", "periodId", "contentHash", "leaseDurationMs", "commandWindowMs",
    "maxCommandsPerWindow", "minCommandIntervalMs", "walkSpeedMmPerSecond", "maxMovementBurstMm", "inspectionRangeMm", "maxReceipts"]);
  check(row["schemaVersion"] === "conductor-session-policy/v1" && text(row["worldId"]) === worldId && text(row["periodId"]) === periodId);
  text(row["policyId"]); integer(row["revision"], 1); hash(row["contentHash"]);
  integer(row["leaseDurationMs"], 5000, 600000); integer(row["commandWindowMs"], 100, 60000);
  integer(row["maxCommandsPerWindow"], 1, 1000); integer(row["minCommandIntervalMs"], 0, 1000);
  integer(row["walkSpeedMmPerSecond"], 100, 3000); integer(row["maxMovementBurstMm"], 1, 10000);
  integer(row["inspectionRangeMm"], 500, 2500); integer(row["maxReceipts"], 128, 262144);
  const result = structuredClone(row) as unknown as ConductorSessionPolicyV1;
  check(runtime.policyHash(result) === result.contentHash); return result;
}
type Period = { readonly periodId: string; readonly validFromMs: number; readonly validUntilMs: number;
  readonly policy: ConductorSessionPolicyV1; readonly currentDialogueReleaseHash: string };
class VerifiedSessionDeployment implements ConductorSessionReleaseCatalog {
  readonly #worldId: string;
  readonly #periods: readonly Period[];
  readonly #releases: readonly Readonly<Record<string, unknown>>[];
  constructor(worldId: string, periods: Period[], releases: Readonly<Record<string, unknown>>[]) {
    this.#worldId = worldId; this.#periods = periods; this.#releases = releases; Object.freeze(this);
  }
  resolve(worldId: string, periodId: string, nowMs: number) {
    if (worldId !== this.#worldId || !Number.isSafeInteger(nowMs) || nowMs < 0) return undefined;
    const match = this.#periods.find((row) => row.periodId === periodId && row.validFromMs <= nowMs && nowMs < row.validUntilMs);
    return match ? { policy: structuredClone(match.policy), currentDialogueReleaseHash: match.currentDialogueReleaseHash,
      dialogueReleases: structuredClone(this.#releases) } : undefined;
  }
}

/** Server-owned configuration; preserves every explicitly pinned dialogue version for ongoing cases. */
export async function loadConductorSessionDeployment(input: {
  readonly path: string; readonly expectedSha256: string; readonly trustedKeysPath: string; readonly worldId: string;
  readonly runtime: Pick<ConductorSessionRuntime, "policyHash">; readonly validator: DialogueReleaseValidator;
}): Promise<ConductorSessionReleaseCatalog> {
  try {
    const bytes = await readLocalDeploymentFile(input.path, 8 * 1024 * 1024);
    check(createHash("sha256").update(bytes).digest("hex") === hash(input.expectedSha256));
    const root = object(json(bytes), ["schemaVersion", "worldId", "periods", "dialogueReleases"]);
    check(root["schemaVersion"] === "conductor-session-deployment/v1" && text(root["worldId"]) === input.worldId);
    const keys = object(json(await readLocalDeploymentFile(input.trustedKeysPath, 1024 * 1024)));
    check(Object.keys(keys).length > 0 && Object.keys(keys).length <= 64);
    const trustedKeys = new Map<string, string>();
    for (const [keyId, pem] of Object.entries(keys)) {
      text(keyId); check(typeof pem === "string" && pem.length <= 16384 && /^-----BEGIN PUBLIC KEY-----\r?\n/u.test(pem));
      check(createPublicKey(pem).asymmetricKeyType === "ed25519"); trustedKeys.set(keyId, pem);
    }
    const periods: Period[] = [];
    for (const value of list(root["periods"], 64)) {
      const row = object(value, ["periodId", "validFromMs", "validUntilMs", "policy", "currentDialogueReleaseHash"]);
      const periodId = text(row["periodId"]), validFromMs = integer(row["validFromMs"]), validUntilMs = integer(row["validUntilMs"]);
      check(validFromMs < validUntilMs && !periods.some((old) => old.periodId === periodId || validFromMs < old.validUntilMs && old.validFromMs < validUntilMs));
      const currentDialogueReleaseHash = hash(row["currentDialogueReleaseHash"]);
      periods.push({ periodId, validFromMs, validUntilMs, currentDialogueReleaseHash, policy: policy(row["policy"], input.worldId, periodId, input.runtime) });
    }
    const releases: Readonly<Record<string, unknown>>[] = [], releaseHashes = new Set<string>(), releaseIds = new Set<string>();
    for (const value of list(root["dialogueReleases"], 64)) {
      const row = object(value, ["directory", "pin", "signature"]), path = directory(row["directory"]);
      const pin = parseDialogueWorldPin(row["pin"]), signature = parseDialogueSignature(row["signature"]);
      check(pin.worldId === input.worldId && !releaseHashes.has(pin.releaseSha256) && !releaseIds.has(pin.releaseId));
      const [releaseBytes, editorialReviewBytes] = await Promise.all([
        readLocalDeploymentFile(join(path, "release.json"), 8 * 1024 * 1024),
        readLocalDeploymentFile(join(path, "editorial-review.json"), 256 * 1024),
      ]);
      const loaded = loadDialogueReleaseForWorld({ worldId: input.worldId, expectedPin: pin, signature, trustedKeys,
        validator: input.validator, releaseBytes, editorialReviewBytes });
      const report = loaded.report(input.worldId);
      releaseHashes.add(report.releaseHash); releaseIds.add(report.releaseId);
      releases.push(object(JSON.parse(loaded.releaseJson(input.worldId))));
    }
    check(periods.every((period) => releaseHashes.has(period.currentDialogueReleaseHash)));
    return new VerifiedSessionDeployment(input.worldId, periods, releases);
  } catch { throw new Error(FAILURE); }
}
