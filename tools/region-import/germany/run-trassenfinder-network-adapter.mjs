#!/usr/bin/env node
import { writeTrassenfinderNetwork } from "./trassenfinder-network-adapter.mjs";

const [inputPath, outputRoot, expectedSha256] = process.argv.slice(2);
if (!outputRoot) throw new Error("Aufruf: run-trassenfinder-network-adapter.mjs INPUT.json OUTPUT_ROOT [SHA256]");
process.stdout.write(`${JSON.stringify(await writeTrassenfinderNetwork(inputPath, outputRoot, expectedSha256))}\n`);
