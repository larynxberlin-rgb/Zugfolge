import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BASEMAP_ATTRIBUTION,
  BASEMAP_VECTOR_LAYERS,
  INFRASTRUCTURE_VECTOR_LAYERS,
} from "./map-package.mjs";
import {
  MAP_PREVIEW_BUILD_SPEC_SCHEMA,
  MAP_PREVIEW_SCHEMA,
  buildMapPreviewBundle,
  validateMapPreviewBuildSpec,
  validateMapPreviewPackagePlan,
  writeMapPreviewBundle,
} from "./map-preview.mjs";

const ANNUAL_SPEC = new URL("./map-preview.annual-2026.3.spec.json", import.meta.url);
const ANNUAL_PLAN = new URL("./map-package.preview-2026.3.plan.json", import.meta.url);
const REQUIRED_BLOCKERS = [
  "class-c-visible-only",
  "infrarelease-not-produced",
  "operational-v2-absent",
  "production-activation-forbidden",
  "retained-2026.2-corpus-only",
];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function write(root, portable, bytes) {
  const path = join(root, ...portable.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

function pinned(sourceFile, bytes) {
  return { sourceFile, expectedBytes: bytes.length, expectedSha256: digest(bytes) };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-preview-"));
  const sourceRoot = join(root, "retained");
  await mkdir(sourceRoot);
  const basemapBytes = Buffer.alloc(256, 1);
  const semanticBytes = Buffer.alloc(257, 2);
  const readModelBytes = Buffer.from("SQLite format 3\0preview-read-model", "binary");
  const projectionBytes = Buffer.from("SQLite format 3\0preview-projection", "binary");
  const sourceBase = "/artifacts/maps/infra-deutschland-2026.2";
  const style = {
    version: 8,
    sources: {
      basemap: {
        type: "vector",
        url: `pmtiles://${sourceBase}/basemap.pmtiles`,
        attribution: BASEMAP_ATTRIBUTION,
      },
    },
    glyphs: `${sourceBase}/assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${sourceBase}/assets/sprites/dark`,
    layers: [{ id: "background", type: "background" }, { id: "boundaries", type: "line", source: "basemap", "source-layer": "boundaries" }],
  };
  const quality = {
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId: "infra-deutschland-2026.2",
    summary: { visibleFeatures: 6, qualityClassFeatureCount: { A: 0, B: 4, C: 2 } },
    layers: [
      { name: "tracks", qualityClassFeatureCount: { A: 0, B: 3, C: 1 } },
      { name: "platforms", qualityClassFeatureCount: { A: 0, B: 1, C: 1 } },
    ],
  };
  const sources = {
    schema: "zugfolge-map-delivery-sources/v1",
    releaseId: "infra-deutschland-2026.2",
    sources: [{ id: "fixture-source", approved: true, attribution: "Fixture attribution", license: "CC0-1.0", scope: "infrastructure", version: "2026" }],
  };
  const styleBytes = Buffer.from(JSON.stringify(style), "utf8");
  const qualityBytes = Buffer.from(JSON.stringify(quality), "utf8");
  const sourcesBytes = Buffer.from(JSON.stringify(sources), "utf8");
  const paths = {
    basemap: "retained/basemap.pmtiles",
    semantic: "retained/semantic.pmtiles",
    readModel: "retained/read-model.sqlite",
    projection: "retained/train-map-projection.sqlite",
    style: "retained/style.json",
    quality: "retained/quality.json",
    sources: "retained/sources.json",
  };
  await Promise.all([
    write(sourceRoot, paths.basemap, basemapBytes),
    write(sourceRoot, paths.semantic, semanticBytes),
    write(sourceRoot, paths.readModel, readModelBytes),
    write(sourceRoot, paths.projection, projectionBytes),
    write(sourceRoot, paths.style, styleBytes),
    write(sourceRoot, paths.quality, qualityBytes),
    write(sourceRoot, paths.sources, sourcesBytes),
    write(sourceRoot, "assets/fonts/Inter/0-255.pbf", Buffer.from("glyph")),
    write(sourceRoot, "assets/sprites/dark.json", Buffer.from("{}")),
    write(sourceRoot, "assets/sprites/dark.png", Buffer.from("png")),
    write(sourceRoot, "assets/sprites/dark@2x.json", Buffer.from("{}")),
    write(sourceRoot, "assets/sprites/dark@2x.png", Buffer.from("png2")),
  ]);
  const spec = {
    schema: MAP_PREVIEW_BUILD_SPEC_SCHEMA,
    previewId: "deutschland-2026.3-map-preview-fixture",
    package: {
      planSchema: "zugfolge-map-package-plan/v1",
      packageId: "zugfolge-map-deutschland-preview-fixture",
      version: "2026.3-preview-fixture",
      partBytes: 1024,
      runtimePublicBasePath: "/artifacts/map-previews/deutschland-2026.3-map-preview-fixture",
    },
    sourceCorpus: {
      corpusId: "deutschland-map-corpus-2026.2-fixture",
      timetableYear: 2026,
      legacyReference: "infra-deutschland-2026.2",
      legacyRuntimePublicBasePath: sourceBase,
      reusedUnchanged: true,
      basemap: { id: "basemap-preview", kind: "basemap", ...pinned(paths.basemap, basemapBytes), installPath: "basemap.pmtiles", expectedVectorLayers: BASEMAP_VECTOR_LAYERS },
      semanticMap: { id: "semantic-preview", kind: "infrastructure", ...pinned(paths.semantic, semanticBytes), installPath: "semantic.pmtiles", expectedVectorLayers: INFRASTRUCTURE_VECTOR_LAYERS },
      readModel: { id: "read-model-preview", kind: "read-model", visibility: "public", ...pinned(paths.readModel, readModelBytes), installPath: "read-model.sqlite" },
      trainMapProjection: { id: "projection-preview", kind: "train-map-projection", visibility: "public", ...pinned(paths.projection, projectionBytes), installPath: "train-map-projection.sqlite" },
      styleTemplate: pinned(paths.style, styleBytes),
      qualityReport: pinned(paths.quality, qualityBytes),
      sourceManifest: pinned(paths.sources, sourcesBytes),
      glyphTree: { idPrefix: "preview-glyph", kind: "glyph", visibility: "public", sourceDirectory: "assets/fonts", installDirectory: "assets/fonts", expectedInventory: { Inter: 1 } },
      spriteTree: { idPrefix: "preview-sprite", kind: "sprite", visibility: "public", sourceDirectory: "assets/sprites", installDirectory: "assets/sprites", expectedInventory: { "dark.json": 1, "dark.png": 1, "dark@2x.json": 1, "dark@2x.png": 1 } },
    },
    quality: {
      status: "blocked",
      expectedVisibleFeatures: 6,
      expectedQualityClassFeatureCount: { A: 0, B: 4, C: 2 },
      expectedClassCByLayer: [{ layer: "platforms", features: 1 }, { layer: "tracks", features: 1 }],
    },
    claims: { infraRelease: false, operationalInfrastructureV2: false, productionRelease: false, pmtilesReusedByteForByte: true },
    activation: { eligible: false, productionImportAllowed: false, productionStagingAllowed: false, worldAdoptionAllowed: false },
    requiredBlockers: REQUIRED_BLOCKERS,
  };
  return { root, sourceRoot, spec, paths, quality, qualityBytes, styleBytes };
}

test("der eingecheckte 2026.3-Preview-Vertrag bleibt ein eigener blockierter v1-Kartenplan", async () => {
  const [spec, plan] = await Promise.all([
    readFile(ANNUAL_SPEC, "utf8").then(JSON.parse),
    readFile(ANNUAL_PLAN, "utf8").then(JSON.parse),
  ]);
  validateMapPreviewBuildSpec(spec);
  validateMapPreviewPackagePlan(plan, spec);
  assert.equal(plan.schema, "zugfolge-map-package-plan/v1");
  assert.equal(plan.packageId, "zugfolge-map-deutschland-preview");
  assert.notEqual(plan.packageId, "zugfolge-map-deutschland");
  assert.equal(spec.claims.infraRelease, false);
  assert.equal(spec.claims.operationalInfrastructureV2, false);
  assert.equal(spec.activation.eligible, false);
  assert.equal(spec.quality.expectedQualityClassFeatureCount.C, 32_064);
  assert.equal(plan.auxiliaryFiles.some(({ kind }) => kind === "train-map-projection"), true);
  assert.equal(plan.auxiliaryFiles.some(({ kind }) => kind === "operational-infrastructure-v2"), false);
});

test("der Builder materialisiert nur kleine Preview-Dateien und expandiert sie zum installierbaren v1-Vertrag", async () => {
  const value = await fixture();
  try {
    const bundle = await buildMapPreviewBundle({ spec: value.spec, sourceRoot: value.sourceRoot });
    const outputRoot = join(value.root, "preview-output");
    const first = await writeMapPreviewBundle(bundle, outputRoot);
    assert.equal(first.status, "written");
    assert.equal(first.expanded.schema, "zugfolge-map-package-spec/v1");
    assert.equal(first.expanded.auxiliaryFiles.some(({ kind }) => kind === "operational-infrastructure-v2"), false);
    assert.equal(first.expanded.auxiliaryFiles.some(({ kind }) => kind === "train-map-projection"), true);
    const preview = JSON.parse(await readFile(join(outputRoot, "public", "preview.json"), "utf8"));
    assert.equal(preview.schema, MAP_PREVIEW_SCHEMA);
    assert.equal(preview.previewId, value.spec.previewId);
    assert.equal(preview.status, "blocked");
    assert.equal(preview.activationEligible, false);
    assert.equal(preview.claims.infraRelease, false);
    assert.equal(preview.claims.operationalInfrastructureV2, false);
    assert.equal(preview.quality.classCFeatures, 2);
    const style = await readFile(join(outputRoot, "style.json"), "utf8");
    assert.equal(style.includes(value.spec.sourceCorpus.legacyRuntimePublicBasePath), false);
    assert.equal(style.includes(value.spec.package.runtimePublicBasePath), true);
    assert.equal((await writeMapPreviewBundle(bundle, outputRoot)).status, "reused");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
test("Aktivierung, Produktionsidentitaet, v2 oder fehlender C-Blocker werden fail-closed abgelehnt", async () => {
  const value = await fixture();
  try {
    const active = structuredClone(value.spec);
    active.activation.eligible = true;
    assert.throws(() => validateMapPreviewBuildSpec(active), /fail-closed/);
    const claiming = structuredClone(value.spec);
    claiming.claims.infraRelease = true;
    assert.throws(() => validateMapPreviewBuildSpec(claiming), /kein InfraRelease/);
    const production = structuredClone(value.spec);
    production.package.packageId = "zugfolge-map-deutschland";
    assert.throws(() => validateMapPreviewBuildSpec(production), /Preview-Paket-ID/);
    const noC = structuredClone(value.spec);
    noC.quality.expectedQualityClassFeatureCount.B += 2;
    noC.quality.expectedQualityClassFeatureCount.C = 0;
    noC.quality.expectedClassCByLayer = [];
    assert.throws(() => validateMapPreviewBuildSpec(noC), /Klasse-C-Blocker/);
    const bundle = await buildMapPreviewBundle({ spec: value.spec, sourceRoot: value.sourceRoot });
    const v2 = structuredClone(bundle.plan);
    v2.schema = "zugfolge-map-package-plan/v2";
    assert.throws(() => validateMapPreviewPackagePlan(v2, value.spec), /v1 bleiben/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("fehlende oder byteveraenderte erhaltene Eingaben werden vor der Planerzeugung abgelehnt", async () => {
  const missing = await fixture();
  try {
    const absent = structuredClone(missing.spec);
    absent.sourceCorpus.styleTemplate.sourceFile = "retained/fehlt.json";
    await assert.rejects(buildMapPreviewBundle({ spec: absent, sourceRoot: missing.sourceRoot }), /ENOENT/);
  } finally {
    await rm(missing.root, { recursive: true, force: true });
  }

  const changed = await fixture();
  try {
    await write(changed.sourceRoot, changed.paths.style, Buffer.alloc(changed.styleBytes.length, 0x20));
    await assert.rejects(buildMapPreviewBundle({ spec: changed.spec, sourceRoot: changed.sourceRoot }), /gepinnten SHA-256/);
  } finally {
    await rm(changed.root, { recursive: true, force: true });
  }
});

test("eine umetikettierte C-Bilanz und ein vom Builder abweichender Golden-Plan scheitern", async () => {
  const value = await fixture();
  try {
    const dishonestQuality = structuredClone(value.quality);
    dishonestQuality.summary.qualityClassFeatureCount = { A: 0, B: 6, C: 0 };
    dishonestQuality.layers[0].qualityClassFeatureCount = { A: 0, B: 4, C: 0 };
    dishonestQuality.layers[1].qualityClassFeatureCount = { A: 0, B: 2, C: 0 };
    const bytes = Buffer.from(JSON.stringify(dishonestQuality), "utf8");
    await write(value.sourceRoot, value.paths.quality, bytes);
    const dishonestSpec = structuredClone(value.spec);
    dishonestSpec.sourceCorpus.qualityReport = pinned(value.paths.quality, bytes);
    await assert.rejects(buildMapPreviewBundle({ spec: dishonestSpec, sourceRoot: value.sourceRoot }), /andere Qualitaetsklassenwerte/);

    await write(value.sourceRoot, value.paths.quality, value.qualityBytes);
    const honestBundle = await buildMapPreviewBundle({ spec: value.spec, sourceRoot: value.sourceRoot });
    const stalePlan = structuredClone(honestBundle.plan);
    stalePlan.auxiliaryFiles.find(({ kind }) => kind === "release-manifest").expectedSha256 = "a".repeat(64);
    await assert.rejects(
      buildMapPreviewBundle({ spec: value.spec, packagePlan: stalePlan, sourceRoot: value.sourceRoot }),
      /weicht von den realen gepinnten Eingaben ab/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
