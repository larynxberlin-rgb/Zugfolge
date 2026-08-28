import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalize as normalizePosix } from "node:path/posix";

import {
  BASEMAP_VECTOR_LAYERS,
  INFRASTRUCTURE_VECTOR_LAYERS,
  expandMapPackagePlan,
  validateRuntimeStyle,
} from "./map-package.mjs";

export const MAP_PREVIEW_BUILD_SPEC_SCHEMA = "zugfolge-map-preview-build-spec/v1";
export const MAP_PREVIEW_SCHEMA = "zugfolge-map-preview/v1";
export const MAP_PREVIEW_QUALITY_SCHEMA = "zugfolge-map-preview-quality/v1";
export const MAP_PREVIEW_SOURCES_SCHEMA = "zugfolge-map-preview-sources/v1";

const MAP_PACKAGE_PLAN_V1 = "zugfolge-map-package-plan/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const REQUIRED_BLOCKERS = Object.freeze([
  "class-c-visible-only",
  "infrarelease-not-produced",
  "operational-v2-absent",
  "production-activation-forbidden",
  "retained-2026.2-corpus-only",
]);
const BLOCKER_MESSAGES = Object.freeze({
  "class-c-visible-only": "Der unveraenderte Kartenbestand enthaelt weiterhin Klasse-C-Objekte und ist deshalb nur sichtbar, nicht betrieblich freigabefaehig.",
  "infrarelease-not-produced": "Diese Vorschau ist ausdruecklich kein InfraRelease und darf nicht als solches importiert werden.",
  "operational-v2-absent": "Ein OperationalInfrastructureV2-Artefakt ist weder enthalten noch behauptet.",
  "production-activation-forbidden": "Produktionsimport, Produktionsstaging und Weltuebernahme sind fuer dieses Vorschaupaket gesperrt.",
  "retained-2026.2-corpus-only": "Die Vorschau zeigt ausschliesslich den unveraenderten erhaltenen Kartenbestand 2026.2 und keinen operativen Neubau 2026.3.",
});

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactObject(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  invariant(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} besitzt unerwartete oder fehlende Felder.`);
  return value;
}

function safeId(value, label) {
  invariant(typeof value === "string" && SAFE_ID.test(value), `${label} ist keine sichere, stabile ID.`);
  return value;
}

function portablePath(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} fehlt.`);
  invariant(!value.includes("\\") && !value.includes("\0"), `${label} ist nicht portabel.`);
  invariant(!isAbsolute(value) && !value.startsWith("/") && !/^[a-z]:/i.test(value), `${label} muss relativ sein.`);
  invariant(!value.includes("://") && normalizePosix(value) === value, `${label} ist nicht normalisiert.`);
  invariant(value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), `${label} enthaelt einen unsicheren Pfadabschnitt.`);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(sortedValue(left)) === JSON.stringify(sortedValue(right));
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function serializeJson(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pinnedFile(value, label) {
  exactObject(value, ["sourceFile", "expectedBytes", "expectedSha256"], label);
  portablePath(value.sourceFile, `${label}.sourceFile`);
  invariant(Number.isSafeInteger(value.expectedBytes) && value.expectedBytes > 0, `${label}.expectedBytes ist ungueltig.`);
  invariant(typeof value.expectedSha256 === "string" && SHA256.test(value.expectedSha256), `${label}.expectedSha256 ist ungueltig.`);
  return value;
}

function mapArtifact(value, label, expectedKind, expectedLayers) {
  exactObject(value, ["id", "kind", "sourceFile", "installPath", "expectedBytes", "expectedSha256", "expectedVectorLayers"], label);
  safeId(value.id, `${label}.id`);
  invariant(value.kind === expectedKind, `${label}.kind muss ${expectedKind} sein.`);
  portablePath(value.sourceFile, `${label}.sourceFile`);
  portablePath(value.installPath, `${label}.installPath`);
  invariant(value.sourceFile.endsWith(".pmtiles") && value.installPath.endsWith(".pmtiles"), `${label} muss PMTiles binden.`);
  invariant(Number.isSafeInteger(value.expectedBytes) && value.expectedBytes > 127, `${label}.expectedBytes ist ungueltig.`);
  invariant(typeof value.expectedSha256 === "string" && SHA256.test(value.expectedSha256), `${label}.expectedSha256 ist ungueltig.`);
  invariant(Array.isArray(value.expectedVectorLayers) && sameJson([...value.expectedVectorLayers].sort(), expectedLayers), `${label}.expectedVectorLayers verletzt den festen Layervertrag.`);
  return value;
}

function sqliteArtifact(value, label, expectedKind, installPath) {
  exactObject(value, ["id", "kind", "visibility", "sourceFile", "installPath", "expectedBytes", "expectedSha256"], label);
  safeId(value.id, `${label}.id`);
  invariant(value.kind === expectedKind && value.visibility === "public", `${label} hat Art oder Sichtbarkeit geaendert.`);
  portablePath(value.sourceFile, `${label}.sourceFile`);
  invariant(value.sourceFile.endsWith(".sqlite") && value.installPath === installPath, `${label} hat keinen festen SQLite-Installationspfad.`);
  invariant(Number.isSafeInteger(value.expectedBytes) && value.expectedBytes > 0 && SHA256.test(value.expectedSha256), `${label} besitzt keinen vollstaendigen Byte-SHA-Vertrag.`);
  return value;
}

function assetTree(value, label, expectedKind) {
  exactObject(value, ["idPrefix", "kind", "visibility", "sourceDirectory", "installDirectory", "expectedInventory"], label);
  safeId(value.idPrefix, `${label}.idPrefix`);
  invariant(value.kind === expectedKind && value.visibility === "public", `${label} hat Art oder Sichtbarkeit geaendert.`);
  portablePath(value.sourceDirectory, `${label}.sourceDirectory`);
  portablePath(value.installDirectory, `${label}.installDirectory`);
  invariant(value.expectedInventory !== null && typeof value.expectedInventory === "object" && !Array.isArray(value.expectedInventory), `${label}.expectedInventory fehlt.`);
  const entries = Object.entries(value.expectedInventory);
  invariant(entries.length > 0, `${label}.expectedInventory ist leer.`);
  for (const [name, count] of entries) {
    invariant(name !== "" && !name.includes("/") && !name.includes("\\") && Number.isSafeInteger(count) && count > 0, `${label}.expectedInventory ist ungueltig.`);
  }
  return value;
}

function classCounts(value, label) {
  exactObject(value, ["A", "B", "C"], label);
  for (const qualityClass of ["A", "B", "C"]) {
    invariant(Number.isSafeInteger(value[qualityClass]) && value[qualityClass] >= 0, `${label}.${qualityClass} ist ungueltig.`);
  }
  return value;
}

export function validateMapPreviewBuildSpec(value) {
  exactObject(value, ["schema", "previewId", "package", "sourceCorpus", "quality", "claims", "activation", "requiredBlockers"], "Karten-Preview-Bauspezifikation");
  invariant(value.schema === MAP_PREVIEW_BUILD_SPEC_SCHEMA, "Karten-Preview-Bauspezifikation hat ein unbekanntes Schema.");
  safeId(value.previewId, "previewId");
  invariant(value.previewId.includes("preview"), "previewId muss die Vorschaugrenze sichtbar tragen.");

  exactObject(value.package, ["planSchema", "packageId", "version", "partBytes", "runtimePublicBasePath"], "package");
  invariant(value.package.planSchema === MAP_PACKAGE_PLAN_V1, "Karten-Preview muss den Legacy-Kartenpaketvertrag v1 verwenden.");
  safeId(value.package.packageId, "package.packageId");
  safeId(value.package.version, "package.version");
  invariant(value.package.packageId !== "zugfolge-map-deutschland" && value.package.packageId.includes("preview"), "Karten-Preview braucht eine eigene Preview-Paket-ID.");
  invariant(value.package.version.startsWith("2026.3-preview-"), "Karten-Preview braucht eine eigene 2026.3-Preview-Version.");
  invariant(Number.isSafeInteger(value.package.partBytes) && value.package.partBytes > 0 && value.package.partBytes < 2 * 1024 * 1024 * 1024, "package.partBytes ist ungueltig.");
  invariant(value.package.runtimePublicBasePath === `/artifacts/map-previews/${value.previewId}`, "Preview-Runtime muss unter der eigenen /artifacts/map-previews/-Wurzel liegen.");

  exactObject(value.sourceCorpus, [
    "corpusId", "timetableYear", "legacyReference", "legacyRuntimePublicBasePath", "reusedUnchanged",
    "basemap", "semanticMap", "readModel", "trainMapProjection", "styleTemplate", "qualityReport", "sourceManifest",
    "glyphTree", "spriteTree",
  ], "sourceCorpus");
  safeId(value.sourceCorpus.corpusId, "sourceCorpus.corpusId");
  invariant(value.sourceCorpus.timetableYear === 2026, "sourceCorpus.timetableYear muss 2026 sein.");
  invariant(value.sourceCorpus.legacyReference === "infra-deutschland-2026.2", "Preview darf nur den erhaltenen 2026.2-Kartenbestand referenzieren.");
  invariant(value.sourceCorpus.legacyRuntimePublicBasePath === "/artifacts/maps/infra-deutschland-2026.2", "Legacy-Runtimepfad widerspricht dem erhaltenen 2026.2-Stil.");
  invariant(value.sourceCorpus.reusedUnchanged === true, "Preview muss den Kartenbestand ausdruecklich unveraendert wiederverwenden.");
  mapArtifact(value.sourceCorpus.basemap, "sourceCorpus.basemap", "basemap", BASEMAP_VECTOR_LAYERS);
  mapArtifact(value.sourceCorpus.semanticMap, "sourceCorpus.semanticMap", "infrastructure", INFRASTRUCTURE_VECTOR_LAYERS);
  sqliteArtifact(value.sourceCorpus.readModel, "sourceCorpus.readModel", "read-model", "read-model.sqlite");
  sqliteArtifact(value.sourceCorpus.trainMapProjection, "sourceCorpus.trainMapProjection", "train-map-projection", "train-map-projection.sqlite");
  pinnedFile(value.sourceCorpus.styleTemplate, "sourceCorpus.styleTemplate");
  pinnedFile(value.sourceCorpus.qualityReport, "sourceCorpus.qualityReport");
  pinnedFile(value.sourceCorpus.sourceManifest, "sourceCorpus.sourceManifest");
  assetTree(value.sourceCorpus.glyphTree, "sourceCorpus.glyphTree", "glyph");
  assetTree(value.sourceCorpus.spriteTree, "sourceCorpus.spriteTree", "sprite");

  exactObject(value.quality, ["status", "expectedVisibleFeatures", "expectedQualityClassFeatureCount", "expectedClassCByLayer"], "quality");
  invariant(value.quality.status === "blocked", "Preview-Qualitaetsstatus muss blocked bleiben.");
  invariant(Number.isSafeInteger(value.quality.expectedVisibleFeatures) && value.quality.expectedVisibleFeatures > 0, "quality.expectedVisibleFeatures ist ungueltig.");
  classCounts(value.quality.expectedQualityClassFeatureCount, "quality.expectedQualityClassFeatureCount");
  const classTotal = Object.values(value.quality.expectedQualityClassFeatureCount).reduce((sum, count) => sum + count, 0);
  invariant(classTotal === value.quality.expectedVisibleFeatures, "Preview-Qualitaetsklassen summieren sich nicht zur sichtbaren Featurezahl.");
  invariant(value.quality.expectedQualityClassFeatureCount.C > 0, "Preview muss den vorhandenen Klasse-C-Blocker sichtbar halten.");
  invariant(Array.isArray(value.quality.expectedClassCByLayer) && value.quality.expectedClassCByLayer.length > 0, "quality.expectedClassCByLayer muss die Klasse-C-Layer nennen.");
  let previousLayer = "";
  let classCByLayer = 0;
  for (const [index, entry] of value.quality.expectedClassCByLayer.entries()) {
    exactObject(entry, ["layer", "features"], `quality.expectedClassCByLayer[${index}]`);
    safeId(entry.layer, `quality.expectedClassCByLayer[${index}].layer`);
    invariant(entry.layer.localeCompare(previousLayer, "en") > 0, "quality.expectedClassCByLayer muss stabil nach Layer sortiert sein.");
    invariant(Number.isSafeInteger(entry.features) && entry.features > 0, `quality.expectedClassCByLayer[${index}].features ist ungueltig.`);
    previousLayer = entry.layer;
    classCByLayer += entry.features;
  }
  invariant(classCByLayer === value.quality.expectedQualityClassFeatureCount.C, "Klasse-C-Layersumme widerspricht der Preview-Gesamtsumme.");

  exactObject(value.claims, ["infraRelease", "operationalInfrastructureV2", "productionRelease", "pmtilesReusedByteForByte"], "claims");
  invariant(value.claims.infraRelease === false, "Preview darf kein InfraRelease behaupten.");
  invariant(value.claims.operationalInfrastructureV2 === false, "Preview darf kein OperationalInfrastructureV2 behaupten.");
  invariant(value.claims.productionRelease === false, "Preview darf kein Produktionsrelease behaupten.");
  invariant(value.claims.pmtilesReusedByteForByte === true, "Preview muss die byteidentische PMTiles-Wiederverwendung ausdruecklich binden.");

  exactObject(value.activation, ["eligible", "productionImportAllowed", "productionStagingAllowed", "worldAdoptionAllowed"], "activation");
  invariant(Object.values(value.activation).every((flag) => flag === false), "Preview-Aktivierung muss in jeder Stufe fail-closed bleiben.");

  invariant(Array.isArray(value.requiredBlockers) && sameJson(value.requiredBlockers, REQUIRED_BLOCKERS), "Preview muss den vollstaendigen, stabil sortierten Blockersatz tragen.");
  return value;
}

function generatedDescriptor(id, kind, sourceFile, installPath, bytes) {
  return {
    id,
    kind,
    visibility: "public",
    sourceFile,
    installPath,
    expectedBytes: bytes.length,
    expectedSha256: sha256(bytes),
  };
}

function publicBlockers(spec) {
  return spec.requiredBlockers.map((code) => ({ code, status: "blocking", message: BLOCKER_MESSAGES[code] }));
}

function rebaseStyle(style, sourceBasePath, previewBasePath) {
  let replacements = 0;
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
    }
    if (typeof value === "string" && value.includes(sourceBasePath)) {
      const occurrences = value.split(sourceBasePath).length - 1;
      replacements += occurrences;
      return value.split(sourceBasePath).join(previewBasePath);
    }
    return value;
  }
  const rebased = visit(style);
  invariant(replacements === 3, "Legacy-Stil muss genau Basemap, Glyphen und Sprite auf die Preview-Runtime umbiegen.");
  invariant(!JSON.stringify(rebased).includes(sourceBasePath), "Preview-Stil referenziert weiterhin die Legacy-Runtime.");
  return rebased;
}

function observedClassCByLayer(qualityReport) {
  invariant(Array.isArray(qualityReport.layers), "Legacy-Qualitaetsbericht besitzt keine Layer.");
  return qualityReport.layers
    .map((layer, index) => {
      invariant(layer !== null && typeof layer === "object" && typeof layer.name === "string", `Legacy-Qualitaetslayer[${index}] ist ungueltig.`);
      classCounts(layer.qualityClassFeatureCount, `Legacy-Qualitaetslayer[${index}].qualityClassFeatureCount`);
      return { layer: layer.name, features: layer.qualityClassFeatureCount.C };
    })
    .filter(({ features }) => features > 0)
    .sort((left, right) => left.layer.localeCompare(right.layer, "en"));
}

function buildPublicDocuments(spec, styleTemplate, qualityReport, sourceManifest) {
  invariant(qualityReport?.schema === "zugfolge-final-infrastructure-quality-report/v1", "Legacy-Qualitaetsbericht hat ein unbekanntes Schema.");
  invariant(qualityReport.releaseId === spec.sourceCorpus.legacyReference, "Legacy-Qualitaetsbericht gehoert zu einem anderen Bestand.");
  invariant(qualityReport.summary?.visibleFeatures === spec.quality.expectedVisibleFeatures, "Legacy-Qualitaetsbericht hat eine andere sichtbare Featurezahl.");
  invariant(sameJson(qualityReport.summary?.qualityClassFeatureCount, spec.quality.expectedQualityClassFeatureCount), "Legacy-Qualitaetsbericht hat andere Qualitaetsklassenwerte.");
  invariant(sameJson(observedClassCByLayer(qualityReport), spec.quality.expectedClassCByLayer), "Legacy-Qualitaetsbericht hat einen anderen Klasse-C-Blockerbestand.");
  invariant(sourceManifest?.schema === "zugfolge-map-delivery-sources/v1" && sourceManifest.releaseId === spec.sourceCorpus.legacyReference, "Legacy-Quellenmanifest gehoert zu einem anderen Bestand.");
  invariant(Array.isArray(sourceManifest.sources) && sourceManifest.sources.length > 0, "Legacy-Quellenmanifest besitzt keine Quellen.");
  invariant(sourceManifest.sources.every((source) => source?.approved === true && typeof source.id === "string" && typeof source.attribution === "string" && typeof source.license === "string"), "Legacy-Quellenmanifest besitzt keine vollstaendig freigegebenen Attributionen.");

  const blockers = publicBlockers(spec);
  const sourceCorpus = {
    id: spec.sourceCorpus.corpusId,
    legacyReference: spec.sourceCorpus.legacyReference,
    reusedUnchanged: true,
    timetableYear: spec.sourceCorpus.timetableYear,
  };
  const preview = {
    schema: MAP_PREVIEW_SCHEMA,
    previewId: spec.previewId,
    status: "blocked",
    activationEligible: false,
    package: {
      id: spec.package.packageId,
      planSchema: spec.package.planSchema,
      version: spec.package.version,
    },
    sourceCorpus,
    claims: spec.claims,
    activation: spec.activation,
    quality: {
      status: spec.quality.status,
      classCFeatures: spec.quality.expectedQualityClassFeatureCount.C,
    },
    blockers,
  };
  const quality = {
    schema: MAP_PREVIEW_QUALITY_SCHEMA,
    previewId: spec.previewId,
    sourceCorpusId: spec.sourceCorpus.corpusId,
    status: "blocked",
    activationEligible: false,
    retainedLegacyClassification: {
      visibleFeatures: spec.quality.expectedVisibleFeatures,
      qualityClassFeatureCount: spec.quality.expectedQualityClassFeatureCount,
      classCByLayer: spec.quality.expectedClassCByLayer,
    },
    blockers,
  };
  const sources = {
    schema: MAP_PREVIEW_SOURCES_SCHEMA,
    previewId: spec.previewId,
    status: "blocked",
    activationEligible: false,
    sourceCorpus,
    claims: spec.claims,
    pinnedArtifacts: [
      { id: spec.sourceCorpus.basemap.id, role: "basemap-pmtiles", bytes: spec.sourceCorpus.basemap.expectedBytes, sha256: spec.sourceCorpus.basemap.expectedSha256 },
      { id: spec.sourceCorpus.semanticMap.id, role: "semantic-pmtiles", bytes: spec.sourceCorpus.semanticMap.expectedBytes, sha256: spec.sourceCorpus.semanticMap.expectedSha256 },
      { id: spec.sourceCorpus.readModel.id, role: "read-model", bytes: spec.sourceCorpus.readModel.expectedBytes, sha256: spec.sourceCorpus.readModel.expectedSha256 },
      { id: spec.sourceCorpus.trainMapProjection.id, role: "train-map-projection", bytes: spec.sourceCorpus.trainMapProjection.expectedBytes, sha256: spec.sourceCorpus.trainMapProjection.expectedSha256 },
    ].sort((left, right) => left.id.localeCompare(right.id, "en")),
    sourceAttributions: [...sourceManifest.sources].sort((left, right) => left.id.localeCompare(right.id, "en")),
    styleHandling: "legacy-style-rebased-to-preview-runtime-only",
  };
  const style = rebaseStyle(styleTemplate, spec.sourceCorpus.legacyRuntimePublicBasePath, spec.package.runtimePublicBasePath);
  return { preview, quality, sources, style };
}

export function createMapPreviewPackagePlan(specInput, documents) {
  const spec = validateMapPreviewBuildSpec(specInput);
  invariant(documents !== null && typeof documents === "object", "Preview-Dokumente fehlen.");
  const previewBytes = serializeJson(documents.preview);
  const qualityBytes = serializeJson(documents.quality);
  const sourcesBytes = serializeJson(documents.sources);
  const styleBytes = serializeJson(documents.style);
  return {
    schema: MAP_PACKAGE_PLAN_V1,
    packageId: spec.package.packageId,
    version: spec.package.version,
    partBytes: spec.package.partBytes,
    runtime: {
      schema: "zugfolge-map-runtime/v1",
      publicBasePath: spec.package.runtimePublicBasePath,
      basemapStyleUrl: `${spec.package.runtimePublicBasePath}/style.json`,
      infrastructurePmtilesUrl: `${spec.package.runtimePublicBasePath}/${spec.sourceCorpus.semanticMap.installPath}`,
    },
    artifacts: [spec.sourceCorpus.basemap, spec.sourceCorpus.semanticMap],
    auxiliaryFiles: [
      generatedDescriptor("preview-quality", "quality-manifest", "public/quality.json", "manifests/preview-quality.json", qualityBytes),
      spec.sourceCorpus.readModel,
      generatedDescriptor("preview-contract", "release-manifest", "public/preview.json", "manifests/preview.json", previewBytes),
      generatedDescriptor("preview-sources", "source-manifest", "public/sources.json", "manifests/preview-sources.json", sourcesBytes),
      spec.sourceCorpus.trainMapProjection,
      generatedDescriptor("preview-style", "style", "style.json", "style.json", styleBytes),
    ],
    auxiliaryTrees: [spec.sourceCorpus.glyphTree, spec.sourceCorpus.spriteTree],
  };
}

export function validateMapPreviewPackagePlan(plan, specInput) {
  const spec = validateMapPreviewBuildSpec(specInput);
  exactObject(plan, ["schema", "packageId", "version", "partBytes", "runtime", "artifacts", "auxiliaryFiles", "auxiliaryTrees"], "Preview-Kartenpaketplan");
  invariant(plan.schema === MAP_PACKAGE_PLAN_V1, "Preview-Kartenpaketplan muss v1 bleiben.");
  invariant(plan.packageId === spec.package.packageId && plan.version === spec.package.version && plan.partBytes === spec.package.partBytes, "Preview-Kartenpaketplan widerspricht der Preview-Paketidentitaet.");
  invariant(plan.packageId !== "zugfolge-map-deutschland" && plan.version !== "2026.3", "Preview-Kartenpaketplan kollidiert mit dem Produktionsvertrag 2026.3.");
  exactObject(plan.runtime, ["schema", "publicBasePath", "basemapStyleUrl", "infrastructurePmtilesUrl"], "Preview-Kartenpaketplan.runtime");
  invariant(plan.runtime.schema === "zugfolge-map-runtime/v1" && plan.runtime.publicBasePath === spec.package.runtimePublicBasePath, "Preview-Kartenpaketplan besitzt eine fremde Runtimewurzel.");
  invariant(plan.runtime.basemapStyleUrl === `${plan.runtime.publicBasePath}/style.json`, "Preview-Stilpfad ist nicht previewgebunden.");
  invariant(plan.runtime.infrastructurePmtilesUrl === `${plan.runtime.publicBasePath}/${spec.sourceCorpus.semanticMap.installPath}`, "Preview-Semantikpfad ist nicht previewgebunden.");
  invariant(sameJson(plan.artifacts, [spec.sourceCorpus.basemap, spec.sourceCorpus.semanticMap]), "Preview-Kartenpaketplan veraendert die gepinnten PMTiles-Artefakte.");
  invariant(sameJson(plan.auxiliaryTrees, [spec.sourceCorpus.glyphTree, spec.sourceCorpus.spriteTree]), "Preview-Kartenpaketplan veraendert die gepinnten Assetbaeume.");
  invariant(Array.isArray(plan.auxiliaryFiles) && plan.auxiliaryFiles.length === 6, "Preview-Kartenpaketplan braucht genau sechs direkte v1-Hilfsdateien.");
  invariant(plan.auxiliaryFiles.filter(({ kind }) => kind === "train-map-projection").length === 1, "Preview-Kartenpaketplan braucht die erhaltene v1-Zugprojektion.");
  invariant(plan.auxiliaryFiles.filter(({ kind }) => kind === "read-model").length === 1, "Preview-Kartenpaketplan braucht das erhaltene v1-ReadModel.");
  invariant(plan.auxiliaryFiles.every(({ kind }) => kind !== "operational-infrastructure-v2"), "Preview-Kartenpaketplan darf kein OperationalInfrastructureV2-Artefakt enthalten.");
  invariant(!JSON.stringify(plan).includes("infra-deutschland-2026.3"), "Preview-Kartenpaketplan darf keinen produktiven 2026.3-InfraRelease-Pfad behaupten.");
  const expectedRetained = [spec.sourceCorpus.readModel, spec.sourceCorpus.trainMapProjection];
  for (const retained of expectedRetained) {
    invariant(plan.auxiliaryFiles.some((entry) => sameJson(entry, retained)), `Preview-Kartenpaketplan veraendert ${retained.id}.`);
  }
  for (const [kind, sourceFile, installPath] of [
    ["release-manifest", "public/preview.json", "manifests/preview.json"],
    ["quality-manifest", "public/quality.json", "manifests/preview-quality.json"],
    ["source-manifest", "public/sources.json", "manifests/preview-sources.json"],
    ["style", "style.json", "style.json"],
  ]) {
    const matches = plan.auxiliaryFiles.filter((entry) => entry.kind === kind);
    invariant(matches.length === 1 && matches[0].sourceFile === sourceFile && matches[0].installPath === installPath, `Preview-Kartenpaketplan besitzt keinen getrennten ${kind}-Pfad.`);
    invariant(Number.isSafeInteger(matches[0].expectedBytes) && matches[0].expectedBytes > 0 && SHA256.test(matches[0].expectedSha256), `${kind} besitzt keinen Byte-SHA-Vertrag.`);
  }
  return plan;
}

async function sourceRoot(value) {
  const requested = resolve(value);
  const metadata = await lstat(requested);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Preview-Quellwurzel muss ein regulaeres Verzeichnis ohne symbolischen Link sein.");
  return realpath(requested);
}

async function containedRegularFile(root, descriptor, label, { read = false } = {}) {
  const sourceFile = portablePath(descriptor.sourceFile, `${label}.sourceFile`);
  let current = root;
  for (const [index, segment] of sourceFile.split("/").entries()) {
    current = join(current, segment);
    const metadata = await lstat(current);
    invariant(!metadata.isSymbolicLink(), `${label} darf keinen symbolischen Link enthalten.`);
    if (index < sourceFile.split("/").length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen ungueltigen Zwischenpfad.`);
  }
  const actual = await realpath(current);
  const remainder = relative(root, actual);
  invariant(remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder), `${label} verlaesst die Quellwurzel.`);
  const metadata = await lstat(actual);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} muss eine regulaere Datei sein.`);
  invariant(metadata.size === descriptor.expectedBytes, `${label} hat nicht die gepinnte Bytezahl.`);
  if (!read) return { path: actual, bytes: metadata.size };
  const bytes = await readFile(actual);
  invariant(bytes.length === descriptor.expectedBytes && sha256(bytes) === descriptor.expectedSha256, `${label} hat nicht den gepinnten SHA-256.`);
  return { path: actual, bytes };
}

async function parsedPinnedJson(root, descriptor, label) {
  const result = await containedRegularFile(root, descriptor, label, { read: true });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes));
  } catch {
    throw new Error(`${label} ist kein gueltiges UTF-8-JSON.`);
  }
}
export async function buildMapPreviewBundle({ spec: specInput, packagePlan, sourceRoot: requestedSourceRoot }) {
  const spec = validateMapPreviewBuildSpec(specInput);
  const root = await sourceRoot(requestedSourceRoot);
  await Promise.all([
    containedRegularFile(root, spec.sourceCorpus.basemap, "Preview-Basemap"),
    containedRegularFile(root, spec.sourceCorpus.semanticMap, "Preview-Semantikkarte"),
    containedRegularFile(root, spec.sourceCorpus.readModel, "Preview-ReadModel"),
    containedRegularFile(root, spec.sourceCorpus.trainMapProjection, "Preview-Zugprojektion"),
  ]);
  const [styleTemplate, qualityReport, sourceManifest] = await Promise.all([
    parsedPinnedJson(root, spec.sourceCorpus.styleTemplate, "Preview-Stilvorlage"),
    parsedPinnedJson(root, spec.sourceCorpus.qualityReport, "Preview-Qualitaetsbericht"),
    parsedPinnedJson(root, spec.sourceCorpus.sourceManifest, "Preview-Quellenmanifest"),
  ]);
  const documents = buildPublicDocuments(spec, styleTemplate, qualityReport, sourceManifest);
  const derivedPlan = createMapPreviewPackagePlan(spec, documents);
  validateMapPreviewPackagePlan(derivedPlan, spec);
  if (packagePlan !== undefined) {
    validateMapPreviewPackagePlan(packagePlan, spec);
    invariant(sameJson(packagePlan, derivedPlan), "Versionierter Preview-Kartenpaketplan weicht von den realen gepinnten Eingaben ab.");
  }
  const plan = packagePlan ?? derivedPlan;
  const files = new Map([
    ["map-package.plan.json", serializeJson(plan)],
    ["public/preview.json", serializeJson(documents.preview)],
    ["public/quality.json", serializeJson(documents.quality)],
    ["public/sources.json", serializeJson(documents.sources)],
    ["style.json", serializeJson(documents.style)],
  ]);
  return { spec, sourceRoot: root, plan, documents, files };
}

async function inventoryDirectory(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const portable = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    invariant(!metadata.isSymbolicLink(), `Preview-Ausgabe enthaelt einen symbolischen Link: ${portable}.`);
    if (metadata.isDirectory()) files.push(...await inventoryDirectory(path, portable));
    else {
      invariant(metadata.isFile(), `Preview-Ausgabe enthaelt einen ungueltigen Eintrag: ${portable}.`);
      files.push(portable);
    }
  }
  return files.sort();
}

async function verifyBundleFiles(root, files) {
  const observed = await inventoryDirectory(root);
  const expected = [...files.keys()].sort();
  invariant(sameJson(observed, expected), "Preview-Ausgabeverzeichnis besitzt ein unerwartetes Dateiinventar.");
  for (const [portable, expectedBytes] of files) {
    const actual = await readFile(join(root, ...portable.split("/")));
    invariant(actual.equals(expectedBytes), `Preview-Ausgabedatei ${portable} weicht vom Vertrag ab.`);
  }
}

async function validateWrittenBundle(bundle, root) {
  await verifyBundleFiles(root, bundle.files);
  const expanded = await expandMapPackagePlan(bundle.plan, [bundle.sourceRoot, root]);
  validateRuntimeStyle(bundle.documents.style, expanded);
  invariant(expanded.schema === "zugfolge-map-package-spec/v1", "Preview-Plan expandiert nicht zum v1-Kartenpaketvertrag.");
  invariant(expanded.auxiliaryFiles.some(({ kind }) => kind === "train-map-projection"), "Preview-v1-Paket hat keine Legacy-Zugprojektion.");
  invariant(expanded.auxiliaryFiles.every(({ kind }) => kind !== "operational-infrastructure-v2"), "Preview-v1-Paket enthaelt unerwartet OperationalInfrastructureV2.");
  return expanded;
}

export async function writeMapPreviewBundle(bundle, outputRoot) {
  invariant(bundle !== null && typeof bundle === "object" && bundle.files instanceof Map, "Preview-Buildergebnis fehlt.");
  const destination = resolve(outputRoot);
  const requestedParent = dirname(destination);
  await mkdir(requestedParent, { recursive: true });
  const parent = await realpath(requestedParent);
  const parentMetadata = await lstat(parent);
  invariant(parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink(), "Preview-Ausgabeelternverzeichnis muss regulaer sein.");
  const target = resolve(parent, basename(destination));
  const targetRemainder = relative(parent, target);
  invariant(targetRemainder !== "" && targetRemainder !== ".." && !targetRemainder.startsWith(`..${sep}`) && !isAbsolute(targetRemainder), "Preview-Ausgabe verlaesst ihr Elternverzeichnis.");
  try {
    const metadata = await lstat(target);
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Bestehendes Preview-Ziel ist kein regulaeres Verzeichnis.");
    const expanded = await validateWrittenBundle(bundle, target);
    return { status: "reused", root: target, plan: bundle.plan, expanded };
  } catch (error) {
    if (!(error !== null && typeof error === "object" && error.code === "ENOENT")) throw error;
  }

  const temporary = await mkdtemp(join(parent, `.${basename(target)}.${randomUUID()}.building-`));
  let completed = false;
  try {
    for (const [portable, bytes] of bundle.files) {
      const path = join(temporary, ...portable.split("/"));
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const expanded = await validateWrittenBundle(bundle, temporary);
    await rename(temporary, target);
    completed = true;
    return { status: "written", root: target, plan: bundle.plan, expanded };
  } finally {
    if (!completed) await rm(temporary, { recursive: true, force: true });
  }
}
