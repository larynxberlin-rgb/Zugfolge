import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { root, repository } from "./paths.mjs";
import { verifyNativeKernel } from "./native/verify-native.mjs";
import { verifyOfflineArt } from "./assets-v2/verify-art.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && !["--typecheck", "--components"].includes(args[0]))) {
  throw new Error("Aufruf: node tools/conductor-offline/check.mjs [--typecheck|--components]");
}
async function run(label, args) {
  process.stdout.write(`\nOffline-Demo: ${label}\n`);
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: repository, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? done()
      : reject(new Error(`${label} fehlgeschlagen (${signal ?? code}).`)));
  });
}
if (args[0] === "--typecheck") {
  await run("strikte UI-Typprüfung", [resolve(repository, "apps/livemap/node_modules/typescript/bin/tsc"),
    "-p", resolve(root, "tsconfig.ui.json")]);
} else {
  await verifyNativeKernel();
  await verifyOfflineArt();
  for (const [label, script, flags] of [
    ["Single-HTML-Build", "build.mjs", []],
    ["Original-WASM im Worker und Restore", "worker-smoke.mjs", []],
    ["lokale Uhr, Pause und Restore", "offline-api-clock.test.mjs", ["--test"]],
    ["drei echte native Kontrollübungen", "practice-control-smoke.mjs", []],
    ...(args[0] === "--components" ? [] : [
      ["Kontrollübungen über sichtbare Offline-UI", "practice-browser-smoke.mjs", []],
      ["Animation, Bewegung und mobile Offline-UI", "animation-browser-smoke.mjs", []],
      ["gebundener Abschlussnachweis", "finalize-v2.mjs", []],
    ]),
  ]) await run(label, [...flags, resolve(root, script)]);
}
