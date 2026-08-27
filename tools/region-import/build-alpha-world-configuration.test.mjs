import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { alphaCanonicalJson } from "../../packages/alpha/dist/index.js";
import { deriveAlphaWorldBuildConfiguration } from "./build-alpha-world-configuration.mjs";

const sha = (letter) => letter.repeat(64);
const SHA_A = sha("a");
const SHA_B = sha("b");
const SHA_C = sha("c");
const SHA_D = sha("d");
const SHA_E = sha("e");
const SHA_F = sha("f");
const SHA_1 = sha("1");
const SHA_2 = sha("2");

function wrapper() {
  const release = {
    schema: "zugfolge-infra-release/v2",
    releaseId: "infra-deutschland-2026.3",
    artifacts: [
      {
        id: "operational-infrastructure-deutschland-2026.3",
        kind: "operational-infrastructure-v2",
        infraReleaseId: "infra-deutschland-2026.3",
        file: "operational-infrastructure-v2.json",
        bytes: 1_234,
        sha256: SHA_A,
        stateHash: SHA_B,
      },
      {
        id: "operational-movement-routes-deutschland-2026.3",
        kind: "movement-route-templates-v2",
        file: "operational-infrastructure-v2.movement-route-templates-v2.json",
        bytes: 96,
        sha256: SHA_1,
      },
      {
        id: "timetable-transfer-demands-deutschland-2026.3",
        kind: "timetable-transfer-demands-v2",
        file: "timetable-routes-v2.transfer-demands-v2.json",
        bytes: 72,
        sha256: SHA_D,
      },
    ],
    quality: {
      operationalClosure: {
        operationalQualityEligible: true,
        unresolvedRequired: 0,
        movementRouteTemplates: {
          bytes: 96,
          sha256: SHA_1,
          stateHash: SHA_2,
          operationalStateHash: SHA_B,
          timetableTransferSetSha256: SHA_F,
        },
        timetableRouteEvidence: {
          routesBytes: 84,
          routesSha256: SHA_C,
          routeSetSha256: SHA_C,
          routeRecordCount: 4,
          completeRouteCount: 4,
          transferDemandsBytes: 72,
          transferDemandsSha256: SHA_D,
          dailyCirculationPlanSha256: SHA_E,
          transferSetSha256: SHA_F,
        },
      },
    },
  };
  return { release, releaseHash: createHash("sha256").update(alphaCanonicalJson(release)).digest("hex") };
}

function identity() {
  return {
    schemaVersion: "zugfolge-alpha-world-identity/v1",
    worldId: "0db56535-a466-44a8-a991-38a8a1f7566c",
    regionId: "mitteldeutschland-b",
    regionVariant: "B",
    operatorId: "public",
    seed: "2026082501",
    fleetReleaseId: "fleet-alpha-mitteldeutschland-b-2026.3",
    planningAuthority: { accountId: "9158446f-70be-46ce-bbfa-7b4cf56215ff", displayName: "Aufgabentraeger" },
  };
}

test("Jahreskonfiguration v3 wird ausschliesslich aus Identitaet und signierter V2-Evidenz abgeleitet", () => {
  const result = deriveAlphaWorldBuildConfiguration(identity(), wrapper());
  assert.equal(result.schemaVersion, "zugfolge-alpha-world-build-configuration/v3");
  assert.deepEqual(result.operationalInfrastructure, { file: "operational-infrastructure-v2.json", bytes: 1_234, sha256: SHA_A, stateHash: SHA_B });
  assert.deepEqual(result.timetableRoutes, { file: "timetable-routes-v2.jsonseq", bytes: 84, sha256: SHA_C });
  assert.deepEqual(result.timetableTransferDemands, {
    file: "timetable-routes-v2.transfer-demands-v2.json",
    bytes: 72,
    sha256: SHA_D,
    dailyPlanSha256: SHA_E,
    transferSetSha256: SHA_F,
  });
  assert.deepEqual(result.movementRouteTemplates, {
    file: "operational-infrastructure-v2.movement-route-templates-v2.json",
    bytes: 96,
    sha256: SHA_1,
    stateHash: SHA_2,
    operationalStateHash: SHA_B,
    timetableTransferSetSha256: SHA_F,
  });
  assert.equal(result.worldId, identity().worldId);
});

test("offene Operational-Qualitaet und auseinanderlaufende Routenhashes blockieren die Konfiguration", () => {
  const blocked = wrapper();
  blocked.release.quality.operationalClosure.unresolvedRequired = 1;
  blocked.releaseHash = createHash("sha256").update(alphaCanonicalJson(blocked.release)).digest("hex");
  assert.throws(() => deriveAlphaWorldBuildConfiguration(identity(), blocked), /keine geschlossene/u);
  const foreign = wrapper();
  foreign.release.quality.operationalClosure.timetableRouteEvidence.routeSetSha256 = SHA_A;
  foreign.releaseHash = createHash("sha256").update(alphaCanonicalJson(foreign.release)).digest("hex");
  assert.throws(() => deriveAlphaWorldBuildConfiguration(identity(), foreign), /keine geschlossene/u);

  const foreignTransfer = wrapper();
  foreignTransfer.release.quality.operationalClosure.timetableRouteEvidence.transferSetSha256 = SHA_A;
  foreignTransfer.releaseHash = createHash("sha256").update(alphaCanonicalJson(foreignTransfer.release)).digest("hex");
  assert.throws(() => deriveAlphaWorldBuildConfiguration(identity(), foreignTransfer), /keine geschlossene/u);

  const foreignMovement = wrapper();
  foreignMovement.release.quality.operationalClosure.movementRouteTemplates.operationalStateHash = SHA_A;
  foreignMovement.releaseHash = createHash("sha256").update(alphaCanonicalJson(foreignMovement.release)).digest("hex");
  assert.throws(() => deriveAlphaWorldBuildConfiguration(identity(), foreignMovement), /keine geschlossene/u);
});

test("fehlende, doppelte oder um Zusatzfelder erweiterte Sidecar-Artefakte blockieren v3", () => {
  const missing = wrapper();
  missing.release.artifacts = missing.release.artifacts.filter(({ kind }) => kind !== "movement-route-templates-v2");
  missing.releaseHash = createHash("sha256").update(alphaCanonicalJson(missing.release)).digest("hex");
  assert.throws(() => deriveAlphaWorldBuildConfiguration(identity(), missing), /genau ein movement-route-templates-v2/u);

  const duplicate = wrapper();
  const movement = duplicate.release.artifacts.find(({ kind }) => kind === "movement-route-templates-v2");
  duplicate.release.artifacts.push({ ...movement, id: `${movement.id}-duplicate` });
  duplicate.releaseHash = createHash("sha256").update(alphaCanonicalJson(duplicate.release)).digest("hex");
  assert.throws(() => deriveAlphaWorldBuildConfiguration(identity(), duplicate), /genau ein movement-route-templates-v2/u);

  const manual = wrapper();
  manual.release.artifacts.find(({ kind }) => kind === "timetable-transfer-demands-v2").transferSetSha256 = SHA_F;
  manual.releaseHash = createHash("sha256").update(alphaCanonicalJson(manual.release)).digest("hex");
  assert.throws(() => deriveAlphaWorldBuildConfiguration(identity(), manual), /fehlende oder unbekannte Felder/u);

  const legacyTransfer = wrapper();
  const transfer = legacyTransfer.release.artifacts.find(({ kind }) => kind === "timetable-transfer-demands-v2");
  transfer.kind = "timetable-transfer-demands-v1";
  transfer.file = "timetable-routes-v2.transfer-demands-v1.json";
  legacyTransfer.releaseHash = createHash("sha256").update(alphaCanonicalJson(legacyTransfer.release)).digest("hex");
  assert.throws(
    () => deriveAlphaWorldBuildConfiguration(identity(), legacyTransfer),
    /genau ein timetable-transfer-demands-v2/u,
  );
});
