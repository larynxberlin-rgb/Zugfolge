import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConductorSessionPolicyV1 } from "@zugfolge/runtime-native";
import type { DialogueReleaseValidator } from "@zugfolge/conductor-dialogue";
import { loadConductorSessionDeployment } from "./conductor-session-configuration.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const key = generateKeyPairSync("ed25519"), pem = key.publicKey.export({ type: "spki", format: "pem" }).toString();
const worldId = "world:explicit-session-deployment-test";
const addon = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"];
const nativeAvailable = Boolean(addon || process.env["ZUGFOLGE_SESSION_TEST_BINARY"] && process.env["ZUGFOLGE_DIALOGUE_TEST_BINARY"]);
function native() {
  function command(binary: string, kind: string, input: string): string {
    const result = spawnSync(binary, [kind], { input, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error("Native test rejection"); return result.stdout.trim();
  }
  const loaded = addon ? createRequire(import.meta.url)(addon) as DialogueReleaseValidator & { hashConductorSessionPolicy(input: string): string } : null;
  return {
    runtime: { policyHash: (policy: ConductorSessionPolicyV1) => loaded ? loaded.hashConductorSessionPolicy(JSON.stringify(policy))
      : command(process.env["ZUGFOLGE_SESSION_TEST_BINARY"]!, "policy-hash", JSON.stringify(policy)) },
    validator: loaded ?? { validateConductorDialogueRelease: (input: string) => command(process.env["ZUGFOLGE_DIALOGUE_TEST_BINARY"]!, "validate", input) },
  };
}
const forbiddenValidator = { validateConductorDialogueRelease() { throw new Error("PRIVATE_VALIDATOR_MUST_NOT_RUN"); } };

async function prepare(useNative = false) {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-session-deployment-")); roots.push(directory);
  const releaseBytes = await readFile(new URL("../../../assets/conductor-dialogue/v1/release.json", import.meta.url));
  const reviewBytes = await readFile(new URL("../../../assets/conductor-dialogue/v1/editorial-review.json", import.meta.url));
  const release = JSON.parse(releaseBytes.toString("utf8")) as Record<string, unknown>;
  const review = JSON.parse(reviewBytes.toString("utf8")) as Record<string, unknown>;
  async function version(name: string, bytes: Buffer, editorial: Buffer) {
    const target = join(directory, name); await mkdir(target);
    await writeFile(join(target, "release.json"), bytes); await writeFile(join(target, "editorial-review.json"), editorial);
    const releaseHash = sha(bytes), releaseId = (JSON.parse(bytes.toString("utf8")) as { releaseId: string }).releaseId;
    return { directory: target, pin: { schemaVersion: "conductor-dialogue-world-pin/v1", worldId, releaseId,
      releaseSha256: releaseHash, editorialReviewSha256: sha(editorial), signingKeyId: "explicit-test-key" },
      signature: { algorithm: "ed25519", keyId: "explicit-test-key", signedHash: releaseHash,
        valueBase64: sign(null, Buffer.from(releaseHash, "utf8"), key.privateKey).toString("base64") } };
  }
  const first = await version("original", releaseBytes, reviewBytes);
  // Explicit second test version: identical reviewed corpus, different test release ID. No production approval claim.
  const secondBytes = Buffer.from(JSON.stringify({ ...release, releaseId: "dialogue-explicit-test-v2" }));
  const secondReview = Buffer.from(JSON.stringify({ ...review, releaseId: "dialogue-explicit-test-v2", releaseSha256: sha(secondBytes),
    reviewerId: "explicit-test-version-copy", notes: ["Synthetic deployment-version test; no additional production review or signature."] }));
  const second = await version("second-test-version", secondBytes, secondReview);
  const runtime = useNative ? native().runtime : { policyHash: (policy: ConductorSessionPolicyV1) => policy.contentHash };
  const validator = useNative ? native().validator : forbiddenValidator;
  function policy(periodId: string): ConductorSessionPolicyV1 {
    const result = { schemaVersion: "conductor-session-policy/v1" as const, policyId: "explicit-test-policy", revision: 1,
      worldId, periodId, contentHash: "a".repeat(64), leaseDurationMs: 30000, commandWindowMs: 1000, maxCommandsPerWindow: 5,
      minCommandIntervalMs: 100, walkSpeedMmPerSecond: 1200, maxMovementBurstMm: 2000, inspectionRangeMm: 1500, maxReceipts: 512 };
    result.contentHash = runtime.policyHash(result); return result;
  }
  const deployment = { schemaVersion: "conductor-session-deployment/v1", worldId,
    periods: [{ periodId: "first", validFromMs: 0, validUntilMs: 10000, policy: policy("first"), currentDialogueReleaseHash: first.pin.releaseSha256 },
      { periodId: "second", validFromMs: 10000, validUntilMs: 20000, policy: policy("second"), currentDialogueReleaseHash: second.pin.releaseSha256 }],
    dialogueReleases: [first, second] };
  const path = join(directory, "deployment.json"), trustedKeysPath = join(directory, "trusted-keys.json");
  await writeFile(trustedKeysPath, JSON.stringify({ "explicit-test-key": pem }));
  async function save() { const bytes = JSON.stringify(deployment); await writeFile(path, bytes); return sha(bytes); }
  return { directory, deployment, first, second, save,
    input: { path, expectedSha256: await save(), trustedKeysPath, worldId, runtime, validator } };
}

describe("conductor session deployment", () => {
  it("checks every native policy bound before any native hashing or dialogue validation", async () => {
    const test = await prepare();
    const base = test.deployment.periods[0]!.policy;
    const bounds = { revision: [1, Number.MAX_SAFE_INTEGER], leaseDurationMs: [5000, 600000], commandWindowMs: [100, 60000],
      maxCommandsPerWindow: [1, 1000], minCommandIntervalMs: [0, 1000], walkSpeedMmPerSecond: [100, 3000],
      maxMovementBurstMm: [1, 10000], inspectionRangeMm: [500, 2500], maxReceipts: [128, 262144] };
    let hashCalls = 0, validationCalls = 0;
    for (const [field, limits] of Object.entries(bounds)) for (const bad of [limits[0]! - 1, limits[1]! + 1, 1.5]) {
      test.deployment.periods[0]!.policy = { ...base, [field]: bad };
      await expect(loadConductorSessionDeployment({ ...test.input, expectedSha256: await test.save(),
        runtime: { policyHash() { hashCalls++; throw new Error("PRIVATE_HASH_MUST_NOT_RUN"); } },
        validator: { validateConductorDialogueRelease() { validationCalls++; throw new Error("PRIVATE_VALIDATOR_MUST_NOT_RUN"); } },
      })).rejects.toThrow("Sitzungsdeployment");
    }
    expect(hashCalls).toBe(0); expect(validationCalls).toBe(0);
  });

  it("rejects foreign world, altered pins, schema additions, symlinks and untrusted signatures privately", async () => {
    const test = await prepare();
    for (const change of [{ worldId: "foreign-world" }, { expectedSha256: "f".repeat(64) }, { runtime: { policyHash: () => "e".repeat(64) } }])
      await expect(loadConductorSessionDeployment({ ...test.input, ...change })).rejects.toThrow("Sitzungsdeployment");
    Object.assign(test.deployment.periods[0]!.policy, { browserOverride: true });
    await expect(loadConductorSessionDeployment({ ...test.input, expectedSha256: await test.save() })).rejects.toThrow("Sitzungsdeployment");
    Reflect.deleteProperty(test.deployment.periods[0]!.policy, "browserOverride");
    const link = join(test.directory, "symlink-release");
    await symlink(test.first.directory, link, process.platform === "win32" ? "junction" : "dir");
    const original = test.first.directory; test.first.directory = link;
    await expect(loadConductorSessionDeployment({ ...test.input, expectedSha256: await test.save() })).rejects.toThrow("Sitzungsdeployment");
    test.first.directory = original;
    test.first.signature.keyId = "untrusted-key";
    try { await loadConductorSessionDeployment({ ...test.input, expectedSha256: await test.save() }); throw new Error("expected failure"); }
    catch (error) { expect(String(error)).toContain("Sitzungsdeployment"); expect(String(error)).not.toContain(test.directory); expect(String(error)).not.toContain("PRIVATE"); }
  });

  it.skipIf(!nativeAvailable)("loads the actual corpus through native validation, preserving old releases across the period change", async () => {
    const test = await prepare(true);
    const loaded = await loadConductorSessionDeployment(test.input);
    expect(loaded.resolve(worldId, "first", 9999)?.currentDialogueReleaseHash).toBe(test.first.pin.releaseSha256);
    const second = loaded.resolve(worldId, "second", 10000)!;
    expect(second.currentDialogueReleaseHash).toBe(test.second.pin.releaseSha256);
    expect(second.dialogueReleases.map((release) => release["releaseId"])).toEqual([test.first.pin.releaseId, test.second.pin.releaseId]);
    expect(loaded.resolve(worldId, "first", 10000)).toBeUndefined();
    expect(loaded.resolve("foreign-world", "second", 10000)).toBeUndefined();
    expect(loaded.resolve(worldId, "second", 20000)).toBeUndefined();
    expect(loaded.resolve(worldId, "second", 10000)).not.toBe(second);
    test.deployment.periods[1]!.currentDialogueReleaseHash = "d".repeat(64);
    await expect(loadConductorSessionDeployment({ ...test.input, expectedSha256: await test.save() })).rejects.toThrow("Sitzungsdeployment");
  });
});
