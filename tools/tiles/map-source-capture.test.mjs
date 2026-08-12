import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildMapSourceCapture, deriveProtomapsDailyVersion, writeMapSourceCapture } from "./map-source-capture.mjs";

const metadata = {
  "planetiler:osm:osmosisreplicationtime": "2026-08-12T04:00:00Z",
  "planetiler:osm:osmosisreplicationseq": "121965",
  version: "4.15.2",
};
const style = { version: 8, sources: { protomaps: { type: "vector", url: "https://build-tiles.protomaps.dev/20260812.json" } } };

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

test("hasht beide finalen Dateien und bindet den echten öffentlichen InfraRelease reproduzierbar", async () => {
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
    const first = await buildMapSourceCapture({ upstreamStyle: style, hybridMetadata: metadata, hybridPath: basemapPath, infrastructurePath: infraPath, infraRelease });
    assert.equal(first.capture.sources[0].sha256, infraSha);
    assert.equal(first.capture.sources[1].version, "20260812+osm-121965+basemap-4.15.2");
    const output = join(root, "capture.json");
    assert.equal((await writeMapSourceCapture(first, output)).status, "written");
    assert.equal((await writeMapSourceCapture(first, output)).status, "reused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
