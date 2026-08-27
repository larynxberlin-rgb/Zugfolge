import assert from "node:assert/strict";
import test from "node:test";

import {
  allocateMovementRoutePlanV2,
  MOVEMENT_PASSENGER_DWELL_MS,
} from "./movement-route-allocation-v2.mjs";

const REPEAT_MS = 86_400_000;
const LENGTH_MM = 69_860;

function dispatch(id, predecessorBaseRouteVersionId, continuity, resourceIds = [`resource:${id}`], minimumRuntimeMs = 60_000) {
  return {
    routeVersionId: `route:${id}`,
    predecessorBaseRouteVersionId,
    dispatchInterlockingRouteId: `interlocking:${id}`,
    headRouteMm: LENGTH_MM,
    minimumRuntimeMs,
    resourceIds,
    routeLegCount: 1,
    protectionContractRuns: [{
      throughRouteLegIndex: 0,
      availableProtectionSystems: ["pzb"],
      simultaneouslyRequiredProtectionSystems: [],
    }],
    continuity,
  };
}

function direct(id, inbound, outbound, continuity = "reverse-direction") {
  const through = continuity === "same-direction"
    ? dispatch(`${id}:through`, inbound, "same-direction")
    : null;
  return {
    id,
    inboundRouteVersionId: inbound,
    outboundRouteVersionId: outbound,
    formationLengthMm: LENGTH_MM,
    terminalIntervals: [{ edgeId: `terminal:${inbound}`, fromMm: 0, toMm: LENGTH_MM }],
    movementKind: "train",
    continuity,
    maximumDwellMs: 1_200_000,
    resourceIds: [`resource:${id}:terminal`],
    resourceSetSha256: "unused-by-prevalidated-plan",
    through,
    outbound: dispatch(
      `${id}:outbound`,
      through?.routeVersionId ?? inbound,
      continuity === "same-direction" ? "same-direction" : "reverse-direction",
    ),
  };
}

function stabling(id, inbound, outbound, candidateRank, berthEdge, resourceSuffix = id) {
  const shuntIn = dispatch(`${id}:shunt-in`, inbound, "same-direction", [`resource:${resourceSuffix}:shunt-in`]);
  const shuntOut = dispatch(`${id}:shunt-out`, shuntIn.routeVersionId, "reverse-direction", [`resource:${resourceSuffix}:shunt-out`]);
  return {
    id,
    inboundRouteVersionId: inbound,
    outboundRouteVersionId: outbound,
    terminalEdgeId: `terminal:${inbound}`,
    terminalNodeId: 1,
    inboundDirection: "along",
    outboundDirection: "against",
    formationLengthMm: LENGTH_MM,
    candidateRank,
    stablingPathLengthMm: 200_000,
    terminalIntervals: [{ edgeId: `terminal:${inbound}`, fromMm: 0, toMm: LENGTH_MM }],
    shuntIn,
    berth: {
      edgeId: berthEdge,
      fromMm: 10_000,
      toMm: 10_000 + LENGTH_MM,
      leftClearanceMm: 10_000,
      rightClearanceMm: 10_000,
    },
    shuntOut,
    outbound: dispatch(`${id}:outbound`, shuntOut.routeVersionId, "same-direction"),
  };
}

function passenger(id, baseRoute, scheduledDepartureMs, formationVersionId = "formation:1") {
  return {
    trainRunId: id,
    trainNumber: id === "p1" ? "S 51001" : id === "p2" ? "S 51002" : `S ${51_100 + Number(id.replace(/\D/gu, ""))}`,
    operator: "public",
    baseRouteVersionId: baseRoute,
    routeVersionId: baseRoute,
    formationVersionId,
    formationLengthMm: LENGTH_MM,
    installedProtection: ["pzb"],
    scheduledDepartureMs,
  };
}

function protectionSelection({ routeLegCount }) {
  return [{ throughRouteLegIndex: routeLegCount - 1, selectedProtectionSystem: "pzb" }];
}

function dailyPlan(circulations, rolloverAssignments) {
  return { circulations, rolloverAssignments };
}

test("materialisiert Direct-Through und lange Abstellung als atomaren vollstaendigen Tagesgraphen", () => {
  const passengers = [passenger("p1", "base:p1", 0), passenger("p2", "base:p2", 1_200_000)];
  const continuities = [{
    id: "continuity:internal",
    sourcePassengerTrainRunId: "p1",
    targetPassengerTrainRunId: "p2",
    sourceDepartureS: 0,
    sourceArrivalS: 600,
    targetDepartureS: 1_200,
    sourcePhase: 0,
    successorDayOffset: 0,
    relation: "same-location",
    transferDemandId: null,
  }, {
    id: "continuity:rollover",
    sourcePassengerTrainRunId: "p2",
    targetPassengerTrainRunId: "p1",
    sourceDepartureS: 1_200,
    sourceArrivalS: 1_800,
    targetDepartureS: 86_400,
    sourcePhase: 0,
    successorDayOffset: 1,
    relation: "same-location",
    transferDemandId: null,
  }];
  const result = allocateMovementRoutePlanV2({
    dailyPlan: dailyPlan(
      [{ id: "c1", passengerTrainRunIds: ["p1", "p2"] }],
      [{ sourceCirculationId: "c1", targetCirculationId: "c1" }],
    ),
    continuities,
    passengerTrains: passengers,
    movementRoutePlan: {
      directTemplates: [
        direct("direct:p1-p2", "base:p1", "base:p2", "same-direction"),
        direct("direct:p2-p1", "base:p2", "base:p1"),
      ],
      templates: [stabling("stabling:p2-p1", "base:p2", "base:p1", 0, "berth:1")],
      transferTemplates: [],
    },
    repeatEveryMs: REPEAT_MS,
    selectProtectionModeRuns: protectionSelection,
  });

  assert.deepEqual(result.metrics, {
    passengerTrainCount: 2,
    movementTrainCount: 3,
    directCount: 0,
    throughCount: 1,
    stablingCount: 1,
    transferCount: 0,
    dailyBoundaryCount: 1,
    reservationCount: result.reservations.length,
  });
  assert.equal(result.programTrains.length, 5);
  assert.equal(result.movementContinuations.length, 5);
  assert.equal(result.movementContinuations.filter((edge) => edge.dailyBoundary).length, 1);
  const throughTrain = result.programTrains.find((train) => train.routeVersionId === "route:direct:p1-p2:through");
  assert.equal(throughTrain.publicPassengerStop, false);
  assert.equal(throughTrain.scheduledDepartureMs, 1_140_000);
  const intoThrough = result.movementContinuations.find((edge) => edge.successorTrainId === throughTrain.id);
  assert.equal(intoThrough.minimumDwellMs, MOVEMENT_PASSENGER_DWELL_MS);
  assert.equal(intoThrough.continuity, "same-direction");
  const passengerTwo = result.programTrains.find((train) => train.id === "p2");
  assert.equal(passengerTwo.routeVersionId, "route:direct:p1-p2:outbound");
  assert.equal(passengerTwo.headRouteMm, LENGTH_MM);
  assert.ok(result.programTrains.filter((train) => !train.publicPassengerStop).every((train) => /^(?:Lt|Rf) [0-9]{1,5}$/u.test(train.trainNumber)));
});

function overlappingStablingFixture(includeSecondBerth) {
  const passengers = [passenger("p1", "base:p1", 0, "formation:1"), passenger("p2", "base:p2", 0, "formation:2")];
  const continuities = [{
    id: "continuity:p1-p2",
    sourcePassengerTrainRunId: "p1",
    targetPassengerTrainRunId: "p2",
    sourceDepartureS: 0,
    sourceArrivalS: 3_600,
    targetDepartureS: 86_400,
    sourcePhase: 0,
    successorDayOffset: 1,
    relation: "same-location",
    transferDemandId: null,
  }, {
    id: "continuity:p2-p1",
    sourcePassengerTrainRunId: "p2",
    targetPassengerTrainRunId: "p1",
    sourceDepartureS: 0,
    sourceArrivalS: 3_600,
    targetDepartureS: 86_400,
    sourcePhase: 0,
    successorDayOffset: 1,
    relation: "same-location",
    transferDemandId: null,
  }];
  const templates = [
    stabling("stabling:p1-p2:0", "base:p1", "base:p2", 0, "berth:shared", "p1:0"),
    stabling("stabling:p2-p1:0", "base:p2", "base:p1", 0, "berth:shared", "p2:0"),
  ];
  if (includeSecondBerth) templates.push(
    stabling("stabling:p1-p2:1", "base:p1", "base:p2", 1, "berth:second", "p1:1"),
    stabling("stabling:p2-p1:1", "base:p2", "base:p1", 1, "berth:second", "p2:1"),
  );
  return {
    dailyPlan: dailyPlan(
      [{ id: "c1", passengerTrainRunIds: ["p1"] }, { id: "c2", passengerTrainRunIds: ["p2"] }],
      [{ sourceCirculationId: "c1", targetCirculationId: "c2" }, { sourceCirculationId: "c2", targetCirculationId: "c1" }],
    ),
    continuities,
    passengerTrains: passengers,
    movementRoutePlan: {
      directTemplates: [direct("direct:p1-p2", "base:p1", "base:p2"), direct("direct:p2-p1", "base:p2", "base:p1")],
      templates,
      transferTemplates: [],
    },
    repeatEveryMs: REPEAT_MS,
    selectProtectionModeRuns: protectionSelection,
  };
}

test("weist zwei ueberlappende Wenden getrennten Berths zu", () => {
  const result = allocateMovementRoutePlanV2(overlappingStablingFixture(true));
  assert.equal(result.metrics.stablingCount, 2);
  assert.deepEqual(
    [...new Set(result.reservations.filter((reservation) => reservation.stage === "berth").map((reservation) => reservation.edgeId))].sort(),
    ["berth:second", "berth:shared"],
  );
});

test("bricht bei periodischer Abstellunterdeckung fail-closed ab", () => {
  assert.throws(
    () => allocateMovementRoutePlanV2(overlappingStablingFixture(false)),
    /kollidiert ohne alternativen Direct-\/Abstellpfad|nicht konfliktfrei/u,
  );
});

test("plant einen gebundenen Transfer spaetestmoeglich und legt dailyBoundary nur auf die Zielkante", () => {
  const passengers = [passenger("p1", "base:p1", 0, "formation:1"), passenger("p2", "base:p2", 7_200_000, "formation:2")];
  const transferDispatch = dispatch("transfer:d1", "base:p1", "same-direction", ["resource:transfer"], 600_000);
  const result = allocateMovementRoutePlanV2({
    dailyPlan: dailyPlan(
      [{ id: "c1", passengerTrainRunIds: ["p1"] }, { id: "c2", passengerTrainRunIds: ["p2"] }],
      [{ sourceCirculationId: "c1", targetCirculationId: "c2" }, { sourceCirculationId: "c2", targetCirculationId: "c1" }],
    ),
    continuities: [{
      id: "continuity:transfer",
      sourcePassengerTrainRunId: "p1",
      targetPassengerTrainRunId: "p2",
      sourceDepartureS: 0,
      sourceArrivalS: 3_600,
      targetDepartureS: 93_600,
      sourcePhase: 0,
      successorDayOffset: 1,
      relation: "transfer",
      transferDemandId: "d1",
    }, {
      id: "continuity:stable",
      sourcePassengerTrainRunId: "p2",
      targetPassengerTrainRunId: "p1",
      sourceDepartureS: 7_200,
      sourceArrivalS: 8_000,
      targetDepartureS: 86_400,
      sourcePhase: 0,
      successorDayOffset: 1,
      relation: "same-location",
      transferDemandId: null,
    }],
    passengerTrains: passengers,
    movementRoutePlan: {
      directTemplates: [direct("direct:p2-p1", "base:p2", "base:p1")],
      templates: [stabling("stabling:p2-p1", "base:p2", "base:p1", 0, "berth:1")],
      transferTemplates: [{
        id: "transfer-template:d1",
        demandId: "d1",
        formationLengthMm: LENGTH_MM,
        sourcePassengerRouteVersionId: "base:p1",
        targetPassengerRouteVersionId: "base:p2",
        sourceLocationId: "A",
        targetLocationId: "B",
        earliestDepartureS: 3_900,
        latestArrivalS: 93_300,
        availableWindowS: 89_400,
        movementKind: "shunting",
        transfer: transferDispatch,
        targetOutbound: dispatch("target-outbound:d1", transferDispatch.routeVersionId, "same-direction"),
        resourceIds: ["resource:transfer"],
        resourceSetSha256: "unused-by-prevalidated-plan",
      }],
    },
    repeatEveryMs: REPEAT_MS,
    selectProtectionModeRuns: protectionSelection,
  });
  const transferTrain = result.programTrains.find((train) => train.routeVersionId === transferDispatch.routeVersionId);
  assert.equal(transferTrain.movementKind, "shunting");
  assert.equal(transferTrain.scheduledDepartureMs, 92_700_000);
  const intoTransfer = result.movementContinuations.find((edge) => edge.successorTrainId === transferTrain.id);
  const outOfTransfer = result.movementContinuations.find((edge) => edge.predecessorTrainId === transferTrain.id);
  assert.equal(intoTransfer.minimumDwellMs, MOVEMENT_PASSENGER_DWELL_MS);
  assert.equal(intoTransfer.dailyBoundary, false);
  assert.equal(outOfTransfer.minimumDwellMs, 0);
  assert.equal(outOfTransfer.dailyBoundary, true);
});

test("verwirft eine Reservierung, die ihre eigene periodische Kopie ueberlappt", () => {
  const repeatEveryMs = 600_000;
  const overlongTransfer = dispatch(
    "transfer:overlong",
    "base:p1",
    "same-direction",
    ["resource:overlong"],
    700_000,
  );
  assert.throws(
    () => allocateMovementRoutePlanV2({
      dailyPlan: dailyPlan(
        [{ id: "c1", passengerTrainRunIds: ["p1"] }],
        [{ sourceCirculationId: "c1", targetCirculationId: "c1" }],
      ),
      continuities: [{
        id: "continuity:overlong",
        sourcePassengerTrainRunId: "p1",
        targetPassengerTrainRunId: "p1",
        sourceDepartureS: 500,
        sourceArrivalS: 0,
        targetDepartureS: 1_100,
        sourcePhase: 0,
        successorDayOffset: 1,
        relation: "transfer",
        transferDemandId: "overlong",
      }],
      passengerTrains: [passenger("p1", "base:p1", 500_000)],
      movementRoutePlan: {
        directTemplates: [],
        templates: [],
        transferTemplates: [{
          id: "transfer-template:overlong",
          demandId: "overlong",
          formationLengthMm: LENGTH_MM,
          sourcePassengerRouteVersionId: "base:p1",
          targetPassengerRouteVersionId: "base:p1",
          sourceLocationId: "A",
          targetLocationId: "A",
          earliestDepartureS: 300,
          latestArrivalS: 1_100,
          availableWindowS: 800,
          movementKind: "shunting",
          transfer: overlongTransfer,
          targetOutbound: dispatch("target-outbound:overlong", overlongTransfer.routeVersionId, "same-direction"),
          resourceIds: ["resource:overlong"],
          resourceSetSha256: "unused-by-prevalidated-plan",
        }],
      },
      repeatEveryMs,
      selectProtectionModeRuns: protectionSelection,
    }),
    /keine konfliktfreie periodische Gesamtzuweisung/u,
  );
});

test("findet per deterministischem Backtracking eine globale Transferbelegung", () => {
  const passengers = [
    passenger("p0", "base:p0", 0, "formation:0"),
    passenger("p1", "base:p1", 0, "formation:1"),
    passenger("p2", "base:p2", 0, "formation:2"),
  ];
  const specifications = [
    { id: "0", source: "p0", target: "p1", earliestS: 80_060, latestDepartureS: 80_540, runtimeMs: 180_000 },
    { id: "1", source: "p1", target: "p2", earliestS: 80_360, latestDepartureS: 80_540, runtimeMs: 240_000 },
    { id: "2", source: "p2", target: "p0", earliestS: 80_120, latestDepartureS: 80_180, runtimeMs: 240_000 },
  ];
  const transferTemplates = specifications.map((specification) => {
    const transfer = dispatch(
      `transfer:${specification.id}`,
      `base:${specification.source}`,
      "same-direction",
      ["resource:shared-transfer"],
      specification.runtimeMs,
    );
    return {
      id: `transfer-template:${specification.id}`,
      demandId: `d${specification.id}`,
      formationLengthMm: LENGTH_MM,
      sourcePassengerRouteVersionId: `base:${specification.source}`,
      targetPassengerRouteVersionId: `base:${specification.target}`,
      sourceLocationId: specification.source,
      targetLocationId: specification.target,
      earliestDepartureS: specification.earliestS,
      latestArrivalS: specification.latestDepartureS + specification.runtimeMs / 1_000,
      availableWindowS: specification.latestDepartureS + specification.runtimeMs / 1_000 - specification.earliestS,
      movementKind: "shunting",
      transfer,
      targetOutbound: dispatch(`target-outbound:${specification.id}`, transfer.routeVersionId, "same-direction"),
      resourceIds: ["resource:shared-transfer"],
      resourceSetSha256: "unused-by-prevalidated-plan",
    };
  });
  const result = allocateMovementRoutePlanV2({
    dailyPlan: dailyPlan(
      passengers.map((entry, index) => ({ id: `c${index}`, passengerTrainRunIds: [entry.trainRunId] })),
      specifications.map((entry) => ({
        sourceCirculationId: `c${entry.source.slice(1)}`,
        targetCirculationId: `c${entry.target.slice(1)}`,
      })),
    ),
    continuities: specifications.map((entry) => ({
      id: `continuity:${entry.id}`,
      sourcePassengerTrainRunId: entry.source,
      targetPassengerTrainRunId: entry.target,
      sourceDepartureS: 0,
      sourceArrivalS: 79_760,
      targetDepartureS: 86_400,
      sourcePhase: 0,
      successorDayOffset: 1,
      relation: "transfer",
      transferDemandId: `d${entry.id}`,
    })),
    passengerTrains: passengers,
    movementRoutePlan: { directTemplates: [], templates: [], transferTemplates },
    repeatEveryMs: REPEAT_MS,
    selectProtectionModeRuns: protectionSelection,
  });

  const departures = new Map(result.programTrains
    .filter((entry) => !entry.publicPassengerStop)
    .map((entry) => [entry.routeVersionId, entry.scheduledDepartureMs]));
  assert.deepEqual(departures, new Map([
    ["route:transfer:0", 80_360_000],
    ["route:transfer:1", 80_540_000],
    ["route:transfer:2", 80_120_000],
  ]));
});
