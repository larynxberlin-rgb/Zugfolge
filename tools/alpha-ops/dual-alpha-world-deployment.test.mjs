import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { alphaHash, validateWorldBlueprint } from "../../packages/alpha/dist/index.js";
import { decodeEconomyValue, encodeEconomyValue } from "../../packages/economy/dist/index.js";
import {
  assertEmbeddedWorldIds,
  assertNoStarterIdentifiers,
  rebindWorldIds,
} from "../region-import/alpha-world-variants.mjs";

const PUBLIC_WORLD_ID = "00000000-0000-4000-8000-000000000014";
const TUTORIAL_WORLD_ID = "00000000-0000-4000-8000-000000000083";

function minimalPublicDeployment() {
  return {
    schema: "zugfolge-alpha-world-deployment/v1",
    worldId: PUBLIC_WORLD_ID,
    worldDefinition: {
      name: "Oeffentliche Alpha-Welt",
      kind: "public",
      rankingStatus: "ranked",
      schedulePeriodWeeks: 4,
      epoch: "2026-12-13T00:00:00.000Z",
    },
    blueprint: {
      schemaVersion: "zugfolge-alpha-world-blueprint/v2",
      regionId: "mitteldeutschland-b",
      regionVariant: "B",
      seed: 14_2026n,
      profileKind: "public",
      accelerationFactor: 1,
      periodCount: 10,
      startingCapitalPolicy: { mode: "finite", amountCents: "0" },
      entryFacilityPolicy: {
        schemaVersion: "zugfolge-public-entry-facility/v1",
        mode: "award-contingent-wet-lease",
        providerOperatorId: "public",
        costBasis: "formation-operating-cost",
      },
      releases: {
        infra: "a".repeat(64),
        timetable: "b".repeat(64),
        fleet: "c".repeat(64),
        economy: "d".repeat(64),
      },
      lots: [{
        lotId: "lot-1",
        contractEndsAtPeriod: 2,
        trainRunIds: ["run-1"],
        pathReceiptIds: ["path-1"],
        vehicleIds: ["public-vehicle-1"],
        personnelDutyIds: ["duty-1"],
        circulationIds: ["circulation-1"],
        operatingProgramIds: ["program-1"],
      }],
      conflictCheckHash: "e".repeat(64),
      tenderCalendarHash: "f".repeat(64),
    },
    fleet: { worldId: PUBLIC_WORLD_ID, authorityRelease: { assets: [{ id: "public-vehicle-1", operatorId: "public" }] } },
    regionalSimulation: { worldId: PUBLIC_WORLD_ID },
    boundaryTransitions: [{ transitionId: "external-reenter-1", worldId: PUBLIC_WORLD_ID }],
  };
}

test("Tutorialvariante bindet jedes eingebettete worldId und laesst das Public-Deployment unveraendert", () => {
  const publicDeployment = minimalPublicDeployment();
  const tutorialDeployment = rebindWorldIds(publicDeployment, PUBLIC_WORLD_ID, TUTORIAL_WORLD_ID);
  tutorialDeployment.worldDefinition = {
    ...tutorialDeployment.worldDefinition,
    name: "Tutorial-Welt",
    kind: "tutorial",
    rankingStatus: "unranked",
    schedulePeriodWeeks: 3,
  };
  tutorialDeployment.blueprint = {
    ...tutorialDeployment.blueprint,
    profileKind: "tutorial",
    accelerationFactor: 60,
    entryFacilityPolicy: { schemaVersion: "zugfolge-public-entry-facility/v1", mode: "disabled" },
  };

  assertEmbeddedWorldIds(publicDeployment, PUBLIC_WORLD_ID);
  assertEmbeddedWorldIds(tutorialDeployment, TUTORIAL_WORLD_ID);
  assert.doesNotThrow(() => validateWorldBlueprint(publicDeployment.blueprint));
  assert.doesNotThrow(() => validateWorldBlueprint(tutorialDeployment.blueprint));
  assert.equal(publicDeployment.boundaryTransitions[0].worldId, PUBLIC_WORLD_ID);
  assert.equal(tutorialDeployment.boundaryTransitions[0].worldId, TUTORIAL_WORLD_ID);
  assert.equal(tutorialDeployment.blueprint.profileKind, "tutorial");
  assert.equal(tutorialDeployment.blueprint.accelerationFactor, 60);
  assert.deepEqual(tutorialDeployment.blueprint.entryFacilityPolicy, {
    schemaVersion: "zugfolge-public-entry-facility/v1",
    mode: "disabled",
  });
});

test("Weltbindung und reservierte Tutorialkennungen werden fail-closed geprueft", () => {
  assert.doesNotThrow(() => assertNoStarterIdentifiers(minimalPublicDeployment()));
  assert.throws(
    () => assertNoStarterIdentifiers({ fleet: { assets: [{ id: "starter-vehicle-001" }] } }),
    /reservierte Tutorialkennung/,
  );
  assert.throws(
    () => assertNoStarterIdentifiers({ startPackageSlots: [] }),
    /Tutorial-Startpaketvertrag/,
  );
  assert.throws(
    () => rebindWorldIds({ worldId: "foreign-world" }, PUBLIC_WORLD_ID, TUTORIAL_WORLD_ID),
    /unerwartete Welt/,
  );
  assert.throws(
    () => assertEmbeddedWorldIds({ boundaryTransitions: [{ worldId: PUBLIC_WORLD_ID }] }, TUTORIAL_WORLD_ID),
    /verletzt die Weltbindung/,
  );
});

test("Generatorvertrag erzeugt nur das signierbare Public-Artefakt; Tutorialwelten entstehen in gebundenen Sessions", async () => {
  const source = await readFile(new URL("../region-import/build-alpha-world.mjs", import.meta.url), "utf8");
  assert.match(source, /schemaVersion: "zugfolge-alpha-world-blueprint\/v2"/);
  assert.match(source, /startingCapitalPolicy: publicDeployConfiguration\.startingCapitalPolicy/);
  assert.match(source, /mode: "award-contingent-wet-lease"/);
  assert.match(source, /costBasis: "formation-operating-cost"/);
  assert.doesNotMatch(source, /tutorialDeploymentPath/);
  assert.doesNotMatch(source, /tutorialConfigurationPath/);
  assert.doesNotMatch(source, /tutorialFleet\.authorityRelease\.assets\.push/);
  assert.doesNotMatch(source, /startPackageSlots/);
  assert.doesNotMatch(source, /const phase2Configuration\s*=/);
  assert.doesNotMatch(source, /writeFile\([^\n]*\.phase2\.json/);
});

test("bestehender Ed25519-Signierer signiert Public und Tutorial als getrennte Hüllen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-dual-alpha-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPath = join(directory, "private.pem");
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

    const publicDeployment = minimalPublicDeployment();
    const tutorialDeployment = rebindWorldIds(publicDeployment, PUBLIC_WORLD_ID, TUTORIAL_WORLD_ID);
    tutorialDeployment.worldDefinition = {
      ...tutorialDeployment.worldDefinition,
      name: "Tutorial-Welt",
      kind: "tutorial",
      rankingStatus: "unranked",
      schedulePeriodWeeks: 3,
    };
    tutorialDeployment.blueprint = {
      ...tutorialDeployment.blueprint,
      seed: 83_2026n,
      profileKind: "tutorial",
      accelerationFactor: 60,
      entryFacilityPolicy: { schemaVersion: "zugfolge-public-entry-facility/v1", mode: "disabled" },
    };
    const deployments = [publicDeployment, tutorialDeployment];
    const hashes = [];
    const signerPath = fileURLToPath(new URL("./sign-alpha-deployment.mjs", import.meta.url));

    for (const [index, deployment] of deployments.entries()) {
      const unsignedPath = join(directory, `deployment-${index}.json`);
      const signedPath = join(directory, `deployment-${index}.signed.json`);
      await writeFile(unsignedPath, `${JSON.stringify({ deployment: encodeEconomyValue(deployment) }, null, 2)}\n`);
      const result = spawnSync(process.execPath, [signerPath, unsignedPath, privateKeyPath, "dual-test", signedPath], { encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);

      const signed = JSON.parse(await readFile(signedPath, "utf8"));
      const decoded = decodeEconomyValue(signed.deployment);
      const expectedHash = alphaHash("zugfolge-alpha-world-deployment/v1", decoded);
      assert.equal(signed.deploymentHash, expectedHash);
      assert.equal(signed.signature.algorithm, "Ed25519");
      assert.equal(
        verify(null, Buffer.from(expectedHash, "hex"), publicKey, Buffer.from(signed.signature.valueBase64, "base64")),
        true,
      );
      hashes.push(expectedHash);
    }

    assert.notEqual(hashes[0], hashes[1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
