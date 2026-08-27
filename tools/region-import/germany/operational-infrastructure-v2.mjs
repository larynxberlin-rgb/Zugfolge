import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { materializeOperationalInfrastructureV2 } from "../materialize-operational-infrastructure-v2.mjs";

export const GERMANY_OPERATIONAL_DERIVATION_SCHEMA = "zugfolge-germany-operational-infrastructure-readiness/v2";
export const GERMANY_OPERATIONAL_DERIVATION_REPORT_SCHEMA = "zugfolge-germany-operational-infrastructure-readiness-report/v1";
export const GERMANY_OPERATIONAL_DERIVATION_MODE = "readiness-only";
export const GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA = "zugfolge-germany-operational-infrastructure-derivation/v2";
export const GERMANY_OPERATIONAL_CONSERVATIVE_MODE = "deterministic-conservative-v1";
export const GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID = "synthetic-operational-b/v2";
export const GERMANY_OPERATIONAL_NATIVE_REPORT_SCHEMA = "germany-operational-v2-derivation-report-v1";
export const GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA = "germany-operational-v2-derivation-receipt-v1";
export const GERMANY_OPERATIONAL_COMPLETE_ROUTE_COVERAGE = "complete-pinned-timetable-routes";
export const GERMANY_OPERATIONAL_NATIVE_EXECUTABLE_ENV = "ZUGFOLGE_INFRA_RELEASE_VALIDATOR_PATH";

const LEGACY_DERIVATION_SCHEMA = "zugfolge-germany-operational-infrastructure-derivation/v1";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA256 = /^[a-f0-9]{64}$/u;
const MAP_LAYER_NAMES = Object.freeze(["tracks", "platforms", "switches", "signals", "blocks", "conflictResources"]);
const CONSERVATIVE_LAYER_NAMES = Object.freeze([...MAP_LAYER_NAMES, "timetableRoutes", "transferDemands"]);
const CONSERVATIVE_POLICY_KEYS = Object.freeze([
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

export const GERMANY_OPERATIONAL_REQUIRED_INPUTS = Object.freeze([
  Object.freeze({
    name: "stationHeads",
    blockerCode: "station-head-connectivity-required",
    artifact: "StationHead-Eingabe fuer die bestehende Rust-Fahrstrassenableitung",
    requiredFields: Object.freeze(["stationHeadId", "nodeId", "incomingTrackId", "switchId", "pointTrackId", "normalTrackId", "reverseTrackId", "activeEntryBoundaryId", "activeEntryBoundaryDirection", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze([
      "Nur Spitze-Stamm- und Spitze-Zweig-Uebergaenge sind zulaessig; Zweig-Zweig und reine Knotennachbarschaft blockieren.",
      "Fehlende oder deaktivierte Eingangssignale bleiben ein Blocker, solange kein bereits autorisierter typisierter Vertrag fuer virtuelle Fahrberechtigungsgrenzen existiert.",
      "Weichenlagen stammen aus StationHead und lauten ausschliesslich normal oder reverse.",
    ]),
  }),
  Object.freeze({
    name: "rustInterlockingRoutes",
    blockerCode: "rust-route-and-interlocking-input-required",
    artifact: "Vom Rust-Vertrag abgeleitete RouteVersionen und InterlockingRouteTemplates",
    requiredFields: Object.freeze(["derivationPolicyVersion", "stationHeadHash", "routeVersions[].id", "routeVersions[].templateId", "routeVersions[].predecessorId", "routeVersions[].transitionRouteMm", "routeVersions[].legs", "interlockingRoutes[].id", "interlockingRoutes[].routeTemplateId", "interlockingRoutes[].signalId", "interlockingRoutes[].pathResources", "interlockingRoutes[].overlapResources", "interlockingRoutes[].flankResources", "interlockingRoutes[].switchPositions", "interlockingRoutes[].authorityStartRouteMm", "interlockingRoutes[].authorityEndRouteMm", "interlockingRoutes[].releaseAfterTailRouteMm", "terminalProtectionBindings[].routeId", "terminalProtectionBindings[].endpointResourceId"]),
    constraints: Object.freeze([
      "Fahrweg, Durchrutschweg und Flankenschutz muessen jeweils fachlich belegte Rollen besitzen; Pfadaliasse und Ersatzressourcen blockieren.",
      "Terminale Fahrwege benoetigen einen belegten Endpunktschutz und duerfen keinen Gleisabschnitt als Ersatzflanke wiederverwenden.",
      "Fahrberechtigungs- und Aufloesegrenzen muessen einen positiven Zug ueber eine Folgefahrberechtigung bis zur lockfreien Beendigung fuehren koennen.",
    ]),
  }),
  Object.freeze({
    name: "platformIntervals",
    blockerCode: "operational-platform-intervals-required",
    artifact: "Operative Bahnsteigintervalle statt Karten- oder Evidenzpunkte",
    requiredFields: Object.freeze(["platformId", "trackId", "fromMm", "toMm", "direction", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Klasse-C-Kartenpunkte und Geometrien ohne exakte gerichtete Gleisbindung blockieren."]),
  }),
  Object.freeze({
    name: "trainProtectionProfiles",
    blockerCode: "canonical-train-protection-profile-required",
    artifact: "Kantengebundene kanonische Zugsicherungsprofile",
    requiredFields: Object.freeze(["trackId", "availableProtectionSystems", "simultaneouslyRequiredProtectionSystems", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Zulaessig sind ausschliesslich pzb, lzb, etcs-level1 und etcs-level2.", "etcs und restricted-unknown sind keine fahrzeugseitig erfuellbaren Betriebskennungen und blockieren."]),
  }),
  Object.freeze({
    name: "resourceBindings",
    blockerCode: "exact-resource-bindings-required",
    artifact: "Vollstaendig referentiell geschlossene Konfliktressourcenbindungen",
    requiredFields: Object.freeze(["resourceId", "resourceKind", "targetId", "exactTrackIds", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Jede Zielbindung muss existieren, bijektiv und mengengleich sein; Orphans und Supersets blockieren."]),
  }),
  Object.freeze({
    name: "regionBoundaries",
    blockerCode: "operational-region-boundaries-required",
    artifact: "Geometrisch und betrieblich belegte Regionsgrenzen",
    requiredFields: Object.freeze(["boundaryId", "geometryE7", "safeHandoverTrackIds", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Eine freie Kennung ohne Grenzgeometrie und sichere Uebergabepunkte blockiert."]),
  }),
  Object.freeze({
    name: "rzueLayout",
    blockerCode: "static-rzue-layout-required",
    artifact: "Statisches RZUE-Layout mit Inhalt, Hash und Herkunft",
    requiredFields: Object.freeze(["layoutId", "nodes", "edges", "contentSha256", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Eine freie Layoutkennung ohne referenziertes statisches Layout blockiert."]),
  }),
  Object.freeze({
    name: "edgeGeometriesMm",
    blockerCode: "upstream-mm-edge-geometry-required",
    artifact: "Upstream berechnete E7-Geometrie mit derselben ganzzahligen Millimeterbasis wie die Kantenlaenge",
    requiredFields: Object.freeze(["edgeId", "lengthMm", "points[].edgeOffsetMm", "points[].latitudeE7", "points[].longitudeE7", "points[].bearingMilliDegrees", "qualityClass", "orderable", "sourceId", "derivationRule"]),
    constraints: Object.freeze(["Der Operational-Ableiter darf Zwischenoffsets weder aus Gradkoordinaten neu gewichten noch schaetzen."]),
  }),
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, name) {
  invariant(isRecord(value), `${name} muss ein Objekt sein.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(JSON.stringify(actual) === JSON.stringify(wanted), `${name} besitzt unbekannte oder fehlende Felder.`);
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value.trim() === value && value !== "", `${name} muss eine nichtleere, randfreie Zeichenkette sein.`);
  return value;
}

function positiveSafeInteger(value, name) {
  invariant(Number.isSafeInteger(value) && value > 0, `${name} muss eine positive sichere Ganzzahl sein.`);
  return value;
}

function nonNegativeSafeInteger(value, name) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${name} muss eine nichtnegative sichere Ganzzahl sein.`);
  return value;
}

function relativeArtifactPath(value, name) {
  const portable = typeof value === "string" ? value.replaceAll("\\", "/") : "";
  const portableAbsolute = /^[A-Za-z]:\//u.test(portable) || portable.startsWith("//");
  const portableScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(portable);
  invariant(typeof value === "string" && value !== "" && !isAbsolute(value) && !portableAbsolute && !portableScheme, `${name} muss ein relativer Artefaktpfad sein.`);
  const segments = portable.split("/");
  invariant(!segments.includes("") && !segments.includes(".") && !segments.includes(".."), `${name} muss ein normalisierter Pfad innerhalb der Artefaktwurzel sein.`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function movementResourceSetSha256(resourceIds) {
  const hash = createHash("sha256");
  for (const resourceId of resourceIds) hash.update(`${resourceId}\n`, "utf8");
  return hash.digest("hex");
}

function validateMapLayerDeclarations(layers, { timetableRoutes = false } = {}) {
  exactKeys(layers, timetableRoutes ? CONSERVATIVE_LAYER_NAMES : MAP_LAYER_NAMES, "Operational-v2-Layer");
  for (const name of MAP_LAYER_NAMES) relativeArtifactPath(layers[name], `layers.${name}`);
  if (timetableRoutes) {
    invariant(layers.timetableRoutes === null || typeof layers.timetableRoutes === "string", "layers.timetableRoutes muss null oder ein relativer Artefaktpfad sein.");
    if (layers.timetableRoutes !== null) relativeArtifactPath(layers.timetableRoutes, "layers.timetableRoutes");
    invariant(layers.transferDemands === null || isRecord(layers.transferDemands), "layers.transferDemands muss null oder ein gepinnter Eingabevertrag sein.");
    if (layers.transferDemands !== null) {
      exactKeys(layers.transferDemands, ["path", "expectedBytes", "expectedSha256"], "layers.transferDemands");
      relativeArtifactPath(layers.transferDemands.path, "layers.transferDemands.path");
      positiveSafeInteger(layers.transferDemands.expectedBytes, "layers.transferDemands.expectedBytes");
      invariant(SHA256.test(layers.transferDemands.expectedSha256), "layers.transferDemands.expectedSha256 ist kein SHA-256.");
      invariant(layers.timetableRoutes !== null, "layers.transferDemands verlangt timetableRoutes.");
    }
  }
}

function validateReadinessSpecification(specification) {
  exactKeys(specification, ["schema", "mode", "infraReleaseId", "layers", "operationalInputs"], "Operational-v2-Readiness-Spezifikation");
  invariant(specification.schema === GERMANY_OPERATIONAL_DERIVATION_SCHEMA, "Unbekanntes Operational-v2-Readiness-Schema.");
  invariant(specification.mode === GERMANY_OPERATIONAL_DERIVATION_MODE, `Operational-v2-Spezifikation muss ${GERMANY_OPERATIONAL_DERIVATION_MODE} sein.`);
  nonEmptyString(specification.infraReleaseId, "Operational-v2-Readiness.infraReleaseId");
  validateMapLayerDeclarations(specification.layers);
  exactKeys(specification.operationalInputs, GERMANY_OPERATIONAL_REQUIRED_INPUTS.map(({ name }) => name), "Explizite Operational-v2-Eingaben");
  for (const { name } of GERMANY_OPERATIONAL_REQUIRED_INPUTS) {
    const declaration = specification.operationalInputs[name];
    invariant(declaration === null || typeof declaration === "string", `operationalInputs.${name} muss null oder ein relativer Artefaktpfad sein.`);
    if (declaration !== null) relativeArtifactPath(declaration, `operationalInputs.${name}`);
  }
}

function validateConservativePolicy(policy) {
  exactKeys(policy, CONSERVATIVE_POLICY_KEYS, "Konservative Operational-v2-Policy");
  invariant(policy.id === GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID, `policy.id muss ${GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID} sein.`);
  invariant(policy.qualityClass === "B", "policy.qualityClass muss B sein.");
  nonEmptyString(policy.sourceId, "policy.sourceId");
  invariant(policy.derivationRule === GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID, `policy.derivationRule muss ${GERMANY_OPERATIONAL_CONSERVATIVE_POLICY_ID} sein.`);
  positiveSafeInteger(policy.unknownMainlineSpeedKmh, "policy.unknownMainlineSpeedKmh");
  positiveSafeInteger(policy.unknownServiceSpeedKmh, "policy.unknownServiceSpeedKmh");
  invariant(policy.unknownServiceSpeedKmh <= policy.unknownMainlineSpeedKmh, "Die unbekannte Servicegeschwindigkeit darf die unbekannte Hauptgleisgeschwindigkeit nicht uebersteigen.");
  nonNegativeSafeInteger(policy.unknownGradientAbsPermille, "policy.unknownGradientAbsPermille");
  invariant(policy.unknownGradientAbsPermille <= 200, "policy.unknownGradientAbsPermille ist nicht begrenzt.");
  positiveSafeInteger(policy.minimumPlatformLengthMm, "policy.minimumPlatformLengthMm");
  positiveSafeInteger(policy.maximumPlatformSnapDistanceMm, "policy.maximumPlatformSnapDistanceMm");
  positiveSafeInteger(policy.minimumOverlapMm, "policy.minimumOverlapMm");
  positiveSafeInteger(policy.minimumBerthEndClearanceMm, "policy.minimumBerthEndClearanceMm");
  positiveSafeInteger(policy.maximumStablingPathEdges, "policy.maximumStablingPathEdges");
  invariant(policy.maximumStablingPathEdges <= 64, "policy.maximumStablingPathEdges ist nicht konservativ begrenzt.");
  positiveSafeInteger(policy.maximumStablingPathLengthMm, "policy.maximumStablingPathLengthMm");
  invariant(policy.maximumStablingPathLengthMm <= 10_000_000, "policy.maximumStablingPathLengthMm ist nicht konservativ begrenzt.");
  invariant(policy.simulatedOperationalBerthFallback === "real-osm-service-yard-then-spur-then-unclassified-rail/v1", "policy.simulatedOperationalBerthFallback verletzt den versionierten Realgeometrie-Vertrag.");
  positiveSafeInteger(policy.maximumDirectDwellMs, "policy.maximumDirectDwellMs");
  invariant(policy.maximumDirectDwellMs === 1_200_000, "policy.maximumDirectDwellMs muss die versionierte 20-Minuten-B-Regel binden.");
  invariant(Array.isArray(policy.terminalFormationLengthsMm) && policy.terminalFormationLengthsMm.length > 0, "policy.terminalFormationLengthsMm fehlt.");
  for (const [index, lengthMm] of policy.terminalFormationLengthsMm.entries()) {
    positiveSafeInteger(lengthMm, `policy.terminalFormationLengthsMm[${index}]`);
    if (index > 0) invariant(policy.terminalFormationLengthsMm[index - 1] < lengthMm, "policy.terminalFormationLengthsMm muss streng aufsteigend und eindeutig sein.");
  }
  invariant(["pzb", "lzb", "etcs-level1", "etcs-level2"].includes(policy.defaultProtectionSystem), "policy.defaultProtectionSystem ist nicht kanonisch.");
  nonEmptyString(policy.regionBoundaryId, "policy.regionBoundaryId");
  nonEmptyString(policy.rzueLayoutId, "policy.rzueLayoutId");
}

export function validateGermanyOperationalInfrastructureV2Specification(specification) {
  invariant(isRecord(specification), "Operational-v2-Spezifikation muss ein Objekt sein.");
  if (specification.schema === GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA || specification.mode === GERMANY_OPERATIONAL_CONSERVATIVE_MODE) {
    exactKeys(specification, ["schema", "mode", "infraReleaseId", "layers", "policy"], "Konservative Operational-v2-Spezifikation");
    invariant(specification.schema === GERMANY_OPERATIONAL_CONSERVATIVE_SCHEMA, "Unbekanntes konservatives Operational-v2-Schema.");
    invariant(specification.mode === GERMANY_OPERATIONAL_CONSERVATIVE_MODE, `Konservative Operational-v2-Spezifikation muss ${GERMANY_OPERATIONAL_CONSERVATIVE_MODE} sein.`);
    nonEmptyString(specification.infraReleaseId, "Konservative Operational-v2-Spezifikation.infraReleaseId");
    validateMapLayerDeclarations(specification.layers, { timetableRoutes: true });
    validateConservativePolicy(specification.policy);
    return "conservative";
  }
  if (specification.schema === LEGACY_DERIVATION_SCHEMA) return "legacy";
  validateReadinessSpecification(specification);
  return "readiness";
}

function legacyInputDeclarations() {
  return Object.fromEntries(GERMANY_OPERATIONAL_REQUIRED_INPUTS.map(({ name }) => [name, null]));
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export function assessGermanyOperationalInfrastructureV2Readiness(specification) {
  invariant(isRecord(specification), "Operational-v2-Spezifikation muss ein Objekt sein.");
  const legacy = specification.schema === LEGACY_DERIVATION_SCHEMA;
  if (legacy) {
    nonEmptyString(specification.infraReleaseId, "Legacy-Operational-v2-Spezifikation.infraReleaseId");
    validateMapLayerDeclarations(specification.layers);
  } else {
    validateReadinessSpecification(specification);
  }
  const operationalInputs = legacy ? legacyInputDeclarations() : specification.operationalInputs;
  const blockers = [{
    code: "six-layer-map-contract-not-operational",
    input: "layers",
    message: "Tracks, Plattformkartenpunkte, Weichen, Signale, Bloecke und Konfliktressourcen sind Karten-/Evidenzlayer und duerfen keinen OperationalInfraRelease-Candidate erzeugen.",
  }];
  if (legacy) blockers.push({ code: "legacy-six-layer-derivation-schema-forbidden", input: "schema", message: `${LEGACY_DERIVATION_SCHEMA} ist wegen erfundener Fahrstrassen- und Schutzwahrheit gesperrt.` });
  for (const requirement of GERMANY_OPERATIONAL_REQUIRED_INPUTS) {
    if (operationalInputs[requirement.name] === null) blockers.push({ code: requirement.blockerCode, input: `operationalInputs.${requirement.name}`, message: `${requirement.artifact} fehlt.` });
  }
  blockers.push({ code: "explicit-rust-operational-compiler-not-implemented", input: "operationalInputs", message: "Auch vollstaendig deklarierte Fachartefakte bleiben blockiert, bis ein echter Compiler sie gegen StationHead und den nativen Operational-v2-Laufzeitvertrag materialisiert und dynamisch nachweist." });
  blockers.sort((left, right) => left.code < right.code ? -1 : left.code > right.code ? 1 : 0);
  const report = {
    schema: GERMANY_OPERATIONAL_DERIVATION_REPORT_SCHEMA,
    status: "blocked",
    infraReleaseId: specification.infraReleaseId,
    candidateProduced: false,
    specificationProof: { canonicalization: "sorted-json-object-keys/v1", sha256: canonicalHash(specification) },
    legacyMapLayers: sortedObject(specification.layers),
    operationalInputs: sortedObject(operationalInputs),
    requiredInputs: GERMANY_OPERATIONAL_REQUIRED_INPUTS.map(({ name, artifact, requiredFields, constraints }) => ({ name, artifact, requiredFields, constraints })),
    blockers,
    unresolvedRequired: blockers.length,
  };
  invariant(report.unresolvedRequired > 0, "Operational-v2-Readiness darf ohne implementierten Fachcompiler niemals freigegeben sein.");
  return report;
}

export class OperationalInfrastructureDerivationBlockedError extends Error {
  constructor(report) {
    super(`Operational-v2-Ableitung blockiert (${report.unresolvedRequired} Pflichtbefunde): ${report.blockers.map(({ code }) => code).join(", ")}`);
    this.name = "OperationalInfrastructureDerivationBlockedError";
    this.report = report;
  }
}

export class OperationalInfrastructureDerivationIncompleteError extends Error {
  constructor(result) {
    super(`Operational-v2-Ableitung bleibt mit ${result.nativeReport.unresolvedRequired} Pflichtbefund(en) nicht aktivierbar.`);
    this.name = "OperationalInfrastructureDerivationIncompleteError";
    this.result = result;
  }
}

async function fileProof(path, label) {
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

function parseLastJsonLine(stdout, label) {
  const line = stdout.trim().split(/\r?\n/u).at(-1);
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`${label} lieferte kein JSON-Receipt.`);
  }
}

export function spawnGermanyOperationalInfrastructureV2Compiler(
  specificationPath,
  sourceRoot,
  candidatePath,
  reportPath,
  { executable, argumentPrefix = [], cwd = REPOSITORY_ROOT } = {},
) {
  const configuredExecutable = (executable ?? process.env[GERMANY_OPERATIONAL_NATIVE_EXECUTABLE_ENV]?.trim()) || undefined;
  const command = configuredExecutable ?? process.env.CARGO ?? "cargo";
  const arguments_ = configuredExecutable === undefined
    ? ["run", "--quiet", "--locked", "-p", "zugfolge-infra", "--bin", "zugfolge-infra-release", "--", "derive-germany-operational-v2", specificationPath, sourceRoot, candidatePath, reportPath]
    : [...argumentPrefix, "derive-germany-operational-v2", specificationPath, sourceRoot, candidatePath, reportPath];
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (result.error !== undefined) throw new Error(`Nativer Deutschland-Operational-v2-Compiler konnte nicht gestartet werden: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new Error(`Native Deutschland-Operational-v2-Ableitung fehlgeschlagen:\n${result.stderr}\n${result.stdout}`);
  return parseLastJsonLine(result.stdout, "Native Deutschland-Operational-v2-Ableitung");
}

function validateProof(value, name, { stateHash = false } = {}) {
  exactKeys(value, stateHash ? ["bytes", "sha256", "stateHash"] : ["bytes", "sha256"], name);
  positiveSafeInteger(value.bytes, `${name}.bytes`);
  invariant(SHA256.test(value.sha256), `${name}.sha256 ist kein SHA-256.`);
  if (stateHash) invariant(SHA256.test(value.stateHash), `${name}.stateHash ist kein SHA-256.`);
  return value;
}

function validateMovementRouteTemplatesProof(value, name, expectedOperationalStateHash, expectedTransferSetSha256) {
  exactKeys(value, ["file", "bytes", "sha256", "stateHash", "operationalStateHash", "timetableTransferSetSha256", "berthAssignmentCounts", "crossBerthTemplateCount"], name);
  invariant(value.file === "operational-infrastructure-v2.movement-route-templates-v2.json", `${name}.file besitzt nicht den kanonischen V2-Dateinamen.`);
  positiveSafeInteger(value.bytes, `${name}.bytes`);
  for (const field of ["sha256", "stateHash", "operationalStateHash"]) invariant(SHA256.test(value[field]), `${name}.${field} ist kein SHA-256.`);
  invariant(value.operationalStateHash === expectedOperationalStateHash, `${name} driftet vom Operational-State-Hash.`);
  invariant(value.timetableTransferSetSha256 === expectedTransferSetSha256, `${name} driftet vom timetableTransferSetSha256.`);
  exactKeys(value.berthAssignmentCounts, ["observedOsmServiceSiding", "simulatedOperationalOsmServiceYard", "simulatedOperationalOsmServiceSpur", "simulatedOperationalOsmUnclassifiedRail"], `${name}.berthAssignmentCounts`);
  for (const [field, count] of Object.entries(value.berthAssignmentCounts)) nonNegativeSafeInteger(count, `${name}.berthAssignmentCounts.${field}`);
  nonNegativeSafeInteger(value.crossBerthTemplateCount, `${name}.crossBerthTemplateCount`);
  return value;
}

export function validateGermanyOperationalInfrastructureV2NativeReceipt(receipt, expectedReleaseId) {
  exactKeys(receipt, ["schema", "infraReleaseId", "candidate", "movementRouteTemplates", "report", "candidateProduced", "activationEligible", "unresolvedRequired"], "Native Deutschland-Operational-v2-Receipt");
  invariant(receipt.schema === GERMANY_OPERATIONAL_NATIVE_RECEIPT_SCHEMA, "Native Deutschland-Operational-v2-Ableitung lieferte ein unbekanntes Receipt-Schema.");
  invariant(receipt.infraReleaseId === expectedReleaseId, "Native Deutschland-Operational-v2-Ableitung verletzte die InfraRelease-ID-Bindung.");
  invariant(receipt.candidateProduced === true, "Native Deutschland-Operational-v2-Ableitung belegte keinen erzeugten Candidate.");
  nonNegativeSafeInteger(receipt.unresolvedRequired, "Native Deutschland-Operational-v2-Receipt.unresolvedRequired");
  invariant(typeof receipt.activationEligible === "boolean" && receipt.activationEligible === (receipt.unresolvedRequired === 0), "Native Deutschland-Operational-v2-Receipt besitzt eine widerspruechliche Aktivierungsentscheidung.");
  validateProof(receipt.candidate, "Native Candidate-Bindung", { stateHash: true });
  validateMovementRouteTemplatesProof(
    receipt.movementRouteTemplates,
    "Native Movement-Route-Templates-Bindung",
    receipt.candidate.stateHash,
    receipt.movementRouteTemplates.timetableTransferSetSha256,
  );
  validateProof(receipt.report, "Native Bericht-Bindung");
  return receipt;
}

function validateNativeDerivationReport(report, specification) {
  exactKeys(report, [
    "schema",
    "mode",
    "infraReleaseId",
    "policy",
    "inputs",
    "candidate",
    "timetableRouteEvidence",
    "counts",
    "scope",
    "routeCoverage",
    "activationEligible",
    "unresolvedRequired",
    "unresolvedRequiredDimensions",
    "realInterlockingFactsClaimed",
    "realGeometry",
    "simulatedOperationalAssignment",
    "candidateProduced",
  ], "Nativer Deutschland-Operational-v2-Bericht");
  invariant(report.schema === GERMANY_OPERATIONAL_NATIVE_REPORT_SCHEMA, "Nativer Deutschland-Operational-v2-Bericht besitzt ein unbekanntes Schema.");
  invariant(report.mode === GERMANY_OPERATIONAL_CONSERVATIVE_MODE, "Nativer Deutschland-Operational-v2-Bericht besitzt nicht den konservativen Modus.");
  invariant(report.infraReleaseId === specification.infraReleaseId, "Nativer Deutschland-Operational-v2-Bericht verletzte die InfraRelease-ID-Bindung.");
  invariant(report.candidateProduced === true, "Nativer Deutschland-Operational-v2-Bericht belegte keinen erzeugten Candidate.");
  nonNegativeSafeInteger(report.unresolvedRequired, "Nativer Bericht.unresolvedRequired");
  invariant(Array.isArray(report.unresolvedRequiredDimensions) && report.unresolvedRequiredDimensions.every((entry) => typeof entry === "string" && entry !== ""), "Nativer Bericht besitzt keine typisierten ungeloesten Pflichtdimensionen.");
  invariant(report.unresolvedRequired === report.unresolvedRequiredDimensions.length, "Nativer Bericht-Zaehler und Pflichtdimensionen laufen auseinander.");
  invariant(typeof report.activationEligible === "boolean" && report.activationEligible === (report.unresolvedRequired === 0), "Nativer Bericht besitzt eine widerspruechliche Aktivierungsentscheidung.");
  invariant(
    report.routeCoverage === (report.activationEligible ? GERMANY_OPERATIONAL_COMPLETE_ROUTE_COVERAGE : "local-directed-track-templates"),
    "Nativer Bericht besitzt eine widerspruechliche Fahrwegabdeckung.",
  );
  invariant(report.realInterlockingFactsClaimed === false, "Der simulierte Klasse-B-Bericht darf keine realen Stellwerksfakten behaupten.");
  exactKeys(report.policy, ["id", "sha256", "spec"], "Nativer Bericht.policy");
  invariant(report.policy.id === specification.policy.id, "Nativer Deutschland-Operational-v2-Bericht ist nicht an die Policy-ID gebunden.");
  invariant(report.policy.sha256 === canonicalHash(specification.policy), "Nativer Deutschland-Operational-v2-Bericht ist nicht an die Policy-Bytesemantik gebunden.");
  invariant(JSON.stringify(canonicalValue(report.policy.spec)) === JSON.stringify(canonicalValue(specification.policy)), "Nativer Deutschland-Operational-v2-Bericht wiederholt eine abweichende Policy.");
  exactKeys(report.inputs, ["spec", "tracks", "platforms", "switches", "signals", "blocks", "conflictResources", "timetableRoutes", "transferDemands"], "Nativer Bericht.inputs");
  for (const [name, evidence] of Object.entries(report.inputs)) {
    if ((name === "timetableRoutes" || name === "transferDemands") && evidence === null) {
      invariant(specification.layers[name] === null, `Nativer Bericht unterschlaegt deklarierte ${name}.`);
      continue;
    }
    exactKeys(evidence, ["path", "bytes", "sha256", "records"], `Nativer Bericht.inputs.${name}`);
    nonEmptyString(evidence.path, `Nativer Bericht.inputs.${name}.path`);
    positiveSafeInteger(evidence.bytes, `Nativer Bericht.inputs.${name}.bytes`);
    invariant(SHA256.test(evidence.sha256), `Nativer Bericht.inputs.${name}.sha256 ist kein SHA-256.`);
    nonNegativeSafeInteger(evidence.records, `Nativer Bericht.inputs.${name}.records`);
  }
  exactKeys(report.candidate, ["bytes", "sha256", "stateHash", "validationMode", "movementRouteTemplates"], "Nativer Bericht.candidate");
  positiveSafeInteger(report.candidate.bytes, "Nativer Bericht.candidate.bytes");
  invariant(SHA256.test(report.candidate.sha256) && SHA256.test(report.candidate.stateHash), "Nativer Bericht besitzt keine vollstaendige Candidate-Hashbindung.");
  invariant(report.candidate.validationMode === "native-streaming-redb-v1", "Nativer Bericht besitzt keinen nativen Streaming-Validierungsbeleg.");
  const transferSetSha256 = report.timetableRouteEvidence === null ? null : report.timetableRouteEvidence.transferSetSha256;
  validateMovementRouteTemplatesProof(report.candidate.movementRouteTemplates, "Nativer Bericht.candidate.movementRouteTemplates", report.candidate.stateHash, transferSetSha256);
  invariant(isRecord(report.counts), "Nativer Deutschland-Operational-v2-Bericht besitzt keinen Zaehlerbeleg.");
  exactKeys(report.counts, ["source", "candidate", "provenance"], "Nativer Bericht.counts");
  exactKeys(report.counts.source, ["tracks", "orderableTracks", "platforms", "switches", "signals", "blocks", "conflictResources", "timetableRoutes", "timetableLegs", "transferDemands", "transferLots", "turnaroundDemands", "turnaroundPairs"], "Nativer Bericht.counts.source");
  exactKeys(report.counts.candidate, ["directedEdges", "edgeGeometries", "routeVersions", "interlockingRoutes", "signals", "switches", "blockResources", "platformIntervals", "regionBoundaries", "directTemplates", "stablingTemplates", "transferTemplates"], "Nativer Bericht.counts.candidate");
  exactKeys(report.counts.provenance, ["observedForwardSpeeds", "observedBackwardSpeeds", "simulatedSpeeds", "observedProtectionAssignments", "simulatedProtectionAssignments", "matchedPlatformIntervals", "excludedPlatformEvidence", "syntheticBoundarySignals", "turnaroundRouteVersions", "turnaroundInterlockingRoutes", "transferRouteVersions", "transferInterlockingRoutes", "observedStablingTemplates", "simulatedOperationalStablingTemplates", "berthAssignmentCounts", "crossBerthTemplates"], "Nativer Bericht.counts.provenance");
  exactKeys(report.counts.provenance.berthAssignmentCounts, ["observedOsmServiceSiding", "simulatedOperationalOsmServiceYard", "simulatedOperationalOsmServiceSpur", "simulatedOperationalOsmUnclassifiedRail"], "Nativer Bericht.counts.provenance.berthAssignmentCounts");
  for (const group of [report.counts.source, report.counts.candidate]) for (const [name, count] of Object.entries(group)) nonNegativeSafeInteger(count, `Nativer Bericht.counts.${name}`);
  for (const [name, count] of Object.entries(report.counts.provenance)) {
    if (name !== "berthAssignmentCounts") nonNegativeSafeInteger(count, `Nativer Bericht.counts.provenance.${name}`);
  }
  for (const [name, count] of Object.entries(report.counts.provenance.berthAssignmentCounts)) nonNegativeSafeInteger(count, `Nativer Bericht.counts.provenance.berthAssignmentCounts.${name}`);
  invariant(
    JSON.stringify(canonicalValue(report.counts.provenance.berthAssignmentCounts)) === JSON.stringify(canonicalValue(report.candidate.movementRouteTemplates.berthAssignmentCounts))
      && report.counts.provenance.crossBerthTemplates === report.candidate.movementRouteTemplates.crossBerthTemplateCount,
    "Nativer Bericht zaehlt Berth-Provenienz in Report und Movement-Beleg verschieden.",
  );
  if (report.timetableRouteEvidence === null) {
    invariant(specification.layers.transferDemands === null, "Nativer Bericht unterschlaegt transferDemands-Evidence.");
  } else {
    exactKeys(report.timetableRouteEvidence, ["timetableRoutes", "transferDemands", "dailyPlanSha256", "transferSetSha256", "circulationCount", "plannedTransitionCount", "transferDemandCount", "transferLotCount", "turnaroundDemandCount", "turnaroundPairCount", "movementRouteTemplates"], "Nativer Bericht.timetableRouteEvidence");
    for (const field of ["dailyPlanSha256", "transferSetSha256"]) invariant(SHA256.test(report.timetableRouteEvidence[field]), `Nativer Bericht.timetableRouteEvidence.${field} ist kein SHA-256.`);
    for (const field of ["circulationCount", "plannedTransitionCount"]) positiveSafeInteger(report.timetableRouteEvidence[field], `Nativer Bericht.timetableRouteEvidence.${field}`);
    for (const field of ["transferDemandCount", "transferLotCount", "turnaroundDemandCount", "turnaroundPairCount"]) nonNegativeSafeInteger(report.timetableRouteEvidence[field], `Nativer Bericht.timetableRouteEvidence.${field}`);
    invariant(
      report.timetableRouteEvidence.transferDemandCount + report.timetableRouteEvidence.turnaroundDemandCount === report.timetableRouteEvidence.plannedTransitionCount
        && report.timetableRouteEvidence.turnaroundPairCount <= report.timetableRouteEvidence.turnaroundDemandCount,
      "Nativer Bericht partitioniert die geplanten physischen Fortsetzungen nicht vollstaendig.",
    );
    invariant(JSON.stringify(canonicalValue(report.timetableRouteEvidence.timetableRoutes)) === JSON.stringify(canonicalValue(report.inputs.timetableRoutes)), "timetableRouteEvidence driftet vom timetableRoutes-Input.");
    invariant(JSON.stringify(canonicalValue(report.timetableRouteEvidence.transferDemands)) === JSON.stringify(canonicalValue(report.inputs.transferDemands)), "timetableRouteEvidence driftet vom transferDemands-Input.");
    invariant(report.timetableRouteEvidence.transferDemands.path === specification.layers.transferDemands.path && report.timetableRouteEvidence.transferDemands.bytes === specification.layers.transferDemands.expectedBytes && report.timetableRouteEvidence.transferDemands.sha256 === specification.layers.transferDemands.expectedSha256, "timetableRouteEvidence driftet vom gepinnten transferDemands-Vertrag.");
    invariant(JSON.stringify(canonicalValue(report.timetableRouteEvidence.movementRouteTemplates)) === JSON.stringify(canonicalValue(report.candidate.movementRouteTemplates)), "timetableRouteEvidence besitzt eine abweichende Movement-Sidecar-Bindung.");
  }
  exactKeys(report.scope, ["routeModel", "interlockingModel", "platformModel", "capacityBias", "minimumOverlapMmPolicy", "turnaroundModel", "minimumBerthEndClearanceMmPolicy", "maximumStablingPathEdgesPolicy", "maximumStablingPathLengthMmPolicy", "simulatedOperationalBerthFallbackPolicy", "maximumDirectDwellMsPolicy", "terminalFormationLengthsMm", "movementRouteTemplateModel"], "Nativer Bericht.scope");
  invariant(report.scope.routeModel === report.routeCoverage, "Nativer Deutschland-Operational-v2-Bericht besitzt zwei verschiedene Fahrwegmodelle.");
  invariant(report.scope.minimumOverlapMmPolicy === specification.policy.minimumOverlapMm, "Nativer Bericht besitzt eine abweichende Durchrutschweg-Policy.");
  invariant(report.scope.minimumBerthEndClearanceMmPolicy === specification.policy.minimumBerthEndClearanceMm && report.scope.maximumStablingPathEdgesPolicy === specification.policy.maximumStablingPathEdges && report.scope.maximumStablingPathLengthMmPolicy === specification.policy.maximumStablingPathLengthMm && report.scope.simulatedOperationalBerthFallbackPolicy === specification.policy.simulatedOperationalBerthFallback && report.scope.maximumDirectDwellMsPolicy === specification.policy.maximumDirectDwellMs, "Nativer Bericht besitzt eine abweichende Turnaround-Policy.");
  invariant(JSON.stringify(report.scope.terminalFormationLengthsMm) === JSON.stringify(specification.policy.terminalFormationLengthsMm), "Nativer Bericht besitzt abweichende Formationslaengen.");
  invariant(report.realGeometry === true && report.simulatedOperationalAssignment === true, "Nativer Bericht besitzt keine ehrliche Realgeometrie-/Synthetic-B-Klassifikation.");
  return report;
}

function sortedUniqueStrings(values, name, { allowEmpty = false } = {}) {
  invariant(Array.isArray(values) && (allowEmpty || values.length > 0), `${name} muss ein ${allowEmpty ? "" : "nichtleeres "}Array sein.`);
  for (const [index, value] of values.entries()) nonEmptyString(value, `${name}[${index}]`);
  invariant(values.every((value, index) => index === 0 || Buffer.from(values[index - 1]).compare(Buffer.from(value)) < 0), `${name} muss UTF-8-sortiert und eindeutig sein.`);
}

function validateProtectionRuns(runs, routeLegCount, name) {
  invariant(Array.isArray(runs) && runs.length > 0, `${name} muss nichtleer sein.`);
  let previous = -1;
  for (const [index, run] of runs.entries()) {
    exactKeys(run, ["throughRouteLegIndex", "availableProtectionSystems", "simultaneouslyRequiredProtectionSystems"], `${name}[${index}]`);
    nonNegativeSafeInteger(run.throughRouteLegIndex, `${name}[${index}].throughRouteLegIndex`);
    invariant(run.throughRouteLegIndex > previous && run.throughRouteLegIndex < routeLegCount, `${name} besitzt keine streng fortschreitende Lauflaengenbindung.`);
    sortedUniqueStrings(run.availableProtectionSystems, `${name}[${index}].availableProtectionSystems`);
    sortedUniqueStrings(run.simultaneouslyRequiredProtectionSystems, `${name}[${index}].simultaneouslyRequiredProtectionSystems`, { allowEmpty: true });
    previous = run.throughRouteLegIndex;
  }
  invariant(previous === routeLegCount - 1, `${name} deckt nicht alle Laufweg-Legs.`);
}

function validateDispatch(dispatch, name) {
  exactKeys(dispatch, ["routeVersionId", "predecessorBaseRouteVersionId", "continuity", "dispatchInterlockingRouteId", "headRouteMm", "minimumRuntimeMs", "resourceIds", "routeLegCount", "protectionContractRuns"], name);
  nonEmptyString(dispatch.routeVersionId, `${name}.routeVersionId`);
  nonEmptyString(dispatch.predecessorBaseRouteVersionId, `${name}.predecessorBaseRouteVersionId`);
  invariant(["same-direction", "reverse-direction"].includes(dispatch.continuity), `${name}.continuity ist keine signierte physische Fortsetzungsrichtung.`);
  nonEmptyString(dispatch.dispatchInterlockingRouteId, `${name}.dispatchInterlockingRouteId`);
  positiveSafeInteger(dispatch.headRouteMm, `${name}.headRouteMm`);
  positiveSafeInteger(dispatch.minimumRuntimeMs, `${name}.minimumRuntimeMs`);
  positiveSafeInteger(dispatch.routeLegCount, `${name}.routeLegCount`);
  sortedUniqueStrings(dispatch.resourceIds, `${name}.resourceIds`);
  validateProtectionRuns(dispatch.protectionContractRuns, dispatch.routeLegCount, `${name}.protectionContractRuns`);
}

function validateTerminalInterval(interval, name) {
  exactKeys(interval, ["edgeId", "fromMm", "toMm"], name);
  nonEmptyString(interval.edgeId, `${name}.edgeId`);
  nonNegativeSafeInteger(interval.fromMm, `${name}.fromMm`);
  positiveSafeInteger(interval.toMm, `${name}.toMm`);
  invariant(interval.fromMm < interval.toMm, `${name} ist leer oder invertiert.`);
}

function validateTerminalIntervals(intervals, formationLengthMm, name, expectedTerminalEdgeId) {
  invariant(Array.isArray(intervals) && intervals.length > 0, `${name} muss eine nichtleere Intervallfolge sein.`);
  let lengthMm = 0;
  const keys = new Set();
  for (const [index, interval] of intervals.entries()) {
    validateTerminalInterval(interval, `${name}[${index}]`);
    lengthMm += interval.toMm - interval.fromMm;
    invariant(Number.isSafeInteger(lengthMm), `${name} laeuft in der Laenge ueber.`);
    const key = `${interval.edgeId}\u0000${interval.fromMm}\u0000${interval.toMm}`;
    invariant(!keys.has(key), `${name} enthaelt ein doppeltes Intervall.`);
    keys.add(key);
  }
  invariant(lengthMm === formationLengthMm, `${name} bildet die Formation nicht exakt ab.`);
  if (expectedTerminalEdgeId !== undefined) {
    invariant(intervals.at(-1).edgeId === expectedTerminalEdgeId, `${name} endet nicht auf der gebundenen Terminalkante.`);
  }
}

function validateBerthAssignment(value, name) {
  exactKeys(value, ["kind", "subtype", "geometryProvenance", "operationalAssignmentProvenance"], name);
  invariant(value.geometryProvenance === "real-osm-rail", `${name} bindet keine reale OSM-Gleisgeometrie.`);
  const observed = value.kind === "observed"
    && value.subtype === "osm-service-siding"
    && value.operationalAssignmentProvenance === "observed-osm-service";
  const simulated = value.kind === "simulated-operational"
    && ["osm-service-yard", "osm-service-spur", "osm-unclassified-rail"].includes(value.subtype)
    && value.operationalAssignmentProvenance === "synthetic-operational-b-policy";
  invariant(observed || simulated, `${name} widerspricht der beobachteten bzw. simulierten Betriebszuordnung.`);
  return value;
}

function validateBerth(value, formationLengthMm, name) {
  exactKeys(value, ["edgeId", "fromMm", "toMm", "leftClearanceMm", "rightClearanceMm"], name);
  nonEmptyString(value.edgeId, `${name}.edgeId`);
  for (const field of ["fromMm", "toMm", "leftClearanceMm", "rightClearanceMm"]) nonNegativeSafeInteger(value[field], `${name}.${field}`);
  invariant(value.toMm - value.fromMm === formationLengthMm, `${name} bildet die Formation nicht exakt ab.`);
  invariant(value.fromMm === value.leftClearanceMm, `${name} besitzt eine widerspruechliche linke Freilaenge.`);
  return value;
}

function validateBerthTransferProvenance(value, template, specification, name) {
  exactKeys(value, ["geometryProvenance", "routingRule", "locationId", "physicalStopId", "maximumPathEdgesPerSide", "maximumPathLengthMmPerSide"], name);
  invariant(
    value.geometryProvenance === "real-osm-rail"
      && value.routingRule === "real-osm-rail-bidirectional-bounded-v1"
      && value.locationId === template.locationId
      && value.physicalStopId === template.physicalStopId
      && value.maximumPathEdgesPerSide === specification.policy.maximumStablingPathEdges
      && value.maximumPathLengthMmPerSide === specification.policy.maximumStablingPathLengthMm,
    `${name} verletzt den realen, ortsidentischen und policybegrenzten Cross-Berth-Vertrag.`,
  );
  return value;
}

function validateMovementRouteTemplatesSidecar(sidecar, specification, proof) {
  exactKeys(sidecar, ["schema", "infraReleaseId", "operationalStateHash", "timetableTransferSetSha256", "directTemplates", "templates", "transferTemplates", "metrics", "stateHash"], "Movement-Route-Templates-v2");
  invariant(sidecar.schema === "movement-route-templates-v2" && sidecar.infraReleaseId === specification.infraReleaseId, "Movement-Sidecar verletzt Schema-/Release-Bindung.");
  invariant(sidecar.operationalStateHash === proof.operationalStateHash && sidecar.stateHash === proof.stateHash, "Movement-Sidecar verletzt die Receipt-Zustandsbindung.");
  invariant(sidecar.timetableTransferSetSha256 === proof.timetableTransferSetSha256, "Movement-Sidecar driftet vom Transfer-Set-Hash.");
  invariant(sidecar.timetableTransferSetSha256 === null || SHA256.test(sidecar.timetableTransferSetSha256), "Movement-Sidecar besitzt keinen gueltigen Transfer-Set-Hash.");
  exactKeys(sidecar.metrics, ["directTemplateCount", "stablingTemplateCount", "transferTemplateCount", "transferDemandCount", "turnaroundDemandCount", "plannedTransitionCount", "turnaroundPairCount", "observedStablingTemplateCount", "simulatedOperationalStablingTemplateCount", "berthAssignmentCounts", "crossBerthTemplateCount"], "Movement-Sidecar.metrics");
  for (const [name, count] of Object.entries(sidecar.metrics)) {
    if (name !== "berthAssignmentCounts") nonNegativeSafeInteger(count, `Movement-Sidecar.metrics.${name}`);
  }
  exactKeys(sidecar.metrics.berthAssignmentCounts, ["observedOsmServiceSiding", "simulatedOperationalOsmServiceYard", "simulatedOperationalOsmServiceSpur", "simulatedOperationalOsmUnclassifiedRail"], "Movement-Sidecar.metrics.berthAssignmentCounts");
  for (const [name, count] of Object.entries(sidecar.metrics.berthAssignmentCounts)) nonNegativeSafeInteger(count, `Movement-Sidecar.metrics.berthAssignmentCounts.${name}`);
  invariant(Array.isArray(sidecar.directTemplates) && Array.isArray(sidecar.templates) && Array.isArray(sidecar.transferTemplates), "Movement-Sidecar besitzt keine drei Template-Mengen.");
  invariant(sidecar.metrics.directTemplateCount === sidecar.directTemplates.length && sidecar.metrics.stablingTemplateCount === sidecar.templates.length && sidecar.metrics.transferTemplateCount === sidecar.transferTemplates.length, "Movement-Sidecar-Metriken laufen von den Template-Mengen weg.");
  const ids = new Set();
  for (const [index, template] of sidecar.directTemplates.entries()) {
    const name = `Movement-Sidecar.directTemplates[${index}]`;
    exactKeys(template, ["id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId", "earliestDepartureS", "latestArrivalS", "availableWindowS", "dailyBoundary", "formationLengthMm", "terminalIntervals", "movementKind", "continuity", "maximumDwellMs", "resourceIds", "resourceSetSha256", "through", "outbound"], name);
    for (const field of ["id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId"]) nonEmptyString(template[field], `${name}.${field}`);
    invariant(!ids.has(template.id), `Doppelte Movement-Template-ID ${template.id}.`); ids.add(template.id);
    for (const field of ["earliestDepartureS", "latestArrivalS"]) nonNegativeSafeInteger(template[field], `${name}.${field}`);
    positiveSafeInteger(template.availableWindowS, `${name}.availableWindowS`);
    invariant(template.latestArrivalS - template.earliestDepartureS === template.availableWindowS && typeof template.dailyBoundary === "boolean", `${name} besitzt kein exaktes Turnaround-Zeitfenster.`);
    positiveSafeInteger(template.formationLengthMm, `${name}.formationLengthMm`);
    invariant(template.movementKind === "train" && ["same-direction", "reverse-direction"].includes(template.continuity), `${name} besitzt keine direkte physische Kontinuitaet.`);
    invariant(template.maximumDwellMs === specification.policy.maximumDirectDwellMs, `${name} driftet von maximumDirectDwellMs.`);
    validateTerminalIntervals(template.terminalIntervals, template.formationLengthMm, `${name}.terminalIntervals`);
    sortedUniqueStrings(template.resourceIds, `${name}.resourceIds`);
    invariant(template.resourceSetSha256 === movementResourceSetSha256(template.resourceIds), `${name}.resourceSetSha256 bindet nicht seine Ressourcen.`);
    validateDispatch(template.outbound, `${name}.outbound`);
    if (template.continuity === "reverse-direction") {
      invariant(template.through === null, `${name}.through muss fuer die physische Richtungswende null sein.`);
      invariant(template.outbound.continuity === "reverse-direction", `${name}.outbound widerspricht der physischen Richtungswende.`);
      invariant(template.outbound.predecessorBaseRouteVersionId === template.inboundRouteVersionId, `${name}.outbound bindet nicht die Ankunftsbasisroute.`);
    } else {
      validateDispatch(template.through, `${name}.through`);
      invariant(template.through.continuity === "same-direction" && template.outbound.continuity === "same-direction", `${name} besitzt keine lueckenlose Same-Direction-Through-Kette.`);
      invariant(template.through.predecessorBaseRouteVersionId === template.inboundRouteVersionId, `${name}.through bindet nicht die Ankunftsbasisroute.`);
      invariant(template.outbound.predecessorBaseRouteVersionId === template.through.routeVersionId, `${name}.outbound bindet nicht die Through-Route.`);
    }
  }
  const berthAssignmentCounts = { observedOsmServiceSiding: 0, simulatedOperationalOsmServiceYard: 0, simulatedOperationalOsmServiceSpur: 0, simulatedOperationalOsmUnclassifiedRail: 0 };
  let crossBerthTemplateCount = 0;
  const countAssignment = (assignment) => {
    const key = assignment.subtype === "osm-service-siding" ? "observedOsmServiceSiding"
      : assignment.subtype === "osm-service-yard" ? "simulatedOperationalOsmServiceYard"
        : assignment.subtype === "osm-service-spur" ? "simulatedOperationalOsmServiceSpur"
          : "simulatedOperationalOsmUnclassifiedRail";
    berthAssignmentCounts[key] += 1;
  };
  for (const [index, template] of sidecar.templates.entries()) {
    const name = `Movement-Sidecar.templates[${index}]`;
    exactKeys(template, ["id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId", "earliestDepartureS", "latestArrivalS", "availableWindowS", "dailyBoundary", "terminalEdgeId", "terminalNodeId", "inboundDirection", "outboundDirection", "formationLengthMm", "candidateRank", "stablingPathLengthMm", "terminalIntervals", "stablingKind", "arrivalBerthAssignment", "departureBerthAssignment", "shuntIn", "arrivalBerth", "berthTransfer", "berthTransferProvenance", "departureBerth", "shuntOut", "outbound"], name);
    for (const field of ["id", "demandId", "inboundRouteVersionId", "outboundRouteVersionId", "locationId", "physicalStopId", "terminalEdgeId"]) nonEmptyString(template[field], `${name}.${field}`);
    invariant(!ids.has(template.id), `Doppelte Movement-Template-ID ${template.id}.`); ids.add(template.id);
    for (const field of ["earliestDepartureS", "latestArrivalS"]) nonNegativeSafeInteger(template[field], `${name}.${field}`);
    positiveSafeInteger(template.availableWindowS, `${name}.availableWindowS`);
    invariant(template.latestArrivalS - template.earliestDepartureS === template.availableWindowS, `${name} besitzt kein exaktes Turnaround-Zeitfenster.`);
    invariant(typeof template.dailyBoundary === "boolean", `${name}.dailyBoundary ist nicht boolesch.`);
    invariant(Number.isSafeInteger(template.terminalNodeId), `${name}.terminalNodeId ist keine sichere Ganzzahl.`);
    invariant(["along", "against"].includes(template.inboundDirection) && ["along", "against"].includes(template.outboundDirection), `${name} besitzt ungueltige Richtungen.`);
    positiveSafeInteger(template.formationLengthMm, `${name}.formationLengthMm`);
    nonNegativeSafeInteger(template.candidateRank, `${name}.candidateRank`);
    positiveSafeInteger(template.stablingPathLengthMm, `${name}.stablingPathLengthMm`);
    validateTerminalIntervals(template.terminalIntervals, template.formationLengthMm, `${name}.terminalIntervals`, template.terminalEdgeId);
    validateBerthAssignment(template.arrivalBerthAssignment, `${name}.arrivalBerthAssignment`);
    validateBerthAssignment(template.departureBerthAssignment, `${name}.departureBerthAssignment`);
    validateBerth(template.arrivalBerth, template.formationLengthMm, `${name}.arrivalBerth`);
    validateBerth(template.departureBerth, template.formationLengthMm, `${name}.departureBerth`);
    for (const field of ["shuntIn", "shuntOut", "outbound"]) validateDispatch(template[field], `${name}.${field}`);
    invariant(template.shuntIn.continuity === "same-direction" && template.outbound.continuity === "same-direction", `${name} widerspricht der physischen Rangier-Fortsetzungsmatrix.`);
    invariant(template.shuntIn.predecessorBaseRouteVersionId === template.inboundRouteVersionId, `${name}.shuntIn bindet nicht die Ankunftsbasisroute.`);
    countAssignment(template.arrivalBerthAssignment);
    if (template.stablingKind === "shared-berth") {
      invariant(template.berthTransfer === null && template.berthTransferProvenance === null, `${name} erfindet fuer einen Shared-Berth einen internen Transfer.`);
      invariant(JSON.stringify(canonicalValue(template.arrivalBerth)) === JSON.stringify(canonicalValue(template.departureBerth)) && JSON.stringify(canonicalValue(template.arrivalBerthAssignment)) === JSON.stringify(canonicalValue(template.departureBerthAssignment)), `${name} besitzt keinen identischen Shared-Berth.`);
      invariant(["same-direction", "reverse-direction"].includes(template.shuntOut.continuity), `${name}.shuntOut besitzt keine physische Shared-Berth-Continuity.`);
      invariant(template.shuntOut.predecessorBaseRouteVersionId === template.shuntIn.routeVersionId, `${name}.shuntOut bindet nicht shuntIn.`);
    } else {
      invariant(template.stablingKind === "cross-berth-transfer", `${name}.stablingKind ist unbekannt.`);
      validateDispatch(template.berthTransfer, `${name}.berthTransfer`);
      validateBerthTransferProvenance(template.berthTransferProvenance, template, specification, `${name}.berthTransferProvenance`);
      invariant(JSON.stringify(canonicalValue(template.arrivalBerth)) !== JSON.stringify(canonicalValue(template.departureBerth)), `${name} besitzt keinen getrennten Ankunfts-/Abfahrts-Berth.`);
      invariant(template.berthTransfer.continuity === "reverse-direction" && template.shuntOut.continuity === "reverse-direction", `${name} besitzt keine explizite Cross-Berth-Richtungswechselkette.`);
      invariant(template.berthTransfer.predecessorBaseRouteVersionId === template.shuntIn.routeVersionId && template.shuntOut.predecessorBaseRouteVersionId === template.berthTransfer.routeVersionId, `${name} besitzt eine unterbrochene Cross-Berth-Vorgaengerkette.`);
      countAssignment(template.departureBerthAssignment);
      crossBerthTemplateCount += 1;
    }
    invariant(template.outbound.predecessorBaseRouteVersionId === template.shuntOut.routeVersionId, `${name}.outbound bindet nicht shuntOut.`);
  }
  const observedCount = berthAssignmentCounts.observedOsmServiceSiding;
  const simulatedCount = berthAssignmentCounts.simulatedOperationalOsmServiceYard + berthAssignmentCounts.simulatedOperationalOsmServiceSpur + berthAssignmentCounts.simulatedOperationalOsmUnclassifiedRail;
  invariant(
    JSON.stringify(canonicalValue(sidecar.metrics.berthAssignmentCounts)) === JSON.stringify(canonicalValue(berthAssignmentCounts))
      && JSON.stringify(canonicalValue(proof.berthAssignmentCounts)) === JSON.stringify(canonicalValue(berthAssignmentCounts))
      && sidecar.metrics.observedStablingTemplateCount === observedCount
      && sidecar.metrics.simulatedOperationalStablingTemplateCount === simulatedCount
      && sidecar.metrics.crossBerthTemplateCount === crossBerthTemplateCount
      && proof.crossBerthTemplateCount === crossBerthTemplateCount
      && observedCount + simulatedCount === sidecar.templates.length + crossBerthTemplateCount,
    "Movement-Sidecar zaehlt Berth-Provenienz oder Cross-Berth-Templates widerspruechlich.",
  );
  invariant(sidecar.metrics.transferDemandCount + sidecar.metrics.turnaroundDemandCount === sidecar.metrics.plannedTransitionCount && sidecar.metrics.turnaroundPairCount <= sidecar.metrics.turnaroundDemandCount, "Movement-Sidecar partitioniert die geplanten physischen Fortsetzungen nicht vollstaendig.");
  invariant(
    sidecar.metrics.directTemplateCount === sidecar.metrics.turnaroundPairCount * specification.policy.terminalFormationLengthsMm.length
      && sidecar.metrics.transferTemplateCount === sidecar.metrics.transferDemandCount * specification.policy.terminalFormationLengthsMm.length,
    "Movement-Sidecar bildet Direct-/Transferanforderungen nicht je Formationslaenge vollstaendig ab.",
  );
  for (const [index, template] of sidecar.transferTemplates.entries()) {
    const name = `Movement-Sidecar.transferTemplates[${index}]`;
    exactKeys(template, ["id", "demandId", "formationLengthMm", "sourcePassengerRouteVersionId", "targetPassengerRouteVersionId", "sourceLocationId", "targetLocationId", "earliestDepartureS", "latestArrivalS", "availableWindowS", "dailyBoundary", "movementKind", "transfer", "targetOutbound", "resourceIds", "resourceSetSha256"], name);
    for (const field of ["id", "demandId", "sourcePassengerRouteVersionId", "targetPassengerRouteVersionId", "sourceLocationId", "targetLocationId"]) nonEmptyString(template[field], `${name}.${field}`);
    invariant(!ids.has(template.id), `Doppelte Movement-Template-ID ${template.id}.`); ids.add(template.id);
    positiveSafeInteger(template.formationLengthMm, `${name}.formationLengthMm`);
    for (const field of ["earliestDepartureS", "latestArrivalS", "availableWindowS"]) positiveSafeInteger(template[field], `${name}.${field}`);
    invariant(template.latestArrivalS - template.earliestDepartureS === template.availableWindowS && typeof template.dailyBoundary === "boolean" && ["train", "shunting"].includes(template.movementKind), `${name} besitzt ein ungueltiges Zeitfenster oder movementKind.`);
    validateDispatch(template.transfer, `${name}.transfer`);
    validateDispatch(template.targetOutbound, `${name}.targetOutbound`);
    invariant(template.transfer.continuity === "same-direction" && template.targetOutbound.continuity === "same-direction", `${name} widerspricht der physischen Transfer-Fortsetzungsmatrix.`);
    invariant(template.transfer.predecessorBaseRouteVersionId === template.sourcePassengerRouteVersionId && template.targetOutbound.predecessorBaseRouteVersionId === template.transfer.routeVersionId, `${name} besitzt eine unterbrochene Transfer-Vorgaengerkette.`);
    sortedUniqueStrings(template.resourceIds, `${name}.resourceIds`);
    invariant(template.transfer.resourceIds.every((resourceId) => template.resourceIds.includes(resourceId)), `${name} bindet nicht alle Ressourcen seiner ersten Transfer-Fahrstrasse.`);
    invariant(template.resourceSetSha256 === movementResourceSetSha256(template.resourceIds), `${name}.resourceSetSha256 bindet nicht seine Ressourcen.`);
  }
  const { stateHash: ignoredStateHash, ...stateValue } = sidecar;
  void ignoredStateHash;
  invariant(canonicalHash({ schema: "movement-route-templates-v2", value: stateValue }) === sidecar.stateHash, "Movement-Sidecar.stateHash ist nicht kanonisch reproduzierbar.");
  return sidecar;
}

async function assertTargetMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} existiert bereits; create-new verweigert jede Ueberschreibung.`);
}

async function publishTogether(bindings) {
  const published = [];
  try {
    for (const { staged, final } of bindings) {
      await link(staged, final);
      published.push(final);
    }
  } catch (error) {
    for (const path of published.reverse()) await rm(path, { force: true });
    throw new Error(`Operational-v2-Artefakte konnten nicht kollisionsfrei gemeinsam veroeffentlicht werden: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function runGermanyOperationalInfrastructureV2({
  specification,
  specificationPath,
  sourceRoot,
  candidatePath,
  reportPath,
  outputPath,
  movementRouteTemplatesPath,
  deriveNative = spawnGermanyOperationalInfrastructureV2Compiler,
  materialize = materializeOperationalInfrastructureV2,
}) {
  const kind = validateGermanyOperationalInfrastructureV2Specification(specification);
  if (kind !== "conservative") throw new OperationalInfrastructureDerivationBlockedError(assessGermanyOperationalInfrastructureV2Readiness(specification));
  nonEmptyString(specificationPath, "specificationPath");
  nonEmptyString(sourceRoot, "sourceRoot");
  nonEmptyString(candidatePath, "candidatePath");
  nonEmptyString(reportPath, "reportPath");
  if (outputPath !== undefined) nonEmptyString(outputPath, "outputPath");
  if (movementRouteTemplatesPath !== undefined) nonEmptyString(movementRouteTemplatesPath, "movementRouteTemplatesPath");
  const candidate = resolve(candidatePath);
  const report = resolve(reportPath);
  const output = outputPath === undefined ? undefined : resolve(outputPath);
  const movementRouteTemplates = resolve(movementRouteTemplatesPath ?? join(dirname(output ?? candidate), "operational-infrastructure-v2.movement-route-templates-v2.json"));
  invariant(basename(movementRouteTemplates) === "operational-infrastructure-v2.movement-route-templates-v2.json", "Movement-Route-Sidecar besitzt keinen kanonischen Dateinamen.");
  invariant(new Set([candidate, report, movementRouteTemplates, ...(output === undefined ? [] : [output])]).size === (output === undefined ? 3 : 4), "Candidate, Ableitungsbericht, Movement-Sidecar und materialisiertes Operational-v2-Artefakt muessen getrennte Dateien sein.");
  invariant(candidate !== report, "Operational-v2-Candidate und Ableitungsbericht muessen getrennte Dateien sein.");
  if (output !== undefined) invariant(basename(output) === "operational-infrastructure-v2.json", "Operational-v2-Ausgabe besitzt keinen kanonischen Dateinamen.");

  const directories = [dirname(candidate), dirname(report), dirname(movementRouteTemplates), ...(output === undefined ? [] : [dirname(output)])];
  for (const directory of new Set(directories)) await mkdir(directory, { recursive: true });
  await assertTargetMissing(candidate, "Operational-v2-Candidate");
  await assertTargetMissing(report, "Operational-v2-Ableitungsbericht");
  await assertTargetMissing(movementRouteTemplates, "Operational-v2-Movement-Route-Sidecar");
  if (output !== undefined) await assertTargetMissing(output, "Operational-v2-Ausgabe");

  const stagingRoot = await mkdtemp(join(dirname(candidate), ".operational-v2-derive-"));
  const nativeStaging = join(stagingRoot, "native");
  await mkdir(nativeStaging, { recursive: true });
  const stagedCandidate = join(nativeStaging, "operational-infrastructure-v2.json");
  const stagedMovementRouteTemplates = join(nativeStaging, "operational-infrastructure-v2.movement-route-templates-v2.json");
  const stagedReport = join(stagingRoot, "report.json");
  const stagedOutput = join(stagingRoot, "materialized", "operational-infrastructure-v2.json");
  try {
    const nativeReceipt = validateGermanyOperationalInfrastructureV2NativeReceipt(
      await deriveNative(resolve(specificationPath), resolve(sourceRoot), stagedCandidate, stagedReport),
      specification.infraReleaseId,
    );
    const [candidateProof, movementRouteTemplatesProof, reportProof] = await Promise.all([
      fileProof(stagedCandidate, "Nativer Operational-v2-Candidate"),
      fileProof(stagedMovementRouteTemplates, "Natives Operational-v2-Movement-Route-Sidecar"),
      fileProof(stagedReport, "Nativer Operational-v2-Ableitungsbericht"),
    ]);
    invariant(candidateProof.bytes === nativeReceipt.candidate.bytes && candidateProof.sha256 === nativeReceipt.candidate.sha256, "Native Candidate-Bindung stimmt nicht mit den erzeugten Bytes ueberein.");
    invariant(reportProof.bytes === nativeReceipt.report.bytes && reportProof.sha256 === nativeReceipt.report.sha256, "Native Bericht-Bindung stimmt nicht mit den erzeugten Bytes ueberein.");
    invariant(movementRouteTemplatesProof.bytes === nativeReceipt.movementRouteTemplates.bytes && movementRouteTemplatesProof.sha256 === nativeReceipt.movementRouteTemplates.sha256, "Native Movement-Sidecar-Bindung stimmt nicht mit den erzeugten Bytes ueberein.");
    const movementRouteTemplatesValue = validateMovementRouteTemplatesSidecar(
      JSON.parse(await readFile(stagedMovementRouteTemplates, "utf8")),
      specification,
      nativeReceipt.movementRouteTemplates,
    );
    const nativeReport = validateNativeDerivationReport(JSON.parse(await readFile(stagedReport, "utf8")), specification);
    invariant(
      nativeReceipt.activationEligible === nativeReport.activationEligible
        && nativeReceipt.unresolvedRequired === nativeReport.unresolvedRequired,
      "Native Receipt- und Berichtsgates laufen auseinander.",
    );
    invariant(
      nativeReport.candidate.bytes === nativeReceipt.candidate.bytes
        && nativeReport.candidate.sha256 === nativeReceipt.candidate.sha256
        && nativeReport.candidate.stateHash === nativeReceipt.candidate.stateHash,
      "Native Receipt- und Berichtskandidaten laufen auseinander.",
    );
    invariant(
      JSON.stringify(canonicalValue(nativeReport.candidate.movementRouteTemplates)) === JSON.stringify(canonicalValue(nativeReceipt.movementRouteTemplates))
        && movementRouteTemplatesValue.operationalStateHash === nativeReceipt.candidate.stateHash,
      "Native Receipt-, Bericht- und Movement-Sidecar-Bindungen laufen auseinander.",
    );

    if (!nativeReport.activationEligible) {
      await publishTogether([{ staged: stagedCandidate, final: candidate }, { staged: stagedMovementRouteTemplates, final: movementRouteTemplates }, { staged: stagedReport, final: report }]);
      throw new OperationalInfrastructureDerivationIncompleteError({ nativeReceipt, nativeReport, paths: { candidate, movementRouteTemplates, report, output: null } });
    }
    invariant(output !== undefined, "Aktivierbare Operational-v2-Ableitung verlangt einen materialisierten OUTPUT-Pfad.");
    const materialization = await materialize({ candidatePath: stagedCandidate, expectedReleaseId: specification.infraReleaseId, outputPath: stagedOutput });
    invariant(materialization.sourceBytes === candidateProof.bytes && materialization.sourceSha256 === candidateProof.sha256, "Materialisierung ist nicht an den abgeleiteten Candidate gebunden.");
    invariant(materialization.stateHash === nativeReceipt.candidate.stateHash, "Ableitung und Materialisierung besitzen verschiedene Zustandshashes.");
    const outputProof = await fileProof(stagedOutput, "Materialisiertes Operational-v2-Artefakt");
    invariant(outputProof.bytes === materialization.bytes && outputProof.sha256 === materialization.sha256, "Materialisierungs-Receipt stimmt nicht mit den Ausgabe-Bytes ueberein.");
    await publishTogether([{ staged: stagedCandidate, final: candidate }, { staged: stagedMovementRouteTemplates, final: movementRouteTemplates }, { staged: stagedReport, final: report }, { staged: stagedOutput, final: output }]);
    return {
      ...nativeReceipt,
      reportStatus: { unresolvedRequired: nativeReport.unresolvedRequired, activationEligible: nativeReport.activationEligible, realInterlockingFactsClaimed: nativeReport.realInterlockingFactsClaimed },
      materialized: { bytes: outputProof.bytes, sha256: outputProof.sha256, stateHash: materialization.stateHash },
      movementRouteTemplates: { ...nativeReceipt.movementRouteTemplates },
      paths: { candidate, movementRouteTemplates, report, output },
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function deriveGermanyOperationalInfrastructureV2(specification, sourceRoot, options = {}) {
  const kind = validateGermanyOperationalInfrastructureV2Specification(specification);
  if (kind !== "conservative") throw new OperationalInfrastructureDerivationBlockedError(assessGermanyOperationalInfrastructureV2Readiness(specification));
  return runGermanyOperationalInfrastructureV2({ specification, sourceRoot, ...options });
}

export async function readGermanyOperationalDerivationSpec(path) {
  return JSON.parse(await readFile(path, "utf8"));
}
