#!/usr/bin/env node
// zugfolge:quelle=dem-hoehenmodell
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { captureDemTiles, verifyDemCapture } from "./copernicus-dem.mjs";

const execFileAsync = promisify(execFile);
const worker = fileURLToPath(new URL("./copernicus_dem_sample.py", import.meta.url));

function usage() {
  return [
    "Aufruf:",
    "  run-copernicus-dem.mjs capture TRACKS CACHE CAPTURE.json [CONCURRENCY]",
    "  run-copernicus-dem.mjs verify  TRACKS CACHE CAPTURE.json",
    "  run-copernicus-dem.mjs derive  TRACKS CACHE CAPTURE.json OUTPUT PYTHON",
    "  run-copernicus-dem.mjs all     TRACKS CACHE CAPTURE.json OUTPUT PYTHON [CONCURRENCY]",
  ].join("\n");
}

async function derive(tracks, cache, manifest, output, python) {
  const started = performance.now();
  const { stdout, stderr } = await execFileAsync(python, [
    worker,
    "--tracks", tracks,
    "--cache", cache,
    "--manifest", manifest,
    "--output", output,
  ], { maxBuffer: 10 * 1024 * 1024 });
  if (stderr.trim() !== "") process.stderr.write(stderr);
  return { ...JSON.parse(stdout), durationMs: Math.round(performance.now() - started) };
}

const [operation, tracks, cache, manifest, output, python, concurrencyText] = process.argv.slice(2);
if (!operation || !tracks || !cache || !manifest) throw new Error(usage());

if (operation === "capture") {
  const concurrency = Number.parseInt(output ?? "2", 10);
  const result = await captureDemTiles({ tracksPath: tracks, cacheRoot: cache, manifestPath: manifest, concurrency });
  process.stdout.write(`${JSON.stringify({ tiles: result.tiles.length, bytes: result.tiles.reduce((sum, tile) => sum + tile.bytes, 0), aggregateTileSha256: result.manifest.aggregateTileSha256 })}\n`);
} else if (operation === "verify") {
  const result = await verifyDemCapture({ tracksPath: tracks, cacheRoot: cache, manifestPath: manifest });
  process.stdout.write(`${JSON.stringify({ verified: true, tiles: result.tiles.length, aggregateTileSha256: result.manifest.aggregateTileSha256 })}\n`);
} else if (operation === "derive") {
  if (!output || !python) throw new Error(usage());
  process.stdout.write(`${JSON.stringify(await derive(tracks, cache, manifest, output, python))}\n`);
} else if (operation === "all") {
  if (!output || !python) throw new Error(usage());
  const concurrency = Number.parseInt(concurrencyText ?? "2", 10);
  await captureDemTiles({ tracksPath: tracks, cacheRoot: cache, manifestPath: manifest, concurrency });
  process.stdout.write(`${JSON.stringify(await derive(tracks, cache, manifest, output, python))}\n`);
} else {
  throw new Error(usage());
}
