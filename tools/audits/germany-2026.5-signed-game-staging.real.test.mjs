import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";

import { verifySourceCandidateBeforeStaging } from "./signed-game-staging-source-verification.mjs";

const REQUIRED_ENV = [
  "ZUGFOLGE_REAL_SIGNED_MAP_PACKAGE_ROOT",
  "ZUGFOLGE_REAL_SIGNED_MAP_STAGING_ROOT",
  "ZUGFOLGE_REAL_SIGNED_MAP_PACKAGE_VERIFIER",
  "INFRA_OPERATIONAL_V2_VALIDATOR_PATH",
  "ZUGFOLGE_REAL_TRUSTED_DELIVERY_KEYS",
  "ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_BYTES",
  "ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_SHA256",
];

const missingEnvironment = REQUIRED_ENV.filter((name) => !process.env[name]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function absoluteEnvironmentPath(name) {
  const value = process.env[name];
  assert.ok(value, `${name} fehlt.`);
  assert.ok(isAbsolute(value), `${name} muss ein absoluter Pfad sein.`);
  return resolve(value);
}

function expectedManifestProof() {
  const bytes = Number(process.env.ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_BYTES);
  const sha = process.env.ZUGFOLGE_REAL_SIGNED_MAP_EXPECTED_MANIFEST_SHA256;
  assert.ok(Number.isSafeInteger(bytes) && bytes > 0, "Erwartete .5-Manifestbytezahl ist ungueltig.");
  assert.match(sha ?? "", /^[a-f0-9]{64}$/u, "Erwarteter .5-Manifest-SHA-256 ist ungueltig.");
  return Object.freeze({ bytes, sha256: sha });
}

async function trustedDeliveryKeys(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  for (const [keyId, publicKey] of Object.entries(parsed)) {
    assert.match(keyId, /^[A-Za-z0-9._-]+$/);
    assert.equal(typeof publicKey, "string");
    assert.match(publicKey, /^-----BEGIN PUBLIC KEY-----/);
  }
  assert.ok(parsed["zugfolge-map-deutschland-2026.5"], "Der Deutschland-2026.5-Delivery-Key fehlt im Trust-Register.");
  assert.ok(
    Object.hasOwn(parsed, "zugfolge-map-deutschland-2026.4"),
    "Der vorherige Deutschland-2026.4-Delivery-Key muss fuer Rollback und Altartefakte im Trust-Register bleiben.",
  );
  assert.equal(
    Object.hasOwn(parsed, "zugfolge-map-deutschland-2026.3"),
    false,
    "Der verworfene Deutschland-2026.3-Delivery-Key darf nicht im Trust-Register stehen.",
  );
  return Object.freeze({
    "zugfolge-map-deutschland-2026.5": parsed["zugfolge-map-deutschland-2026.5"],
  });
}

test("staged den echten signierten Deutschland-2026.5-V2-Kandidaten im Game fail-closed", {
  skip: missingEnvironment.length === 0
    ? false
    : `echte Artefaktpfade fehlen: ${missingEnvironment.join(", ")}`,
  timeout: 60 * 60 * 1_000,
}, async (context) => {
  const packageRoot = absoluteEnvironmentPath("ZUGFOLGE_REAL_SIGNED_MAP_PACKAGE_ROOT");
  const stagingRoot = absoluteEnvironmentPath("ZUGFOLGE_REAL_SIGNED_MAP_STAGING_ROOT");
  const packageVerifierModule = absoluteEnvironmentPath("ZUGFOLGE_REAL_SIGNED_MAP_PACKAGE_VERIFIER");
  const nativeValidator = absoluteEnvironmentPath("INFRA_OPERATIONAL_V2_VALIDATOR_PATH");
  const trustedKeysPath = absoluteEnvironmentPath("ZUGFOLGE_REAL_TRUSTED_DELIVERY_KEYS");
  const expectedManifest = expectedManifestProof();

  const [{ InfraPackageStaging, createLocalMapPackageVerifier }, { createInfraOperationalV2NativeVerifier }] = await Promise.all([
    import("../../apps/game-api/dist/infra-package-staging.js"),
    import("../../apps/game-api/dist/infra-operational-native-verifier.js"),
  ]);
  const [packageVerifier, nativeOperationalVerifier, trustedReleaseKeys] = await Promise.all([
    createLocalMapPackageVerifier(packageVerifierModule),
    createInfraOperationalV2NativeVerifier(nativeValidator),
    trustedDeliveryKeys(trustedKeysPath),
  ]);
  const staging = new InfraPackageStaging(stagingRoot, {
    packageVerifier,
    nativeOperationalVerifier,
    trustedReleaseKeys,
  });

  const manifestPath = join(packageRoot, "manifest.json");
  const manifest = await readFile(manifestPath);
  const manifestProof = { bytes: manifest.length, sha256: sha256(manifest) };
  assert.deepEqual(manifestProof, expectedManifest);

  const importId = "infra-deutschland-2026.5-signed-v2-local";
  const { sourceVerification, stagingResult: begun } = await verifySourceCandidateBeforeStaging({
    packageRoot,
    packageVerifier,
    expected: {
      packageId: "zugfolge-map-deutschland",
      version: "2026.5",
      manifestSha256: manifestProof.sha256,
    },
    continueStaging: () => staging.begin(importId, manifestProof),
  });
  context.diagnostic(`Quellkandidat vor Stage-Wiederverwendung vollstaendig verifiziert: ${sourceVerification.manifestSha256}`);
  if (begun.status === "created") {
    const accepted = await staging.uploadManifest(importId, manifestProof, createReadStream(manifestPath));
    context.diagnostic(`Game hat ${accepted.parts.length} Paketteile aus dem signierten Manifest angenommen.`);
    let completed = 0;
    for (const part of accepted.parts) {
      await staging.uploadPart(
        importId,
        part.partId,
        { bytes: part.bytes, sha256: part.sha256 },
        createReadStream(join(packageRoot, ...part.packagePath.split("/"))),
      );
      completed += 1;
      if (completed % 100 === 0 || completed === accepted.parts.length) {
        context.diagnostic(`${completed}/${accepted.parts.length} Paketteile bytegenau im Game-Staging gespeichert.`);
      }
    }
  }

  const result = await staging.finalize(importId);
  assert.deepEqual(
    {
      packageId: result.packageId,
      version: result.version,
      manifestSha256: result.manifestSha256,
      deliveryReleaseId: result.deliveryReleaseId,
      signatureStatus: result.signatureStatus,
      nativeOperationalValidationStatus: result.nativeOperationalValidationStatus,
      operationalStateHash: result.operationalStateHash,
      activationBlocker: result.activationBlocker,
      activationEligible: result.activationEligible,
    },
    {
      packageId: "zugfolge-map-deutschland",
      version: "2026.5",
      manifestSha256: expectedManifest.sha256,
      deliveryReleaseId: "infra-deutschland-2026.5",
      signatureStatus: "verified",
      nativeOperationalValidationStatus: "verified",
      operationalStateHash: "PENDING_REAL_ANNUAL_RELEASE_BUILD",
      activationBlocker: null,
      activationEligible: true,
    },
  );
  assert.ok(resolve(result.stagePath).startsWith(`${stagingRoot}\\`) || resolve(result.stagePath).startsWith(`${stagingRoot}/`));
  context.diagnostic(`Signierter Delivery-v2-Kandidat lokal qualifiziert: ${result.stagePath}`);
});

throw new Error("PENDING_REAL_ANNUAL_RELEASE_BUILD: Deutschland-Signed-Game-Staging-Audit 2026.5 muss nach dem realen Jahresrelease-Build neu gepinnt werden.");
