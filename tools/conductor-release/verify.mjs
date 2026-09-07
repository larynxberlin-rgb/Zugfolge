/** Public-only verification of the operator-registered original M15 releases. */
import { createHash, createPublicKey } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { loadArtAtlasFromDirectory } from "../../packages/conductor-art/dist/index.js";
import { loadDialogueReleaseFromDirectory } from "../../packages/conductor-dialogue/dist/index.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORLD_ID = "0db56535-a466-44a8-a991-38a8a1f7566c";
const DIRECTORY = `ops/conductor/worlds/${WORLD_ID}`;
const FILES = {
  identity: "tools/region-import/specifications/alpha-world-germany-2026.3.identity.json",
  binding: `${DIRECTORY}/release-binding.json`,
  artPin: `${DIRECTORY}/art-world-pin.json`, artSignature: `${DIRECTORY}/art-signature.json`,
  dialoguePin: `${DIRECTORY}/dialogue-world-pin.json`, dialogueSignature: `${DIRECTORY}/dialogue-signature.json`,
  artTrust: "ops/keys/trusted-conductor-art-keys.json", dialogueTrust: "ops/keys/trusted-conductor-dialogue-keys.json",
  priorTrust: "ops/keys/trusted-delivery-keys.json",
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireValue = (value, code) => { if (!value) throw new Error(code); };
function parse(bytes) {
  requireValue(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 1024 * 1024, "conductor_public_input_invalid");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("conductor_public_json_invalid"); }
}
function fingerprint(pem) {
  requireValue(typeof pem === "string" && pem.length <= 16384 && /^-----BEGIN PUBLIC KEY-----\n/u.test(pem), "conductor_public_key_invalid");
  let key;
  try { key = createPublicKey(pem); } catch { throw new Error("conductor_public_key_invalid"); }
  requireValue(key.type === "public" && key.asymmetricKeyType === "ed25519"
    && key.export({ type: "spki", format: "pem" }) === pem, "conductor_public_key_invalid");
  return sha(key.export({ type: "spki", format: "der" }));
}
function trust(value) {
  requireValue(value && typeof value === "object" && !Array.isArray(value), "conductor_public_trust_invalid");
  const entries = Object.entries(value);
  requireValue(entries.length > 0 && entries.length <= 64, "conductor_public_trust_invalid");
  for (const [id, pem] of entries) {
    requireValue(/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(id), "conductor_public_trust_invalid"); fingerprint(pem);
  }
  return new Map(entries);
}

export async function readRegisteredConductorInputs() {
  return Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([id, path]) => {
    const fullPath = resolve(ROOT, path), stat = await lstat(fullPath);
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 1024 * 1024, "conductor_public_file_invalid");
    return [id, await readFile(fullPath)];
  })));
}

/** Only the public registered inputs are accepted; no private key is read here. */
export async function verifyRegisteredConductorReleases({ validator, inputs } = {}) {
  inputs ??= await readRegisteredConductorInputs();
  const data = Object.fromEntries(Object.keys(FILES).map((id) => [id, parse(inputs[id])]));
  const { identity, binding } = data;
  requireValue(identity.schemaVersion === "zugfolge-alpha-world-identity/v1" && identity.worldId === WORLD_ID
    && binding.schemaVersion === "conductor-release-binding/v1" && binding.worldId === identity.worldId
    && binding.worldIdentityFile === FILES.identity && binding.worldIdentityCanonicalSha256 === sha(JSON.stringify(identity)), "conductor_registered_world_mismatch");
  requireValue(binding.deploymentStatus === "registered_not_activated"
    && binding.authorization?.basis === "owner-authorized-initial-provisioning"
    && binding.authorization.record === "docs/conductor-release-signing.md", "conductor_registration_authority_invalid");
  const maps = { art: trust(data.artTrust), dialogue: trust(data.dialogueTrust) }, prior = trust(data.priorTrust);
  const priorFingerprints = new Set([...prior.values()].map(fingerprint)), roleFingerprints = new Set();
  requireValue(Object.keys(binding.roles).sort().join(",") === "art,dialogue", "conductor_registered_roles_invalid");
  for (const role of ["art", "dialogue"]) {
    const registered = binding.roles[role], key = maps[role].get(registered.keyId);
    requireValue(key !== undefined && fingerprint(key) === registered.publicSpkiSha256, "conductor_registered_key_mismatch");
    requireValue(!priorFingerprints.has(registered.publicSpkiSha256) && !roleFingerprints.has(registered.publicSpkiSha256), "conductor_key_role_reuse");
    requireValue(data[`${role}Signature`].keyId === registered.keyId, "conductor_registered_signing_key_mismatch");
    roleFingerprints.add(registered.publicSpkiSha256);
  }
  const art = await loadArtAtlasFromDirectory({ directory: resolve(ROOT, "assets/conductor-art/v1"), worldId: WORLD_ID,
    expectedPin: data.artPin, signature: data.artSignature, trustedKeys: maps.art });
  const dialogue = await loadDialogueReleaseFromDirectory({ directory: resolve(ROOT, "assets/conductor-dialogue/v1"), worldId: WORLD_ID,
    expectedPin: data.dialoguePin, signature: data.dialogueSignature, trustedKeys: maps.dialogue, validator });
  // Successful loading must retain the actual world guard, not just check it once.
  for (const read of [() => art.renderView("unregistered-world"), () => dialogue.report("unregistered-world")]) {
    let rejected = false; try { read(); } catch { rejected = true; } requireValue(rejected, "conductor_loaded_world_guard_missing");
  }
  const view = art.renderView(WORLD_ID);
  return { schemaVersion: "conductor-registered-release-verification/v1", worldId: WORLD_ID,
    releaseSignaturesVerified: true, privateKeysRead: false, worldServerActivated: false,
    worldIdentityCanonicalSha256: binding.worldIdentityCanonicalSha256, roles: binding.roles,
    art: { releaseId: view.releaseId, manifestSha256: view.manifestSha256, assets: view.assets.length,
      atlases: view.files.length, animations: view.animations.length }, dialogue: dialogue.report(WORLD_ID),
    files: Object.entries(FILES).map(([id, file]) => ({ file, ...(id === "identity"
      ? { canonicalJsonSha256: sha(JSON.stringify(identity)) } : { sha256: sha(inputs[id]) }) })),
    limits: ["Initial trust registered under the owner's completion authorization; no prior human fingerprint review claimed",
      "Existing Alpha world identity; this verification does not claim a running target server or activate a world"] };
}

export function nativeDialogueValidator({ addon, binary } = {}) {
  requireValue(!(addon && binary), "conductor_validator_ambiguous");
  addon ??= binary ? undefined : process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH;
  binary ??= addon ? undefined : process.env.ZUGFOLGE_DIALOGUE_TEST_BINARY;
  if (addon) return createRequire(import.meta.url)(resolve(addon));
  requireValue(binary, "conductor_native_validator_required");
  return { validateConductorDialogueRelease(input) {
    const result = spawnSync(resolve(binary), ["validate"], { input, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    requireValue(result.status === 0, "conductor_native_validator_rejected"); return result.stdout;
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    for (let at = 2; at < process.argv.length; at += 2) {
      const key = { "--validator-addon": "addon", "--validator-binary": "binary" }[process.argv[at]], value = process.argv[at + 1];
      requireValue(key && value && !Object.hasOwn(options, key), "conductor_verifier_arguments_invalid"); options[key] = value;
    }
    console.log(JSON.stringify(await verifyRegisteredConductorReleases({ validator: nativeDialogueValidator(options) }), null, 2));
  } catch (error) { console.error(error instanceof Error ? error.message : "conductor_release_verification_failed"); process.exitCode = 1; }
}
