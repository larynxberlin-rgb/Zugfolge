import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { executeProductionRecoveryAction } from "./production-recovery-contract.mjs";

export { executeProductionRecoveryAction };

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [action, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || !["prepared", "preflight", "activate", "reseal"].includes(action)) {
    process.stderr.write("Aufruf: node tools/alpha-ops/activate-production-recovery.mjs <prepared|preflight|activate|reseal>\n");
    process.exitCode = 64;
  } else {
    try {
      process.stdout.write(`${JSON.stringify(await executeProductionRecoveryAction({ action }))}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 65;
    }
  }
}
