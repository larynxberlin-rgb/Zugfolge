import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { APN_CAPTURE_SCHEMA, sha256 } from "./apn-evidence.mjs";
import {
  STATION_PLAN_EXTRACTOR_SCHEMA,
  assertNoInternalStationPlanEvidence,
  auditCapturedStationPlans,
  createSemanticReviewRecord,
} from "./apn-semantic-audit.mjs";

const REPOSITORY_ROOT = resolve(".");

function sequence(features) {
  return features.map((feature) => `\x1e${JSON.stringify(feature)}\n`).join("");
}

function feature(id, type, coordinates, properties = {}) {
  return {
    type: "Feature",
    properties: {
      feature_id: id,
      feature_type: type,
      quality_class: "B",
      orderable: false,
      ...properties,
    },
    geometry: { type: "Point", coordinates },
  };
}

function token(value, rule = "test-observed-token") {
  return {
    value,
    normalizedValue: value.toUpperCase(),
    page: 1,
    bboxMillipoints: { x0: 1, top: 2, x1: 3, bottom: 4 },
    fontSizeMillipoints: 8_000,
    rule,
    evidenceKind: "observed-vector-text",
    semanticAssertion: false,
  };
}

function extraction(documentSha256) {
  const lexicalEvidence = {
    trackDesignationTokens: [token("7")],
    switchDesignationTokens: [token("123")],
    mainSignalDesignationTokens: [token("95A"), token("96Q8")],
    routeNumberTokens: [{ ...token("6340"), routeNumber: 6340 }],
    kilometreHintTokens: [{ ...token("123,456"), millimetresFromRouteOrigin: 123_456_000 }],
    platformDesignationTokens: [token("2")],
    usefulPlatformLengthTokens: [{ ...token("250/220"), usefulLengthMetres: 250, platformLengthMetres: 220 }],
    metrics: {
      tokenOccurrences: {},
      distinctTokenValues: {},
      unclassifiedNumericOccurrences: 0,
      unclassifiedNumericDistinctValues: 0,
    },
  };
  return {
    schema: STATION_PLAN_EXTRACTOR_SCHEMA,
    extractorVersion: "station-plan-vector-text/test",
    documentSha256,
    extractionSha256: sha256(lexicalEvidence),
    extractionState: "vector-text-observed-review-required",
    documentMetrics: { pageCount: 1, characterCount: 100, wordCount: 20, vectorPrimitiveCount: 5, imageCount: 0 },
    pageMetrics: [],
    lexicalEvidence,
    safety: {
      manualReviewRequired: true,
      semanticObjectAssertion: false,
      topologyMutationAllowed: false,
      qualityClassPromotionAllowed: false,
      orderabilityPromotionAllowed: false,
      publicExportAllowed: false,
      ocrUsed: false,
    },
  };
}

test("erzeugt einen deterministischen, ausschließlich internen Abweichungsbericht", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-station-plan-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pdfRoot = join(root, "pdf");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(pdfRoot));
  const pdf = Buffer.from("%PDF-1.4\ninternal fixture\n%%EOF\n", "utf8");
  const documentSha256 = sha256(pdf);
  await writeFile(join(pdfRoot, "station.pdf"), pdf);
  const capture = {
    schema: APN_CAPTURE_SCHEMA,
    captureVersion: "apn-capture/1",
    entries: [{
      stationKey: "a".repeat(24),
      targetObjectId: "db-infrago:rl100:TEST",
      rl100: "TEST",
      sourceUrl: "https://internal.invalid/station/TEST",
      status: "available",
      bytes: pdf.length,
      documentSha256,
      storedRelativePath: "pdf/station.pdf",
    }],
  };
  await writeFile(join(root, "capture-index.json"), `${JSON.stringify(capture)}\n`);

  const operatingPointsPath = join(root, "operating-points.geojsonseq");
  const signalsPath = join(root, "signals.geojsonseq");
  const switchesPath = join(root, "switches.geojsonseq");
  const platformsPath = join(root, "platforms.geojsonseq");
  await writeFile(operatingPointsPath, sequence([
    feature("operating-point:rl100:TEST", "operating-point", [11, 51], {
      rl100: "TEST",
      route_numbers_json: "[6340]",
    }),
  ]));
  await writeFile(signalsPath, sequence([
    feature("signal:one", "signal", [11.001, 51.001], { osm_tags_json: "{\"ref\":\"95A\"}" }),
  ]));
  await writeFile(switchesPath, sequence([
    feature("switch:one", "switch", [11.001, 51], { osm_tags_json: "{\"ref\":\"123\"}" }),
  ]));
  await writeFile(platformsPath, sequence([
    feature("platform:one", "platform", [11, 51.001], { osm_tags_json: "{\"local_ref\":\"2\"}" }),
  ]));

  const result = await auditCapturedStationPlans({
    evidenceRoot: root,
    repositoryRoot: REPOSITORY_ROOT,
    operatingPointsPath,
    semanticLayerPaths: { signals: signalsPath, switches: switchesPath, platforms: platformsPath },
    maximumRecords: 1,
    rl100Filter: ["test"],
    extractPdf: async () => extraction(documentSha256),
  });
  assert.deepEqual(result.summary, {
    captureAvailableCount: 1,
    captureUnavailableCount: 0,
    capturePendingCount: 0,
    eligibleAvailableCount: 1,
    reviewedDocumentCount: 1,
    failedDocumentCount: 0,
    vectorTextDocumentCount: 1,
    highPriorityReviewCount: 0,
    mediumPriorityReviewCount: 1,
    lowPriorityReviewCount: 0,
    discrepancyCount: 3,
    classAEligibleCount: 0,
    orderabilityPromotionCount: 0,
    automaticCorpusMutationCount: 0,
    remainingEligibleCount: 0,
  });
  assert.deepEqual(result.runStatistics, {
    processedThisRun: 1,
    failedThisRun: 0,
    reusedThisRun: 0,
    skippedFailedThisRun: 0,
  });
  const record = result.index.records[0];
  assert.deepEqual(record.semanticContext.layers.signals.exactReferenceMatches, ["95A"]);
  assert.deepEqual(record.semanticContext.layers.switches.exactReferenceMatches, ["123"]);
  assert.deepEqual(record.semanticContext.layers.platforms.exactReferenceMatches, ["2"]);
  assert.deepEqual(record.disposition.validatedDimensions, []);
  assert.equal(record.disposition.classAEligible, false);
  assert.equal(record.disposition.orderabilityPromotionAllowed, false);
  assert.equal(record.disposition.automaticCorpusMutationAllowed, false);
  assert.match(record.recordSha256, /^[a-f0-9]{64}$/u);
  const persisted = JSON.parse(await readFile(result.outputPath, "utf8"));
  assert.deepEqual(persisted, result.index);
  const repeated = await auditCapturedStationPlans({
    evidenceRoot: root,
    repositoryRoot: REPOSITORY_ROOT,
    operatingPointsPath,
    semanticLayerPaths: { signals: signalsPath, switches: switchesPath, platforms: platformsPath },
    maximumRecords: 1,
    rl100Filter: ["test"],
    extractPdf: async () => extraction(documentSha256),
  });
  assert.deepEqual(repeated.index, result.index);
  assert.deepEqual(repeated.runStatistics, {
    processedThisRun: 0,
    failedThisRun: 0,
    reusedThisRun: 1,
    skippedFailedThisRun: 0,
  });
  assert.equal(JSON.stringify(result.index).toLowerCase().includes("apn"), false);
  assert.equal(JSON.stringify(result.index).includes("sourceUrl"), false);
  assert.throws(() => assertNoInternalStationPlanEvidence(result.index), /interne.*Plan-Evidenz/);
  assert.throws(() => assertNoInternalStationPlanEvidence({ source: "APN" }), /interne Plan-/);
  assert.throws(() => assertNoInternalStationPlanEvidence({ rawTokens: ["95A"] }), /interne Plan-Evidenz/);
  assert.deepEqual(assertNoInternalStationPlanEvidence({
    schema: "zugfolge-validation-marker/v1",
    targetObjectId: "station:test",
    classAEligible: false,
    validatedDimensions: [],
  }), {
    schema: "zugfolge-validation-marker/v1",
    targetObjectId: "station:test",
    classAEligible: false,
    validatedDimensions: [],
  });
});

test("verweigert jede Extraktion, die Qualität oder Bestellbarkeit anheben dürfte", () => {
  const documentSha256 = "a".repeat(64);
  const unsafe = extraction(documentSha256);
  unsafe.safety.qualityClassPromotionAllowed = true;
  assert.throws(() => createSemanticReviewRecord({
    captureEntry: { stationKey: "b".repeat(24), targetObjectId: "station:test", rl100: "TEST", documentSha256 },
    extraction: unsafe,
    operatingPoint: undefined,
    layerIndexes: {},
    radiusMetres: 1_500,
  }), /Qualitätsklassenanhebung/);
});

test("setzt batchweise fort, überspringt unavailable und isoliert Parserfehler je RL100", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-station-plan-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "pdf"));
  const firstPdf = Buffer.from("%PDF-1.4\nfirst\n%%EOF\n");
  const secondPdf = Buffer.from("%PDF-1.4\nsecond\n%%EOF\n");
  await writeFile(join(root, "pdf", "first.pdf"), firstPdf);
  await writeFile(join(root, "pdf", "second.pdf"), secondPdf);
  const capture = {
    schema: APN_CAPTURE_SCHEMA,
    captureVersion: "apn-capture/1",
    entries: [
      {
        stationKey: "1".repeat(24), targetObjectId: "db-infrago:rl100:AONE", rl100: "AONE",
        status: "available", bytes: firstPdf.length, documentSha256: sha256(firstPdf), storedRelativePath: "pdf/first.pdf",
      },
      {
        stationKey: "2".repeat(24), targetObjectId: "db-infrago:rl100:BTWO", rl100: "BTWO",
        status: "available", bytes: secondPdf.length, documentSha256: sha256(secondPdf), storedRelativePath: "pdf/second.pdf",
      },
      {
        stationKey: "3".repeat(24), targetObjectId: "db-infrago:rl100:CNONE", rl100: "CNONE",
        status: "unavailable", reason: "not-found",
      },
    ],
  };
  await writeFile(join(root, "capture-index.json"), `${JSON.stringify(capture)}\n`);
  const operatingPointsPath = join(root, "operating-points.geojsonseq");
  const signalsPath = join(root, "signals.geojsonseq");
  const switchesPath = join(root, "switches.geojsonseq");
  const platformsPath = join(root, "platforms.geojsonseq");
  await writeFile(operatingPointsPath, sequence([
    feature("operating-point:rl100:AONE", "operating-point", [11, 51], { rl100: "AONE", route_numbers_json: "[]" }),
    feature("operating-point:rl100:BTWO", "operating-point", [12, 52], { rl100: "BTWO", route_numbers_json: "[]" }),
  ]));
  await Promise.all([signalsPath, switchesPath, platformsPath].map((path) => writeFile(path, "")));
  const baseOptions = {
    evidenceRoot: root,
    repositoryRoot: REPOSITORY_ROOT,
    operatingPointsPath,
    semanticLayerPaths: { signals: signalsPath, switches: switchesPath, platforms: platformsPath },
    batchSize: 1,
  };

  const first = await auditCapturedStationPlans({
    ...baseOptions,
    extractPdf: async (pdfPath, entry) => extraction(entry.documentSha256),
  });
  assert.equal(first.summary.captureUnavailableCount, 1);
  assert.equal(first.summary.reviewedDocumentCount, 1);
  assert.equal(first.summary.failedDocumentCount, 0);
  assert.equal(first.summary.remainingEligibleCount, 1);
  assert.deepEqual(first.runStatistics, {
    processedThisRun: 1, failedThisRun: 0, reusedThisRun: 0, skippedFailedThisRun: 0,
  });

  const second = await auditCapturedStationPlans({
    ...baseOptions,
    extractPdf: async (pdfPath, entry) => {
      if (entry.rl100 === "BTWO") throw new Error(`broken parser at ${pdfPath}`);
      return extraction(entry.documentSha256);
    },
  });
  assert.equal(second.summary.reviewedDocumentCount, 1);
  assert.equal(second.summary.failedDocumentCount, 1);
  assert.equal(second.summary.remainingEligibleCount, 0);
  assert.deepEqual(second.runStatistics, {
    processedThisRun: 1, failedThisRun: 1, reusedThisRun: 1, skippedFailedThisRun: 0,
  });
  const failure = second.index.failures[0];
  assert.equal(failure.rl100, "BTWO");
  assert.equal(failure.status, "failed-review-required");
  assert.equal(failure.disposition.classAEligible, false);
  assert.equal(failure.disposition.orderabilityPromotionAllowed, false);
  assert.match(failure.failure.message, /<document>/u);
  assert.equal(failure.failure.message.includes(root), false);

  const skipped = await auditCapturedStationPlans({
    ...baseOptions,
    extractPdf: async () => { throw new Error("must not run"); },
  });
  assert.deepEqual(skipped.runStatistics, {
    processedThisRun: 0, failedThisRun: 0, reusedThisRun: 1, skippedFailedThisRun: 1,
  });
  assert.deepEqual(skipped.index, second.index);

  const retried = await auditCapturedStationPlans({
    ...baseOptions,
    retryFailed: true,
    extractPdf: async (pdfPath, entry) => extraction(entry.documentSha256),
  });
  assert.equal(retried.summary.reviewedDocumentCount, 2);
  assert.equal(retried.summary.failedDocumentCount, 0);
  assert.equal(retried.summary.remainingEligibleCount, 0);
  assert.deepEqual(retried.runStatistics, {
    processedThisRun: 1, failedThisRun: 0, reusedThisRun: 1, skippedFailedThisRun: 0,
  });
});
