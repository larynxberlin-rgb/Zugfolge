import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadBoundOperationalValidatorRebuildImplementation } from "./operational-validator-rebuild-bootstrap.mjs";
import { validateOperationalValidatorRebuildSpec } from "./operational-validator-rebuild-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = join(HERE, "operational-validator-rebuild-bootstrap.mjs");
const ENTRYPOINT_PATH = join(HERE, "operational-validator-rebuild-evidence-cli.mjs");
const IMPLEMENTATION_PATH = join(HERE, "operational-validator-rebuild-evidence.mjs");
const PRODUCTION_SPEC_PATH = join(HERE, "operational-validator-rebuild.annual-2026.5.json");
const REPOSITORY_ROOT = dirname(dirname(dirname(HERE)));
const WINDOWS_BUILD = { skip: process.platform !== "win32" };

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`, "utf8");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function proof(bytes) {
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function producerPins(paths) {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([id, path]) => {
    const bytes = await readFile(path);
    return [id, { bytes: bytes.length, file: `tools/region-import/germany/${path.split(/[\\/]/).at(-1)}`, sha256: sha256(bytes) }];
  })));
}

function provenanceChain(value) {
  const sourceSha256 = sha256(canonicalBytes({ producer: value.producer, releaseId: value.releaseId, source: value.source, specification: value.specification }));
  const buildSha256 = sha256(canonicalBytes({ previousSha256: sourceSha256, build: value.build, toolchain: value.toolchain }));
  const outputSha256 = sha256(canonicalBytes({ previousSha256: buildSha256, binaries: value.binaries, pe: value.pe }));
  return { algorithm: "sha256-canonical-json-chain/v1", buildSha256, outputSha256, sourceSha256 };
}

function environmentValue(name) {
  const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : process.env[key];
}

function controlledTestEnvironment(spec, targetDirectory) {
  const environment = {};
  for (const name of spec.build.environmentPolicy.allowedInherited) {
    let value = environmentValue(name);
    if (!value && name === "CARGO_HOME") value = join(environmentValue("USERPROFILE") ?? environmentValue("HOME"), ".cargo");
    if (!value && name === "RUSTUP_HOME") value = join(environmentValue("USERPROFILE") ?? environmentValue("HOME"), ".rustup");
    if (value) environment[name] = value;
  }
  Object.assign(environment, spec.build.environmentPolicy.fixed, { CARGO_TARGET_DIR: targetDirectory });
  return environment;
}

function run(file, arguments_, { cwd, env = process.env, expectFailure = false } = {}) {
  return new Promise((resolveResult, reject) => {
    execFile(file, arguments_, { cwd, encoding: "buffer", env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const result = { error, stderr: Buffer.from(stderr ?? []), stdout: Buffer.from(stdout ?? []) };
      if (expectFailure || !error) resolveResult(result);
      else reject(new Error(`${file} ${arguments_.join(" ")} ist fehlgeschlagen: ${result.stderr.toString("utf8")}`, { cause: error }));
    });
  });
}

async function renameEventually(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (error?.code !== "EPERM" || attempt === 19) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }
}

function parseVerbose(bytes) {
  const lines = bytes.toString("utf8").replace(/\r\n/g, "\n").trim().split("\n");
  const values = new Map();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

async function currentToolchain(cwd) {
  const [cargoResult, rustcResult] = await Promise.all([
    run("cargo", ["-vV"], { cwd }),
    run("rustc", ["-vV"], { cwd }),
  ]);
  const cargo = parseVerbose(cargoResult.stdout);
  const rustc = parseVerbose(rustcResult.stdout);
  return {
    cargo: { commitHash: cargo.get("commit-hash"), host: cargo.get("host"), release: cargo.get("release") },
    rustc: {
      commitHash: rustc.get("commit-hash"),
      host: rustc.get("host"),
      llvmVersion: rustc.get("LLVM version"),
      release: rustc.get("release"),
    },
  };
}

function normalizedSha256(bytes) {
  const normalized = Buffer.from(bytes);
  normalized.fill(0, 136, 140);
  normalized.fill(0, 216, 220);
  return sha256(normalized);
}

function peSections(bytes) {
  const peOffset = bytes.readUInt32LE(0x3c);
  const coffOffset = peOffset + 4;
  const count = bytes.readUInt16LE(coffOffset + 2);
  const optionalBytes = bytes.readUInt16LE(coffOffset + 16);
  const table = coffOffset + 20 + optionalBytes;
  return Array.from({ length: count }, (_, index) => {
    const offset = table + index * 40;
    const rawName = bytes.subarray(offset, offset + 8);
    const zero = rawName.indexOf(0);
    return {
      name: (zero < 0 ? rawName : rawName.subarray(0, zero)).toString("ascii"),
      offset,
      rawBytes: bytes.readUInt32LE(offset + 16),
      rawPointer: bytes.readUInt32LE(offset + 20),
    };
  });
}

async function persistSpec(value) {
  value.specBytes = canonicalBytes(value.spec);
  await writeFile(value.specPath, value.specBytes);
}

async function loadFixtureImplementation(value, hooks = {}) {
  return loadBoundOperationalValidatorRebuildImplementation({
    bootstrapPath: value.producerPaths.bootstrap,
    entrypointPath: value.producerPaths.entrypoint,
    implementationPath: value.producerPaths.implementation,
    workspaceRoot: value.workspaceRoot,
    expectedProducerProofs: value.spec.producer,
    hooks,
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-rebuild-v2-test-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const workspaceRoot = join(root, "workspace");
  const sourceRoot = join(root, "source-repository");
  const baselineTarget = join(root, "baseline-target");
  const producerRoot = join(workspaceRoot, "tools", "region-import", "germany");
  const artifactRoot = join(workspaceRoot, "artifacts");
  await mkdir(join(sourceRoot, "src"), { recursive: true });
  await mkdir(producerRoot, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(join(sourceRoot, ".gitattributes"), "* text=auto eol=lf\n");
  await writeFile(join(sourceRoot, ".gitignore"), "/ignored-input.txt\n/target\n");
  await writeFile(join(sourceRoot, "Cargo.toml"), [
    "[package]",
    'name = "zugfolge-infra"',
    'version = "0.1.0"',
    'edition = "2024"',
    "",
    "[[bin]]",
    'name = "zugfolge-infra-release"',
    'path = "src/main.rs"',
    "",
  ].join("\n"));
  await writeFile(join(sourceRoot, "Cargo.lock"), [
    "# This file is automatically @generated by Cargo.",
    "# It is not intended for manual editing.",
    "version = 4",
    "",
    "[[package]]",
    'name = "zugfolge-infra"',
    'version = "0.1.0"',
    "",
  ].join("\n"));
  await writeFile(join(sourceRoot, "src", "main.rs"), 'fn main() { println!("operational rebuild fixture"); }\n');
  await run("git", ["init", "-q"], { cwd: sourceRoot });
  await run("git", ["add", ".gitattributes", ".gitignore", "Cargo.toml", "Cargo.lock", "src/main.rs"], { cwd: sourceRoot });
  await run("git", ["-c", "user.name=Zugfolge Test", "-c", "user.email=test@invalid.example", "commit", "-qm", "fixture"], { cwd: sourceRoot });
  let commit = (await run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.toString("utf8").trim();

  const productionSpec = JSON.parse(await readFile(PRODUCTION_SPEC_PATH, "utf8"));
  await mkdir(baselineTarget);
  await run("cargo", productionSpec.build.command.slice(1), {
    cwd: sourceRoot,
    env: controlledTestEnvironment(productionSpec, baselineTarget),
  });
  await run("git", ["add", "Cargo.lock"], { cwd: sourceRoot });
  await run("git", ["-c", "user.name=Zugfolge Test", "-c", "user.email=test@invalid.example", "commit", "--amend", "-qm", "fixture"], { cwd: sourceRoot });
  commit = (await run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.toString("utf8").trim();
  const preserved = await readFile(join(baselineTarget, productionSpec.build.targetOutputFile));
  assert.deepEqual(peSections(preserved).map(({ name }) => name), productionSpec.pe.sections.map(({ name }) => name));

  const producerPaths = {
    bootstrap: join(producerRoot, "operational-validator-rebuild-bootstrap.mjs"),
    entrypoint: join(producerRoot, "operational-validator-rebuild-evidence-cli.mjs"),
    implementation: join(producerRoot, "operational-validator-rebuild-evidence.mjs"),
  };
  await Promise.all([
    copyFile(BOOTSTRAP_PATH, producerPaths.bootstrap),
    copyFile(ENTRYPOINT_PATH, producerPaths.entrypoint),
    copyFile(IMPLEMENTATION_PATH, producerPaths.implementation),
  ]);
  const preservedPath = join(artifactRoot, "preserved.exe");
  const rebuiltPath = join(artifactRoot, "rebuilt-official.exe");
  const archivePath = join(artifactRoot, "source.tar");
  const provenancePath = join(artifactRoot, "provenance.json");
  const outputPath = join(artifactRoot, "receipt.json");
  await writeFile(preservedPath, preserved);
  const cargoLock = (await run("git", ["show", `${commit}:Cargo.lock`], { cwd: sourceRoot })).stdout;
  const archiveBytes = (await run("git", ["archive", "--format=tar", commit], { cwd: sourceRoot })).stdout;
  const spec = structuredClone(productionSpec);
  spec.binaries = {
    preserved: { bytes: preserved.length, file: "artifacts/preserved.exe", sha256: sha256(preserved) },
    rebuilt: { expectedBytes: preserved.length, file: "artifacts/rebuilt-official.exe" },
  };
  spec.pe.normalizedSha256 = normalizedSha256(preserved);
  spec.producer = await producerPins(producerPaths);
  spec.provenance = { file: "artifacts/provenance.json" };
  spec.source = {
    archive: { bytes: archiveBytes.length, file: "artifacts/source.tar", format: "tar", sha256: sha256(archiveBytes) },
    cargoLock: { bytes: cargoLock.length, file: "Cargo.lock", sha256: sha256(cargoLock) },
    commit,
  };
  spec.toolchain = await currentToolchain(sourceRoot);
  const specPath = join(producerRoot, "fixture-spec.json");
  const value = { archivePath, artifactRoot, outputPath, preserved, preservedPath, producerPaths, provenancePath, rebuiltPath, root, sourceRoot, spec, specPath, workspaceRoot };
  await persistSpec(value);
  const loaded = await loadFixtureImplementation(value);
  value.implementation = loaded.implementation;
  value.producerProofs = loaded.producerProofs;
  return value;
}

function materialize(value, options = {}) {
  return value.implementation.materializeOperationalValidatorRebuildEvidence({
    outputPath: value.outputPath,
    producerProofs: value.producerProofs,
    sourceRoot: value.sourceRoot,
    spec: value.spec,
    specBytes: value.specBytes,
    specFile: value.specPath,
    workspaceRoot: value.workspaceRoot,
    ...options,
  });
}

function verify(value) {
  return value.implementation.verifyOperationalValidatorRebuildEvidence({
    receiptPath: value.outputPath,
    spec: value.spec,
    workspaceRoot: value.workspaceRoot,
  });
}

async function resetPublished(value, binaryBytes, receiptBytes, provenanceBytes) {
  await writeFile(value.rebuiltPath, binaryBytes);
  await writeFile(value.outputPath, receiptBytes);
  await writeFile(value.provenancePath, provenanceBytes);
}

async function rewriteReceiptForBinary(value, bytes) {
  const receipt = JSON.parse(await readFile(value.outputPath, "utf8"));
  const provenance = JSON.parse(await readFile(value.provenancePath, "utf8"));
  const currentProof = proof(bytes);
  receipt.binaries.rebuilt = { file: value.spec.binaries.rebuilt.file, ...currentProof };
  receipt.build.output = { file: value.spec.binaries.rebuilt.file, ...currentProof };
  provenance.binaries.rebuilt = { file: value.spec.binaries.rebuilt.file, ...currentProof };
  provenance.build.output = { file: value.spec.binaries.rebuilt.file, ...currentProof };
  provenance.chain = provenanceChain(provenance);
  const provenanceBytes = canonicalBytes(provenance);
  await writeFile(value.provenancePath, provenanceBytes);
  receipt.provenance = { file: value.spec.provenance.file, ...proof(provenanceBytes) };
  await writeFile(value.outputPath, canonicalBytes(receipt));
}

test("2026.5-v2-Spec ist kanonisch und pinnt Build, Isolation und PE-Vertrag", async () => {
  const bytes = await readFile(PRODUCTION_SPEC_PATH);
  const spec = JSON.parse(bytes.toString("utf8"));
  validateOperationalValidatorRebuildSpec(spec);
  assert.ok(bytes.equals(canonicalBytes(spec)));
  assert.equal(spec.schema, "zugfolge-operational-validator-rebuild-spec/v2");
  assert.equal(spec.source.commit, "ee6d7081b32277e46cd6ebb28fc65bd45ce55012");
  assert.deepEqual(spec.build.command, ["cargo", "build", "--locked", "--release", "-p", "zugfolge-infra", "--bin", "zugfolge-infra-release"]);
  assert.equal(spec.build.environmentPolicy.targetDirectory, "external-empty-create-new");
  assert.equal(spec.binaries.rebuilt.sha256, undefined);
  assert.match(spec.binaries.rebuilt.file, /-official\.exe$/);
});

test("Bootstrap bindet die vollstaendige lokale Import-Closure vor data:-Import", async () => {
  const spec = JSON.parse(await readFile(PRODUCTION_SPEC_PATH, "utf8"));
  const loaded = await loadBoundOperationalValidatorRebuildImplementation({
    bootstrapPath: BOOTSTRAP_PATH,
    entrypointPath: ENTRYPOINT_PATH,
    implementationPath: IMPLEMENTATION_PATH,
    workspaceRoot: REPOSITORY_ROOT,
    expectedProducerProofs: spec.producer,
  });
  assert.deepEqual(Object.keys(loaded.implementation).sort(), [
    "materializeOperationalValidatorRebuildEvidence",
    "validateOperationalValidatorRebuildSpec",
    "verifyOperationalValidatorRebuildEvidence",
  ]);
  assert.deepEqual(Object.keys(loaded.producerProofs).sort(), ["bootstrap", "entrypoint", "implementation"]);
});

test("Bootstrap verwirft Producer-Tausch zwischen Handle-Bindung und Import", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-rebuild-bootstrap-swap-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const producerRoot = join(root, "tools", "region-import", "germany");
  await mkdir(producerRoot, { recursive: true });
  const paths = {
    bootstrap: join(producerRoot, "operational-validator-rebuild-bootstrap.mjs"),
    entrypoint: join(producerRoot, "operational-validator-rebuild-evidence-cli.mjs"),
    implementation: join(producerRoot, "operational-validator-rebuild-evidence.mjs"),
  };
  await Promise.all([copyFile(BOOTSTRAP_PATH, paths.bootstrap), copyFile(ENTRYPOINT_PATH, paths.entrypoint), copyFile(IMPLEMENTATION_PATH, paths.implementation)]);
  const expectedProducerProofs = await producerPins(paths);
  await assert.rejects(
    loadBoundOperationalValidatorRebuildImplementation({
      bootstrapPath: paths.bootstrap,
      entrypointPath: paths.entrypoint,
      implementationPath: paths.implementation,
      workspaceRoot: root,
      expectedProducerProofs,
      hooks: { afterProducerBinding: async () => appendFile(paths.implementation, "\n// producer swap\n") },
    }),
    /driftete|ersetzt|veraendert/,
  );
});

test("Bootstrap verwirft extern ungepinnte Producer-Substitution vor dem Import", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-rebuild-bootstrap-pin-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const producerRoot = join(root, "tools", "region-import", "germany");
  await mkdir(producerRoot, { recursive: true });
  const paths = {
    bootstrap: join(producerRoot, "operational-validator-rebuild-bootstrap.mjs"),
    entrypoint: join(producerRoot, "operational-validator-rebuild-evidence-cli.mjs"),
    implementation: join(producerRoot, "operational-validator-rebuild-evidence.mjs"),
  };
  await Promise.all([copyFile(BOOTSTRAP_PATH, paths.bootstrap), copyFile(ENTRYPOINT_PATH, paths.entrypoint), copyFile(IMPLEMENTATION_PATH, paths.implementation)]);
  const expectedProducerProofs = await producerPins(paths);
  await appendFile(paths.implementation, "\n// ungepinnte Producer-Substitution\n");
  await assert.rejects(loadBoundOperationalValidatorRebuildImplementation({
    bootstrapPath: paths.bootstrap,
    entrypointPath: paths.entrypoint,
    implementationPath: paths.implementation,
    workspaceRoot: root,
    expectedProducerProofs,
  }), /externen Spec-Pin/);
});

test("reale Bootstrap-CLI baut aus Commit-Archiv und Verify braucht danach kein Source-Repo", WINDOWS_BUILD, async (t) => {
  const value = await fixture(t);
  await appendFile(join(value.sourceRoot, "src", "main.rs"), "this dirty tracked text is not Rust\n");
  await writeFile(join(value.sourceRoot, "untracked-input.rs"), "not part of commit\n");
  await writeFile(join(value.sourceRoot, "ignored-input.txt"), "ignored\n");
  await run("git", ["update-index", "--assume-unchanged", "src/main.rs"], { cwd: value.sourceRoot });
  const cli = await run(process.execPath, [value.producerPaths.entrypoint, "materialize", value.specPath, value.sourceRoot, value.outputPath, value.workspaceRoot], { cwd: value.workspaceRoot });
  const cliResult = JSON.parse(cli.stdout.toString("utf8"));
  assert.equal(cliResult.binary.path, value.rebuiltPath);
  const receipt = JSON.parse(await readFile(value.outputPath, "utf8"));
  assert.equal(receipt.schema, "zugfolge-operational-validator-rebuild-evidence/v2");
  assert.equal(receipt.source.git.commit, value.spec.source.commit);
  assert.equal(receipt.source.git.isolation, "git-archive-commit");
  assert.deepEqual(receipt.build.command, value.spec.build.command);
  assert.equal(receipt.build.exitCode, 0);
  assert.equal(receipt.binaries.rebuilt.sha256, sha256(await readFile(value.rebuiltPath)));
  await rm(value.sourceRoot, { recursive: true, force: true });
  const verified = await verify(value);
  assert.equal(verified.receipt.binaries.rebuilt.sha256, receipt.binaries.rebuilt.sha256);
});

test("Buildfehler und Source-Tamper blockieren beide create-new Outputs", WINDOWS_BUILD, async (t) => {
  await t.test("Cargo wird wirklich aufgerufen; ungueltiger archivierter Source bricht ab", async (st) => {
    const value = await fixture(st);
    let invoked = false;
    await assert.rejects(materialize(value, {
      hooks: {
        beforeBuild: async ({ sourceDirectory }) => {
          invoked = true;
          await writeFile(join(sourceDirectory, "src", "main.rs"), "not valid Rust\n");
        },
      },
    }), /Locked Operational-Validator-Rebuild|Source-Tree driftet/);
    assert.equal(invoked, true);
    await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
  });

  await t.test("archiviertes Cargo.lock muss exakt der Spec entsprechen", async (st) => {
    const value = await fixture(st);
    await appendFile(join(value.sourceRoot, "Cargo.lock"), "# drift\n");
    await run("git", ["add", "Cargo.lock"], { cwd: value.sourceRoot });
    await run("git", ["-c", "user.name=Zugfolge Test", "-c", "user.email=test@invalid.example", "commit", "-qm", "lock drift"], { cwd: value.sourceRoot });
    value.spec.source.commit = (await run("git", ["rev-parse", "HEAD"], { cwd: value.sourceRoot })).stdout.toString("utf8").trim();
    const archiveBytes = (await run("git", ["archive", "--format=tar", value.spec.source.commit], { cwd: value.sourceRoot })).stdout;
    value.spec.source.archive = { ...value.spec.source.archive, bytes: archiveBytes.length, sha256: sha256(archiveBytes) };
    await persistSpec(value);
    await assert.rejects(materialize(value), /Archiviertes Cargo\.lock/);
    await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
  });

  await t.test("Source-Tree wird nach erfolgreichem Build erneut bytegebunden auditiert", async (st) => {
    const value = await fixture(st);
    await assert.rejects(materialize(value, {
      hooks: { afterBuild: async ({ sourceDirectory }) => appendFile(join(sourceDirectory, "src", "main.rs"), "// post-build drift\n") },
    }), /Source-Tree driftet waehrend des Builds/);
    await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
  });

  await t.test("fehlender Commit und Toolchain-Drift werden vor Publikation verworfen", async (st) => {
    const missingCommit = await fixture(st);
    missingCommit.spec.source.commit = "f".repeat(40);
    await persistSpec(missingCommit);
    await assert.rejects(materialize(missingCommit), /git rev-parse commit/);

    const wrongToolchain = await fixture(st);
    wrongToolchain.spec.toolchain.cargo.release = "1.94.0";
    await persistSpec(wrongToolchain);
    await assert.rejects(materialize(wrongToolchain), /cargo-Toolchain driftet/);
    await assert.rejects(stat(wrongToolchain.outputPath), { code: "ENOENT" });
    await assert.rejects(stat(wrongToolchain.rebuiltPath), { code: "ENOENT" });
  });

  await t.test("nicht archivgebundene Cargo-Konfiguration in einem Elternpfad ist verboten", async (st) => {
    const value = await fixture(st);
    await assert.rejects(materialize(value, {
      hooks: {
        afterStagingCreated: async () => {
          const cargoDirectory = join(value.artifactRoot, ".cargo");
          await mkdir(cargoDirectory);
          await writeFile(join(cargoDirectory, "config.toml"), "[build]\nrustflags = [\"--cfg\", \"external_input\"]\n");
        },
      },
    }), /nicht archivgebundener Cargo-Input verboten/);
    await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
  });
});

test("kontrollierte Umgebung ignoriert RUSTFLAGS und Receipt bindet die Policy", WINDOWS_BUILD, async (t) => {
  const value = await fixture(t);
  const previous = process.env.RUSTFLAGS;
  process.env.RUSTFLAGS = "-Cthis-is-not-a-valid-rustc-option";
  try {
    const result = await materialize(value);
    assert.ok(result.receipt.build.environment.cleared.includes("RUSTFLAGS"));
    assert.equal(result.receipt.build.environment.fixed.CARGO_NET_OFFLINE, "true");
  } finally {
    if (previous === undefined) delete process.env.RUSTFLAGS;
    else process.env.RUSTFLAGS = previous;
  }
});

test("PE-/Receipt-Verifier faellt bei Code, Header, Sections und Nichtkanonizitaet geschlossen", WINDOWS_BUILD, async (t) => {
  const value = await fixture(t);
  await materialize(value);
  const originalBinary = await readFile(value.rebuiltPath);
  const originalReceipt = await readFile(value.outputPath);
  const originalProvenance = await readFile(value.provenancePath);

  await t.test("Raw-Code-Drift", async () => {
    const mutated = Buffer.from(originalBinary);
    const text = peSections(mutated).find(({ name }) => name === ".text");
    mutated[text.rawPointer] ^= 0x01;
    await writeFile(value.rebuiltPath, mutated);
    await rewriteReceiptForBinary(value, mutated);
    await assert.rejects(verify(value), /PE-Section \.text besitzt verschiedene Raw-SHA-256/);
    await resetPublished(value, originalBinary, originalReceipt, originalProvenance);
  });

  await t.test("zusaetzliche Header-Differenz", async () => {
    const mutated = Buffer.from(originalBinary);
    mutated[8] ^= 0x01;
    await writeFile(value.rebuiltPath, mutated);
    await rewriteReceiptForBinary(value, mutated);
    await assert.rejects(verify(value), /nicht erlaubten Offset 8/);
    await resetPublished(value, originalBinary, originalReceipt, originalProvenance);
  });

  await t.test("Section-Name oder -Reihenfolge", async () => {
    const mutated = Buffer.from(originalBinary);
    const first = peSections(mutated)[0];
    mutated.fill(0, first.offset, first.offset + 8);
    mutated.write(".bad", first.offset, "ascii");
    await writeFile(value.rebuiltPath, mutated);
    await rewriteReceiptForBinary(value, mutated);
    await assert.rejects(verify(value), /Name oder Reihenfolge/);
    await resetPublished(value, originalBinary, originalReceipt, originalProvenance);
  });

  await t.test("nichtkanonisches Receipt", async () => {
    await appendFile(value.outputPath, "\n");
    await assert.rejects(verify(value), /nicht kanonisch serialisiert/);
    await writeFile(value.outputPath, originalReceipt);
  });

  await t.test("handgeschriebenes kanonisches Receipt ohne passenden Provenienzbeleg", async () => {
    const forged = JSON.parse(originalReceipt.toString("utf8"));
    forged.source.git.tree = "f".repeat(40);
    await writeFile(value.outputPath, canonicalBytes(forged));
    await assert.rejects(verify(value), /content-addressed Build-Provenienz/);
    await writeFile(value.outputPath, originalReceipt);
  });

  await t.test("falscher Normalisierungs-Offset", () => {
    const spec = structuredClone(value.spec);
    spec.pe.allowedNormalizationFields[0].offset = 135;
    assert.throws(() => validateOperationalValidatorRebuildSpec(spec), /allowedNormalizationFields/);
  });

  await t.test("Buildkommando- und Toolchain-Drift", () => {
    const command = structuredClone(value.spec);
    command.build.command[2] = "--offline";
    assert.throws(() => validateOperationalValidatorRebuildSpec(command), /build\.command/);
    const toolchain = structuredClone(value.spec);
    toolchain.toolchain.cargo.release = "1.94.0";
    assert.doesNotThrow(() => validateOperationalValidatorRebuildSpec(toolchain));
  });
});

test("create-new-Paar wird bei vorhandenen Zielen und Faults nicht teilweise publiziert", WINDOWS_BUILD, async (t) => {
  await t.test("vorhandenes Receipt blockiert vor dem Build", async (st) => {
    const value = await fixture(st);
    await writeFile(value.outputPath, "existing\n");
    await assert.rejects(materialize(value), /existiert bereits/);
    assert.equal(await readFile(value.outputPath, "utf8"), "existing\n");
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
  });

  await t.test("Fehler nach Binary-Link rollt nur das eigene Binary zurueck", async (st) => {
    const value = await fixture(st);
    await assert.rejects(materialize(value, {
      hooks: { afterBuiltOutputLink: async () => { throw new Error("injected after binary link"); } },
    }), /injected after binary link/);
    await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
    assert.deepEqual((await readdir(value.artifactRoot)).sort(), ["preserved.exe"]);
  });

  await t.test("Receipt-Schreibfehler publiziert gar nichts", async (st) => {
    const value = await fixture(st);
    await assert.rejects(materialize(value, {
      hooks: { duringReceiptWrite: async () => { throw new Error("injected receipt write"); } },
    }), /injected receipt write/);
    await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
  });

  await t.test("Fehler nach Receipt-Link rollt das vollstaendige Paar zurueck", async (st) => {
    const value = await fixture(st);
    await assert.rejects(materialize(value, {
      hooks: { afterReceiptLink: async () => { throw new Error("injected after receipt link"); } },
    }), /injected after receipt link/);
    await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
    assert.deepEqual((await readdir(value.artifactRoot)).sort(), ["preserved.exe"]);
  });

  await t.test("mkdtemp- und Cleanup-Faults hinterlassen weder Output noch privaten Baum", async (st) => {
    const value = await fixture(st);
    await assert.rejects(materialize(value, {
      hooks: {
        afterStagingCreated: async () => { throw new Error("injected after mkdtemp"); },
        beforeBuildRootQuarantine: async () => { throw new Error("injected before quarantine"); },
      },
    }), /Rebuild, Cleanup|injected/);
    await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
    assert.deepEqual((await readdir(value.artifactRoot)).sort(), ["preserved.exe"]);
  });
});

test("echter Prozess-Kill zwischen Binary- und Receipt-Link ist typisiert recoverbar", WINDOWS_BUILD, async (t) => {
  const value = await fixture(t);
  const driverPath = join(dirname(value.producerPaths.entrypoint), "kill-after-binary-link.mjs");
  await writeFile(driverPath, [
    'import { readFile } from "node:fs/promises";',
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'import { loadBoundOperationalValidatorRebuildImplementation } from "./operational-validator-rebuild-bootstrap.mjs";',
    'const [specPath, sourceRoot, outputPath, workspaceRoot] = process.argv.slice(2);',
    'const specBytes = await readFile(specPath);',
    'const spec = JSON.parse(specBytes.toString("utf8"));',
    'const here = dirname(fileURLToPath(import.meta.url));',
    'const loaded = await loadBoundOperationalValidatorRebuildImplementation({',
    '  bootstrapPath: resolve(here, "operational-validator-rebuild-bootstrap.mjs"),',
    '  entrypointPath: resolve(here, "operational-validator-rebuild-evidence-cli.mjs"),',
    '  implementationPath: resolve(here, "operational-validator-rebuild-evidence.mjs"),',
    '  workspaceRoot, expectedProducerProofs: spec.producer,',
    '});',
    'await loaded.implementation.materializeOperationalValidatorRebuildEvidence({',
    '  spec, specBytes, specFile: specPath, workspaceRoot, sourceRoot, outputPath, producerProofs: loaded.producerProofs,',
    '  hooks: { afterBuiltOutputLink: async () => process.exit(91) },',
    '});',
    '',
  ].join("\n"));
  const killed = await run(process.execPath, [driverPath, value.specPath, value.sourceRoot, value.outputPath, value.workspaceRoot], { cwd: value.workspaceRoot, expectFailure: true });
  assert.equal(killed.error?.code, 91);
  assert.equal((await stat(value.rebuiltPath)).size, value.spec.binaries.rebuilt.expectedBytes);
  await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
  const claimPath = `${value.outputPath}.publication-claim.json`;
  assert.ok((await stat(claimPath)).size > 0);
  const recovered = await run(process.execPath, [value.producerPaths.entrypoint, "recover", value.specPath, value.outputPath, value.workspaceRoot], { cwd: value.workspaceRoot });
  const result = JSON.parse(recovered.stdout.toString("utf8"));
  assert.equal(result.recovery.stagingRetained, false);
  await assert.rejects(stat(result.recovery.staging), { code: "ENOENT" });
  await assert.rejects(stat(claimPath), { code: "ENOENT" });
  await assert.rejects(stat(`${value.outputPath}.build-claim.json`), { code: "ENOENT" });
  assert.equal((await verify(value)).receipt.schema, "zugfolge-operational-validator-rebuild-evidence/v2");
});

test("Publikations-Races liefern keinen stale success und loeschen keine fremden Outputs", WINDOWS_BUILD, async (t) => {
  await t.test("Source-Tausch unmittelbar nach Link wird owned-only zurueckgerollt", async (st) => {
    const value = await fixture(st);
    await assert.rejects(materialize(value, {
      hooks: {
        afterPublicationSourceLinkBeforeAudit: async ({ id, path }) => {
          if (id !== "binary") return;
          await rename(path, `${path}.detached-owned`);
          await writeFile(path, "foreign staged source\n");
        },
      },
    }), /Quelle wurde|gebundener create-new Hardlink/);
    await assert.rejects(stat(value.rebuiltPath), { code: "ENOENT" });
    await assert.rejects(stat(value.outputPath), { code: "ENOENT" });
    assert.deepEqual((await readdir(value.artifactRoot)).sort(), ["preserved.exe"]);
  });

  for (const target of ["binary", "receipt"]) {
    await t.test(`${target}-Tausch im Post-Cleanup-Fenster wird erkannt`, async (st) => {
      const value = await fixture(st);
      const targetPath = target === "binary" ? value.rebuiltPath : value.outputPath;
      const foreign = Buffer.from(`foreign ${target}\n`, "utf8");
      await assert.rejects(materialize(value, {
        hooks: {
          afterBuildRootCleanupBeforeFinalAudit: async () => {
            await rename(targetPath, `${targetPath}.detached-owned`);
            await writeFile(targetPath, foreign);
          },
        },
      }), /ersetzt|driftete/);
      assert.ok((await readFile(targetPath)).equals(foreign));
      assert.ok((await stat(`${targetPath}.detached-owned`)).size > 0);
    });
  }

  await t.test("Parent-Tausch unmittelbar nach Link wird erkannt und bleibt nach Ruecktausch recoverbar", async (st) => {
    const value = await fixture(st);
    const displacedParent = `${value.artifactRoot}.displaced-owned`;
    const foreignParent = `${value.artifactRoot}.foreign`;
    await assert.rejects(materialize(value, {
      hooks: {
        afterPublicationSourceLinkBeforeAudit: async ({ id }) => {
          if (id !== "archive") return;
          await rename(value.artifactRoot, displacedParent);
          await mkdir(value.artifactRoot);
          await writeFile(join(value.artifactRoot, "foreign.txt"), "foreign parent\n");
        },
      },
    }), /Elternverzeichnis unmittelbar nach Link wurde fremd ersetzt|Rebuild, Cleanup/);
    assert.equal(await readFile(join(value.artifactRoot, "foreign.txt"), "utf8"), "foreign parent\n");
    await renameEventually(value.artifactRoot, foreignParent);
    await renameEventually(displacedParent, value.artifactRoot);
    const recovered = await materialize(value, { recoveryOnly: true });
    assert.equal(recovered.recovery.stagingRetained, false);
    await assert.rejects(stat(recovered.recovery.staging), { code: "ENOENT" });
    assert.equal((await verify(value)).receipt.schema, "zugfolge-operational-validator-rebuild-evidence/v2");
    assert.equal(await readFile(join(foreignParent, "foreign.txt"), "utf8"), "foreign parent\n");
  });
});

test("optionaler 8.28-MB-Produktionsgate baut den festgelegten ee6d-Commit wirklich neu", {
  skip: process.platform !== "win32" || !process.env.ZUGFOLGE_REAL_OPERATIONAL_VALIDATOR_REBUILD_SOURCE_ROOT,
}, async () => {
  const sourceRoot = process.env.ZUGFOLGE_REAL_OPERATIONAL_VALIDATOR_REBUILD_SOURCE_ROOT;
  const tempRoot = await mkdtemp(join(tmpdir(), "zugfolge-operational-rebuild-real-"));
  try {
    const workspaceRoot = join(tempRoot, "workspace");
    const producerRoot = join(workspaceRoot, "tools", "region-import", "germany");
    const artifactRoot = join(workspaceRoot, "artifacts");
    await mkdir(producerRoot, { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    await Promise.all([
      copyFile(BOOTSTRAP_PATH, join(producerRoot, "operational-validator-rebuild-bootstrap.mjs")),
      copyFile(ENTRYPOINT_PATH, join(producerRoot, "operational-validator-rebuild-evidence-cli.mjs")),
      copyFile(IMPLEMENTATION_PATH, join(producerRoot, "operational-validator-rebuild-evidence.mjs")),
    ]);
    const spec = JSON.parse(await readFile(PRODUCTION_SPEC_PATH, "utf8"));
    const copiedProducerPaths = {
      bootstrap: join(producerRoot, "operational-validator-rebuild-bootstrap.mjs"),
      entrypoint: join(producerRoot, "operational-validator-rebuild-evidence-cli.mjs"),
      implementation: join(producerRoot, "operational-validator-rebuild-evidence.mjs"),
    };
    spec.producer = await producerPins(copiedProducerPaths);
    const sourcePreserved = join(REPOSITORY_ROOT, ...spec.binaries.preserved.file.split("/"));
    const preservedPath = join(artifactRoot, "preserved.exe");
    const rebuiltPath = join(artifactRoot, "rebuilt-official.exe");
    const tempSpecPath = join(producerRoot, "real-spec.json");
    const tempOutputPath = join(artifactRoot, "receipt.json");
    await copyFile(sourcePreserved, preservedPath);
    spec.binaries.preserved.file = "artifacts/preserved.exe";
    spec.binaries.rebuilt.file = "artifacts/rebuilt-official.exe";
    spec.source.archive.file = "artifacts/source.tar";
    spec.provenance.file = "artifacts/provenance.json";
    await writeFile(tempSpecPath, canonicalBytes(spec));
    const materialized = await run(process.execPath, [
      join(producerRoot, "operational-validator-rebuild-evidence-cli.mjs"),
      "materialize",
      tempSpecPath,
      sourceRoot,
      tempOutputPath,
      workspaceRoot,
    ], { cwd: workspaceRoot });
    const result = JSON.parse(materialized.stdout.toString("utf8"));
    assert.equal(result.binary.bytes, 8_283_251);
    assert.equal((await stat(rebuiltPath)).size, 8_283_251);
    const receipt = JSON.parse(await readFile(tempOutputPath, "utf8"));
    assert.equal(receipt.source.git.commit, "ee6d7081b32277e46cd6ebb28fc65bd45ce55012");
    assert.equal(receipt.pe.normalized.rebuiltSha256, spec.pe.normalizedSha256);
    const verified = await run(process.execPath, [
      join(producerRoot, "operational-validator-rebuild-evidence-cli.mjs"),
      "verify",
      tempSpecPath,
      tempOutputPath,
      workspaceRoot,
    ], { cwd: workspaceRoot });
    assert.equal(JSON.parse(verified.stdout.toString("utf8")).sha256, sha256(await readFile(tempOutputPath)));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
