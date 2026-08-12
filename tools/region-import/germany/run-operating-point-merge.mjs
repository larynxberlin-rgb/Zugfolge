#!/usr/bin/env node
import { writeMergedOperatingPoints } from "./operating-point-merge.mjs";

const [officialPath, trassenfinderPath, outputRoot] = process.argv.slice(2);
if (!outputRoot) throw new Error("Aufruf: run-operating-point-merge.mjs OFFICIAL.geojsonseq TF.jsonseq OUTPUT_ROOT");
process.stdout.write(`${JSON.stringify(await writeMergedOperatingPoints(officialPath, trassenfinderPath, outputRoot))}\n`);
