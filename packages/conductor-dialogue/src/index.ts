import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface DialogueReleaseReportV1 { releaseId: string; releaseHash: string; families: number; trees: number; utterances: number }
export interface DialogueWorldPinV1 {
  schemaVersion: "conductor-dialogue-world-pin/v1";
  worldId: string;
  releaseId: string;
  releaseSha256: string;
  editorialReviewSha256: string;
  signingKeyId: string;
}
export interface DialogueSignatureV1 { algorithm: "ed25519"; keyId: string; signedHash: string; valueBase64: string }
export interface DialogueReleaseValidator {
  /** Echter Rust-Korpusvalidator; erhält exakt die verifizierten UTF-8-Bytes. */
  validateConductorDialogueRelease(input: string): string;
}
export type DialogueReleaseErrorCode = "dialogue_input_invalid" | "dialogue_world_mismatch" | "dialogue_pin_mismatch"
  | "dialogue_signature_invalid" | "dialogue_signing_key_untrusted" | "dialogue_review_invalid"
  | "dialogue_core_rejected" | "dialogue_files_unavailable";
export class DialogueReleaseError extends Error {
  constructor(readonly code: DialogueReleaseErrorCode) { super(code); this.name = "DialogueReleaseError"; }
}
function requireValue(condition: unknown, code: DialogueReleaseErrorCode): asserts condition {
  if (!condition) throw new DialogueReleaseError(code);
}
const hashPattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[a-zA-Z0-9_:.\/-]{1,160}$/u;
function object(value: unknown, keys: readonly string[], code: DialogueReleaseErrorCode): Record<string, unknown> {
  requireValue(typeof value === "object" && value !== null && !Array.isArray(value), code);
  const result = value as Record<string, unknown>;
  requireValue(Object.keys(result).length === keys.length && keys.every((key) => Object.hasOwn(result, key)), code);
  return result;
}
function text(value: unknown, pattern: RegExp, code: DialogueReleaseErrorCode): string {
  requireValue(typeof value === "string" && pattern.test(value), code); return value;
}
function parseJson(bytes: Uint8Array, code: DialogueReleaseErrorCode): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new DialogueReleaseError(code); }
}
export function dialogueSha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function parseDialogueWorldPin(value: unknown): DialogueWorldPinV1 {
  const code = "dialogue_input_invalid";
  const row = object(value, ["schemaVersion", "worldId", "releaseId", "releaseSha256", "editorialReviewSha256", "signingKeyId"], code);
  requireValue(row.schemaVersion === "conductor-dialogue-world-pin/v1", code);
  return { schemaVersion: "conductor-dialogue-world-pin/v1", worldId: text(row.worldId, idPattern, code),
    releaseId: text(row.releaseId, idPattern, code), releaseSha256: text(row.releaseSha256, hashPattern, code),
    editorialReviewSha256: text(row.editorialReviewSha256, hashPattern, code), signingKeyId: text(row.signingKeyId, idPattern, code) };
}
export function parseDialogueSignature(value: unknown): DialogueSignatureV1 {
  const code = "dialogue_signature_invalid";
  const row = object(value, ["algorithm", "keyId", "signedHash", "valueBase64"], code);
  requireValue(row.algorithm === "ed25519", code);
  const valueBase64 = text(row.valueBase64, /^[A-Za-z0-9+/]{86}==$/u, code);
  const bytes = Buffer.from(valueBase64, "base64");
  requireValue(bytes.byteLength === 64 && bytes.toString("base64") === valueBase64, code);
  return { algorithm: "ed25519", keyId: text(row.keyId, idPattern, code), signedHash: text(row.signedHash, hashPattern, code), valueBase64 };
}
function review(bytes: Uint8Array, releaseBytes: Uint8Array, pin: DialogueWorldPinV1): void {
  const code = "dialogue_review_invalid";
  requireValue(dialogueSha256(bytes) === pin.editorialReviewSha256, code);
  const row = object(parseJson(bytes, code), ["schemaVersion", "releaseId", "releaseSha256", "sourceSha256", "reviewerKind", "reviewerId", "status", "sampledTreeIds", "checks", "notes"], code);
  requireValue(row.schemaVersion === "conductor-dialogue-editorial-review/v1" && row.status === "accepted"
    && row.releaseId === pin.releaseId && row.releaseSha256 === pin.releaseSha256
    && ["independent_agent", "human_editor"].includes(String(row.reviewerKind)), code);
  text(row.sourceSha256, hashPattern, code); text(row.reviewerId, idPattern, code);
  const checks = object(row.checks, ["coherentBranches", "shortPlayableGerman", "noBrandsOrRealPersons", "noProtectedTraitFareInference", "claimsAreNotEvidence", "policeRequiresObservedGrounds"], code);
  requireValue(Object.values(checks).every((value) => value === true), code);
  requireValue(Array.isArray(row.notes) && row.notes.every((note) => typeof note === "string" && note.length <= 1000), code);
  requireValue(Array.isArray(row.sampledTreeIds) && row.sampledTreeIds.length >= 24
    && row.sampledTreeIds.every((id) => typeof id === "string" && idPattern.test(id)), code);
  const ids = new Set(row.sampledTreeIds as string[]);
  requireValue(ids.size === row.sampledTreeIds.length, code);
  // Der Rust-Validator hat Struktur und Familien bereits geprüft. Hier wird
  // ausschließlich die externe redaktionelle Stichprobe an diesen Korpus gebunden.
  const release = parseJson(releaseBytes, code) as { families: { trees: { treeId: string }[] }[] };
  let found = 0;
  for (const family of release.families) {
    const covered = family.trees.filter((tree) => ids.has(tree.treeId)).length;
    requireValue(covered >= 2, code); found += covered;
  }
  requireValue(found === ids.size, code);
}

/** Private Releasebytes ausschließlich für serverseitige Sitzungskerne. */
export interface LoadedDialogueRelease {
  report(worldId: string): DialogueReleaseReportV1;
  releaseJson(worldId: string): string;
}
class VerifiedDialogueRelease implements LoadedDialogueRelease {
  readonly #worldId: string;
  readonly #json: string;
  readonly #report: DialogueReleaseReportV1;
  constructor(worldId: string, json: string, report: DialogueReleaseReportV1) {
    this.#worldId = worldId; this.#json = json; this.#report = structuredClone(report); Object.freeze(this);
  }
  #check(worldId: string): void { requireValue(worldId === this.#worldId, "dialogue_world_mismatch"); }
  report(worldId: string): DialogueReleaseReportV1 { this.#check(worldId); return structuredClone(this.#report); }
  releaseJson(worldId: string): string { this.#check(worldId); return this.#json; }
}
export interface LoadDialogueReleaseInput {
  worldId: string; expectedPin: unknown; releaseBytes: Uint8Array; editorialReviewBytes: Uint8Array;
  signature: unknown; trustedKeys: ReadonlyMap<string, string>; validator: DialogueReleaseValidator;
}
export function loadDialogueReleaseForWorld(input: LoadDialogueReleaseInput): LoadedDialogueRelease {
  const bytes = input.releaseBytes, reviewBytes = input.editorialReviewBytes;
  requireValue(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 8 * 1024 * 1024
    && reviewBytes instanceof Uint8Array && reviewBytes.byteLength > 0 && reviewBytes.byteLength <= 256 * 1024, "dialogue_input_invalid");
  const snapshot = Uint8Array.from(bytes), editorialSnapshot = Uint8Array.from(reviewBytes);
  const pin = parseDialogueWorldPin(input.expectedPin), signature = parseDialogueSignature(input.signature);
  requireValue(pin.worldId === input.worldId, "dialogue_world_mismatch");
  const hash = dialogueSha256(snapshot);
  requireValue(hash === pin.releaseSha256 && hash === signature.signedHash, "dialogue_pin_mismatch");
  requireValue(signature.keyId === pin.signingKeyId, "dialogue_signing_key_untrusted");
  const trustedKey = input.trustedKeys.get(signature.keyId);
  requireValue(trustedKey !== undefined, "dialogue_signing_key_untrusted");
  try {
    const key = createPublicKey(trustedKey);
    requireValue(key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(hash, "utf8"), key, Buffer.from(signature.valueBase64, "base64")), "dialogue_signature_invalid");
  } catch { throw new DialogueReleaseError("dialogue_signature_invalid"); }
  let json: string, report: DialogueReleaseReportV1;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
    const nativeReport = JSON.parse(input.validator.validateConductorDialogueRelease(json)) as unknown;
    const row = object(nativeReport, ["releaseId", "releaseHash", "families", "trees", "utterances"], "dialogue_core_rejected");
    requireValue(row.releaseHash === hash && row.releaseId === pin.releaseId
      && [row.families, row.trees, row.utterances].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0), "dialogue_core_rejected");
    report = row as unknown as DialogueReleaseReportV1;
  } catch { throw new DialogueReleaseError("dialogue_core_rejected"); }
  try { review(editorialSnapshot, snapshot, pin); } catch { throw new DialogueReleaseError("dialogue_review_invalid"); }
  return new VerifiedDialogueRelease(pin.worldId, json, report);
}
export async function loadDialogueReleaseFromDirectory(input: {
  directory: string; worldId: string; expectedPin: unknown; signature: unknown;
  trustedKeys: ReadonlyMap<string, string>; validator: DialogueReleaseValidator;
}): Promise<LoadedDialogueRelease> {
  let releaseBytes: Uint8Array, editorialReviewBytes: Uint8Array;
  try { [releaseBytes, editorialReviewBytes] = await Promise.all([
    readFile(join(input.directory, "release.json")), readFile(join(input.directory, "editorial-review.json")),
  ]); } catch { throw new DialogueReleaseError("dialogue_files_unavailable"); }
  return loadDialogueReleaseForWorld({ ...input, releaseBytes, editorialReviewBytes });
}
