import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  APN_CAPTURE_SCHEMA,
  normalizeRl100,
  prepareExternalEvidenceRoot,
  renameWithTransientWindowsRetry,
  sha256,
} from "./apn-evidence.mjs";

export const STATION_PLAN_EXTRACTOR_SCHEMA = "zugfolge-internal-station-plan-vector-text/v1";
export const STATION_PLAN_SEMANTIC_REVIEW_SCHEMA = "zugfolge-internal-station-plan-semantic-review/v1";
export const STATION_PLAN_SEMANTIC_REVIEW_VERSION = "station-plan-semantic-review/1";

const CAPTURE_INDEX_FILE = "capture-index.json";
const REVIEW_INDEX_FILE = "semantic-review-index.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_RADIUS_METRES = 1_500;
const DEFAULT_TIMEOUT_MS = 180_000;
const GRID_DEGREES = 0.05;
const LAYER_NAMES = Object.freeze(["signals", "switches", "platforms"]);
const MODULE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeInteger(value, label, minimum, maximum) {
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label} muss zwischen ${minimum} und ${maximum} liegen.`);
  return value;
}

function pathWithin(root, candidate) {
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedCandidate = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.building`;
  await rm(temporary, { force: true });
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await renameWithTransientWindowsRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function* jsonSequence(path) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;
    const json = line.startsWith("\x1e") ? line.slice(1) : line;
    yield JSON.parse(json);
  }
}

function pointFromGeometry(geometry) {
  if (geometry?.type === "Point" && Array.isArray(geometry.coordinates) && geometry.coordinates.length >= 2) {
    const [longitude, latitude] = geometry.coordinates;
    if (Number.isFinite(longitude) && Number.isFinite(latitude)) return { longitude, latitude };
  }
  if (geometry === null || typeof geometry !== "object" || !Array.isArray(geometry.coordinates)) return null;
  const bounds = { minimumLongitude: Infinity, minimumLatitude: Infinity, maximumLongitude: -Infinity, maximumLatitude: -Infinity };
  function visit(value) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      bounds.minimumLongitude = Math.min(bounds.minimumLongitude, value[0]);
      bounds.maximumLongitude = Math.max(bounds.maximumLongitude, value[0]);
      bounds.minimumLatitude = Math.min(bounds.minimumLatitude, value[1]);
      bounds.maximumLatitude = Math.max(bounds.maximumLatitude, value[1]);
      return;
    }
    for (const child of value) visit(child);
  }
  visit(geometry.coordinates);
  if (!Number.isFinite(bounds.minimumLongitude)) return null;
  return {
    longitude: (bounds.minimumLongitude + bounds.maximumLongitude) / 2,
    latitude: (bounds.minimumLatitude + bounds.maximumLatitude) / 2,
  };
}

function normalizeReference(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase()
    : "";
}

function parseJsonProperty(value, fallback) {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function featureReferences(feature, layerName) {
  const properties = feature?.properties ?? {};
  const tags = parseJsonProperty(properties.osm_tags_json, {});
  const candidates = layerName === "platforms"
    ? [tags.ref, tags.local_ref]
    : [tags.ref];
  return [...new Set(candidates.map(normalizeReference).filter(Boolean))].sort(compareText);
}

function gridKey(longitude, latitude) {
  return `${Math.floor(longitude / GRID_DEGREES)}:${Math.floor(latitude / GRID_DEGREES)}`;
}

function haversineMetres(left, right) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(6_371_008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function loadOperatingPoints(path) {
  const values = new Map();
  for await (const feature of jsonSequence(path)) {
    invariant(feature?.type === "Feature", `Betriebsstellen-Datei ${basename(path)} enthält einen Nicht-Feature-Eintrag.`);
    const rl100Value = feature.properties?.rl100;
    if (typeof rl100Value !== "string" || rl100Value.trim() === "") continue;
    const rl100 = normalizeRl100(rl100Value);
    invariant(!values.has(rl100), `Betriebsstellen-Datei enthält RL100 ${rl100} mehrfach.`);
    const point = pointFromGeometry(feature.geometry);
    const routeNumbers = parseJsonProperty(feature.properties?.route_numbers_json, [])
      .filter((value) => Number.isSafeInteger(value))
      .sort((left, right) => left - right);
    values.set(rl100, {
      featureId: String(feature.properties?.feature_id ?? ""),
      qualityClass: String(feature.properties?.quality_class ?? "C"),
      point,
      routeNumbers,
    });
  }
  return values;
}

async function loadSpatialLayer(path, layerName) {
  const buckets = new Map();
  let featureCount = 0;
  let geometrylessCount = 0;
  for await (const feature of jsonSequence(path)) {
    invariant(feature?.type === "Feature", `Semantiklayer ${layerName} enthält einen Nicht-Feature-Eintrag.`);
    featureCount += 1;
    const point = pointFromGeometry(feature.geometry);
    if (point === null) {
      geometrylessCount += 1;
      continue;
    }
    const item = {
      featureId: String(feature.properties?.feature_id ?? ""),
      point,
      references: featureReferences(feature, layerName),
      qualityClass: String(feature.properties?.quality_class ?? "C"),
      orderable: feature.properties?.orderable === true,
    };
    const key = gridKey(point.longitude, point.latitude);
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) bucket.sort((left, right) => compareText(left.featureId, right.featureId));
  return { layerName, buckets, featureCount, geometrylessCount };
}

function nearbyFeatures(index, point, radiusMetres) {
  const longitudeCell = Math.floor(point.longitude / GRID_DEGREES);
  const latitudeCell = Math.floor(point.latitude / GRID_DEGREES);
  // At Germany's northern edge, 0.05 longitude degrees are still more than
  // 3 km.  This intentionally over-queries before the exact distance check.
  const neighbours = Math.max(1, Math.ceil(radiusMetres / 2_500));
  const result = [];
  for (let x = longitudeCell - neighbours; x <= longitudeCell + neighbours; x += 1) {
    for (let y = latitudeCell - neighbours; y <= latitudeCell + neighbours; y += 1) {
      for (const feature of index.buckets.get(`${x}:${y}`) ?? []) {
        const distanceMetres = haversineMetres(point, feature.point);
        if (distanceMetres <= radiusMetres) result.push({ ...feature, distanceMetres });
      }
    }
  }
  return result.sort((left, right) => left.distanceMetres - right.distanceMetres || compareText(left.featureId, right.featureId));
}

function summarizeLayerContext(features, tokens) {
  const tokenValues = [...new Set(tokens.map((item) => normalizeReference(item.normalizedValue)).filter(Boolean))].sort(compareText);
  const layerReferences = [...new Set(features.flatMap((feature) => feature.references))].sort(compareText);
  const layerReferenceSet = new Set(layerReferences);
  const tokenSet = new Set(tokenValues);
  return {
    nearbyFeatureCount: features.length,
    nearbyOrderableFeatureCount: features.filter((feature) => feature.orderable).length,
    nearbyQualityCounts: Object.fromEntries([...new Set(features.map((feature) => feature.qualityClass))]
      .sort(compareText)
      .map((qualityClass) => [qualityClass, features.filter((feature) => feature.qualityClass === qualityClass).length])),
    nearbyReferencedFeatureCount: features.filter((feature) => feature.references.length > 0).length,
    exactReferenceMatches: tokenValues.filter((value) => layerReferenceSet.has(value)),
    documentTokenValuesWithoutExactReference: tokenValues.filter((value) => !layerReferenceSet.has(value)),
    nearbyReferencesWithoutExactDocumentToken: layerReferences.filter((value) => !tokenSet.has(value)),
  };
}

function discrepancies({ extraction, operatingPoint, contexts }) {
  const values = [];
  const add = (code, severity, detail) => values.push({ code, severity, detail });
  if (operatingPoint === undefined || operatingPoint.point === null) {
    add("operating-point-coordinate-unresolved", "high", "Kein eindeutiger räumlicher Betriebsstellenanker für den automatischen Umkreisvergleich.");
  }
  if (extraction.extractionState !== "vector-text-observed-review-required") {
    add("vector-text-unavailable", "high", "Der Plan liefert keine direkt auswertbare Vektortext-Evidenz; OCR ist nicht freigegeben.");
  }
  const lexical = extraction.lexicalEvidence;
  const bindings = [
    ["signals", lexical.mainSignalDesignationTokens],
    ["switches", lexical.switchDesignationTokens],
    ["platforms", lexical.platformDesignationTokens],
  ];
  for (const [layerName, tokens] of bindings) {
    if (tokens.length === 0 || contexts[layerName] === null) continue;
    const distinct = new Set(tokens.map((token) => token.normalizedValue)).size;
    if (contexts[layerName].nearbyFeatureCount === 0) {
      add(`${layerName}-context-empty`, "high", `${distinct} verschiedene lexikalische Plan-Tokens, aber kein Objekt im ${layerName}-Umkreis.`);
    } else if (contexts[layerName].documentTokenValuesWithoutExactReference.length > 0) {
      add(`${layerName}-reference-mismatch`, "medium", "Mindestens ein Plan-Token besitzt keine exakte Referenzgleichheit im räumlichen Semantiklayer.");
    }
    if (distinct > contexts[layerName].nearbyFeatureCount) {
      add(`${layerName}-token-count-exceeds-context`, "medium", "Die Zahl verschiedener Plan-Tokens übersteigt die Zahl räumlich gefundener Layerobjekte.");
    }
  }
  const routeTokens = [...new Set(lexical.routeNumberTokens.map((item) => item.routeNumber))].sort((left, right) => left - right);
  if (routeTokens.length > 0 && operatingPoint !== undefined) {
    const known = new Set(operatingPoint.routeNumbers);
    if (routeTokens.some((route) => !known.has(route))) {
      add("route-number-mismatch", "medium", "Mindestens ein explizites Strecken-Token fehlt in den amtlichen Betriebsstellenbindungen.");
    }
  }
  if (lexical.usefulPlatformLengthTokens.length > 0) {
    add("useful-length-requires-track-binding", "low", "NL/BL-Werte sind beobachtet, aber ohne eindeutige Gleis-/Bahnsteigzuordnung nicht übernehmbar.");
  }
  return values.sort((left, right) => compareText(left.code, right.code));
}

function reviewPriority(values) {
  if (values.some((value) => value.severity === "high")) return "high";
  if (values.some((value) => value.severity === "medium")) return "medium";
  return "low";
}

export function createSemanticReviewRecord({ captureEntry, extraction, operatingPoint, layerIndexes, radiusMetres }) {
  invariant(extraction?.schema === STATION_PLAN_EXTRACTOR_SCHEMA, "Unbekanntes Schema der Vektortext-Extraktion.");
  invariant(extraction.documentSha256 === captureEntry.documentSha256, "Vektortext-Extraktion gehört nicht zum gebundenen Dokumenthash.");
  invariant(extraction.safety?.qualityClassPromotionAllowed === false, "Extraktion erlaubt unerwartet eine Qualitätsklassenanhebung.");
  invariant(extraction.safety?.orderabilityPromotionAllowed === false, "Extraktion erlaubt unerwartet eine Bestellbarkeitsanhebung.");
  const point = operatingPoint?.point ?? null;
  const nearby = Object.fromEntries(LAYER_NAMES.map((layerName) => [
    layerName,
    point === null ? [] : nearbyFeatures(layerIndexes[layerName], point, radiusMetres),
  ]));
  const lexical = extraction.lexicalEvidence;
  const contexts = {
    signals: point === null ? null : summarizeLayerContext(nearby.signals, lexical.mainSignalDesignationTokens),
    switches: point === null ? null : summarizeLayerContext(nearby.switches, lexical.switchDesignationTokens),
    platforms: point === null ? null : summarizeLayerContext(nearby.platforms, lexical.platformDesignationTokens),
  };
  const discrepancyValues = discrepancies({ extraction, operatingPoint, contexts });
  const record = {
    stationKey: captureEntry.stationKey,
    targetObjectId: captureEntry.targetObjectId,
    rl100: captureEntry.rl100,
    documentBinding: {
      documentSha256: captureEntry.documentSha256,
      extractionSha256: extraction.extractionSha256,
    },
    extraction,
    semanticContext: {
      radiusMetres,
      operatingPoint: operatingPoint === undefined ? null : {
        featureId: operatingPoint.featureId,
        qualityClass: operatingPoint.qualityClass,
        coordinateResolved: operatingPoint.point !== null,
        routeNumbers: operatingPoint.routeNumbers,
      },
      layers: contexts,
    },
    discrepancies: discrepancyValues,
    disposition: {
      reviewRequired: true,
      reviewPriority: reviewPriority(discrepancyValues),
      automaticCorpusMutationAllowed: false,
      validatedDimensions: [],
      classAEligible: false,
      orderabilityPromotionAllowed: false,
      publicExportAllowed: false,
      reasons: [
        "lexical-category-is-not-object-proof",
        "edge-track-or-platform-binding-required",
        "independent-evidence-required-for-quality-promotion",
      ],
    },
  };
  return { ...record, recordSha256: sha256(record) };
}

export function createFailedSemanticReview({ captureEntry, error, evidenceRoot, pdfPath }) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const sanitizedMessage = rawMessage
    .replaceAll(resolve(pdfPath), "<document>")
    .replaceAll(resolve(evidenceRoot), "<evidence-root>")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 2_000);
  const failure = {
    stationKey: captureEntry.stationKey,
    targetObjectId: captureEntry.targetObjectId,
    rl100: captureEntry.rl100,
    documentBinding: { documentSha256: captureEntry.documentSha256 },
    status: "failed-review-required",
    failure: {
      code: "vector-text-parser-failed",
      errorType: error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name) ? error.name : "Error",
      message: sanitizedMessage === "" ? "Unbekannter Parserfehler." : sanitizedMessage,
      messageSha256: sha256(rawMessage),
    },
    disposition: {
      reviewRequired: true,
      reviewPriority: "high",
      automaticCorpusMutationAllowed: false,
      validatedDimensions: [],
      classAEligible: false,
      orderabilityPromotionAllowed: false,
      publicExportAllowed: false,
      reasons: ["vector-text-parser-failed", "manual-document-review-required"],
    },
  };
  return { ...failure, recordSha256: sha256(failure) };
}

export function createSemanticReviewIndex({
  capture,
  records,
  failures = [],
  sourceBindings,
  layerStatistics,
  radiusMetres,
  eligibleAvailableCount = records.length + failures.length,
  remainingEligibleCount = 0,
}) {
  const sortedRecords = [...records].sort((left, right) => compareText(left.rl100, right.rl100) || compareText(left.stationKey, right.stationKey));
  const sortedFailures = [...failures].sort((left, right) => compareText(left.rl100, right.rl100) || compareText(left.stationKey, right.stationKey));
  const captureStatusCounts = Object.fromEntries(["available", "unavailable", "pending"].map((status) => [
    status,
    capture.entries.filter((entry) => entry.status === status).length,
  ]));
  const review = {
    schema: STATION_PLAN_SEMANTIC_REVIEW_SCHEMA,
    reviewVersion: STATION_PLAN_SEMANTIC_REVIEW_VERSION,
    internalOnly: true,
    containsPlanDerivedTokens: true,
    publicExportAllowed: false,
    captureLedgerSha256: sha256(capture),
    sourceBindings,
    radiusMetres,
    layerStatistics,
    records: sortedRecords,
    failures: sortedFailures,
    summary: {
      captureAvailableCount: captureStatusCounts.available,
      captureUnavailableCount: captureStatusCounts.unavailable,
      capturePendingCount: captureStatusCounts.pending,
      eligibleAvailableCount,
      reviewedDocumentCount: sortedRecords.length,
      failedDocumentCount: sortedFailures.length,
      vectorTextDocumentCount: sortedRecords.filter((record) => record.extraction.extractionState === "vector-text-observed-review-required").length,
      highPriorityReviewCount: sortedRecords.filter((record) => record.disposition.reviewPriority === "high").length,
      mediumPriorityReviewCount: sortedRecords.filter((record) => record.disposition.reviewPriority === "medium").length,
      lowPriorityReviewCount: sortedRecords.filter((record) => record.disposition.reviewPriority === "low").length,
      discrepancyCount: sortedRecords.reduce((sum, record) => sum + record.discrepancies.length, 0),
      classAEligibleCount: 0,
      orderabilityPromotionCount: 0,
      automaticCorpusMutationCount: 0,
      remainingEligibleCount,
    },
    safety: {
      rawDocumentsShipped: false,
      rawTextShipped: false,
      tokenEvidenceShipped: false,
      publicSourceNameShipped: false,
      qualityClassPromotionAllowed: false,
      orderabilityPromotionAllowed: false,
    },
  };
  return { ...review, ledgerSha256: sha256(review) };
}

export function assertNoInternalStationPlanEvidence(publicArtifact) {
  const forbiddenSchemas = new Set([STATION_PLAN_EXTRACTOR_SCHEMA, STATION_PLAN_SEMANTIC_REVIEW_SCHEMA]);
  function visit(value, path = "artifact") {
    if (typeof value === "string") {
      invariant(!forbiddenSchemas.has(value), `${path} enthält ein internes Plan-Evidenzschema.`);
      invariant(!/\bapn\b|trassenfinder|station-plan-vector-text|station-plan-semantic-review|internal-evidence|\.pdf(?:$|[?#\s])/iu.test(value), `${path} enthält eine interne Plan- oder Dateikennung.`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      invariant(!/(?:stationKey|documentBinding|extractionSha256|documentSha256|containsPlanDerivedTokens|tokens$)/iu.test(key), `${path}.${key} ist interne Plan-Evidenz.`);
      visit(nested, `${path}.${key}`);
    }
  }
  visit(publicArtifact);
  return publicArtifact;
}

export function runStationPlanExtractor({ pythonExecutable, extractorPath, pdfPath, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  safeInteger(timeoutMs, "Extraktions-Timeout", 1_000, 900_000);
  return new Promise((accept, reject) => {
    const child = spawn(pythonExecutable, [extractorPath, "--input", pdfPath], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`Vektortext-Extraktion überschritt ${timeoutMs} ms.`)));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > 64 * 1024 * 1024) {
        child.kill();
        finish(() => reject(new Error("Vektortext-Extraktion überschritt 64 MiB JSON-Ausgabe.")));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1024 * 1024) stderr.push(chunk);
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => finish(() => {
      if (code !== 0) {
        reject(new Error(`Vektortext-Extraktion endete mit ${code ?? `Signal ${signal}`}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      try {
        accept(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch (error) {
        reject(new Error(`Vektortext-Extraktion lieferte kein gültiges JSON: ${error.message}`));
      }
    }));
  });
}

async function readExistingSemanticReview(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    invariant(value?.schema === STATION_PLAN_SEMANTIC_REVIEW_SCHEMA, "Bestehendes Semantik-Review besitzt ein unbekanntes Schema.");
    invariant(value.reviewVersion === STATION_PLAN_SEMANTIC_REVIEW_VERSION, "Bestehendes Semantik-Review besitzt eine unbekannte Version.");
    invariant(Array.isArray(value.records), "Bestehendes Semantik-Review enthält keine records-Liste.");
    invariant(value.failures === undefined || Array.isArray(value.failures), "Bestehendes Semantik-Review enthält keine gültige failures-Liste.");
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function reviewEntryMatchesCapture(reviewEntry, captureEntry) {
  return reviewEntry?.stationKey === captureEntry.stationKey
    && reviewEntry?.targetObjectId === captureEntry.targetObjectId
    && reviewEntry?.rl100 === captureEntry.rl100
    && reviewEntry?.documentBinding?.documentSha256 === captureEntry.documentSha256;
}

export async function auditCapturedStationPlans({
  evidenceRoot,
  repositoryRoot,
  operatingPointsPath,
  semanticLayerPaths,
  pythonExecutable,
  extractorPath = resolve(MODULE_DIRECTORY, "apn_semantic_extract.py"),
  radiusMetres = DEFAULT_RADIUS_METRES,
  maximumRecords = Number.MAX_SAFE_INTEGER,
  batchSize = Number.MAX_SAFE_INTEGER,
  rl100Filter = [],
  retryFailed = false,
  extractionTimeoutMs = DEFAULT_TIMEOUT_MS,
  extractPdf,
} = {}) {
  const root = await prepareExternalEvidenceRoot({ evidenceRoot, repositoryRoot });
  safeInteger(radiusMetres, "Vergleichsradius", 100, 10_000);
  safeInteger(maximumRecords, "maximumRecords", 1, Number.MAX_SAFE_INTEGER);
  safeInteger(batchSize, "batchSize", 1, Number.MAX_SAFE_INTEGER);
  invariant(typeof retryFailed === "boolean", "retryFailed muss boolesch sein.");
  invariant(typeof operatingPointsPath === "string" && operatingPointsPath !== "", "Pfad der Betriebsstellen fehlt.");
  invariant(semanticLayerPaths !== null && typeof semanticLayerPaths === "object", "Semantiklayer-Pfade fehlen.");
  for (const layerName of LAYER_NAMES) invariant(typeof semanticLayerPaths[layerName] === "string" && semanticLayerPaths[layerName] !== "", `Semantiklayer ${layerName} fehlt.`);
  const resolvedRepository = resolve(repositoryRoot);
  const resolvedExtractor = resolve(extractorPath);
  invariant(pathWithin(resolvedRepository, resolvedExtractor), "Extraktor muss aus dem Repository stammen.");
  const extractor = extractPdf ?? ((pdfPath) => {
    invariant(typeof pythonExecutable === "string" && pythonExecutable !== "", "Python-Pfad fehlt.");
    return runStationPlanExtractor({ pythonExecutable, extractorPath: resolvedExtractor, pdfPath, timeoutMs: extractionTimeoutMs });
  });

  const capturePath = resolve(root, CAPTURE_INDEX_FILE);
  const outputPath = resolve(root, REVIEW_INDEX_FILE);
  const capture = JSON.parse(await readFile(capturePath, "utf8"));
  invariant(capture?.schema === APN_CAPTURE_SCHEMA && Array.isArray(capture.entries), "Unbekannter interner Capture-Index.");
  const normalizedFilter = new Set(rl100Filter.map(normalizeRl100));
  const entries = capture.entries
    .filter((entry) => entry.status === "available")
    .filter((entry) => normalizedFilter.size === 0 || normalizedFilter.has(entry.rl100))
    .sort((left, right) => compareText(left.rl100, right.rl100) || compareText(left.stationKey, right.stationKey))
    .slice(0, maximumRecords);

  const resolvedOperatingPoints = resolve(operatingPointsPath);
  const resolvedLayerPaths = Object.fromEntries(LAYER_NAMES.map((name) => [name, resolve(semanticLayerPaths[name])]));
  const [operatingPoints, ...layerIndexesList] = await Promise.all([
    loadOperatingPoints(resolvedOperatingPoints),
    ...LAYER_NAMES.map((name) => loadSpatialLayer(resolvedLayerPaths[name], name)),
  ]);
  const layerIndexes = Object.fromEntries(layerIndexesList.map((index) => [index.layerName, index]));
  const sourceHashes = await Promise.all([
    sha256File(resolvedOperatingPoints),
    ...LAYER_NAMES.map((name) => sha256File(resolvedLayerPaths[name])),
  ]);
  const sourceBindings = {
    operatingPointsSha256: sourceHashes[0],
    semanticLayerSha256: Object.fromEntries(LAYER_NAMES.map((name, index) => [name, sourceHashes[index + 1]])),
  };
  const layerStatistics = Object.fromEntries(LAYER_NAMES.map((name) => [name, {
    sourceFeatureCount: layerIndexes[name].featureCount,
    geometrylessFeatureCount: layerIndexes[name].geometrylessCount,
  }]));

  const currentAvailableByStationKey = new Map(capture.entries
    .filter((entry) => entry.status === "available")
    .map((entry) => [entry.stationKey, entry]));
  const existing = await readExistingSemanticReview(outputPath);
  const compatibleExisting = existing !== null
    && existing.radiusMetres === radiusMetres
    && sha256(existing.sourceBindings) === sha256(sourceBindings);
  const recordsByStationKey = new Map();
  const failuresByStationKey = new Map();
  if (compatibleExisting) {
    for (const record of existing.records) {
      const entry = currentAvailableByStationKey.get(record.stationKey);
      if (entry !== undefined && reviewEntryMatchesCapture(record, entry)) recordsByStationKey.set(record.stationKey, record);
    }
    for (const failure of existing.failures ?? []) {
      const entry = currentAvailableByStationKey.get(failure.stationKey);
      if (entry !== undefined && reviewEntryMatchesCapture(failure, entry)) failuresByStationKey.set(failure.stationKey, failure);
    }
  }

  const statistics = {
    processedThisRun: 0,
    failedThisRun: 0,
    reusedThisRun: 0,
    skippedFailedThisRun: 0,
  };
  const attemptedThisRun = new Set();
  const completedEligibleCount = () => entries.filter((entry) => recordsByStationKey.has(entry.stationKey)
    || (failuresByStationKey.has(entry.stationKey) && (!retryFailed || attemptedThisRun.has(entry.stationKey)))).length;
  const persist = async () => {
    const index = createSemanticReviewIndex({
      capture,
      records: recordsByStationKey.values(),
      failures: failuresByStationKey.values(),
      sourceBindings,
      layerStatistics,
      radiusMetres,
      eligibleAvailableCount: entries.length,
      remainingEligibleCount: entries.length - completedEligibleCount(),
    });
    await atomicWriteJson(outputPath, index);
    return index;
  };

  for (const entry of entries) {
    if (recordsByStationKey.has(entry.stationKey)) {
      statistics.reusedThisRun += 1;
      continue;
    }
    if (failuresByStationKey.has(entry.stationKey) && !retryFailed) {
      statistics.skippedFailedThisRun += 1;
      continue;
    }
    if (statistics.processedThisRun >= batchSize) continue;
    invariant(typeof entry.storedRelativePath === "string" && !isAbsolute(entry.storedRelativePath), `Capture ${entry.stationKey} ohne sicheren relativen Speicherpfad.`);
    invariant(SHA256.test(entry.documentSha256 ?? ""), `Capture ${entry.stationKey} ohne Dokumenthash.`);
    const pdfPath = resolve(root, entry.storedRelativePath);
    invariant(pathWithin(root, pdfPath), `Capture ${entry.stationKey} verlässt die Evidenzwurzel.`);
    const info = await stat(pdfPath);
    invariant(info.isFile() && info.size === entry.bytes, `Capture ${entry.stationKey} stimmt nicht mit der gebundenen Bytezahl überein.`);
    invariant(await sha256File(pdfPath) === entry.documentSha256, `Capture ${entry.stationKey} ist nicht mehr byteidentisch.`);
    attemptedThisRun.add(entry.stationKey);
    statistics.processedThisRun += 1;
    try {
      const extraction = await extractor(pdfPath, entry);
      recordsByStationKey.set(entry.stationKey, createSemanticReviewRecord({
        captureEntry: entry,
        extraction,
        operatingPoint: operatingPoints.get(entry.rl100),
        layerIndexes,
        radiusMetres,
      }));
      failuresByStationKey.delete(entry.stationKey);
    } catch (error) {
      statistics.failedThisRun += 1;
      recordsByStationKey.delete(entry.stationKey);
      failuresByStationKey.set(entry.stationKey, createFailedSemanticReview({
        captureEntry: entry,
        error,
        evidenceRoot: root,
        pdfPath,
      }));
    }
  }

  const index = await persist();
  return { outputPath, index, summary: index.summary, runStatistics: statistics };
}
