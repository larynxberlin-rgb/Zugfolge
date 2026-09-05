import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signEd25519 } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { alphaHash } from "../../packages/alpha/dist/index.js";
import { decodeEconomyValue } from "../../packages/economy/dist/index.js";
import {
  OPERATIONAL_DAILY_RESTRICTIONS_SCHEMA,
  OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
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
import { DailyRestrictionCommandCatalog } from "../../apps/game-api/dist/daily-restriction-catalog.js";
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
    assert.equal(timetableTransferDemands.schema, "zugfolge-timetable-transfer-demands/v2");
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
      ["movement-route-templates-v2", "operational-infrastructure-v2", "timetable-transfer-demands-v2"],
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
      const trainsById = new Map(
        signed.deployment.regionalSimulation.trains.map((train) => [train.id, train]),
      );
      const continuationByPredecessor = new Map(
        signed.deployment.regionalSimulation.movementContinuations.map((continuation) => [
          continuation.predecessorTrainId,
          continuation,
        ]),
      );
      const expectedContinuationChain = [];
      let predecessorTrainId = firstTrain.id;
      let predecessorDay = 0;
      for (;;) {
        const continuation = continuationByPredecessor.get(predecessorTrainId);
        assert.ok(continuation, `Fahrt '${predecessorTrainId}' besitzt keine physische Nachfolgekette.`);
        const successor = trainsById.get(continuation.successorTrainId);
        assert.ok(successor, `Fortsetzung '${continuation.id}' verweist auf eine unbekannte Fahrt.`);
        const successorDay = predecessorDay + continuation.successorDayOffset;
        expectedContinuationChain.push({
          continuation,
          predecessorTrainId: predecessorDay === 0
            ? predecessorTrainId
            : `${predecessorTrainId}:day-${predecessorDay}`,
          successorTrainId: successorDay === 0
            ? successor.id
            : `${successor.id}:day-${successorDay}`,
        });
        if (successor.publicPassengerStop) break;
        predecessorTrainId = successor.id;
        predecessorDay = successorDay;
      }
      assert.deepEqual(commands.map(({ command }) => command.type), [
        "materialize",
        ...expectedContinuationChain.map(() => "queue-movement-continuation"),
        "dispatch",
      ]);
      assert.equal(commands[0].command.train.id, firstTrain.id);
      const queuedContinuations = commands.slice(1, -1).map(({ command }) => {
        assert.equal(command.type, "queue-movement-continuation");
        return command.continuation;
      });
      assert.deepEqual(
        queuedContinuations.map((continuation) => ({
          predecessorTrainId: continuation.predecessorTrainId,
          predecessorBaseRouteVersionId: continuation.predecessorBaseRouteVersionId,
          successorTrainId: continuation.successor.id,
          minimumDwellMs: continuation.minimumDwellMs,
          continuity: continuation.continuity,
        })),
        expectedContinuationChain.map(({ continuation, predecessorTrainId, successorTrainId }) => ({
          predecessorTrainId,
          predecessorBaseRouteVersionId: continuation.predecessorBaseRouteVersionId,
          successorTrainId,
          minimumDwellMs: continuation.minimumDwellMs,
          continuity: continuation.continuity,
        })),
      );
      const dispatch = commands.at(-1).command;
      assert.equal(dispatch.type, "dispatch");
      assert.equal(dispatch.requests[0].trainId, firstTrain.id);
      assert.equal(
        dispatch.requests[0].interlockingRouteId,
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

  test("explizite La-Policy erzeugt nativ wirksame Geschwindigkeit, committed Diagnose und restartfaehigen Ablauf", {
    skip: !nativeAvailable,
  }, async () => {
    const previousRoots = process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
    process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = JSON.stringify({ [fixture.infraReleaseId]: fixture.infrastructureRoot });
    try {
      const native = loadOperationalSimulationRuntime();
      const policy = {
        version: 1, plannedWorksMode: "SIMULATED", operationalIncidentMode: "SIMULATED", providerSetId: null,
        simulationProfile: {
          id: "explicit-alpha-la-integration/v1", eventsPerPeriod: 6,
          minimumSeverityBasisPoints: 1_000, maximumSeverityBasisPoints: 8_000,
          minimumDurationSeconds: 1_800, maximumDurationSeconds: 21 * 86_400,
          minimumNoticeSeconds: 7 * 86_400, maximumNoticeSeconds: 21 * 86_400,
          dailyRestrictionsPerDay: 400, infrastructureIncidentsPer100Days: 1,
          vehicleIncidentsPer10000TrainRuns: 1, dwellIncidentsPer10000Stops: 1,
        },
        rulesetVersion: "disruption-rules/v1", validFromMs: 0, validUntilMs: null,
      };
      const request = {
        schemaVersion: OPERATIONAL_DAILY_RESTRICTIONS_SCHEMA,
        worldId: MINIMAL_BUILDER_WORLD_ID, regionId: MINIMAL_BUILDER_REGION_ID,
        seed: signed.deployment.blueprint.seed.toString(), dayStartMs: 0,
        infraRelease: signed.deployment.regionalSimulation.infraRelease,
        routeVersionIds: [...new Set(signed.deployment.regionalSimulation.trains.map((train) => train.routeVersionId))].sort(),
        policy,
      };
      const generated = native.dailyRestrictions(request);
      assert.deepEqual(native.dailyRestrictions(request), generated);
      assert.ok(generated.restrictions.length > 0);
      assert.ok(generated.unsupportedRestrictions.length > 0);
      assert.equal(generated.restrictions.length + generated.unsupportedRestrictions.length, 400);
      const restriction = [...generated.restrictions].sort((left, right) => left.effect["speed-restriction"].maximumSpeedMmps - right.effect["speed-restriction"].maximumSpeedMmps)[0];
      const registry = new ActiveWorldDeploymentRuntime({ activeWorlds: [], operationalProgramPreflight: (input) => native.initialize(input).validationReceipt });
      registry.prepareOperationalProgram(signed);
      registry.register(signed, new Date(MINIMAL_BUILDER_EPOCH));
      const catalog = new DailyRestrictionCommandCatalog({ base: registry, loadPolicies: async () => [policy], generate: (input) => native.dailyRestrictions(input) });
      await catalog.refresh([{
        worldId: request.worldId, regionId: request.regionId, seed: request.seed,
        infraRelease: request.infraRelease, routeVersionIds: request.routeVersionIds,
      }]);
      const firstTrain = signed.deployment.regionalSimulation.trains[0];
      const departure = firstTrain.scheduledDepartureMs;
      async function apply(state, commandId, command) {
        return native.apply(state, {
          schemaVersion: OPERATIONAL_SIMULATION_COMMAND_SCHEMA,
          worldId: MINIMAL_BUILDER_WORLD_ID, regionId: MINIMAL_BUILDER_REGION_ID,
          commandId, expectedStateHash: state.stateHash, expectedRevision: state.revision,
          expectedPublisherSequence: state.publisherSequence, command,
        });
      }
      async function run(withRestriction) {
        let result = native.initialize(signed.deployment.regionalSimulation);
        const commands = withRestriction ? catalog : registry;
        for (const command of commands.at(request.worldId, request.regionId, 0)) {
          result = await apply(result.state, command.commandId, command.command);
        }
        for (const boundary of commands.dueBoundaries(request.worldId, request.regionId, 0, departure + 30_000)) {
          result = await apply(result.state, `test:boundary:${boundary.atMs}`, { type: "advance-to", atMs: boundary.atMs });
          for (const command of boundary.commands) result = await apply(result.state, command.commandId, command.command);
        }
        result = await apply(result.state, "test:motion", { type: "advance-to", atMs: departure + 30_000 });
        return result;
      }
      const baseline = await run(false);
      const restricted = await run(true);
      const baselineTrain = baseline.liveMap.trains.find((train) => train.trainId === firstTrain.id);
      const restrictedTrain = restricted.liveMap.trains.find((train) => train.trainId === firstTrain.id);
      assert.ok(baselineTrain && restrictedTrain);
      // Die committed Segmentanker koennen identisch liegen; die native
      // Bewegungsfreigabe muss die La bereits mit geringerer Fahrt abbilden.
      assert.ok(restrictedTrain.speedMmps < baselineTrain.speedMmps);
      assert.ok(restrictedTrain.speedMmps <= restriction.effect["speed-restriction"].maximumSpeedMmps);
      assert.deepEqual(restricted.liveMap.activeDisruptions, restricted.rzue.activeDisruptions);
      assert.ok(restricted.liveMap.activeDisruptions.some((value) => value.disruptionId === restriction.disruptionId));
      assert.equal(catalog.diagnostics(request.worldId)[0].status, "partially-supported");
      assert.deepEqual(catalog.diagnostics(request.worldId)[0].unsupportedRestrictions, generated.unsupportedRestrictions);
      const restored = native.restore(restricted.state, restricted.initializationHash);
      assert.deepEqual(native.dailyRestrictions(request), generated);
      const expires = catalog.at(request.worldId, request.regionId, restriction.endsAtMs).find(({ command }) => command.type === "clear-disruption" && command.disruptionId === restriction.disruptionId);
      assert.ok(expires);
      const atExpiry = await apply(restored.state, "test:la:expiry", { type: "advance-to", atMs: restriction.endsAtMs });
      const cleared = await apply(atExpiry.state, expires.commandId, expires.command);
      assert.equal(cleared.liveMap.activeDisruptions.some((value) => value.disruptionId === restriction.disruptionId), false);
      assert.deepEqual(cleared.liveMap.activeDisruptions, cleared.rzue.activeDisruptions);
    } finally {
      if (previousRoots === undefined) delete process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
      else process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = previousRoots;
    }
  });
});
