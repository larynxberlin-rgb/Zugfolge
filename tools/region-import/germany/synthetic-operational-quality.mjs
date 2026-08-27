import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  GERMANY_TIMETABLE_ROUTE_REPORT_SCHEMA,
  GERMANY_TIMETABLE_TRANSFER_DEMAND_SCHEMA,
  TIMETABLE_ROUTE_DERIVATION_RULE,
  TIMETABLE_ROUTE_POLICY_ID,
  TIMETABLE_ROUTE_SELECTION_RULE,
  validatePinnedGtfsSnapshot,
} from "./timetable-route-compiler.mjs";
import {
  DAILY_CIRCULATION_MINIMUM_TURNAROUND_S,
  DAILY_CIRCULATION_PLAN_SCHEMA,
  DAILY_CIRCULATION_REPEAT_EVERY_S,
  DAILY_CIRCULATION_RULE,
} from "../daily-circulation-v2.mjs";

export const SYNTHETIC_OPERATIONAL_POLICY_ID = "synthetic-operational-b/v2";
export const SYNTHETIC_OPERATIONAL_POLICY_SCHEMA = "zugfolge-synthetic-operational-policy/v2";
export const SYNTHETIC_OPERATIONAL_CLOSURE_SCHEMA = "zugfolge-synthetic-operational-closure-receipt/v2";

const DERIVATION_SPEC_SCHEMA = "zugfolge-germany-operational-infrastructure-derivation/v2";
const DERIVATION_REPORT_SCHEMA = "germany-operational-v2-derivation-report-v1";
const DERIVATION_MODE = "deterministic-conservative-v1";
const COMPLETE_ROUTE_COVERAGE = "complete-pinned-timetable-routes";
const FULL_ROUTE_INTERLOCKING_MODEL = "deterministic-linear-segment-node-stellzone-mutex-and-progressive-authority/v3";
const TURNAROUND_MODEL = "real-osm-bounded-bidirectional-access-with-observed-siding-or-explicit-synthetic-operational-berth/v3";
const MOVEMENT_ROUTE_TEMPLATE_MODEL = "daily-plan-scoped-direct-stabling-transfer-continuity/v2";
const NATIVE_SCHEMA = "operational-infrastructure-v2";
const NATIVE_MODE = "native-streaming-redb-v1";
const GTFS_SNAPSHOT_SCHEMA = "zugfolge-gtfs-region-snapshot/v2";
const SHA256 = /^[a-f0-9]{64}$/u;
const DERIVATION_INPUT_ROLES = Object.freeze([
  "blocks",
  "conflict-resources",
  "platforms",
  "signals",
  "switches",
  "timetable-routes",
  "timetable-transfer-demands",
  "tracks",
]);
const REQUIRED_INPUT_ROLES = Object.freeze([
  "blocks",
  "conflict-resources",
  "gtfs-snapshot",
  "platforms",
  "signals",
  "switches",
  "timetable-route-report",
  "timetable-routes",
  "timetable-transfer-demands",
  "tracks",
]);
const REQUIRED_DIMENSIONS = Object.freeze([
  "directed-edge-geometry",
  "route-versions",
  "complete-pinned-timetable-routes",
  "daily-physical-circulations",
  "real-transfer-route-coverage",
  "free-gtfs-route-provenance",
  "station-heads",
  "interlocking-routes",
  "platform-intervals",
  "train-protection",
  "path-resources",
  "overlap-resources",
  "flank-resources",
  "region-boundaries",
  "rzue-layout",
]);
const COMPILER_POLICY_KEYS = Object.freeze([
  "id",
  "qualityClass",
  "sourceId",
  "derivationRule",
  "unknownMainlineSpeedKmh",
  "unknownServiceSpeedKmh",
  "unknownGradientAbsPermille",
  "minimumPlatformLengthMm",
  "maximumPlatformSnapDistanceMm",
  "minimumOverlapMm",
  "minimumBerthEndClearanceMm",
  "maximumStablingPathEdges",
  "maximumStablingPathLengthMm",
  "simulatedOperationalBerthFallback",
  "maximumDirectDwellMs",
  "terminalFormationLengthsMm",
  "defaultProtectionSystem",
  "regionBoundaryId",
  "rzueLayoutId",
]);
const COVERAGE_FIELDS = Object.freeze([
  "blockResources",
  "directedEdges",
  "edgeGeometries",
  "interlockingRoutes",
  "platformIntervals",
  "regionBoundaries",
  "routeVersions",
  "rzueLayouts",
  "signals",
  "switches",
]);
const REPORT_INPUT_NAMES = Object.freeze([
  "spec",
  "tracks",
  "platforms",
  "switches",
  "signals",
  "blocks",
  "conflictResources",
  "timetableRoutes",
  "transferDemands",
]);
const DERIVATION_ROLE_TO_LAYER = Object.freeze({
  blocks: "blocks",
  "conflict-resources": "conflictResources",
  platforms: "platforms",
  signals: "signals",
  switches: "switches",
  "timetable-routes": "timetableRoutes",
  "timetable-transfer-demands": "transferDemands",
  tracks: "tracks",
});
const TIMETABLE_ROUTE_REPORT_KEYS = Object.freeze([
  "schema",
  "infraReleaseId",
  "status",
  "routesProduced",
  "derivationRule",
  "selectionRule",
  "policyId",
  "gtfsBinding",
  "metrics",
  "sourceProofs",
  "sourceMetrics",
  "provenance",
  "routeSetSha256",
  "dailyCirculationPlanSha256",
  "transferSetSha256",
  "transferDemandsProduced",
  "findings",
  "unresolvedRequired",
]);
const TIMETABLE_ROUTE_METRIC_KEYS = Object.freeze([
  "stationCount",
  "journeyChainCount",
  "playableLegCount",
  "oneStopPlayableLegCount",
  "externalLegCount",
  "snapshotSegmentCount",
  "eligibleSegmentCount",
  "excludedQualityCCount",
  "uniqueDirectedStopPairCount",
  "uniqueRoutableDirectedStopPairCount",
  "sameStopTransitionCount",
  "completeRouteCount",
  "incompleteRouteCount",
  "routeRecordCount",
  "routedStopPairCount",
  "reusedStopPairRouteCount",
  "uniqueRouterQueryCount",
  "routeLegCount",
  "totalRouteLengthMm",
  "maximumAnchorDistanceMm",
  "zeroMovementStopTransitionCount",
  "dailyCirculation",
  "transferRouteCount",
  "transferRouteLegCount",
  "transferRouteLengthMm",
  "retainedRoutingTrackCount",
]);
const DAILY_CIRCULATION_METRIC_KEYS = Object.freeze([
  "lotCount",
  "journeyChainCount",
  "circulationCount",
  "rolloverAssignmentCount",
  "plannedTransitionCount",
  "turnaroundDemandCount",
  "transferDemandCount",
  "transferLotCount",
]);
const TIMETABLE_ROUTE_EVIDENCE_KEYS = Object.freeze([
  "reportSchema",
  "policyId",
  "derivationRule",
  "selectionRule",
  "reportBytes",
  "reportSha256",
  "routesBytes",
  "routesSha256",
  "gtfsSnapshotBytes",
  "gtfsSnapshotSha256",
  "transferDemandsSchema",
  "transferDemandsBytes",
  "transferDemandsSha256",
  "snapshotHash",
  "archive",
  "archiveSha256",
  "sourceLicense",
  "sourceLicenseAsPublished",
  "selectedSegmentCount",
  "completeRouteCount",
  "routeRecordCount",
  "sameStopTransitionCount",
  "routeSetSha256",
  "dailyCirculationPlanSha256",
  "transferSetSha256",
  "transferDemandsProduced",
  "dailyCirculation",
  "transferRouteCount",
  "transferRouteLegCount",
  "transferRouteLengthMm",
  "realGeometry",
  "simulatedOperationalAssignment",
  "realInterlockingFactsClaimed",
  "externalOperationalNetworkProvenance",
]);
const VERIFIED = Symbol("verified-synthetic-operational-closure");

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} ist kein Objekt.`);
  invariant(
    JSON.stringify(Object.keys(value).sort(compareText)) === JSON.stringify([...expected].sort(compareText)),
    `${label} besitzt unerwartete oder fehlende Felder.`,
  );
}

function positiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} ist keine positive sichere Ganzzahl.`);
  return value;
}

function nonNegativeInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} ist keine nichtnegative sichere Ganzzahl.`);
  return value;
}

export function canonicalSyntheticOperationalValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalSyntheticOperationalValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalSyntheticOperationalValue(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function syntheticOperationalSha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalSyntheticOperationalValue(value)).digest("hex");
}

function sameCanonical(left, right) {
  return canonicalSyntheticOperationalValue(left) === canonicalSyntheticOperationalValue(right);
}

function exactStrings(actual, expected, label) {
  invariant(Array.isArray(actual) && actual.every((value) => typeof value === "string" && value !== ""), `${label} ist keine vollstaendige Kennungsliste.`);
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `${label} entspricht nicht dem festen synthetic-operational-b/v2-Vertrag.`);
}

function regularRelativePath(value, label) {
  invariant(typeof value === "string" && value !== "" && !isAbsolute(value), `${label} ist kein relativer Dateipfad.`);
  const normalized = value.replaceAll("\\", "/");
  invariant(!normalized.startsWith("../") && !normalized.includes("/../") && normalized !== "..", `${label} verlaesst seine Artefaktwurzel.`);
  return normalized;
}

function fileBinding(value, label, extraKeys = []) {
  exactKeys(value, ["file", "bytes", "sha256", ...extraKeys], label);
  regularRelativePath(value.file, `${label}.file`);
  positiveInteger(value.bytes, `${label}.bytes`);
  invariant(SHA256.test(value.sha256), `${label}.sha256 ist ungueltig.`);
  return value;
}

function inputBinding(value, label) {
  fileBinding(value, label, ["role", "records"]);
  invariant(typeof value.role === "string" && value.role !== "", `${label}.role fehlt.`);
  positiveInteger(value.records, `${label}.records`);
  return value;
}

function validateCompilerPolicy(policy) {
  exactKeys(policy, COMPILER_POLICY_KEYS, "compilerPolicy");
  invariant(policy.id === SYNTHETIC_OPERATIONAL_POLICY_ID && policy.qualityClass === "B", "compilerPolicy verletzt ID oder Klasse.");
  for (const field of ["sourceId", "derivationRule", "simulatedOperationalBerthFallback", "defaultProtectionSystem", "regionBoundaryId", "rzueLayoutId"]) {
    invariant(typeof policy[field] === "string" && policy[field] !== "", `compilerPolicy.${field} fehlt.`);
  }
  invariant(
    policy.simulatedOperationalBerthFallback === "real-osm-service-yard-then-spur-then-unclassified-rail/v1",
    "compilerPolicy.simulatedOperationalBerthFallback verletzt den versionierten Berth-Fallback-Vertrag.",
  );
  for (const field of [
    "unknownMainlineSpeedKmh",
    "unknownServiceSpeedKmh",
    "minimumPlatformLengthMm",
    "maximumPlatformSnapDistanceMm",
    "minimumOverlapMm",
    "minimumBerthEndClearanceMm",
    "maximumStablingPathEdges",
    "maximumStablingPathLengthMm",
    "maximumDirectDwellMs",
  ]) {
    positiveInteger(policy[field], `compilerPolicy.${field}`);
  }
  nonNegativeInteger(policy.unknownGradientAbsPermille, "compilerPolicy.unknownGradientAbsPermille");
  invariant(
    Array.isArray(policy.terminalFormationLengthsMm)
      && policy.terminalFormationLengthsMm.length > 0
      && policy.terminalFormationLengthsMm.every((length, index, values) => Number.isSafeInteger(length) && length > 0 && (index === 0 || values[index - 1] < length)),
    "compilerPolicy.terminalFormationLengthsMm ist keine nichtleere, streng aufsteigende Formationslaengenliste.",
  );
  return policy;
}

export function validateSyntheticOperationalPolicy(policy) {
  exactKeys(policy, [
    "schema",
    "id",
    "qualityClass",
    "provenance",
    "classAEligible",
    "ordinaryAssumptionsEligible",
    "requiredInputRoles",
    "requiredDimensions",
    "rules",
    "compilerPolicy",
    "publicClaims",
  ], "Synthetic-Operational-Policy");
  invariant(policy.schema === SYNTHETIC_OPERATIONAL_POLICY_SCHEMA, "Synthetic-Operational-Policy besitzt kein v2-Schema mit timetableRoutes-Bindung.");
  invariant(policy.id === SYNTHETIC_OPERATIONAL_POLICY_ID, "Synthetic-Operational-Policy besitzt eine unbekannte ID.");
  invariant(policy.qualityClass === "B" && policy.provenance === "derived", "Synthetic-Operational-Policy ist nicht als Derived/B gebunden.");
  invariant(policy.classAEligible === false && policy.ordinaryAssumptionsEligible === false, "Synthetic-Operational-Policy darf weder Klasse A noch gewoehnliche Annahmen freigeben.");
  exactStrings(policy.requiredInputRoles, REQUIRED_INPUT_ROLES, "requiredInputRoles");
  exactStrings(policy.requiredDimensions, REQUIRED_DIMENSIONS, "requiredDimensions");
  invariant(Array.isArray(policy.rules) && policy.rules.length > 0, "Synthetic-Operational-Policy besitzt keine Regeln.");
  const ruleIds = new Set();
  for (const rule of policy.rules) {
    exactKeys(rule, ["id", "effect"], "Synthetic-Operational-Regel");
    invariant(typeof rule.id === "string" && /\/v\d+$/u.test(rule.id), "Synthetic-Operational-Regel besitzt keine versionierte ID.");
    invariant(!ruleIds.has(rule.id), `Synthetic-Operational-Regel ${rule.id} ist doppelt.`);
    ruleIds.add(rule.id);
    invariant(typeof rule.effect === "string" && rule.effect !== "", `Synthetic-Operational-Regel ${rule.id} besitzt keine Wirkung.`);
  }
  invariant(ruleIds.has("pinned-timetable-route-coverage/v1"), "Synthetic-Operational-Policy besitzt keine vollstaendige timetableRoutes-Regel.");
  invariant(ruleIds.has("daily-physical-circulation-and-transfer-coverage/v2"), "Synthetic-Operational-Policy besitzt keine physisch geschlossene v2-Tagesumlauf- und Transferregel.");
  invariant(ruleIds.has("free-gtfs-route-provenance/v2"), "Synthetic-Operational-Policy besitzt keine freie GTFS-Provenienzregel.");
  validateCompilerPolicy(policy.compilerPolicy);
  exactKeys(policy.publicClaims, [
    "realGeometry",
    "simulatedOperationalAssignment",
    "realInterlockingFactsClaimed",
    "syntheticOperationalDetailsShipped",
    "objectLevelProvenanceShipped",
    "observedAndSyntheticObjectsShareRuntimeCollections",
  ], "publicClaims");
  invariant(
    policy.publicClaims.realGeometry === true
      && policy.publicClaims.simulatedOperationalAssignment === true
      && policy.publicClaims.realInterlockingFactsClaimed === false
      && policy.publicClaims.syntheticOperationalDetailsShipped === true
      && policy.publicClaims.objectLevelProvenanceShipped === false
      && policy.publicClaims.observedAndSyntheticObjectsShareRuntimeCollections === true,
    "Synthetic-Operational-Policy trennt oeffentliche Fakten und interne Simulation nicht fail-closed.",
  );
  return policy;
}

function validateNativeReceipt(receipt, releaseId, expected, label) {
  exactKeys(receipt, ["bytes", "infraReleaseId", "schema", "sha256", "sourceBytes", "sourceSha256", "stateHash", "validationMode"], label);
  invariant(receipt.schema === NATIVE_SCHEMA && receipt.infraReleaseId === releaseId && receipt.validationMode === NATIVE_MODE, `${label} verletzt Schema, Release oder Modus.`);
  invariant(
    receipt.sourceBytes === expected.bytes
      && receipt.sourceSha256 === expected.sha256
      && receipt.bytes === expected.bytes
      && receipt.sha256 === expected.sha256
      && receipt.stateHash === expected.stateHash,
    `${label} bindet nicht dieselben kanonischen Bytes und denselben Zustand.`,
  );
  invariant(SHA256.test(receipt.stateHash) && receipt.stateHash !== receipt.sha256, `${label} besitzt keinen getrennten Zustandshash.`);
}

function validateCoverage(coverage) {
  exactKeys(coverage, COVERAGE_FIELDS, "Closure-Coverage");
  for (const field of COVERAGE_FIELDS) positiveInteger(coverage[field], `Closure-Coverage.${field}`);
  invariant(coverage.rzueLayouts === 1, "Closure-Receipt muss genau ein statisches RZUE-Layout binden.");
  invariant(coverage.directedEdges === coverage.edgeGeometries, "Closure-Receipt deckt nicht jede gerichtete Kante geometrisch ab.");
}

function validateReportInputEvidence(value, label) {
  exactKeys(value, ["path", "bytes", "sha256", "records"], label);
  invariant(typeof value.path === "string" && value.path !== "", `${label}.path fehlt.`);
  positiveInteger(value.bytes, `${label}.bytes`);
  invariant(SHA256.test(value.sha256), `${label}.sha256 ist ungueltig.`);
  positiveInteger(value.records, `${label}.records`);
}

function validateMovementRouteTemplatesEvidence(value, { operationalStateHash, transferSetSha256 }, label) {
  exactKeys(value, ["file", "bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256", "berthAssignmentCounts", "crossBerthTemplateCount"], label);
  const path = regularRelativePath(value.file, `${label}.file`);
  invariant(
    basename(path) === path && path.endsWith(".movement-route-templates-v2.json"),
    `${label}.file ist kein einzelnes Movement-Route-Templates-v2-Sidecar.`,
  );
  positiveInteger(value.bytes, `${label}.bytes`);
  for (const field of ["sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256"]) {
    invariant(SHA256.test(value[field]), `${label}.${field} ist ungueltig.`);
  }
  invariant(value.sha256 !== value.stateHash, `${label} trennt Datei- und Zustandshash nicht.`);
  invariant(value.operationalStateHash === operationalStateHash, `${label} bindet einen anderen Operational-v2-Zustand.`);
  invariant(value.timetableTransferSetSha256 === transferSetSha256, `${label} bindet ein anderes Timetable-Transfer-Set.`);
  exactKeys(value.berthAssignmentCounts, ["observedOsmServiceSiding", "simulatedOperationalOsmServiceYard", "simulatedOperationalOsmServiceSpur", "simulatedOperationalOsmUnclassifiedRail"], `${label}.berthAssignmentCounts`);
  for (const [field, count] of Object.entries(value.berthAssignmentCounts)) nonNegativeInteger(count, `${label}.berthAssignmentCounts.${field}`);
  nonNegativeInteger(value.crossBerthTemplateCount, `${label}.crossBerthTemplateCount`);
  return value;
}

function validateNativeTimetableRouteEvidence(value, report) {
  exactKeys(value, [
    "timetableRoutes", "transferDemands", "dailyPlanSha256", "transferSetSha256", "circulationCount",
    "plannedTransitionCount", "transferDemandCount", "transferLotCount", "turnaroundDemandCount", "turnaroundPairCount",
    "movementRouteTemplates",
  ], "Nativer Bericht.timetableRouteEvidence");
  validateReportInputEvidence(value.timetableRoutes, "Nativer Bericht.timetableRouteEvidence.timetableRoutes");
  validateReportInputEvidence(value.transferDemands, "Nativer Bericht.timetableRouteEvidence.transferDemands");
  invariant(
    sameCanonical(value.timetableRoutes, report.inputs.timetableRoutes)
      && sameCanonical(value.transferDemands, report.inputs.transferDemands),
    "Nativer Bericht wiederholt abweichende Timetable-Routen- oder Transfer-Dateibindungen.",
  );
  invariant(SHA256.test(value.dailyPlanSha256) && SHA256.test(value.transferSetSha256), "Nativer Bericht besitzt keinen Tagesplan- oder Transfer-Set-Hash.");
  for (const field of ["circulationCount", "plannedTransitionCount"]) {
    positiveInteger(value[field], `Nativer Bericht.timetableRouteEvidence.${field}`);
  }
  for (const field of ["transferDemandCount", "transferLotCount", "turnaroundDemandCount", "turnaroundPairCount"]) {
    nonNegativeInteger(value[field], `Nativer Bericht.timetableRouteEvidence.${field}`);
  }
  invariant(
    value.transferDemandCount + value.turnaroundDemandCount === value.plannedTransitionCount
      && value.transferLotCount <= value.transferDemandCount
      && value.turnaroundPairCount <= value.turnaroundDemandCount,
    "Nativer Bericht schliesst Tagesumlauf-, Transfer- und Turnaround-Anforderungen nicht widerspruchsfrei.",
  );
  const movement = validateMovementRouteTemplatesEvidence(value.movementRouteTemplates, {
    operationalStateHash: report.candidate.stateHash,
    transferSetSha256: value.transferSetSha256,
  }, "Nativer Bericht.timetableRouteEvidence.movementRouteTemplates");
  invariant(sameCanonical(movement, report.candidate.movementRouteTemplates), "Nativer Bericht bindet im Candidate und Timetable-Nachweis verschiedene Movement-Route-Templates.");
  return value;
}

export function coverageFromSyntheticOperationalDerivationReport(report) {
  exactKeys(report.counts, ["source", "candidate", "provenance"], "Nativer Bericht.counts");
  exactKeys(report.counts.source, [
    "tracks", "orderableTracks", "platforms", "switches", "signals", "blocks", "conflictResources",
    "timetableRoutes", "timetableLegs", "transferDemands", "transferLots", "turnaroundDemands", "turnaroundPairs",
  ], "Nativer Bericht.counts.source");
  exactKeys(report.counts.candidate, [
    "directedEdges", "edgeGeometries", "routeVersions", "interlockingRoutes", "signals", "switches",
    "blockResources", "platformIntervals", "regionBoundaries", "directTemplates", "stablingTemplates", "transferTemplates",
  ], "Nativer Bericht.counts.candidate");
  exactKeys(report.counts.provenance, [
    "observedForwardSpeeds", "observedBackwardSpeeds", "simulatedSpeeds", "observedProtectionAssignments",
    "simulatedProtectionAssignments", "matchedPlatformIntervals", "excludedPlatformEvidence", "syntheticBoundarySignals",
    "turnaroundRouteVersions", "turnaroundInterlockingRoutes", "transferRouteVersions", "transferInterlockingRoutes",
    "observedStablingTemplates", "simulatedOperationalStablingTemplates", "berthAssignmentCounts", "crossBerthTemplates",
  ], "Nativer Bericht.counts.provenance");
  exactKeys(report.counts.provenance.berthAssignmentCounts, ["observedOsmServiceSiding", "simulatedOperationalOsmServiceYard", "simulatedOperationalOsmServiceSpur", "simulatedOperationalOsmUnclassifiedRail"], "Nativer Bericht.counts.provenance.berthAssignmentCounts");
  for (const [name, value] of Object.entries(report.counts.source)) nonNegativeInteger(value, `Nativer Bericht.counts.source.${name}`);
  for (const [name, value] of Object.entries(report.counts.provenance)) {
    if (name !== "berthAssignmentCounts") nonNegativeInteger(value, `Nativer Bericht.counts.provenance.${name}`);
  }
  for (const [name, value] of Object.entries(report.counts.provenance.berthAssignmentCounts)) nonNegativeInteger(value, `Nativer Bericht.counts.provenance.berthAssignmentCounts.${name}`);
  const berthAssignmentTotal = Object.values(report.counts.provenance.berthAssignmentCounts).reduce((sum, count) => sum + count, 0);
  invariant(
    sameCanonical(report.counts.provenance.berthAssignmentCounts, report.candidate.movementRouteTemplates.berthAssignmentCounts)
      && report.counts.provenance.crossBerthTemplates === report.candidate.movementRouteTemplates.crossBerthTemplateCount
      && report.counts.provenance.observedStablingTemplates + report.counts.provenance.simulatedOperationalStablingTemplates === report.counts.candidate.stablingTemplates
      && berthAssignmentTotal === report.counts.candidate.stablingTemplates + report.counts.provenance.crossBerthTemplates,
    "Nativer Bericht zaehlt Berth-Provenienz in Report und Movement-Beleg verschieden.",
  );
  for (const [name, value] of Object.entries(report.counts.candidate)) {
    if (["directTemplates", "stablingTemplates"].includes(name)) nonNegativeInteger(value, `Nativer Bericht.counts.candidate.${name}`);
    else positiveInteger(value, `Nativer Bericht.counts.candidate.${name}`);
  }
  invariant(
    report.counts.source.timetableRoutes > 0
      && report.counts.source.timetableLegs > 0
      && report.counts.source.transferDemands > 0
      && report.counts.source.transferLots > 0,
    "Nativer Bericht besitzt keine vollstaendige Timetable-/Transfer-Abdeckung.",
  );
  invariant(
    report.counts.candidate.routeVersions
      === report.counts.source.timetableRoutes
        + report.counts.provenance.turnaroundRouteVersions
        + report.counts.provenance.transferRouteVersions,
    "RouteVersions und gepinnte Timetable-/Turnaround-/Transfer-Routen laufen auseinander.",
  );
  invariant(
    report.counts.candidate.interlockingRoutes
      === report.counts.source.timetableLegs
        + report.counts.provenance.turnaroundInterlockingRoutes
        + report.counts.provenance.transferInterlockingRoutes,
    "Gesamtfahrstrassen und gepinnte Timetable-/Turnaround-/Transfer-Legs laufen auseinander.",
  );
  invariant(report.counts.provenance.syntheticBoundarySignals === report.counts.source.timetableLegs, "Synthetische Grenzsignale und gepinnte timetableRoute-Legs laufen auseinander.");
  invariant(
    report.counts.provenance.transferRouteVersions === report.counts.source.transferDemands
      && report.counts.candidate.transferTemplates
        === report.counts.source.transferDemands * report.policy.spec.terminalFormationLengthsMm.length,
    "Transfer-Routenversionen oder formationsspezifische Templates laufen von den Transferanforderungen weg.",
  );
  invariant(
    report.counts.candidate.directTemplates + report.counts.candidate.stablingTemplates
      >= report.counts.source.turnaroundPairs * report.policy.spec.terminalFormationLengthsMm.length,
    "Nicht jedes Turnaround-Paar besitzt formationsspezifische Direct-/Stabling-Kontinuitaet.",
  );
  invariant(typeof report.policy?.spec?.rzueLayoutId === "string" && report.policy.spec.rzueLayoutId !== "", "Nativer Bericht besitzt kein gebundenes RZUE-Layout.");
  return {
    blockResources: report.counts.candidate.blockResources,
    directedEdges: report.counts.candidate.directedEdges,
    edgeGeometries: report.counts.candidate.edgeGeometries,
    interlockingRoutes: report.counts.candidate.interlockingRoutes,
    platformIntervals: report.counts.candidate.platformIntervals,
    regionBoundaries: report.counts.candidate.regionBoundaries,
    routeVersions: report.counts.candidate.routeVersions,
    rzueLayouts: 1,
    signals: report.counts.candidate.signals,
    switches: report.counts.candidate.switches,
  };
}

export function validateSyntheticOperationalDerivationReport(report, { releaseId, annualSpecification, annualSpecificationProof, inputBindings, candidate }) {
  exactKeys(report, ["schema", "mode", "infraReleaseId", "policy", "inputs", "candidate", "timetableRouteEvidence", "counts", "scope", "routeCoverage", "activationEligible", "unresolvedRequired", "unresolvedRequiredDimensions", "realInterlockingFactsClaimed", "realGeometry", "simulatedOperationalAssignment", "candidateProduced"], "Nativer Deutschland-Operational-v2-Bericht");
  invariant(report.schema === DERIVATION_REPORT_SCHEMA && report.mode === DERIVATION_MODE, "Nativer Deutschland-Operational-v2-Bericht verletzt Schema oder Modus.");
  invariant(report.infraReleaseId === releaseId, "Nativer Deutschland-Operational-v2-Bericht verletzt die Releasebindung.");
  invariant(report.activationEligible === true && report.unresolvedRequired === 0 && Array.isArray(report.unresolvedRequiredDimensions) && report.unresolvedRequiredDimensions.length === 0, "Nativer Deutschland-Operational-v2-Bericht ist nicht vollstaendig geschlossen.");
  invariant(report.routeCoverage === COMPLETE_ROUTE_COVERAGE && report.candidateProduced === true, "Nativer Deutschland-Operational-v2-Bericht besitzt keine vollstaendige gepinnte Fahrwegabdeckung.");
  invariant(
    report.realInterlockingFactsClaimed === false
      && report.realGeometry === true
      && report.simulatedOperationalAssignment === true,
    "Nativer Deutschland-Operational-v2-Bericht verletzt die ehrliche Geometrie-/Simulationsgrenze.",
  );
  exactKeys(report.policy, ["id", "sha256", "spec"], "Nativer Bericht.policy");
  invariant(report.policy.id === SYNTHETIC_OPERATIONAL_POLICY_ID && sameCanonical(report.policy.spec, annualSpecification.policy), "Nativer Bericht wiederholt eine abweichende Compilerpolicy.");
  invariant(report.policy.sha256 === syntheticOperationalSha256(annualSpecification.policy), "Nativer Bericht besitzt keinen kanonischen Compilerpolicy-Hash.");
  exactKeys(report.inputs, REPORT_INPUT_NAMES, "Nativer Bericht.inputs");
  validateReportInputEvidence(report.inputs.spec, "Nativer Bericht.inputs.spec");
  invariant(
    report.inputs.spec.path === basename(annualSpecificationProof.file)
      && report.inputs.spec.bytes === annualSpecificationProof.bytes
      && report.inputs.spec.sha256 === annualSpecificationProof.sha256
      && report.inputs.spec.records === 1,
    "Nativer Bericht bindet nicht dieselbe eingecheckte Jahresspezifikation.",
  );
  const byRole = new Map(inputBindings.map((entry) => [entry.role, entry]));
  for (const role of DERIVATION_INPUT_ROLES) {
    const name = DERIVATION_ROLE_TO_LAYER[role];
    const evidence = report.inputs[name];
    validateReportInputEvidence(evidence, `Nativer Bericht.inputs.${name}`);
    const expected = byRole.get(role);
    invariant(expected !== undefined, `Closure-Input ${role} fehlt.`);
    const configuredLayer = annualSpecification.layers[name];
    const configuredPath = name === "transferDemands" ? configuredLayer?.path : configuredLayer;
    invariant(typeof configuredPath === "string" && configuredPath !== "", `Jahresspezifikation.layers.${name} besitzt keinen geschlossenen Dateipfad.`);
    invariant(
      evidence.path.replaceAll("\\", "/") === configuredPath.replaceAll("\\", "/")
        && evidence.bytes === expected.bytes
        && evidence.sha256 === expected.sha256
        && evidence.records === expected.records,
      `Nativer Bericht bindet nicht dieselben Bytes und Records fuer ${role}.`,
    );
  }
  exactKeys(report.candidate, ["bytes", "sha256", "stateHash", "validationMode", "movementRouteTemplates"], "Nativer Bericht.candidate");
  invariant(
    report.candidate.bytes === candidate.bytes
      && report.candidate.sha256 === candidate.sha256
      && report.candidate.stateHash === candidate.stateHash
      && report.candidate.validationMode === NATIVE_MODE,
    "Nativer Bericht bindet nicht denselben validierten Candidate.",
  );
  validateNativeTimetableRouteEvidence(report.timetableRouteEvidence, report);
  exactKeys(report.scope, [
    "routeModel", "interlockingModel", "platformModel", "capacityBias", "minimumOverlapMmPolicy",
    "turnaroundModel", "minimumBerthEndClearanceMmPolicy", "maximumStablingPathEdgesPolicy",
    "maximumStablingPathLengthMmPolicy", "simulatedOperationalBerthFallbackPolicy", "maximumDirectDwellMsPolicy",
    "terminalFormationLengthsMm", "movementRouteTemplateModel",
  ], "Nativer Bericht.scope");
  invariant(
    report.scope.routeModel === COMPLETE_ROUTE_COVERAGE
      && report.scope.interlockingModel === FULL_ROUTE_INTERLOCKING_MODEL
      && report.scope.platformModel === "deterministic-nearest-observed-track-within-policy-radius/v1"
      && report.scope.capacityBias === "conservative-under-capacity",
    "Nativer Bericht verletzt Fahrweg-, Gesamtfahrstrassen- oder Kapazitaetsscope.",
  );
  invariant(
    report.scope.minimumOverlapMmPolicy === annualSpecification.policy.minimumOverlapMm
      && report.scope.turnaroundModel === TURNAROUND_MODEL
      && report.scope.minimumBerthEndClearanceMmPolicy === annualSpecification.policy.minimumBerthEndClearanceMm
      && report.scope.maximumStablingPathEdgesPolicy === annualSpecification.policy.maximumStablingPathEdges
      && report.scope.maximumStablingPathLengthMmPolicy === annualSpecification.policy.maximumStablingPathLengthMm
      && report.scope.simulatedOperationalBerthFallbackPolicy === annualSpecification.policy.simulatedOperationalBerthFallback
      && report.scope.maximumDirectDwellMsPolicy === annualSpecification.policy.maximumDirectDwellMs
      && sameCanonical(report.scope.terminalFormationLengthsMm, annualSpecification.policy.terminalFormationLengthsMm)
      && report.scope.movementRouteTemplateModel === MOVEMENT_ROUTE_TEMPLATE_MODEL,
    "Nativer Bericht wiederholt abweichende Overlap-, Turnaround-Such- oder Movement-Template-Policies.",
  );
  invariant(
    report.counts.source.timetableRoutes === report.timetableRouteEvidence.timetableRoutes.records
      && report.counts.source.transferDemands === report.timetableRouteEvidence.transferDemandCount
      && report.counts.source.transferLots === report.timetableRouteEvidence.transferLotCount
      && report.counts.source.turnaroundDemands === report.timetableRouteEvidence.turnaroundDemandCount
      && report.counts.source.turnaroundPairs === report.timetableRouteEvidence.turnaroundPairCount,
    "Nativer Bericht zaehlt in Inputs, Tagesplan und Source-Coverage verschiedene Fahrplananforderungen.",
  );
  const coverage = coverageFromSyntheticOperationalDerivationReport(report);
  validateCoverage(coverage);
  return coverage;
}

function validateDerivationBinding(binding, candidate, timetableRouteEvidence) {
  fileBinding(binding, "derivationReport", [
    "schema", "mode", "routeCoverage", "activationEligible", "unresolvedRequired", "realInterlockingFactsClaimed",
    "realGeometry", "simulatedOperationalAssignment", "candidate", "timetableRouteEvidence",
  ]);
  invariant(binding.schema === DERIVATION_REPORT_SCHEMA && binding.mode === DERIVATION_MODE && binding.routeCoverage === COMPLETE_ROUTE_COVERAGE, "Closure-Receipt bindet keinen vollstaendigen nativen Ableitungsbericht.");
  invariant(
    binding.activationEligible === true
      && binding.unresolvedRequired === 0
      && binding.realInterlockingFactsClaimed === false
      && binding.realGeometry === true
      && binding.simulatedOperationalAssignment === true,
    "Closure-Receipt bindet keinen geschlossenen ehrlichen Ableitungsbericht.",
  );
  exactKeys(binding.candidate, ["bytes", "sha256", "stateHash", "validationMode", "movementRouteTemplates"], "derivationReport.candidate");
  invariant(
    binding.candidate.bytes === candidate.bytes
      && binding.candidate.sha256 === candidate.sha256
      && binding.candidate.stateHash === candidate.stateHash
      && binding.candidate.validationMode === NATIVE_MODE,
    "Closure-Receipt und Ableitungsbericht binden verschiedene Candidates.",
  );
  exactKeys(binding.timetableRouteEvidence, [
    "timetableRoutes", "transferDemands", "dailyPlanSha256", "transferSetSha256", "circulationCount",
    "plannedTransitionCount", "transferDemandCount", "transferLotCount", "turnaroundDemandCount", "turnaroundPairCount",
    "movementRouteTemplates",
  ], "derivationReport.timetableRouteEvidence");
  validateReportInputEvidence(binding.timetableRouteEvidence.timetableRoutes, "derivationReport.timetableRouteEvidence.timetableRoutes");
  validateReportInputEvidence(binding.timetableRouteEvidence.transferDemands, "derivationReport.timetableRouteEvidence.transferDemands");
  for (const field of ["turnaroundDemandCount", "turnaroundPairCount"]) {
    nonNegativeInteger(binding.timetableRouteEvidence[field], `derivationReport.timetableRouteEvidence.${field}`);
  }
  const movement = validateMovementRouteTemplatesEvidence(binding.candidate.movementRouteTemplates, {
    operationalStateHash: candidate.stateHash,
    transferSetSha256: binding.timetableRouteEvidence.transferSetSha256,
  }, "derivationReport.candidate.movementRouteTemplates");
  invariant(sameCanonical(movement, binding.timetableRouteEvidence.movementRouteTemplates), "Closure-Receipt bindet zwei verschiedene Movement-Route-Templates-Nachweise.");
  invariant(
    binding.timetableRouteEvidence.dailyPlanSha256 === timetableRouteEvidence.dailyCirculationPlanSha256
      && binding.timetableRouteEvidence.transferSetSha256 === timetableRouteEvidence.transferSetSha256
      && binding.timetableRouteEvidence.transferDemands.bytes === timetableRouteEvidence.transferDemandsBytes
      && binding.timetableRouteEvidence.transferDemands.sha256 === timetableRouteEvidence.transferDemandsSha256
      && binding.timetableRouteEvidence.circulationCount === timetableRouteEvidence.dailyCirculation.circulationCount
      && binding.timetableRouteEvidence.plannedTransitionCount === timetableRouteEvidence.dailyCirculation.plannedTransitionCount
      && binding.timetableRouteEvidence.transferDemandCount === timetableRouteEvidence.transferRouteCount
      && binding.timetableRouteEvidence.transferLotCount === timetableRouteEvidence.dailyCirculation.transferLotCount
      && binding.timetableRouteEvidence.turnaroundDemandCount === timetableRouteEvidence.dailyCirculation.turnaroundDemandCount,
    "Closure-Receipt und nativer Bericht binden verschiedene Tagesplan-/Transfer-Nachweise.",
  );
}

function sha256Proof(value, label) {
  exactKeys(value, ["bytes", "sha256"], label);
  positiveInteger(value.bytes, `${label}.bytes`);
  invariant(SHA256.test(value.sha256), `${label}.sha256 ist ungueltig.`);
  return value;
}

function nonEmptyString(value, label) {
  invariant(typeof value === "string" && value.trim() === value && value !== "", `${label} ist keine nichtleere randfreie Zeichenkette.`);
  return value;
}

function exactNonEmptyStrings(value, label, { allowEmpty = false } = {}) {
  invariant(Array.isArray(value) && (allowEmpty || value.length > 0), `${label} ist keine ${allowEmpty ? "" : "nichtleere "}Kennungsliste.`);
  for (const [index, entry] of value.entries()) nonEmptyString(entry, `${label}[${index}]`);
  invariant(new Set(value).size === value.length, `${label} enthaelt Duplikate.`);
  return value;
}

function validateDailyCirculationMetrics(value, label) {
  exactKeys(value, DAILY_CIRCULATION_METRIC_KEYS, label);
  for (const field of ["lotCount", "journeyChainCount", "circulationCount", "rolloverAssignmentCount", "plannedTransitionCount"]) {
    positiveInteger(value[field], `${label}.${field}`);
  }
  for (const field of ["turnaroundDemandCount", "transferDemandCount", "transferLotCount"]) nonNegativeInteger(value[field], `${label}.${field}`);
  invariant(
    value.turnaroundDemandCount + value.transferDemandCount === value.plannedTransitionCount
      && value.plannedTransitionCount === value.journeyChainCount,
    `${label} partitioniert die geplanten Uebergaenge nicht vollstaendig.`,
  );
  invariant(value.transferLotCount <= value.lotCount, `${label} besitzt mehr Transferlose als Lose.`);
  invariant(value.rolloverAssignmentCount === value.circulationCount, `${label} bindet nicht genau einen Rollover je Umlauf.`);
  return value;
}

function validateCirculationEndpoint(value, label) {
  exactKeys(value, ["legId", "passengerRouteVersionId", "locationId", "physicalStopId", "timeS"], label);
  for (const field of ["legId", "passengerRouteVersionId", "locationId", "physicalStopId"]) nonEmptyString(value[field], `${label}.${field}`);
  invariant(value.passengerRouteVersionId === `route:gtfs:${value.legId}:v1`, `${label} besitzt keine deterministische Passenger-Routenidentitaet.`);
  nonNegativeInteger(value.timeS, `${label}.timeS`);
  return value;
}

const DAILY_TRANSITION_DEMAND_KEYS = Object.freeze([
  "id",
  "lotId",
  "assetCompatibilityKey",
  "sourceCirculationId",
  "targetCirculationId",
  "sourcePassengerLegId",
  "targetPassengerLegId",
  "sourcePassengerRouteVersionId",
  "targetPassengerRouteVersionId",
  "sourceLocationId",
  "targetLocationId",
  "sourcePhysicalStopId",
  "targetPhysicalStopId",
  "earliestDepartureS",
  "latestArrivalS",
  "availableWindowS",
  "dailyBoundary",
]);
const DAILY_TURNAROUND_DEMAND_KEYS = DAILY_TRANSITION_DEMAND_KEYS;
const DAILY_TRANSFER_DEMAND_KEYS = Object.freeze([
  ...DAILY_TRANSITION_DEMAND_KEYS,
  "movementKind",
]);
const TRANSFER_ROUTE_KEYS = Object.freeze([
  ...DAILY_TRANSFER_DEMAND_KEYS,
  "formationLengthsMm",
  "routeVersionId",
  "templateId",
  "legs",
  "totalLengthMm",
  "weightedCostMm",
  "minimumRuntimeMs",
]);

function sameOrderedStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
}

function dailyPlanSha256(plan) {
  const body = { ...plan };
  delete body.planSha256;
  return syntheticOperationalSha256({ schema: DAILY_CIRCULATION_PLAN_SCHEMA, value: body });
}

/**
 * Validiert den kompletten v2-Transfer-Sidecar semantisch. Die Rueckgabe ist
 * absichtlich klein: Closure und Downstream-Gates transportieren nur
 * reproduzierte Hashes, Dateibeweise und gepruefte Zaehler weiter.
 */
export function validateSyntheticOperationalTimetableTransferDemands({
  releaseId,
  transferDemands,
  transferDemandsBinding,
  routeReport,
  timetableRoutesProof,
  gtfsSnapshot = null,
}) {
  exactKeys(transferDemands, [
    "schema",
    "infraReleaseId",
    "gtfsSnapshotHash",
    "dailyPlan",
    "formationLengthsMm",
    "transferRoutes",
    "transferSetSha256",
  ], "Timetable-Transfer-Demands");
  invariant(
    transferDemands.schema === GERMANY_TIMETABLE_TRANSFER_DEMAND_SCHEMA
      && transferDemands.infraReleaseId === releaseId
      && transferDemands.gtfsSnapshotHash === routeReport.gtfsBinding?.snapshotHash,
    "Timetable-Transfer-Demands verletzt Schema, Release- oder GTFS-Snapshot-Bindung.",
  );
  fileBinding(transferDemandsBinding, "Timetable-Transfer-Demands-Input", ["role", "records"]);
  invariant(transferDemandsBinding.role === "timetable-transfer-demands", "Timetable-Transfer-Demands-Input besitzt eine falsche Rolle.");

  const formationLengthsMm = transferDemands.formationLengthsMm;
  invariant(
    Array.isArray(formationLengthsMm)
      && formationLengthsMm.length > 0
      && formationLengthsMm.every((length, index, values) => Number.isSafeInteger(length) && length > 0 && (index === 0 || values[index - 1] < length)),
    "Timetable-Transfer-Demands.formationLengthsMm ist nicht streng aufsteigend und positiv.",
  );

  const plan = transferDemands.dailyPlan;
  exactKeys(plan, [
    "schema",
    "rule",
    "gtfsReleaseId",
    "repeatEveryS",
    "minimumTurnaroundS",
    "metrics",
    "circulations",
    "rolloverAssignments",
    "turnaroundDemands",
    "transferDemands",
    "planSha256",
  ], "Timetable-Transfer-Demands.dailyPlan");
  invariant(
    plan.schema === DAILY_CIRCULATION_PLAN_SCHEMA
      && plan.rule === DAILY_CIRCULATION_RULE
      && plan.repeatEveryS === DAILY_CIRCULATION_REPEAT_EVERY_S
      && plan.minimumTurnaroundS === DAILY_CIRCULATION_MINIMUM_TURNAROUND_S
      && nonEmptyString(plan.gtfsReleaseId, "Timetable-Transfer-Demands.dailyPlan.gtfsReleaseId") !== "",
    "Timetable-Transfer-Demands.dailyPlan verletzt Schema, Regel oder Tagesperiodenvertrag.",
  );
  invariant(SHA256.test(plan.planSha256) && plan.planSha256 === dailyPlanSha256(plan), "Timetable-Transfer-Demands.dailyPlan.planSha256 ist nicht reproduzierbar.");
  const metrics = validateDailyCirculationMetrics(plan.metrics, "Timetable-Transfer-Demands.dailyPlan.metrics");
  invariant(Array.isArray(plan.circulations) && plan.circulations.length === metrics.circulationCount, "Daily-Circulation-Umlaufzahl driftet von den Metriken.");
  invariant(Array.isArray(plan.rolloverAssignments) && plan.rolloverAssignments.length === metrics.rolloverAssignmentCount, "Daily-Circulation-Rolloverzahl driftet von den Metriken.");
  invariant(Array.isArray(plan.turnaroundDemands) && plan.turnaroundDemands.length === metrics.turnaroundDemandCount, "Daily-Circulation-Turnaroundzahl driftet von den Metriken.");
  invariant(Array.isArray(plan.transferDemands) && plan.transferDemands.length === metrics.transferDemandCount, "Daily-Circulation-Transferzahl driftet von den Metriken.");

  const circulationById = new Map();
  const allJourneyChainIds = new Set();
  const allPassengerLegIds = new Set();
  const allPassengerTrainRunIds = new Set();
  let previousCirculationId = null;
  for (const [index, circulation] of plan.circulations.entries()) {
    const label = `Timetable-Transfer-Demands.dailyPlan.circulations[${index}]`;
    exactKeys(circulation, [
      "id", "lotId", "serviceLineId", "assetCompatibilityKey", "journeyChainIds", "passengerLegIds",
      "passengerTrainRunIds", "start", "end",
    ], label);
    for (const field of ["id", "lotId", "serviceLineId", "assetCompatibilityKey"]) nonEmptyString(circulation[field], `${label}.${field}`);
    invariant(circulation.assetCompatibilityKey === circulation.lotId, `${label} driftet zwischen Los und Fahrzeugkompatibilitaet.`);
    exactNonEmptyStrings(circulation.journeyChainIds, `${label}.journeyChainIds`);
    exactNonEmptyStrings(circulation.passengerLegIds, `${label}.passengerLegIds`);
    exactNonEmptyStrings(circulation.passengerTrainRunIds, `${label}.passengerTrainRunIds`);
    invariant(circulation.passengerLegIds.length === circulation.passengerTrainRunIds.length, `${label} bindet Legs und physische Zuglaeufe nicht 1:1.`);
    const start = validateCirculationEndpoint(circulation.start, `${label}.start`);
    const end = validateCirculationEndpoint(circulation.end, `${label}.end`);
    invariant(start.legId === circulation.passengerLegIds[0] && end.legId === circulation.passengerLegIds.at(-1), `${label} driftet zwischen Passenger-Legs und Endpunkten.`);
    invariant(previousCirculationId === null || compareText(previousCirculationId, circulation.id) < 0, "Daily-Circulation-Umlaeufe sind nicht streng nach ID sortiert.");
    previousCirculationId = circulation.id;
    invariant(!circulationById.has(circulation.id), `Daily-Circulation-Umlauf ${circulation.id} ist doppelt.`);
    circulationById.set(circulation.id, circulation);
    for (const journeyChainId of circulation.journeyChainIds) invariant(!allJourneyChainIds.has(journeyChainId) && allJourneyChainIds.add(journeyChainId), `JourneyChain ${journeyChainId} ist mehreren Umlaeufen zugeordnet.`);
    for (const passengerLegId of circulation.passengerLegIds) invariant(!allPassengerLegIds.has(passengerLegId) && allPassengerLegIds.add(passengerLegId), `Passenger-Leg ${passengerLegId} ist mehreren Umlaeufen zugeordnet.`);
    for (const trainRunId of circulation.passengerTrainRunIds) invariant(!allPassengerTrainRunIds.has(trainRunId) && allPassengerTrainRunIds.add(trainRunId), `Passenger-TrainRun ${trainRunId} ist mehreren Umlaeufen zugeordnet.`);
  }
  invariant(allJourneyChainIds.size === metrics.journeyChainCount, "Daily-Circulation-JourneyChain-Zahl driftet von den Metriken.");
  invariant(new Set(plan.circulations.map(({ lotId }) => lotId)).size === metrics.lotCount, "Daily-Circulation-Loszahl driftet von den Metriken.");

  invariant(allJourneyChainIds.size === metrics.plannedTransitionCount, "Daily-Circulation-Zahl geplanter Uebergaenge driftet von den JourneyChains.");

  const endpointByLegId = new Map();
  const endpointByJourneyChainId = new Map();
  if (gtfsSnapshot !== null) {
    invariant(Array.isArray(gtfsSnapshot?.journeyChains), "Timetable-Transfer-Demands brauchen fuer die vollstaendige Semantikpruefung den gebundenen GTFS-Snapshot.");
    for (const chain of gtfsSnapshot.journeyChains) {
      if (chain?.orderable !== true || !Array.isArray(chain.legs)) continue;
      const playableLegs = chain.legs.filter((entry) => entry?.kind === "playable");
      for (const leg of playableLegs) {
        invariant(Array.isArray(leg.stops) && leg.stops.length > 0, `${leg?.legId ?? "PlayableLeg"} besitzt keine Stopfolge.`);
        const sourceStop = leg.stops[0];
        const targetStop = leg.stops.at(-1);
        const legId = nonEmptyString(leg.legId, "GTFS-PlayableLeg.legId");
        invariant(!endpointByLegId.has(legId), `GTFS-PlayableLeg ${legId} ist doppelt.`);
        endpointByLegId.set(legId, Object.freeze({
          start: Object.freeze({
            legId,
            passengerRouteVersionId: `route:gtfs:${legId}:v1`,
            locationId: leg.entryPortalId ?? sourceStop.stopId,
            physicalStopId: sourceStop.stopId,
            timeS: sourceStop.departureS,
          }),
          end: Object.freeze({
            legId,
            passengerRouteVersionId: `route:gtfs:${legId}:v1`,
            locationId: leg.exitPortalId ?? targetStop.stopId,
            physicalStopId: targetStop.stopId,
            timeS: targetStop.arrivalS,
          }),
        }));
      }
      invariant(playableLegs.length > 0, `${chain.journeyChainId} besitzt kein spielbares Segment.`);
      endpointByJourneyChainId.set(chain.journeyChainId, Object.freeze({
        start: endpointByLegId.get(playableLegs[0].legId).start,
        end: endpointByLegId.get(playableLegs.at(-1).legId).end,
      }));
    }
    invariant(endpointByLegId.size === allPassengerLegIds.size, "GTFS-Snapshot und DailyPlan besitzen verschiedene Passenger-Leg-Mengen.");
    for (const legId of allPassengerLegIds) invariant(endpointByLegId.has(legId), `DailyPlan-Leg ${legId} fehlt im gebundenen GTFS-Snapshot.`);
    invariant(endpointByJourneyChainId.size === allJourneyChainIds.size, "GTFS-Snapshot und DailyPlan besitzen verschiedene JourneyChain-Mengen.");
    for (const chainId of allJourneyChainIds) invariant(endpointByJourneyChainId.has(chainId), `DailyPlan-JourneyChain ${chainId} fehlt im gebundenen GTFS-Snapshot.`);
  }

  const expectedTransitions = new Map();
  const addExpectedTransition = ({ source, target, sourceLegId, targetLegId, dailyBoundary }) => {
    const key = `${sourceLegId}\u0000${targetLegId}\u0000${dailyBoundary ? "1" : "0"}`;
    invariant(!expectedTransitions.has(key), `Daily-Circulation-Uebergang ${key} ist doppelt geplant.`);
    expectedTransitions.set(key, Object.freeze({
      source,
      target,
      sourceEndpoint: endpointByLegId.get(sourceLegId)?.end ?? (dailyBoundary ? source.end : null),
      targetEndpoint: endpointByLegId.get(targetLegId)?.start ?? (dailyBoundary ? target.start : null),
      dailyBoundary,
    }));
  };
  if (gtfsSnapshot !== null) {
    for (const circulation of plan.circulations) {
      for (let index = 0; index < circulation.journeyChainIds.length - 1; index += 1) {
        const sourceEndpoint = endpointByJourneyChainId.get(circulation.journeyChainIds[index]);
        const targetEndpoint = endpointByJourneyChainId.get(circulation.journeyChainIds[index + 1]);
        invariant(sourceEndpoint !== undefined && targetEndpoint !== undefined, `${circulation.id} referenziert einen unbekannten JourneyChain-Uebergang.`);
        addExpectedTransition({
          source: circulation,
          target: circulation,
          sourceLegId: sourceEndpoint.end.legId,
          targetLegId: targetEndpoint.start.legId,
          dailyBoundary: false,
        });
      }
    }
  }

  const rolloverSources = new Set();
  const rolloverTargets = new Set();
  let previousRolloverSource = null;
  for (const [index, rollover] of plan.rolloverAssignments.entries()) {
    const label = `Timetable-Transfer-Demands.dailyPlan.rolloverAssignments[${index}]`;
    exactKeys(rollover, ["sourceCirculationId", "targetCirculationId", "kind"], label);
    const sourceId = nonEmptyString(rollover.sourceCirculationId, `${label}.sourceCirculationId`);
    const targetId = nonEmptyString(rollover.targetCirculationId, `${label}.targetCirculationId`);
    invariant(rollover.kind === "same-location" || rollover.kind === "transfer", `${label}.kind ist unbekannt.`);
    const source = circulationById.get(sourceId);
    const target = circulationById.get(targetId);
    invariant(source !== undefined && target !== undefined, `${label} bindet einen unbekannten Umlauf.`);
    invariant(source.lotId === target.lotId, `${label} ueberschreitet die Losgrenze.`);
    invariant(!rolloverSources.has(sourceId) && !rolloverTargets.has(targetId), "Daily-Circulation-Rollover ist keine eindeutige Permutation.");
    rolloverSources.add(sourceId);
    rolloverTargets.add(targetId);
    invariant(previousRolloverSource === null || compareText(previousRolloverSource, sourceId) < 0, "Daily-Circulation-Rollover sind nicht streng nach Quell-ID sortiert.");
    previousRolloverSource = sourceId;
    const sameLocation = source.end.locationId === target.start.locationId
      && source.end.physicalStopId === target.start.physicalStopId;
    invariant((rollover.kind === "same-location") === sameLocation, `${label} klassifiziert den physischen Ortswechsel falsch.`);
    addExpectedTransition({
      source,
      target,
      sourceLegId: source.passengerLegIds.at(-1),
      targetLegId: target.passengerLegIds[0],
      dailyBoundary: true,
    });
  }
  invariant(rolloverSources.size === circulationById.size && rolloverTargets.size === circulationById.size, "Daily-Circulation-Rollover ist keine vollstaendige Permutation.");
  if (gtfsSnapshot !== null) invariant(expectedTransitions.size === metrics.plannedTransitionCount, "Daily-Circulation bildet nicht jeden JourneyChain-Uebergang genau einmal ab.");

  const dailyDemandById = new Map();
  const classifiedTransitions = new Set();
  const validateDemand = (demand, { kind, label, previousId }) => {
    exactKeys(demand, kind === "transfer" ? DAILY_TRANSFER_DEMAND_KEYS : DAILY_TURNAROUND_DEMAND_KEYS, label);
    for (const field of [
      "id", "lotId", "assetCompatibilityKey", "sourceCirculationId", "targetCirculationId",
      "sourcePassengerLegId", "targetPassengerLegId", "sourcePassengerRouteVersionId", "targetPassengerRouteVersionId",
      "sourceLocationId", "targetLocationId", "sourcePhysicalStopId", "targetPhysicalStopId",
    ]) nonEmptyString(demand[field], `${label}.${field}`);
    invariant(typeof demand.dailyBoundary === "boolean", `${label}.dailyBoundary ist nicht boolesch.`);
    if (kind === "transfer") invariant(demand.movementKind === "train", `${label}.movementKind ist kein physischer Zuglauf.`);
    invariant(demand.id.startsWith(`${kind}-`) && /^[a-z]+-[a-f0-9]{64}$/u.test(demand.id), `${label}.id verletzt den v2-${kind}-Identitaetsvertrag.`);
    const source = circulationById.get(demand.sourceCirculationId);
    const target = circulationById.get(demand.targetCirculationId);
    invariant(source !== undefined && target !== undefined, `${label} bindet einen unbekannten Umlauf.`);
    invariant(
      demand.dailyBoundary
        || (source === target
          && source.passengerLegIds.includes(demand.sourcePassengerLegId)
          && source.passengerLegIds.includes(demand.targetPassengerLegId)),
      `${label} verletzt die interne Umlaufbindung.`,
    );
    const transitionKey = `${demand.sourcePassengerLegId}\u0000${demand.targetPassengerLegId}\u0000${demand.dailyBoundary ? "1" : "0"}`;
    const expected = expectedTransitions.get(transitionKey);
    invariant((expected !== undefined || (gtfsSnapshot === null && demand.dailyBoundary === false)) && !classifiedTransitions.has(transitionKey), `${label} besitzt keinen eindeutigen geplanten Uebergang.`);
    classifiedTransitions.add(transitionKey);
    invariant(
      (expected === undefined || (source === expected.source && target === expected.target))
        && demand.lotId === source.lotId && demand.lotId === target.lotId
        && demand.assetCompatibilityKey === source.assetCompatibilityKey && demand.assetCompatibilityKey === target.assetCompatibilityKey
        && demand.sourcePassengerRouteVersionId === `route:gtfs:${demand.sourcePassengerLegId}:v1`
        && demand.targetPassengerRouteVersionId === `route:gtfs:${demand.targetPassengerLegId}:v1`,
      `${label} driftet von seinem geplanten Umlauf- oder Passenger-Routen-Uebergang.`,
    );
    const sourceEndpoint = expected?.sourceEndpoint ?? null;
    const targetEndpoint = expected?.targetEndpoint ?? null;
    if (sourceEndpoint !== null && targetEndpoint !== null) {
      invariant(
        demand.sourceLocationId === sourceEndpoint.locationId && demand.targetLocationId === targetEndpoint.locationId
          && demand.sourcePhysicalStopId === sourceEndpoint.physicalStopId && demand.targetPhysicalStopId === targetEndpoint.physicalStopId
          && demand.sourcePassengerRouteVersionId === sourceEndpoint.passengerRouteVersionId
          && demand.targetPassengerRouteVersionId === targetEndpoint.passengerRouteVersionId,
        `${label} driftet von den gebundenen physischen Passenger-Endpunkten.`,
      );
    }
    const samePhysicalEndpoint = demand.sourceLocationId === demand.targetLocationId
      && demand.sourcePhysicalStopId === demand.targetPhysicalStopId;
    invariant((kind === "turnaround") === samePhysicalEndpoint, `${label} klassifiziert Turnaround und physischen Transfer falsch.`);
    invariant(
      Number.isSafeInteger(demand.earliestDepartureS)
        && Number.isSafeInteger(demand.latestArrivalS)
        && Number.isSafeInteger(demand.availableWindowS)
        && demand.availableWindowS === demand.latestArrivalS - demand.earliestDepartureS
        && demand.availableWindowS > 0,
      `${label} besitzt kein positives ganzzahliges Uebergangszeitfenster.`,
    );
    if (sourceEndpoint !== null && targetEndpoint !== null) {
      const targetOccurrenceS = targetEndpoint.timeS + (demand.dailyBoundary ? plan.repeatEveryS : 0);
      const expectedEarliestS = sourceEndpoint.timeS + (kind === "transfer" ? plan.minimumTurnaroundS : 0);
      const expectedLatestS = targetOccurrenceS - (kind === "transfer" ? plan.minimumTurnaroundS : 0);
      invariant(
        demand.earliestDepartureS === expectedEarliestS && demand.latestArrivalS === expectedLatestS,
        `${label} besitzt kein aus dem GTFS-Uebergang reproduzierbares Zeitfenster.`,
      );
      if (kind === "turnaround") invariant(demand.availableWindowS >= plan.minimumTurnaroundS, `${label} unterschreitet die Mindestwendezeit.`);
    }
    invariant(previousId === null || compareText(previousId, demand.id) < 0, `Daily-Circulation-${kind}-Anforderungen sind nicht streng nach ID sortiert.`);
    invariant(!dailyDemandById.has(demand.id), `Daily-Circulation-Anforderung ${demand.id} ist doppelt.`);
    dailyDemandById.set(demand.id, demand);
    return demand.id;
  };
  let previousTurnaroundId = null;
  for (const [index, demand] of plan.turnaroundDemands.entries()) {
    previousTurnaroundId = validateDemand(demand, {
      kind: "turnaround",
      label: `Timetable-Transfer-Demands.dailyPlan.turnaroundDemands[${index}]`,
      previousId: previousTurnaroundId,
    });
  }
  let previousDemandId = null;
  for (const [index, demand] of plan.transferDemands.entries()) {
    previousDemandId = validateDemand(demand, {
      kind: "transfer",
      label: `Timetable-Transfer-Demands.dailyPlan.transferDemands[${index}]`,
      previousId: previousDemandId,
    });
  }
  if (gtfsSnapshot !== null) invariant(classifiedTransitions.size === expectedTransitions.size, "Daily-Circulation partitioniert nicht jeden internen und taeglichen Grenzuebergang genau einmal.");
  invariant(dailyDemandById.size === metrics.plannedTransitionCount, "Daily-Circulation-Anforderungszahl driftet von den geplanten Uebergaengen.");
  invariant(new Set(plan.transferDemands.map(({ lotId }) => lotId)).size === metrics.transferLotCount, "Daily-Circulation-Transferloszahl driftet von den Metriken.");

  invariant(Array.isArray(transferDemands.transferRoutes) && transferDemands.transferRoutes.length === metrics.transferDemandCount, "Timetable-Transfer-Routen decken die Anforderungen nicht 1:1 ab.");
  const passengerRouteIds = new Set(timetableRoutesProof.segmentIds.map((segmentId) => `route:gtfs:${segmentId}:v1`));
  const transferSet = createHash("sha256");
  let routeLegCount = 0;
  let routeLengthMm = 0;
  let previousTransferId = null;
  for (const [index, route] of transferDemands.transferRoutes.entries()) {
    const label = `Timetable-Transfer-Demands.transferRoutes[${index}]`;
    exactKeys(route, TRANSFER_ROUTE_KEYS, label);
    const demand = dailyDemandById.get(route.id);
    invariant(demand !== undefined, `${label} besitzt keine Daily-Plan-Anforderung.`);
    for (const field of DAILY_TRANSFER_DEMAND_KEYS) invariant(sameCanonical(route[field], demand[field]), `${label}.${field} driftet vom DailyPlan.`);
    invariant(sameOrderedStrings(route.formationLengthsMm, formationLengthsMm), `${label}.formationLengthsMm driftet vom Sidecar-Vertrag.`);
    invariant(
      route.sourcePassengerRouteVersionId === `route:gtfs:${route.sourcePassengerLegId}:v1`
        && route.targetPassengerRouteVersionId === `route:gtfs:${route.targetPassengerLegId}:v1`
        && passengerRouteIds.has(route.sourcePassengerRouteVersionId)
        && passengerRouteIds.has(route.targetPassengerRouteVersionId),
      `${label} bindet keine existierenden Quell- und Ziel-Passagierfahrwege.`,
    );
    invariant(route.routeVersionId === `route:${route.id}:movement:v1` && route.templateId === `template:${route.id}:movement:v1`, `${label} besitzt keine deterministische Transferfahrwegidentitaet.`);
    invariant(Array.isArray(route.legs) && route.legs.length > 0, `${label} besitzt keinen realen gerichteten Transferfahrweg.`);
    let totalLengthMm = 0;
    for (const [legIndex, leg] of route.legs.entries()) {
      const legLabel = `${label}.legs[${legIndex}]`;
      exactKeys(leg, ["edgeId", "direction", "edgeEntryMm", "edgeExitMm", "availableProtectionSystems", "simultaneouslyRequiredProtectionSystems"], legLabel);
      nonEmptyString(leg.edgeId, `${legLabel}.edgeId`);
      invariant(leg.direction === "along" || leg.direction === "against", `${legLabel}.direction ist ungueltig.`);
      nonNegativeInteger(leg.edgeEntryMm, `${legLabel}.edgeEntryMm`);
      nonNegativeInteger(leg.edgeExitMm, `${legLabel}.edgeExitMm`);
      invariant((leg.direction === "along" && leg.edgeExitMm > leg.edgeEntryMm) || (leg.direction === "against" && leg.edgeEntryMm > leg.edgeExitMm), `${legLabel} besitzt kein positives richtungstreues Intervall.`);
      exactNonEmptyStrings(leg.availableProtectionSystems, `${legLabel}.availableProtectionSystems`);
      exactNonEmptyStrings(leg.simultaneouslyRequiredProtectionSystems, `${legLabel}.simultaneouslyRequiredProtectionSystems`, { allowEmpty: true });
      invariant(leg.simultaneouslyRequiredProtectionSystems.every((system) => leg.availableProtectionSystems.includes(system)), `${legLabel} verlangt ein nicht verfuegbares Zugsicherungssystem.`);
      totalLengthMm += Math.abs(leg.edgeExitMm - leg.edgeEntryMm);
      invariant(Number.isSafeInteger(totalLengthMm), `${label}.totalLengthMm ueberschreitet die sichere Ganzzahlgrenze.`);
    }
    positiveInteger(route.totalLengthMm, `${label}.totalLengthMm`);
    positiveInteger(route.weightedCostMm, `${label}.weightedCostMm`);
    positiveInteger(route.minimumRuntimeMs, `${label}.minimumRuntimeMs`);
    invariant(
      route.totalLengthMm === totalLengthMm
        && route.weightedCostMm >= route.totalLengthMm
        && route.minimumRuntimeMs <= route.availableWindowS * 1_000,
      `${label} besitzt eine inkonsistente Laenge, Gewichtung oder Mindestfahrzeit.`,
    );
    invariant(previousTransferId === null || compareText(previousTransferId, route.id) < 0, "Timetable-Transfer-Routen sind nicht streng nach ID sortiert.");
    previousTransferId = route.id;
    transferSet.update(`${canonicalSyntheticOperationalValue(route)}\n`);
    routeLegCount += route.legs.length;
    routeLengthMm += route.totalLengthMm;
    invariant(Number.isSafeInteger(routeLegCount) && Number.isSafeInteger(routeLengthMm), "Timetable-Transfer-Metriken ueberschreiten die sichere Ganzzahlgrenze.");
  }
  const transferSetSha256 = transferSet.digest("hex");
  invariant(SHA256.test(transferDemands.transferSetSha256) && transferDemands.transferSetSha256 === transferSetSha256, "Timetable-Transfer-Demands.transferSetSha256 ist nicht reproduzierbar.");
  invariant(transferDemandsBinding.records === transferDemands.transferRoutes.length, "Timetable-Transfer-Demands-Input bindet eine abweichende Recordzahl.");
  return Object.freeze({
    schema: transferDemands.schema,
    bytes: transferDemandsBinding.bytes,
    sha256: transferDemandsBinding.sha256,
    dailyCirculationPlanSha256: plan.planSha256,
    transferSetSha256,
    dailyCirculation: Object.freeze({ ...metrics }),
    transferRouteCount: transferDemands.transferRoutes.length,
    transferRouteLegCount: routeLegCount,
    transferRouteLengthMm: routeLengthMm,
  });
}

function containsExternalOperationalNetworkProvenance(value) {
  if (Array.isArray(value)) return value.some(containsExternalOperationalNetworkProvenance);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
    return (normalized.includes("operationalnetwork") && normalized !== "operationalnetworkused")
      || containsExternalOperationalNetworkProvenance(child);
  });
}

function validateTimetableRouteEvidenceBinding(evidence, inputBindings) {
  exactKeys(evidence, TIMETABLE_ROUTE_EVIDENCE_KEYS, "timetableRouteEvidence");
  invariant(evidence.reportSchema === GERMANY_TIMETABLE_ROUTE_REPORT_SCHEMA, "timetableRouteEvidence bindet keinen v4-Routenbericht mit vollstaendiger physischer Uebergangspartition.");
  invariant(evidence.policyId === TIMETABLE_ROUTE_POLICY_ID && evidence.policyId === SYNTHETIC_OPERATIONAL_POLICY_ID, "timetableRouteEvidence bindet nicht synthetic-operational-b/v2.");
  invariant(evidence.derivationRule === TIMETABLE_ROUTE_DERIVATION_RULE && evidence.selectionRule === TIMETABLE_ROUTE_SELECTION_RULE, "timetableRouteEvidence bindet abweichende GTFS-Fahrwegregeln.");
  invariant(evidence.transferDemandsSchema === GERMANY_TIMETABLE_TRANSFER_DEMAND_SCHEMA, "timetableRouteEvidence bindet keinen v2-Transfer-Sidecar.");
  for (const field of ["reportBytes", "routesBytes", "gtfsSnapshotBytes", "transferDemandsBytes"]) positiveInteger(evidence[field], `timetableRouteEvidence.${field}`);
  for (const field of [
    "reportSha256", "routesSha256", "gtfsSnapshotSha256", "transferDemandsSha256", "snapshotHash",
    "archiveSha256", "routeSetSha256", "dailyCirculationPlanSha256", "transferSetSha256",
  ]) {
    invariant(SHA256.test(evidence[field]), `timetableRouteEvidence.${field} ist ungueltig.`);
  }
  invariant(typeof evidence.archive === "string" && evidence.archive !== "", "timetableRouteEvidence.archive fehlt.");
  invariant(evidence.sourceLicense === "CC-BY-4.0" && evidence.sourceLicenseAsPublished === "CC BY 4.0", "timetableRouteEvidence besitzt nicht die freie CC-BY-4.0-Bindung.");
  for (const field of ["selectedSegmentCount", "completeRouteCount", "routeRecordCount"]) positiveInteger(evidence[field], `timetableRouteEvidence.${field}`);
  nonNegativeInteger(evidence.sameStopTransitionCount, "timetableRouteEvidence.sameStopTransitionCount");
  validateDailyCirculationMetrics(evidence.dailyCirculation, "timetableRouteEvidence.dailyCirculation");
  for (const field of ["transferRouteCount", "transferRouteLegCount", "transferRouteLengthMm"]) positiveInteger(evidence[field], `timetableRouteEvidence.${field}`);
  invariant(
    evidence.selectedSegmentCount === evidence.completeRouteCount && evidence.completeRouteCount === evidence.routeRecordCount,
    "timetableRouteEvidence besitzt keine vollstaendige 1:1-Segmentabdeckung.",
  );
  invariant(
    evidence.transferDemandsProduced === true
      && evidence.transferRouteCount === evidence.dailyCirculation.transferDemandCount,
    "timetableRouteEvidence besitzt keine vollstaendig erzeugte 1:1-Transferabdeckung.",
  );
  invariant(
    evidence.realGeometry === true
      && evidence.simulatedOperationalAssignment === true
      && evidence.realInterlockingFactsClaimed === false
      && evidence.externalOperationalNetworkProvenance === false,
    "timetableRouteEvidence behauptet erfundene Geometrie, reale Stellwerksfakten oder externe Operational-Network-Provenienz.",
  );
  const byRole = new Map(inputBindings.map((entry) => [entry.role, entry]));
  const report = byRole.get("timetable-route-report");
  const routes = byRole.get("timetable-routes");
  const snapshot = byRole.get("gtfs-snapshot");
  const transfers = byRole.get("timetable-transfer-demands");
  invariant(report !== undefined && routes !== undefined && snapshot !== undefined && transfers !== undefined, "timetableRouteEvidence besitzt nicht alle vier freien GTFS-/Transfer-Dateibindungen.");
  invariant(report.bytes === evidence.reportBytes && report.sha256 === evidence.reportSha256 && report.records === 1, "timetableRouteEvidence und Routenbericht-Input laufen auseinander.");
  invariant(routes.bytes === evidence.routesBytes && routes.sha256 === evidence.routesSha256 && routes.records === evidence.routeRecordCount, "timetableRouteEvidence und timetableRoutes-Input laufen auseinander.");
  invariant(snapshot.bytes === evidence.gtfsSnapshotBytes && snapshot.sha256 === evidence.gtfsSnapshotSha256 && snapshot.records === 1, "timetableRouteEvidence und GTFS-Snapshot-Input laufen auseinander.");
  invariant(transfers.bytes === evidence.transferDemandsBytes && transfers.sha256 === evidence.transferDemandsSha256 && transfers.records === evidence.transferRouteCount, "timetableRouteEvidence und Transfer-Demands-Input laufen auseinander.");
  invariant(evidence.routesSha256 === evidence.routeSetSha256, "Die kanonische timetableRoutes-JSONSeq-Datei besitzt nicht den gebundenen routeSetSha256.");
  return evidence;
}

export async function syntheticOperationalTimetableRoutesProof(path, label = "timetableRoutes-v2") {
  const before = await syntheticOperationalFileProof(path, label);
  const routeSet = createHash("sha256");
  const segmentIds = [];
  let previousRouteVersionId = null;
  let routeLegCount = 0;
  let totalRouteLengthMm = 0;
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    invariant(line !== "", `${label} enthaelt eine leere JSONSeq-Zeile ${lineNumber}.`);
    let route;
    try {
      route = JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} enthaelt in Zeile ${lineNumber} kein gueltiges JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    exactKeys(route, ["routeVersionId", "templateId", "predecessorId", "transitionRouteMm", "legs"], `${label}[${lineNumber}]`);
    invariant(typeof route.routeVersionId === "string" && route.routeVersionId.startsWith("route:gtfs:") && route.routeVersionId.endsWith(":v1"), `${label}[${lineNumber}].routeVersionId verletzt den freien GTFS-Vertrag.`);
    const segmentId = route.routeVersionId.slice("route:gtfs:".length, -":v1".length);
    invariant(segmentId !== "" && route.templateId === `template:gtfs:${segmentId}:v1`, `${label}[${lineNumber}] bindet Segment und Template nicht 1:1.`);
    invariant(route.predecessorId === null && route.transitionRouteMm === null && Array.isArray(route.legs), `${label}[${lineNumber}] besitzt unerwartete Versions- oder Leg-Felder.`);
    invariant(previousRouteVersionId === null || compareText(previousRouteVersionId, route.routeVersionId) < 0, `${label} ist nicht streng und eindeutig nach routeVersionId geordnet.`);
    previousRouteVersionId = route.routeVersionId;
    segmentIds.push(segmentId);
    routeLegCount += route.legs.length;
    for (const [legIndex, leg] of route.legs.entries()) {
      invariant(Number.isSafeInteger(leg?.edgeEntryMm) && Number.isSafeInteger(leg?.edgeExitMm), `${label}[${lineNumber}].legs[${legIndex}] besitzt keine ganzzahligen Kantenpositionen.`);
      totalRouteLengthMm += Math.abs(leg.edgeExitMm - leg.edgeEntryMm);
      invariant(Number.isSafeInteger(totalRouteLengthMm), `${label} ueberschreitet die sichere ganzzahlige Gesamtlaenge.`);
    }
    const canonical = canonicalSyntheticOperationalValue(route);
    invariant(line === canonical, `${label}[${lineNumber}] ist nicht kanonisch serialisiert.`);
    routeSet.update(`${canonical}\n`);
  }
  positiveInteger(segmentIds.length, `${label}.records`);
  const after = await syntheticOperationalFileProof(path, label);
  invariant(sameCanonical(before, after), `${label} aenderte sich waehrend der semantischen Pruefung.`);
  const routeSetSha256 = routeSet.digest("hex");
  invariant(routeSetSha256 === before.sha256, `${label} enthaelt keine bytegleiche kanonische JSONSeq-Routenmenge.`);
  return Object.freeze({ ...before, records: segmentIds.length, routeSetSha256, segmentIds: Object.freeze(segmentIds), routeLegCount, totalRouteLengthMm });
}

export function validateSyntheticOperationalTimetableRouteEvidence({
  releaseId,
  routeReport,
  routeReportBinding,
  gtfsSnapshot,
  gtfsSnapshotBinding,
  timetableRoutesProof,
  timetableTransferDemands,
  timetableTransferDemandsBinding,
  tracksBinding,
}) {
  exactKeys(routeReport, TIMETABLE_ROUTE_REPORT_KEYS, "Timetable-Route-Bericht");
  invariant(routeReport.schema === GERMANY_TIMETABLE_ROUTE_REPORT_SCHEMA && routeReport.infraReleaseId === releaseId, "Timetable-Route-Bericht verletzt v4-Schema oder Releasebindung.");
  invariant(
    routeReport.status === "qualified"
      && routeReport.routesProduced === true
      && routeReport.transferDemandsProduced === true
      && routeReport.unresolvedRequired === 0,
    "Timetable-Route-Bericht ist nicht samt Transferanforderungen vollstaendig qualifiziert.",
  );
  invariant(routeReport.derivationRule === TIMETABLE_ROUTE_DERIVATION_RULE && routeReport.selectionRule === TIMETABLE_ROUTE_SELECTION_RULE && routeReport.policyId === SYNTHETIC_OPERATIONAL_POLICY_ID, "Timetable-Route-Bericht verletzt Policy, Ableitungs- oder Auswahlregel.");
  exactKeys(routeReport.findings, [], "Timetable-Route-Bericht.findings");
  invariant(!containsExternalOperationalNetworkProvenance(routeReport), "Timetable-Route-Bericht enthaelt externe Operational-Network-Provenienz.");

  exactKeys(routeReport.gtfsBinding, ["schema", "regionId", "regionVariant", "serviceDate", "sourceId", "archive", "archiveSha256", "sourceLicense", "sourceLicenseAsPublished", "attribution", "snapshotHash"], "Timetable-Route-Bericht.gtfsBinding");
  const gtfs = routeReport.gtfsBinding;
  invariant(gtfs.schema === GTFS_SNAPSHOT_SCHEMA, "Timetable-Route-Bericht bindet kein GTFS-Snapshot-v2.");
  for (const field of ["regionId", "regionVariant", "serviceDate", "sourceId", "archive", "attribution"]) invariant(typeof gtfs[field] === "string" && gtfs[field] !== "", `Timetable-Route-Bericht.gtfsBinding.${field} fehlt.`);
  invariant(SHA256.test(gtfs.archiveSha256) && SHA256.test(gtfs.snapshotHash), "Timetable-Route-Bericht besitzt keinen Archiv- oder Snapshot-Hash.");
  invariant(gtfs.sourceLicense === "CC-BY-4.0" && gtfs.sourceLicenseAsPublished === "CC BY 4.0", "Timetable-Route-Bericht besitzt nicht die freie CC-BY-4.0-Quelle.");

  exactKeys(routeReport.sourceProofs, ["tracks", "corridors", "gtfsSnapshot"], "Timetable-Route-Bericht.sourceProofs");
  const trackProof = sha256Proof(routeReport.sourceProofs.tracks, "Timetable-Route-Bericht.sourceProofs.tracks");
  sha256Proof(routeReport.sourceProofs.corridors, "Timetable-Route-Bericht.sourceProofs.corridors");
  const snapshotProof = sha256Proof(routeReport.sourceProofs.gtfsSnapshot, "Timetable-Route-Bericht.sourceProofs.gtfsSnapshot");
  invariant(trackProof.bytes === tracksBinding.bytes && trackProof.sha256 === tracksBinding.sha256, "Timetable-Route-Bericht und Closure binden verschiedene reale Gleisgeometrie.");
  invariant(snapshotProof.bytes === gtfsSnapshotBinding.bytes && snapshotProof.sha256 === gtfsSnapshotBinding.sha256, "Timetable-Route-Bericht und Closure binden verschiedene GTFS-Snapshot-Bytes.");
  invariant(routeReportBinding.records === 1 && gtfsSnapshotBinding.records === 1, "Routenbericht und GTFS-Snapshot muessen genau je ein gebundenes Dokument sein.");

  exactKeys(routeReport.metrics, TIMETABLE_ROUTE_METRIC_KEYS, "Timetable-Route-Bericht.metrics");
  for (const [name, value] of Object.entries(routeReport.metrics)) {
    if (name !== "dailyCirculation") nonNegativeInteger(value, `Timetable-Route-Bericht.metrics.${name}`);
  }
  validateDailyCirculationMetrics(routeReport.metrics.dailyCirculation, "Timetable-Route-Bericht.metrics.dailyCirculation");
  positiveInteger(routeReport.metrics.eligibleSegmentCount, "Timetable-Route-Bericht.metrics.eligibleSegmentCount");
  positiveInteger(routeReport.metrics.retainedRoutingTrackCount, "Timetable-Route-Bericht.metrics.retainedRoutingTrackCount");
  positiveInteger(routeReport.metrics.transferRouteCount, "Timetable-Route-Bericht.metrics.transferRouteCount");
  positiveInteger(routeReport.metrics.transferRouteLegCount, "Timetable-Route-Bericht.metrics.transferRouteLegCount");
  positiveInteger(routeReport.metrics.transferRouteLengthMm, "Timetable-Route-Bericht.metrics.transferRouteLengthMm");
  invariant(
    routeReport.metrics.dailyCirculation.journeyChainCount === routeReport.metrics.journeyChainCount
      && routeReport.metrics.dailyCirculation.transferDemandCount === routeReport.metrics.transferRouteCount,
    "Timetable-Route-Bericht besitzt keine vollstaendig gekoppelte Tagesumlauf-/Transfermetrik.",
  );
  const validatedSnapshot = validatePinnedGtfsSnapshot(gtfsSnapshot, {
    expectedSnapshotHash: gtfs.snapshotHash,
    expectedSchema: gtfs.schema,
    expectedRegionId: gtfs.regionId,
    expectedRegionVariant: gtfs.regionVariant,
    expectedServiceDate: gtfs.serviceDate,
    expectedSourceId: gtfs.sourceId,
    expectedArchiveSha256: gtfs.archiveSha256,
    expectedSourceLicense: gtfs.sourceLicenseAsPublished,
  }, {
    minimumStopCount: 2,
    qualityClass: "B",
    expectedSnapshotSegmentCount: routeReport.metrics.snapshotSegmentCount,
    expectedEligibleSegmentCount: routeReport.metrics.eligibleSegmentCount,
  });
  invariant(validatedSnapshot.snapshot.source.archive === gtfs.archive && validatedSnapshot.snapshot.source.attribution === gtfs.attribution, "Timetable-Route-Bericht wiederholt abweichendes GTFS-Archiv oder Attribution.");
  for (const [name, value] of Object.entries(validatedSnapshot.metrics)) invariant(routeReport.metrics[name] === value, `Timetable-Route-Bericht.metrics.${name} stimmt nicht mit dem Snapshot ueberein.`);
  invariant(routeReport.metrics.snapshotSegmentCount === routeReport.metrics.eligibleSegmentCount + routeReport.metrics.excludedQualityCCount, "Timetable-Route-Bericht deckt nicht jedes Snapshot-Segment als B oder ausgeschlossenes C ab.");
  invariant(
    routeReport.metrics.eligibleSegmentCount === routeReport.metrics.completeRouteCount
      && routeReport.metrics.completeRouteCount === routeReport.metrics.routeRecordCount
      && routeReport.metrics.routeRecordCount === timetableRoutesProof.records
      && routeReport.metrics.incompleteRouteCount === 0,
    "Timetable-Route-Bericht besitzt keine vollstaendige 1:1-Abdeckung aller ausgewaehlten Segmente.",
  );
  invariant(routeReport.metrics.sameStopTransitionCount === routeReport.metrics.zeroMovementStopTransitionCount, "Same-Stop-Uebergaenge sind nicht vollstaendig als Nullbewegung ausgewiesen.");
  invariant(routeReport.metrics.routeLegCount === timetableRoutesProof.routeLegCount && routeReport.metrics.totalRouteLengthMm === timetableRoutesProof.totalRouteLengthMm, "Timetable-Route-Bericht und JSONSeq besitzen verschiedene Leganzahl oder Gesamtlaenge.");
  const selectedSegmentIds = validatedSnapshot.selectedSegments.map(({ segmentId }) => segmentId);
  invariant(JSON.stringify(selectedSegmentIds) === JSON.stringify(timetableRoutesProof.segmentIds), "timetableRoutes bilden nicht exakt jedes ausgewaehlte GTFS-Segment 1:1 ab.");
  invariant(routeReport.routeSetSha256 === timetableRoutesProof.routeSetSha256 && timetableRoutesProof.sha256 === routeReport.routeSetSha256, "Timetable-Route-Bericht bindet nicht die kanonischen JSONSeq-Bytes.");
  const transferEvidence = validateSyntheticOperationalTimetableTransferDemands({
    releaseId,
    transferDemands: timetableTransferDemands,
    transferDemandsBinding: timetableTransferDemandsBinding,
    routeReport,
    timetableRoutesProof,
    gtfsSnapshot: validatedSnapshot.snapshot,
  });
  invariant(
    routeReport.dailyCirculationPlanSha256 === transferEvidence.dailyCirculationPlanSha256
      && routeReport.transferSetSha256 === transferEvidence.transferSetSha256
      && sameCanonical(routeReport.metrics.dailyCirculation, transferEvidence.dailyCirculation)
      && routeReport.metrics.transferRouteCount === transferEvidence.transferRouteCount
      && routeReport.metrics.transferRouteLegCount === transferEvidence.transferRouteLegCount
      && routeReport.metrics.transferRouteLengthMm === transferEvidence.transferRouteLengthMm,
    "Timetable-Route-Bericht und Transfer-Sidecar besitzen verschiedene Plan-/Set-Hashes oder Transfermetriken.",
  );

  exactKeys(routeReport.sourceMetrics, ["gtfsSnapshot", "gtfsTrackGraph"], "Timetable-Route-Bericht.sourceMetrics");
  invariant(sameCanonical(routeReport.sourceMetrics.gtfsSnapshot, validatedSnapshot.metrics), "Timetable-Route-Bericht.sourceMetrics.gtfsSnapshot ist nicht aus demselben Snapshot abgeleitet.");
  invariant(routeReport.sourceMetrics.gtfsTrackGraph !== null && typeof routeReport.sourceMetrics.gtfsTrackGraph === "object" && !Array.isArray(routeReport.sourceMetrics.gtfsTrackGraph), "Timetable-Route-Bericht besitzt keine GTFS-Gleisgraphmetriken.");
  exactKeys(routeReport.provenance, ["realGeometry", "simulatedOperationalAssignment", "realInterlockingFactsClaimed", "operationalNetworkUsed", "gtfsShapeGeometryUsed", "inventedGeometryUsed", "everyIntermediateStopUsedAsTrackAnchor", "trackGraphRule", "simulatedRouteKey"], "Timetable-Route-Bericht.provenance");
  invariant(
    routeReport.provenance.realGeometry === true
      && routeReport.provenance.simulatedOperationalAssignment === true
      && routeReport.provenance.realInterlockingFactsClaimed === false
      && routeReport.provenance.operationalNetworkUsed === false
      && routeReport.provenance.gtfsShapeGeometryUsed === false
      && routeReport.provenance.inventedGeometryUsed === false
      && routeReport.provenance.everyIntermediateStopUsedAsTrackAnchor === true,
    "Timetable-Route-Bericht trennt reale Geometrie und simulierte Zuordnung nicht fail-closed.",
  );
  for (const field of ["trackGraphRule", "simulatedRouteKey"]) invariant(typeof routeReport.provenance[field] === "string" && routeReport.provenance[field] !== "", `Timetable-Route-Bericht.provenance.${field} fehlt.`);

  const evidence = {
    reportSchema: routeReport.schema,
    policyId: routeReport.policyId,
    derivationRule: routeReport.derivationRule,
    selectionRule: routeReport.selectionRule,
    reportBytes: routeReportBinding.bytes,
    reportSha256: routeReportBinding.sha256,
    routesBytes: timetableRoutesProof.bytes,
    routesSha256: timetableRoutesProof.sha256,
    gtfsSnapshotBytes: gtfsSnapshotBinding.bytes,
    gtfsSnapshotSha256: gtfsSnapshotBinding.sha256,
    transferDemandsSchema: transferEvidence.schema,
    transferDemandsBytes: transferEvidence.bytes,
    transferDemandsSha256: transferEvidence.sha256,
    snapshotHash: gtfs.snapshotHash,
    archive: gtfs.archive,
    archiveSha256: gtfs.archiveSha256,
    sourceLicense: gtfs.sourceLicense,
    sourceLicenseAsPublished: gtfs.sourceLicenseAsPublished,
    selectedSegmentCount: routeReport.metrics.eligibleSegmentCount,
    completeRouteCount: routeReport.metrics.completeRouteCount,
    routeRecordCount: routeReport.metrics.routeRecordCount,
    sameStopTransitionCount: routeReport.metrics.sameStopTransitionCount,
    routeSetSha256: routeReport.routeSetSha256,
    dailyCirculationPlanSha256: transferEvidence.dailyCirculationPlanSha256,
    transferSetSha256: transferEvidence.transferSetSha256,
    transferDemandsProduced: true,
    dailyCirculation: { ...transferEvidence.dailyCirculation },
    transferRouteCount: transferEvidence.transferRouteCount,
    transferRouteLegCount: transferEvidence.transferRouteLegCount,
    transferRouteLengthMm: transferEvidence.transferRouteLengthMm,
    realGeometry: true,
    simulatedOperationalAssignment: true,
    realInterlockingFactsClaimed: false,
    externalOperationalNetworkProvenance: false,
  };
  return Object.freeze(evidence);
}

export function validateSyntheticOperationalClosureReceipt(receipt, { policy, releaseId }) {
  validateSyntheticOperationalPolicy(policy);
  exactKeys(receipt, ["schema", "releaseId", "policyId", "policySha256", "annualSpecification", "classification", "claims", "candidate", "operationalArtifact", "derivationReport", "inputs", "timetableRouteEvidence", "closure", "coverage", "nativeValidation", "receiptSha256"], "Synthetic-Operational-Closure");
  invariant(receipt.schema === SYNTHETIC_OPERATIONAL_CLOSURE_SCHEMA, "Synthetic-Operational-Closure besitzt kein v2-Schema mit timetableRoutes-Bindung.");
  invariant(receipt.releaseId === releaseId, "Synthetic-Operational-Closure und Qualitaetsbericht nennen verschiedene Releases.");
  invariant(receipt.policyId === policy.id && receipt.policySha256 === syntheticOperationalSha256(policy), "Synthetic-Operational-Closure ist nicht an die eingecheckte Policy gebunden.");
  fileBinding(receipt.annualSpecification, "annualSpecification");
  exactKeys(receipt.classification, ["qualityClass", "provenance", "classAEligible"], "classification");
  invariant(receipt.classification.qualityClass === "B" && receipt.classification.provenance === "derived" && receipt.classification.classAEligible === false, "Synthetic-Operational-Closure ist nicht ausschliesslich Derived/B.");
  exactKeys(receipt.claims, [
    "realGeometry",
    "simulatedOperationalAssignment",
    "realInterlockingFactsClaimed",
    "syntheticOperationalDetailsShipped",
    "objectLevelProvenanceShipped",
    "observedAndSyntheticObjectsShareRuntimeCollections",
  ], "claims");
  invariant(
    receipt.claims.realGeometry === true
      && receipt.claims.simulatedOperationalAssignment === true
      && receipt.claims.realInterlockingFactsClaimed === false
      && receipt.claims.syntheticOperationalDetailsShipped === true
      && receipt.claims.objectLevelProvenanceShipped === false
      && receipt.claims.observedAndSyntheticObjectsShareRuntimeCollections === true,
    "Synthetic-Operational-Closure bildet Geometrie, Simulation und ausgelieferte Provenienz nicht ehrlich ab.",
  );
  const candidate = fileBinding(receipt.candidate, "candidate", ["stateHash"]);
  const artifact = fileBinding(receipt.operationalArtifact, "operationalArtifact", ["stateHash"]);
  invariant(SHA256.test(candidate.stateHash) && SHA256.test(artifact.stateHash), "Operational-Candidate oder Artefakt besitzt keinen Zustandshash.");
  invariant(candidate.bytes === artifact.bytes && candidate.sha256 === artifact.sha256 && candidate.stateHash === artifact.stateHash, "Candidate und materialisiertes Operational-v2-Artefakt sind nicht kanonisch identisch.");
  invariant(Array.isArray(receipt.inputs) && receipt.inputs.length === REQUIRED_INPUT_ROLES.length, "Synthetic-Operational-Closure bindet nicht exakt alle zehn Pflichtinputs.");
  exactStrings(receipt.inputs.map(({ role }) => role), REQUIRED_INPUT_ROLES, "Closure-Inputrollen");
  for (const input of receipt.inputs) inputBinding(input, `input:${input.role}`);
  validateTimetableRouteEvidenceBinding(receipt.timetableRouteEvidence, receipt.inputs);
  validateDerivationBinding(receipt.derivationReport, candidate, receipt.timetableRouteEvidence);
  exactKeys(receipt.closure, ["derivedDimensions", "unresolvedRequired", "ordinaryAssumptionsPromoted", "mapClassCReclassified"], "closure");
  exactStrings(receipt.closure.derivedDimensions, REQUIRED_DIMENSIONS, "derivedDimensions");
  invariant(receipt.closure.unresolvedRequired === 0, "Synthetic-Operational-Closure besitzt offene Pflichtdimensionen.");
  invariant(receipt.closure.ordinaryAssumptionsPromoted === 0, "Gewoehnliche Annahmen duerfen nicht still zu Derived/B angehoben werden.");
  invariant(receipt.closure.mapClassCReclassified === 0, "Operational-Closure darf sichtbare Klasse-C-Kartenobjekte nicht pauschal umklassifizieren.");
  validateCoverage(receipt.coverage);
  exactKeys(receipt.nativeValidation, ["candidate", "operationalArtifact"], "nativeValidation");
  validateNativeReceipt(receipt.nativeValidation.candidate, releaseId, candidate, "nativeValidation.candidate");
  validateNativeReceipt(receipt.nativeValidation.operationalArtifact, releaseId, artifact, "nativeValidation.operationalArtifact");
  const timetableRoutes = receipt.inputs.find(({ role }) => role === "timetable-routes");
  invariant(timetableRoutes !== undefined && timetableRoutes.records > 0, "Closure-Receipt bindet keine gepinnten timetableRoutes.");
  const payload = { ...receipt };
  delete payload.receiptSha256;
  invariant(receipt.receiptSha256 === syntheticOperationalSha256(payload), "Synthetic-Operational-Closure besitzt keinen gueltigen Eigenhash.");
  return receipt;
}

export function buildSyntheticOperationalClosureReceipt({
  policy,
  releaseId,
  annualSpecification,
  candidate,
  operationalArtifact,
  derivationReport,
  inputs,
  timetableRouteEvidence,
  coverage,
  nativeValidation,
}) {
  validateSyntheticOperationalPolicy(policy);
  const payload = {
    schema: SYNTHETIC_OPERATIONAL_CLOSURE_SCHEMA,
    releaseId,
    policyId: policy.id,
    policySha256: syntheticOperationalSha256(policy),
    annualSpecification,
    classification: { qualityClass: "B", provenance: "derived", classAEligible: false },
    claims: {
      realGeometry: true,
      simulatedOperationalAssignment: true,
      realInterlockingFactsClaimed: false,
      syntheticOperationalDetailsShipped: true,
      objectLevelProvenanceShipped: false,
      observedAndSyntheticObjectsShareRuntimeCollections: true,
    },
    candidate,
    operationalArtifact,
    derivationReport,
    inputs: [...inputs].sort((left, right) => compareText(left.role, right.role)),
    timetableRouteEvidence,
    closure: { derivedDimensions: [...REQUIRED_DIMENSIONS], unresolvedRequired: 0, ordinaryAssumptionsPromoted: 0, mapClassCReclassified: 0 },
    coverage,
    nativeValidation,
  };
  const receipt = { ...payload, receiptSha256: syntheticOperationalSha256(payload) };
  return validateSyntheticOperationalClosureReceipt(receipt, { policy, releaseId });
}

function contained(root, file, label) {
  const relativePath = regularRelativePath(file, label);
  const absolute = resolve(root, relativePath);
  const remainder = relative(root, absolute);
  invariant(remainder !== "" && !remainder.startsWith("..") && !isAbsolute(remainder), `${label} verlaesst seine Artefaktwurzel.`);
  return absolute;
}

export async function syntheticOperationalFileProof(path, label = "Synthetic-Operational-Datei") {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `${label} ist keine nichtleere regulaere Datei.`);
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === metadata.size, `${label} aenderte sich waehrend der Hashbildung.`);
  return { bytes, sha256: digest.digest("hex") };
}

async function verifyProof(root, expected, label) {
  const path = contained(root, expected.file, `${label}.file`);
  const actual = await syntheticOperationalFileProof(path, label);
  invariant(actual.bytes === expected.bytes && actual.sha256 === expected.sha256, `${label} stimmt nicht mit den gehashten Bytes ueberein.`);
  return path;
}

function artifactRelativePath(artifactRoot, absolute, label) {
  const path = relative(artifactRoot, absolute).replaceAll("\\", "/");
  invariant(path !== "" && !path.startsWith("../") && !isAbsolute(path), `${label} liegt nicht in der Artefaktwurzel.`);
  return path;
}

export async function verifySyntheticOperationalClosureReceipt({ receipt, policy, releaseId, artifactRoot, repositoryRoot = "." }) {
  validateSyntheticOperationalClosureReceipt(receipt, { policy, releaseId });
  const root = resolve(artifactRoot);
  const repository = resolve(repositoryRoot);
  const specificationPath = await verifyProof(repository, receipt.annualSpecification, "Jahresspezifikation");
  const candidatePath = await verifyProof(root, receipt.candidate, "Synthetic-Operational-Candidate");
  await verifyProof(root, receipt.operationalArtifact, "Operational-v2-Artefakt");
  const reportPath = await verifyProof(root, receipt.derivationReport, "Operational-v2-Ableitungsbericht");
  const inputPaths = new Map();
  for (const input of receipt.inputs) inputPaths.set(input.role, await verifyProof(root, input, `Synthetic-Operational-Input ${input.role}`));
  const annualSpecification = JSON.parse(await readFile(specificationPath, "utf8"));
  exactKeys(annualSpecification, ["schema", "mode", "infraReleaseId", "layers", "policy"], "Jahresspezifikation");
  invariant(annualSpecification.schema === DERIVATION_SPEC_SCHEMA && annualSpecification.mode === DERIVATION_MODE && annualSpecification.infraReleaseId === releaseId, "Jahresspezifikation verletzt Schema, Modus oder Releasebindung.");
  exactKeys(annualSpecification.layers, ["tracks", "platforms", "switches", "signals", "blocks", "conflictResources", "timetableRoutes", "transferDemands"], "Jahresspezifikation.layers");
  validateCompilerPolicy(annualSpecification.policy);
  invariant(sameCanonical(annualSpecification.policy, policy.compilerPolicy), "Jahresspezifikation und eingecheckte Policy besitzen verschiedene Compilerregeln.");
  const byRole = new Map(receipt.inputs.map((entry) => [entry.role, entry]));
  for (const role of DERIVATION_INPUT_ROLES) {
    const layer = DERIVATION_ROLE_TO_LAYER[role];
    const configured = annualSpecification.layers[layer];
    const configuredPath = layer === "transferDemands" ? configured?.path : configured;
    invariant(typeof configuredPath === "string" && configuredPath !== "", `Jahresspezifikation.layers.${layer} besitzt keinen geschlossenen Dateipfad.`);
    const expectedPath = resolve(repository, configuredPath);
    const actualPath = resolve(root, byRole.get(role).file);
    invariant(expectedPath === actualPath && artifactRelativePath(root, actualPath, `Input ${role}`) === byRole.get(role).file, `Jahresspezifikation und Closure binden verschiedene Pfade fuer ${role}.`);
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const coverage = validateSyntheticOperationalDerivationReport(report, {
    releaseId,
    annualSpecification,
    annualSpecificationProof: receipt.annualSpecification,
    inputBindings: receipt.inputs,
    candidate: receipt.candidate,
  });
  await verifyProof(root, {
    file: report.candidate.movementRouteTemplates.file,
    bytes: report.candidate.movementRouteTemplates.bytes,
    sha256: report.candidate.movementRouteTemplates.sha256,
  }, "Movement-Route-Templates-v2-Sidecar");
  const movementRouteTemplates = Object.freeze({
    bytes: report.candidate.movementRouteTemplates.bytes,
    sha256: report.candidate.movementRouteTemplates.sha256,
    stateHash: report.candidate.movementRouteTemplates.stateHash,
    operationalStateHash: report.candidate.movementRouteTemplates.operationalStateHash,
    timetableTransferSetSha256: report.candidate.movementRouteTemplates.timetableTransferSetSha256,
  });
  invariant(sameCanonical(coverage, receipt.coverage), "Closure-Coverage wurde nicht aus demselben validierten Ableitungsbericht abgeleitet.");
  const routeReportPath = inputPaths.get("timetable-route-report");
  const gtfsSnapshotPath = inputPaths.get("gtfs-snapshot");
  const timetableRoutesPath = inputPaths.get("timetable-routes");
  const timetableTransferDemandsPath = inputPaths.get("timetable-transfer-demands");
  const routeReport = JSON.parse(await readFile(routeReportPath, "utf8"));
  const gtfsSnapshot = JSON.parse(await readFile(gtfsSnapshotPath, "utf8"));
  const timetableTransferDemands = JSON.parse(await readFile(timetableTransferDemandsPath, "utf8"));
  const timetableRoutesProof = await syntheticOperationalTimetableRoutesProof(timetableRoutesPath);
  const timetableRouteEvidence = validateSyntheticOperationalTimetableRouteEvidence({
    releaseId,
    routeReport,
    routeReportBinding: byRole.get("timetable-route-report"),
    gtfsSnapshot,
    gtfsSnapshotBinding: byRole.get("gtfs-snapshot"),
    timetableRoutesProof,
    timetableTransferDemands,
    timetableTransferDemandsBinding: byRole.get("timetable-transfer-demands"),
    tracksBinding: byRole.get("tracks"),
  });
  await verifyProof(root, byRole.get("timetable-route-report"), "Timetable-Route-Bericht");
  await verifyProof(root, byRole.get("gtfs-snapshot"), "GTFS-Snapshot");
  await verifyProof(root, byRole.get("timetable-transfer-demands"), "Timetable-Transfer-Demands");
  invariant(sameCanonical(timetableRouteEvidence, receipt.timetableRouteEvidence), "Closure-Timetable-Route-Evidence wurde nicht aus denselben validierten Dateien abgeleitet.");
  const candidate = await syntheticOperationalFileProof(candidatePath, "Synthetic-Operational-Candidate");
  invariant(candidate.bytes === receipt.candidate.bytes && candidate.sha256 === receipt.candidate.sha256, "Candidate aenderte sich waehrend der Closure-Pruefung.");
  return Object.freeze({
    [VERIFIED]: true,
    coverage: Object.freeze({ ...receipt.coverage }),
    operationalArtifact: Object.freeze({ bytes: receipt.operationalArtifact.bytes, sha256: receipt.operationalArtifact.sha256, stateHash: receipt.operationalArtifact.stateHash }),
    policyId: receipt.policyId,
    policySha256: receipt.policySha256,
    receiptSha256: receipt.receiptSha256,
    releaseId: receipt.releaseId,
    stateHash: receipt.operationalArtifact.stateHash,
    movementRouteTemplates,
    timetableRouteEvidence: Object.freeze({ ...receipt.timetableRouteEvidence }),
  });
}

export function isVerifiedSyntheticOperationalClosure(value) {
  return value?.[VERIFIED] === true;
}

export function publicSyntheticOperationalClosure(verified) {
  invariant(isVerifiedSyntheticOperationalClosure(verified), "Nur ein bytegeprueftes Synthetic-Operational-Closure darf oeffentlich projiziert werden.");
  return {
    policyId: verified.policyId,
    policySha256: verified.policySha256,
    closureReceiptSha256: verified.receiptSha256,
    qualityClass: "B",
    provenance: "derived",
    realGeometry: true,
    simulatedOperationalAssignment: true,
    realInterlockingFactsClaimed: false,
    syntheticOperationalDetailsShipped: true,
    objectLevelProvenanceShipped: false,
    observedAndSyntheticObjectsShareRuntimeCollections: true,
    movementRouteTemplates: { ...verified.movementRouteTemplates },
    timetableRouteEvidence: { ...verified.timetableRouteEvidence },
    operationalArtifact: { ...verified.operationalArtifact },
    coverage: { ...verified.coverage },
  };
}
