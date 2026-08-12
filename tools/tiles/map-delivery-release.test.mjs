import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BASEMAP_VECTOR_LAYERS, INFRASTRUCTURE_VECTOR_LAYERS } from "./map-package.mjs";
import {
  buildMapDeliveryRelease,
  buildMapDeliverySources,
  serializeDeliveryJson,
  writeMapDeliveryRelease,
} from "./map-delivery-release.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function packageSpec() {
  return {
    schema: "zugfolge-map-package-spec/v1",
    packageId: "zugfolge-map-deutschland",
    version: "2026.1",
    partBytes: 100 * 1024 * 1024,
    runtime: {
      schema: "zugfolge-map-runtime/v1",
      publicBasePath: "/artifacts/maps/infra-deutschland-2026.1",
      basemapStyleUrl: "/artifacts/maps/infra-deutschland-2026.1/style.json",
      infrastructurePmtilesUrl: "/artifacts/maps/infra-deutschland-2026.1/infra.pmtiles",
    },
    artifacts: [
      { id: "basemap", kind: "basemap", sourceFile: "basemap.pmtiles", installPath: "basemap.pmtiles", expectedVectorLayers: BASEMAP_VECTOR_LAYERS },
      { id: "infrastructure", kind: "infrastructure", sourceFile: "infra.pmtiles", installPath: "infra.pmtiles", expectedVectorLayers: INFRASTRUCTURE_VECTOR_LAYERS },
    ],
    auxiliaryFiles: [
      { id: "glyph", kind: "glyph", visibility: "public", sourceFile: "assets/font.pbf", installPath: "assets/fonts/font.pbf" },
      { id: "quality", kind: "quality-manifest", visibility: "public", sourceFile: "public/quality.json", installPath: "manifests/quality.json" },
      { id: "readmodel", kind: "read-model", visibility: "public", sourceFile: "public/read-model.sqlite", installPath: "read-model.sqlite" },
      { id: "release", kind: "release-manifest", visibility: "public", sourceFile: "public/release.json", installPath: "manifests/release.json" },
      { id: "sources", kind: "source-manifest", visibility: "public", sourceFile: "public/sources.json", installPath: "manifests/sources.json" },
      { id: "sprite-json", kind: "sprite", visibility: "public", sourceFile: "assets/dark.json", installPath: "assets/sprites/dark.json" },
      { id: "sprite-png", kind: "sprite", visibility: "public", sourceFile: "assets/dark.png", installPath: "assets/sprites/dark.png" },
      { id: "style", kind: "style", visibility: "public", sourceFile: "style.json", installPath: "style.json" },
      { id: "train-projection", kind: "train-map-projection", visibility: "public", sourceFile: "public/train-map-projection.sqlite", installPath: "train-map-projection.sqlite" },
    ],
  };
}

function infraRelease() {
  return {
    schema: "zugfolge-infra-release/v2",
    releaseId: "infra-deutschland-2026.1",
    timetableYear: 2026,
    sources: [{
      id: "official-infrastructure",
      version: "2026-08-12",
      sourceLicense: "CC-BY-4.0",
      attribution: "Datenquelle DB InfraGO, CC BY 4.0; durch Zugfolge bearbeitet.",
      modifications: "Normalisiert und konservativ modelliert.",
    }],
  };
}

function mapRelease() {
  return {
    schema: "zugfolge-map-release/v1",
    releaseId: "map-2026.1",
    sources: [{
      id: "protomaps-daily-basemap",
      version: "20260812",
      sourceLicense: "ODbL-1.0 Produced Work",
      attribution: "© OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps; weitere Bearbeitung durch Zugfolge",
      modifications: "Welt und Deutschlanddetail zusammengeführt.",
    }],
    artifacts: [
      { id: "map-basemap", kind: "basemap", bytes: 14, sha256: HASH_A },
      { id: "map-infra", kind: "infrastructure", bytes: 12, sha256: HASH_B },
    ],
  };
}

function quality() {
  return {
    schema: "zugfolge-final-infrastructure-quality-report/v1",
    releaseId: "infra-deutschland-2026.1",
    timetableYear: 2026,
    deterministic: true,
    policy: {
      classC: "visible but not orderable",
      classAFromSingleSourceOrAutomatedInference: false,
      nonPublicSourceRawDataShipped: false,
    },
    summary: { visibleLayers: 10, visibleFeatures: 42 },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-delivery-"));
  await mkdir(join(root, "assets"), { recursive: true });
  await mkdir(join(root, "public"), { recursive: true });
  const files = new Map([
    ["basemap.pmtiles", Buffer.from("basemap-proof!")],
    ["infra.pmtiles", Buffer.from("infra-proof!")],
    ["assets/font.pbf", Buffer.from("glyph")],
    ["public/read-model.sqlite", Buffer.from("SQLite format 3\0")],
    ["public/train-map-projection.sqlite", Buffer.from("SQLite format 3\0")],
    ["assets/dark.json", Buffer.from("{}\n")],
    ["assets/dark.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ["style.json", Buffer.from("{}\n")],
    ["public/quality.json", serializeDeliveryJson(quality())],
  ]);
  for (const [path, bytes] of files) await writeFile(join(root, ...path.split("/")), bytes);
  return root;
}

test("kombinierter Deliveryvertrag bindet das vollständige öffentliche Paket ohne Signaturbehauptung", async () => {
  const root = await fixture();
  try {
    const result = await buildMapDeliveryRelease({
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      packageSpec: packageSpec(),
      sourceRoot: root,
      infraRelease: infraRelease(),
      mapRelease: mapRelease(),
      auxiliaryArtifactProofs: [
        { id: "readmodel", bytes: 16, sha256: HASH_C },
        { id: "train-projection", bytes: 16, sha256: HASH_D },
      ],
    });
    assert.equal(result.release.schema, "zugfolge-map-delivery-release/v1");
    assert.equal(result.release.signature, null);
    assert.equal(result.release.approvalGates.signature.status, "missing");
    assert.equal(result.release.artifacts.length, 9);
    assert.equal(result.release.artifacts.find(({ id }) => id === "basemap").sha256, HASH_A);
    assert.equal(result.release.artifacts.find(({ id }) => id === "readmodel").sha256, HASH_C);
    assert.equal(result.release.artifacts.find(({ id }) => id === "train-projection").sha256, HASH_D);
    assert.equal(result.release.bindings.sourcesSha256, result.sourcesSha256);
    assert.deepEqual(result.sources.sources.map(({ id }) => id), ["basemap-protomaps-daily-basemap", "infrastructure-official-infrastructure"]);

    const output = join(root, "public-output");
    assert.equal((await writeMapDeliveryRelease(result, output)).releaseStatus, "written");
    assert.equal((await writeMapDeliveryRelease(result, output)).releaseStatus, "reused");
    assert.deepEqual(JSON.parse(await readFile(join(output, "release.json"), "utf8")), result.release);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("öffentlicher Quellenvertrag verwirft interne Validierungsnamen", () => {
  const unsafe = infraRelease();
  unsafe.sources[0].attribution = "interne APN Validierung";
  assert.throws(
    () => buildMapDeliverySources({ releaseId: unsafe.releaseId, infraRelease: unsafe, mapRelease: mapRelease() }),
    /interne Validierungsreferenz/,
  );
});

test("ReadModel- und Zugpositionsbelege sind getrennt bytegenau und werden nicht als Ganzes erneut gelesen", async () => {
  const root = await fixture();
  try {
    await assert.rejects(
      buildMapDeliveryRelease({
        releaseId: "infra-deutschland-2026.1",
        timetableYear: 2026,
        packageSpec: packageSpec(),
        sourceRoot: root,
        infraRelease: infraRelease(),
        mapRelease: mapRelease(),
        auxiliaryArtifactProofs: [
          { id: "readmodel", bytes: 17, sha256: HASH_C },
          { id: "train-projection", bytes: 16, sha256: HASH_D },
        ],
      }),
      /belegten Bytezahl/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
