/** Fiktive Abnahmefahrt durch echte M5-, Operational-, M10- und Sitzungskerne. */
import { loadDialogueReleaseForWorld } from "@zugfolge/conductor-dialogue";
import { LivemapRegistry, type LivemapReadModel } from "@zugfolge/livemap-stream";
import { conductorSessionRuntimeFromAddon, demandRuntimeFromAddon, loadConductorSessionRuntime, loadDemandRuntime,
  loadOperationalSimulationRuntime, operationalSimulationRuntimeFromAddon, OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV,
  OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY, OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
  type ConductorSessionPolicyV1, type OperationalSimulationCommandPayload, type OperationalSimulationInitialization,
  type OperationalTrainInitialization } from "@zugfolge/runtime-native";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInteriorNativeFixture, callInteriorFixtureRust, interiorFixtureDeployment, interiorFixtureGeometry,
  INTERIOR_FIXTURE_WORLD as WORLD, INTERIOR_FIXTURE_OPERATOR as OPERATOR, INTERIOR_FIXTURE_PERIOD as PERIOD,
  INTERIOR_FIXTURE_SUBJECT as SUBJECT } from "./conductor-interior.native-fixture.js";
import { ConductorSessionService, type ConductorControlIntegration } from "./conductor-session-service.js";
import { DemandService } from "./demand-service.js";
import { demandHash } from "./demand-store.js";
import { RegionalSimulationWorker } from "./regional-simulation-worker.js";
import { conductorSceneNativeFixture } from "./conductor-scene.native-fixture.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const suffix = process.platform === "win32" ? ".exe" : "";
const binary = (name: string, variable: string) => process.env[variable] ?? resolve(ROOT, `target/debug/examples/${name}${suffix}`);
export const sessionFixtureBinary = binary("session_fixture", "ZUGFOLGE_SESSION_FIXTURE_BINARY");
export const hasSessionNativeFixture = existsSync(sessionFixtureBinary);
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function sessionFixtureRuntimes() {
  const addonPath = process.env["ZUGFOLGE_RUNTIME_NATIVE_PATH"];
  if (addonPath !== undefined) return { operational: loadOperationalSimulationRuntime(), demand: loadDemandRuntime(),
    session: loadConductorSessionRuntime(), validator: createRequire(import.meta.url)(addonPath) as { validateConductorDialogueRelease(input: string): string } };
  const operational = (method: string, ...args: string[]) => callInteriorFixtureRust(binary("operational_json", "ZUGFOLGE_OPERATIONAL_TEST_BINARY"), [], { method, args }).trim();
  const session = (method: string, json: string) => callInteriorFixtureRust(binary("session_json", "ZUGFOLGE_SESSION_TEST_BINARY"), [method], JSON.parse(json)).trim();
  return { operational: operationalSimulationRuntimeFromAddon({
    hashFareControlPolicy: (json) => operational("fare-control-policy-hash", json),
    initializeOperationalSimulation: (...args) => operational("initialize", ...args), restoreOperationalSimulation: (...args) => operational("restore", ...args),
    applyOperationalSimulationCommand: (...args) => operational("apply", ...args), applyOperationalSimulationCommandBatch: (...args) => operational("batch", ...args),
    hashOperationalSimulationCommand: (...args) => operational("hash", ...args),
  }), demand: demandRuntimeFromAddon({ evaluatePassengerDemand: (json) => callInteriorFixtureRust(binary("evaluate_json", "ZUGFOLGE_DEMAND_TEST_BINARY"), [], JSON.parse(json)) }),
  session: conductorSessionRuntimeFromAddon({
    initializeConductorSessionState: (json) => session("initialize", json), applyConductorSessionCommand: (json) => session("apply", json),
    synchronizeConductorSession: (json) => session("synchronize", json), restoreConductorSessionState: (json) => session("restore", json),
    projectConductorSessionSnapshot: (json) => session("project", json), replayConductorSession: (json) => session("replay", json),
    hashConductorOperationalWorld: (json) => session("operational-hash", json), hashConductorSessionPolicy: (json) => session("policy-hash", json),
  }), validator: { validateConductorDialogueRelease: (json: string) => callInteriorFixtureRust(binary("dialogue_json", "ZUGFOLGE_DIALOGUE_TEST_BINARY"), ["validate"], JSON.parse(json)) } };
}

export async function createConductorSessionNativeFixture(control: ConductorControlIntegration, options: { sceneEpochUtcTimeOfDayMs?: number } = {}) {
  const base = await createInteriorNativeFixture({ longTrip: true });
  const oldRoots = process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV];
  try {
    const fixture = JSON.parse(callInteriorFixtureRust(sessionFixtureBinary, [], {}));
    if (fixture.testOnly !== true) throw new Error("Nur explizite Testdaten sind hier erlaubt.");
    const infra = fixture.infrastructure;
    const bindingModule = await import(new URL("../../../tools/region-import/operational-infrastructure-binding.mjs", import.meta.url).href);
    const stopModule = await import(new URL("../../../tools/region-import/passenger-stop-binding-v1.mjs", import.meta.url).href);
    const infraJson = `${bindingModule.canonicalOperationalInfrastructureV2Json(infra)}\n`;
    writeFileSync(join(base.directory, "operational-infrastructure-v2.json"), infraJson);
    const infraBinding = { schemaVersion: "zugfolge-operational-infrastructure-binding/v2" as const,
      infraReleaseId: infra.id as string, file: "operational-infrastructure-v2.json" as const,
      bytes: Buffer.byteLength(infraJson), sha256: sha(infraJson), stateHash: bindingModule.operationalInfrastructureV2StateHash(infra) as string };
    process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = JSON.stringify({ [infra.id]: base.directory });
    const native = sessionFixtureRuntimes(), inventory = JSON.parse(readFileSync(join(base.compiled.output, "operational-vehicle-inventory-v2.json"), "utf8"));
    const route = infra.routeVersions[fixture.materialization.routeVersionId];
    const seed = fixture.materialization;
    const formation = inventory.formations.find((row: { vehicleIds: string[] }) => row.vehicleIds.length === 1 && row.vehicleIds[0] === "fixture-interior-vehicle-1");
    const train = { ...seed, stopPlan: undefined, operatorId: OPERATOR, formationVersionId: formation.id,
      dispatchInterlockingRouteId: "interlocking:train", protectionModeSelectionRuns: [{ throughRouteLegIndex: route.legs.length - 1, selectedProtectionSystem: "pzb" }] };
    const anchors = seed.stopPlan.stops.map((stop: { stationId: string; stopSequence: number; routeMm: number }) => {
      const leg = route.legs.find((leg: { routeStartMm: number; edgeEntryMm: number; edgeExitMm: number }) => leg.routeStartMm <= stop.routeMm
        && stop.routeMm <= leg.routeStartMm + Math.abs(leg.edgeExitMm - leg.edgeEntryMm));
      const offset = leg.edgeEntryMm + (leg.direction === "along" ? 1 : -1) * (stop.routeMm - leg.routeStartMm);
      return { stationId: stop.stationId, stopSequence: stop.stopSequence, edgeId: leg.edgeId, direction: leg.direction,
        offsetMm: offset, routeMm: stop.routeMm - train.headRouteMm, sourceEdgeId: leg.edgeId, sourceOffsetMm: offset };
    });
    train.stopPlan = stopModule.bindPassengerStopPlan({ passenger: { trainRunId: train.id, formationVersionId: train.formationVersionId,
      formationLengthMm: 70_000, serviceOutcome: { serviceId: train.id, serviceRunId: `${train.id}:day:0` } }, materialization: train,
      timetableRoute: { routeVersionId: "base:conductor-fixture", legs: route.legs.slice(1), passengerStopAnchors: anchors },
      timetableStops: seed.stopPlan.stops.map((stop: { stationId: string; stopSequence: number; scheduledArrivalMs: number; scheduledDepartureMs: number }) => ({
        stopId: stop.stationId, stopSequence: stop.stopSequence, arrivalS: stop.scheduledArrivalMs / 1000, departureS: stop.scheduledDepartureMs / 1000 })),
      infrastructure: { routes: new Map(Object.entries(infra.routeVersions)), platforms: new Map(Object.entries(infra.platformIntervals)) },
      worldId: WORLD, infrastructureReleaseId: infra.id, timetableReleaseId: "explicit-conductor-integration-fixture",
      sourcePins: { gtfsSnapshotSha256: sha(JSON.stringify(seed.stopPlan.stops)), timetableRoutesSha256: sha(JSON.stringify(anchors)),
        infrastructureStateHash: infraBinding.stateHash, movementRouteStateHash: infraBinding.stateHash } });
    if (train.stopPlan === null || train.stopPlan === undefined) throw new Error("Echter Haltebinder konnte die fiktive Fahrt nicht binden.");
    const initialization: OperationalSimulationInitialization = { schemaVersion: OPERATIONAL_SIMULATION_INITIALIZE_SCHEMA,
      worldId: WORLD, regionId: "conductor-native-fixture", nowMs: base.clock.nowMs, repeatEveryMs: null,
      protectionModeSelectionPolicy: OPERATIONAL_PROTECTION_MODE_SELECTION_POLICY, infraRelease: infraBinding,
      vehicleTypes: inventory.vehicleTypes, vehicles: inventory.vehicles,
      formations: inventory.formations.map((row: { id: string; vehicleIds: string[] }) => ({ id: row.id, predecessorId: null, vehicleIds: row.vehicleIds })),
      trains: [train as OperationalTrainInitialization], movementContinuations: [] };
    const signed = await interiorFixtureDeployment(base.directory, interiorFixtureGeometry(base.compiled.authority), 86_400_000);
    const input = fixture.demand;
    delete input.previousEvaluation; delete input.operationalProgress;
    input.nowMs = base.clock.nowMs; input.revision = 1; input.periodId = PERIOD;
    const service = input.services[0]; service.operatorId = OPERATOR;
    service.stops = train.stopPlan.stops.map((stop: { stopId: string; stationId: string; scheduledArrivalMs: number; scheduledDepartureMs: number }) => ({ stopId: stop.stopId,
      stationId: stop.stationId, arrivalMs: stop.scheduledArrivalMs, departureMs: stop.scheduledDepartureMs, passengerStop: true }));
    const livemap = new LivemapRegistry(), worker = new RegionalSimulationWorker(base.db, native.operational, livemap);
    const initialized = await worker.initialize(initialization, new Date(base.clock.nowMs));
    const readModel = { async getConfig() { return { infrastructureReleaseId: infra.id }; },
      async getScheduledCall(worldId: string, stationId: string, trainId: string, timeS: number, kind: string) {
        return worldId === WORLD && trainId === train.id && service.stops.some((stop: Record<string, unknown>) => stop["stationId"] === stationId
          && stop[kind === "arrival" ? "arrivalMs" : "departureMs"] === timeS * 1000) ? { trainId } : undefined;
      } } as unknown as LivemapReadModel;
    const demand = new DemandService({ db: base.db, runtime: native.demand, deployment: { schemaVersion: "zugfolge-demand-deployment/v1",
      worldId: WORLD, infrastructureReleaseId: infra.id, windows: [input] }, deploymentHash: demandHash(input), readModel, livemap,
      infrastructure: [], operationalRegions: () => worker.readyRegions() });
    const apply = async (id: string, command: OperationalSimulationCommandPayload) => worker.apply({ worldId: WORLD, regionId: initialization.regionId, commandId: id, command }, new Date(base.clock.nowMs));
    const refresh = () => demand.prepareOperationalCycle(new Date(base.clock.nowMs));
    await refresh();
    await apply("conductor:materialize", { type: "materialize", train: train as OperationalTrainInitialization });
    await apply("conductor:dispatch", { type: "dispatch", requests: [{ trainId: train.id, interlockingRouteId: train.dispatchInterlockingRouteId,
      committedRank: 0, timetableDeviationMs: 0, passengerImpact: 0, contractualImpact: 0, networkImpact: 0, resourceConsequence: 0, recoveryRank: 0, waitingSinceMs: base.clock.nowMs }] });
    base.clock.nowMs = train.scheduledDepartureMs + 1;
    await apply("conductor:origin-departure", { type: "advance-to", atMs: base.clock.nowMs }); await refresh();
    const releaseBytes = readFileSync(resolve(ROOT, "assets/conductor-dialogue/v1/release.json"));
    const editorialReviewBytes = readFileSync(resolve(ROOT, "assets/conductor-dialogue/v1/editorial-review.json"));
    const release = JSON.parse(releaseBytes.toString("utf8")), keys = generateKeyPairSync("ed25519"), keyId = "temporary-session-test-only";
    const hash = sha(releaseBytes), loadedDialogue = loadDialogueReleaseForWorld({ worldId: WORLD, releaseBytes, editorialReviewBytes,
      expectedPin: { schemaVersion: "conductor-dialogue-world-pin/v1", worldId: WORLD, releaseId: release.releaseId, releaseSha256: hash,
        editorialReviewSha256: sha(editorialReviewBytes), signingKeyId: keyId }, signature: { algorithm: "ed25519", keyId, signedHash: hash,
        valueBase64: sign(null, Buffer.from(hash, "utf8"), keys.privateKey).toString("base64") },
      trustedKeys: new Map([[keyId, keys.publicKey.export({ type: "spki", format: "pem" }).toString()]]), validator: native.validator });
    const policy: ConductorSessionPolicyV1 = { ...fixture.source.sessionPolicy, worldId: WORLD, periodId: PERIOD };
    const pinnedPolicy = { ...policy, contentHash: native.session.policyHash(policy) };
    const artPin = signed.document.periods[0]!.artPin;
    const scenes = await conductorSceneNativeFixture({ directory: base.directory, worldId: WORLD, periodId: PERIOD,
      regionId: initialization.regionId, infrastructure: infra, infrastructureStateHash: infraBinding.stateHash,
      routeVersionId: train.routeVersionId, stops: train.stopPlan.stops, artReleaseId: artPin.releaseId,
      artManifestHash: artPin.manifestSha256, epochUtcTimeOfDayMs: options.sceneEpochUtcTimeOfDayMs });
    const dependencies = { db: base.db, fleetRuntime: base.runtimes.fleet, demandRuntime: native.demand, operationalRuntime: native.operational,
      interiorRuntime: base.runtimes.interior, interiorDeployment: signed.deployment, regionBindings: () => [{ regionId: initialization.regionId, initializationHash: initialized.initializationHash }],
      sessionRuntime: native.session, sessionReleases: { resolve(worldId: string, periodId: string) { return worldId === WORLD && periodId === PERIOD
        ? { policy: pinnedPolicy, currentDialogueReleaseHash: loadedDialogue.report(WORLD).releaseHash,
          dialogueReleases: [JSON.parse(loadedDialogue.releaseJson(WORLD)) as Readonly<Record<string, unknown>>] } : undefined; } }, control, scenes };
    const sessions = new ConductorSessionService(dependencies);
    return { ...base, signed, native, initialization, worker, demand, dependencies, sessions, apply, refresh,
      access: { worldId: WORLD, operatorId: OPERATOR, trainRunId: train.id as string, keycloakSubject: SUBJECT },
      async dispose() { await base.client.close(); if (oldRoots === undefined) delete process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV]; else process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = oldRoots; } };
  } catch (error) {
    await base.client.close(); if (oldRoots === undefined) delete process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV]; else process.env[OPERATIONAL_INFRASTRUCTURE_ROOTS_ENV] = oldRoots;
    throw error;
  }
}
