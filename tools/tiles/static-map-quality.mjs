import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { assertCreateNewTarget, publishFileCreateNew } from "./create-new-output.mjs";

export const STATIC_MAP_QUALITY_MATERIALIZATION_SCHEMA = "zugfolge-static-map-quality-materialization/v2";
export const STATIC_MAP_QUALITY_SCHEMA = "zugfolge-static-map-quality/v2";

const DETAILED_QUALITY_INPUT_SCHEMA = "zugfolge-final-infrastructure-quality-report/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const QUALITY_CLASSES = Object.freeze(["A", "B", "C"]);
const LAYER_FEATURE_TYPES = Object.freeze({
  rail_corridors: "rail-corridor",
  operating_points: "operating-point",
  stations: "station",
  tracks: "track",
  platforms: "platform",
  switches: "switch",
  signals: "signal",
  blocks: "block",
  conflict_resources: "conflict_resource",
  rail_context: "rail_context",
});
export const STATIC_MAP_QUALITY_LAYER_ORDER = Object.freeze(Object.keys(LAYER_FEATURE_TYPES));

const PUBLIC_CLAIMS = Object.freeze({
  detailedSourceReportShipped: false,
  operationalInfraRelease: false,
  productionActivationEligible: false,
});
const PUBLIC_CLASSIFICATION = Object.freeze({
  A: "complete-evidence",
  B: "conservative-visible-model",
  C: "visible-not-operationally-orderable",
});
const FORBIDDEN_PUBLIC_DETAIL = /(?:\/v1\b|trackDimensions|declaredQualityClass|qualityClassificationCorrections|ruleId|evidenceByState|evidenceGapsByReason|operationalHandlingByState|nonPublicSourceRawData|trassenfinder|(?:^|[^a-z0-9])apn(?:$|[^a-z0-9]))/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  invariant(Object.keys(value).sort().join(",") === [...expected].sort().join(","), `${label} besitzt unerwartete oder fehlende Felder.`);
}

function safeId(value, label) {
  invariant(typeof value === "string" && SAFE_ID.test(value), `${label} ist keine sichere ID.`);
  return value;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function serialize(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function sameValue(left, right) {
  return JSON.stringify(sortedValue(left)) === JSON.stringify(sortedValue(right));
}

function validateClassCount(value, label) {
  exactKeys(value, QUALITY_CLASSES, label);
  for (const qualityClass of QUALITY_CLASSES) {
    invariant(Number.isSafeInteger(value[qualityClass]) && value[qualityClass] >= 0, `${label}.${qualityClass} ist keine nichtnegative sichere Ganzzahl.`);
  }
  return value;
}

function sumClassCount(value) {
  return QUALITY_CLASSES.reduce((total, qualityClass) => total + value[qualityClass], 0);
}

function addClassCounts(left, right) {
  return Object.fromEntries(QUALITY_CLASSES.map((qualityClass) => [qualityClass, left[qualityClass] + right[qualityClass]]));
}

function validateSpec(spec) {
  exactKeys(spec, ["schema", "releaseId", "infrastructureCorpusId", "timetableYear", "scopeId", "visibleLayerOrder"], "Quality-Materialisierung");
  invariant(spec.schema === STATIC_MAP_QUALITY_MATERIALIZATION_SCHEMA, "Unbekannte Static-Map-Quality-Materialisierung; ein oeffentlicher v1-Vertrag ist nicht auslieferbar.");
  safeId(spec.releaseId, "releaseId");
  safeId(spec.infrastructureCorpusId, "infrastructureCorpusId");
  safeId(spec.scopeId, "scopeId");
  invariant(Number.isSafeInteger(spec.timetableYear) && spec.timetableYear >= 2026 && spec.timetableYear <= 9999, "timetableYear ist ungueltig.");
  invariant(Array.isArray(spec.visibleLayerOrder), "visibleLayerOrder muss eine Liste sein.");
  invariant(JSON.stringify(spec.visibleLayerOrder) === JSON.stringify(STATIC_MAP_QUALITY_LAYER_ORDER), "visibleLayerOrder muss den vollstaendigen kanonischen Zehn-Layer-Kartenbestand in stabiler Reihenfolge enthalten.");
  return spec;
}

function validateDetailedQualityInput(report, spec) {
  exactKeys(report, ["schema", "releaseId", "timetableYear", "scopeId", "purpose", "operationalReleaseGate", "deterministic", "policy", "summary", "layers", "trackDimensions"], "Detaillierter Quality-Build-Input");
  invariant(report.schema === DETAILED_QUALITY_INPUT_SCHEMA, "Unbekannter detaillierter Quality-Build-Input; nur der bytegebundene Jahresbericht darf projiziert werden.");
  invariant(report.releaseId === spec.infrastructureCorpusId, "Detaillierter Quality-Build-Input gehoert zu einem anderen Infrastrukturkorpus.");
  invariant(report.timetableYear === spec.timetableYear && report.scopeId === spec.scopeId, "Detaillierter Quality-Build-Input verletzt Jahr oder Sichtbarkeitsscope.");
  invariant(report.purpose === "visible-map-quality-evidence" && report.operationalReleaseGate === false, "Detaillierter Quality-Build-Input darf kein Operational-Release-Gate beanspruchen.");
  invariant(report.deterministic === true, "Detaillierter Quality-Build-Input ist nicht deterministisch.");

  exactKeys(report.policy, ["classA", "classB", "classC", "classAFromSingleSourceOrAutomatedInference", "conservativeAssumptionsReportedSeparately", "ordinaryAssumptionsOperationalClassBEligible", "syntheticDerivedClosureRequiredForOperationalClassB", "nonPublicSourceRawDataShipped"], "Detaillierter Quality-Build-Input.policy");
  invariant([report.policy.classA, report.policy.classB, report.policy.classC].every((value) => typeof value === "string" && value !== ""), "Detaillierter Quality-Build-Input definiert die Qualitaetsklassen nicht.");
  invariant(report.policy.classAFromSingleSourceOrAutomatedInference === false, "Klasse A darf nicht allein aus einer Quelle oder automatischer Inferenz behauptet werden.");
  invariant(report.policy.conservativeAssumptionsReportedSeparately === true, "Konservative Annahmen muessen getrennt berichtet sein.");
  invariant(report.policy.ordinaryAssumptionsOperationalClassBEligible === false, "Gewoehnliche Kartenannahmen duerfen kein Operational-B behaupten.");
  invariant(report.policy.syntheticDerivedClosureRequiredForOperationalClassB === true, "Operational-B muss einen getrennten synthetischen Derived-Closure verlangen.");
  invariant(report.policy.nonPublicSourceRawDataShipped === false, "Nichtoeffentliche Quelldaten duerfen nicht als Quality-Build-Input zur Auslieferung markiert sein.");

  exactKeys(report.summary, ["visibleLayers", "visibleFeatures", "declaredQualityClassFeatureCount", "qualityClassFeatureCount"], "Detaillierter Quality-Build-Input.summary");
  validateClassCount(report.summary.declaredQualityClassFeatureCount, "Detaillierter Quality-Build-Input.summary.declaredQualityClassFeatureCount");
  validateClassCount(report.summary.qualityClassFeatureCount, "Detaillierter Quality-Build-Input.summary.qualityClassFeatureCount");
  invariant(sameValue(report.summary.declaredQualityClassFeatureCount, report.summary.qualityClassFeatureCount), "Deklarierte und tatsaechliche Gesamtklassifikation weichen ab.");
  invariant(report.summary.visibleLayers === STATIC_MAP_QUALITY_LAYER_ORDER.length, "Detaillierter Quality-Build-Input besitzt nicht exakt zehn sichtbare Layer.");
  invariant(Number.isSafeInteger(report.summary.visibleFeatures) && report.summary.visibleFeatures > 0, "Detaillierter Quality-Build-Input besitzt keine sichtbaren Features.");
  invariant(sumClassCount(report.summary.qualityClassFeatureCount) === report.summary.visibleFeatures, "Gesamtklassifikation summiert sich nicht zur sichtbaren Featurezahl.");

  invariant(Array.isArray(report.layers) && report.layers.length === STATIC_MAP_QUALITY_LAYER_ORDER.length, "Detaillierter Quality-Build-Input besitzt nicht exakt zehn Layerberichte.");
  invariant(JSON.stringify(report.layers.map(({ name }) => name)) === JSON.stringify(spec.visibleLayerOrder), "Layerberichte verletzen die kanonische sichtbare Reihenfolge.");
  let totalFeatures = 0;
  let totalClassCount = { A: 0, B: 0, C: 0 };
  for (const [index, layer] of report.layers.entries()) {
    const isTrack = layer?.name === "tracks";
    const baseKeys = ["name", "featureType", "bytes", "features", "declaredQualityClassFeatureCount", "qualityClassFeatureCount"];
    const trackKeys = ["totalLengthMm", "declaredQualityClassLengthMm", "qualityClassLengthMm", "qualityClassificationCorrections"];
    exactKeys(layer, isTrack ? [...baseKeys, ...trackKeys] : baseKeys, `Detaillierter Quality-Build-Input.layers[${index}]`);
    invariant(layer.name === STATIC_MAP_QUALITY_LAYER_ORDER[index] && layer.featureType === LAYER_FEATURE_TYPES[layer.name], `${layer.name ?? `Layer ${index}`} besitzt nicht den kanonischen Layer-/Featuretypvertrag.`);
    invariant(Number.isSafeInteger(layer.bytes) && layer.bytes > 0, `${layer.name}.bytes ist ungueltig.`);
    invariant(Number.isSafeInteger(layer.features) && layer.features > 0, `${layer.name}.features ist ungueltig.`);
    validateClassCount(layer.declaredQualityClassFeatureCount, `${layer.name}.declaredQualityClassFeatureCount`);
    validateClassCount(layer.qualityClassFeatureCount, `${layer.name}.qualityClassFeatureCount`);
    invariant(sameValue(layer.declaredQualityClassFeatureCount, layer.qualityClassFeatureCount), `${layer.name}: deklarierte und tatsaechliche Klassifikation weichen ab.`);
    invariant(sumClassCount(layer.qualityClassFeatureCount) === layer.features, `${layer.name}: Klassen summieren sich nicht zur sichtbaren Featurezahl.`);
    if (isTrack) {
      validateClassCount(layer.declaredQualityClassLengthMm, "tracks.declaredQualityClassLengthMm");
      validateClassCount(layer.qualityClassLengthMm, "tracks.qualityClassLengthMm");
      invariant(sameValue(layer.declaredQualityClassLengthMm, layer.qualityClassLengthMm), "tracks: deklarierte und tatsaechliche Laengenklassifikation weichen ab.");
      invariant(Number.isSafeInteger(layer.totalLengthMm) && layer.totalLengthMm > 0 && sumClassCount(layer.qualityClassLengthMm) === layer.totalLengthMm, "tracks: Laengenklassifikation ist unvollstaendig.");
      exactKeys(layer.qualityClassificationCorrections, [], "tracks.qualityClassificationCorrections");
    }
    totalFeatures += layer.features;
    totalClassCount = addClassCounts(totalClassCount, layer.qualityClassFeatureCount);
  }
  invariant(totalFeatures === report.summary.visibleFeatures && sameValue(totalClassCount, report.summary.qualityClassFeatureCount), "Layeraggregation und Quality-Gesamtsumme weichen ab.");

  exactKeys(report.trackDimensions, ["topology", "maximumSpeed", "gradient", "electrification", "trackCount", "signals", "blocks", "conflictResources"], "Detaillierter Quality-Build-Input.trackDimensions");
  for (const [dimension, value] of Object.entries(report.trackDimensions)) {
    invariant(value !== null && typeof value === "object" && typeof value.policy?.ruleId === "string" && value.policy.ruleId.endsWith("/v1"), `Detaillierter Quality-Build-Input.trackDimensions.${dimension} besitzt keinen typisierten Detailregelbeleg.`);
  }
  return report;
}

function projectLayer(layer) {
  const projected = {
    name: layer.name,
    featureType: layer.featureType,
    features: layer.features,
    qualityClassFeatureCount: layer.qualityClassFeatureCount,
  };
  if (layer.name === "tracks") {
    projected.totalLengthMm = layer.totalLengthMm;
    projected.qualityClassLengthMm = layer.qualityClassLengthMm;
  }
  return projected;
}

export function buildStaticMapQuality({ spec: specInput, detailedReport, sourceProof }) {
  const spec = validateSpec(specInput);
  const report = validateDetailedQualityInput(detailedReport, spec);
  exactKeys(sourceProof, ["bytes", "sha256"], "sourceProof");
  invariant(Number.isSafeInteger(sourceProof.bytes) && sourceProof.bytes > 0 && SHA256.test(sourceProof.sha256), "sourceProof besitzt keine gueltige Byte-SHA-Bindung.");
  const value = {
    schema: STATIC_MAP_QUALITY_SCHEMA,
    releaseId: spec.releaseId,
    infrastructureCorpusId: spec.infrastructureCorpusId,
    timetableYear: spec.timetableYear,
    scopeId: spec.scopeId,
    purpose: "static-map-visible-quality",
    deterministic: true,
    claims: PUBLIC_CLAIMS,
    classification: PUBLIC_CLASSIFICATION,
    sourceReport: {
      content: "detailed-infrastructure-quality-report",
      binding: "sha256",
      bytes: sourceProof.bytes,
      sha256: sourceProof.sha256,
      shipped: false,
    },
    summary: {
      visibleLayers: report.summary.visibleLayers,
      visibleFeatures: report.summary.visibleFeatures,
      qualityClassFeatureCount: report.summary.qualityClassFeatureCount,
    },
    layers: report.layers.map(projectLayer),
  };
  return validateStaticMapQuality(value, { releaseId: spec.releaseId, infrastructureCorpusId: spec.infrastructureCorpusId });
}

export function validateStaticMapQuality(value, expected = {}) {
  exactKeys(value, ["schema", "releaseId", "infrastructureCorpusId", "timetableYear", "scopeId", "purpose", "deterministic", "claims", "classification", "sourceReport", "summary", "layers"], "Static-Map-Quality-v2");
  invariant(value.schema === STATIC_MAP_QUALITY_SCHEMA, "Oeffentliche Kartenqualitaet besitzt kein Static-Map-Quality-v2-Schema.");
  safeId(value.releaseId, "Static-Map-Quality-v2.releaseId");
  safeId(value.infrastructureCorpusId, "Static-Map-Quality-v2.infrastructureCorpusId");
  safeId(value.scopeId, "Static-Map-Quality-v2.scopeId");
  if (expected.releaseId !== undefined) invariant(value.releaseId === expected.releaseId, "Static-Map-Quality-v2 gehoert zu einer anderen Kartenrelease-ID.");
  if (expected.infrastructureCorpusId !== undefined) invariant(value.infrastructureCorpusId === expected.infrastructureCorpusId, "Static-Map-Quality-v2 gehoert zu einem anderen Infrastrukturkorpus.");
  invariant(Number.isSafeInteger(value.timetableYear) && value.timetableYear >= 2026 && value.timetableYear <= 9999, "Static-Map-Quality-v2.timetableYear ist ungueltig.");
  invariant(value.purpose === "static-map-visible-quality" && value.deterministic === true, "Static-Map-Quality-v2 ist keine deterministische sichtbare Kartenqualitaet.");
  exactKeys(value.claims, Object.keys(PUBLIC_CLAIMS), "Static-Map-Quality-v2.claims");
  invariant(sameValue(value.claims, PUBLIC_CLAIMS), "Static-Map-Quality-v2.claims lockert die statische, nicht aktivierbare Auslieferungsgrenze.");
  exactKeys(value.classification, QUALITY_CLASSES, "Static-Map-Quality-v2.classification");
  invariant(sameValue(value.classification, PUBLIC_CLASSIFICATION), "Static-Map-Quality-v2.classification besitzt nicht die oeffentliche A/B/C-Semantik.");
  exactKeys(value.sourceReport, ["content", "binding", "bytes", "sha256", "shipped"], "Static-Map-Quality-v2.sourceReport");
  invariant(value.sourceReport.content === "detailed-infrastructure-quality-report" && value.sourceReport.binding === "sha256", "Static-Map-Quality-v2 bindet keinen detaillierten Quality-Build-Input.");
  invariant(Number.isSafeInteger(value.sourceReport.bytes) && value.sourceReport.bytes > 0 && SHA256.test(value.sourceReport.sha256), "Static-Map-Quality-v2 besitzt keinen bytegenauen Quellberichtbeleg.");
  invariant(value.sourceReport.shipped === false, "Der detaillierte Quality-Build-Input darf nicht ausgeliefert werden.");

  exactKeys(value.summary, ["visibleLayers", "visibleFeatures", "qualityClassFeatureCount"], "Static-Map-Quality-v2.summary");
  validateClassCount(value.summary.qualityClassFeatureCount, "Static-Map-Quality-v2.summary.qualityClassFeatureCount");
  invariant(value.summary.visibleLayers === STATIC_MAP_QUALITY_LAYER_ORDER.length && Number.isSafeInteger(value.summary.visibleFeatures) && value.summary.visibleFeatures > 0, "Static-Map-Quality-v2 besitzt keinen vollstaendigen sichtbaren Zehn-Layer-Korpus.");
  invariant(sumClassCount(value.summary.qualityClassFeatureCount) === value.summary.visibleFeatures, "Static-Map-Quality-v2-Gesamtklassifikation ist unvollstaendig.");
  invariant(Array.isArray(value.layers) && value.layers.length === STATIC_MAP_QUALITY_LAYER_ORDER.length, "Static-Map-Quality-v2 besitzt nicht exakt zehn sichtbare Layer.");
  invariant(JSON.stringify(value.layers.map(({ name }) => name)) === JSON.stringify(STATIC_MAP_QUALITY_LAYER_ORDER), "Static-Map-Quality-v2-Layerreihenfolge ist nicht kanonisch.");
  let totalFeatures = 0;
  let totalClassCount = { A: 0, B: 0, C: 0 };
  for (const [index, layer] of value.layers.entries()) {
    const isTrack = layer?.name === "tracks";
    exactKeys(layer, isTrack
      ? ["name", "featureType", "features", "qualityClassFeatureCount", "totalLengthMm", "qualityClassLengthMm"]
      : ["name", "featureType", "features", "qualityClassFeatureCount"], `Static-Map-Quality-v2.layers[${index}]`);
    invariant(layer.name === STATIC_MAP_QUALITY_LAYER_ORDER[index] && layer.featureType === LAYER_FEATURE_TYPES[layer.name], `${layer.name ?? `Layer ${index}`} verletzt den oeffentlichen Layer-/Featuretypvertrag.`);
    invariant(Number.isSafeInteger(layer.features) && layer.features > 0, `${layer.name}.features ist ungueltig.`);
    validateClassCount(layer.qualityClassFeatureCount, `${layer.name}.qualityClassFeatureCount`);
    invariant(sumClassCount(layer.qualityClassFeatureCount) === layer.features, `${layer.name}: Klassen summieren sich nicht zur sichtbaren Featurezahl.`);
    if (isTrack) {
      validateClassCount(layer.qualityClassLengthMm, "tracks.qualityClassLengthMm");
      invariant(Number.isSafeInteger(layer.totalLengthMm) && layer.totalLengthMm > 0 && sumClassCount(layer.qualityClassLengthMm) === layer.totalLengthMm, "tracks: oeffentliche Laengenklassifikation ist unvollstaendig.");
    }
    totalFeatures += layer.features;
    totalClassCount = addClassCounts(totalClassCount, layer.qualityClassFeatureCount);
  }
  invariant(totalFeatures === value.summary.visibleFeatures && sameValue(totalClassCount, value.summary.qualityClassFeatureCount), "Static-Map-Quality-v2-Layeraggregation und Gesamtsumme weichen ab.");
  invariant(!FORBIDDEN_PUBLIC_DETAIL.test(JSON.stringify(value)), "Static-Map-Quality-v2 enthaelt v1-, Detailregel- oder interne Evidenzdaten.");
  return value;
}

export function serializeStaticMapQuality(value) {
  validateStaticMapQuality(value);
  return serialize(value);
}

async function writeDurable(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeStaticMapQuality(value, outputPathInput) {
  const bytes = serializeStaticMapQuality(value);
  const outputPath = resolve(outputPathInput);
  const outputParent = dirname(outputPath);
  await assertCreateNewTarget(outputPath, "Static-Map-Quality-v2-Ziel");
  await mkdir(outputParent, { recursive: true });
  const temporaryRoot = await mkdtemp(join(outputParent, `.${basename(outputPath)}.materializing-`));
  const temporaryPath = join(temporaryRoot, basename(outputPath));
  try {
    await writeDurable(temporaryPath, bytes);
    await publishFileCreateNew(temporaryPath, outputPath, "Static-Map-Quality-v2-Ziel");
    return { status: "materialized", outputPath, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function materializeStaticMapQuality(specInput, detailedReportPathInput, outputPathInput) {
  const detailedReportPath = resolve(detailedReportPathInput);
  const metadata = await lstat(detailedReportPath);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), "Detaillierter Quality-Build-Input muss eine regulaere Datei sein.");
  const sourceBytes = await readFile(detailedReportPath);
  invariant(sourceBytes.length > 0 && sourceBytes.length <= 32 * 1024 * 1024, "Detaillierter Quality-Build-Input hat eine unzulaessige Groesse.");
  let detailedReport;
  try {
    detailedReport = JSON.parse(sourceBytes.toString("utf8"));
  } catch {
    throw new Error("Detaillierter Quality-Build-Input ist kein gueltiges JSON.");
  }
  const sourceProof = { bytes: sourceBytes.length, sha256: createHash("sha256").update(sourceBytes).digest("hex") };
  const value = buildStaticMapQuality({ spec: specInput, detailedReport, sourceProof });
  const written = await writeStaticMapQuality(value, outputPathInput);
  return { ...written, quality: value, sourceProof };
}
