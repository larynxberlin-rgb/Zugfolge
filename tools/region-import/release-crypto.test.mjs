import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { releaseHash, signRelease, verifyRelease } from "./release-crypto.mjs";

test("InfraRelease-Hash und Ed25519-Signatur binden den kanonischen Inhalt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = { schema: "zugfolge-infra-release/v1", values: { b: 2, a: 1 } };
  const signed = signRelease(manifest, privateKey.export({ type: "pkcs8", format: "pem" }), "test-key");
  assert.equal(signed.releaseHash, releaseHash(manifest));
  assert.equal(verifyRelease(signed, publicKey.export({ type: "spki", format: "pem" })), true);
  assert.equal(verifyRelease({ ...signed, values: { b: 3, a: 1 } }, publicKey.export({ type: "spki", format: "pem" })), false);
});
