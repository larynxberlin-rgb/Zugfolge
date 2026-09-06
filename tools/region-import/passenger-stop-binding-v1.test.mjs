import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { alphaCanonicalJson, alphaHash } from "../../packages/alpha/dist/index.js";
import { bindMovementPassengerStopPlansV1 } from "./movement-route-allocation-v2.mjs";
import { bindPassengerStopPlan, streamPassengerStopInfrastructure, validatePassengerStopAnchors } from "./passenger-stop-binding-v1.mjs";

function fixture(direction = "along") {
  const against = direction === "against";
  const positions = [0, 230_000, 800_000];
  const offsets = against ? [800_000, 570_000, 0] : [100_000, 330_000, 900_000];
  const anchors = positions.map((routeMm, index) => ({stationId: ["A", "B", "C"][index], stopSequence: index + 4,
    edgeId: "edge", direction, offsetMm: offsets[index], routeMm, sourceEdgeId: "edge", sourceOffsetMm: offsets[index]}));
  const timetableRoute = {routeVersionId: "base", legs: [{edgeId: "edge", direction, edgeEntryMm: offsets[0], edgeExitMm: offsets[2]}], passengerStopAnchors: anchors};
  const actualRoute = {id: "dispatch", legs: [{edgeId: "edge", direction, edgeEntryMm: against ? 900_000 : 0,
    edgeExitMm: offsets[2], routeStartMm: 0}]};
  const platforms = new Map(offsets.map((offset, index) => [`platform-${index}`, {edgeId: "edge", direction,
    fromMm: against ? offset : offset - 100_000, toMm: against ? offset + 100_000 : offset}]));
  const passenger = {trainRunId: "train", formationVersionId: "formation", formationLengthMm: 100_000,
    serviceOutcome: {serviceId: "train", serviceRunId: "train:service-day:2026-09-06"}};
  const materialization = {id: "train", routeVersionId: "dispatch", formationVersionId: "formation", headRouteMm: 100_000,
    scheduledDepartureMs: 86_460_000, publicPassengerStop: true};
  const timetableStops = [
    {stopId: "A", stopSequence: 4, arrivalS: 86_400, departureS: 86_460},
    {stopId: "B", stopSequence: 5, arrivalS: 86_700, departureS: 86_760},
    {stopId: "C", stopSequence: 6, arrivalS: 87_000, departureS: 87_000},
  ];
  return {passenger, materialization, timetableRoute, timetableStops,
    infrastructure: {routes: new Map([["dispatch", actualRoute]]), platforms},
    worldId: "world", infrastructureReleaseId: "infra", timetableReleaseId: "timetable",
    sourcePins: {gtfsSnapshotSha256: "a".repeat(64), timetableRoutesSha256: "b".repeat(64),
      infrastructureStateHash: "c".repeat(64), movementRouteStateHash: "d".repeat(64)}};
}

test("bindet drei gerichtete Halte exakt und rechnet Weltzeiten einmal um, auch gegen die Kantenrichtung", () => {
  for (const direction of ["along", "against"]) {
    const input = fixture(direction), plan = bindPassengerStopPlan(input);
    assert.deepEqual(plan.stops.map((stop) => [stop.stopId, stop.stationId, stop.stopSequence, stop.routeMm, stop.platformId]), [
      ["train:0", "A", 0, 100_000, "platform-0"], ["train:1", "B", 1, 330_000, "platform-1"], ["train:2", "C", 2, 900_000, "platform-2"],
    ]);
    assert.deepEqual(plan.stops.map((stop) => [stop.scheduledArrivalMs, stop.scheduledDepartureMs, stop.minimumDwellMs]),
      [[86_400_000, 86_460_000, 60_000], [86_700_000, 86_760_000, 60_000], [87_000_000, 87_000_000, 0]]);
    assert.equal(plan.routeVersionId, "dispatch"); assert.match(plan.sourceBindingHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(bindPassengerStopPlan(input), plan);
  }
});

test("fehlende, mehrdeutige, zu kurze oder falsche gerichtete Plattformen erfinden keinen Haltplan", () => {
  for (const change of [
    (input) => input.infrastructure.platforms.delete("platform-1"),
    (input) => input.infrastructure.platforms.set("duplicate", {...input.infrastructure.platforms.get("platform-1")}),
    (input) => input.infrastructure.platforms.get("platform-1").fromMm++,
    (input) => { input.infrastructure.platforms.get("platform-1").direction = "against"; },
    (input) => { input.materialization.headRouteMm++; },
    (input) => { input.infrastructure.routes.get("dispatch").legs[0].edgeExitMm++; },
  ]) {
    const input = fixture(); change(input); assert.equal(bindPassengerStopPlan(input), undefined);
  }
  const legacy = fixture(); delete legacy.timetableRoute.passengerStopAnchors;
  assert.equal(bindPassengerStopPlan(legacy), undefined);
});

test("verwirft manipulierte Anker, Vorkommen, Zeiten und Pins vor einer Materialisierung", () => {
  for (const change of [
    (input) => { input.timetableRoute.passengerStopAnchors[1].routeMm++; },
    (input) => { input.timetableRoute.passengerStopAnchors[1].offsetMm++; },
    (input) => { input.timetableStops[1].stopSequence++; },
    (input) => { input.timetableStops[1].stopId = "wrong"; },
    (input) => { input.timetableStops[1].arrivalS = Number.MAX_SAFE_INTEGER; },
    (input) => { input.sourcePins.infrastructureStateHash = "invalid"; },
    (input) => { input.materialization.formationVersionId = "foreign"; },
  ]) {
    const input = fixture(); change(input); assert.throws(() => bindPassengerStopPlan(input), /Halt|Fahrgast/u);
  }
});

test("gleiche Stationspositionen bleiben getrennt belegt, ergeben aber keinen stillschweigend zusammengefassten Plan", () => {
  const input = fixture(); input.timetableRoute.passengerStopAnchors[1] = {...input.timetableRoute.passengerStopAnchors[0], stopSequence: 5};
  input.timetableStops[1].stopId = "A";
  assert.equal(validatePassengerStopAnchors(input.timetableRoute).length, 3);
  assert.equal(bindPassengerStopPlan(input), undefined);
});

test("Quellen-, Formations- und Haltplanfakten sind Bestandteil der signierten Initialisierung", () => {
  const input = fixture(), plan = bindPassengerStopPlan(input);
  const initialization = {worldId: "world", trains: [{...input.materialization, stopPlan: plan}]};
  const initialHash = alphaHash("zugfolge-operational-simulation-initialization/v2", initialization);
  const changed = structuredClone(initialization); changed.trains[0].stopPlan.stops[1].scheduledDepartureMs++;
  assert.notEqual(alphaHash("zugfolge-operational-simulation-initialization/v2", changed), initialHash);
  const changedSource = fixture(); changedSource.sourcePins.timetableRoutesSha256 = "e".repeat(64);
  assert.notEqual(bindPassengerStopPlan(changedSource).sourceBindingHash, plan.sourceBindingHash);
  const changedPlatform = fixture(); changedPlatform.infrastructure.platforms.get("platform-1").fromMm--;
  assert.notEqual(bindPassengerStopPlan(changedPlatform).sourceBindingHash, plan.sourceBindingHash);
});

test("bindet nur qualifizierte Personenfahrten nach dem Movement-Allocator und bewahrt Legacy-/Rangierfahrten", () => {
  const input = fixture();
  const movement = {id: "shunt", publicPassengerStop: false};
  const allocation = {schema: "zugfolge-movement-route-allocation/v2", programTrains: [input.materialization, movement], movementContinuations: [{id: "continuation"}]};
  const bind = (entry) => bindPassengerStopPlan({...input, ...entry});
  const result = bindMovementPassengerStopPlansV1(allocation, [input.passenger], bind);
  assert.equal(result.programTrains[0].stopPlan.stops.length, 3);
  assert.equal(result.programTrains[1], movement); assert.equal(result.movementContinuations, allocation.movementContinuations);
  assert.equal(allocation.programTrains[0].stopPlan, undefined);
  assert.equal(bindMovementPassengerStopPlansV1(allocation, [input.passenger], () => undefined).programTrains[0], input.materialization);
  assert.throws(() => bindMovementPassengerStopPlansV1(allocation, [input.passenger], () => ({trainRunId: "train", routeVersionId: "base"})), /nicht zugewiesene/u);
});

test("extrahiert nur ausgewählte Routen und Bahnsteige über Chunkgrenzen unter exaktem signierten Datei-Pin", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-passenger-stops-"));
  try {
    const input = fixture(), file = join(directory, "operational.json");
    const artifact = {id: "infra", ignored: "ü\\\"".repeat(50_000),
      routeVersions: {dispatch: input.infrastructure.routes.get("dispatch"), irrelevant: {id: "irrelevant", legs: []}},
      platformIntervals: {...Object.fromEntries(input.infrastructure.platforms), unrelated: {edgeId: "other", fromMm: 0, toMm: 1, direction: "along"}}};
    const bytes = Buffer.from(alphaCanonicalJson(artifact)); await writeFile(file, bytes);
    const proof = {infraReleaseId: "infra", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
    const actual = await streamPassengerStopInfrastructure(file, proof, new Set(["dispatch"]), new Set(["edge"]));
    assert.deepEqual([...actual.routes.keys()], ["dispatch"]); assert.equal(actual.platforms.size, 3);
    assert.deepEqual(bindPassengerStopPlan({...input, infrastructure: actual}), bindPassengerStopPlan(input));
    await assert.rejects(streamPassengerStopInfrastructure(file, {...proof, sha256: "f".repeat(64)}, new Set(["dispatch"]), new Set(["edge"])), /Hashpin/u);
    await assert.rejects(streamPassengerStopInfrastructure(file, {...proof, infraReleaseId: "foreign"}, new Set(["dispatch"]), new Set(["edge"])), /Release/u);
    await assert.rejects(streamPassengerStopInfrastructure(file, proof, new Set(["missing"]), new Set(["edge"])), /fehlende native Dispatchroute/u);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
