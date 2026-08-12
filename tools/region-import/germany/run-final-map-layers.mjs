#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildFinalMapLayers } from "./final-map-layers.mjs";

const [configurationPath] = process.argv.slice(2);
if (!configurationPath) throw new Error("Aufruf: run-final-map-layers.mjs CONFIG.json");
const configuration = JSON.parse(await readFile(resolve(configurationPath), "utf8"));
const result = await buildFinalMapLayers(configuration);
process.stdout.write(`${JSON.stringify({ outputDirectory: result.outputDirectory, report: result.report })}\n`);
