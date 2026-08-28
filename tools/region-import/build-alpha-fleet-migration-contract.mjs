import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runBuildAlphaFleetMigrationContract } from "./migrate-alpha-fleet-v1-to-v2.mjs";

const mainModule = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (mainModule) await runBuildAlphaFleetMigrationContract();
