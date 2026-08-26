#!/usr/bin/env node
import { pathToFileURL } from "node:url";

import { executeProductionRecoverySourceAction } from "./production-recovery-contract.mjs";

export { executeProductionRecoverySourceAction };

async function main() {
  const [action, ...extra] = process.argv.slice(2);
  if (extra.length !== 0 || (action !== "release" && action !== "reseal")) {
    process.stderr.write("Aufruf: node tools/alpha-ops/switch-production-recovery-source.mjs <release|reseal>\n");
    process.exitCode = 64;
    return;
  }
  try {
    process.stdout.write(`${JSON.stringify(await executeProductionRecoverySourceAction({ action }))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
