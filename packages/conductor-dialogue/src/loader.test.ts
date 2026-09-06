import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dialogueSha256, loadDialogueReleaseForWorld, type DialogueReleaseValidator, type LoadDialogueReleaseInput } from "./index.js";

const releaseBytes = readFileSync(new URL("../../../assets/conductor-dialogue/v1/release.json", import.meta.url));
const sourceBytes = readFileSync(new URL("../../../assets/conductor-dialogue/v1/scenes.txt", import.meta.url));
const release = JSON.parse(releaseBytes.toString("utf8")) as { releaseId: string; families: { trees: { treeId: string }[] }[] };
const pairs = generateKeyPairSync("ed25519");
const publicKey = pairs.publicKey.export({ type: "spki", format: "pem" }).toString();
const binary = process.env["ZUGFOLGE_DIALOGUE_TEST_BINARY"];
const addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"];
function nativeValidator(): DialogueReleaseValidator {
  if (binary) return { validateConductorDialogueRelease(input) {
    const result = spawnSync(binary, ["validate"], { input, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    if (result.status !== 0) throw new Error("Echter Dialogkern lehnt den Korpus ab."); return result.stdout;
  } };
  if (addonPath) return createRequire(import.meta.url)(addonPath) as DialogueReleaseValidator;
  throw new Error("Für den positiven Nachweis ist der echte Rust-Kern erforderlich.");
}
function fixture(validator: DialogueReleaseValidator): LoadDialogueReleaseInput {
  const releaseSha256 = dialogueSha256(releaseBytes);
  const review = { schemaVersion: "conductor-dialogue-editorial-review/v1", releaseId: release.releaseId,
    releaseSha256, sourceSha256: dialogueSha256(sourceBytes), reviewerKind: "independent_agent", reviewerId: "explicit-test-review",
    status: "accepted", sampledTreeIds: release.families.flatMap((family) => [family.trees[0]!.treeId, family.trees.at(-1)!.treeId]),
    checks: { coherentBranches: true, shortPlayableGerman: true, noBrandsOrRealPersons: true,
      noProtectedTraitFareInference: true, claimsAreNotEvidence: true, policeRequiresObservedGrounds: true },
    notes: ["Explizite Testidentität; keine produktive Freigabe oder Schlüsselanlage."] };
  const editorialReviewBytes = Buffer.from(JSON.stringify(review));
  return { worldId: "world-a", expectedPin: { schemaVersion: "conductor-dialogue-world-pin/v1", worldId: "world-a",
    releaseId: release.releaseId, releaseSha256, editorialReviewSha256: dialogueSha256(editorialReviewBytes), signingKeyId: "test-key" },
    releaseBytes: Uint8Array.from(releaseBytes), editorialReviewBytes, signature: { algorithm: "ed25519", keyId: "test-key", signedHash: releaseSha256,
      valueBase64: sign(null, Buffer.from(releaseSha256, "utf8"), pairs.privateKey).toString("base64") },
    trustedKeys: new Map([["test-key", publicKey]]), validator };
}
const forbiddenCore: DialogueReleaseValidator = { validateConductorDialogueRelease() { throw new Error("PRIVATE_MARKER_DARF_NICHT_ERREICHT_WERDEN"); } };

describe("Dialogrelease vor der Kerngrenze", () => {
  it("verwirft fremde Welt, Schlüssel und manipulierte Bytes ohne Kernaufruf", () => {
    const input = fixture(forbiddenCore);
    expect(() => loadDialogueReleaseForWorld({ ...input, worldId: "world-b" })).toThrow("dialogue_world_mismatch");
    expect(() => loadDialogueReleaseForWorld({ ...input, trustedKeys: new Map() })).toThrow("dialogue_signing_key_untrusted");
    expect(() => loadDialogueReleaseForWorld({ ...input, releaseBytes: Buffer.from("PRIVATE_FREMTEXT") })).toThrow("dialogue_pin_mismatch");
    const signature = { ...(input.signature as object), keyId: "foreign-key" };
    expect(() => loadDialogueReleaseForWorld({ ...input, signature, trustedKeys: new Map([["foreign-key", publicKey]]) })).toThrow("dialogue_signing_key_untrusted");
  });
  it("verwirft falsche Signaturkonvention und hält Kernfehler privat", () => {
    const input = fixture(forbiddenCore);
    const signature = input.signature as { signedHash: string };
    expect(() => loadDialogueReleaseForWorld({ ...input, signature: { ...input.signature as object,
      valueBase64: sign(null, Buffer.from(signature.signedHash, "hex"), pairs.privateKey).toString("base64") } })).toThrow("dialogue_signature_invalid");
    try { loadDialogueReleaseForWorld(input); throw new Error("Die Ablehnung fehlt."); }
    catch (error) { expect(String(error)).toContain("dialogue_core_rejected"); expect(String(error)).not.toContain("PRIVATE_MARKER"); }
  });
});

describe.runIf(Boolean(binary || addonPath))("Signierter tatsächlicher Autorenkorpus mit echtem Rust-Validator", () => {
  it("lädt nur die exakten weltgepinnten, redaktionell gebundenen Bytes", () => {
    const input = fixture(nativeValidator());
    const loaded = loadDialogueReleaseForWorld(input);
    expect(loaded.report("world-a")).toMatchObject({ releaseId: release.releaseId, families: 12, trees: 156, utterances: 624 });
    expect(loaded.releaseJson("world-a")).toBe(releaseBytes.toString("utf8"));
    expect(() => loaded.releaseJson("world-b")).toThrow("dialogue_world_mismatch");
    expect(Reflect.set(loaded, "worldId", "world-b")).toBe(false);
    expect(Reflect.set(loaded, "check", () => {})).toBe(false);
    const report = loaded.report("world-a"); report.releaseId = "changed";
    expect(loaded.report("world-a").releaseId).toBe(release.releaseId);
    input.releaseBytes.fill(0);
    expect(loaded.releaseJson("world-a").startsWith("{\"schemaVersion\"")).toBe(true);
  });
  it("verwirft selbst signierte ungültige Korpora und veränderte Stichproben", () => {
    const input = fixture(nativeValidator());
    const review = JSON.parse(Buffer.from(input.editorialReviewBytes).toString("utf8")) as { sampledTreeIds: string[] };
    review.sampledTreeIds[0] = "unbekannter-baum";
    const editorialReviewBytes = Buffer.from(JSON.stringify(review));
    expect(() => loadDialogueReleaseForWorld({ ...input, editorialReviewBytes,
      expectedPin: { ...input.expectedPin as object, editorialReviewSha256: dialogueSha256(editorialReviewBytes) } })).toThrow("dialogue_review_invalid");
    const invalid = Buffer.from("{\"schemaVersion\":\"conductor-dialogue-release/v1\",\"private\":\"PRIVATE_MARKER\"}");
    const hash = dialogueSha256(invalid);
    expect(() => loadDialogueReleaseForWorld({ ...input, releaseBytes: invalid,
      expectedPin: { ...input.expectedPin as object, releaseSha256: hash },
      signature: { algorithm: "ed25519", keyId: "test-key", signedHash: hash,
        valueBase64: sign(null, Buffer.from(hash, "utf8"), pairs.privateKey).toString("base64") } })).toThrow("dialogue_core_rejected");
  });
});
