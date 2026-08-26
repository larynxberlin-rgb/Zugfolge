import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  GERMANY_TIMETABLE_ROUTE_REPORT_SCHEMA,
  TIMETABLE_ROUTE_DERIVATION_RULE,
  TIMETABLE_ROUTE_POLICY_ID,
  TIMETABLE_ROUTE_SELECTION_RULE,
  validatePinnedGtfsSnapshot,
} from "./timetable-route-compiler.mjs";

export const SYNTHETIC_OPERATIONAL_POLICY_ID = "synthetic-operational-b/v2";
export const SYNTHETIC_OPERATIONAL_POLICY_SCHEMA = "zugfolge-synthetic-operational-policy/v2";
export const SYNTHETIC_OPERATIONAL_CLOSURE_SCHEMA = "zugfolge-synthetic-operational-closure-receipt/v2";

const DERIVATION_SPEC_SCHEMA = "zugfolge-germany-operational-infrastructure-derivation/v2";
const DERIVATION_REPORT_SCHEMA = "germany-operational-v2-derivation-report-v1";
const DERIVATION_MODE = "deterministic-conservative-v1";
const COMPLETE_ROUTE_COVERAGE = "complete-pinned-timetable-routes";
const FULL_ROUTE_INTERLOCKING_MODEL = "deterministic-full-route-node-stellzone-mutex-and-authority/v2";
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
  "tracks",
]);
const REQUIRED_DIMENSIONS = Object.freeze([
  "directed-edge-geometry",
  "route-versions",
  "complete-pinned-timetable-routes",
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
]);
const DERIVATION_ROLE_TO_LAYER = Object.freeze({
  blocks: "blocks",
  "conflict-resources": "conflictResources",
  platforms: "platforms",
  signals: "signals",
  switches: "switches",
  "timetable-routes": "timetableRoutes",
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
  "retainedRoutingTrackCount",
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
  for (const field of ["sourceId", "derivationRule", "defaultProtectionSystem", "regionBoundaryId", "rzueLayoutId"]) {
    invariant(typeof policy[field] === "string" && policy[field] !== "", `compilerPolicy.${field} fehlt.`);
  }
  for (const field of ["unknownMainlineSpeedKmh", "unknownServiceSpeedKmh", "minimumPlatformLengthMm", "maximumPlatformSnapDistanceMm", "minimumOverlapMm"]) {
    positiveInteger(policy[field], `compilerPolicy.${field}`);
  }
  nonNegativeInteger(policy.unknownGradientAbsPermille, "compilerPolicy.unknownGradientAbsPermille");
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

export function coverageFromSyntheticOperationalDerivationReport(report) {
  exactKeys(report.counts, ["source", "candidate", "provenance"], "Nativer Bericht.counts");
  exactKeys(report.counts.source, ["tracks", "orderableTracks", "platforms", "switches", "signals", "blocks", "conflictResources", "timetableRoutes", "timetableLegs"], "Nativer Bericht.counts.source");
  exactKeys(report.counts.candidate, ["directedEdges", "edgeGeometries", "routeVersions", "interlockingRoutes", "signals", "switches", "blockResources", "platformIntervals", "regionBoundaries"], "Nativer Bericht.counts.candidate");
  exactKeys(report.counts.provenance, ["observedForwardSpeeds", "observedBackwardSpeeds", "simulatedSpeeds", "observedProtectionAssignments", "simulatedProtectionAssignments", "matchedPlatformIntervals", "excludedPlatformEvidence", "syntheticBoundarySignals"], "Nativer Bericht.counts.provenance");
  for (const [name, value] of Object.entries(report.counts.source)) nonNegativeInteger(value, `Nativer Bericht.counts.source.${name}`);
  for (const [name, value] of Object.entries(report.counts.provenance)) nonNegativeInteger(value, `Nativer Bericht.counts.provenance.${name}`);
  for (const [name, value] of Object.entries(report.counts.candidate)) positiveInteger(value, `Nativer Bericht.counts.candidate.${name}`);
  invariant(report.counts.source.timetableRoutes > 0 && report.counts.source.timetableLegs > 0, "Nativer Bericht besitzt keine vollstaendige timetableRoutes-Abdeckung.");
  invariant(report.counts.candidate.routeVersions === report.counts.source.timetableRoutes, "RouteVersions und gepinnte timetableRoutes laufen auseinander.");
  invariant(report.counts.candidate.interlockingRoutes === report.counts.source.timetableRoutes, "Gesamtfahrstrassen und gepinnte timetableRoutes laufen auseinander.");
  invariant(report.counts.provenance.syntheticBoundarySignals === report.counts.source.timetableLegs, "Synthetische Grenzsignale und gepinnte timetableRoute-Legs laufen auseinander.");
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
  exactKeys(report, ["schema", "mode", "infraReleaseId", "policy", "inputs", "candidate", "counts", "scope", "routeCoverage", "activationEligible", "unresolvedRequired", "unresolvedRequiredDimensions", "realInterlockingFactsClaimed", "candidateProduced"], "Nativer Deutschland-Operational-v2-Bericht");
  invariant(report.schema === DERIVATION_REPORT_SCHEMA && report.mode === DERIVATION_MODE, "Nativer Deutschland-Operational-v2-Bericht verletzt Schema oder Modus.");
  invariant(report.infraReleaseId === releaseId, "Nativer Deutschland-Operational-v2-Bericht verletzt die Releasebindung.");
  invariant(report.activationEligible === true && report.unresolvedRequired === 0 && Array.isArray(report.unresolvedRequiredDimensions) && report.unresolvedRequiredDimensions.length === 0, "Nativer Deutschland-Operational-v2-Bericht ist nicht vollstaendig geschlossen.");
  invariant(report.routeCoverage === COMPLETE_ROUTE_COVERAGE && report.candidateProduced === true, "Nativer Deutschland-Operational-v2-Bericht besitzt keine vollstaendige gepinnte Fahrwegabdeckung.");
  invariant(report.realInterlockingFactsClaimed === false, "Nativer Deutschland-Operational-v2-Bericht behauptet reale Stellwerksfakten.");
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
    invariant(
      evidence.path.replaceAll("\\", "/") === annualSpecification.layers[name].replaceAll("\\", "/")
        && evidence.bytes === expected.bytes
        && evidence.sha256 === expected.sha256
        && evidence.records === expected.records,
      `Nativer Bericht bindet nicht dieselben Bytes und Records fuer ${role}.`,
    );
  }
  exactKeys(report.candidate, ["bytes", "sha256", "stateHash", "validationMode"], "Nativer Bericht.candidate");
  invariant(
    report.candidate.bytes === candidate.bytes
      && report.candidate.sha256 === candidate.sha256
      && report.candidate.stateHash === candidate.stateHash
      && report.candidate.validationMode === NATIVE_MODE,
    "Nativer Bericht bindet nicht denselben validierten Candidate.",
  );
  exactKeys(report.scope, ["routeModel", "interlockingModel", "platformModel", "capacityBias", "minimumOverlapMmPolicy"], "Nativer Bericht.scope");
  invariant(
    report.scope.routeModel === COMPLETE_ROUTE_COVERAGE
      && report.scope.interlockingModel === FULL_ROUTE_INTERLOCKING_MODEL
      && report.scope.capacityBias === "conservative-under-capacity",
    "Nativer Bericht verletzt Fahrweg-, Gesamtfahrstrassen- oder Kapazitaetsscope.",
  );
  invariant(report.scope.minimumOverlapMmPolicy === annualSpecification.policy.minimumOverlapMm, "Nativer Bericht besitzt eine abweichende Durchrutschweg-Policy.");
  const coverage = coverageFromSyntheticOperationalDerivationReport(report);
  validateCoverage(coverage);
  return coverage;
}

function validateDerivationBinding(binding, candidate) {
  fileBinding(binding, "derivationReport", ["schema", "mode", "routeCoverage", "activationEligible", "unresolvedRequired", "realInterlockingFactsClaimed", "candidate"]);
  invariant(binding.schema === DERIVATION_REPORT_SCHEMA && binding.mode === DERIVATION_MODE && binding.routeCoverage === COMPLETE_ROUTE_COVERAGE, "Closure-Receipt bindet keinen vollstaendigen nativen Ableitungsbericht.");
  invariant(binding.activationEligible === true && binding.unresolvedRequired === 0 && binding.realInterlockingFactsClaimed === false, "Closure-Receipt bindet keinen geschlossenen ehrlichen Ableitungsbericht.");
  exactKeys(binding.candidate, ["bytes", "sha256", "stateHash", "validationMode"], "derivationReport.candidate");
  invariant(
    binding.candidate.bytes === candidate.bytes
      && binding.candidate.sha256 === candidate.sha256
      && binding.candidate.stateHash === candidate.stateHash
      && binding.candidate.validationMode === NATIVE_MODE,
    "Closure-Receipt und Ableitungsbericht binden verschiedene Candidates.",
  );
}

function sha256Proof(value, label) {
  exactKeys(value, ["bytes", "sha256"], label);
  positiveInteger(value.bytes, `${label}.bytes`);
  invariant(SHA256.test(value.sha256), `${label}.sha256 ist ungueltig.`);
  return value;
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
  invariant(evidence.reportSchema === GERMANY_TIMETABLE_ROUTE_REPORT_SCHEMA, "timetableRouteEvidence bindet keinen v2-Routenbericht.");
  invariant(evidence.policyId === TIMETABLE_ROUTE_POLICY_ID && evidence.policyId === SYNTHETIC_OPERATIONAL_POLICY_ID, "timetableRouteEvidence bindet nicht synthetic-operational-b/v2.");
  invariant(evidence.derivationRule === TIMETABLE_ROUTE_DERIVATION_RULE && evidence.selectionRule === TIMETABLE_ROUTE_SELECTION_RULE, "timetableRouteEvidence bindet abweichende GTFS-Fahrwegregeln.");
  for (const field of ["reportBytes", "routesBytes", "gtfsSnapshotBytes"]) positiveInteger(evidence[field], `timetableRouteEvidence.${field}`);
  for (const field of ["reportSha256", "routesSha256", "gtfsSnapshotSha256", "snapshotHash", "archiveSha256", "routeSetSha256"]) {
    invariant(SHA256.test(evidence[field]), `timetableRouteEvidence.${field} ist ungueltig.`);
  }
  invariant(typeof evidence.archive === "string" && evidence.archive !== "", "timetableRouteEvidence.archive fehlt.");
  invariant(evidence.sourceLicense === "CC-BY-4.0" && evidence.sourceLicenseAsPublished === "CC BY 4.0", "timetableRouteEvidence besitzt nicht die freie CC-BY-4.0-Bindung.");
  for (const field of ["selectedSegmentCount", "completeRouteCount", "routeRecordCount"]) positiveInteger(evidence[field], `timetableRouteEvidence.${field}`);
  nonNegativeInteger(evidence.sameStopTransitionCount, "timetableRouteEvidence.sameStopTransitionCount");
  invariant(
    evidence.selectedSegmentCount === evidence.completeRouteCount && evidence.completeRouteCount === evidence.routeRecordCount,
    "timetableRouteEvidence besitzt keine vollstaendige 1:1-Segmentabdeckung.",
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
  invariant(report !== undefined && routes !== undefined && snapshot !== undefined, "timetableRouteEvidence besitzt nicht alle drei freien GTFS-Dateibindungen.");
  invariant(report.bytes === evidence.reportBytes && report.sha256 === evidence.reportSha256 && report.records === 1, "timetableRouteEvidence und Routenbericht-Input laufen auseinander.");
  invariant(routes.bytes === evidence.routesBytes && routes.sha256 === evidence.routesSha256 && routes.records === evidence.routeRecordCount, "timetableRouteEvidence und timetableRoutes-Input laufen auseinander.");
  invariant(snapshot.bytes === evidence.gtfsSnapshotBytes && snapshot.sha256 === evidence.gtfsSnapshotSha256 && snapshot.records === 1, "timetableRouteEvidence und GTFS-Snapshot-Input laufen auseinander.");
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
  tracksBinding,
}) {
  exactKeys(routeReport, TIMETABLE_ROUTE_REPORT_KEYS, "Timetable-Route-Bericht");
  invariant(routeReport.schema === GERMANY_TIMETABLE_ROUTE_REPORT_SCHEMA && routeReport.infraReleaseId === releaseId, "Timetable-Route-Bericht verletzt v2-Schema oder Releasebindung.");
  invariant(routeReport.status === "qualified" && routeReport.routesProduced === true && routeReport.unresolvedRequired === 0, "Timetable-Route-Bericht ist nicht vollstaendig qualifiziert.");
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
  for (const [name, value] of Object.entries(routeReport.metrics)) nonNegativeInteger(value, `Timetable-Route-Bericht.metrics.${name}`);
  positiveInteger(routeReport.metrics.eligibleSegmentCount, "Timetable-Route-Bericht.metrics.eligibleSegmentCount");
  positiveInteger(routeReport.metrics.retainedRoutingTrackCount, "Timetable-Route-Bericht.metrics.retainedRoutingTrackCount");
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
  validateDerivationBinding(receipt.derivationReport, candidate);
  invariant(Array.isArray(receipt.inputs) && receipt.inputs.length === REQUIRED_INPUT_ROLES.length, "Synthetic-Operational-Closure bindet nicht exakt alle neun Pflichtinputs.");
  exactStrings(receipt.inputs.map(({ role }) => role), REQUIRED_INPUT_ROLES, "Closure-Inputrollen");
  for (const input of receipt.inputs) inputBinding(input, `input:${input.role}`);
  validateTimetableRouteEvidenceBinding(receipt.timetableRouteEvidence, receipt.inputs);
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
  exactKeys(annualSpecification.layers, ["tracks", "platforms", "switches", "signals", "blocks", "conflictResources", "timetableRoutes"], "Jahresspezifikation.layers");
  validateCompilerPolicy(annualSpecification.policy);
  invariant(sameCanonical(annualSpecification.policy, policy.compilerPolicy), "Jahresspezifikation und eingecheckte Policy besitzen verschiedene Compilerregeln.");
  const byRole = new Map(receipt.inputs.map((entry) => [entry.role, entry]));
  for (const role of DERIVATION_INPUT_ROLES) {
    const expectedPath = resolve(repository, annualSpecification.layers[DERIVATION_ROLE_TO_LAYER[role]]);
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
  invariant(sameCanonical(coverage, receipt.coverage), "Closure-Coverage wurde nicht aus demselben validierten Ableitungsbericht abgeleitet.");
  const routeReportPath = inputPaths.get("timetable-route-report");
  const gtfsSnapshotPath = inputPaths.get("gtfs-snapshot");
  const timetableRoutesPath = inputPaths.get("timetable-routes");
  const routeReport = JSON.parse(await readFile(routeReportPath, "utf8"));
  const gtfsSnapshot = JSON.parse(await readFile(gtfsSnapshotPath, "utf8"));
  const timetableRoutesProof = await syntheticOperationalTimetableRoutesProof(timetableRoutesPath);
  const timetableRouteEvidence = validateSyntheticOperationalTimetableRouteEvidence({
    releaseId,
    routeReport,
    routeReportBinding: byRole.get("timetable-route-report"),
    gtfsSnapshot,
    gtfsSnapshotBinding: byRole.get("gtfs-snapshot"),
    timetableRoutesProof,
    tracksBinding: byRole.get("tracks"),
  });
  await verifyProof(root, byRole.get("timetable-route-report"), "Timetable-Route-Bericht");
  await verifyProof(root, byRole.get("gtfs-snapshot"), "GTFS-Snapshot");
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
    timetableRouteEvidence: { ...verified.timetableRouteEvidence },
    operationalArtifact: { ...verified.operationalArtifact },
    coverage: { ...verified.coverage },
  };
}
