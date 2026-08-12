#!/usr/bin/env node
import { resolve } from "node:path";

import { inspectPublicReadModel } from "./livemap-read-model.mjs";

const [path] = process.argv.slice(2);
if (path === undefined) throw new Error("Aufruf: node tools/tiles/inspect-livemap-read-model.mjs READ_MODEL.sqlite");
process.stdout.write(`${JSON.stringify(await inspectPublicReadModel(resolve(path)), null, 2)}\n`);
