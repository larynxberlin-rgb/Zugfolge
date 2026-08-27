import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildMapAssetTreeProof } from "./map-asset-notices.mjs";
import { buildMapSourceCapture, deriveProtomapsDailyVersion, writeMapSourceCapture } from "./map-source-capture.mjs";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./build-map-source-capture.mjs", import.meta.url));

const metadata = {
  "planetiler:osm:osmosisreplicationtime": "2026-08-12T04:00:00Z",
  "planetiler:osm:osmosisreplicationseq": "121965",
  version: "4.15.2",
};
const style = { version: 8, sources: { protomaps: { type: "vector", url: "https://build-tiles.protomaps.dev/20260812.json" } } };

function proof(bytes) {
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function notice(text) {
  return { text, ...proof(Buffer.from(text, "utf8")) };
}

async function assetFixture(root) {
  const glyphBytes = Buffer.from("fixture-glyph");
  const spriteJson = Buffer.from("{}\n");
  const spritePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const files = [
    { sourceFile: "assets/fonts/Fixture/0-255.pbf", cacheFile: "sources/basemap/assets/fonts/Fixture/0-255.pbf", kind: "glyph", installPath: "assets/fonts/Fixture/0-255.pbf", bytes: glyphBytes },
    { sourceFile: "assets/sprites/dark.json", cacheFile: "sources/basemap/assets/sprites/dark.json", kind: "sprite", installPath: "assets/sprites/dark.json", bytes: spriteJson },
    { sourceFile: "assets/sprites/dark.png", cacheFile: "sources/basemap/assets/sprites/dark.png", kind: "sprite", installPath: "assets/sprites/dark.png", bytes: spritePng },
  ];
  for (const file of files) {
    await mkdir(join(root, ...file.sourceFile.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...file.sourceFile.split("/")), file.bytes);
  }
  const descriptors = files.map((file, index) => ({ id: `asset-${index}`, kind: file.kind, installPath: file.installPath, ...proof(file.bytes) }));
  const notoCopyright = "Copyright 2022 The Noto Project Authors (https://github.com/notofonts)";
  const spriteCopyright = "Copyright (c) 2017 Mapzen";
  const notoNotice = notice(`${notoCopyright}\nSIL OPEN FONT LICENSE Version 1.1\n`);
  const spriteNotice = notice(`The MIT License (MIT)\n${spriteCopyright}\n`);
  const assetNotices = {
    schema: "zugfolge-map-asset-notices/v2",
    assets: [
      {
        id: "noto-glyphs", rightsSourceId: "noto-glyphs", kind: "glyph", license: "OFL-1.1", copyright: notoCopyright,
        modifications: "PBF-Glyphen werden unveraendert selbst gehostet.",
        source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "fonts" }, derivedFrom: null,
        notice: { url: `https://raw.githubusercontent.com/protomaps/basemaps-assets/${"a".repeat(40)}/fonts/OFL.txt`, ...notoNotice },
        tree: buildMapAssetTreeProof("glyph", "assets/fonts", descriptors),
      },
      {
        id: "protomaps-sprites", rightsSourceId: "protomaps-sprites", kind: "sprite", license: "MIT", copyright: spriteCopyright,
        modifications: "Dunkle Sprites werden unveraendert selbst gehostet.",
        source: { repository: "https://github.com/protomaps/basemaps-assets", commit: "a".repeat(40), path: "sprites/v4" },
        derivedFrom: { repository: "https://github.com/tangrams/icons", commit: "b".repeat(40), license: "MIT" },
        notice: { url: `https://raw.githubusercontent.com/tangrams/icons/${"b".repeat(40)}/LICENSE.md`, ...spriteNotice },
        tree: buildMapAssetTreeProof("sprite", "assets/sprites", descriptors),
      },
    ],
  };
  return {
    assetNotices,
    cacheInventoryPlan: { schema: "zugfolge-map-build-cache-inventory-plan/v1", releaseId: "infra-deutschland-2026.1", files: files.map(({ sourceFile, cacheFile }) => ({ sourceFile, cacheFile })) },
    files,
  };
}

test("leitet die Tagesversion nur aus übereinstimmendem HTTPS-Downloadbeleg und PMTiles-Metadaten ab", () => {
  assert.deepEqual(deriveProtomapsDailyVersion(style, metadata), {
    day: "20260812",
    version: "20260812+osm-121965+basemap-4.15.2",
    capturedAt: "2026-08-12T04:00:00Z",
    sourceUrl: "https://build-tiles.protomaps.dev/20260812.json",
  });
  assert.throws(() => deriveProtomapsDailyVersion({ ...style, sources: { protomaps: { url: "https://build-tiles.protomaps.dev/latest.json" } } }, metadata), /Tagesbuild/);
  assert.throws(() => deriveProtomapsDailyVersion(style, { ...metadata, "planetiler:osm:osmosisreplicationtime": "2026-08-11T04:00:00Z" }), /widersprechen/);
});

test("hasht PMTiles und reale Glyph-/Spritebaeume und bindet den oeffentlichen InfraRelease reproduzierbar", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-capture-"));
  try {
    const basemapPath = join(root, "basemap.pmtiles");
    const infraPath = join(root, "infra.pmtiles");
    const basemap = Buffer.alloc(256, 1);
    const infrastructure = Buffer.alloc(256, 2);
    await Promise.all([writeFile(basemapPath, basemap), writeFile(infraPath, infrastructure)]);
    const infraSha = "f5c22e35d04167e37913e7963ce033b1f3d17a924a4e6fe5fc95af1224051921";
    const infraRelease = {
      schema: "zugfolge-infra-release/v2",
      releaseId: "infra-deutschland-2026.1",
      timetableYear: 2026,
      artifacts: [{ id: "infra-deutschland-2026.1", bytes: infrastructure.length, sha256: infraSha }],
    };
    const assets = await assetFixture(root);
    const first = await buildMapSourceCapture({
      upstreamStyle: style,
      hybridMetadata: metadata,
      hybridPath: basemapPath,
      infrastructurePath: infraPath,
      infraRelease,
      assetNotices: assets.assetNotices,
      cacheInventoryPlan: assets.cacheInventoryPlan,
      artifactRoot: root,
    });
    assert.equal(first.capture.schema, "zugfolge-map-source-capture/v2");
    assert.equal(first.capture.sources[0].sha256, infraSha);
    assert.equal(first.capture.sources[1].version, "20260812+osm-121965+basemap-4.15.2");
    assert.equal(first.assetFiles, 3);
    assert.match(first.capture.assetInventoryPlanSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(first.capture.assetNotices, assets.assetNotices);
    const output = join(root, "capture.json");
    assert.equal((await writeMapSourceCapture(first, output)).status, "written");
    await assert.rejects(
      writeMapSourceCapture(first, output),
      (error) => error?.code === "EEXIST" && /weder ersetzt noch wiederverwendet/u.test(error.message),
    );
    assert.deepEqual(await readFile(output), first.captureBytes);

    await writeFile(join(root, ...assets.files[0].sourceFile.split("/")), "manipulated-glyph");
    await assert.rejects(buildMapSourceCapture({
      upstreamStyle: style,
      hybridMetadata: metadata,
      hybridPath: basemapPath,
      infrastructurePath: infraPath,
      infraRelease,
      assetNotices: assets.assetNotices,
      cacheInventoryPlan: assets.cacheInventoryPlan,
      artifactRoot: root,
    }), /weicht im Cache-Inventar oder in den realen Quelldateien/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Build-CLI laedt Notice-Volltexte und schreibt Capture-v2 aus dem expliziten Cache-Inventar", async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-map-capture-cli-"));
  try {
    const basemap = Buffer.alloc(256, 1);
    const infrastructure = Buffer.alloc(256, 2);
    const assets = await assetFixture(root);
    const values = {
      style,
      metadata,
      infraRelease: {
        schema: "zugfolge-infra-release/v2",
        releaseId: "infra-deutschland-2026.1",
        timetableYear: 2026,
        artifacts: [{ id: "infra-deutschland-2026.1", bytes: infrastructure.length, sha256: proof(infrastructure).sha256 }],
      },
      cache: assets.cacheInventoryPlan,
    };
    for (const [name, value] of Object.entries(values)) await writeFile(join(root, `${name}.json`), JSON.stringify(value));
    await writeFile(join(root, "basemap.pmtiles"), basemap);
    await writeFile(join(root, "infra.pmtiles"), infrastructure);
    await mkdir(join(root, "notices"));
    const contract = { schema: "zugfolge-map-asset-notice-contract/v1", assets: [] };
    for (const asset of assets.assetNotices.assets) {
      const file = `notices/${asset.id}.txt`;
      await writeFile(join(root, ...file.split("/")), asset.notice.text);
      const { text: _text, ...noticeProof } = asset.notice;
      contract.assets.push({ ...asset, notice: { file, ...noticeProof } });
    }
    await writeFile(join(root, "asset-contract.json"), JSON.stringify(contract));
    const output = join(root, "capture.json");
    const args = [
      join(root, "style.json"), join(root, "metadata.json"), join(root, "basemap.pmtiles"), join(root, "infra.pmtiles"),
      join(root, "infraRelease.json"), join(root, "asset-contract.json"), root, join(root, "cache.json"), root, output,
    ];
    const result = JSON.parse((await execFileAsync(process.execPath, [cli, ...args])).stdout);
    assert.equal(result.assetFiles, 3);
    assert.equal(result.assetNoticesSchema, "zugfolge-map-asset-notices/v2");
    assert.equal(JSON.parse(await readFile(output, "utf8")).schema, "zugfolge-map-source-capture/v2");
    await assert.rejects(
      execFileAsync(process.execPath, [cli, ...args]),
      (error) => /EEXIST|existiert bereits/u.test(error?.stderr ?? error?.message ?? ""),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
