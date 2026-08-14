#!/usr/bin/env node
// Datei-I/O-Orchestrator: Die autoritative Manifestentscheidung liegt im
// Rust-Binary `zugfolge-infra-release` (ADR-0005/E5).
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length !== 4) {
  throw new Error(
    "Aufruf: node build-infra-release.mjs BUILD-CONFIG.json SOURCE_ROOT ARTIFACT_ROOT OUTPUT.json",
  );
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resolvedArgs = args.map((path) => resolve(path));
const cargo = process.env.CARGO ?? "cargo";
const child = spawn(
  cargo,
  [
    "run",
    "--quiet",
    "--locked",
    "-p",
    "zugfolge-infra",
    "--bin",
    "zugfolge-infra-release",
    "--",
    "regional-manifest",
    ...resolvedArgs,
  ],
  { cwd: root, stdio: "inherit", shell: false },
);

child.on("error", (error) => {
  throw error;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
