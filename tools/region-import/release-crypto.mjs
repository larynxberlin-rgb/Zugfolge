import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export function canonical(value) {
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function releaseHash(manifest) {
  const { releaseHash: ignoredHash, signature: ignoredSignature, ...unsigned } = manifest;
  void ignoredHash;
  void ignoredSignature;
  return sha256Bytes(canonical(unsigned));
}

export function signRelease(manifest, privateKeyPem, keyId) {
  const hash = releaseHash(manifest);
  const signature = sign(null, Buffer.from(hash, "hex"), createPrivateKey(privateKeyPem));
  return {
    ...manifest,
    releaseHash: hash,
    signature: { algorithm: "Ed25519", keyId, valueBase64: signature.toString("base64") },
  };
}

export function verifyRelease(signed, publicKeyPem) {
  return signed.releaseHash === releaseHash(signed)
    && signed.signature?.algorithm === "Ed25519"
    && Buffer.from(signed.signature.valueBase64, "base64").length === 64
    && verify(null, Buffer.from(signed.releaseHash, "hex"), createPublicKey(publicKeyPem), Buffer.from(signed.signature.valueBase64, "base64"));
}

