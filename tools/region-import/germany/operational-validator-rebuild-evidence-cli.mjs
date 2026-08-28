#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = resolve(HERE, "operational-validator-rebuild-bootstrap.mjs");
const ENTRYPOINT_PATH = fileURLToPath(import.meta.url);
const IMPLEMENTATION_PATH = resolve(HERE, "operational-validator-rebuild-evidence.mjs");
const MAX_BOOTSTRAP_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function pathKey(path) {
  const value = resolve(path).replace(/^\\\\\?\\/u, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function sameStableMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function validateBootstrapPin(proof, expectedFile, label) {
  invariant(proof !== null && typeof proof === "object" && !Array.isArray(proof), `${label}-Pin fehlt.`);
  invariant(Object.keys(proof).sort().join(",") === "bytes,file,sha256", `${label}-Pin besitzt falsche Felder.`);
  invariant(proof.file === expectedFile, `${label}-Pin bindet den falschen Pfad.`);
  invariant(Number.isSafeInteger(proof.bytes) && proof.bytes > 0 && proof.bytes <= MAX_BOOTSTRAP_BYTES, `${label}-Pin besitzt ungueltige Bytes.`);
  invariant(typeof proof.sha256 === "string" && SHA256.test(proof.sha256), `${label}-Pin besitzt keinen SHA-256.`);
  return proof;
}

async function openPinnedBootstrapInput(path, expected, label) {
  const metadata = await lstat(path, { bigint: true });
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} muss eine regulaere Datei ohne Symlink sein.`);
  invariant(metadata.size > 0n && metadata.size <= BigInt(MAX_BOOTSTRAP_BYTES), `${label} ist leer oder unerwartet gross.`);
  invariant(pathKey(await realpath(path)) === pathKey(path), `${label} enthaelt einen Symlink-/Junction-Pfad.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(sameStableMetadata(metadata, before), `${label} wurde vor der vor-import Bindung ersetzt oder veraendert.`);
    const bytes = Buffer.alloc(Number(before.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    invariant(bytesRead === bytes.length, `${label} wurde vor dem Import nicht vollstaendig gelesen.`);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    invariant(sameStableMetadata(before, after) && sameStableMetadata(after, pathAfter), `${label} driftete waehrend der vor-import Bindung.`);
    invariant(bytes.length === expected.bytes && createHash("sha256").update(bytes).digest("hex") === expected.sha256,
      `${label} driftet vom externen Spec-Pin.`);
    return { bytes, handle, identity: after, path };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function assertPinnedBootstrapInput(entry, label) {
  const [held, visible] = await Promise.all([
    entry.handle.stat({ bigint: true }),
    lstat(entry.path, { bigint: true }),
  ]);
  invariant(sameStableMetadata(entry.identity, held) && sameStableMetadata(held, visible), `${label} wurde vor dem dynamischen Import ersetzt oder veraendert.`);
  const bytes = Buffer.alloc(entry.bytes.length);
  const { bytesRead } = await entry.handle.read(bytes, 0, bytes.length, 0);
  invariant(bytesRead === bytes.length && bytes.equals(entry.bytes), `${label} driftete trotz gehaltener Bindung.`);
}

async function loadExternallyPinnedBootstrap(spec) {
  const bootstrapPin = validateBootstrapPin(
    spec?.producer?.bootstrap,
    "tools/region-import/germany/operational-validator-rebuild-bootstrap.mjs",
    "Rebuild-Bootstrap",
  );
  const entrypointPin = validateBootstrapPin(
    spec?.producer?.entrypoint,
    "tools/region-import/germany/operational-validator-rebuild-evidence-cli.mjs",
    "Rebuild-Entrypoint",
  );
  const entries = [];
  let primaryError;
  let loaded;
  const closeErrors = [];
  try {
    const bootstrap = await openPinnedBootstrapInput(BOOTSTRAP_PATH, bootstrapPin, "Rebuild-Bootstrap");
    entries.push(bootstrap);
    const entrypoint = await openPinnedBootstrapInput(ENTRYPOINT_PATH, entrypointPin, "Rebuild-Entrypoint");
    entries.push(entrypoint);
    await Promise.all([
      assertPinnedBootstrapInput(bootstrap, "Rebuild-Bootstrap"),
      assertPinnedBootstrapInput(entrypoint, "Rebuild-Entrypoint"),
    ]);
    const source = `${bootstrap.bytes.toString("utf8")}\n//# sourceURL=zugfolge-operational-validator-rebuild-bootstrap-bound-${bootstrapPin.sha256}.mjs\n`;
    loaded = await import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}#${bootstrapPin.sha256}`);
    invariant(Object.keys(loaded).join(",") === "loadBoundOperationalValidatorRebuildImplementation",
      "Dynamisch gebundener Rebuild-Bootstrap besitzt unerwartete Exporte.");
    await Promise.all([
      assertPinnedBootstrapInput(bootstrap, "Rebuild-Bootstrap"),
      assertPinnedBootstrapInput(entrypoint, "Rebuild-Entrypoint"),
    ]);
  } catch (error) {
    primaryError = error;
  } finally {
    for (const entry of entries.reverse()) {
      try { await entry.handle.close(); } catch (error) { closeErrors.push(error); }
    }
  }
  if (primaryError && closeErrors.length > 0) throw new AggregateError([primaryError, ...closeErrors], "Vor-import Producer-Bindung und Handle-Close sind fehlgeschlagen.");
  if (primaryError) throw primaryError;
  if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Vor-import Producer-Handles konnten nicht geschlossen werden.");
  return loaded.loadBoundOperationalValidatorRebuildImplementation;
}

function usage() {
  return [
    "Aufruf:",
    "  operational-validator-rebuild-evidence-cli.mjs materialize SPEC.json SOURCE_REPOSITORY OUTPUT.json [WORKSPACE_ROOT]",
    "  operational-validator-rebuild-evidence-cli.mjs recover SPEC.json RECEIPT.json [WORKSPACE_ROOT]",
    "  operational-validator-rebuild-evidence-cli.mjs verify SPEC.json RECEIPT.json [WORKSPACE_ROOT]",
  ].join("\n");
}

async function readSpec(pathInput) {
  const path = resolve(pathInput);
  const bytes = await readFile(path);
  let spec;
  try {
    spec = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Operational-Validator-Rebuild-Spec ist kein gueltiges JSON.", { cause: error });
  }
  return { bytes, path, spec };
}

const [command, ...arguments_] = process.argv.slice(2);
let workspaceRoot;
let specPathInput;
if (command === "materialize") {
  const [specPath, sourceRoot, outputPath, workspaceRootInput = ".", ...extra] = arguments_;
  if (!specPath || !sourceRoot || !outputPath || extra.length > 0) throw new Error(usage());
  specPathInput = specPath;
  workspaceRoot = resolve(workspaceRootInput);
} else if (command === "verify" || command === "recover") {
  const [specPath, receiptPath, workspaceRootInput = ".", ...extra] = arguments_;
  if (!specPath || !receiptPath || extra.length > 0) throw new Error(usage());
  specPathInput = specPath;
  workspaceRoot = resolve(workspaceRootInput);
} else {
  throw new Error(usage());
}

const loaded = await readSpec(specPathInput);
const loadBoundOperationalValidatorRebuildImplementation = await loadExternallyPinnedBootstrap(loaded.spec);
const { implementation, producerProofs } = await loadBoundOperationalValidatorRebuildImplementation({
  bootstrapPath: BOOTSTRAP_PATH,
  entrypointPath: ENTRYPOINT_PATH,
  implementationPath: IMPLEMENTATION_PATH,
  workspaceRoot,
  expectedProducerProofs: loaded.spec?.producer,
});
const {
  materializeOperationalValidatorRebuildEvidence,
  validateOperationalValidatorRebuildSpec,
  verifyOperationalValidatorRebuildEvidence,
} = implementation;
validateOperationalValidatorRebuildSpec(loaded.spec);

if (command === "materialize") {
  const [specPath, sourceRoot, outputPath, workspaceRootInput = ".", ...extra] = arguments_;
  if (!specPath || !sourceRoot || !outputPath || extra.length > 0) throw new Error(usage());
  const result = await materializeOperationalValidatorRebuildEvidence({
    outputPath: resolve(outputPath),
    producerProofs,
    sourceRoot: resolve(sourceRoot),
    spec: loaded.spec,
    specBytes: loaded.bytes,
    specFile: loaded.path,
    workspaceRoot: resolve(workspaceRootInput),
  });
  process.stdout.write(`${JSON.stringify({ archive: result.archive, binary: result.binary, path: result.path, provenance: result.provenance, ...result.proof })}\n`);
} else if (command === "recover") {
  const [specPath, receiptPath, workspaceRootInput = ".", ...extra] = arguments_;
  if (!specPath || !receiptPath || extra.length > 0) throw new Error(usage());
  const result = await materializeOperationalValidatorRebuildEvidence({
    outputPath: resolve(receiptPath),
    producerProofs,
    recoveryOnly: true,
    spec: loaded.spec,
    specBytes: loaded.bytes,
    specFile: loaded.path,
    workspaceRoot: resolve(workspaceRootInput),
  });
  process.stdout.write(`${JSON.stringify({ archive: result.archive, binary: result.binary, path: result.path, provenance: result.provenance, recovery: result.recovery, ...result.proof })}\n`);
} else {
  const [specPath, receiptPath, workspaceRootInput = ".", ...extra] = arguments_;
  if (!specPath || !receiptPath || extra.length > 0) throw new Error(usage());
  const result = await verifyOperationalValidatorRebuildEvidence({
    receiptPath: resolve(receiptPath),
    spec: loaded.spec,
    workspaceRoot: resolve(workspaceRootInput),
  });
  process.stdout.write(`${JSON.stringify({ path: resolve(receiptPath), ...result.proof })}\n`);
}
