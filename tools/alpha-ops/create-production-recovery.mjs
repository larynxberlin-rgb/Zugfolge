import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createProductionRecoveryArtifacts } from "./production-recovery-contract.mjs";

export { createProductionRecoveryArtifacts };

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(await createProductionRecoveryArtifacts())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}
