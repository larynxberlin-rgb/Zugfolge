import { createHash } from "node:crypto";

export const QUALITY_DIMENSIONS = Object.freeze([
  "geometry",
  "topology",
  "speed",
  "electrification",
  "gradient",
  "trainProtection",
  "signalling",
  "conflictModel",
]);

const EVIDENCE_STATES = new Set(["validated", "observed", "derived", "assumed", "missing"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function speedNumber(value) {
  const normalized = text(value);
  if (normalized === null || !/^\d{1,3}(?:\s*km\/h)?$/iu.test(normalized)) return null;
  const number = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(number) && number > 0 && number <= 400 ? number : null;
}

function absolutePermille(value) {
  const normalized = text(value);
  if (normalized === null) return null;
  const match = /^([+-]?\d+(?:[.,]\d+)?)\s*(%|‰)?$/u.exec(normalized);
  if (match === null) return null;
  const numeric = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(numeric)) return null;
  const permille = match[2] === "%" ? numeric * 10 : numeric;
  const rounded = Math.round(Math.abs(permille));
  return Number.isSafeInteger(rounded) && rounded <= 100 ? rounded : null;
}

function truthyTag(value) {
  return ["yes", "present", "installed", "pzb", "lzb", "etcs"].includes(text(value)?.toLowerCase());
}

function normalizedElectrification(raw) {
  const value = text(raw)?.toLowerCase();
  if (value === undefined || value === null) return null;
  if (["contact_line", "yes", "overhead"].includes(value)) return "overhead";
  if (["no", "none"].includes(value)) return "none";
  return null;
}

function safeSpeed(tags, policy) {
  const service = text(tags.service)?.toLowerCase();
  if (["yard", "siding", "spur", "crossover"].includes(service)) return policy.unknownServiceSpeedKmh;
  return policy.unknownMainlineSpeedKmh;
}

function baseDimensions(block, tags, policy) {
  const directionalSpeeds = [speedNumber(tags["maxspeed:forward"]), speedNumber(tags["maxspeed:backward"])]
    .filter((value) => value !== null);
  const commonSpeed = speedNumber(tags.maxspeed);
  const taggedSpeed = commonSpeed ?? (directionalSpeeds.length > 0 ? Math.min(...directionalSpeeds) : null);
  const electrification = normalizedElectrification(tags.electrified);
  const incline = absolutePermille(tags.incline);
  const protection = [
    truthyTag(tags["railway:pzb"]) ? "pzb" : null,
    truthyTag(tags["railway:lzb"]) ? "lzb" : null,
    truthyTag(tags["railway:etcs"]) ? "etcs" : null,
  ].filter(Boolean);
  const boundarySignalCount = Number.isSafeInteger(block.boundarySignalCount) && block.boundarySignalCount >= 0
    ? block.boundarySignalCount
    : 0;
  return {
    geometry: block.lengthMm > 0
      ? { state: "observed", value: { lengthMm: block.lengthMm }, ruleId: null }
      : { state: "missing", value: null, ruleId: null },
    topology: block.fromNodeId !== block.toNodeId
      ? { state: "derived", value: { fromNodeId: block.fromNodeId, toNodeId: block.toNodeId }, ruleId: "osm-node-topology/v1" }
      : { state: "missing", value: null, ruleId: null },
    speed: taggedSpeed !== null
      ? { state: "observed", value: {
        maximumKmh: taggedSpeed,
        ...(commonSpeed === null && directionalSpeeds.length > 0 ? { directionallyConservative: true } : {}),
      }, ruleId: null }
      : { state: "assumed", value: { maximumKmh: safeSpeed(tags, policy) }, ruleId: "unknown-speed-restrictive/v1" },
    electrification: electrification !== null
      ? { state: "observed", value: { system: electrification }, ruleId: null }
      : { state: "assumed", value: { system: "none" }, ruleId: "unknown-electrification-none/v1" },
    gradient: incline !== null
      ? { state: "observed", value: { absolutePermille: incline }, ruleId: null }
      : { state: "assumed", value: { minimumPermille: -policy.unknownGradientAbsPermille, maximumPermille: policy.unknownGradientAbsPermille }, ruleId: "unknown-gradient-envelope/v1" },
    trainProtection: protection.length > 0
      ? { state: "observed", value: { systems: protection.sort() }, ruleId: null }
      : { state: "assumed", value: { system: "restricted-unknown" }, ruleId: "unknown-protection-restricted/v1" },
    signalling: boundarySignalCount >= 2
      ? { state: "observed", value: { boundarySignalCount }, ruleId: null }
      : { state: "derived", value: { model: "virtual-fixed-block", boundarySignalCount }, ruleId: "virtual-fixed-block/v1" },
    conflictModel: {
      state: "derived",
      value: { model: "edge-exclusive-plus-switch-node-lock" },
      ruleId: "conservative-conflict-resource/v1",
    },
  };
}

function validationKey(receipt) {
  if (Number.isSafeInteger(receipt.edgeId)) return `edge:${receipt.edgeId}`;
  if (Number.isSafeInteger(receipt.sourceWayId)) return `way:${receipt.sourceWayId}`;
  throw new Error(`Validierungsbeleg ${receipt.receiptId ?? "ohne Kennung"} besitzt weder edgeId noch sourceWayId.`);
}

function validationIndex(receipts) {
  const index = new Map();
  for (const receipt of receipts) {
    invariant(typeof receipt.receiptId === "string" && receipt.receiptId !== "", "Validierungsbeleg ohne receiptId.");
    invariant(receipt.status === "accepted", `Validierungsbeleg ${receipt.receiptId} ist nicht accepted.`);
    invariant(Array.isArray(receipt.validatedDimensions), `Validierungsbeleg ${receipt.receiptId} ohne validatedDimensions.`);
    for (const dimension of receipt.validatedDimensions) invariant(QUALITY_DIMENSIONS.includes(dimension), `Unbekannte Qualitätsdimension ${dimension}.`);
    const key = validationKey(receipt);
    const values = index.get(key) ?? [];
    values.push(receipt);
    index.set(key, values);
  }
  for (const values of index.values()) values.sort((left, right) => left.receiptId.localeCompare(right.receiptId));
  return index;
}

function applyValidation(dimensions, receipts) {
  const receiptIds = [];
  for (const receipt of receipts) {
    receiptIds.push(receipt.receiptId);
    for (const dimension of receipt.validatedDimensions) {
      const override = receipt.overrides?.[dimension];
      invariant(dimensions[dimension].state !== "missing" || override !== undefined, `Validierungsbeleg ${receipt.receiptId} muss die ungelöste Dimension ${dimension} mit einem Wert schließen.`);
      const state = receipt.classAEligible === true ? "validated"
        : dimensions[dimension].state === "validated" ? "validated" : "observed";
      dimensions[dimension] = {
        ...dimensions[dimension],
        ...(override === undefined ? {} : { value: override }),
        state,
        ruleId: null,
      };
    }
  }
  return [...new Set(receiptIds)].sort();
}

function qualityClass(dimensions) {
  const states = QUALITY_DIMENSIONS.map((dimension) => dimensions[dimension]?.state ?? "missing");
  if (states.every((state) => state === "validated")) return "A";
  if (states.every((state) => state !== "missing" && state !== "assumed")) return "B";
  return "C";
}

function sourceWayId(feature) {
  const candidates = [feature?.properties?.osm_way_id, feature?.properties?.id, feature?.id];
  for (const candidate of candidates) {
    if (Number.isSafeInteger(candidate)) return candidate;
    const match = String(candidate ?? "").match(/(?:way\/)?(\d+)$/);
    if (match !== null) return Number.parseInt(match[1], 10);
  }
  return null;
}

export function indexWayTags(features) {
  const result = new Map();
  for (const feature of features) {
    const wayId = sourceWayId(feature);
    if (wayId === null) continue;
    const properties = feature?.properties;
    if (properties === null || typeof properties !== "object") continue;
    result.set(wayId, properties);
  }
  return result;
}

function initializeDimensionTotals() {
  return Object.fromEntries(QUALITY_DIMENSIONS.map((dimension) => [dimension, {
    validatedLengthMm: 0,
    observedLengthMm: 0,
    derivedLengthMm: 0,
    assumedLengthMm: 0,
    missingLengthMm: 0,
  }]));
}

function increment(map, key, lengthMm) {
  const current = map.get(key) ?? { cause: key, sectionCount: 0, lengthMm: 0 };
  current.sectionCount += 1;
  current.lengthMm += lengthMm;
  map.set(key, current);
}

export function buildGermanyInfraCorpus({ pbfReport, wayFeatures, validationReceipts = [], policy }) {
  invariant(pbfReport?.schema === "zugfolge-pbf-release-report/v1", "PBF-Bericht besitzt ein unbekanntes Schema.");
  invariant(Array.isArray(pbfReport.derivations?.blocks), "PBF-Bericht enthält keine Blockableitung.");
  invariant(Number.isSafeInteger(policy?.unknownMainlineSpeedKmh) && policy.unknownMainlineSpeedKmh > 0, "Konservative Hauptgleisgeschwindigkeit fehlt.");
  invariant(Number.isSafeInteger(policy?.unknownServiceSpeedKmh) && policy.unknownServiceSpeedKmh > 0, "Konservative Nebengleisgeschwindigkeit fehlt.");
  invariant(Number.isSafeInteger(policy?.unknownGradientAbsPermille) && policy.unknownGradientAbsPermille > 0, "Konservativer Neigungskorridor fehlt.");

  const tagsByWay = indexWayTags(wayFeatures);
  const validations = validationIndex(validationReceipts);
  const evidenceBindings = [];
  const sections = [];
  for (const block of pbfReport.derivations.blocks) {
    invariant(Number.isSafeInteger(block.edgeId), "Block ohne ganzzahlige edgeId.");
    invariant(Number.isSafeInteger(block.sourceWayId), `Block ${block.edgeId} ohne sourceWayId.`);
    invariant(Number.isSafeInteger(block.lengthMm) && block.lengthMm >= 0, `Block ${block.edgeId} mit ungültiger Länge.`);
    const tags = tagsByWay.get(block.sourceWayId) ?? {};
    const dimensions = baseDimensions(block, tags, policy);
    const receipts = [
      ...(validations.get(`way:${block.sourceWayId}`) ?? []),
      ...(validations.get(`edge:${block.edgeId}`) ?? []),
    ].sort((left, right) => left.receiptId.localeCompare(right.receiptId));
    const receiptIds = applyValidation(dimensions, receipts);
    for (const dimension of QUALITY_DIMENSIONS) invariant(EVIDENCE_STATES.has(dimensions[dimension].state), `Ungültiger Evidenzzustand für ${dimension}.`);
    const grade = qualityClass(dimensions);
    const provenanceReceiptHash = sha256({ edgeId: block.edgeId, sourceWayId: block.sourceWayId, receiptIds, dimensions });
    sections.push({
      sectionId: `de-edge-${block.edgeId}`,
      sourceWayId: block.sourceWayId,
      fromNodeId: block.fromNodeId,
      toNodeId: block.toNodeId,
      lengthMm: block.lengthMm,
      qualityClass: grade,
      visible: true,
      modelled: grade !== "C",
      playable: grade !== "C",
      dimensions,
      provenanceReceiptHash,
    });
    evidenceBindings.push({ sectionId: `de-edge-${block.edgeId}`, provenanceReceiptHash, receiptIds });
  }
  sections.sort((left, right) => left.sectionId.localeCompare(right.sectionId, "en"));
  evidenceBindings.sort((left, right) => left.sectionId.localeCompare(right.sectionId, "en"));

  const byClassLengthMm = { A: 0, B: 0, C: 0 };
  const byClassSectionCount = { A: 0, B: 0, C: 0 };
  const byDimension = initializeDimensionTotals();
  const causes = new Map();
  for (const section of sections) {
    byClassLengthMm[section.qualityClass] += section.lengthMm;
    byClassSectionCount[section.qualityClass] += 1;
    for (const dimension of QUALITY_DIMENSIONS) {
      const state = section.dimensions[dimension].state;
      byDimension[dimension][`${state}LengthMm`] += section.lengthMm;
      if (state !== "validated") increment(causes, `${dimension}:${state}`, section.lengthMm);
    }
  }
  const qualityReport = {
    schema: "zugfolge-infrastructure-quality-report/v2",
    scopeId: "deutschland-ebo",
    dimensions: QUALITY_DIMENSIONS,
    policy: {
      A: "Alle betriebsrelevanten Dimensionen fachlich validiert.",
      B: "Betriebsmodell vollständig und konservativ; jede nicht beobachtete Dimension ist durch eine versionierte Ableitung geschlossen.",
      C: "Mindestens eine betriebsrelevante Dimension fehlt oder ist nur gewöhnlich angenommen; nur Kartenkontext.",
    },
    totalLengthMm: sections.reduce((sum, section) => sum + section.lengthMm, 0),
    byClassLengthMm,
    byClassSectionCount,
    byDimension,
    degradationCauses: [...causes.values()].sort((left, right) => left.cause.localeCompare(right.cause, "en")),
  };
  const corpus = {
    schema: "zugfolge-infracorpus/v2",
    corpusId: "deutschland-ebo",
    coverage: "complete-germany-input",
    visibleScope: "deutschland-ebo",
    modelledScope: "all-quality-a-or-b-sections",
    playableScope: "world-release-mask-intersection",
    qualityReportHash: sha256(qualityReport),
    sections,
  };
  return {
    corpus,
    corpusHash: sha256(corpus),
    qualityReport,
    qualityReportHash: sha256(qualityReport),
    internalEvidenceBindings: {
      schema: "zugfolge-internal-evidence-bindings/v1",
      corpusId: corpus.corpusId,
      bindings: evidenceBindings,
    },
  };
}
