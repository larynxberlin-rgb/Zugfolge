import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
} from "node:fs/promises";
import { basename, delimiter, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const SPEC_SCHEMA = "zugfolge-operational-validator-rebuild-spec/v2";
const EVIDENCE_SCHEMA = "zugfolge-operational-validator-rebuild-evidence/v2";
const PROVENANCE_SCHEMA = "zugfolge-operational-validator-rebuild-provenance/v1";
const PUBLICATION_CLAIM_SCHEMA = "zugfolge-operational-validator-rebuild-publication-claim/v1";
const BUILD_CLAIM_SCHEMA = "zugfolge-operational-validator-rebuild-build-claim/v1";
const PRODUCER_BOOTSTRAP = "tools/region-import/germany/operational-validator-rebuild-bootstrap.mjs";
const PRODUCER_ENTRYPOINT = "tools/region-import/germany/operational-validator-rebuild-evidence-cli.mjs";
const PRODUCER_IMPLEMENTATION = "tools/region-import/germany/operational-validator-rebuild-evidence.mjs";
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024;
const MAX_SPEC_BYTES = 1024 * 1024;
const MAX_PRODUCER_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_COMMIT = /^[a-f0-9]{40}$/;
const PORTABLE_FILE = /^(?![A-Za-z]:)(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;
const RELEASE_ID = /^infra-deutschland-20\d{2}\.[1-9]\d*$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/;
const TARGET = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+$/;
const EXPECTED_BUILD_COMMAND = Object.freeze([
  "cargo",
  "build",
  "--locked",
  "--release",
  "-p",
  "zugfolge-infra",
  "--bin",
  "zugfolge-infra-release",
]);
const EXPECTED_NORMALIZATION_FIELDS = Object.freeze([
  Object.freeze({ name: "coff-time-date-stamp", offset: 136, bytes: 4 }),
  Object.freeze({ name: "optional-header-checksum", offset: 216, bytes: 4 }),
]);
const EXPECTED_SECTIONS = Object.freeze([
  Object.freeze({ name: ".text", rawData: "non-empty" }),
  Object.freeze({ name: ".data", rawData: "non-empty" }),
  Object.freeze({ name: ".rdata", rawData: "non-empty" }),
  Object.freeze({ name: ".pdata", rawData: "non-empty" }),
  Object.freeze({ name: ".xdata", rawData: "non-empty" }),
  Object.freeze({ name: ".bss", rawData: "empty" }),
  Object.freeze({ name: ".idata", rawData: "non-empty" }),
  Object.freeze({ name: ".CRT", rawData: "non-empty" }),
  Object.freeze({ name: ".tls", rawData: "non-empty" }),
  Object.freeze({ name: ".reloc", rawData: "non-empty" }),
]);
const ALLOWED_INHERITED_ENVIRONMENT = Object.freeze([
  "CARGO_HOME", "COMSPEC", "HOME", "HOMEDRIVE", "HOMEPATH", "NUMBER_OF_PROCESSORS", "PATH", "PATHEXT",
  "PROCESSOR_ARCHITECTURE", "RUSTUP_HOME", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "WINDIR",
]);
const CLEARED_BUILD_ENVIRONMENT = Object.freeze([
  "AR", "CARGO_BUILD_RUSTC", "CARGO_BUILD_RUSTC_WRAPPER", "CARGO_BUILD_TARGET", "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_PROFILE_RELEASE_CODEGEN_UNITS", "CARGO_PROFILE_RELEASE_DEBUG", "CARGO_PROFILE_RELEASE_LTO",
  "CARGO_PROFILE_RELEASE_OPT_LEVEL", "CARGO_PROFILE_RELEASE_PANIC", "CARGO_TARGET_DIR", "CC", "CFLAGS", "CXX",
  "CXXFLAGS", "LDFLAGS", "RUSTC", "RUSTC_BOOTSTRAP", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER",
  "RUSTDOCFLAGS", "RUSTFLAGS", "RUSTUP_TOOLCHAIN", "SOURCE_DATE_EPOCH",
]);
const FIXED_BUILD_ENVIRONMENT = Object.freeze({ CARGO_INCREMENTAL: "0", CARGO_NET_OFFLINE: "true", CARGO_TERM_COLOR: "never" });

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  invariant(Object.keys(value).sort().join(",") === [...keys].sort().join(","), `${label} besitzt unerwartete oder fehlende Felder.`);
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function sameCanonicalValue(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validatePortableFile(value, label) {
  invariant(typeof value === "string" && PORTABLE_FILE.test(value), `${label} muss ein sicherer relativer POSIX-Dateipfad sein.`);
  return value;
}

function validateSha256(value, label) {
  invariant(typeof value === "string" && SHA256.test(value), `${label} muss ein kleingeschriebener SHA-256 sein.`);
  return value;
}

function validatePositiveBytes(value, label, maximum = MAX_BINARY_BYTES) {
  invariant(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} muss eine positive Bytezahl bis ${maximum} sein.`);
  return value;
}

function validateProof(value, label, maximum = MAX_BINARY_BYTES, { file = false } = {}) {
  exactKeys(value, file ? ["bytes", "file", "sha256"] : ["bytes", "sha256"], label);
  if (file) validatePortableFile(value.file, `${label}.file`);
  validatePositiveBytes(value.bytes, `${label}.bytes`, maximum);
  validateSha256(value.sha256, `${label}.sha256`);
  return value;
}

function validateStringArray(value, expected, label) {
  invariant(Array.isArray(value) && value.length === expected.length, `${label} besitzt die falsche Laenge.`);
  invariant(value.every((entry, index) => entry === expected[index]), `${label} driftet vom festgelegten Wert.`);
  return value;
}

function validateRustcIdentity(value, label = "toolchain.rustc") {
  exactKeys(value, ["commitHash", "host", "llvmVersion", "release"], label);
  invariant(typeof value.release === "string" && VERSION.test(value.release), `${label}.release ist ungueltig.`);
  invariant(typeof value.commitHash === "string" && GIT_COMMIT.test(value.commitHash), `${label}.commitHash ist ungueltig.`);
  invariant(typeof value.host === "string" && TARGET.test(value.host), `${label}.host ist ungueltig.`);
  invariant(typeof value.llvmVersion === "string" && VERSION.test(value.llvmVersion), `${label}.llvmVersion ist ungueltig.`);
  return value;
}

function validateCargoIdentity(value, label = "toolchain.cargo") {
  exactKeys(value, ["commitHash", "host", "release"], label);
  invariant(typeof value.release === "string" && VERSION.test(value.release), `${label}.release ist ungueltig.`);
  invariant(typeof value.commitHash === "string" && GIT_COMMIT.test(value.commitHash), `${label}.commitHash ist ungueltig.`);
  invariant(typeof value.host === "string" && TARGET.test(value.host), `${label}.host ist ungueltig.`);
  return value;
}

export function validateOperationalValidatorRebuildSpec(spec) {
  exactKeys(spec, ["binaries", "build", "pe", "producer", "provenance", "releaseId", "schema", "source", "toolchain"], "Operational-Validator-Rebuild-Spec");
  invariant(spec.schema === SPEC_SCHEMA, "Operational-Validator-Rebuild-Spec besitzt ein unbekanntes Schema.");
  invariant(typeof spec.releaseId === "string" && RELEASE_ID.test(spec.releaseId), "Operational-Validator-Rebuild-Spec.releaseId ist ungueltig.");
  exactKeys(spec.source, ["archive", "cargoLock", "commit"], "source");
  exactKeys(spec.source.archive, ["bytes", "file", "format", "sha256"], "source.archive");
  invariant(spec.source.archive.format === "tar", "source.archive.format muss tar sein.");
  validatePortableFile(spec.source.archive.file, "source.archive.file");
  validatePositiveBytes(spec.source.archive.bytes, "source.archive.bytes", MAX_ARCHIVE_BYTES);
  validateSha256(spec.source.archive.sha256, "source.archive.sha256");
  invariant(typeof spec.source.commit === "string" && GIT_COMMIT.test(spec.source.commit), "source.commit ist ungueltig.");
  validateProof(spec.source.cargoLock, "source.cargoLock", MAX_SPEC_BYTES, { file: true });
  exactKeys(spec.build, ["command", "environmentPolicy", "profile", "targetOutputFile"], "build");
  validateStringArray(spec.build.command, EXPECTED_BUILD_COMMAND, "build.command");
  invariant(spec.build.profile === "release", "build.profile muss release sein.");
  invariant(spec.build.targetOutputFile === "release/zugfolge-infra-release.exe", "build.targetOutputFile driftet vom externen Cargo-Release-Output.");
  exactKeys(spec.build.environmentPolicy, ["allowedInherited", "cleared", "fixed", "targetDirectory"], "build.environmentPolicy");
  validateStringArray(spec.build.environmentPolicy.allowedInherited, ALLOWED_INHERITED_ENVIRONMENT, "build.environmentPolicy.allowedInherited");
  validateStringArray(spec.build.environmentPolicy.cleared, CLEARED_BUILD_ENVIRONMENT, "build.environmentPolicy.cleared");
  invariant(sameCanonicalValue(spec.build.environmentPolicy.fixed, FIXED_BUILD_ENVIRONMENT), "build.environmentPolicy.fixed driftet vom Offline-Buildvertrag.");
  invariant(spec.build.environmentPolicy.targetDirectory === "external-empty-create-new", "build.environmentPolicy.targetDirectory ist ungueltig.");
  exactKeys(spec.toolchain, ["cargo", "rustc"], "toolchain");
  validateCargoIdentity(spec.toolchain.cargo);
  validateRustcIdentity(spec.toolchain.rustc);
  exactKeys(spec.binaries, ["preserved", "rebuilt"], "binaries");
  validateProof(spec.binaries.preserved, "binaries.preserved", MAX_BINARY_BYTES, { file: true });
  exactKeys(spec.binaries.rebuilt, ["expectedBytes", "file"], "binaries.rebuilt");
  validatePortableFile(spec.binaries.rebuilt.file, "binaries.rebuilt.file");
  validatePositiveBytes(spec.binaries.rebuilt.expectedBytes, "binaries.rebuilt.expectedBytes");
  invariant(spec.binaries.preserved.bytes === spec.binaries.rebuilt.expectedBytes, "Preserved und official rebuild muessen dieselbe Bytezahl besitzen.");
  invariant(spec.binaries.preserved.file !== spec.binaries.rebuilt.file, "Preserved und official rebuild muessen getrennte Pfade besitzen.");
  exactKeys(spec.pe, ["allowedNormalizationFields", "format", "machine", "maxBinaryBytes", "normalizedSha256", "sections"], "pe");
  invariant(spec.pe.format === "PE32+" && spec.pe.machine === 0x8664, "pe muss AMD64 PE32+ sein.");
  invariant(spec.pe.maxBinaryBytes === MAX_BINARY_BYTES, `pe.maxBinaryBytes muss ${MAX_BINARY_BYTES} sein.`);
  validateSha256(spec.pe.normalizedSha256, "pe.normalizedSha256");
  invariant(sameCanonicalValue(spec.pe.allowedNormalizationFields, EXPECTED_NORMALIZATION_FIELDS), "pe.allowedNormalizationFields muss exakt die PE-Felder bei 136/216 umfassen.");
  invariant(sameCanonicalValue(spec.pe.sections, EXPECTED_SECTIONS), "pe.sections muss die zehn festgelegten Sections enthalten.");
  exactKeys(spec.producer, ["bootstrap", "entrypoint", "implementation"], "producer");
  for (const [id, file] of [["bootstrap", PRODUCER_BOOTSTRAP], ["entrypoint", PRODUCER_ENTRYPOINT], ["implementation", PRODUCER_IMPLEMENTATION]]) {
    validateProof(spec.producer[id], `producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(spec.producer[id].file === file, `producer.${id}.file driftet.`);
  }
  exactKeys(spec.provenance, ["file"], "provenance");
  validatePortableFile(spec.provenance.file, "provenance.file");
  const outputFiles = [spec.binaries.preserved.file, spec.binaries.rebuilt.file, spec.source.archive.file, spec.provenance.file];
  invariant(new Set(outputFiles).size === outputFiles.length, "Binary-, Archiv- und Provenienzpfade muessen getrennt sein.");
  return spec;
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

function sameIdentitySizeMtime(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function filesystemIdentity(metadata) {
  return { dev: metadata.dev.toString(), ino: metadata.ino.toString() };
}

function validateFilesystemIdentity(value, label) {
  exactKeys(value, ["dev", "ino"], label);
  invariant(typeof value.dev === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value.dev), `${label}.dev ist ungueltig.`);
  invariant(typeof value.ino === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value.ino), `${label}.ino ist ungueltig.`);
  return value;
}

function matchesFilesystemIdentity(metadata, value) {
  return metadata.dev.toString() === value.dev && metadata.ino.toString() === value.ino;
}

function isContained(rootInput, targetInput, { allowRoot = false } = {}) {
  const value = relative(resolve(rootInput), resolve(targetInput));
  return (allowRoot && value === "") || (value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function regularDirectorySnapshot(pathInput, label) {
  const path = resolve(pathInput);
  const metadata = await lstat(path, { bigint: true });
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${label} muss ein regulaeres Verzeichnis ohne Symlink/Junction sein.`);
  invariant(pathKey(await realpath(path)) === pathKey(path), `${label} enthaelt einen Symlink-/Junction-Pfad.`);
  return { path, metadata };
}

async function assertDirectoryIdentity(path, expected, label) {
  const actual = await lstat(path, { bigint: true });
  invariant(actual.isDirectory() && !actual.isSymbolicLink() && sameIdentity(actual, expected), `${label} wurde fremd ersetzt.`);
}

async function assertRegularDirectorySnapshot(snapshot, label) {
  const actual = await lstat(snapshot.path, { bigint: true });
  invariant(
    actual.isDirectory()
      && !actual.isSymbolicLink()
      && sameIdentity(actual, snapshot.metadata)
      && pathKey(await realpath(snapshot.path)) === pathKey(snapshot.path),
    `${label} wurde fremd ersetzt oder ueber einen Symlink/Junction umgebunden.`,
  );
}

async function assertNoSymlinkPath(rootInput, targetInput, label, { leafMayBeMissing = false } = {}) {
  const root = resolve(rootInput);
  const target = resolve(targetInput);
  invariant(isContained(root, target, { allowRoot: true }), `${label} verlaesst seine Wurzel.`);
  const parts = relative(root, target).split(sep).filter(Boolean);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = resolve(cursor, parts[index]);
    let metadata;
    try {
      metadata = await lstat(cursor, { bigint: true });
    } catch (error) {
      if (leafMayBeMissing && index === parts.length - 1 && error?.code === "ENOENT") return;
      throw error;
    }
    invariant(!metadata.isSymbolicLink(), `${label} enthaelt einen Symlink/Junction: ${cursor}`);
    if (index < parts.length - 1) invariant(metadata.isDirectory(), `${label} besitzt einen ungueltigen Elternpfad.`);
  }
}

function resolveWorkspaceFile(workspaceRoot, portableFile, label) {
  validatePortableFile(portableFile, label);
  const value = resolve(workspaceRoot, ...portableFile.split("/"));
  invariant(isContained(workspaceRoot, value), `${label} verlaesst workspaceRoot.`);
  return value;
}

async function regularFileSnapshot(root, pathInput, label, maximumBytes, { allowEmpty = false } = {}) {
  const path = resolve(pathInput);
  await assertNoSymlinkPath(root, path, label);
  const pathBefore = await lstat(path, { bigint: true });
  invariant(pathBefore.isFile() && !pathBefore.isSymbolicLink(), `${label} muss eine regulaere Datei sein.`);
  invariant((allowEmpty ? pathBefore.size >= 0n : pathBefore.size > 0n) && pathBefore.size <= BigInt(maximumBytes), `${label} ist leer oder ueberschreitet ${maximumBytes} Bytes.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat({ bigint: true });
    invariant(before.isFile() && sameIdentity(pathBefore, before), `${label} wurde vor dem Lesen ersetzt.`);
    const bytes = Buffer.alloc(Number(before.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    invariant(bytesRead === bytes.length, `${label} wurde nicht vollstaendig gelesen.`);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    invariant(unchangedIdentity(before, after) && unchangedIdentity(after, pathAfter), `${label} wurde waehrend des Lesens veraendert.`);
    return { bytes, identity: after, path, proof: { bytes: bytes.length, sha256: sha256(bytes) } };
  } finally {
    await handle.close();
  }
}

function proofMatches(actual, expected, label) {
  invariant(
    actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
    `${label} driftet von seiner Byte-/SHA-256-Bindung (actual ${actual.bytes}/${actual.sha256}, expected ${expected.bytes}/${expected.sha256}).`,
  );
}

async function assertCreateNewTarget(pathInput, label) {
  const path = resolve(pathInput);
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return path;
    throw error;
  }
  const error = new Error(`${label} existiert bereits und darf nicht ersetzt werden: ${path}`);
  error.code = "EEXIST";
  throw error;
}

async function createOwnedTemporaryDirectory(parentInput, prefix, label) {
  const parent = resolve(parentInput);
  const parentSnapshot = await regularDirectorySnapshot(parent, `${label}-Elternverzeichnis`);
  let path;
  try {
    path = await mkdtemp(resolve(parent, prefix));
    const snapshot = await regularDirectorySnapshot(path, label);
    await assertDirectoryIdentity(parent, parentSnapshot.metadata, `${label}-Elternverzeichnis`);
    return snapshot;
  } catch (primaryError) {
    if (path === undefined) throw primaryError;
    let recoveryError;
    try { await rmdir(path); } catch (error) { if (error?.code !== "ENOENT") recoveryError = error; }
    if (!recoveryError) throw primaryError;
    throw new AggregateError([primaryError, recoveryError], `${label} konnte nach unvollstaendiger Erstellung nicht recovered werden: ${path}`);
  }
}

function processEnvironmentValue(name) {
  if (Object.hasOwn(process.env, name)) return process.env[name];
  const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : process.env[key];
}

function defaultHome(subdirectory) {
  const base = processEnvironmentValue("USERPROFILE") ?? processEnvironmentValue("HOME");
  invariant(typeof base === "string" && base.length > 0, `Kein Home-Pfad fuer ${subdirectory} verfuegbar.`);
  return resolve(base, subdirectory);
}

function controlledEnvironment(targetDirectory, spec) {
  const environment = {};
  const inherited = [];
  for (const name of spec.build.environmentPolicy.allowedInherited) {
    let value = processEnvironmentValue(name);
    if (name === "CARGO_HOME" && !value) value = defaultHome(".cargo");
    if (name === "RUSTUP_HOME" && !value) value = defaultHome(".rustup");
    if (!value) {
      inherited.push({ name, present: false });
      continue;
    }
    environment[name] = value;
    const bytes = Buffer.from(value, "utf8");
    inherited.push({ bytes: bytes.length, name, present: true, sha256: sha256(bytes) });
  }
  invariant(typeof environment.PATH === "string" && environment.PATH.length > 0, "Kontrollierte Build-Umgebung besitzt keinen PATH.");
  Object.assign(environment, spec.build.environmentPolicy.fixed);
  environment.CARGO_TARGET_DIR = resolve(targetDirectory);
  return {
    environment,
    receipt: { allowedInherited: inherited, cleared: spec.build.environmentPolicy.cleared, fixed: { ...spec.build.environmentPolicy.fixed }, targetDirectory: spec.build.environmentPolicy.targetDirectory },
  };
}

async function assertMissingPath(pathInput, label) {
  try {
    await lstat(pathInput);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} ist als nicht archivgebundener Cargo-Input verboten.`);
}

async function auditExternalCargoConfiguration(sourceDirectory, environment) {
  const candidates = [];
  let ancestor = dirname(resolve(sourceDirectory));
  for (;;) {
    candidates.push(resolve(ancestor, ".cargo", "config"), resolve(ancestor, ".cargo", "config.toml"));
    const parent = dirname(ancestor);
    if (pathKey(parent) === pathKey(ancestor)) break;
    ancestor = parent;
  }
  candidates.push(resolve(environment.CARGO_HOME, "config"), resolve(environment.CARGO_HOME, "config.toml"));
  const unique = [...new Map(candidates.map((path) => [pathKey(path), path])).values()];
  for (const path of unique) await assertMissingPath(path, `Externe Cargo-Konfiguration ${path}`);
  const pathHashes = unique.map((path) => sha256(Buffer.from(pathKey(path), "utf8"))).sort();
  return {
    candidateCount: pathHashes.length,
    candidatePathSetSha256: sha256(canonicalBytes(pathHashes)),
    policy: "tracked-source-config-only",
  };
}

function commandExtensions(command) {
  if (process.platform !== "win32" || extname(command) !== "") return [""];
  return (processEnvironmentValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((value) => value.toLowerCase());
}

async function resolveCommand(command, pathValue, label) {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of commandExtensions(command)) {
      const candidate = resolve(directory.replace(/^"|"$/g, ""), `${command}${extension}`);
      try {
        const metadata = await lstat(candidate, { bigint: true });
        if (metadata.isFile() && !metadata.isSymbolicLink()) return candidate;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  throw new Error(`${label} wurde im kontrollierten PATH nicht gefunden.`);
}

function runProcess(executable, arguments_, { cwd, env, label, allowedExitCodes = [0] }) {
  return new Promise((resolveResult, reject) => {
    execFile(executable, arguments_, { cwd, encoding: "buffer", env, maxBuffer: MAX_PROCESS_OUTPUT_BYTES, windowsHide: true }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : 0;
      const result = { code, stderr: Buffer.from(stderr ?? []), stdout: Buffer.from(stdout ?? []) };
      if (error && typeof error.code !== "number") return reject(new Error(`${label} konnte nicht ausgefuehrt werden.`, { cause: error }));
      if (!allowedExitCodes.includes(code)) {
        const tail = result.stderr.toString("utf8").slice(-4096).trim();
        const failure = new Error(`${label} endete mit ${code}${tail ? `: ${tail}` : ""}`);
        failure.result = result;
        return reject(failure);
      }
      resolveResult(result);
    });
  });
}

async function runProcessWithInputFile(executable, arguments_, inputPath, { cwd, env, label }) {
  const handle = await open(inputPath, "r");
  let primaryError;
  let result;
  try {
    result = await new Promise((resolveResult, reject) => {
    const child = spawn(executable, arguments_, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const input = handle.createReadStream({ autoClose: false });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      input.destroy();
      child.stdin.destroy();
      child.kill();
      reject(error);
    };
    input.on("error", (error) => fail(new Error(`${label}-Eingabe konnte nicht gelesen werden.`, { cause: error })));
    child.stdin.on("error", (error) => {
      if (error?.code === "EPIPE") {
        input.destroy();
        return;
      }
      fail(new Error(`${label}-stdin ist fehlgeschlagen.`, { cause: error }));
    });
    child.on("error", (error) => fail(new Error(`${label} konnte nicht ausgefuehrt werden.`, { cause: error })));
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on("data", (chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) fail(new Error(`${label}-Ausgabe ist unerwartet gross.`));
        else chunks.push(chunk);
      });
    }
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) reject(new Error(`${label} endete mit ${code}${errorText ? `: ${errorText}` : ""}`));
      else resolveResult({ code, stderr: Buffer.concat(stderr), stdout: Buffer.concat(stdout) });
    });
    input.pipe(child.stdin);
    });
  } catch (error) {
    primaryError = error;
  }
  let closeError;
  try { await handle.close(); } catch (error) { closeError = error; }
  if (primaryError && closeError) throw new AggregateError([primaryError, closeError], `${label} und Input-Handle-Close sind fehlgeschlagen.`);
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
  return result;
}

function encodedOutput(bytes) {
  return { base64: bytes.toString("base64"), bytes: bytes.length, sha256: sha256(bytes) };
}

function validateEncodedOutput(value, label) {
  exactKeys(value, ["base64", "bytes", "sha256"], label);
  invariant(typeof value.base64 === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value.base64), `${label}.base64 ist ungueltig.`);
  invariant(Number.isSafeInteger(value.bytes) && value.bytes >= 0 && value.bytes <= MAX_PROCESS_OUTPUT_BYTES, `${label}.bytes ist ungueltig.`);
  validateSha256(value.sha256, `${label}.sha256`);
  const bytes = Buffer.from(value.base64, "base64");
  invariant(bytes.length === value.bytes && sha256(bytes) === value.sha256, `${label} besitzt keine konsistente Bindung.`);
}

function parseKeyedVerboseVersion(stdout, label) {
  const lines = stdout.toString("utf8").replace(/\r\n/g, "\n").trim().split("\n");
  invariant(lines.length >= 2, `${label} -vV ist unvollstaendig.`);
  const values = new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { firstLine: lines[0], values };
}

async function bindExecutable(workspaceRoot, executable, command) {
  const canonical = await realpath(executable);
  const root = isContained(workspaceRoot, canonical) ? workspaceRoot : dirname(canonical);
  const source = await regularFileSnapshot(root, canonical, `${command}-Executable`, MAX_TOOL_BYTES);
  return {
    identity: source.identity,
    path: canonical,
    proof: source.proof,
    receipt: { bytes: source.proof.bytes, command, pathSha256: sha256(Buffer.from(pathKey(canonical), "utf8")), sha256: source.proof.sha256 },
    root,
  };
}

async function assertExecutableStillBound(binding, command) {
  const source = await regularFileSnapshot(binding.root, binding.path, `${command}-Executable-Recheck`, MAX_TOOL_BYTES);
  invariant(sameIdentity(source.identity, binding.identity), `${command}-Executable wurde nach der Bindung ersetzt.`);
  proofMatches(source.proof, binding.proof, `${command}-Executable`);
}

async function assertExecutableSetStillBound(bindings) {
  await Promise.all(Object.entries(bindings).map(([command, binding]) => assertExecutableStillBound(binding, command)));
}

async function inspectToolchain({ sourceDirectory, environment, executableBindings, spec }) {
  await assertExecutableSetStillBound(executableBindings);
  const [rustcResult, cargoResult, gitResult, tarResult] = await Promise.all([
    runProcess(executableBindings.rustc.path, ["-vV"], { cwd: sourceDirectory, env: environment, label: "rustc -vV" }),
    runProcess(executableBindings.cargo.path, ["-vV"], { cwd: sourceDirectory, env: environment, label: "cargo -vV" }),
    runProcess(executableBindings.git.path, ["--version"], { cwd: sourceDirectory, env: environment, label: "git --version" }),
    runProcess(executableBindings.tar.path, ["--version"], { cwd: sourceDirectory, env: environment, label: "tar --version" }),
  ]);
  await assertExecutableSetStillBound(executableBindings);
  const rustcVerbose = parseKeyedVerboseVersion(rustcResult.stdout, "rustc");
  const cargoVerbose = parseKeyedVerboseVersion(cargoResult.stdout, "cargo");
  const rustcIdentity = { commitHash: rustcVerbose.values.get("commit-hash"), host: rustcVerbose.values.get("host"), llvmVersion: rustcVerbose.values.get("LLVM version"), release: rustcVerbose.values.get("release") };
  const cargoIdentity = { commitHash: cargoVerbose.values.get("commit-hash"), host: cargoVerbose.values.get("host"), release: cargoVerbose.values.get("release") };
  invariant(rustcVerbose.firstLine.startsWith(`rustc ${rustcIdentity.release} (${String(rustcIdentity.commitHash).slice(0, 9)} `), "rustc -vV besitzt eine inkonsistente Kopfzeile.");
  invariant(cargoVerbose.firstLine.startsWith(`cargo ${cargoIdentity.release} (${String(cargoIdentity.commitHash).slice(0, 9)} `), "cargo -vV besitzt eine inkonsistente Kopfzeile.");
  invariant(sameCanonicalValue(rustcIdentity, spec.toolchain.rustc), "rustc-Toolchain driftet von der Rebuild-Spec.");
  invariant(sameCanonicalValue(cargoIdentity, spec.toolchain.cargo), "cargo-Toolchain driftet von der Rebuild-Spec.");
  return {
    cargo: { command: ["cargo", "-vV"], executable: executableBindings.cargo.receipt, identity: cargoIdentity, output: encodedOutput(cargoResult.stdout) },
    git: { command: ["git", "--version"], executable: executableBindings.git.receipt, output: encodedOutput(gitResult.stdout) },
    rustc: { command: ["rustc", "-vV"], executable: executableBindings.rustc.receipt, identity: rustcIdentity, output: encodedOutput(rustcResult.stdout) },
    tar: { command: ["tar", "--version"], executable: executableBindings.tar.receipt, output: encodedOutput(tarResult.stdout) },
  };
}

function readUInt16(buffer, offset, label) {
  invariant(Number.isSafeInteger(offset) && offset >= 0 && offset + 2 <= buffer.length, `${label} liegt ausserhalb der PE-Datei.`);
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset, label) {
  invariant(Number.isSafeInteger(offset) && offset >= 0 && offset + 4 <= buffer.length, `${label} liegt ausserhalb der PE-Datei.`);
  return buffer.readUInt32LE(offset);
}

function parseSectionName(buffer, offset) {
  const raw = buffer.subarray(offset, offset + 8);
  const zero = raw.indexOf(0);
  const name = (zero === -1 ? raw : raw.subarray(0, zero)).toString("ascii");
  invariant(name.length > 0 && /^[.A-Za-z0-9_$]+$/.test(name), "PE enthaelt einen ungueltigen Section-Namen.");
  return name;
}

function inspectPe(buffer, label, expectedMachine) {
  invariant(buffer.length >= 512 && buffer.subarray(0, 2).equals(Buffer.from("MZ", "ascii")), `${label} ist kein MZ/PE-Binary.`);
  const peOffset = readUInt32(buffer, 0x3c, `${label}.peOffset`);
  invariant(peOffset >= 0x40 && peOffset + 24 <= buffer.length && buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0, 0])), `${label} besitzt keinen gueltigen PE-Header.`);
  const coffOffset = peOffset + 4;
  const machine = readUInt16(buffer, coffOffset, `${label}.machine`);
  const numberOfSections = readUInt16(buffer, coffOffset + 2, `${label}.numberOfSections`);
  const timeDateStampOffset = coffOffset + 4;
  const sizeOfOptionalHeader = readUInt16(buffer, coffOffset + 16, `${label}.sizeOfOptionalHeader`);
  const optionalHeaderOffset = coffOffset + 20;
  const optionalHeaderMagic = readUInt16(buffer, optionalHeaderOffset, `${label}.optionalHeaderMagic`);
  const checkSumOffset = optionalHeaderOffset + 64;
  invariant(machine === expectedMachine && optionalHeaderMagic === 0x20b && sizeOfOptionalHeader >= 68, `${label} ist nicht das erwartete AMD64 PE32+.`);
  invariant(numberOfSections > 0 && numberOfSections <= 96, `${label} besitzt eine unplausible Section-Anzahl.`);
  const sectionTableOffset = optionalHeaderOffset + sizeOfOptionalHeader;
  invariant(sectionTableOffset + numberOfSections * 40 <= buffer.length, `${label}.Section-Tabelle liegt ausserhalb der Datei.`);
  const sections = [];
  for (let index = 0; index < numberOfSections; index += 1) {
    const offset = sectionTableOffset + index * 40;
    const name = parseSectionName(buffer, offset);
    const virtualSize = readUInt32(buffer, offset + 8, `${label}.${name}.virtualSize`);
    const virtualAddress = readUInt32(buffer, offset + 12, `${label}.${name}.virtualAddress`);
    const rawDataBytes = readUInt32(buffer, offset + 16, `${label}.${name}.rawDataBytes`);
    const rawDataPointer = readUInt32(buffer, offset + 20, `${label}.${name}.rawDataPointer`);
    invariant(rawDataBytes === 0 || (rawDataPointer > 0 && rawDataPointer + rawDataBytes <= buffer.length), `${label}.${name} besitzt einen ungueltigen Raw-Bereich.`);
    const raw = rawDataBytes === 0 ? Buffer.alloc(0) : buffer.subarray(rawDataPointer, rawDataPointer + rawDataBytes);
    sections.push({ index, name, rawDataBytes, rawDataPointer, rawSha256: sha256(raw), virtualAddress, virtualSize });
  }
  invariant(new Set(sections.map(({ name }) => name)).size === sections.length, `${label} besitzt doppelte Section-Namen.`);
  return {
    header: {
      coffTimeDateStamp: { offset: timeDateStampOffset, value: readUInt32(buffer, timeDateStampOffset, `${label}.coffTimeDateStamp`) },
      dosSignature: "MZ", machine, numberOfSections,
      optionalHeaderCheckSum: { offset: checkSumOffset, value: readUInt32(buffer, checkSumOffset, `${label}.optionalHeaderCheckSum`) },
      optionalHeaderMagic, peOffset, peSignature: "PE\\0\\0", sectionTableOffset, sizeOfOptionalHeader,
    },
    sections,
  };
}

function inspectPePair(preservedBytes, rebuiltBytes, spec) {
  invariant(preservedBytes.length === rebuiltBytes.length, "Preserved und official rebuilt Validator besitzen verschiedene Dateilaengen.");
  const preserved = inspectPe(preservedBytes, "Preserved Validator", spec.pe.machine);
  const rebuilt = inspectPe(rebuiltBytes, "Official Rebuilt Validator", spec.pe.machine);
  invariant(preserved.header.coffTimeDateStamp.offset === 136 && rebuilt.header.coffTimeDateStamp.offset === 136, "COFF TimeDateStamp liegt nicht bei Offset 136.");
  invariant(preserved.header.optionalHeaderCheckSum.offset === 216 && rebuilt.header.optionalHeaderCheckSum.offset === 216, "OptionalHeader CheckSum liegt nicht bei Offset 216.");
  invariant(preserved.sections.length === EXPECTED_SECTIONS.length && rebuilt.sections.length === EXPECTED_SECTIONS.length, "PE besitzt nicht exakt zehn erwartete Sections.");
  const sections = preserved.sections.map((left, index) => {
    const right = rebuilt.sections[index];
    const expected = EXPECTED_SECTIONS[index];
    invariant(left.name === expected.name && right.name === expected.name, `PE-Section ${index} driftet in Name oder Reihenfolge.`);
    invariant(left.rawDataBytes === right.rawDataBytes && left.virtualSize === right.virtualSize, `PE-Section ${left.name} driftet in Groesse.`);
    invariant(left.rawSha256 === right.rawSha256, `PE-Section ${left.name} besitzt verschiedene Raw-SHA-256.`);
    invariant(expected.rawData === "empty" ? left.rawDataBytes === 0 : left.rawDataBytes > 0, `PE-Section ${left.name} verletzt ihren Raw-Datenvertrag.`);
    return { index, name: left.name, preservedRawSha256: left.rawSha256, rawDataBytes: left.rawDataBytes, rawDataPointer: left.rawDataPointer, rebuiltRawSha256: right.rawSha256, virtualAddress: left.virtualAddress, virtualSize: left.virtualSize };
  });
  const allowed = new Set(EXPECTED_NORMALIZATION_FIELDS.flatMap((field) => Array.from({ length: field.bytes }, (_, index) => field.offset + index)));
  const differingOffsets = [];
  for (let offset = 0; offset < preservedBytes.length; offset += 1) {
    if (preservedBytes[offset] === rebuiltBytes[offset]) continue;
    invariant(allowed.has(offset), `Validator-Binaries unterscheiden sich am nicht erlaubten Offset ${offset}.`);
    differingOffsets.push(offset);
  }
  const normalizedPreserved = Buffer.from(preservedBytes);
  const normalizedRebuilt = Buffer.from(rebuiltBytes);
  for (const field of EXPECTED_NORMALIZATION_FIELDS) {
    normalizedPreserved.fill(0, field.offset, field.offset + field.bytes);
    normalizedRebuilt.fill(0, field.offset, field.offset + field.bytes);
  }
  invariant(normalizedPreserved.equals(normalizedRebuilt), "Validator-Binaries sind ausserhalb der PE-Normalisierungsfelder nicht bytegleich.");
  const preservedNormalizedSha256 = sha256(normalizedPreserved);
  const rebuiltNormalizedSha256 = sha256(normalizedRebuilt);
  invariant(preservedNormalizedSha256 === spec.pe.normalizedSha256 && rebuiltNormalizedSha256 === spec.pe.normalizedSha256, "Normalisierter Validator-SHA-256 driftet von der Spec.");
  return { allowedNormalizationFields: EXPECTED_NORMALIZATION_FIELDS, differingOffsets, headers: { preserved: preserved.header, rebuilt: rebuilt.header }, normalized: { expectedSha256: spec.pe.normalizedSha256, preservedSha256: preservedNormalizedSha256, rebuiltSha256: rebuiltNormalizedSha256 }, sections };
}

async function auditExtractedTree(rootInput) {
  const root = resolve(rootInput);
  const manifest = [];
  async function visit(directory, prefix) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const portable = prefix ? `${prefix}/${entry.name}` : entry.name;
      invariant(PORTABLE_FILE.test(portable), `Git-Archiv enthaelt einen unzulaessigen Pfad: ${portable}`);
      const metadata = await lstat(path, { bigint: true });
      invariant(!metadata.isSymbolicLink(), `Git-Archiv enthaelt einen Symlink: ${portable}`);
      if (metadata.isDirectory()) await visit(path, portable);
      else {
        invariant(metadata.isFile() && metadata.size <= BigInt(MAX_SOURCE_FILE_BYTES), `Git-Archivdatei ${portable} ist unzulaessig.`);
        const source = await regularFileSnapshot(root, path, `Archivdatei ${portable}`, MAX_SOURCE_FILE_BYTES, { allowEmpty: true });
        manifest.push({ bytes: source.proof.bytes, file: portable, sha256: source.proof.sha256 });
      }
    }
  }
  await visit(root, "");
  invariant(manifest.length > 0 && manifest.length <= 100_000, "Extrahierter Git-Tree besitzt eine unplausible Dateianzahl.");
  manifest.sort((left, right) => left.file.localeCompare(right.file, "en"));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  invariant(Number.isSafeInteger(totalBytes), "Extrahierter Git-Tree ist zu gross.");
  return { fileCount: manifest.length, manifestSha256: sha256(canonicalBytes(manifest)), totalBytes };
}

function tarText(bytes, offset, length) {
  const field = bytes.subarray(offset, offset + length);
  const zero = field.indexOf(0);
  return (zero < 0 ? field : field.subarray(0, zero)).toString("utf8").trim();
}

function tarOctal(bytes, offset, length, label) {
  const text = tarText(bytes, offset, length).replace(/^\s+|\s+$/g, "");
  invariant(/^[0-7]+$/.test(text), `${label} ist kein kanonisches Oktalfeld.`);
  const value = Number.parseInt(text, 8);
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} ist ausserhalb des sicheren Zahlenbereichs.`);
  return value;
}

function parsePaxRecords(bytes, label) {
  const records = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    invariant(space > offset, `${label} besitzt einen ungueltigen Record-Laengenprefix.`);
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    invariant(/^[1-9][0-9]*$/.test(lengthText), `${label} besitzt eine ungueltige Record-Laenge.`);
    const length = Number(lengthText);
    invariant(Number.isSafeInteger(length) && length > space - offset + 3 && offset + length <= bytes.length, `${label} Record liegt ausserhalb des PAX-Headers.`);
    const record = bytes.subarray(space + 1, offset + length);
    invariant(record.at(-1) === 0x0a, `${label} Record endet nicht mit LF.`);
    const payload = record.subarray(0, -1).toString("utf8");
    const equals = payload.indexOf("=");
    invariant(equals > 0, `${label} Record besitzt kein Schluessel/Wert-Paar.`);
    const key = payload.slice(0, equals);
    invariant(!Object.hasOwn(records, key), `${label} besitzt einen doppelten PAX-Schluessel ${key}.`);
    records[key] = payload.slice(equals + 1);
    offset += length;
  }
  invariant(offset === bytes.length, `${label} besitzt nach dem letzten Record Restbytes.`);
  return records;
}

function auditPinnedSourceArchive(bytes, spec) {
  invariant(bytes.length === spec.source.archive.bytes && sha256(bytes) === spec.source.archive.sha256, "Persistiertes Commit-Archiv driftet vom Spec-Pin.");
  const manifest = [];
  const seen = new Set();
  let globalPax = {};
  let localPax;
  let offset = 0;
  let sawEnd = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      invariant(bytes.subarray(offset).every((byte) => byte === 0), "Commit-TAR besitzt Nicht-Null-Restdaten hinter dem Endmarker.");
      break;
    }
    const storedChecksum = tarOctal(header, 148, 8, "TAR.checksum");
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 0x20 : header[index];
    invariant(checksum === storedChecksum, "Commit-TAR besitzt einen ungueltigen Header-Checksum.");
    const headerSize = tarOctal(header, 124, 12, "TAR.size");
    const type = String.fromCharCode(header[156] || 0x30);
    const dataOffset = offset + 512;
    invariant(dataOffset + headerSize <= bytes.length, "Commit-TAR-Eintrag liegt ausserhalb des Archivs.");
    const data = bytes.subarray(dataOffset, dataOffset + headerSize);
    if (type === "g") {
      globalPax = { ...globalPax, ...parsePaxRecords(data, "Globaler PAX-Header") };
    } else if (type === "x") {
      invariant(localPax === undefined, "Commit-TAR besitzt verschachtelte lokale PAX-Header.");
      localPax = parsePaxRecords(data, "Lokaler PAX-Header");
    } else {
      const prefix = tarText(header, 345, 155);
      const headerName = tarText(header, 0, 100);
      const file = localPax?.path ?? (prefix ? `${prefix}/${headerName}` : headerName);
      const size = localPax?.size === undefined ? headerSize : Number(localPax.size);
      invariant(Number.isSafeInteger(size) && size === headerSize, `Commit-TAR ${file} besitzt eine inkonsistente PAX-Groesse.`);
      localPax = undefined;
      invariant(typeof file === "string" && file.length > 0, "Commit-TAR besitzt einen leeren Pfad.");
      const normalizedFile = file.endsWith("/") ? file.slice(0, -1) : file;
      invariant(PORTABLE_FILE.test(normalizedFile), `Commit-TAR besitzt einen unzulaessigen Pfad: ${file}`);
      if (type === "0") {
        invariant(!seen.has(normalizedFile), `Commit-TAR besitzt eine doppelte Datei: ${normalizedFile}`);
        seen.add(normalizedFile);
        manifest.push({ bytes: data.length, file: normalizedFile, sha256: sha256(data) });
      } else invariant(type === "5" && data.length === 0, `Commit-TAR besitzt einen verbotenen Eintragstyp ${type} fuer ${file}.`);
    }
    offset = dataOffset + Math.ceil(headerSize / 512) * 512;
  }
  invariant(sawEnd && manifest.length > 0 && localPax === undefined, "Commit-TAR besitzt keinen vollstaendigen Endmarker oder Dateibaum.");
  invariant(globalPax.comment === spec.source.commit, "Commit-TAR-PAX-Kommentar bindet nicht den Spec-Commit.");
  manifest.sort((left, right) => left.file.localeCompare(right.file, "en"));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  const extractedTree = { fileCount: manifest.length, manifestSha256: sha256(canonicalBytes(manifest)), totalBytes };
  const cargoLock = manifest.find(({ file }) => file === spec.source.cargoLock.file);
  invariant(cargoLock !== undefined, "Commit-TAR enthaelt kein Cargo.lock.");
  proofMatches({ bytes: cargoLock.bytes, sha256: cargoLock.sha256 }, spec.source.cargoLock, "Commit-TAR Cargo.lock");
  return { cargoLock: { file: cargoLock.file, bytes: cargoLock.bytes, sha256: cargoLock.sha256 }, extractedTree };
}

async function validateProducerProofs({ producerProofs, spec, workspaceRoot }) {
  exactKeys(producerProofs, ["bootstrap", "entrypoint", "implementation"], "producerProofs");
  const result = {};
  for (const id of ["bootstrap", "entrypoint", "implementation"]) {
    validateProof(producerProofs[id], `producerProofs.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(sameCanonicalValue(producerProofs[id], spec.producer[id]), `producerProofs.${id} driftet vom externen Spec-Pin.`);
    const path = resolveWorkspaceFile(workspaceRoot, spec.producer[id].file, `producer.${id}.file`);
    const source = await regularFileSnapshot(workspaceRoot, path, `Producer ${id}`, MAX_PRODUCER_BYTES);
    proofMatches(source.proof, producerProofs[id], `Producer ${id}`);
    result[id] = { file: spec.producer[id].file, ...source.proof };
  }
  return result;
}

async function validateSpecInputs({ spec, specBytes, specFile, workspaceRoot }) {
  validateOperationalValidatorRebuildSpec(spec);
  const supplied = Buffer.from(specBytes);
  invariant(supplied.length > 0 && supplied.length <= MAX_SPEC_BYTES && supplied.equals(canonicalBytes(spec)), "specBytes ist nicht die kanonische Rebuild-Spec.");
  const path = resolve(specFile);
  invariant(isContained(workspaceRoot, path), "specFile verlaesst workspaceRoot.");
  const source = await regularFileSnapshot(workspaceRoot, path, "Rebuild-Spec", MAX_SPEC_BYTES);
  invariant(source.bytes.equals(supplied), "specFile und specBytes sind nicht bytegleich.");
  const parsed = JSON.parse(source.bytes.toString("utf8"));
  validateOperationalValidatorRebuildSpec(parsed);
  invariant(sameCanonicalValue(parsed, spec), "specFile driftet von der uebergebenen Spec.");
  return { bytes: source.proof.bytes, file: relative(workspaceRoot, path).split(sep).join("/"), path, sha256: source.proof.sha256 };
}

async function sourceArchiveEvidence({ sourceRepository, sourceRepositorySnapshot, sourceDirectory, archivePath, stagingRoot, environment, executables, spec, hooks }) {
  const repository = await regularDirectorySnapshot(sourceRepository, "sourceRepository");
  invariant(sameIdentity(repository.metadata, sourceRepositorySnapshot.metadata), "sourceRepository driftete zwischen Materialisierungsstart und Git-Audit.");
  await assertRegularDirectorySnapshot(sourceRepositorySnapshot, "sourceRepository vor git rev-parse commit");
  const commitResult = await runProcess(executables.git, ["rev-parse", `${spec.source.commit}^{commit}`], { cwd: repository.path, env: environment, label: "git rev-parse commit" });
  await assertRegularDirectorySnapshot(sourceRepositorySnapshot, "sourceRepository nach git rev-parse commit");
  invariant(commitResult.stdout.toString("utf8").trim() === spec.source.commit, "sourceRepository enthaelt nicht den festgelegten Commit.");
  await assertRegularDirectorySnapshot(sourceRepositorySnapshot, "sourceRepository vor git rev-parse tree");
  const treeResult = await runProcess(executables.git, ["rev-parse", `${spec.source.commit}^{tree}`], { cwd: repository.path, env: environment, label: "git rev-parse tree" });
  await assertRegularDirectorySnapshot(sourceRepositorySnapshot, "sourceRepository nach git rev-parse tree");
  const tree = treeResult.stdout.toString("utf8").trim();
  invariant(GIT_COMMIT.test(tree), "Git-Tree-ID ist ungueltig.");
  if (hooks.beforeArchive) await hooks.beforeArchive({ archivePath, sourceRepository: repository.path });
  await assertRegularDirectorySnapshot(sourceRepositorySnapshot, "sourceRepository vor git archive");
  const archiveResult = await runProcess(executables.git, ["archive", "--format=tar", `--output=${archivePath}`, spec.source.commit], { cwd: repository.path, env: environment, label: "git archive" });
  await assertRegularDirectorySnapshot(sourceRepositorySnapshot, "sourceRepository nach git archive");
  invariant(archiveResult.stdout.length === 0, "git archive schrieb unerwartete stdout-Daten.");
  const archive = await regularFileSnapshot(stagingRoot, archivePath, "Git-Commit-Archiv", MAX_ARCHIVE_BYTES);
  const embedded = await runProcessWithInputFile(executables.git, ["get-tar-commit-id"], archivePath, { cwd: repository.path, env: environment, label: "git get-tar-commit-id" });
  await assertRegularDirectorySnapshot(sourceRepositorySnapshot, "sourceRepository nach git get-tar-commit-id");
  invariant(embedded.stdout.toString("utf8").trim() === spec.source.commit, "Git-Archiv bindet nicht den festgelegten Commit.");
  if (hooks.afterArchive) await hooks.afterArchive({ archivePath, proof: archive.proof });
  await mkdir(sourceDirectory, { recursive: false, mode: 0o700 });
  if (hooks.beforeExtraction) await hooks.beforeExtraction({ sourceDirectory });
  await runProcess(executables.tar, ["-xf", archivePath, "-C", sourceDirectory], { cwd: stagingRoot, env: environment, label: "tar extract" });
  const archiveAfterExtraction = await regularFileSnapshot(stagingRoot, archivePath, "Git-Commit-Archiv nach Extraktion", MAX_ARCHIVE_BYTES);
  invariant(sameIdentity(archive.identity, archiveAfterExtraction.identity), "Git-Commit-Archiv wurde waehrend der Extraktion ersetzt.");
  proofMatches(archiveAfterExtraction.proof, archive.proof, "Git-Commit-Archiv nach Extraktion");
  const extractedTree = await auditExtractedTree(sourceDirectory);
  const cargoLockPath = resolveWorkspaceFile(sourceDirectory, spec.source.cargoLock.file, "source.cargoLock.file");
  const cargoLock = await regularFileSnapshot(sourceDirectory, cargoLockPath, "Archiviertes Cargo.lock", MAX_SPEC_BYTES);
  proofMatches(cargoLock.proof, spec.source.cargoLock, "Archiviertes Cargo.lock");
  if (hooks.afterExtraction) await hooks.afterExtraction({ sourceDirectory, extractedTree });
  proofMatches(archive.proof, spec.source.archive, "Git-Commit-Archiv-Spec-Pin");
  return {
    archive: { embeddedCommit: spec.source.commit, file: spec.source.archive.file, format: spec.source.archive.format, ...archive.proof },
    cargoLock: { file: spec.source.cargoLock.file, ...cargoLock.proof },
    extractedTree,
    git: { archiveCommand: ["git", "archive", "--format=tar", "--output=$CREATE_NEW_ARCHIVE", spec.source.commit], commit: spec.source.commit, isolation: "git-archive-commit", tree },
  };
}

async function writeReceiptCreateNew(path, bytes, hooks) {
  if (hooks.beforeReceiptOpen) await hooks.beforeReceiptOpen({ path });
  const handle = await open(path, "wx", 0o600);
  let primaryError;
  try {
    if (hooks.afterReceiptOpen) await hooks.afterReceiptOpen({ handle, path });
    if (hooks.duringReceiptWrite) {
      await handle.write(bytes.subarray(0, 1));
      await hooks.duringReceiptWrite({ handle, path });
      await handle.write(bytes.subarray(1));
    } else await handle.writeFile(bytes);
    await handle.sync();
    if (hooks.afterReceiptSync) await hooks.afterReceiptSync({ handle, path });
  } catch (error) { primaryError = error; }
  let closeError;
  try { await handle.close(); if (hooks.afterReceiptClose) await hooks.afterReceiptClose({ path }); } catch (error) { closeError = error; }
  if (primaryError && closeError) throw new AggregateError([primaryError, closeError], "Receipt-Write und Close sind fehlgeschlagen.");
  if (primaryError) throw primaryError;
  if (closeError) throw closeError;
}

async function publishCreateNew(path, output, label, expectedIdentity, registerOwned, { afterLinkBeforeAudit, parent } = {}) {
  const before = await lstat(path, { bigint: true });
  invariant(before.isFile() && sameIdentity(before, expectedIdentity), `${label}-Quelle wurde vor dem Link ersetzt.`);
  try { await link(path, output); } catch (error) {
    if (error?.code === "EEXIST") throw Object.assign(new Error(`${label} existiert bereits: ${output}`), { code: "EEXIST" });
    throw error;
  }
  registerOwned({ identity: expectedIdentity, label, path: output });
  if (afterLinkBeforeAudit) await afterLinkBeforeAudit({ output, path });
  if (parent) await assertDirectoryIdentity(parent.path, parent.metadata, `${label}-Elternverzeichnis unmittelbar nach Link`);
  const handle = await open(output, "r");
  try {
    const [source, published, held] = await Promise.all([lstat(path, { bigint: true }), lstat(output, { bigint: true }), handle.stat({ bigint: true })]);
    invariant(
      source.isFile() && published.isFile() && held.isFile()
        && sameIdentity(source, expectedIdentity) && sameIdentity(published, expectedIdentity) && sameIdentity(held, expectedIdentity),
      `${label} wurde nicht als gebundener create-new Hardlink publiziert.`,
    );
    if (parent) await assertDirectoryIdentity(parent.path, parent.metadata, `${label}-Elternverzeichnis nach Bindungs-Audit`);
    return { handle, identity: held, label, path: output };
  } catch (error) {
    try { await handle.close(); } catch (closeError) { throw new AggregateError([error, closeError], `${label}-Bindung und Handle-Close sind fehlgeschlagen.`); }
    throw error;
  }
}

async function proofFromHeldPublication(binding, maximumBytes) {
  const held = await binding.handle.stat({ bigint: true });
  const pathMetadata = await lstat(binding.path, { bigint: true });
  invariant(held.isFile() && pathMetadata.isFile() && sameIdentity(held, binding.identity) && sameIdentity(pathMetadata, binding.identity), `${binding.label} wurde nach Publikation ersetzt.`);
  invariant(held.size > 0n && held.size <= BigInt(maximumBytes), `${binding.label} besitzt eine ungueltige Groesse.`);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  while (position < Number(held.size)) {
    const length = Math.min(buffer.length, Number(held.size) - position);
    const { bytesRead } = await binding.handle.read(buffer, 0, length, position);
    invariant(bytesRead === length, `${binding.label} konnte ueber den gehaltenen Handle nicht vollstaendig gelesen werden.`);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await binding.handle.stat({ bigint: true });
  const pathAfter = await lstat(binding.path, { bigint: true });
  invariant(unchangedIdentity(held, after) && unchangedIdentity(after, pathAfter), `${binding.label} driftete bei der Post-Cleanup-Pruefung.`);
  return { bytes: position, sha256: hash.digest("hex") };
}

async function closePublicationBindings(bindings) {
  const errors = [];
  for (const binding of [...bindings].reverse()) {
    try { await binding.handle.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Publikations-Handles konnten nicht vollstaendig geschlossen werden.");
}

async function removePublishedOwned(output, identity, label) {
  let current;
  try { current = await lstat(output, { bigint: true }); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (!sameIdentity(current, identity)) return;
  const quarantine = await createOwnedTemporaryDirectory(dirname(output), ".operational-validator-rebuild-output-rollback-", `${label}-Rollback-Quarantaene`);
  const moved = resolve(quarantine.path, "owned");
  let movedEntry = false;
  try {
    await rename(output, moved);
    movedEntry = true;
    const movedMetadata = await lstat(moved, { bigint: true });
    if (!movedMetadata.isFile() || movedMetadata.isSymbolicLink() || !sameIdentity(movedMetadata, identity)) {
      invariant(!(await pathExists(output)), `${label} wurde nach der Quarantaene erneut fremd belegt.`);
      await rename(moved, output);
      movedEntry = false;
      throw new Error(`${label} wurde beim Rollback fremd ersetzt und am Originalpfad wiederhergestellt.`);
    }
    const immediatelyBeforeUnlink = await lstat(moved, { bigint: true });
    invariant(
      immediatelyBeforeUnlink.isFile()
        && !immediatelyBeforeUnlink.isSymbolicLink()
        && unchangedIdentity(movedMetadata, immediatelyBeforeUnlink),
      `${label} driftete in der Rollback-Quarantaene.`,
    );
    await unlink(moved);
    movedEntry = false;
    await rmdir(quarantine.path);
  } catch (error) {
    if (movedEntry) {
      try {
        if (!(await pathExists(output))) {
          await rename(moved, output);
          movedEntry = false;
        }
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `${label} konnte nicht restored owned-only zurueckgerollt werden; Quarantaene: ${quarantine.path}`);
      }
    }
    if (!movedEntry) {
      try { await rmdir(quarantine.path); } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], `${label} konnte nicht owned-only zurueckgerollt werden; Quarantaene: ${quarantine.path}`);
      }
    }
    throw new Error(`${label} konnte nicht owned-only zurueckgerollt werden; Quarantaene: ${quarantine.path}`, { cause: error });
  }
}

async function rollbackPublished(outputs) {
  const errors = [];
  for (const output of [...outputs].reverse()) {
    try { await removePublishedOwned(output.path, output.identity, output.label); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Create-new-Buildpaar konnte nicht vollstaendig zurueckgerollt werden.");
}

function portableWorkspacePath(workspaceRoot, pathInput, label) {
  const value = relative(resolve(workspaceRoot), resolve(pathInput)).split(sep).join("/");
  validatePortableFile(value, label);
  return value;
}

function publicationClaimPath(receiptOutput) {
  return `${resolve(receiptOutput)}.publication-claim.json`;
}

function buildClaimPath(receiptOutput) {
  return `${resolve(receiptOutput)}.build-claim.json`;
}

function createBuildClaim({ parent, producer, specification, spec, staging, workspaceRoot }) {
  return {
    parent: {
      identity: filesystemIdentity(parent.metadata),
      path: portableWorkspacePath(workspaceRoot, parent.path, "buildClaim.parent.path"),
    },
    producer,
    releaseId: spec.releaseId,
    schema: BUILD_CLAIM_SCHEMA,
    specification: { bytes: specification.bytes, file: specification.file, sha256: specification.sha256 },
    staging: {
      identity: filesystemIdentity(staging.metadata),
      root: portableWorkspacePath(workspaceRoot, staging.path, "buildClaim.staging.root"),
    },
  };
}

function validateBuildClaim(value, { spec, workspaceRoot }) {
  exactKeys(value, ["parent", "producer", "releaseId", "schema", "specification", "staging"], "Rebuild-Buildclaim");
  invariant(value.schema === BUILD_CLAIM_SCHEMA && value.releaseId === spec.releaseId, "Rebuild-Buildclaim besitzt falsches Schema oder Release-ID.");
  validateProof(value.specification, "Rebuild-Buildclaim.specification", MAX_SPEC_BYTES, { file: true });
  exactKeys(value.producer, ["bootstrap", "entrypoint", "implementation"], "Rebuild-Buildclaim.producer");
  for (const id of ["bootstrap", "entrypoint", "implementation"]) {
    validateProof(value.producer[id], `Rebuild-Buildclaim.producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(sameCanonicalValue(value.producer[id], spec.producer[id]), `Rebuild-Buildclaim.producer.${id} driftet vom Spec-Pin.`);
  }
  exactKeys(value.parent, ["identity", "path"], "Rebuild-Buildclaim.parent");
  validateFilesystemIdentity(value.parent.identity, "Rebuild-Buildclaim.parent.identity");
  validatePortableFile(value.parent.path, "Rebuild-Buildclaim.parent.path");
  exactKeys(value.staging, ["identity", "root"], "Rebuild-Buildclaim.staging");
  validateFilesystemIdentity(value.staging.identity, "Rebuild-Buildclaim.staging.identity");
  validatePortableFile(value.staging.root, "Rebuild-Buildclaim.staging.root");
  const parent = resolveWorkspaceFile(workspaceRoot, value.parent.path, "Rebuild-Buildclaim.parent.path");
  const staging = resolveWorkspaceFile(workspaceRoot, value.staging.root, "Rebuild-Buildclaim.staging.root");
  invariant(dirname(staging) === parent && basename(staging).startsWith(".operational-validator-rebuild-v2-"), "Rebuild-Buildclaim bindet keinen privaten Buildbaum im gebundenen Elternverzeichnis.");
  return value;
}

async function readBuildClaim({ path, producer, spec, specification, workspace }) {
  const source = await regularFileSnapshot(workspace.path, path, "Rebuild-Buildclaim", MAX_JSON_BYTES);
  const value = validateBuildClaim(parseJson(source.bytes, "Rebuild-Buildclaim"), { spec, workspaceRoot: workspace.path });
  invariant(source.bytes.equals(canonicalBytes(value)), "Rebuild-Buildclaim ist nicht kanonisch serialisiert.");
  proofMatches(specification, value.specification, "Rebuild-Buildclaim-Spec");
  invariant(sameCanonicalValue(producer, value.producer), "Rebuild-Buildclaim-Producer driftet.");
  return { identity: source.identity, path, source, value };
}

function createPublicationClaim({ archive, binary, producer, provenance, receipt, specification, spec, stagingRoot, workspaceRoot }) {
  const output = (file, stagedPath, source) => ({ bytes: source.proof.bytes, file, sha256: source.proof.sha256, stagedFile: portableWorkspacePath(workspaceRoot, stagedPath, `${file}.stagedFile`) });
  return {
    outputs: {
      archive: output(spec.source.archive.file, archive.path, archive),
      binary: output(spec.binaries.rebuilt.file, binary.path, binary),
      provenance: output(spec.provenance.file, provenance.path, provenance),
      receipt: output(portableWorkspacePath(workspaceRoot, receipt.outputPath, "claim.outputs.receipt.file"), receipt.path, receipt),
    },
    producer,
    releaseId: spec.releaseId,
    schema: PUBLICATION_CLAIM_SCHEMA,
    specification: { bytes: specification.bytes, file: specification.file, sha256: specification.sha256 },
    staging: { root: portableWorkspacePath(workspaceRoot, stagingRoot, "claim.staging.root") },
  };
}

function validatePublicationClaim(value, { receiptOutput, spec, workspaceRoot }) {
  exactKeys(value, ["outputs", "producer", "releaseId", "schema", "specification", "staging"], "Rebuild-Publikationsclaim");
  invariant(value.schema === PUBLICATION_CLAIM_SCHEMA && value.releaseId === spec.releaseId, "Rebuild-Publikationsclaim besitzt falsches Schema oder Release-ID.");
  validateProof(value.specification, "Rebuild-Publikationsclaim.specification", MAX_SPEC_BYTES, { file: true });
  exactKeys(value.producer, ["bootstrap", "entrypoint", "implementation"], "Rebuild-Publikationsclaim.producer");
  for (const id of ["bootstrap", "entrypoint", "implementation"]) {
    validateProof(value.producer[id], `Rebuild-Publikationsclaim.producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(sameCanonicalValue(value.producer[id], spec.producer[id]), `Rebuild-Publikationsclaim.producer.${id} driftet vom Spec-Pin.`);
  }
  exactKeys(value.staging, ["root"], "Rebuild-Publikationsclaim.staging");
  validatePortableFile(value.staging.root, "Rebuild-Publikationsclaim.staging.root");
  invariant(value.staging.root.split("/").at(-1).startsWith(".operational-validator-rebuild-v2-"), "Rebuild-Publikationsclaim bindet keinen privaten Rebuild-Baum.");
  exactKeys(value.outputs, ["archive", "binary", "provenance", "receipt"], "Rebuild-Publikationsclaim.outputs");
  const expected = {
    archive: { file: spec.source.archive.file, maximum: MAX_ARCHIVE_BYTES },
    binary: { file: spec.binaries.rebuilt.file, maximum: MAX_BINARY_BYTES },
    provenance: { file: spec.provenance.file, maximum: MAX_PROVENANCE_BYTES },
    receipt: { file: portableWorkspacePath(workspaceRoot, receiptOutput, "receiptOutput"), maximum: MAX_JSON_BYTES },
  };
  for (const id of ["archive", "binary", "provenance", "receipt"]) {
    exactKeys(value.outputs[id], ["bytes", "file", "sha256", "stagedFile"], `Rebuild-Publikationsclaim.outputs.${id}`);
    validatePortableFile(value.outputs[id].file, `Rebuild-Publikationsclaim.outputs.${id}.file`);
    validatePortableFile(value.outputs[id].stagedFile, `Rebuild-Publikationsclaim.outputs.${id}.stagedFile`);
    validatePositiveBytes(value.outputs[id].bytes, `Rebuild-Publikationsclaim.outputs.${id}.bytes`, expected[id].maximum);
    validateSha256(value.outputs[id].sha256, `Rebuild-Publikationsclaim.outputs.${id}.sha256`);
    invariant(value.outputs[id].file === expected[id].file, `Rebuild-Publikationsclaim.outputs.${id}.file driftet.`);
    const stagedPath = resolveWorkspaceFile(workspaceRoot, value.outputs[id].stagedFile, `Rebuild-Publikationsclaim.outputs.${id}.stagedFile`);
    const stagingRoot = resolveWorkspaceFile(workspaceRoot, value.staging.root, "Rebuild-Publikationsclaim.staging.root");
    invariant(isContained(stagingRoot, stagedPath), `Rebuild-Publikationsclaim.outputs.${id}.stagedFile verlaesst den privaten Baum.`);
  }
  return value;
}

async function bindExistingPublication(workspaceRoot, path, label, expectedProof, maximumBytes) {
  const snapshot = await regularFileSnapshot(workspaceRoot, path, label, maximumBytes);
  proofMatches(snapshot.proof, expectedProof, label);
  const handle = await open(path, "r");
  const held = await handle.stat({ bigint: true });
  if (!sameIdentity(held, snapshot.identity)) {
    await handle.close();
    throw new Error(`${label} wurde beim Recovery-Binden ersetzt.`);
  }
  return { handle, identity: held, label, path };
}

async function pathExists(path) {
  try { await lstat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function validateStagedPublicationSet({ claim, spec, staged, workspaceRoot }) {
  const receipt = validateReceiptEnvelope(parseJson(staged.receipt.bytes, "Gestagetes Recovery-Receipt"), spec);
  invariant(staged.receipt.bytes.equals(canonicalBytes(receipt)), "Gestagetes Recovery-Receipt ist nicht kanonisch.");
  const provenance = validateBuildProvenance(parseJson(staged.provenance.bytes, "Gestagete Recovery-Provenienz"), spec);
  invariant(staged.provenance.bytes.equals(canonicalBytes(provenance)), "Gestagete Recovery-Provenienz ist nicht kanonisch.");
  proofMatches(staged.provenance.proof, receipt.provenance, "Recovery-Provenienz/Receipt");
  const archiveAudit = auditPinnedSourceArchive(staged.archive.bytes, spec);
  invariant(sameCanonicalValue(archiveAudit.cargoLock, receipt.source.cargoLock), "Recovery-Archiv/Cargo.lock driftet.");
  invariant(sameCanonicalValue(archiveAudit.extractedTree, receipt.source.extractedTree), "Recovery-Archiv/Source-Tree driftet.");
  for (const field of ["binaries", "build", "pe", "producer", "source", "specification", "toolchain"]) {
    invariant(sameCanonicalValue(provenance[field], receipt[field]), `Recovery-Provenienz.${field} driftet vom Receipt.`);
  }
  const preservedPath = resolveWorkspaceFile(workspaceRoot, spec.binaries.preserved.file, "binaries.preserved.file");
  const preserved = await regularFileSnapshot(workspaceRoot, preservedPath, "Recovery-Preserved-Validator", spec.pe.maxBinaryBytes);
  proofMatches(preserved.proof, spec.binaries.preserved, "Recovery-Preserved-Validator");
  const pe = inspectPePair(preserved.bytes, staged.binary.bytes, spec);
  invariant(sameCanonicalValue(pe, receipt.pe), "Recovery-Binary driftet vom Receipt-PE-Beleg.");
  for (const id of ["archive", "binary", "provenance", "receipt"]) proofMatches(staged[id].proof, claim.outputs[id], `Recovery-Staging ${id}`);
  return receipt;
}

async function recoverPublicationClaim({ buildClaim, claimPath, hooks, producer, receiptOutput, spec, specification, workspace }) {
  const claimSource = await regularFileSnapshot(workspace.path, claimPath, "Rebuild-Publikationsclaim", MAX_JSON_BYTES);
  const claim = validatePublicationClaim(parseJson(claimSource.bytes, "Rebuild-Publikationsclaim"), { receiptOutput, spec, workspaceRoot: workspace.path });
  invariant(claimSource.bytes.equals(canonicalBytes(claim)), "Rebuild-Publikationsclaim ist nicht kanonisch.");
  proofMatches(specification, claim.specification, "Rebuild-Publikationsclaim-Spec");
  invariant(sameCanonicalValue(producer, claim.producer), "Rebuild-Publikationsclaim-Producer driftet.");
  const stagingRoot = resolveWorkspaceFile(workspace.path, buildClaim.value.staging.root, "Rebuild-Buildclaim.staging.root");
  const publicationStagingRoot = resolveWorkspaceFile(workspace.path, claim.staging.root, "Rebuild-Publikationsclaim.staging.root");
  invariant(pathKey(stagingRoot) === pathKey(publicationStagingRoot), "Build- und Publikationsclaim binden verschiedene private Buildbaeume.");
  const buildParentPath = resolveWorkspaceFile(workspace.path, buildClaim.value.parent.path, "Rebuild-Buildclaim.parent.path");
  const buildParent = await regularDirectorySnapshot(buildParentPath, "Rebuild-Recovery-Build-Elternverzeichnis");
  invariant(matchesFilesystemIdentity(buildParent.metadata, buildClaim.value.parent.identity), "Rebuild-Recovery-Build-Elternverzeichnis driftet vom Buildclaim.");
  let stagingMetadata = null;
  if (await pathExists(stagingRoot)) {
    stagingMetadata = await lstat(stagingRoot, { bigint: true });
    invariant(
      stagingMetadata.isDirectory()
        && !stagingMetadata.isSymbolicLink()
        && matchesFilesystemIdentity(stagingMetadata, buildClaim.value.staging.identity),
      "Rebuild-Recovery-Buildbaum wurde fremd ersetzt.",
    );
  }
  const maxima = { archive: MAX_ARCHIVE_BYTES, binary: MAX_BINARY_BYTES, provenance: MAX_PROVENANCE_BYTES, receipt: MAX_JSON_BYTES };
  const finalPaths = Object.fromEntries(["archive", "binary", "provenance", "receipt"].map((id) => [id, resolveWorkspaceFile(workspace.path, claim.outputs[id].file, `claim.outputs.${id}.file`)]));
  const finalPresence = Object.fromEntries(await Promise.all(Object.entries(finalPaths).map(async ([id, path]) => [id, await pathExists(path)])));
  const parentSnapshots = new Map();
  for (const id of ["archive", "provenance", "binary", "receipt"]) {
    const parentPath = dirname(finalPaths[id]);
    if (!parentSnapshots.has(pathKey(parentPath))) parentSnapshots.set(pathKey(parentPath), await regularDirectorySnapshot(parentPath, `Recovery-Elternverzeichnis ${id}`));
  }
  if (Object.values(finalPresence).every(Boolean)) {
    const bindings = [];
    let primaryError;
    let verification;
    try {
      for (const id of ["archive", "provenance", "binary", "receipt"]) {
        const parent = parentSnapshots.get(pathKey(dirname(finalPaths[id])));
        await assertDirectoryIdentity(parent.path, parent.metadata, `Recovery-Complete-Elternverzeichnis vor ${id}`);
        bindings.push(await bindExistingPublication(workspace.path, finalPaths[id], `Recovery-Complete ${id}`, claim.outputs[id], maxima[id]));
        await assertDirectoryIdentity(parent.path, parent.metadata, `Recovery-Complete-Elternverzeichnis nach ${id}`);
      }
      verification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
      for (const [index, id] of ["archive", "provenance", "binary", "receipt"].entries()) proofMatches(await proofFromHeldPublication(bindings[index], maxima[id]), claim.outputs[id], `Recovery-Complete-Postcheck ${id}`);
      for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Recovery-Complete-Elternverzeichnis nach Postcheck");
    } catch (error) { primaryError = error; }
    let closeError;
    try { await closePublicationBindings(bindings); } catch (error) { closeError = error; }
    if (primaryError && closeError) throw new AggregateError([primaryError, closeError], "Vollstaendiges Recovery und Handle-Close sind fehlgeschlagen.");
    if (primaryError) throw primaryError;
    if (closeError) throw closeError;
    if (stagingMetadata !== null) {
      await cleanupOwnedBuildRoot(buildParent, stagingRoot, stagingMetadata, hooks);
      stagingMetadata = null;
    }
    for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Recovery-Complete-Elternverzeichnis vor Claim-Abschluss");
    verification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
    await removePublishedOwned(claimPath, claimSource.identity, "Rebuild-Publikationsclaim");
    invariant(!(await pathExists(claimPath)), "Rebuild-Publikationsclaim blieb nach vollstaendigem Recovery sichtbar.");
    await removePublishedOwned(buildClaim.path, buildClaim.identity, "Rebuild-Buildclaim");
    invariant(!(await pathExists(buildClaim.path)), "Rebuild-Buildclaim blieb nach vollstaendigem Recovery sichtbar.");
    for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Recovery-Complete-Elternverzeichnis nach Claim-Abschluss");
    const finalVerification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
    return {
      archive: { path: finalPaths.archive, bytes: claim.outputs.archive.bytes, sha256: claim.outputs.archive.sha256 },
      binary: { path: finalPaths.binary, bytes: claim.outputs.binary.bytes, sha256: claim.outputs.binary.sha256 },
      path: receiptOutput,
      proof: finalVerification.proof,
      provenance: { path: finalPaths.provenance, bytes: claim.outputs.provenance.bytes, sha256: claim.outputs.provenance.sha256 },
      receipt: finalVerification.receipt,
      recovery: { claim: claimPath, staging: stagingRoot, stagingRetained: false },
    };
  }
  invariant(stagingMetadata !== null, "Partielles Rebuild-Recovery besitzt keinen gebundenen privaten Buildbaum.");
  const staged = {};
  for (const id of ["archive", "binary", "provenance", "receipt"]) {
    const path = resolveWorkspaceFile(workspace.path, claim.outputs[id].stagedFile, `claim.outputs.${id}.stagedFile`);
    staged[id] = await regularFileSnapshot(workspace.path, path, `Recovery-Staging ${id}`, maxima[id]);
    proofMatches(staged[id].proof, claim.outputs[id], `Recovery-Staging ${id}`);
  }
  const receipt = await validateStagedPublicationSet({ claim, spec, staged, workspaceRoot: workspace.path });
  const owned = [];
  const bindings = [];
  let primaryError;
  let result;
  try {
    for (const id of ["archive", "provenance", "binary", "receipt"]) {
      const output = resolveWorkspaceFile(workspace.path, claim.outputs[id].file, `claim.outputs.${id}.file`);
      const label = `Recovery-Output ${id}`;
      const parent = parentSnapshots.get(pathKey(dirname(output)));
      await assertDirectoryIdentity(parent.path, parent.metadata, `Recovery-Elternverzeichnis vor ${id}`);
      let binding;
      if (await pathExists(output)) binding = await bindExistingPublication(workspace.path, output, label, claim.outputs[id], maxima[id]);
      else binding = await publishCreateNew(staged[id].path, output, label, staged[id].identity, (entry) => owned.push(entry), {
        afterLinkBeforeAudit: hooks?.afterRecoverySourceLinkBeforeAudit
          ? (details) => hooks.afterRecoverySourceLinkBeforeAudit({ id, ...details })
          : undefined,
        parent: parentSnapshots.get(pathKey(dirname(output))),
      });
      bindings.push(binding);
      await assertDirectoryIdentity(dirname(output), parentSnapshots.get(pathKey(dirname(output))).metadata, `Recovery-Elternverzeichnis nach ${id}`);
      if (hooks?.afterRecoveryLink) await hooks.afterRecoveryLink({ id, output });
    }
    const verification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
    for (const [index, id] of ["archive", "provenance", "binary", "receipt"].entries()) {
      proofMatches(await proofFromHeldPublication(bindings[index], maxima[id]), claim.outputs[id], `Recovery-Postcheck ${id}`);
    }
    for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Recovery-Elternverzeichnis nach Postcheck");
    result = {
      archive: { path: bindings[0].path, bytes: claim.outputs.archive.bytes, sha256: claim.outputs.archive.sha256 },
      binary: { path: bindings[2].path, bytes: claim.outputs.binary.bytes, sha256: claim.outputs.binary.sha256 },
      path: receiptOutput,
      proof: verification.proof,
      provenance: { path: bindings[1].path, bytes: claim.outputs.provenance.bytes, sha256: claim.outputs.provenance.sha256 },
      receipt: verification.receipt,
      recovery: { claim: claimPath, staging: stagingRoot, stagingRetained: false },
    };
  } catch (error) { primaryError = error; }
  let closeError;
  try { await closePublicationBindings(bindings); } catch (error) { closeError = error; }
  if (primaryError || closeError) {
    let rollbackError;
    try { await rollbackPublished(owned); } catch (error) { rollbackError = error; }
    const errors = [primaryError, closeError, rollbackError].filter(Boolean);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Recovery oder owned-only Recovery-Rollback ist fehlgeschlagen.");
  }
  for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Recovery-Elternverzeichnis vor Claim-Abschluss");
  const preClaimVerification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
  await cleanupOwnedBuildRoot(buildParent, stagingRoot, stagingMetadata, hooks);
  stagingMetadata = null;
  await removePublishedOwned(claimPath, claimSource.identity, "Rebuild-Publikationsclaim");
  invariant(!(await pathExists(claimPath)), "Rebuild-Publikationsclaim blieb nach erfolgreichem Recovery bestehen.");
  await removePublishedOwned(buildClaim.path, buildClaim.identity, "Rebuild-Buildclaim");
  invariant(!(await pathExists(buildClaim.path)), "Rebuild-Buildclaim blieb nach erfolgreichem Recovery bestehen.");
  for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Recovery-Elternverzeichnis nach Claim-Abschluss");
  const finalVerification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
  result.proof = finalVerification.proof;
  result.receipt = finalVerification.receipt;
  invariant(receipt.binaries.rebuilt.sha256 === preClaimVerification.receipt.binaries.rebuilt.sha256 && receipt.binaries.rebuilt.sha256 === result.receipt.binaries.rebuilt.sha256, "Recovery-Receipt driftete nach Verify.");
  return result;
}

async function deleteQuarantinedTreeEntry(path, expectedIdentity, context, label) {
  const metadata = await lstat(path, { bigint: true });
  invariant(
    !metadata.isSymbolicLink()
      && (metadata.isFile() || metadata.isDirectory())
      && sameIdentitySizeMtime(metadata, expectedIdentity),
    `${label} driftete in der owned-only Quarantaene.`,
  );
  if (metadata.isDirectory()) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const original = resolve(path, entry.name);
      invariant(isContained(path, original), `${label}.${entry.name} verlaesst die Quarantaene.`);
      const before = await lstat(original, { bigint: true });
      invariant(!before.isSymbolicLink() && (before.isFile() || before.isDirectory()), `${label}.${entry.name} ist kein owned-loeschbarer regulaerer Eintrag.`);
      if (context.hooks.afterOwnedTreeSnapshotBeforeRename) {
        await context.hooks.afterOwnedTreeSnapshotBeforeRename({ label: `${label}.${entry.name}`, path: original, root: context.root });
      }
      const moved = resolve(context.trashRoot, `entry-${String(context.nextId).padStart(8, "0")}`);
      context.nextId += 1;
      let movedEntry = false;
      try {
        await rename(original, moved);
        movedEntry = true;
        const movedMetadata = await lstat(moved, { bigint: true });
        if (!sameIdentitySizeMtime(before, movedMetadata)) {
          invariant(!(await pathExists(original)), `${label}.${entry.name} wurde nach der Quarantaene erneut fremd belegt.`);
          await rename(moved, original);
          movedEntry = false;
          throw new Error(`${label}.${entry.name} wurde im Check-Rename-Fenster fremd ersetzt und wiederhergestellt.`);
        }
        await deleteQuarantinedTreeEntry(moved, movedMetadata, context, `${label}.${entry.name}`);
        movedEntry = false;
      } catch (error) {
        if (movedEntry) {
          try {
            if (!(await pathExists(original)) && await pathExists(moved)) {
              await rename(moved, original);
              movedEntry = false;
            }
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], `${label}.${entry.name} konnte nicht aus der owned-only Quarantaene wiederhergestellt werden: ${context.trashRoot}`);
          }
        }
        throw error;
      }
    }
    invariant((await readdir(path)).length === 0, `${label} erhielt waehrend des Cleanup fremde Eintraege; Quarantaene bleibt erhalten.`);
    await rmdir(path);
    return;
  }
  const handle = await open(path, "r");
  try {
    const held = await handle.stat({ bigint: true });
    const visible = await lstat(path, { bigint: true });
    invariant(unchangedIdentity(metadata, held) && unchangedIdentity(held, visible), `${label} driftete vor der owned-only Loeschung.`);
    if (context.hooks.afterOwnedTreeEntryQuarantineBeforeDelete) {
      await context.hooks.afterOwnedTreeEntryQuarantineBeforeDelete({ label, path, root: context.root });
    }
    const finalHeld = await handle.stat({ bigint: true });
    const finalVisible = await lstat(path, { bigint: true });
    invariant(unchangedIdentity(held, finalHeld) && unchangedIdentity(finalHeld, finalVisible), `${label} wurde unmittelbar vor der owned-only Loeschung fremd ersetzt.`);
    await unlink(path);
  } finally {
    await handle.close();
  }
}

async function cleanupOwnedBuildRoot(parent, stagingRoot, stagingIdentity, hooks = {}) {
  await assertDirectoryIdentity(parent.path, parent.metadata, "Build-Elternverzeichnis vor Cleanup");
  let injectedError;
  try { if (hooks.beforeBuildRootQuarantine) await hooks.beforeBuildRootQuarantine({ stagingRoot }); } catch (error) { injectedError = error; }
  const before = await lstat(stagingRoot, { bigint: true });
  invariant(before.isDirectory() && !before.isSymbolicLink() && sameIdentity(before, stagingIdentity), "Privater Buildbaum wurde vor Cleanup fremd ersetzt.");
  if (hooks.afterBuildRootSnapshotBeforeRename) await hooks.afterBuildRootSnapshotBeforeRename({ stagingRoot });
  const quarantine = await createOwnedTemporaryDirectory(parent.path, ".operational-validator-rebuild-owned-cleanup-", "Build-Cleanup-Quarantaene");
  const quarantined = resolve(quarantine.path, "build-root");
  const trashRoot = resolve(quarantine.path, "entries");
  let movedRoot = false;
  try {
    await rename(stagingRoot, quarantined);
    movedRoot = true;
    const moved = await lstat(quarantined, { bigint: true });
    if (!moved.isDirectory() || moved.isSymbolicLink() || !sameIdentitySizeMtime(before, moved)) {
      invariant(!(await pathExists(stagingRoot)), "Privater Buildbaum wurde nach der Quarantaene erneut fremd belegt.");
      await rename(quarantined, stagingRoot);
      movedRoot = false;
      throw new Error("Privater Buildbaum wurde im Check-Rename-Fenster fremd ersetzt und wiederhergestellt.");
    }
    await mkdir(trashRoot, { recursive: false, mode: 0o700 });
    await deleteQuarantinedTreeEntry(quarantined, moved, { hooks, nextId: 0, root: stagingRoot, trashRoot }, "Privater Buildbaum");
    movedRoot = false;
    invariant((await readdir(trashRoot)).length === 0, "Build-Cleanup-Quarantaene enthaelt fremde Eintraege.");
    await rmdir(trashRoot);
    await rmdir(quarantine.path);
  } catch (error) {
    if (movedRoot) {
      try {
        if (!(await pathExists(stagingRoot)) && await pathExists(quarantined)) {
          await rename(quarantined, stagingRoot);
          movedRoot = false;
        }
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `Build-Cleanup konnte den privaten Baum nicht wiederherstellen: ${quarantine.path}`);
      }
    }
    if (!movedRoot) {
      try {
        if (await pathExists(trashRoot)) await rmdir(trashRoot);
        await rmdir(quarantine.path);
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], `Build-Cleanup und Quarantaenen-Recovery sind fehlgeschlagen: ${quarantine.path}`);
      }
    }
    throw error;
  }
  await assertDirectoryIdentity(parent.path, parent.metadata, "Build-Elternverzeichnis nach Cleanup");
  if (injectedError) {
    if (injectedError !== null && typeof injectedError === "object") injectedError.cleanupCompleted = true;
    throw injectedError;
  }
}

async function recoverAbortedBuildClaim({ buildClaim, hooks, receiptOutput, workspace }) {
  const parentPath = resolveWorkspaceFile(workspace.path, buildClaim.value.parent.path, "Rebuild-Buildclaim.parent.path");
  const parent = await regularDirectorySnapshot(parentPath, "Rebuild-Buildclaim-Elternverzeichnis");
  invariant(matchesFilesystemIdentity(parent.metadata, buildClaim.value.parent.identity), "Rebuild-Buildclaim-Elternverzeichnis wurde fremd ersetzt.");
  const stagingRoot = resolveWorkspaceFile(workspace.path, buildClaim.value.staging.root, "Rebuild-Buildclaim.staging.root");
  let stagingRemoved = false;
  if (await pathExists(stagingRoot)) {
    const stagingMetadata = await lstat(stagingRoot, { bigint: true });
    invariant(
      stagingMetadata.isDirectory()
        && !stagingMetadata.isSymbolicLink()
        && matchesFilesystemIdentity(stagingMetadata, buildClaim.value.staging.identity),
      "Rebuild-Buildclaim-Staging wurde fremd ersetzt; Claim bleibt erhalten.",
    );
    await cleanupOwnedBuildRoot(parent, stagingRoot, stagingMetadata, hooks);
    stagingRemoved = true;
  }
  await removePublishedOwned(buildClaim.path, buildClaim.identity, "Rebuild-Buildclaim");
  invariant(!(await pathExists(buildClaim.path)), "Rebuild-Buildclaim blieb nach Abbruch-Recovery sichtbar.");
  await assertDirectoryIdentity(parent.path, parent.metadata, "Rebuild-Buildclaim-Elternverzeichnis nach Abbruch-Recovery");
  return {
    path: receiptOutput,
    recovery: {
      claim: buildClaim.path,
      phase: "aborted-build-cleaned",
      staging: stagingRoot,
      stagingRemoved,
      stagingRetained: false,
    },
  };
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error(`${label} ist kein gueltiges JSON.`, { cause: error }); }
}

function validateExecutableBinding(value, label) {
  exactKeys(value, ["bytes", "command", "pathSha256", "sha256"], label);
  invariant(typeof value.command === "string" && /^[a-z][a-z0-9-]*$/.test(value.command), `${label}.command ist ungueltig.`);
  validatePositiveBytes(value.bytes, `${label}.bytes`, MAX_TOOL_BYTES);
  validateSha256(value.pathSha256, `${label}.pathSha256`);
  validateSha256(value.sha256, `${label}.sha256`);
}

function validateToolchainReceipt(toolchain, spec) {
  exactKeys(toolchain, ["cargo", "git", "rustc", "tar"], "Receipt.toolchain");
  exactKeys(toolchain.cargo, ["command", "executable", "identity", "output"], "Receipt.toolchain.cargo");
  validateStringArray(toolchain.cargo.command, ["cargo", "-vV"], "Receipt.toolchain.cargo.command");
  validateExecutableBinding(toolchain.cargo.executable, "Receipt.toolchain.cargo.executable");
  validateCargoIdentity(toolchain.cargo.identity, "Receipt.toolchain.cargo.identity");
  invariant(sameCanonicalValue(toolchain.cargo.identity, spec.toolchain.cargo), "Receipt bindet die falsche Cargo-Toolchain.");
  validateEncodedOutput(toolchain.cargo.output, "Receipt.toolchain.cargo.output");
  exactKeys(toolchain.rustc, ["command", "executable", "identity", "output"], "Receipt.toolchain.rustc");
  validateStringArray(toolchain.rustc.command, ["rustc", "-vV"], "Receipt.toolchain.rustc.command");
  validateExecutableBinding(toolchain.rustc.executable, "Receipt.toolchain.rustc.executable");
  validateRustcIdentity(toolchain.rustc.identity, "Receipt.toolchain.rustc.identity");
  invariant(sameCanonicalValue(toolchain.rustc.identity, spec.toolchain.rustc), "Receipt bindet die falsche Rustc-Toolchain.");
  validateEncodedOutput(toolchain.rustc.output, "Receipt.toolchain.rustc.output");
  for (const id of ["git", "tar"]) {
    exactKeys(toolchain[id], ["command", "executable", "output"], `Receipt.toolchain.${id}`);
    validateStringArray(toolchain[id].command, [id, "--version"], `Receipt.toolchain.${id}.command`);
    validateExecutableBinding(toolchain[id].executable, `Receipt.toolchain.${id}.executable`);
    validateEncodedOutput(toolchain[id].output, `Receipt.toolchain.${id}.output`);
  }
}

function validateEnvironmentReceipt(value, spec) {
  exactKeys(value, ["allowedInherited", "cargoConfiguration", "cleared", "fixed", "targetDirectory"], "Receipt.build.environment");
  invariant(Array.isArray(value.allowedInherited) && value.allowedInherited.length === spec.build.environmentPolicy.allowedInherited.length, "Receipt.build.environment.allowedInherited muss alle erlaubten Namen binden.");
  for (const [index, entry] of value.allowedInherited.entries()) {
    invariant(entry?.name === spec.build.environmentPolicy.allowedInherited[index], "Receipt bindet Umgebungsvariablen nicht in der festgelegten Reihenfolge.");
    if (entry.present === false) {
      exactKeys(entry, ["name", "present"], "Receipt.build.environment.allowedInherited[]");
      continue;
    }
    exactKeys(entry, ["bytes", "name", "present", "sha256"], "Receipt.build.environment.allowedInherited[]");
    invariant(entry.present === true, `Receipt.build.environment.${entry.name}.present ist ungueltig.`);
    validatePositiveBytes(entry.bytes, `Receipt.build.environment.${entry.name}.bytes`, 64 * 1024);
    validateSha256(entry.sha256, `Receipt.build.environment.${entry.name}.sha256`);
  }
  invariant(value.allowedInherited.find(({ name }) => name === "PATH")?.present === true, "Receipt.build.environment bindet keinen PATH.");
  exactKeys(value.cargoConfiguration, ["candidateCount", "candidatePathSetSha256", "policy"], "Receipt.build.environment.cargoConfiguration");
  invariant(Number.isSafeInteger(value.cargoConfiguration.candidateCount) && value.cargoConfiguration.candidateCount >= 2, "Receipt.build.environment.cargoConfiguration.candidateCount ist ungueltig.");
  validateSha256(value.cargoConfiguration.candidatePathSetSha256, "Receipt.build.environment.cargoConfiguration.candidatePathSetSha256");
  invariant(value.cargoConfiguration.policy === "tracked-source-config-only", "Receipt.build.environment.cargoConfiguration.policy ist ungueltig.");
  validateStringArray(value.cleared, spec.build.environmentPolicy.cleared, "Receipt.build.environment.cleared");
  invariant(sameCanonicalValue(value.fixed, spec.build.environmentPolicy.fixed), "Receipt.build.environment.fixed driftet.");
  invariant(value.targetDirectory === spec.build.environmentPolicy.targetDirectory, "Receipt.build.environment.targetDirectory driftet.");
}

function validateSourceReceipt(value, spec) {
  exactKeys(value, ["archive", "cargoLock", "extractedTree", "git"], "Receipt.source");
  exactKeys(value.archive, ["bytes", "embeddedCommit", "file", "format", "sha256"], "Receipt.source.archive");
  validatePositiveBytes(value.archive.bytes, "Receipt.source.archive.bytes", MAX_ARCHIVE_BYTES);
  validateSha256(value.archive.sha256, "Receipt.source.archive.sha256");
  invariant(value.archive.file === spec.source.archive.file && value.archive.format === spec.source.archive.format && value.archive.embeddedCommit === spec.source.commit, "Receipt.source.archive bindet falsches Format, Datei oder Commit.");
  proofMatches({ bytes: value.archive.bytes, sha256: value.archive.sha256 }, spec.source.archive, "Receipt.source.archive-Spec-Pin");
  validateProof(value.cargoLock, "Receipt.source.cargoLock", MAX_SPEC_BYTES, { file: true });
  invariant(sameCanonicalValue(value.cargoLock, spec.source.cargoLock), "Receipt.source.cargoLock driftet.");
  exactKeys(value.extractedTree, ["fileCount", "manifestSha256", "totalBytes"], "Receipt.source.extractedTree");
  invariant(Number.isSafeInteger(value.extractedTree.fileCount) && value.extractedTree.fileCount > 0 && value.extractedTree.fileCount <= 100_000, "Receipt.source.extractedTree.fileCount ist ungueltig.");
  invariant(Number.isSafeInteger(value.extractedTree.totalBytes) && value.extractedTree.totalBytes > 0, "Receipt.source.extractedTree.totalBytes ist ungueltig.");
  validateSha256(value.extractedTree.manifestSha256, "Receipt.source.extractedTree.manifestSha256");
  exactKeys(value.git, ["archiveCommand", "commit", "isolation", "tree"], "Receipt.source.git");
  validateStringArray(value.git.archiveCommand, ["git", "archive", "--format=tar", "--output=$CREATE_NEW_ARCHIVE", spec.source.commit], "Receipt.source.git.archiveCommand");
  invariant(value.git.commit === spec.source.commit && value.git.isolation === "git-archive-commit" && GIT_COMMIT.test(value.git.tree), "Receipt.source.git ist ungueltig.");
}

function buildProvenanceChain(value) {
  const sourceSha256 = sha256(canonicalBytes({
    producer: value.producer,
    releaseId: value.releaseId,
    source: value.source,
    specification: value.specification,
  }));
  const buildSha256 = sha256(canonicalBytes({ previousSha256: sourceSha256, build: value.build, toolchain: value.toolchain }));
  const outputSha256 = sha256(canonicalBytes({ previousSha256: buildSha256, binaries: value.binaries, pe: value.pe }));
  return { algorithm: "sha256-canonical-json-chain/v1", buildSha256, outputSha256, sourceSha256 };
}

function createBuildProvenance({ binaries, build, pe, producer, releaseId, source, specification, toolchain }) {
  const value = { binaries, build, pe, producer, releaseId, schema: PROVENANCE_SCHEMA, source, specification, toolchain };
  return { ...value, chain: buildProvenanceChain(value) };
}

function validateBuildProvenance(value, spec) {
  exactKeys(value, ["binaries", "build", "chain", "pe", "producer", "releaseId", "schema", "source", "specification", "toolchain"], "Build-Provenienz");
  invariant(value.schema === PROVENANCE_SCHEMA && value.releaseId === spec.releaseId, "Build-Provenienz besitzt falsches Schema oder Release-ID.");
  exactKeys(value.chain, ["algorithm", "buildSha256", "outputSha256", "sourceSha256"], "Build-Provenienz.chain");
  for (const name of ["buildSha256", "outputSha256", "sourceSha256"]) validateSha256(value.chain[name], `Build-Provenienz.chain.${name}`);
  invariant(sameCanonicalValue(value.chain, buildProvenanceChain(value)), "Build-Provenienz besitzt eine ungueltige Hash-Kette.");
  validateProof(value.specification, "Build-Provenienz.specification", MAX_SPEC_BYTES, { file: true });
  validateSourceReceipt(value.source, spec);
  validateToolchainReceipt(value.toolchain, spec);
  exactKeys(value.build, ["command", "environment", "exitCode", "logs", "output", "profile", "targetDirectory"], "Build-Provenienz.build");
  validateStringArray(value.build.command, spec.build.command, "Build-Provenienz.build.command");
  invariant(value.build.profile === spec.build.profile && value.build.exitCode === 0, "Build-Provenienz.build besitzt falsches Profil oder Exitcode.");
  validateEnvironmentReceipt(value.build.environment, spec);
  exactKeys(value.build.logs, ["stderr", "stdout"], "Build-Provenienz.build.logs");
  validateEncodedOutput(value.build.logs.stderr, "Build-Provenienz.build.logs.stderr");
  validateEncodedOutput(value.build.logs.stdout, "Build-Provenienz.build.logs.stdout");
  validateProof(value.build.output, "Build-Provenienz.build.output", MAX_BINARY_BYTES, { file: true });
  exactKeys(value.build.targetDirectory, ["initiallyEmpty", "mode"], "Build-Provenienz.build.targetDirectory");
  exactKeys(value.binaries, ["preserved", "rebuilt"], "Build-Provenienz.binaries");
  validateProof(value.binaries.preserved, "Build-Provenienz.binaries.preserved", MAX_BINARY_BYTES, { file: true });
  validateProof(value.binaries.rebuilt, "Build-Provenienz.binaries.rebuilt", MAX_BINARY_BYTES, { file: true });
  exactKeys(value.producer, ["bootstrap", "entrypoint", "implementation"], "Build-Provenienz.producer");
  for (const id of ["bootstrap", "entrypoint", "implementation"]) {
    validateProof(value.producer[id], `Build-Provenienz.producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(sameCanonicalValue(value.producer[id], spec.producer[id]), `Build-Provenienz.producer.${id} driftet vom Spec-Pin.`);
  }
  invariant(value.build.output.file === spec.binaries.rebuilt.file, "Build-Provenienz.build.output bindet den falschen Binary-Pfad.");
  invariant(sameCanonicalValue(value.binaries.preserved, { ...spec.binaries.preserved }), "Build-Provenienz bindet das falsche Preserved-Binary.");
  invariant(value.binaries.rebuilt.file === spec.binaries.rebuilt.file && value.binaries.rebuilt.bytes === spec.binaries.rebuilt.expectedBytes, "Build-Provenienz bindet das falsche Rebuild-Binary.");
  return value;
}

function validateReceiptEnvelope(receipt, spec) {
  exactKeys(receipt, ["binaries", "build", "pe", "producer", "provenance", "releaseId", "schema", "source", "specification", "toolchain"], "Operational-Validator-Rebuild-Receipt");
  invariant(receipt.schema === EVIDENCE_SCHEMA && receipt.releaseId === spec.releaseId, "Receipt besitzt falsches Schema oder Release-ID.");
  validateProof(receipt.specification, "Receipt.specification", MAX_SPEC_BYTES, { file: true });
  validateSourceReceipt(receipt.source, spec);
  exactKeys(receipt.build, ["command", "environment", "exitCode", "logs", "output", "profile", "targetDirectory"], "Receipt.build");
  validateStringArray(receipt.build.command, spec.build.command, "Receipt.build.command");
  invariant(receipt.build.profile === spec.build.profile && receipt.build.exitCode === 0, "Receipt.build besitzt falsches Profil oder Exitcode.");
  validateEnvironmentReceipt(receipt.build.environment, spec);
  exactKeys(receipt.build.logs, ["stderr", "stdout"], "Receipt.build.logs");
  validateEncodedOutput(receipt.build.logs.stdout, "Receipt.build.logs.stdout");
  validateEncodedOutput(receipt.build.logs.stderr, "Receipt.build.logs.stderr");
  validateProof(receipt.build.output, "Receipt.build.output", MAX_BINARY_BYTES, { file: true });
  invariant(receipt.build.output.file === spec.binaries.rebuilt.file, "Receipt.build.output bindet den falschen Pfad.");
  exactKeys(receipt.build.targetDirectory, ["initiallyEmpty", "mode"], "Receipt.build.targetDirectory");
  invariant(receipt.build.targetDirectory.initiallyEmpty === true && receipt.build.targetDirectory.mode === "external-empty-create-new", "Receipt.build.targetDirectory ist ungueltig.");
  validateToolchainReceipt(receipt.toolchain, spec);
  exactKeys(receipt.binaries, ["preserved", "rebuilt"], "Receipt.binaries");
  validateProof(receipt.binaries.preserved, "Receipt.binaries.preserved", MAX_BINARY_BYTES, { file: true });
  validateProof(receipt.binaries.rebuilt, "Receipt.binaries.rebuilt", MAX_BINARY_BYTES, { file: true });
  invariant(receipt.binaries.preserved.file === spec.binaries.preserved.file && receipt.binaries.rebuilt.file === spec.binaries.rebuilt.file, "Receipt.binaries bindet falsche Pfade.");
  invariant(receipt.binaries.rebuilt.bytes === spec.binaries.rebuilt.expectedBytes, "Receipt.binaries.rebuilt besitzt die falsche Bytezahl.");
  exactKeys(receipt.producer, ["bootstrap", "entrypoint", "implementation"], "Receipt.producer");
  for (const id of ["bootstrap", "entrypoint", "implementation"]) {
    validateProof(receipt.producer[id], `Receipt.producer.${id}`, MAX_PRODUCER_BYTES, { file: true });
    invariant(sameCanonicalValue(receipt.producer[id], spec.producer[id]), `Receipt.producer.${id} driftet vom Spec-Pin.`);
  }
  validateProof(receipt.provenance, "Receipt.provenance", MAX_PROVENANCE_BYTES, { file: true });
  invariant(receipt.provenance.file === spec.provenance.file, "Receipt.provenance bindet den falschen Pfad.");
  return receipt;
}

export async function materializeOperationalValidatorRebuildEvidence({ spec, specBytes, specFile, workspaceRoot, sourceRoot, outputPath, producerProofs, recoveryOnly = false, hooks = {} }) {
  validateOperationalValidatorRebuildSpec(spec);
  const workspace = await regularDirectorySnapshot(workspaceRoot, "workspaceRoot");
  const receiptOutput = resolve(outputPath);
  invariant(isContained(workspace.path, receiptOutput), "outputPath verlaesst workspaceRoot.");
  const outputs = {
    archive: resolveWorkspaceFile(workspace.path, spec.source.archive.file, "source.archive.file"),
    binary: resolveWorkspaceFile(workspace.path, spec.binaries.rebuilt.file, "binaries.rebuilt.file"),
    provenance: resolveWorkspaceFile(workspace.path, spec.provenance.file, "provenance.file"),
    receipt: receiptOutput,
  };
  const claimPath = publicationClaimPath(receiptOutput);
  const buildClaimOutput = buildClaimPath(receiptOutput);
  for (const [id, path] of [...Object.entries(outputs), ["claim", claimPath], ["buildClaim", buildClaimOutput]]) {
    await assertNoSymlinkPath(workspace.path, path, id, { leafMayBeMissing: true });
  }
  const specification = await validateSpecInputs({ spec, specBytes, specFile, workspaceRoot: workspace.path });
  const producer = await validateProducerProofs({ producerProofs, spec, workspaceRoot: workspace.path });
  const [hasBuildClaim, hasPublicationClaim] = await Promise.all([pathExists(buildClaimOutput), pathExists(claimPath)]);
  if (hasBuildClaim) {
    const buildClaim = await readBuildClaim({ path: buildClaimOutput, producer, spec, specification, workspace });
    if (hasPublicationClaim) {
      return recoverPublicationClaim({ buildClaim, claimPath, hooks, producer, receiptOutput, spec, specification, workspace });
    }
    return recoverAbortedBuildClaim({ buildClaim, hooks, receiptOutput, workspace });
  }
  invariant(!hasPublicationClaim, "Rebuild-Publikationsclaim besitzt keinen vor dem Build erzeugten Eigentumsclaim; automatische Recovery bleibt fail-closed.");
  invariant(!recoveryOnly, "Kein recoverbarer Rebuild-Build- oder Publikationsclaim vorhanden.");
  const sourceRepository = await regularDirectorySnapshot(sourceRoot, "sourceRepository");
  for (const [id, path] of Object.entries(outputs)) await assertCreateNewTarget(path, `Operational-Validator-Rebuild-${id}`);
  await assertCreateNewTarget(claimPath, "Operational-Validator-Rebuild-Publikationsclaim");
  await assertCreateNewTarget(buildClaimOutput, "Operational-Validator-Rebuild-Buildclaim");
  const preservedPath = resolveWorkspaceFile(workspace.path, spec.binaries.preserved.file, "binaries.preserved.file");
  const preserved = await regularFileSnapshot(workspace.path, preservedPath, "Preserved Validator", spec.pe.maxBinaryBytes);
  proofMatches(preserved.proof, spec.binaries.preserved, "Preserved Validator");
  const parentSnapshots = new Map();
  for (const path of [...Object.values(outputs), claimPath, buildClaimOutput]) {
    const parentPath = dirname(path);
    if (!parentSnapshots.has(pathKey(parentPath))) parentSnapshots.set(pathKey(parentPath), await regularDirectorySnapshot(parentPath, "Rebuild-Output-Elternverzeichnis"));
  }
  const binaryParent = parentSnapshots.get(pathKey(dirname(outputs.binary)));
  const staging = await createOwnedTemporaryDirectory(binaryParent.path, ".operational-validator-rebuild-v2-", "Privater Rebuild-Baum");
  const stagingRoot = staging.path;
  const published = [];
  const bindings = [];
  let buildClaimIdentity;
  let claimIdentity;
  let expectedProofs;
  let primaryError;
  let result;
  try {
    const buildClaimValue = createBuildClaim({
      parent: binaryParent,
      producer,
      specification,
      spec,
      staging,
      workspaceRoot: workspace.path,
    });
    const buildClaimBytes = canonicalBytes(buildClaimValue);
    await writeReceiptCreateNew(buildClaimOutput, buildClaimBytes, {});
    const buildClaimSource = await regularFileSnapshot(workspace.path, buildClaimOutput, "Rebuild-Buildclaim", MAX_JSON_BYTES);
    invariant(buildClaimSource.bytes.equals(buildClaimBytes), "Rebuild-Buildclaim driftet unmittelbar nach create-new.");
    buildClaimIdentity = buildClaimSource.identity;
    if (hooks.afterBuildClaim) await hooks.afterBuildClaim({ buildClaimPath: buildClaimOutput, stagingRoot });
    if (hooks.afterStagingCreated) await hooks.afterStagingCreated({ stagingRoot });
    const archivePath = resolve(stagingRoot, "source.tar");
    const sourceDirectory = resolve(stagingRoot, "source");
    const targetDirectory = resolve(stagingRoot, "target");
    await mkdir(targetDirectory, { recursive: false, mode: 0o700 });
    invariant((await readdir(targetDirectory)).length === 0, "Externer Cargo-Target-Pfad ist nicht leer.");
    const environmentBinding = controlledEnvironment(targetDirectory, spec);
    const resolvedExecutables = {
      cargo: await resolveCommand("cargo", environmentBinding.environment.PATH, "cargo"),
      git: await resolveCommand("git", environmentBinding.environment.PATH, "git"),
      rustc: await resolveCommand("rustc", environmentBinding.environment.PATH, "rustc"),
      tar: await resolveCommand("tar", environmentBinding.environment.PATH, "tar"),
    };
    const executableBindings = Object.fromEntries(await Promise.all(Object.entries(resolvedExecutables).map(async ([command, executable]) => [command, await bindExecutable(workspace.path, executable, command)])));
    const executables = Object.fromEntries(Object.entries(executableBindings).map(([command, binding]) => [command, binding.path]));
    await assertExecutableSetStillBound(executableBindings);
    const source = await sourceArchiveEvidence({
      archivePath,
      environment: environmentBinding.environment,
      executables,
      hooks,
      sourceDirectory,
      sourceRepository: sourceRepository.path,
      sourceRepositorySnapshot: sourceRepository,
      spec,
      stagingRoot,
    });
    const archive = await regularFileSnapshot(stagingRoot, archivePath, "Gestagetes Commit-Archiv", MAX_ARCHIVE_BYTES);
    auditPinnedSourceArchive(archive.bytes, spec);
    const cargoConfiguration = await auditExternalCargoConfiguration(sourceDirectory, environmentBinding.environment);
    environmentBinding.receipt.cargoConfiguration = cargoConfiguration;
    const toolchain = await inspectToolchain({ environment: environmentBinding.environment, executableBindings, sourceDirectory, spec });
    invariant((await readdir(targetDirectory)).length === 0, "Externer Cargo-Target-Pfad wurde vor dem Build beschrieben.");
    if (hooks.beforeBuild) await hooks.beforeBuild({ command: spec.build.command, sourceDirectory, targetDirectory });
    const buildResult = await runProcess(executables.cargo, spec.build.command.slice(1), { cwd: sourceDirectory, env: environmentBinding.environment, label: "Locked Operational-Validator-Rebuild" });
    if (hooks.afterBuild) await hooks.afterBuild({ buildResult, sourceDirectory, targetDirectory });
    await assertExecutableSetStillBound(executableBindings);
    invariant(sameCanonicalValue(await auditExternalCargoConfiguration(sourceDirectory, environmentBinding.environment), cargoConfiguration), "Externe Cargo-Konfigurationskandidaten drifteten waehrend des Builds.");
    const sourceTreeAfterBuild = await auditExtractedTree(sourceDirectory);
    invariant(sameCanonicalValue(sourceTreeAfterBuild, source.extractedTree), "Extrahierter Source-Tree driftet waehrend des Builds.");
    const cargoLockAfterBuild = await regularFileSnapshot(sourceDirectory, resolveWorkspaceFile(sourceDirectory, spec.source.cargoLock.file, "source.cargoLock.file"), "Archiviertes Cargo.lock nach Build", MAX_SPEC_BYTES);
    proofMatches(cargoLockAfterBuild.proof, spec.source.cargoLock, "Archiviertes Cargo.lock nach Build");
    const built = await regularFileSnapshot(targetDirectory, resolveWorkspaceFile(targetDirectory, spec.build.targetOutputFile, "build.targetOutputFile"), "Tatsaechlich gebauter Operational-Validator", spec.pe.maxBinaryBytes);
    invariant(built.proof.bytes === spec.binaries.rebuilt.expectedBytes, "Tatsaechlich gebauter Operational-Validator besitzt die falsche Bytezahl.");
    const pe = inspectPePair(preserved.bytes, built.bytes, spec);
    const binaries = { preserved: { file: spec.binaries.preserved.file, ...preserved.proof }, rebuilt: { file: spec.binaries.rebuilt.file, ...built.proof } };
    const build = {
      command: spec.build.command, environment: environmentBinding.receipt, exitCode: buildResult.code,
      logs: { stderr: encodedOutput(buildResult.stderr), stdout: encodedOutput(buildResult.stdout) },
      output: { file: spec.binaries.rebuilt.file, ...built.proof }, profile: spec.build.profile,
      targetDirectory: { initiallyEmpty: true, mode: spec.build.environmentPolicy.targetDirectory },
    };
    const specificationProof = { bytes: specification.bytes, file: specification.file, sha256: specification.sha256 };
    const provenanceValue = createBuildProvenance({ binaries, build, pe, producer, releaseId: spec.releaseId, source, specification: specificationProof, toolchain });
    const provenanceBytes = canonicalBytes(provenanceValue);
    invariant(provenanceBytes.length <= MAX_PROVENANCE_BYTES, "Build-Provenienz ist unerwartet gross.");
    const stagedProvenancePath = resolve(stagingRoot, "provenance.json");
    await writeReceiptCreateNew(stagedProvenancePath, provenanceBytes, {});
    const stagedProvenance = await regularFileSnapshot(stagingRoot, stagedProvenancePath, "Gestagete Build-Provenienz", MAX_PROVENANCE_BYTES);
    const receipt = { ...provenanceValue, provenance: { file: spec.provenance.file, ...stagedProvenance.proof }, schema: EVIDENCE_SCHEMA };
    delete receipt.chain;
    const receiptBytes = canonicalBytes(receipt);
    invariant(receiptBytes.length <= MAX_JSON_BYTES, "Operational-Validator-Rebuild-Receipt ist unerwartet gross.");
    const stagedReceiptPath = resolve(stagingRoot, "receipt.json");
    await writeReceiptCreateNew(stagedReceiptPath, receiptBytes, hooks);
    const stagedReceipt = await regularFileSnapshot(stagingRoot, stagedReceiptPath, "Gestagetes Rebuild-Receipt", MAX_JSON_BYTES);
    invariant(stagedReceipt.bytes.equals(receiptBytes), "Gestagetes Rebuild-Receipt driftet.");
    const claim = createPublicationClaim({
      archive, binary: built, producer, provenance: stagedProvenance,
      receipt: { ...stagedReceipt, outputPath: receiptOutput }, specification, spec, stagingRoot, workspaceRoot: workspace.path,
    });
    const claimBytes = canonicalBytes(claim);
    await writeReceiptCreateNew(claimPath, claimBytes, {});
    const claimSource = await regularFileSnapshot(workspace.path, claimPath, "Rebuild-Publikationsclaim", MAX_JSON_BYTES);
    invariant(claimSource.bytes.equals(claimBytes), "Rebuild-Publikationsclaim driftet nach dem Schreiben.");
    claimIdentity = claimSource.identity;
    expectedProofs = { archive: archive.proof, binary: built.proof, provenance: stagedProvenance.proof, receipt: stagedReceipt.proof };
    const stagedSources = { archive, binary: built, provenance: stagedProvenance, receipt: stagedReceipt };
    for (const id of ["archive", "provenance", "binary", "receipt"]) {
      const parent = parentSnapshots.get(pathKey(dirname(outputs[id])));
      await assertDirectoryIdentity(parent.path, parent.metadata, `Output-Elternverzeichnis vor ${id}-Link`);
      const binding = await publishCreateNew(stagedSources[id].path, outputs[id], `Operational-Validator-Rebuild-${id}`, stagedSources[id].identity, (entry) => published.push(entry), {
        afterLinkBeforeAudit: hooks.afterPublicationSourceLinkBeforeAudit
          ? (details) => hooks.afterPublicationSourceLinkBeforeAudit({ id, ...details })
          : undefined,
        parent,
      });
      bindings.push(binding);
      await assertDirectoryIdentity(parent.path, parent.metadata, `Output-Elternverzeichnis nach ${id}-Link`);
      if (id === "binary" && hooks.afterBuiltOutputLink) await hooks.afterBuiltOutputLink({ binaryOutput: outputs.binary, builtPath: built.path });
      if (id === "receipt" && hooks.afterReceiptLink) await hooks.afterReceiptLink({ binaryOutput: outputs.binary, receiptOutput });
      if (hooks.afterPublicationLink) await hooks.afterPublicationLink({ id, output: outputs[id], stagedPath: stagedSources[id].path });
    }
    const verification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
    invariant(verification.receipt.binaries.rebuilt.sha256 === built.proof.sha256, "Publiziertes Receipt bindet nicht den Build.");
    result = {
      archive: { path: outputs.archive, ...archive.proof }, binary: { path: outputs.binary, ...built.proof }, path: receiptOutput,
      proof: verification.proof, provenance: { path: outputs.provenance, ...stagedProvenance.proof }, receipt: verification.receipt,
    };
  } catch (error) { primaryError = error; }
  let cleanupError;
  let cleanupCompleted = false;
  try {
    await cleanupOwnedBuildRoot(binaryParent, stagingRoot, staging.metadata, hooks);
    cleanupCompleted = true;
  } catch (error) {
    cleanupError = error;
    cleanupCompleted = error?.cleanupCompleted === true;
  }
  if (!primaryError && !cleanupError) {
    try {
      if (hooks.afterBuildRootCleanupBeforeFinalAudit) await hooks.afterBuildRootCleanupBeforeFinalAudit({ outputs: { ...outputs } });
      for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Output-Elternverzeichnis unmittelbar nach Cleanup");
      for (const [index, id] of ["archive", "provenance", "binary", "receipt"].entries()) proofMatches(await proofFromHeldPublication(bindings[index], { archive: MAX_ARCHIVE_BYTES, provenance: MAX_PROVENANCE_BYTES, binary: MAX_BINARY_BYTES, receipt: MAX_JSON_BYTES }[id]), expectedProofs[id], `Post-Cleanup ${id}`);
      const verification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
      result.proof = verification.proof;
      result.receipt = verification.receipt;
    } catch (error) { primaryError = error; }
  }
  let closeError;
  try { await closePublicationBindings(bindings); } catch (error) { closeError = error; }
  if (primaryError || cleanupError || closeError) {
    let rollbackError;
    try { await rollbackPublished(published); } catch (error) { rollbackError = error; }
    let claimRollbackError;
    if (!rollbackError && cleanupCompleted && claimIdentity) {
      try {
        await removePublishedOwned(claimPath, claimIdentity, "Rebuild-Publikationsclaim");
        invariant(!(await pathExists(claimPath)), "Rebuild-Publikationsclaim blieb nach Fehler-Rollback sichtbar.");
      } catch (error) { claimRollbackError = error; }
    }
    let buildClaimRollbackError;
    if (!rollbackError && cleanupCompleted && buildClaimIdentity) {
      try {
        await removePublishedOwned(buildClaimOutput, buildClaimIdentity, "Rebuild-Buildclaim");
        invariant(!(await pathExists(buildClaimOutput)), "Rebuild-Buildclaim blieb nach Fehler-Rollback sichtbar.");
      } catch (error) { buildClaimRollbackError = error; }
    }
    const errors = [primaryError, cleanupError, closeError, rollbackError, claimRollbackError, buildClaimRollbackError].filter(Boolean);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Rebuild, Cleanup, Handle-Close oder owned-only Rollback ist fehlgeschlagen.");
  }
  await removePublishedOwned(claimPath, claimIdentity, "Rebuild-Publikationsclaim");
  invariant(!(await pathExists(claimPath)), "Rebuild-Publikationsclaim blieb nach erfolgreichem Abschluss sichtbar.");
  await removePublishedOwned(buildClaimOutput, buildClaimIdentity, "Rebuild-Buildclaim");
  invariant(!(await pathExists(buildClaimOutput)), "Rebuild-Buildclaim blieb nach erfolgreichem Abschluss sichtbar.");
  for (const parent of parentSnapshots.values()) await assertDirectoryIdentity(parent.path, parent.metadata, "Output-Elternverzeichnis nach Claim-Abschluss");
  const finalVerification = await verifyOperationalValidatorRebuildEvidence({ spec, receiptPath: receiptOutput, workspaceRoot: workspace.path });
  result.proof = finalVerification.proof;
  result.receipt = finalVerification.receipt;
  return result;
}

export async function verifyOperationalValidatorRebuildEvidence({ spec, receiptPath, workspaceRoot }) {
  validateOperationalValidatorRebuildSpec(spec);
  const workspace = await regularDirectorySnapshot(workspaceRoot, "workspaceRoot");
  const receiptFile = resolve(receiptPath);
  invariant(isContained(workspace.path, receiptFile), "receiptPath verlaesst workspaceRoot.");
  const source = await regularFileSnapshot(workspace.path, receiptFile, "Operational-Validator-Rebuild-Receipt", MAX_JSON_BYTES);
  const receipt = validateReceiptEnvelope(parseJson(source.bytes, "Operational-Validator-Rebuild-Receipt"), spec);
  invariant(source.bytes.equals(canonicalBytes(receipt)), "Operational-Validator-Rebuild-Receipt ist nicht kanonisch serialisiert.");
  const specificationPath = resolveWorkspaceFile(workspace.path, receipt.specification.file, "Receipt.specification.file");
  const specification = await regularFileSnapshot(workspace.path, specificationPath, "Rebuild-Spec", MAX_SPEC_BYTES);
  proofMatches(specification.proof, receipt.specification, "Rebuild-Spec");
  invariant(specification.bytes.equals(canonicalBytes(spec)), "Aktuelle Rebuild-Spec ist nicht kanonisch oder driftet.");
  const preservedPath = resolveWorkspaceFile(workspace.path, spec.binaries.preserved.file, "binaries.preserved.file");
  const rebuiltPath = resolveWorkspaceFile(workspace.path, spec.binaries.rebuilt.file, "binaries.rebuilt.file");
  const archivePath = resolveWorkspaceFile(workspace.path, spec.source.archive.file, "source.archive.file");
  const provenancePath = resolveWorkspaceFile(workspace.path, spec.provenance.file, "provenance.file");
  const [preserved, rebuilt, archive, provenanceSource] = await Promise.all([
    regularFileSnapshot(workspace.path, preservedPath, "Preserved Validator", spec.pe.maxBinaryBytes),
    regularFileSnapshot(workspace.path, rebuiltPath, "Official Rebuilt Validator", spec.pe.maxBinaryBytes),
    regularFileSnapshot(workspace.path, archivePath, "Persistiertes Commit-Archiv", MAX_ARCHIVE_BYTES),
    regularFileSnapshot(workspace.path, provenancePath, "Persistierte Build-Provenienz", MAX_PROVENANCE_BYTES),
  ]);
  proofMatches(preserved.proof, spec.binaries.preserved, "Preserved Validator");
  proofMatches(preserved.proof, receipt.binaries.preserved, "Receipt-Preserved-Validator");
  proofMatches(rebuilt.proof, receipt.binaries.rebuilt, "Receipt-Official-Rebuilt-Validator");
  proofMatches(rebuilt.proof, receipt.build.output, "Receipt-Build-Output");
  invariant(rebuilt.proof.bytes === spec.binaries.rebuilt.expectedBytes, "Official Rebuilt Validator besitzt die falsche Bytezahl.");
  proofMatches(archive.proof, spec.source.archive, "Persistiertes Commit-Archiv");
  proofMatches(archive.proof, { bytes: receipt.source.archive.bytes, sha256: receipt.source.archive.sha256 }, "Receipt-Commit-Archiv");
  const archiveAudit = auditPinnedSourceArchive(archive.bytes, spec);
  invariant(sameCanonicalValue(archiveAudit.cargoLock, receipt.source.cargoLock), "Receipt-Cargo.lock driftet vom nativ auditierten Commit-TAR.");
  invariant(sameCanonicalValue(archiveAudit.extractedTree, receipt.source.extractedTree), "Receipt-Source-Tree driftet vom nativ auditierten Commit-TAR.");
  proofMatches(provenanceSource.proof, receipt.provenance, "Receipt-Build-Provenienz");
  invariant(provenanceSource.bytes.equals(canonicalBytes(parseJson(provenanceSource.bytes, "Build-Provenienz"))), "Build-Provenienz ist nicht kanonisch serialisiert.");
  const provenance = validateBuildProvenance(parseJson(provenanceSource.bytes, "Build-Provenienz"), spec);
  for (const field of ["binaries", "build", "pe", "producer", "source", "specification", "toolchain"]) {
    invariant(sameCanonicalValue(provenance[field], receipt[field]), `Receipt.${field} driftet von der content-addressed Build-Provenienz.`);
  }
  const pe = inspectPePair(preserved.bytes, rebuilt.bytes, spec);
  invariant(sameCanonicalValue(pe, receipt.pe), "Receipt-PE-Evidenz driftet von den aktuellen Binaries.");
  for (const id of ["bootstrap", "entrypoint", "implementation"]) {
    const path = resolveWorkspaceFile(workspace.path, spec.producer[id].file, `producer.${id}.file`);
    const producer = await regularFileSnapshot(workspace.path, path, `Producer ${id}`, MAX_PRODUCER_BYTES);
    proofMatches(producer.proof, receipt.producer[id], `Receipt-Producer ${id}`);
  }
  return { proof: source.proof, receipt };
}
