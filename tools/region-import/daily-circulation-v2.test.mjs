import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_CIRCULATION_PLAN_SCHEMA,
  dailyMovementContinuities,
  dailyRolloverCycles,
  deriveDailyCirculationPlan,
  dailyServiceLotIdentifiers,
} from "./daily-circulation-v2.mjs";

const RELEASE_ID = "gtfs-test-release";

function chain(id, origin, destination, startS, endS, { entryPortalId = null, exitPortalId = null } = {}) {
  return {
    journeyChainId: id,
    releaseId: RELEASE_ID,
    routeId: "route-1",
    routeShortName: "R1",
    orderable: true,
    legs: [{
      kind: "playable",
      legId: `leg-${id}`,
      sequence: 0,
      qualityClass: "B",
      orderable: true,
      entryPortalId,
      exitPortalId,
      stops: [
        { stopId: origin, stopSequence: 0, arrivalS: startS, departureS: startS },
        { stopId: destination, stopSequence: 1, arrivalS: endS, departureS: endS },
      ],
    }],
  };
}

const stations = ["A", "B", "C", "D"].map((stopId, index) => ({
  stopId,
  latitudeE7: 510_000_000 + index * 10_000,
  longitudeE7: 120_000_000 + index * 10_000,
}));

test("leitet weltneutrale Loskennungen identisch und releasegebunden ab", () => {
  const first = dailyServiceLotIdentifiers({ gtfsReleaseId: RELEASE_ID, routeId: "route-1", routeShortName: "R 1" });
  const replay = dailyServiceLotIdentifiers({ gtfsReleaseId: RELEASE_ID, routeId: "route-1", routeShortName: "R 1" });
  const next = dailyServiceLotIdentifiers({ gtfsReleaseId: `${RELEASE_ID}-next`, routeId: "route-1", routeShortName: "R 1" });
  assert.deepEqual(first, replay);
  assert.match(first.lotId, /^lot-r-1-[a-f0-9]{64}$/u);
  assert.notEqual(first.lotId, next.lotId);
});

test("minimiert Cross-Location-Rollover und bildet eine vollstaendige Slot-Permutation", () => {
  const plan = deriveDailyCirculationPlan({
    journeyChains: [
      chain("chain-a-b", "A", "B", 100, 200),
      chain("chain-b-a", "B", "A", 100, 200),
      chain("chain-c-d", "C", "D", 100, 200),
    ],
    stations,
    gtfsReleaseId: RELEASE_ID,
  });
  assert.equal(plan.schema, DAILY_CIRCULATION_PLAN_SCHEMA);
  assert.deepEqual(plan.metrics, {
    lotCount: 1,
    journeyChainCount: 3,
    circulationCount: 3,
    rolloverAssignmentCount: 3,
    plannedTransitionCount: 3,
    turnaroundDemandCount: 2,
    transferDemandCount: 1,
    transferLotCount: 1,
  });
  assert.equal(new Set(plan.rolloverAssignments.map((value) => value.sourceCirculationId)).size, 3);
  assert.equal(new Set(plan.rolloverAssignments.map((value) => value.targetCirculationId)).size, 3);
  const byPassenger = new Map(plan.circulations.map((value) => [value.passengerLegIds[0], value]));
  const aToB = byPassenger.get("leg-chain-a-b");
  const bToA = byPassenger.get("leg-chain-b-a");
  assert.deepEqual(
    plan.rolloverAssignments.find((value) => value.sourceCirculationId === aToB.id),
    { sourceCirculationId: aToB.id, targetCirculationId: bToA.id, kind: "same-location" },
  );
  assert.deepEqual(
    plan.rolloverAssignments.find((value) => value.sourceCirculationId === bToA.id),
    { sourceCirculationId: bToA.id, targetCirculationId: aToB.id, kind: "same-location" },
  );
  assert.deepEqual(plan.transferDemands.map(({ sourceLocationId, targetLocationId }) => ({ sourceLocationId, targetLocationId })), [
    { sourceLocationId: "D", targetLocationId: "C" },
  ]);
  assert.equal(plan.transferDemands[0].earliestDepartureS, 500);
  assert.equal(plan.transferDemands[0].latestArrivalS, 86_200);
  assert.equal(typeof plan.planSha256, "string");
  assert.equal(plan.planSha256.length, 64);
});

test("verkettet gleichortige Folgefahrten innerhalb des Tages vor dem Rollover", () => {
  const plan = deriveDailyCirculationPlan({
    journeyChains: [
      chain("chain-a-b", "A", "B", 100, 200),
      chain("chain-b-c", "B", "C", 500, 600),
    ],
    stations,
    gtfsReleaseId: RELEASE_ID,
  });
  assert.equal(plan.metrics.circulationCount, 1);
  assert.equal(plan.metrics.plannedTransitionCount, 2);
  assert.equal(plan.metrics.turnaroundDemandCount, 1);
  assert.deepEqual(plan.circulations[0].journeyChainIds, ["chain-a-b", "chain-b-c"]);
  assert.deepEqual(plan.circulations[0].passengerTrainRunIds, ["chain-a-b", "chain-b-c"]);
  assert.equal(plan.metrics.transferDemandCount, 1);
  assert.equal(plan.transferDemands[0].sourceLocationId, "C");
  assert.equal(plan.transferDemands[0].targetLocationId, "A");
});

test("waehlt ein vollstaendig laufzeitfaehiges Rollover statt einer lokal kuerzeren Sackgasse", () => {
  const calls = [];
  const plan = deriveDailyCirculationPlan({
    journeyChains: [
      chain("chain-a-x", "A", "C", 100, 200),
      chain("chain-b-y", "B", "D", 100, 200),
    ],
    stations,
    gtfsReleaseId: RELEASE_ID,
    transferCost: ({ sourceEndpoint, targetEndpoint, earliestDepartureS, latestArrivalS }) => {
      calls.push({ source: sourceEndpoint.locationId, target: targetEndpoint.locationId, earliestDepartureS, latestArrivalS });
      if (sourceEndpoint.locationId === "C" && targetEndpoint.locationId === "A") return null;
      return sourceEndpoint.locationId === "C" && targetEndpoint.locationId === "B" ? 10 : 20;
    },
  });
  assert.equal(plan.metrics.transferDemandCount, 2);
  assert.equal(plan.metrics.plannedTransitionCount, 2);
  assert.equal(plan.metrics.turnaroundDemandCount, 0);
  assert.deepEqual(plan.transferDemands.map(({ sourceLocationId, targetLocationId }) => `${sourceLocationId}->${targetLocationId}`).sort(), ["C->B", "D->A"]);
  assert.equal(calls.every(({ earliestDepartureS, latestArrivalS }) => earliestDepartureS === 500 && latestArrivalS === 86_200), true);
});

test("bricht bei einer unzulaessigen Transfermatrix geschlossen ab", () => {
  assert.throws(() => deriveDailyCirculationPlan({
    journeyChains: [chain("chain-a-b", "A", "B", 100, 200)],
    stations,
    gtfsReleaseId: RELEASE_ID,
    transferCost: () => null,
  }), /keine zulaessige Kante|kein vollstaendiges physisch zulaessiges Matching/u);
});

test("akzeptiert die Tagesgrenze exakt auf Mindestwendezeit und verwirft eine Sekunde weniger", () => {
  const exact = deriveDailyCirculationPlan({
    journeyChains: [chain("chain-exact-boundary", "A", "A", 0, 86_100)],
    stations,
    gtfsReleaseId: RELEASE_ID,
  });
  assert.equal(exact.metrics.turnaroundDemandCount, 1);
  assert.equal(exact.metrics.transferDemandCount, 0);
  assert.deepEqual({
    earliestDepartureS: exact.turnaroundDemands[0].earliestDepartureS,
    latestArrivalS: exact.turnaroundDemands[0].latestArrivalS,
    availableWindowS: exact.turnaroundDemands[0].availableWindowS,
    dailyBoundary: exact.turnaroundDemands[0].dailyBoundary,
  }, {
    earliestDepartureS: 86_100,
    latestArrivalS: 86_400,
    availableWindowS: 300,
    dailyBoundary: true,
  });
  assert.throws(() => deriveDailyCirculationPlan({
    journeyChains: [chain("chain-short-boundary", "A", "A", 0, 86_101)],
    stations,
    gtfsReleaseId: RELEASE_ID,
  }), /keine zulaessige Kante|kein vollstaendiges physisch zulaessiges Matching/u);
});

test("leitet die Periodenfortschaltung aus Rohphasen statt aus dem Rollover-Label ab", () => {
  const journeyChains = [
    chain("chain-before-midnight", "A", "B", 85_800, 86_100),
    chain("chain-after-midnight", "B", "A", 87_000, 87_400),
  ];
  const plan = deriveDailyCirculationPlan({ journeyChains, stations, gtfsReleaseId: RELEASE_ID });
  assert.equal(plan.metrics.circulationCount, 1);
  assert.equal(plan.metrics.transferDemandCount, 0);
  assert.equal(plan.metrics.turnaroundDemandCount, 2);
  const continuities = dailyMovementContinuities({ dailyPlan: plan, journeyChains });
  assert.deepEqual(
    continuities
      .map(({ sourcePassengerTrainRunId, targetPassengerTrainRunId, relation, successorDayOffset }) => ({
        sourcePassengerTrainRunId,
        targetPassengerTrainRunId,
        relation,
        successorDayOffset,
      }))
      .sort((left, right) => left.sourcePassengerTrainRunId.localeCompare(right.sourcePassengerTrainRunId)),
    [
      {
        sourcePassengerTrainRunId: "chain-after-midnight",
        targetPassengerTrainRunId: "chain-before-midnight",
        relation: "same-location",
        successorDayOffset: 0,
      },
      {
        sourcePassengerTrainRunId: "chain-before-midnight",
        targetPassengerTrainRunId: "chain-after-midnight",
        relation: "same-location",
        successorDayOffset: 1,
      },
    ],
  );
  assert.equal(continuities.reduce((sum, continuity) => sum + continuity.successorDayOffset, 0), 1);
});

test("trennt einen unmoeglichen internen Portalwechsel und routet ihn erst am Tagesrand", () => {
  const calls = [];
  const plan = deriveDailyCirculationPlan({
    journeyChains: [
      chain("chain-a-b", "A", "B", 100, 200, { exitPortalId: "chemnitz-hbf" }),
      chain("chain-c-a", "C", "A", 1_200, 1_300, { entryPortalId: "chemnitz-hbf" }),
    ],
    stations,
    gtfsReleaseId: RELEASE_ID,
    transferCost: ({ sourceEndpoint, targetEndpoint, dailyBoundary }) => {
      calls.push({
        source: sourceEndpoint.physicalStopId,
        target: targetEndpoint.physicalStopId,
        dailyBoundary,
      });
      return 1;
    },
  });
  assert.equal(plan.metrics.circulationCount, 2);
  assert.equal(plan.metrics.plannedTransitionCount, 2);
  assert.equal(plan.metrics.turnaroundDemandCount, 1);
  assert.equal(plan.metrics.transferDemandCount, 1);
  const internal = plan.transferDemands[0];
  assert.equal(internal.dailyBoundary, true);
  assert.deepEqual({
    sourceLocationId: internal.sourceLocationId,
    targetLocationId: internal.targetLocationId,
    sourcePhysicalStopId: internal.sourcePhysicalStopId,
    targetPhysicalStopId: internal.targetPhysicalStopId,
  }, {
    sourceLocationId: "chemnitz-hbf",
    targetLocationId: "chemnitz-hbf",
    sourcePhysicalStopId: "B",
    targetPhysicalStopId: "C",
  });
  assert.equal(internal.sourcePassengerRouteVersionId, "route:gtfs:leg-chain-a-b:v1");
  assert.equal(internal.targetPassengerRouteVersionId, "route:gtfs:leg-chain-c-a:v1");
  assert.equal(calls.some((call) => call.source === "B" && call.target === "C" && call.dailyBoundary === true), true);
  assert.equal(dailyMovementContinuities({ dailyPlan: plan, journeyChains: [
    chain("chain-a-b", "A", "B", 100, 200, { exitPortalId: "chemnitz-hbf" }),
    chain("chain-c-a", "C", "A", 1_200, 1_300, { entryPortalId: "chemnitz-hbf" }),
  ] }).some((continuity) => continuity.sourcePassengerLegId === "leg-chain-a-b" && continuity.relation === "transfer"), true);
});

test("belegt Rollover-Permutationszyklen getrennt von den taeglichen Slot-Pfaden", () => {
  const journeyChains = [
    chain("chain-a-b", "A", "B", 100, 200),
    chain("chain-b-a", "B", "A", 100, 200),
    chain("chain-c-d", "C", "D", 100, 200),
  ];
  const plan = deriveDailyCirculationPlan({ journeyChains, stations, gtfsReleaseId: RELEASE_ID });
  const cycles = dailyRolloverCycles(plan);
  assert.equal(cycles.flat().length, plan.metrics.circulationCount);
  assert.equal(new Set(cycles.flat()).size, plan.metrics.circulationCount);
  assert.deepEqual(cycles.map((cycle) => cycle.length).sort((left, right) => left - right), [1, 2]);
  assert.equal(dailyMovementContinuities({ dailyPlan: plan, journeyChains }).length, plan.metrics.journeyChainCount);
});
