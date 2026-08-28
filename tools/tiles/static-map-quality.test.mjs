import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  STATIC_MAP_QUALITY_LAYER_ORDER,
  STATIC_MAP_QUALITY_MATERIALIZATION_SCHEMA,
  buildStaticMapQuality,
  materializeStaticMapQuality,
  serializeStaticMapQuality,
  validateStaticMapQuality,
} from "./static-map-quality.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./static-map-quality-cli.mjs", import.meta.url));
const FEATURE_TYPES = Object.freeze({
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
const DIMENSIONS = Object.freeze(["topology", "maximumSpeed", "gradient", "electrification", "trackCount", "signals", "blocks", "conflictResources"]);

function fixture() {
  const spec = {
    schema: STATIC_MAP_QUALITY_MATERIALIZATION_SCHEMA,
    releaseId: "karte-deutschland-2026.3-v2-test",
    infrastructureCorpusId: "infra-deutschland-2026.3-test",
    timetableYear: 2026,
    scopeId: "deutschland-ebo-visible-corpus",
    visibleLayerOrder: [...STATIC_MAP_QUALITY_LAYER_ORDER],
  };
  const layers = STATIC_MAP_QUALITY_LAYER_ORDER.map((name, index) => {
    const features = index + 1;
    const classCount = name === "platforms" ? { A: 0, B: 0, C: features } : { A: 0, B: features, C: 0 };
    const layer = {
      name,
      featureType: FEATURE_TYPES[name],
      bytes: 1000 + index,
      features,
      declaredQualityClassFeatureCount: { ...classCount },
      qualityClassFeatureCount: { ...classCount },
    };
    if (name === "tracks") {
      Object.assign(layer, {
        totalLengthMm: 123456,
        declaredQualityClassLengthMm: { A: 0, B: 123456, C: 0 },
        qualityClassLengthMm: { A: 0, B: 123456, C: 0 },
        qualityClassificationCorrections: {},
      });
    }
    return layer;
  });
  const visibleFeatures = layers.reduce((sum, { features }) => sum + features, 0);
  const qualityClassFeatureCount = layers.reduce((sum, layer) => ({
    A: sum.A + layer.qualityClassFeatureCount.A,
    B: sum.B + layer.qualityClassFeatureCount.B,
    C: sum.C + layer.qualityClassFeatureCount.C,
  }), { A: 0, B: 0, C: 0 });
  const detailedReport = {
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId: spec.infrastructureCorpusId,
    timetableYear: spec.timetableYear,
    scopeId: spec.scopeId,
    purpose: "visible-map-quality-evidence",
    operationalReleaseGate: false,
    deterministic: true,
    policy: {
      classA: "complete evidence",
      classB: "conservative model",
      classC: "visible but not orderable",
      classAFromSingleSourceOrAutomatedInference: false,
      conservativeAssumptionsReportedSeparately: true,
      ordinaryAssumptionsOperationalClassBEligible: false,
      syntheticDerivedClosureRequiredForOperationalClassB: true,
      nonPublicSourceRawDataShipped: false,
    },
    summary: {
      visibleLayers: layers.length,
      visibleFeatures,
      declaredQualityClassFeatureCount: { ...qualityClassFeatureCount },
      qualityClassFeatureCount: { ...qualityClassFeatureCount },
    },
    layers,
    trackDimensions: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, { policy: { ruleId: `${dimension}/v1` } }])),
  };
  return { spec, detailedReport };
}

test("Static-Map-Quality-v2 projiziert sichtbare Qualitaet und bindet den nicht ausgelieferten Detailbericht bytegenau", async () => {
  const value = fixture();
  const root = await mkdtemp(join(tmpdir(), "zugfolge-static-map-quality-"));
  try {
    const sourcePath = join(root, "detailed-quality.json");
    const sourceBytes = Buffer.from(`${JSON.stringify(value.detailedReport, null, 2)}\n`, "utf8");
    await writeFile(sourcePath, sourceBytes);
    const outputPath = join(root, "static-map-quality-v2.json");
    const first = await materializeStaticMapQuality(value.spec, sourcePath, outputPath);
    assert.equal(first.status, "materialized");
    assert.equal(first.quality.schema, "zugfolge-static-map-quality/v2");
    assert.equal(first.quality.releaseId, value.spec.releaseId);
    assert.equal(first.quality.infrastructureCorpusId, value.spec.infrastructureCorpusId);
    assert.deepEqual(first.quality.sourceReport, {
      content: "detailed-infrastructure-quality-report",
      binding: "sha256",
      bytes: sourceBytes.length,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      shipped: false,
    });
    assert.deepEqual(first.quality.summary, {
      visibleLayers: 10,
      visibleFeatures: value.detailedReport.summary.visibleFeatures,
      qualityClassFeatureCount: value.detailedReport.summary.qualityClassFeatureCount,
    });
    const serialized = await readFile(outputPath, "utf8");
    assert.doesNotMatch(serialized, /\/v1\b|trackDimensions|declaredQualityClass|ruleId|evidenceByState|nonPublicSourceRawData/i);
    await assert.rejects(
      materializeStaticMapQuality(value.spec, sourcePath, outputPath),
      (error) => error?.code === "EEXIST" && /weder ersetzt noch wiederverwendet/u.test(error.message),
    );

    await writeFile(sourcePath, Buffer.from(`${JSON.stringify(value.detailedReport)}\n`, "utf8"));
    await assert.rejects(
      materializeStaticMapQuality(value.spec, sourcePath, outputPath),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v1-Auslieferung, unehrliche Klassen, nichtoeffentliche Rohdaten und Detaillecks scheitern fail-closed", () => {
  const legacySpec = fixture();
  legacySpec.spec.schema = "zugfolge-static-map-quality-materialization/v1";
  assert.throws(() => buildStaticMapQuality({ spec: legacySpec.spec, detailedReport: legacySpec.detailedReport, sourceProof: { bytes: 1, sha256: "a".repeat(64) } }), /oeffentlicher v1-Vertrag ist nicht auslieferbar/);

  const wrongInput = fixture();
  wrongInput.detailedReport.schema = "zugfolge-final-infrastructure-quality-report/v2";
  assert.throws(() => buildStaticMapQuality({ spec: wrongInput.spec, detailedReport: wrongInput.detailedReport, sourceProof: { bytes: 1, sha256: "a".repeat(64) } }), /Unbekannter detaillierter Quality-Build-Input/);

  const relabeled = fixture();
  const platform = relabeled.detailedReport.layers.find(({ name }) => name === "platforms");
  platform.qualityClassFeatureCount = { A: 0, B: platform.features, C: 0 };
  assert.throws(() => buildStaticMapQuality({ spec: relabeled.spec, detailedReport: relabeled.detailedReport, sourceProof: { bytes: 1, sha256: "a".repeat(64) } }), /deklarierte und tatsaechliche Klassifikation weichen ab/);

  const raw = fixture();
  raw.detailedReport.policy.nonPublicSourceRawDataShipped = true;
  assert.throws(() => buildStaticMapQuality({ spec: raw.spec, detailedReport: raw.detailedReport, sourceProof: { bytes: 1, sha256: "a".repeat(64) } }), /Nichtoeffentliche Quelldaten duerfen nicht/);

  const publicValue = fixture();
  const quality = buildStaticMapQuality({ spec: publicValue.spec, detailedReport: publicValue.detailedReport, sourceProof: { bytes: 1, sha256: "a".repeat(64) } });
  assert.throws(() => validateStaticMapQuality({ ...quality, schema: "zugfolge-static-map-quality/v1" }), /kein Static-Map-Quality-v2-Schema/);
  assert.throws(() => validateStaticMapQuality({ ...quality, sourceReport: { ...quality.sourceReport, shipped: true } }), /darf nicht ausgeliefert/);
  assert.throws(() => validateStaticMapQuality({ ...quality, trackDimensions: {} }), /unerwartete oder fehlende Felder/);
  assert.doesNotMatch(serializeStaticMapQuality(quality).toString("utf8"), /zugfolge-[^"]+\/v1/);
});

test("CLI materialisiert den neuen Quality-v2-Vertrag aus Spec und detailliertem Build-Input", async () => {
  const value = fixture();
  const root = await mkdtemp(join(tmpdir(), "zugfolge-static-map-quality-cli-"));
  try {
    const specPath = join(root, "spec.json");
    const detailedPath = join(root, "detailed.json");
    const outputPath = join(root, "public.json");
    await writeFile(specPath, JSON.stringify(value.spec));
    await writeFile(detailedPath, JSON.stringify(value.detailedReport));
    const result = JSON.parse((await execFileAsync(process.execPath, [cli, "materialize", specPath, detailedPath, outputPath])).stdout);
    assert.equal(result.action, "materialized");
    assert.equal(result.schema, "zugfolge-static-map-quality/v2");
    assert.equal(result.releaseId, value.spec.releaseId);
    assert.equal(result.infrastructureCorpusId, value.spec.infrastructureCorpusId);
    assert.equal(result.visibleLayers, 10);
    assert.doesNotMatch(await readFile(outputPath, "utf8"), /\/v1\b/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
