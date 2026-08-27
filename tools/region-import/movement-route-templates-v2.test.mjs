import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { alphaCanonicalJson } from "../../packages/alpha/dist/index.js";
import {
  MOVEMENT_ROUTE_TEMPLATES_SCHEMA,
  movementResourceSetSha256,
  validateMovementRouteTemplatesV2,
} from "./movement-route-templates-v2.mjs";

const HASH = "a".repeat(64);

function dispatch(id, resourceIds = [`resource:${id}`], predecessorBaseRouteVersionId = `base:${id}`, continuity = "same-direction") {
  return {
    routeVersionId: `route:${id}`,
    predecessorBaseRouteVersionId,
    dispatchInterlockingRouteId: `interlocking:${id}`,
    headRouteMm: 100,
    minimumRuntimeMs: 1_000,
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

const observedBerthAssignment = Object.freeze({ kind: "observed", subtype: "osm-service-siding", geometryProvenance: "real-osm-rail", operationalAssignmentProvenance: "observed-osm-service" });
const simulatedBerthAssignment = Object.freeze({ kind: "simulated-operational", subtype: "osm-unclassified-rail", geometryProvenance: "real-osm-rail", operationalAssignmentProvenance: "synthetic-operational-b-policy" });

function stabling(id, shuntOutContinuity, candidateRank) {
  const inboundRouteVersionId = "passenger:in";
  const outboundRouteVersionId = "passenger:out";
  const terminalEdgeId = `edge:${id}:terminal`;
  const shuntIn = dispatch(`${id}:shunt-in`, undefined, inboundRouteVersionId);
  const shuntOut = dispatch(`${id}:shunt-out`, undefined, shuntIn.routeVersionId, shuntOutContinuity);
  const sharedBerth = {
    edgeId: `edge:${id}:berth`,
    edgeLengthMm: 200,
    fromMm: 50,
    toMm: 150,
    leftClearanceMm: 50,
    rightClearanceMm: 50,
  };
  return {
    id: `stabling:${id}`,
    demandId: "turnaround:1",
    inboundRouteVersionId,
    outboundRouteVersionId,
    locationId: "A",
    physicalStopId: "A",
    earliestDepartureS: 100,
    latestArrivalS: 1_000,
    availableWindowS: 900,
    dailyBoundary: false,
    terminalEdgeId,
    terminalNodeId: 1,
    inboundDirection: "along",
    outboundDirection: "against",
    formationLengthMm: 100,
    candidateRank,
    stablingPathLengthMm: 300,
    terminalIntervals: [{ edgeId: terminalEdgeId, fromMm: 0, toMm: 100 }],
    stablingKind: "shared-berth",
    arrivalBerthAssignment: observedBerthAssignment,
    departureBerthAssignment: observedBerthAssignment,
    shuntIn,
    arrivalBerth: sharedBerth,
    berthTransfer: null,
    berthTransferProvenance: null,
    departureBerth: sharedBerth,
    shuntOut,
    outbound: dispatch(`${id}:outbound`, undefined, shuntOut.routeVersionId),
  };
}

function crossBerthStabling() {
  const value = stabling("cross", "reverse-direction", 0);
  value.stablingKind = "cross-berth-transfer";
  value.arrivalBerthAssignment = simulatedBerthAssignment;
  value.departureBerthAssignment = simulatedBerthAssignment;
  value.departureBerth = { edgeId: "edge:cross:departure", edgeLengthMm: 200, fromMm: 60, toMm: 160, leftClearanceMm: 60, rightClearanceMm: 40 };
  value.berthTransfer = dispatch("cross:berth-transfer", undefined, value.shuntIn.routeVersionId, "reverse-direction");
  value.berthTransferProvenance = { geometryProvenance: "real-osm-rail", routingRule: "real-osm-rail-bidirectional-bounded-v1", locationId: "A", physicalStopId: "A", maximumPathEdgesPerSide: 64, maximumPathLengthMmPerSide: 10_000_000 };
  value.shuntOut.predecessorBaseRouteVersionId = value.berthTransfer.routeVersionId;
  return value;
}

function fixture() {
  const directResources = ["resource:terminal"];
  const transferResources = ["resource:transfer"];
  const body = {
    schema: MOVEMENT_ROUTE_TEMPLATES_SCHEMA,
    infraReleaseId: "infra:test",
    operationalStateHash: HASH,
    timetableTransferSetSha256: "b".repeat(64),
    directTemplates: [{
      id: "direct:1",
      demandId: "turnaround:1",
      inboundRouteVersionId: "passenger:in",
      outboundRouteVersionId: "passenger:out",
      locationId: "A",
      physicalStopId: "A",
      earliestDepartureS: 100,
      latestArrivalS: 1_000,
      availableWindowS: 900,
      dailyBoundary: false,
      formationLengthMm: 100,
      terminalIntervals: [
        { edgeId: "edge:approach", fromMm: 20, toMm: 60 },
        { edgeId: "edge:terminal", fromMm: 50, toMm: 110 },
      ],
      movementKind: "train",
      continuity: "reverse-direction",
      maximumDwellMs: 1_200_000,
      resourceIds: directResources,
      resourceSetSha256: movementResourceSetSha256(directResources),
      through: null,
      outbound: dispatch("direct-outbound", undefined, "passenger:in", "reverse-direction"),
    }],
    templates: [],
    transferTemplates: [{
      id: "transfer-template:1",
      demandId: "transfer:1",
      formationLengthMm: 100,
      sourcePassengerRouteVersionId: "passenger:source",
      targetPassengerRouteVersionId: "passenger:target",
      sourceLocationId: "A",
      targetLocationId: "B",
      earliestDepartureS: 1_000,
      latestArrivalS: 2_000,
      availableWindowS: 1_000,
      dailyBoundary: false,
      movementKind: "train",
      transfer: dispatch("transfer", transferResources, "passenger:source"),
      targetOutbound: dispatch("target-outbound", undefined, "route:transfer"),
      resourceIds: transferResources,
      resourceSetSha256: movementResourceSetSha256(transferResources),
    }],
    metrics: {
      directTemplateCount: 1,
      stablingTemplateCount: 0,
      transferTemplateCount: 1,
      transferDemandCount: 1,
      turnaroundDemandCount: 1,
      plannedTransitionCount: 2,
      turnaroundPairCount: 1,
      observedStablingTemplateCount: 0,
      simulatedOperationalStablingTemplateCount: 0,
      berthAssignmentCounts: { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 },
      crossBerthTemplateCount: 0,
    },
  };
  const stateHash = createHash("sha256")
    .update(alphaCanonicalJson({ schema: MOVEMENT_ROUTE_TEMPLATES_SCHEMA, value: body }))
    .digest("hex");
  const artifact = { ...body, stateHash };
  return {
    artifact,
    binding: {
      file: "operational-infrastructure-v2.movement-route-templates-v2.json",
      bytes: 1,
      sha256: "c".repeat(64),
      stateHash,
      operationalStateHash: HASH,
      timetableTransferSetSha256: "b".repeat(64),
    },
    infraReleaseId: "infra:test",
    operationalStateHash: HASH,
    timetableTransferPlan: {
      transferSetSha256: "b".repeat(64),
      formationLengthsMm: [100],
      dailyPlan: {
        metrics: { plannedTransitionCount: 2 },
        circulations: [{ passengerTrainRunIds: ["run:1", "run:2"] }],
        rolloverAssignments: [{ kind: "transfer" }],
        turnaroundDemands: [{
          id: "turnaround:1",
          sourcePassengerRouteVersionId: "passenger:in",
          targetPassengerRouteVersionId: "passenger:out",
          sourceLocationId: "A",
          targetLocationId: "A",
          sourcePhysicalStopId: "A",
          targetPhysicalStopId: "A",
          earliestDepartureS: 100,
          latestArrivalS: 1_000,
          availableWindowS: 900,
          dailyBoundary: false,
        }],
        transferDemands: [{
          id: "transfer:1",
          sourceLocationId: "A",
          targetLocationId: "B",
          earliestDepartureS: 1_000,
          latestArrivalS: 2_000,
          availableWindowS: 1_000,
          dailyBoundary: false,
          movementKind: "train",
        }],
      },
      transferRoutes: [{
        id: "transfer:1",
        sourcePassengerRouteVersionId: "passenger:source",
        targetPassengerRouteVersionId: "passenger:target",
      }],
    },
  };
}

function rebindState(input) {
  const body = Object.fromEntries(Object.entries(input.artifact).filter(([key]) => key !== "stateHash"));
  const stateHash = createHash("sha256")
    .update(alphaCanonicalJson({ schema: MOVEMENT_ROUTE_TEMPLATES_SCHEMA, value: body }))
    .digest("hex");
  input.artifact.stateHash = stateHash;
  input.binding.stateHash = stateHash;
}

function addStablingContinuityMatrix(input) {
  input.artifact.templates = [
    stabling("same-berth-direction", "reverse-direction", 0),
    stabling("opposite-berth-direction", "same-direction", 1),
  ];
  input.artifact.metrics.stablingTemplateCount = input.artifact.templates.length;
  input.artifact.metrics.observedStablingTemplateCount = 2;
  input.artifact.metrics.berthAssignmentCounts.observedOsmServiceSiding = 2;
  rebindState(input);
  return input;
}

test("validiert den kombinierten Movement-v2-Sidecar byteunabhaengig aber stategebunden", () => {
  const input = fixture();
  const validated = validateMovementRouteTemplatesV2(input);
  assert.equal(validated.stateHash, input.artifact.stateHash);
  assert.equal(validated.directTemplates.length, 1);
  assert.equal(validated.transferTemplates.length, 1);
  assert(Object.isFrozen(validated.metrics.berthAssignmentCounts));
  assert.throws(() => { validated.metrics.berthAssignmentCounts.observedOsmServiceSiding = 1; }, TypeError);
});

test("bindet den Sidecar-Dateibeweis an kanonischen Pfad, positive Bytes und SHA-256", () => {
  const scenarios = [
    { field: "file", value: "nested/operational-infrastructure-v2.movement-route-templates-v2.json", error: /kanonischen V2-Dateinamen/u },
    { field: "bytes", value: 0, error: /sichere Ganzzahl ab 1/u },
    { field: "sha256", value: "not-a-sha256", error: /kein SHA-256/u },
  ];
  for (const scenario of scenarios) {
    const input = fixture();
    input.binding[scenario.field] = scenario.value;
    assert.throws(() => validateMovementRouteTemplatesV2(input), scenario.error);
  }
});

test("verwirft einen manipulierten Movement-Ressourcensatz", () => {
  const input = fixture();
  input.artifact.transferTemplates[0].resourceIds = ["resource:foreign"];
  rebindState(input);
  assert.throws(() => validateMovementRouteTemplatesV2(input), /bindet nicht alle Ressourcen|fremden Ressourcenhash/u);
});

test("verlangt genau ein natives Transfer-Template je Demand und Laenge", () => {
  const input = fixture();
  input.artifact.transferTemplates = [];
  input.artifact.metrics.transferTemplateCount = 0;
  rebindState(input);
  assert.throws(() => validateMovementRouteTemplatesV2(input), /nicht jede Transferanforderung/u);
});

test("bindet Direct- und Transfer-Vorlagen an die autoritativen V2-Anforderungen", () => {
  const foreignDirectDemand = fixture();
  foreignDirectDemand.artifact.directTemplates[0].demandId = "turnaround:foreign";
  rebindState(foreignDirectDemand);
  assert.throws(() => validateMovementRouteTemplatesV2(foreignDirectDemand), /keine gebundene Turnaround-Anforderung/u);

  const driftedDirectWindow = fixture();
  driftedDirectWindow.artifact.directTemplates[0].availableWindowS += 1;
  rebindState(driftedDirectWindow);
  assert.throws(() => validateMovementRouteTemplatesV2(driftedDirectWindow), /driftet von seiner autoritativen Turnaround-Anforderung/u);

  const driftedTransferBoundary = fixture();
  driftedTransferBoundary.artifact.transferTemplates[0].dailyBoundary = true;
  rebindState(driftedTransferBoundary);
  assert.throws(() => validateMovementRouteTemplatesV2(driftedTransferBoundary), /driftet vom vollstaendigen Timetable-Transfervertrag/u);
});

test("verlangt mehrkantige terminale Belegung und exakte Basisroutenbindung", () => {
  const singular = fixture();
  singular.artifact.directTemplates[0].terminalInterval = singular.artifact.directTemplates[0].terminalIntervals[0];
  delete singular.artifact.directTemplates[0].terminalIntervals;
  rebindState(singular);
  assert.throws(() => validateMovementRouteTemplatesV2(singular), /fehlende oder unbekannte Felder/u);

  const short = fixture();
  short.artifact.directTemplates[0].terminalIntervals[1].toMm -= 1;
  rebindState(short);
  assert.throws(() => validateMovementRouteTemplatesV2(short), /nicht exakt die Formation/u);

  const wrongBase = fixture();
  wrongBase.artifact.directTemplates[0].outbound.predecessorBaseRouteVersionId = "passenger:foreign";
  rebindState(wrongBase);
  assert.throws(() => validateMovementRouteTemplatesV2(wrongBase), /bindet nicht die Basisroute/u);

  const duplicate = fixture();
  duplicate.artifact.directTemplates[0].terminalIntervals = [
    { edgeId: "edge:terminal", fromMm: 0, toMm: 40 },
    { edgeId: "edge:terminal", fromMm: 0, toMm: 40 },
    { edgeId: "edge:terminal", fromMm: 40, toMm: 60 },
  ];
  rebindState(duplicate);
  assert.throws(() => validateMovementRouteTemplatesV2(duplicate), /dupliziertes Intervall/u);

  const sameEdgeGap = fixture();
  sameEdgeGap.artifact.directTemplates[0].terminalIntervals = [
    { edgeId: "edge:terminal", fromMm: 0, toMm: 40 },
    { edgeId: "edge:terminal", fromMm: 50, toMm: 110 },
  ];
  rebindState(sameEdgeGap);
  assert.throws(() => validateMovementRouteTemplatesV2(sameEdgeGap), /Luecke, Ueberlappung oder falsche Reihenfolge/u);
});

test("erzwingt Through nur fuer gleichgerichtete Direct-Fortsetzungen", () => {
  const missing = fixture();
  missing.artifact.directTemplates[0].continuity = "same-direction";
  rebindState(missing);
  assert.throws(() => validateMovementRouteTemplatesV2(missing), /keine physische Through-Bewegung/u);

  const valid = fixture();
  valid.artifact.directTemplates[0].continuity = "same-direction";
  valid.artifact.directTemplates[0].through = dispatch("through", undefined, "passenger:in");
  valid.artifact.directTemplates[0].outbound.predecessorBaseRouteVersionId = "route:through";
  valid.artifact.directTemplates[0].outbound.continuity = "same-direction";
  rebindState(valid);
  assert.equal(validateMovementRouteTemplatesV2(valid).directTemplates[0].through.routeVersionId, "route:through");

  const wrongThroughContinuity = structuredClone(valid);
  wrongThroughContinuity.artifact.directTemplates[0].through.continuity = "reverse-direction";
  rebindState(wrongThroughContinuity);
  assert.throws(() => validateMovementRouteTemplatesV2(wrongThroughContinuity), /keine gleichgerichtete Through-Kette/u);

  const duplicateBaseTraversal = structuredClone(valid);
  duplicateBaseTraversal.artifact.directTemplates[0].outbound.predecessorBaseRouteVersionId = "passenger:in";
  rebindState(duplicateBaseTraversal);
  assert.throws(() => validateMovementRouteTemplatesV2(duplicateBaseTraversal), /bindet nicht die unmittelbar vorige Through-Route/u);
});

test("akzeptiert beide nativ belegten Stabling-Fortsetzungen der physischen Enum-Matrix", () => {
  const input = addStablingContinuityMatrix(fixture());
  const validated = validateMovementRouteTemplatesV2(input);
  assert.deepEqual(
    validated.templates.map((template) => [template.shuntIn.continuity, template.shuntOut.continuity, template.outbound.continuity]),
    [
      ["same-direction", "reverse-direction", "same-direction"],
      ["same-direction", "same-direction", "same-direction"],
    ],
  );
  assert.notEqual(validated.templates[0].shuntIn.routeVersionId, validated.templates[0].shuntOut.routeVersionId);
  assert.notEqual(validated.templates[1].shuntIn.routeVersionId, validated.templates[1].shuntOut.routeVersionId);
});

test("bindet beide Berth-Freilaengen an dieselbe reale Kantenlaenge", () => {
  const input = addStablingContinuityMatrix(fixture());
  input.artifact.templates[0].arrivalBerth.rightClearanceMm += 1;
  rebindState(input);
  assert.throws(() => validateMovementRouteTemplatesV2(input), /rechte Freilaenge nicht an das reale Kantenende/u);
});

test("bindet einen realgeometrischen Cross-Berth-Transfer mit getrennter Provenienz und Vorgaengerkette", () => {
  const input = fixture();
  input.artifact.templates = [crossBerthStabling()];
  input.artifact.metrics.stablingTemplateCount = 1;
  input.artifact.metrics.simulatedOperationalStablingTemplateCount = 1;
  input.artifact.metrics.berthAssignmentCounts.simulatedOperationalOsmUnclassifiedRail = 2;
  input.artifact.metrics.crossBerthTemplateCount = 1;
  rebindState(input);
  const [template] = validateMovementRouteTemplatesV2(input).templates;
  assert.equal(template.stablingKind, "cross-berth-transfer");
  assert.equal(template.berthTransfer.continuity, "reverse-direction");
  assert.equal(template.berthTransferProvenance.geometryProvenance, "real-osm-rail");
});

test("verwirft erfundene, ortsfremde oder unterbrochene Cross-Berth-Belege", () => {
  const scenarios = [
    {
      mutate: (template) => { template.berthTransferProvenance.geometryProvenance = "invented"; },
      error: /keinen realen, ortsidentischen Cross-Berth-Laufweg/u,
    },
    {
      mutate: (template) => { template.berthTransferProvenance.physicalStopId = "B"; },
      error: /keinen realen, ortsidentischen Cross-Berth-Laufweg/u,
    },
    {
      mutate: (template) => { template.shuntOut.predecessorBaseRouteVersionId = template.shuntIn.routeVersionId; },
      error: /unterbrochene Cross-Berth-Vorgaengerkette/u,
    },
  ];
  for (const scenario of scenarios) {
    const input = fixture();
    input.artifact.templates = [crossBerthStabling()];
    input.artifact.metrics.stablingTemplateCount = 1;
    input.artifact.metrics.simulatedOperationalStablingTemplateCount = 1;
    input.artifact.metrics.berthAssignmentCounts.simulatedOperationalOsmUnclassifiedRail = 2;
    input.artifact.metrics.crossBerthTemplateCount = 1;
    scenario.mutate(input.artifact.templates[0]);
    rebindState(input);
    assert.throws(() => validateMovementRouteTemplatesV2(input), scenario.error);
  }
});

test("verwirft eine nachtraeglich manipulierte signierte Stabling-Continuity", () => {
  const input = addStablingContinuityMatrix(fixture());
  input.artifact.templates[0].shuntOut.continuity = "same-direction";
  assert.throws(() => validateMovementRouteTemplatesV2(input), /fremden kanonischen State-Hash/u);
});

test("verwirft Enum-gueltige aber fachlich freie Stabling-Fortsetzungen", () => {
  const wrongShuntIn = addStablingContinuityMatrix(fixture());
  wrongShuntIn.artifact.templates[0].shuntIn.continuity = "reverse-direction";
  rebindState(wrongShuntIn);
  assert.throws(() => validateMovementRouteTemplatesV2(wrongShuntIn), /keine physisch belegte Rangier-Fortsetzungsmatrix/u);

  const wrongOutbound = addStablingContinuityMatrix(fixture());
  wrongOutbound.artifact.templates[0].outbound.continuity = "reverse-direction";
  rebindState(wrongOutbound);
  assert.throws(() => validateMovementRouteTemplatesV2(wrongOutbound), /keine physisch belegte Rangier-Fortsetzungsmatrix/u);
});

test("verwirft fehlende und unbekannte Stabling-Continuity-Werte", () => {
  const missing = addStablingContinuityMatrix(fixture());
  delete missing.artifact.templates[0].shuntOut.continuity;
  rebindState(missing);
  assert.throws(() => validateMovementRouteTemplatesV2(missing), /fehlende oder unbekannte Felder/u);

  const unknown = addStablingContinuityMatrix(fixture());
  unknown.artifact.templates[0].shuntOut.continuity = "sideways";
  rebindState(unknown);
  assert.throws(() => validateMovementRouteTemplatesV2(unknown), /continuity ist unbekannt/u);
});

test("bindet den kanonischen State-Hash auch ohne fachliche Neuberechnung", () => {
  const input = fixture();
  input.artifact.directTemplates[0].outbound.routeVersionId = "route:tampered";
  assert.throws(() => validateMovementRouteTemplatesV2(input), /fremden kanonischen State-Hash/u);
});
