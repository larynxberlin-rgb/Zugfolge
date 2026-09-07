import assert from "node:assert/strict";
import test from "node:test";
import { nativeDialogueValidator, readRegisteredConductorInputs, verifyRegisteredConductorReleases } from "./verify.mjs";

const nativeAvailable = !!(process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH || process.env.ZUGFOLGE_DIALOGUE_TEST_BINARY);
const replaceJson = (inputs, key, change) => ({ ...inputs, [key]: Buffer.from(JSON.stringify(change(JSON.parse(inputs[key])))) });

test("registered original signatures and separate public trust load both real releases for the existing Alpha world", { skip: !nativeAvailable }, async () => {
  const report = await verifyRegisteredConductorReleases({ validator: nativeDialogueValidator() });
  assert.equal(report.worldId, "0db56535-a466-44a8-a991-38a8a1f7566c");
  assert.deepEqual([report.art.assets, report.art.atlases, report.art.animations], [186, 7, 60]);
  assert.deepEqual([report.dialogue.families, report.dialogue.trees, report.dialogue.utterances], [12, 156, 624]);
  assert.equal(report.releaseSignaturesVerified, true); assert.equal(report.privateKeysRead, false);
  assert.equal(report.worldServerActivated, false);
});

test("another world or swapped role trust cannot reuse the registered release authorization", async () => {
  const inputs = await readRegisteredConductorInputs();
  await assert.rejects(verifyRegisteredConductorReleases({ inputs: replaceJson(inputs, "artPin", row => ({ ...row, worldId: "unregistered-world" })) }), /atlas_world_mismatch/u);
  await assert.rejects(verifyRegisteredConductorReleases({ inputs: { ...inputs, artTrust: inputs.dialogueTrust } }), /conductor_registered_key_mismatch/u);
});

test("changing the actual detached art signature fails cryptographic verification", async () => {
  const inputs = await readRegisteredConductorInputs();
  const changed = replaceJson(inputs, "artSignature", row => {
    const bytes = Buffer.from(row.valueBase64, "base64"); bytes[0] ^= 1;
    return { ...row, valueBase64: bytes.toString("base64") };
  });
  await assert.rejects(verifyRegisteredConductorReleases({ inputs: changed }), /atlas_signature_invalid/u);
});

test("changing the actual dialogue signature fails before the native content resolver", async () => {
  const inputs = await readRegisteredConductorInputs();
  const changed = replaceJson(inputs, "dialogueSignature", row => {
    const bytes = Buffer.from(row.valueBase64, "base64"); bytes[0] ^= 1;
    return { ...row, valueBase64: bytes.toString("base64") };
  });
  await assert.rejects(verifyRegisteredConductorReleases({ inputs: changed }), /dialogue_signature_invalid/u);
});
