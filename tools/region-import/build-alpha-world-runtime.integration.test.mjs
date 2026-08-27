import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { alphaHash } from "../../packages/alpha/dist/index.js";
import { decodeEconomyValue } from "../../packages/economy/dist/index.js";
import {
  OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV,
  loadOperationalSimulationRuntime,
} from "../../packages/runtime-native/dist/index.js";
import {
  ALPHA_WORLD_DEPLOYMENT_SCHEMA,
  parseSignedAlphaWorldDeployment,
  serializeSignedAlphaWorldDeployment,
} from "../../apps/game-api/dist/alpha-world-start.js";
import { operationalSimulationInitializationHash } from "../../apps/game-api/dist/operational-initialization-hash.js";
import { ActiveWorldDeploymentRuntime } from "../../apps/game-api/dist/world-deployment-runtime.js";
import {
  MINIMAL_BUILDER_EPOCH,
  MINIMAL_BUILDER_REGION_ID,
  MINIMAL_BUILDER_WORLD_ID,
  buildMinimalAlphaWorldRuntimeFixture,
} from "./minimal-alpha-world-builder.fixture.mjs";

const KEY_ID = "alpha-builder-runtime-fixture";
const nativeAvailable = process.env.ZUGFOLGE_RUNTIME_NATIVE_PATH !== undefined;

describe("echter Alpha-Builder bis zur produktiven Scheduler-Registry", () => {
  let root;
  let fixture;
  let serializedBuilderOutput;
  let buildConfiguration;
  let timetableTransferDemands;
  let movementRouteTemplates;
  let infraReleaseWrapper;
  let signed;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "zugfolge-alpha-builder-runtime-"));
    fixture = await buildMinimalAlphaWorldRuntimeFixture(root);
    serializedBuilderOutput = JSON.parse(await readFile(fixture.deployment, "utf8"));
    [buildConfiguration, timetableTransferDemands, movementRouteTemplates, infraReleaseWrapper] = await Promise.all([
      readFile(fixture.buildConfiguration, "utf8").then(JSON.parse),
      readFile(fixture.timetableTransferDemands, "utf8").then(JSON.parse),
      readFile(fixture.movementRouteTemplates, "utf8").then(JSON.parse),
      readFile(fixture.infraRelease, "utf8").then(JSON.parse),
    ]);

    const deployment = decodeEconomyValue(serializedBuilderOutput.deployment);
    const deploymentHash = alphaHash(ALPHA_WORLD_DEPLOYMENT_SCHEMA, deployment);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signedEnvelope = {
      deployment: serializedBuilderOutput.deployment,
      deploymentHash,
      signature: {
        algorithm: "Ed25519",
        keyId: KEY_ID,
        valueBase64: signEd25519(
          null,
          Buffer.from(deploymentHash, "hex"),
          privateKey,
        ).toString("base64"),
      },
    };
    const trustedKeys = {
      [KEY_ID]: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
    signed = parseSignedAlphaWorldDeployment(
      JSON.parse(JSON.stringify(signedEnvelope)),
      trustedKeys,
    );
    signed = parseSignedAlphaWorldDeployment(
      JSON.parse(JSON.stringify(serializeSignedAlphaWorldDeployment(signed))),
      trustedKeys,
    );
  });

  after(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  test("serialisiert das reale build-alpha-world-Output als kompakten Operational-v2-Vertrag", () => {
    assert.equal(buildConfiguration.schemaVersion, "zugfolge-alpha-world-build-configuration/v3");
    assert.equal(timetableTransferDemands.schema, "zugfolge-timetable-transfer-demands/v1");
    assert.equal(timetableTransferDemands.transferRoutes.length, fixture.routeCount);
    assert.equal(movementRouteTemplates.schema, "movement-route-templates-v2");
    assert.equal(movementRouteTemplates.transferTemplates.length, fixture.routeCount);
    assert.equal(
      movementRouteTemplates.timetableTransferSetSha256,
      timetableTransferDemands.transferSetSha256,
    );
    assert.equal(
      movementRouteTemplates.operationalStateHash,
      buildConfiguration.operationalInfrastructure.stateHash,
    );
    assert.deepEqual(
      infraReleaseWrapper.release.artifacts.map(({ kind }) => kind).sort(),
      ["movement-route-templates-v2", "operational-infrastructure-v2", "timetable-transfer-demands-v1"],
    );
    assert.deepEqual(Object.keys(serializedBuilderOutput), ["deployment"]);
    assert.equal(signed.deployment.worldId, MINIMAL_BUILDER_WORLD_ID);
    assert.equal(signed.deployment.worldDefinition.epoch, MINIMAL_BUILDER_EPOCH);
    assert.equal(signed.deployment.regionalSimulation.regionId, MINIMAL_BUILDER_REGION_ID);
    assert.equal(
      signed.deployment.regionalSimulation.trains.length,
      fixture.routeCount + timetableTransferDemands.transferRoutes.length,
    );
    assert.equal(
      signed.deployment.regionalSimulation.trains.filter(({ publicPassengerStop }) => publicPassengerStop).length,
      fixture.routeCount,
    );
    assert.deepEqual(
      Object.keys(signed.deployment.regionalSimulation.infraRelease).sort(),
      ["bytes", "file", "infraReleaseId", "schemaVersion", "sha256", "stateHash"].sort(),
    );
    assert.equal(
      signed.deployment.regionalSimulation.infraRelease.stateHash,
      signed.deployment.blueprint.conflictCheckHash,
    );
    assert.equal(
      signed.deployment.provenance.operationalInfrastructureStateHash,
      signed.deployment.blueprint.conflictCheckHash,
    );
    assert.equal(
      Object.hasOwn(signed.deployment.regionalSimulation.infraRelease, "routeVersions"),
      false,
    );
    assert.equal(
      Object.hasOwn(signed.deployment.regionalSimulation.infraRelease, "interlockingRoutes"),
      false,
    );
  });

  test("hydriert das Builder-Deployment beim Serverstart nativ und registriert exakt sein Schedulerprogramm", {
    skip: !nativeAvailable,
  }, () => {
    const previousRoots = process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
    process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = JSON.stringify({
      [fixture.infraReleaseId]: fixture.infrastructureRoot,
    });
    try {
      const nativeRuntime = loadOperationalSimulationRuntime();
      const runtimeSeed = {
        activeWorlds: [],
        operationalProgramPreflight: (initialization) =>
          nativeRuntime.initialize(initialization).validationReceipt,
      };
      const runtime = new ActiveWorldDeploymentRuntime(runtimeSeed);
      const prepared = runtime.prepareOperationalProgram(signed);
      const expectedTrainRunIds = signed.deployment.regionalSimulation.trains.map(({ id }) => id);

      assert.deepEqual(
        runtime.operationalProgramRegistration(MINIMAL_BUILDER_WORLD_ID, MINIMAL_BUILDER_REGION_ID),
        {
          deploymentHash: signed.deploymentHash,
          initializationHash: operationalSimulationInitializationHash(
            signed.deployment.regionalSimulation,
          ),
          trainRunIds: expectedTrainRunIds,
        },
      );
      assert.deepEqual(runtime.realtimeRegions(), []);

      runtime.register(signed, new Date(MINIMAL_BUILDER_EPOCH));
      prepared.rollback();
      assert.deepEqual(runtime.worldIds(), [MINIMAL_BUILDER_WORLD_ID]);
      assert.deepEqual(runtime.realtimeWorldIds(), [MINIMAL_BUILDER_WORLD_ID]);
      assert.deepEqual(runtime.realtimeRegions().map(({ worldId, regionId }) => ({ worldId, regionId })), [{
        worldId: MINIMAL_BUILDER_WORLD_ID,
        regionId: MINIMAL_BUILDER_REGION_ID,
      }]);
      assert.deepEqual(
        runtime.operationalProgramRegistration(MINIMAL_BUILDER_WORLD_ID, MINIMAL_BUILDER_REGION_ID).trainRunIds,
        expectedTrainRunIds,
      );

      const firstTrain = signed.deployment.regionalSimulation.trains[0];
      const commands = runtime.at(
        MINIMAL_BUILDER_WORLD_ID,
        MINIMAL_BUILDER_REGION_ID,
        firstTrain.scheduledDepartureMs,
      );
      assert.deepEqual(commands.map(({ command }) => command.type), ["materialize", "dispatch"]);
      assert.equal(commands[0].command.train.id, firstTrain.id);
      assert.equal(commands[1].command.requests[0].trainId, firstTrain.id);
      assert.equal(
        commands[1].command.requests[0].interlockingRouteId,
        firstTrain.dispatchInterlockingRouteId,
      );
    } finally {
      if (previousRoots === undefined) {
        delete process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
      } else {
        process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = previousRoots;
      }
    }
  });
});
