import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { executeProductionRecoveryAction } from "./production-recovery-contract.mjs";

export { executeProductionRecoveryAction };

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  if (process.argv.slice(2).length !== 0) {
    process.stderr.write("Aufruf: node tools/alpha-ops/continue-production-recovery.mjs\n");
    process.exitCode = 64;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await executeProductionRecoveryAction({ action: "continue" }))}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 65;
    }
  }
}
