#!/usr/bin/env node
/** Reproduzierbare Offline-Pipeline für eigene Dark-Vector-Tiles (M4.7).
 * Benötigt tippecanoe und pmtiles im PATH; öffentliche Tile-Dienste werden nie angesprochen.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
const [included, excluded, output = "dist/zugfolge.pmtiles"] = process.argv.slice(2);
if (!included || !excluded) { console.error("Aufruf: build-pmtiles.mjs NETZ.geojson KONTEXT.geojson [AUSGABE.pmtiles]"); process.exit(2); }
const mbtiles = `${output}.mbtiles`;
mkdirSync(dirname(output),{recursive:true});
const run = (command, args) => { const result=spawnSync(command,args,{stdio:"inherit"}); if(result.status!==0) process.exit(result.status ?? 1); };
run("tippecanoe",["--force","--no-tile-compression","--minimum-zoom=5","--maximum-zoom=14","--layer=rail","--named-layer",`context:${excluded}`,"--output",mbtiles,included]);
run("pmtiles",["convert",mbtiles,output]);
rmSync(mbtiles,{force:true});
