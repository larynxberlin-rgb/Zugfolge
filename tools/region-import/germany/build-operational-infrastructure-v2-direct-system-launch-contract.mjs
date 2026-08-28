#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
  GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE,
  GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE,
  validateGermanyOperationalExecutionPins,
} from "./operational-infrastructure-v2-execution-pins.mjs";

export const GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA =
  "zugfolge-operational-v2-direct-system-launch-contract/v1";
export const GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_FILE =
  "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.annual-2026.5.json";
export const GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_SOURCE_FILE =
  "tools/region-import/germany/operational-infrastructure-v2-direct-system-launch.windows.ps1";
export const GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTEXT_SCHEMA =
  "zugfolge-operational-v2-direct-system-launch-context/v1";

export const GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_BINDINGS = Object.freeze([
  Object.freeze({
    id: "launchContext",
    environment: "ZUGFOLGE_OPERATIONAL_LAUNCH_CONTEXT_BASE64",
    encoding: "canonical-json-utf8-base64-v1",
    schema: GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTEXT_SCHEMA,
    properties: Object.freeze([
      "candidatePath",
      "candidateSidecarPath",
      "executionPinsPath",
      "nativeReceiptPath",
      "reportPath",
      "runtimePath",
      "schema",
      "sourceRoot",
      "specificationPath",
    ]),
  }),
]);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../..");
const DEFAULT_EXECUTION_PINS_FILE =
  "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json";
const SHA256 = /^[a-f0-9]{64}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
}

function fileProof(file, bytes) {
  return {
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function serializeGermanyOperationalDirectSystemLaunchContract(value) {
  return Buffer.from(`${JSON.stringify(sortedValue(value))}\n`, "utf8");
}

export function validateGermanyOperationalDirectSystemLaunchContract(value) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value),
    "Operational-v2-Direct-System-Launch-Vertrag muss ein Objekt sein.");
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([
    "bootstrap", "dynamicBindings", "executionPins", "launcher", "platform", "releaseId", "schema", "trustedExecutor",
  ]), "Operational-v2-Direct-System-Launch-Vertrag besitzt fremde oder fehlende Felder.");
  invariant(value.schema === GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA
    && /^infra-deutschland-[0-9]{4}\.[1-9][0-9]*$/u.test(value.releaseId) && value.platform === "win32",
  "Operational-v2-Direct-System-Launch-Vertrag besitzt eine falsche Identitaet.");
  invariant(JSON.stringify(sortedValue(value.dynamicBindings))
    === JSON.stringify(sortedValue(GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_BINDINGS)),
    "Operational-v2-Direct-System-Launch-Vertrag besitzt nicht exakt die kanonische Base64-Kontextbindung.");
  const releaseVersion = value.releaseId.slice("infra-deutschland-".length);
  invariant(value.executionPins !== null && typeof value.executionPins === "object" && !Array.isArray(value.executionPins)
    && JSON.stringify(Object.keys(value.executionPins).sort()) === JSON.stringify(["bytes", "file", "schema", "sha256"])
    && value.executionPins.file === `tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-${releaseVersion}.json`
    && Number.isSafeInteger(value.executionPins.bytes) && value.executionPins.bytes > 0
    && SHA256.test(value.executionPins.sha256)
    && value.executionPins.schema === GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
  "Operational-v2-Direct-System-Launch-Vertrag besitzt ungueltige Execution-Pins.");
  invariant(value.trustedExecutor !== null && typeof value.trustedExecutor === "object"
    && !Array.isArray(value.trustedExecutor)
    && JSON.stringify(Object.keys(value.trustedExecutor).sort()) === JSON.stringify([
      "buildCommit", "bytes", "file", "sha256",
    ])
    && typeof value.trustedExecutor.file === "string" && value.trustedExecutor.file.length > 0
    && !value.trustedExecutor.file.includes("\\") && !value.trustedExecutor.file.startsWith("/")
    && !value.trustedExecutor.file.split("/").includes(".."),
  "Operational-v2-Direct-System-Launch-Vertrag besitzt keinen Trusted-Executor-Pfad.");
  invariant(/^[a-f0-9]{40}$/u.test(value.trustedExecutor.buildCommit)
    && Number.isSafeInteger(value.trustedExecutor.bytes) && value.trustedExecutor.bytes > 0
    && SHA256.test(value.trustedExecutor.sha256),
  "Operational-v2-Direct-System-Launch-Vertrag besitzt einen ungueltigen Trusted-Executor-Beleg.");
  invariant(value.launcher !== null && typeof value.launcher === "object" && !Array.isArray(value.launcher)
    && JSON.stringify(Object.keys(value.launcher).sort()) === JSON.stringify(["file", "mode", "sourceBytes", "sourceSha256"])
    && value.launcher.file === GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE
    && value.launcher.mode === GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE
    && Number.isSafeInteger(value.launcher.sourceBytes) && value.launcher.sourceBytes > 0
    && SHA256.test(value.launcher.sourceSha256),
  "Operational-v2-Direct-System-Launch-Vertrag besitzt einen ungueltigen Windows-Systemlauncher.");
  invariant(value.bootstrap !== null && typeof value.bootstrap === "object" && !Array.isArray(value.bootstrap)
    && JSON.stringify(Object.keys(value.bootstrap).sort()) === JSON.stringify(["mode", "sourceBase64", "sourceBytes", "sourceEncoding", "sourceSha256"])
    && value.bootstrap.mode === "held-contract-inline-powershell-v1"
    && value.bootstrap.sourceEncoding === "utf-8"
    && Number.isSafeInteger(value.bootstrap.sourceBytes) && value.bootstrap.sourceBytes > 0
    && SHA256.test(value.bootstrap.sourceSha256)
    && typeof value.bootstrap.sourceBase64 === "string",
  "Operational-v2-Direct-System-Launch-Vertrag besitzt einen ungueltigen Inline-Bootstrap.");
  const sourceBytes = Buffer.from(value.bootstrap.sourceBase64, "base64");
  invariant(sourceBytes.toString("base64") === value.bootstrap.sourceBase64
    && sourceBytes.length === value.bootstrap.sourceBytes
    && createHash("sha256").update(sourceBytes).digest("hex") === value.bootstrap.sourceSha256,
  "Operational-v2-Direct-System-Launch-Inline-Bootstrap driftet von seinem Bytebeleg.");
  return value;
}

export async function buildGermanyOperationalDirectSystemLaunchContract({
  workspaceRoot = REPOSITORY_ROOT,
  executionPinsFile = DEFAULT_EXECUTION_PINS_FILE,
  executionPinsBytes: providedExecutionPinsBytes,
} = {}) {
  const root = resolve(workspaceRoot);
  const [executionPinsBytes, launcherBytes, bootstrapBytes] = await Promise.all([
    providedExecutionPinsBytes ?? readFile(join(root, ...executionPinsFile.split("/"))),
    readFile(join(root, ...GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE.split("/"))),
    readFile(join(root, ...GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_SOURCE_FILE.split("/"))),
  ]);
  const executionPins = validateGermanyOperationalExecutionPins(JSON.parse(executionPinsBytes.toString("utf8")));
  invariant(executionPins.runner.runtime.platform === "win32",
    "Operational-v2-Direct-System-Launch benoetigt Windows-Execution-Pins.");
  const launcherProof = fileProof(GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_SOURCE_FILE, launcherBytes);
  invariant(executionPins.runner.launcher.mode === GERMANY_OPERATIONAL_WINDOWS_LAUNCHER_MODE
    && executionPins.runner.launcher.sourceBytes === launcherProof.bytes
    && executionPins.runner.launcher.sourceSha256 === launcherProof.sha256,
  "Operational-v2-Direct-System-Launch-Systemlauncher driftet von den Execution-Pins.");
  const value = {
    schema: GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
    releaseId: executionPins.releaseId,
    platform: "win32",
    executionPins: {
      ...fileProof(executionPinsFile, executionPinsBytes),
      schema: GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
    },
    trustedExecutor: {
      file: executionPins.validator.file,
      buildCommit: executionPins.validator.buildCommit,
      bytes: executionPins.validator.bytes,
      sha256: executionPins.validator.sha256,
    },
    launcher: {
      file: launcherProof.file,
      mode: executionPins.runner.launcher.mode,
      sourceBytes: launcherProof.bytes,
      sourceSha256: launcherProof.sha256,
    },
    dynamicBindings: GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_BINDINGS.map((entry) => ({ ...entry })),
    bootstrap: {
      mode: "held-contract-inline-powershell-v1",
      sourceEncoding: "utf-8",
      sourceBase64: bootstrapBytes.toString("base64"),
      sourceBytes: bootstrapBytes.length,
      sourceSha256: createHash("sha256").update(bootstrapBytes).digest("hex"),
    },
  };
  return validateGermanyOperationalDirectSystemLaunchContract(value);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [outputFile = GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_FILE, ...extra] = process.argv.slice(2);
  invariant(extra.length === 0, "Aufruf: build-operational-infrastructure-v2-direct-system-launch-contract.mjs [OUTPUT.json]");
  const value = await buildGermanyOperationalDirectSystemLaunchContract();
  await writeFile(join(REPOSITORY_ROOT, ...outputFile.split("/")), serializeGermanyOperationalDirectSystemLaunchContract(value));
}
