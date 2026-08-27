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

function dispatch(id, resourceIds = [`resource:${id}`], predecessorBaseRouteVersionId = `base:${id}`) {
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
  };
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
      inboundRouteVersionId: "passenger:in",
      outboundRouteVersionId: "passenger:out",
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
      outbound: dispatch("direct-outbound", undefined, "passenger:in"),
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
      turnaroundPairCount: 1,
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
        circulations: [{ passengerTrainRunIds: ["run:1", "run:2"] }],
        rolloverAssignments: [{ kind: "transfer" }],
        transferDemands: [{
          id: "transfer:1",
          sourceLocationId: "A",
          targetLocationId: "B",
          earliestDepartureS: 1_000,
          latestArrivalS: 2_000,
          availableWindowS: 1_000,
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

test("validiert den kombinierten Movement-v2-Sidecar byteunabhaengig aber stategebunden", () => {
  const input = fixture();
  const validated = validateMovementRouteTemplatesV2(input);
  assert.equal(validated.stateHash, input.artifact.stateHash);
  assert.equal(validated.directTemplates.length, 1);
  assert.equal(validated.transferTemplates.length, 1);
});

test("verwirft einen manipulierten Movement-Ressourcensatz", () => {
  const input = fixture();
  input.artifact.transferTemplates[0].resourceIds = ["resource:foreign"];
  rebindState(input);
  assert.throws(() => validateMovementRouteTemplatesV2(input), /verschiedene Transfer-Ressourcen|fremden Ressourcenhash/u);
});

test("verlangt genau ein natives Transfer-Template je Demand und Laenge", () => {
  const input = fixture();
  input.artifact.transferTemplates = [];
  input.artifact.metrics.transferTemplateCount = 0;
  rebindState(input);
  assert.throws(() => validateMovementRouteTemplatesV2(input), /nicht jede Transferanforderung/u);
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
  rebindState(valid);
  assert.equal(validateMovementRouteTemplatesV2(valid).directTemplates[0].through.routeVersionId, "route:through");
});
