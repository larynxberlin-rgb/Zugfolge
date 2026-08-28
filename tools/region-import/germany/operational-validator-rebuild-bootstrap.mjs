import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_PRODUCER_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_FILES = Object.freeze({
  bootstrap: "tools/region-import/germany/operational-validator-rebuild-bootstrap.mjs",
  entrypoint: "tools/region-import/germany/operational-validator-rebuild-evidence-cli.mjs",
  implementation: "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
});
const REQUIRED_EXPORTS = Object.freeze([
  "materializeOperationalValidatorRebuildEvidence",
  "validateOperationalValidatorRebuildSpec",
  "verifyOperationalValidatorRebuildEvidence",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validateExpectedProducerProofs(value) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Externe Producer-Pins fehlen.");
  invariant(Object.keys(value).sort().join(",") === "bootstrap,entrypoint,implementation", "Externe Producer-Pins sind unvollstaendig.");
  for (const id of Object.keys(EXPECTED_FILES)) {
    const proof = value[id];
    invariant(proof !== null && typeof proof === "object" && !Array.isArray(proof), `Producer-Pin ${id} fehlt.`);
    invariant(Object.keys(proof).sort().join(",") === "bytes,file,sha256", `Producer-Pin ${id} besitzt falsche Felder.`);
    invariant(proof.file === EXPECTED_FILES[id], `Producer-Pin ${id} bindet den falschen Pfad.`);
    invariant(Number.isSafeInteger(proof.bytes) && proof.bytes > 0 && proof.bytes <= MAX_PRODUCER_BYTES, `Producer-Pin ${id}.bytes ist ungueltig.`);
    invariant(typeof proof.sha256 === "string" && SHA256.test(proof.sha256), `Producer-Pin ${id}.sha256 ist ungueltig.`);
  }
}

function pathKey(path) {
  const value = resolve(path).replace(/^\\\\\?\\/, "");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedIdentity(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function portablePath(workspaceRootInput, pathInput, label) {
  const workspaceRoot = resolve(workspaceRootInput);
  const path = resolve(pathInput);
  const value = relative(workspaceRoot, path);
  invariant(value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value), `${label} verlaesst workspaceRoot.`);
  return value.split(sep).join("/");
}

async function openBoundFile(workspaceRoot, pathInput, label) {
  const path = resolve(pathInput);
  const file = portablePath(workspaceRoot, path, label);
  const metadata = await lstat(path, { bigint: true });
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${label} muss eine regulaere Datei ohne Symlink sein.`);
  invariant(metadata.size > 0n && metadata.size <= BigInt(MAX_PRODUCER_BYTES), `${label} ist leer oder unerwartet gross.`);
  invariant(pathKey(await realpath(path)) === pathKey(path), `${label} enthaelt einen Symlink-/Junction-Pfad.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && sameIdentity(metadata, before), `${label} wurde vor dem Bootstrap-Lesen ersetzt.`);
    const bytes = Buffer.alloc(Number(before.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    invariant(bytesRead === bytes.length, `${label} wurde nicht vollstaendig gelesen.`);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    invariant(unchangedIdentity(before, after) && unchangedIdentity(after, pathAfter), `${label} driftete waehrend des Bootstrap-Lesens.`);
    return {
      bytes,
      file,
      handle,
      identity: after,
      path,
      proof: {
        bytes: bytes.length,
        file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertStillBound(entry, label) {
  const handleMetadata = await entry.handle.stat({ bigint: true });
  const pathMetadata = await lstat(entry.path, { bigint: true });
  invariant(
    unchangedIdentity(entry.identity, handleMetadata) && unchangedIdentity(handleMetadata, pathMetadata),
    `${label} wurde zwischen Bootstrap-Bindung und dynamischem Import ersetzt oder veraendert.`,
  );
  const bytes = Buffer.alloc(entry.bytes.length);
  const { bytesRead } = await entry.handle.read(bytes, 0, bytes.length, 0);
  invariant(bytesRead === bytes.length && bytes.equals(entry.bytes), `${label} driftete nach der Bootstrap-Bindung.`);
}

export async function loadBoundOperationalValidatorRebuildImplementation({
  bootstrapPath,
  entrypointPath,
  implementationPath,
  workspaceRoot,
  expectedProducerProofs,
  hooks = {},
}) {
  validateExpectedProducerProofs(expectedProducerProofs);
  const entries = {};
  const closeErrors = [];
  let primaryError;
  let result;
  try {
    entries.bootstrap = await openBoundFile(workspaceRoot, bootstrapPath, "Rebuild-Bootstrap");
    entries.entrypoint = await openBoundFile(workspaceRoot, entrypointPath, "Rebuild-Entrypoint");
    entries.implementation = await openBoundFile(workspaceRoot, implementationPath, "Rebuild-Implementierung");
    for (const id of Object.keys(EXPECTED_FILES)) {
      invariant(
        entries[id].proof.bytes === expectedProducerProofs[id].bytes
          && entries[id].proof.file === expectedProducerProofs[id].file
          && entries[id].proof.sha256 === expectedProducerProofs[id].sha256,
        `Tatsaechlich ausgefuehrter Producer ${id} driftet vom externen Spec-Pin.`,
      );
    }
    if (hooks.afterProducerBinding !== undefined) {
      await hooks.afterProducerBinding({
        bootstrap: entries.bootstrap.path,
        entrypoint: entries.entrypoint.path,
        implementation: entries.implementation.path,
      });
    }
    await Promise.all([
      assertStillBound(entries.bootstrap, "Rebuild-Bootstrap"),
      assertStillBound(entries.entrypoint, "Rebuild-Entrypoint"),
      assertStillBound(entries.implementation, "Rebuild-Implementierung"),
    ]);
    const source = `${entries.implementation.bytes.toString("utf8")}\n//# sourceURL=zugfolge-operational-validator-rebuild-evidence-bound-${entries.implementation.proof.sha256}.mjs\n`;
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}#${entries.implementation.proof.sha256}`;
    const implementation = await import(moduleUrl);
    await Promise.all([
      assertStillBound(entries.bootstrap, "Rebuild-Bootstrap"),
      assertStillBound(entries.entrypoint, "Rebuild-Entrypoint"),
      assertStillBound(entries.implementation, "Rebuild-Implementierung"),
    ]);
    invariant(
      Object.keys(implementation).sort().join(",") === [...REQUIRED_EXPORTS].sort().join(","),
      "Dynamisch gebundene Rebuild-Implementierung besitzt unerwartete oder fehlende Exporte.",
    );
    result = {
      implementation,
      producerProofs: {
        bootstrap: entries.bootstrap.proof,
        entrypoint: entries.entrypoint.proof,
        implementation: entries.implementation.proof,
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    for (const entry of Object.values(entries).reverse()) {
      try {
        await entry.handle.close();
      } catch (error) {
        closeErrors.push(error);
      }
    }
  }
  if (primaryError && closeErrors.length > 0) {
    throw new AggregateError([primaryError, ...closeErrors], "Producer-Bindung und Handle-Close sind fehlgeschlagen.");
  }
  if (primaryError) throw primaryError;
  if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Producer-Handles konnten nicht vollstaendig geschlossen werden.");
  return result;
}
