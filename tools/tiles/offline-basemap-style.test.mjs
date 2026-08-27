import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildOfflineBasemapStyle,
  materializeOfflineBasemapStyle,
  serializeOfflineBasemapStyle,
} from "./offline-basemap-style.mjs";

const upstream = {
  version: 8,
  name: "Upstream",
  sources: { protomaps: { type: "vector", url: "https://example.invalid/tiles.json" } },
  glyphs: "https://example.invalid/fonts/{fontstack}/{range}.pbf",
  sprite: "https://example.invalid/sprite",
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#101216" } },
    { id: "roads", type: "line", source: "protomaps", "source-layer": "roads", minzoom: 5 },
  ],
};

const options = {
  releaseId: "infra-deutschland-2026.1",
  basemapUrl: "pmtiles:///artifacts/maps/infra-deutschland-2026.1/basemap.pmtiles",
  glyphsUrl: "/artifacts/maps/infra-deutschland-2026.1/assets/fonts/{fontstack}/{range}.pbf",
  spriteUrl: "/artifacts/maps/infra-deutschland-2026.1/assets/sprites/dark",
  maxZoom: 15,
  attribution: "© OpenStreetMap-Mitwirkende, ODbL 1.0; Basemap-Aufbereitung Protomaps; weitere Bearbeitung durch Zugfolge",
};

test("ersetzt die Onlinequelle durch genau eine releasefeste Offlinequelle", () => {
  const { style, styleHash } = buildOfflineBasemapStyle(upstream, options);
  assert.deepEqual(Object.keys(style.sources), ["basemap"]);
  assert.equal(style.sources.basemap.url, options.basemapUrl);
  assert.equal(style.layers[1].source, "basemap");
  assert.equal(style.layers.length, upstream.layers.length);
  assert.equal(style.metadata["zugfolge:runtime_external_sources"], 0);
  assert.match(style.sources.basemap.attribution, /Protomaps/);
  assert.match(styleHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(style).includes("https://"), false);
});

test("ist byte-deterministisch", () => {
  const first = buildOfflineBasemapStyle(upstream, options);
  const second = buildOfflineBasemapStyle(upstream, options);
  assert.equal(first.styleHash, second.styleHash);
  assert.equal(serializeOfflineBasemapStyle(first.style), serializeOfflineBasemapStyle(second.style));
});

test("lehnt externe oder veränderliche Laufzeitpfade ab", () => {
  assert.throws(() => buildOfflineBasemapStyle(upstream, { ...options, basemapUrl: "https://tiles.example/basemap.pmtiles" }), /pmtiles:\/\/\//);
  assert.throws(() => buildOfflineBasemapStyle(upstream, { ...options, glyphsUrl: "/maps/latest/fonts/{fontstack}/{range}.pbf" }), /latest/);
  assert.throws(() => buildOfflineBasemapStyle(upstream, { ...options, glyphsUrl: "//tiles.example/fonts/{fontstack}/{range}.pbf" }), /selbst gehostet/u);
  assert.throws(() => buildOfflineBasemapStyle(upstream, { ...options, basemapUrl: "pmtiles:////tiles.example/basemap.pmtiles" }), /selbst gehostet/u);
  assert.throws(() => buildOfflineBasemapStyle(upstream, { ...options, releaseId: "infra-deutschland-main" }), /veränderliche/u);
  assert.throws(
    () => buildOfflineBasemapStyle({ ...upstream, metadata: { documentation: "mapbox://styles/foreign" } }, options),
    /externe URLs/u,
  );
});

test("lehnt zusätzliche unbekannte Quellen der Vorlage ab", () => {
  assert.throws(() => buildOfflineBasemapStyle({ ...upstream, sources: { ...upstream.sources, extra: { type: "vector" } } }, options), /genau eine/);
});

test("publiziert den Offline-Stil atomar create-new und bewahrt vorhandene Ziele", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-offline-style-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "nested", "style.json");
  const expected = serializeOfflineBasemapStyle(buildOfflineBasemapStyle(upstream, options).style);

  const first = await materializeOfflineBasemapStyle(upstream, options, output);
  assert.equal(first.output, output);
  assert.equal(await readFile(output, "utf8"), expected);

  await assert.rejects(
    materializeOfflineBasemapStyle(
      { ...upstream, name: "darf das Ziel nicht ersetzen" },
      options,
      output,
    ),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(await readFile(output, "utf8"), expected);
});
