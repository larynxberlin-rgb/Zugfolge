import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildOperationalValidatorWindowsAnchorHelper } from "./build-operational-validator-windows-anchor-helper.mjs";
import {
  materializeOperationalValidatorRebuildEvidence,
  validateOperationalValidatorRebuildSpec,
  WINDOWS_BUILD_ANCHOR_HELPER_SOURCE,
} from "./operational-validator-rebuild-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const IMPLEMENTATION_PATH = join(HERE, "operational-validator-rebuild-evidence.mjs");
const HELPER_BUILDER_PATH = join(HERE, "build-operational-validator-windows-anchor-helper.mjs");
const HELPER_PATH = join(HERE, "operational-windows-anchor-helper.dll");
const PREPARATION_PATH = join(HERE, "prepare-operational-validator-rebuild-inputs.mjs");
const PRODUCTION_SPEC_PATH = join(HERE, "operational-validator-rebuild.annual-2026.5.json");
const WORKFLOW_RUNNER_PATH = join(HERE, "run-operational-validator-rebuild-workflow.mjs");
const WORKFLOW_PATH = join(ROOT, ".github", "workflows", "operational-validator-rebuild-evidence.yml");
const EXECUTION_AUTHORITY_WORKFLOW_PATH = join(ROOT, ".github", "workflows", "operational-v2-execution-authority.yml");
const POWERSHELL_51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_ONLY = { skip: process.platform !== "win32" };

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

let tarAuditForTest;

async function loadTarAuditForTest() {
  tarAuditForTest ??= (async () => {
    const source = await readFile(IMPLEMENTATION_PATH, "utf8");
    const instrumented = `${source}\nexport { auditPinnedRegularTar as __auditPinnedRegularTarForTest };\n`;
    const module = await import(`data:text/javascript;base64,${Buffer.from(instrumented, "utf8").toString("base64")}`);
    return module.__auditPinnedRegularTarForTest;
  })();
  return tarAuditForTest;
}

function tarOctalField(value, length) {
  const octal = value.toString(8).padStart(length - 1, "0");
  assert.ok(octal.length < length, `TAR-Oktalfeld ${value} passt nicht in ${length} Bytes.`);
  return Buffer.from(`${octal}\0`, "ascii");
}

function tarHeader({ bytes, file, link = "", type = "0" }) {
  const header = Buffer.alloc(512);
  Buffer.from(file, "utf8").copy(header, 0);
  tarOctalField(type === "5" ? 0o755 : 0o644, 8).copy(header, 100);
  tarOctalField(0, 8).copy(header, 108);
  tarOctalField(0, 8).copy(header, 116);
  tarOctalField(bytes, 12).copy(header, 124);
  tarOctalField(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  Buffer.from(link, "utf8").copy(header, 157);
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  return header;
}

function tarPaxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  for (;;) {
    const record = `${length} ${payload}`;
    const actual = Buffer.byteLength(record);
    if (actual === length) return Buffer.from(record, "utf8");
    length = actual;
  }
}

function tarEntry({ data = Buffer.alloc(0), file, link = "", type = "0" }) {
  const bytes = Buffer.from(data);
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([tarHeader({ bytes: bytes.length, file, link, type }), bytes, padding]);
}

function tarFixture(entries, comment = "a".repeat(40)) {
  const pax = tarPaxRecord("comment", comment);
  const bytes = Buffer.concat([
    tarEntry({ data: pax, file: "pax-global", type: "g" }),
    ...entries.map(tarEntry),
    Buffer.alloc(1024),
  ]);
  const manifest = entries
    .filter(({ type = "0" }) => type === "0")
    .map(({ data = Buffer.alloc(0), file }) => {
      const content = Buffer.from(data);
      return { bytes: content.length, file, sha256: sha256(content) };
    })
    .sort((left, right) => left.file.localeCompare(right.file, "en"));
  const totalBytes = manifest.reduce((sum, entry) => sum + entry.bytes, 0);
  return {
    bytes,
    comment,
    manifest,
    tree: {
      fileCount: manifest.length,
      manifestSha256: sha256(canonicalBytes(manifest)),
      totalBytes,
    },
  };
}

function auditFixture(audit, fixture, overrides = {}) {
  return audit(fixture.bytes, {
    archive: { bytes: fixture.bytes.length, sha256: sha256(fixture.bytes) },
    expectedComment: fixture.comment,
    expectedTree: fixture.tree,
    label: "Test-Commit-TAR",
    ...overrides,
  });
}

function clone(value) {
  return structuredClone(value);
}

function execute(file, arguments_, { cwd = ROOT, env = process.env, expectFailure = false, maxBuffer = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolveResult, reject) => {
    execFile(file, arguments_, { cwd, encoding: "buffer", env, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      const result = { error, stderr: Buffer.from(stderr ?? []), stdout: Buffer.from(stdout ?? []) };
      if (expectFailure || !error) resolveResult(result);
      else reject(new Error(`${file} ist fehlgeschlagen: ${result.stderr.toString("utf8")}`, { cause: error }));
    });
  });
}

async function loadProductionSpec() {
  const bytes = await readFile(PRODUCTION_SPEC_PATH);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

async function temporaryDirectory(t, prefix = "zugfolge-rebuild-v3-test-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

async function waitForFileBytes(path, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try { return await readFile(path); }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`Zeitlimit beim Warten auf ${path}.`, { cause: error });
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
}

async function materializationTarSwapFixture(t) {
  const workspaceRoot = await temporaryDirectory(t, "zfrbtarswap");
  const { value: productionSpec } = await loadProductionSpec();
  const spec = clone(productionSpec);
  const sourceData = Buffer.from("held-v1\n", "utf8");
  const foreignSourceData = Buffer.from("evil-v1\n", "utf8");
  const vendorData = Buffer.from("[held__]\n", "utf8");
  const foreignVendorData = Buffer.from("[evil__]\n", "utf8");
  const source = tarFixture([{ data: sourceData, file: "Cargo.lock" }], spec.source.commit);
  const foreignSource = tarFixture([{ data: foreignSourceData, file: "Cargo.lock" }], spec.source.commit);
  const vendor = tarFixture([{ data: vendorData, file: ".cargo/config.toml" }], "cargo-vendor-tree-v1");
  const foreignVendor = tarFixture([{ data: foreignVendorData, file: ".cargo/config.toml" }], "cargo-vendor-tree-v1");
  const workspacePath = (portable) => join(workspaceRoot, ...portable.split("/"));
  const toolchainRoot = join(workspaceRoot, "fixture-toolchain");
  const cargoPath = join(toolchainRoot, "bin", "cargo.exe");
  const rustcPath = join(toolchainRoot, "bin", "rustc.exe");
  const cargoBytes = Buffer.from("fixture-cargo-not-executed\n", "utf8");
  const rustcBytes = Buffer.from("fixture-rustc-not-executed\n", "utf8");
  await mkdir(dirname(cargoPath), { recursive: true });
  await Promise.all([
    writeFile(cargoPath, cargoBytes, { flag: "wx" }),
    writeFile(rustcPath, rustcBytes, { flag: "wx" }),
  ]);
  spec.toolchain.root = toolchainRoot;
  spec.toolchain.cargoPath = "bin/cargo.exe";
  spec.toolchain.rustcPath = "bin/rustc.exe";
  const manifest = {
    directories: ["bin"],
    files: [
      { bytes: cargoBytes.length, file: spec.toolchain.cargoPath, sha256: sha256(cargoBytes) },
      { bytes: rustcBytes.length, file: spec.toolchain.rustcPath, sha256: sha256(rustcBytes) },
    ],
    id: "fixture-toolchain-v1",
    schema: "zugfolge-operational-validator-toolchain-manifest/v1",
  };
  const manifestBytes = canonicalBytes(manifest);
  spec.toolchain.manifest = {
    bytes: manifestBytes.length,
    file: spec.toolchain.manifest.file,
    sha256: sha256(manifestBytes),
  };
  spec.source.archive = {
    bytes: source.bytes.length,
    file: spec.source.archive.file,
    format: "tar",
    sha256: sha256(source.bytes),
  };
  spec.source.cargoLock = { ...source.manifest.find(({ file }) => file === "Cargo.lock") };
  spec.source.tree = source.tree;
  spec.source.vendor.archive = {
    bytes: vendor.bytes.length,
    file: spec.source.vendor.archive.file,
    format: "tar",
    sha256: sha256(vendor.bytes),
  };
  spec.source.vendor.cargoConfig = { ...vendor.manifest.find(({ file }) => file === ".cargo/config.toml") };
  spec.source.vendor.tree = vendor.tree;
  const preservedBytes = Buffer.from("fixture-preserved-validator-not-inspected-as-pe-before-build\n", "utf8");
  spec.binaries.preserved = {
    bytes: preservedBytes.length,
    file: spec.binaries.preserved.file,
    sha256: sha256(preservedBytes),
  };
  spec.binaries.rebuilt.expectedBytes = preservedBytes.length;
  const helperBytes = await readFile(HELPER_PATH);
  spec.toolchain.anchor.helperAssembly = {
    bytes: helperBytes.length,
    file: spec.toolchain.anchor.helperAssembly.file,
    sha256: sha256(helperBytes),
  };
  const specBytes = canonicalBytes(spec);
  const specFile = join(workspaceRoot, "fixture-rebuild-spec.json");
  const sourcePath = workspacePath(spec.source.archive.file);
  const vendorPath = workspacePath(spec.source.vendor.archive.file);
  const manifestPath = workspacePath(spec.toolchain.manifest.file);
  const preservedPath = workspacePath(spec.binaries.preserved.file);
  const helperPath = workspacePath(spec.toolchain.anchor.helperAssembly.file);
  const outputPath = workspacePath(spec.receipt.file);
  const foreignSourcePath = join(workspaceRoot, "foreign-source.tar");
  const foreignVendorPath = join(workspaceRoot, "foreign-vendor.tar");
  for (const path of [sourcePath, vendorPath, manifestPath, preservedPath, helperPath, outputPath,
    workspacePath(spec.binaries.rebuilt.file), workspacePath(spec.provenance.file)]) {
    await mkdir(dirname(path), { recursive: true });
  }
  await Promise.all([
    writeFile(specFile, specBytes, { flag: "wx" }),
    writeFile(sourcePath, source.bytes, { flag: "wx" }),
    writeFile(vendorPath, vendor.bytes, { flag: "wx" }),
    writeFile(manifestPath, manifestBytes, { flag: "wx" }),
    writeFile(preservedPath, preservedBytes, { flag: "wx" }),
    copyFile(HELPER_PATH, helperPath),
    writeFile(foreignSourcePath, foreignSource.bytes, { flag: "wx" }),
    writeFile(foreignVendorPath, foreignVendor.bytes, { flag: "wx" }),
  ]);
  const authorityEnvironment = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: spec.authority.event,
    GITHUB_REF: spec.authority.requiredRef,
    GITHUB_REF_PROTECTED: "true",
    GITHUB_REPOSITORY: spec.authority.repository,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "424242",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW_REF: `${spec.authority.repository}/${spec.authority.workflowFile}@${spec.authority.requiredRef}`,
    RUNNER_ARCH: "X64",
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Windows",
    ZUGFOLGE_REBUILD_RUNNER_IMAGE: spec.authority.runnerImages[0],
  };
  const previousEnvironment = new Map(Object.keys(authorityEnvironment).map((name) => [name, process.env[name]]));
  Object.assign(process.env, authorityEnvironment);
  t.after(() => {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return {
    foreignSourcePath,
    foreignSourceBytes: foreignSource.bytes,
    foreignVendorPath,
    foreignVendorBytes: foreignVendor.bytes,
    outputPaths: [
      workspacePath(spec.binaries.rebuilt.file),
      workspacePath(spec.provenance.file),
      outputPath,
    ],
    sourcePath,
    sourceBytes: source.bytes,
    sourceData,
    vendorPath,
    vendorBytes: vendor.bytes,
    workspaceRoot,
    materialize: (hooks) => materializeOperationalValidatorRebuildEvidence({
      hooks,
      outputPath,
      producerProofs: spec.producer,
      runnerAnchorHelperProof: spec.toolchain.anchor.helperAssembly,
      spec,
      specBytes,
      specFile,
      workspaceRoot,
    }),
  };
}

function isWindowsHeldMutationError(error) {
  return /^(?:EACCES|EBUSY|EPERM)$/u.test(error?.code ?? "");
}

test("Annual-Rebuild-Spec v3 ist kanonisch und vollstaendig gepinnt", async () => {
  const { bytes, value: spec } = await loadProductionSpec();
  assert.ok(bytes.equals(canonicalBytes(spec)));
  assert.equal(validateOperationalValidatorRebuildSpec(spec), spec);
  assert.equal(spec.schema, "zugfolge-operational-validator-rebuild-spec/v3");
  assert.deepEqual(Object.keys(spec.producer).sort(), ["bundle", "entrypoint", "executionPins", "implementation"]);
  assert.deepEqual(spec.authority.attestation.subjects, [
    spec.binaries.rebuilt.file,
    spec.provenance.file,
    spec.receipt.file,
    spec.binaries.preserved.file,
    spec.authority.annualExecutorPlan.directContractFile,
    spec.authority.annualExecutorPlan.planFile,
    `${spec.authority.annualExecutorPlan.planFile}.zugfolge-complete.json`,
    spec.authority.annualExecutorPlan.startEvidenceFile,
    `${spec.authority.annualExecutorPlan.startEvidenceFile}.zugfolge-complete.json`,
  ]);
  assert.equal(spec.authority.artifactAttestation, "github-sigstore-build-provenance-required-v1");
  assert.equal(spec.authority.attestation.verification.denySelfHostedRunners, true);
  assert.equal(spec.toolchain.platform, "win32");
  assert.equal(spec.toolchain.anchor.helperAssembly.file, "tools/region-import/germany/operational-windows-anchor-helper.dll");
  assert.deepEqual(spec.build.command.slice(0, 5), ["cargo", "--config", "$PINNED_CARGO_CONFIG", "build", "--manifest-path"]);
  assert.ok(spec.build.command.includes("--locked"));
  assert.ok(spec.build.command.includes("--offline"));
  assert.deepEqual(spec.build.environmentPolicy.allowedInherited, []);
  assert.equal(spec.build.environmentPolicy.fixed.CARGO_NET_OFFLINE, "true");
  assert.equal(spec.build.environmentPolicy.fixed.CARGO_ENCODED_RUSTFLAGS,
    "--remap-path-prefix=$HELD_VENDOR_ROOT=$ANNUAL_VENDOR_REMAP_PREFIX");
  const [implementation, helper] = await Promise.all([readFile(IMPLEMENTATION_PATH), readFile(HELPER_PATH)]);
  assert.deepEqual(spec.producer.implementation, {
    bytes: implementation.length,
    file: "tools/region-import/germany/operational-validator-rebuild-evidence.mjs",
    sha256: sha256(implementation),
  });
  assert.deepEqual(spec.toolchain.anchor.helperAssembly, {
    bytes: helper.length,
    file: "tools/region-import/germany/operational-windows-anchor-helper.dll",
    sha256: sha256(helper),
  });
});

test("Spec-Validator lehnt Trust-, Dependency-, Plattform- und Producer-Drift fail-closed ab", async (t) => {
  const { value: production } = await loadProductionSpec();
  const cases = [
    ["v2-Schema", (spec) => { spec.schema = "zugfolge-operational-validator-rebuild-spec/v2"; }],
    ["zusaetzlicher Bootstrap-Producer", (spec) => { spec.producer.bootstrap = spec.producer.bundle; }],
    ["fremde Authority", (spec) => { spec.authority.repository = "attacker/Zugfolge"; }],
    ["umgeordnete Attestation-Subjects", (spec) => { spec.authority.attestation.subjects.reverse(); }],
    ["fehlendes offline", (spec) => { spec.build.command = spec.build.command.filter((entry) => entry !== "--offline"); }],
    ["ambienter CARGO_HOME", (spec) => { spec.build.environmentPolicy.allowedInherited = ["CARGO_HOME"]; }],
    ["Linux-Materialisierung", (spec) => { spec.toolchain.platform = "linux"; }],
    ["POSIX-Toolchain-Root", (spec) => { spec.toolchain.root = "/tmp/toolchain"; }],
    ["laufwerksrelativer Toolchain-Root", (spec) => { spec.toolchain.root = String.raw`C:toolchain`; }],
    ["UNC-Toolchain-Root", (spec) => { spec.toolchain.root = String.raw`\\server\share\toolchain`; }],
    ["ignorierter Helper", (spec) => { spec.toolchain.anchor.helperAssembly.file = "var/operational-windows-anchor-helper.dll"; }],
    ["Receipt-Subject-Drift", (spec) => { spec.receipt.file = "var/derived/germany-2026.5/toolchain/other-receipt.json"; }],
    ["freies Rustflag", (spec) => { spec.build.environmentPolicy.fixed.CARGO_ENCODED_RUSTFLAGS = "-Ctarget-cpu=native"; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const spec = clone(production);
      mutate(spec);
      assert.throws(() => validateOperationalValidatorRebuildSpec(spec));
    });
  }
});

test("falscher Receipt-Pfad scheitert vor jeder Archiv-, Claim- oder Publikationswirkung", async (t) => {
  const workspaceRoot = await temporaryDirectory(t);
  const { bytes: specBytes, value: spec } = await loadProductionSpec();
  const before = await readdir(workspaceRoot);
  await assert.rejects(materializeOperationalValidatorRebuildEvidence({
    outputPath: join(workspaceRoot, "wrong-receipt.json"),
    producerProofs: spec.producer,
    runnerAnchorHelperProof: spec.toolchain.anchor.helperAssembly,
    spec,
    specBytes,
    specFile: PRODUCTION_SPEC_PATH,
    workspaceRoot,
  }), /outputPath driftet/);
  assert.deepEqual(await readdir(workspaceRoot), before);
});

test("releasefaehige Materialisierung enthaelt weder externes git/tar/rustup noch Add-Type", async () => {
  const source = await readFile(IMPLEMENTATION_PATH, "utf8");
  assert.doesNotMatch(source, /\b(?:execFile|execFileSync|spawn|spawnSync)\s*\(\s*["'](?:git|tar|rustup)(?:\.exe)?["']/u);
  assert.doesNotMatch(source, /git archive|get-tar-commit-id|\btar\.exe\b|\bAdd-Type\b/u);
  for (const required of [
    "NtCreateFile", "CreateProtectedDirectory", "S-1-3-4", "AssertFrozenDirectoryEntry",
    "ReadDirectoryChangesW-Overflow", "RunAs(", "RunStrict(", "CreateProcessAsUserW", "PROC_THREAD_ATTRIBUTE_HANDLE_LIST",
    "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE", "pending-external-verification", "runnerAnchorHelperProof",
    "PUBLICATION_COMPLETE", "TerminateJobObject(post-root descendants)", "PublishHeldCreateNew",
    "MarkRegularFileDeletePending", "ZugfolgeAnnualArtifactPublisher", "PublishPair(",
    "PublishOrRecoverPair(", "VerifyPair(",
  ]) assert.ok(source.includes(required), `Rebuild-v3-Implementierung bindet ${required} nicht.`);
  for (const forbidden of ["link(", "rename(", "unlink(", "rmdir(", "mkdtemp("]) {
    assert.ok(!source.includes(forbidden), `Rebuild-v3-Implementierung enthaelt weiterhin pfadbasierte Wirkung ${forbidden}.`);
  }
});

test("TAR-Audit liefert nur gepinnte regulaere Dateislices als Extraktionsplan", async () => {
  const audit = await loadTarAuditForTest();
  const fixture = tarFixture([
    { data: Buffer.from("lock-v1\n", "utf8"), file: "Cargo.lock" },
    { data: Buffer.from("fn main() {}\n", "utf8"), file: "src/main.rs" },
  ]);
  const result = auditFixture(audit, fixture, { requiredFile: fixture.manifest[0] });
  assert.deepEqual(result.manifest, fixture.manifest);
  assert.deepEqual(result.extractedTree, fixture.tree);
  assert.deepEqual(result.required, fixture.manifest[0]);
  assert.deepEqual(result.files.map(({ bytes, file, sha256: hash }) => ({ bytes, file, sha256: hash })), fixture.manifest);
  for (const entry of result.files) {
    const slice = fixture.bytes.subarray(entry.offset, entry.offset + entry.bytes);
    assert.equal(sha256(slice), entry.sha256);
  }
});

test("TAR-Audit verwirft Bytezahl- und SHA-256-Drift vor jeder Extraktionsplanung", async () => {
  const audit = await loadTarAuditForTest();
  const fixture = tarFixture([{ data: Buffer.from("lock-v1\n", "utf8"), file: "Cargo.lock" }]);
  for (const archive of [
    { bytes: fixture.bytes.length + 1, sha256: sha256(fixture.bytes) },
    { bytes: fixture.bytes.length, sha256: "f".repeat(64) },
  ]) {
    assert.throws(() => auditFixture(audit, fixture, { archive }), /driftet vom Spec-Pin/u);
  }
});

test("TAR-Audit verwirft Traversalpfade vor jeder Extraktionsplanung", async () => {
  const audit = await loadTarAuditForTest();
  for (const file of ["../escape", "src/../../escape", "./Cargo.lock", "src/./main.rs"]) {
    const fixture = tarFixture([{ data: Buffer.from("escape\n", "utf8"), file }]);
    assert.throws(() => auditFixture(audit, fixture), /sicherer relativer POSIX-Dateipfad/u);
  }
});

test("TAR-Audit verwirft absolute POSIX-, Laufwerks- und UNC-Pfade", async () => {
  const audit = await loadTarAuditForTest();
  for (const file of ["/absolute/Cargo.lock", "C:/absolute/Cargo.lock", "\\\\server\\share\\Cargo.lock"]) {
    const fixture = tarFixture([{ data: Buffer.from("escape\n", "utf8"), file }]);
    assert.throws(() => auditFixture(audit, fixture), /sicherer relativer POSIX-Dateipfad/u);
  }
});

test("TAR-Audit verwirft Links, Geraete und unbekannte Typen", async () => {
  const audit = await loadTarAuditForTest();
  const forbidden = [
    { file: "hardlink", link: "Cargo.lock", type: "1" },
    { file: "symlink", link: "Cargo.lock", type: "2" },
    { file: "character-device", type: "3" },
    { file: "block-device", type: "4" },
    { file: "fifo", type: "6" },
    { file: "unknown", type: "7" },
  ];
  for (const entry of forbidden) {
    const fixture = tarFixture([entry]);
    assert.throws(() => auditFixture(audit, fixture), /unerwartetes Linkziel|verbotenen Eintragstyp/u);
  }
});

test("TAR-Audit verwirft Doppelteintraege und Windows-Pfadkollisionen", async () => {
  const audit = await loadTarAuditForTest();
  for (const files of [["Cargo.lock", "Cargo.lock"], ["Cargo.lock", "cargo.LOCK"]]) {
    const fixture = tarFixture(files.map((file, index) => ({ data: Buffer.from(`lock-${index}\n`, "utf8"), file })));
    assert.throws(() => auditFixture(audit, fixture), /doppelten oder kollidierenden Datei- oder Verzeichniseintrag/u);
  }
});

test("gehaltener TAR-Handle verhindert unbemerkten Pfadtausch im Pruef-Extraktionsfenster", async (t) => {
  const audit = await loadTarAuditForTest();
  const root = await temporaryDirectory(t, "zugfolge-rebuild-tar-swap-");
  const archivePath = join(root, "source.tar");
  const displacedPath = join(root, "source-held.tar");
  const original = tarFixture([{ data: Buffer.from("held-lock\n", "utf8"), file: "Cargo.lock" }]);
  const replacement = tarFixture([{ data: Buffer.from("foreign\n", "utf8"), file: "../foreign" }]);
  await writeFile(archivePath, original.bytes);
  const handle = await open(archivePath, "r");
  try {
    const metadata = await handle.stat();
    const heldBytes = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(heldBytes, 0, heldBytes.length, 0);
    assert.equal(bytesRead, heldBytes.length);
    const plan = auditFixture(audit, { ...original, bytes: heldBytes });

    await rename(archivePath, displacedPath);
    await writeFile(archivePath, replacement.bytes);

    for (const entry of plan.files) {
      const slice = Buffer.alloc(entry.bytes);
      const read = await handle.read(slice, 0, slice.length, entry.offset);
      assert.equal(read.bytesRead, slice.length);
      assert.equal(sha256(slice), entry.sha256);
      assert.equal(slice.toString("utf8"), "held-lock\n");
    }
    assert.throws(() => auditFixture(audit, replacement), /sicherer relativer POSIX-Dateipfad/u);
    assert.ok((await readFile(displacedPath)).equals(original.bytes));
    assert.ok((await readFile(archivePath)).equals(replacement.bytes));
  } finally {
    await handle.close();
  }
});

test("echte Materialisierung stoppt am Audit-Hook ohne TAR-Pfadtausch oder Extraktionswirkung",
  WINDOWS_ONLY, async (t) => {
    const fixture = await materializationTarSwapFixture(t);
    let stagingRoot;
    let sourceRenameError;
    let vendorWriteError;
    await assert.rejects(fixture.materialize({
      afterPinnedInputAuditBeforeExtraction: async (value) => {
        stagingRoot = value.stagingRoot;
        try { await rename(fixture.sourcePath, `${fixture.sourcePath}.displaced-after-audit`); }
        catch (error) { sourceRenameError = error; }
        try { await writeFile(fixture.vendorPath, fixture.foreignVendorBytes); }
        catch (error) { vendorWriteError = error; }
        throw new Error("TEST_STOP_AFTER_PINNED_TAR_AUDIT");
      },
    }), /TEST_STOP_AFTER_PINNED_TAR_AUDIT/u);
    assert.ok(isWindowsHeldMutationError(sourceRenameError), `Source-TAR-Rename war nicht gehalten: ${sourceRenameError}`);
    assert.ok(isWindowsHeldMutationError(vendorWriteError), `Vendor-TAR-Write war nicht gehalten: ${vendorWriteError}`);
    assert.ok((await readFile(fixture.sourcePath)).equals(fixture.sourceBytes));
    assert.ok((await readFile(fixture.vendorPath)).equals(fixture.vendorBytes));
    await assert.rejects(readdir(stagingRoot), { code: "ENOENT" });
    for (const output of fixture.outputPaths) await assert.rejects(readFile(output), { code: "ENOENT" });
  });

test("Windows-Anker verweigert Rename/Write exakt vor der Extraktion und extrahiert keine Fremdbytes",
  WINDOWS_ONLY, async (t) => {
    const fixture = await materializationTarSwapFixture(t);
    let audited = false;
    let stagingRoot;
    let sourceWriteError;
    let vendorRenameError;
    let parentRenameError;
    await assert.rejects(fixture.materialize({
      afterPinnedInputAuditBeforeExtraction: ({ stagingRoot: value }) => {
        audited = true;
        stagingRoot = value;
      },
      beforeWindowsAnchoredExtraction: async ({ buildRoot }) => {
        assert.equal(audited, true, "Windows-Extraktionshook lief vor dem vollstaendigen TAR-Audit.");
        assert.equal(resolve(buildRoot), resolve(stagingRoot));
        try { await writeFile(fixture.sourcePath, fixture.foreignSourceBytes); }
        catch (error) { sourceWriteError = error; }
        try { await rename(fixture.vendorPath, `${fixture.vendorPath}.displaced-before-extraction`); }
        catch (error) { vendorRenameError = error; }
        const parent = dirname(fixture.sourcePath);
        try { await rename(parent, `${parent}.displaced-before-extraction`); }
        catch (error) { parentRenameError = error; }
        throw new Error("TEST_STOP_AT_WINDOWS_ANCHORED_EXTRACTION");
      },
    }), /TEST_STOP_AT_WINDOWS_ANCHORED_EXTRACTION/u);
    assert.ok(isWindowsHeldMutationError(sourceWriteError), `Source-TAR-Write war nicht gehalten: ${sourceWriteError}`);
    assert.ok(isWindowsHeldMutationError(vendorRenameError), `Vendor-TAR-Rename war nicht gehalten: ${vendorRenameError}`);
    assert.ok(isWindowsHeldMutationError(parentRenameError), `TAR-Parent-Rename war nicht gehalten: ${parentRenameError}`);
    assert.ok((await readFile(fixture.sourcePath)).equals(fixture.sourceBytes));
    assert.ok((await readFile(fixture.vendorPath)).equals(fixture.vendorBytes));
    await assert.rejects(readdir(stagingRoot), { code: "ENOENT" });
    for (const output of fixture.outputPaths) await assert.rejects(readFile(output), { code: "ENOENT" });
  });

test("echtes Windows PowerShell 5.1 parst den Anchor und alle Workflow-Bloecke", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zfrbpsparse");
  const harness = join(root, "parse-production-powershell.ps1");
  await writeFile(harness, [
    "param([string] $Implementation, [string] $Workflow)",
    "$ErrorActionPreference = 'Stop'",
    "$source = [IO.File]::ReadAllText($Implementation)",
    "$anchor = [Text.RegularExpressions.Regex]::Match($source, 'const WINDOWS_BUILD_ANCHOR = String\\.raw`(?<script>.*?)`;\\r?\\nconst EXPECTED_NORMALIZATION_FIELDS', [Text.RegularExpressions.RegexOptions]::Singleline)",
    "if (-not $anchor.Success) { throw 'WINDOWS_BUILD_ANCHOR wurde nicht eindeutig gefunden.' }",
    "$null = [ScriptBlock]::Create($anchor.Groups['script'].Value)",
    "$lines = [IO.File]::ReadAllLines($Workflow)",
    "$count = 0",
    "for ($index = 0; $index -lt $lines.Length; $index++) {",
    "  if ($lines[$index].Trim() -cne 'shell: powershell') { continue }",
    "  $run = $index + 1",
    "  while ($run -lt $lines.Length -and $lines[$run] -cnotmatch '^        run: \\|$') {",
    "    if ($lines[$run] -match '^      - ') { throw 'PowerShell-Workflow-Step besitzt keinen run-Block.' }",
    "    $run++",
    "  }",
    "  if ($run -ge $lines.Length) { throw 'PowerShell-Workflow-Step endet vor seinem run-Block.' }",
    "  $body = [Collections.Generic.List[string]]::new()",
    "  for ($line = $run + 1; $line -lt $lines.Length; $line++) {",
    "    if ($lines[$line].Length -eq 0) { $body.Add(''); continue }",
    "    if (-not $lines[$line].StartsWith('          ')) { break }",
    "    $body.Add($lines[$line].Substring(10))",
    "  }",
    "  if ($body.Count -eq 0) { throw 'PowerShell-Workflow-run-Block ist leer.' }",
    "  $null = [ScriptBlock]::Create([string]::Join(\"`n\", $body))",
    "  $count++",
    "}",
    "[Console]::Out.WriteLine($count)",
    "",
  ].join("\r\n"));
  const parsed = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    harness, IMPLEMENTATION_PATH, WORKFLOW_PATH,
  ], { cwd: "C:\\Windows\\System32" });
  assert.equal(parsed.stdout.toString("utf8").trim(), "7");
});

test("Helper-Builder reproduziert das tracked PE32+-Artefakt bytegenau", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zugfolge-helper-parity-");
  const output = join(root, "operational-windows-anchor-helper.dll");
  const result = await buildOperationalValidatorWindowsAnchorHelper(output);
  const [actual, expected] = await Promise.all([readFile(output), readFile(HELPER_PATH)]);
  assert.ok(actual.equals(expected));
  assert.equal(result.bytes, expected.length);
  assert.equal(result.sha256, sha256(expected));
  assert.equal(result.sourceSha256, sha256(Buffer.from(WINDOWS_BUILD_ANCHOR_HELPER_SOURCE, "utf8")));
  const pe = actual.readUInt32LE(0x3c);
  assert.equal(actual.subarray(pe, pe + 4).toString("hex"), "50450000");
  assert.equal(actual.readUInt16LE(pe + 24), 0x20b);
});

test("Helper-Builder verweigert nicht kanonischen Ausgabepfad vor Compilerwirkung", async (t) => {
  const root = await temporaryDirectory(t, "zugfolge-helper-name-");
  await assert.rejects(buildOperationalValidatorWindowsAnchorHelper(join(root, "helper.dll")), /muss operational-windows-anchor-helper\.dll heissen/);
  assert.deepEqual(await readdir(root), []);
});

test("PowerShell 5.1: Timeout, Cancellation und Root-Exit beenden den gesamten Jobbaum", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zfrbhelper");
  const grandchild = join(root, "grandchild.ps1");
  const parent = join(root, "parent.ps1");
  const parentExit = join(root, "parent-exit.ps1");
  const harness = join(root, "harness.ps1");
  const timeoutStarted = join(root, "timeout-started.txt");
  const timeoutMarker = join(root, "timeout-marker.txt");
  const exitStarted = join(root, "exit-started.txt");
  const exitMarker = join(root, "exit-marker.txt");
  await writeFile(grandchild, [
    "param([string] $Marker)",
    "Start-Sleep -Milliseconds 2500",
    "[IO.File]::WriteAllText($Marker, 'leaked')",
    "",
  ].join("\r\n"));
  const spawnLines = [
    "param([string] $ChildScript, [string] $Marker, [string] $Started)",
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $ChildScript, $Marker)",
    "Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden",
    "[IO.File]::WriteAllText($Started, 'started')",
  ];
  await writeFile(parent, [...spawnLines, "Start-Sleep -Seconds 30", ""].join("\r\n"));
  await writeFile(parentExit, [...spawnLines, "exit 0", ""].join("\r\n"));
  await writeFile(harness, [
    "param([string] $Dll, [string] $ParentScript, [string] $ParentExitScript, [string] $ChildScript, [string] $TimeoutMarker, [string] $TimeoutStarted, [string] $ExitMarker, [string] $ExitStarted)",
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "$methods = @([ZugfolgeMitigatedProcess].GetMethods() | Where-Object { $_.IsPublic -and $_.IsStatic } | ForEach-Object Name | Sort-Object -Unique)",
    "function New-ChildEnvironment {",
    "  return @{ SystemRoot=[string]$env:SystemRoot; WINDIR=[string]$env:SystemRoot; PATH=[string](Join-Path $env:SystemRoot 'System32'); TEMP=[string](Join-Path $env:SystemRoot 'System32'); TMP=[string](Join-Path $env:SystemRoot 'System32') }",
    "}",
    "$environment = New-ChildEnvironment",
    "$powershell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$never = [Func[bool]] { return $false }",
    "$timeoutMessage = ''; $timeoutClock = [Diagnostics.Stopwatch]::StartNew()",
    "try { $null = [ZugfolgeMitigatedProcess]::RunStrict($powershell, [string[]]@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$ParentScript,$ChildScript,$TimeoutMarker,$TimeoutStarted), (Join-Path $env:SystemRoot 'System32'), $environment, [byte[]]@(), 1048576, 1750, $never); $timeoutMessage = 'unexpected-success' } catch { $timeoutMessage = $_.Exception.GetBaseException().Message }",
    "$timeoutClock.Stop(); Start-Sleep -Milliseconds 3000",
    "$environment = New-ChildEnvironment",
    "$cancelClock = [Diagnostics.Stopwatch]::StartNew(); $cancel = [Func[bool]] { return $cancelClock.ElapsedMilliseconds -ge 250 }; $cancelMessage = ''",
    "try { $null = [ZugfolgeMitigatedProcess]::RunStrict($powershell, [string[]]@('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30'), (Join-Path $env:SystemRoot 'System32'), $environment, [byte[]]@(), 1048576, 5000, $cancel); $cancelMessage = 'unexpected-success' } catch { $cancelMessage = $_.Exception.GetBaseException().Message }",
    "$cancelClock.Stop()",
    "$environment = New-ChildEnvironment",
    "$oversizeClock = [Diagnostics.Stopwatch]::StartNew(); $oversizeMessage = ''",
    "try { $null = [ZugfolgeMitigatedProcess]::RunStrict($powershell, [string[]]@('-NoProfile','-NonInteractive','-Command','[Console]::Out.Write((''x'' * 131072))'), (Join-Path $env:SystemRoot 'System32'), $environment, [byte[]]@(), 4096, 5000, $never); $oversizeMessage = 'unexpected-success' } catch { $oversizeMessage = $_.Exception.GetBaseException().Message }",
    "$oversizeClock.Stop()",
    "$environment = New-ChildEnvironment",
    "$exitClock = [Diagnostics.Stopwatch]::StartNew()",
    "$exitResult = [ZugfolgeMitigatedProcess]::RunStrict($powershell, [string[]]@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$ParentExitScript,$ChildScript,$ExitMarker,$ExitStarted), (Join-Path $env:SystemRoot 'System32'), $environment, [byte[]]@(), 1048576, 5000, $never)",
    "$exitClock.Stop(); Start-Sleep -Milliseconds 3000",
    "$value = @{ cancellationElapsed=$cancelClock.ElapsedMilliseconds; cancellationMessage=$cancelMessage; exitCode=$exitResult.ExitCode; exitElapsed=$exitClock.ElapsedMilliseconds; exitMarker=[IO.File]::Exists($ExitMarker); exitStarted=[IO.File]::Exists($ExitStarted); methods=$methods; oversizeElapsed=$oversizeClock.ElapsedMilliseconds; oversizeMessage=$oversizeMessage; timeoutElapsed=$timeoutClock.ElapsedMilliseconds; timeoutMarker=[IO.File]::Exists($TimeoutMarker); timeoutMessage=$timeoutMessage; timeoutStarted=[IO.File]::Exists($TimeoutStarted) }",
    "[Console]::Out.WriteLine(($value | ConvertTo-Json -Compress))",
    "",
  ].join("\r\n"));
  const executed = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    harness, HELPER_PATH, parent, parentExit, grandchild, timeoutMarker, timeoutStarted, exitMarker, exitStarted,
  ], { cwd: "C:\\Windows\\System32" });
  const result = JSON.parse(executed.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1));
  assert.deepEqual(result.methods.filter((name) => ["AbortActive", "Run", "RunAs", "RunAsStrict", "RunStrict"].includes(name)),
    ["AbortActive", "Run", "RunAs", "RunAsStrict", "RunStrict"]);
  assert.equal(result.timeoutStarted, true, JSON.stringify(result));
  assert.equal(result.timeoutMarker, false);
  assert.match(result.timeoutMessage, /ueberschritt das gepinnte Zeitlimit/);
  assert.ok(result.timeoutElapsed < 5000);
  assert.match(result.cancellationMessage, /monotoner Inputdrift beendet/);
  assert.ok(result.cancellationElapsed < 5000);
  assert.match(result.oversizeMessage, /ueberschritt das kombinierte gepinnte Limit/);
  assert.ok(result.oversizeElapsed < 5000);
  assert.equal(result.exitStarted, true);
  assert.equal(result.exitMarker, false, "Root-Exit darf keinen pipehaltenden Enkel ueberleben lassen.");
  assert.equal(result.exitCode, 0);
  assert.ok(result.exitElapsed < 5000, "Root-Exit darf nicht unbeschraenkt in Pipe-Waits haengen.");
});

test("PowerShell 5.1: gehaltenes Annual-Publikationspaar commitet oder rollt beide Outputs identity-sicher zurueck", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zfrbpublish");
  const stage = join(root, "stage");
  const outputDirectory = join(root, "out");
  const stagedData = join(stage, "annual-plan.json");
  const stagedCompletion = join(stage, "annual-plan.completion.json");
  const tamperedCompletion = join(stage, "annual-plan.tampered-completion.json");
  const marker = join(outputDirectory, "foreign-marker.txt");
  const harness = join(root, "publish-pair.ps1");
  const outputRelativeFile = "out/annual-plan.json";
  const output = join(root, ...outputRelativeFile.split("/"));
  const outputCompletion = `${output}.zugfolge-complete.json`;
  const dataBytes = canonicalBytes({ phase: "annual-plan", trains: 17 });
  const dataProof = { bytes: dataBytes.length, file: outputRelativeFile, sha256: sha256(dataBytes) };
  const completionBytes = canonicalBytes({
    artifact: dataProof,
    schema: "zugfolge-germany-annual-create-new-artifact-completion/v1",
  });
  const tamperedCompletionBytes = canonicalBytes({
    artifact: { ...dataProof, bytes: dataProof.bytes + 1 },
    schema: "zugfolge-germany-annual-create-new-artifact-completion/v1",
  });
  await Promise.all([mkdir(stage), mkdir(outputDirectory)]);
  await Promise.all([
    writeFile(stagedData, dataBytes),
    writeFile(stagedCompletion, completionBytes),
    writeFile(tamperedCompletion, tamperedCompletionBytes),
    writeFile(marker, "foreign-marker\n"),
  ]);
  await writeFile(harness, [
    "param([string] $Dll, [string] $Root, [string] $StagedData, [string] $StagedCompletion, [string] $TamperedCompletion, [string] $OutputRelative, [Int64] $DataBytes, [string] $DataSha, [Int64] $CompletionBytes, [string] $CompletionSha, [Int64] $TamperedBytes, [string] $TamperedSha)",
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "$output = Join-Path $Root ($OutputRelative -replace '/', '\\')",
    "$completion = \"$output.zugfolge-complete.json\"",
    "$outputParent = Split-Path -Parent $output",
    "$outputParentSwap = \"$outputParent.swap\"",
    "$outputSwap = \"$output.swap\"",
    "function Invoke-Blocked([scriptblock] $Action, [scriptblock] $Restore) {",
    "  try { & $Action; if ($null -ne $Restore) { & $Restore }; return $false } catch { return $true }",
    "}",
    "$pair = [ZugfolgeAnnualArtifactPublisher]::PublishPair($Root, $StagedData, $StagedCompletion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$proof = @{ artifact=@{ bytes=$pair.Artifact.Bytes; file=$pair.Artifact.File; sha256=$pair.Artifact.Sha256; dev=$pair.Artifact.Identity.Dev; ino=$pair.Artifact.Identity.Ino }; completion=@{ bytes=$pair.Completion.Bytes; file=$pair.Completion.File; sha256=$pair.Completion.Sha256; dev=$pair.Completion.Identity.Dev; ino=$pair.Completion.Identity.Ino } }",
    "$writeBlocked = Invoke-Blocked { [IO.File]::WriteAllText($output, 'foreign') } $null",
    "$sourceWriteBlocked = Invoke-Blocked { [IO.File]::WriteAllText($StagedData, 'foreign-source') } $null",
    "$renameBlocked = Invoke-Blocked { Move-Item -LiteralPath $output -Destination $outputSwap -ErrorAction Stop } { Move-Item -LiteralPath $outputSwap -Destination $output -ErrorAction Stop }",
    "$parentRenameBlocked = Invoke-Blocked { Move-Item -LiteralPath $outputParent -Destination $outputParentSwap -ErrorAction Stop } { Move-Item -LiteralPath $outputParentSwap -Destination $outputParent -ErrorAction Stop }",
    "$pair.Rollback(); $pair.Dispose()",
    "$rolledBack = -not [IO.File]::Exists($output) -and -not [IO.File]::Exists($completion)",
    "$tamperedMessage = ''",
    "try { $bad = [ZugfolgeAnnualArtifactPublisher]::PublishPair($Root, $StagedData, $TamperedCompletion, $OutputRelative, $DataBytes, $DataSha, $TamperedBytes, $TamperedSha); try { $bad.Rollback() } finally { $bad.Dispose() }; $tamperedMessage = 'unexpected-success' } catch { $tamperedMessage = $_.Exception.GetBaseException().Message }",
    "$tamperedLeftNothing = -not [IO.File]::Exists($output) -and -not [IO.File]::Exists($completion)",
    "$committed = [ZugfolgeAnnualArtifactPublisher]::PublishPair($Root, $StagedData, $StagedCompletion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$committedProof = @{ artifact=@{ bytes=$committed.Artifact.Bytes; file=$committed.Artifact.File; sha256=$committed.Artifact.Sha256; dev=$committed.Artifact.Identity.Dev; ino=$committed.Artifact.Identity.Ino }; completion=@{ bytes=$committed.Completion.Bytes; file=$committed.Completion.File; sha256=$committed.Completion.Sha256; dev=$committed.Completion.Identity.Dev; ino=$committed.Completion.Identity.Ino } }",
    "$committed.Commit(); $committed.Dispose()",
    "$verified = [ZugfolgeAnnualArtifactPublisher]::VerifyPair($Root, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$verifyProof = @{ artifact=@{ bytes=$verified.Artifact.Bytes; file=$verified.Artifact.File; sha256=$verified.Artifact.Sha256; dev=$verified.Artifact.Identity.Dev; ino=$verified.Artifact.Identity.Ino }; completion=@{ bytes=$verified.Completion.Bytes; file=$verified.Completion.File; sha256=$verified.Completion.Sha256; dev=$verified.Completion.Identity.Dev; ino=$verified.Completion.Identity.Ino } }",
    "$verifyWriteBlocked = Invoke-Blocked { [IO.File]::WriteAllText($output, 'foreign-after-verify') } $null",
    "$verifyRenameBlocked = Invoke-Blocked { Move-Item -LiteralPath $output -Destination $outputSwap -ErrorAction Stop } { Move-Item -LiteralPath $outputSwap -Destination $output -ErrorAction Stop }",
    "$verifyParentRenameBlocked = Invoke-Blocked { Move-Item -LiteralPath $outputParent -Destination $outputParentSwap -ErrorAction Stop } { Move-Item -LiteralPath $outputParentSwap -Destination $outputParent -ErrorAction Stop }",
    "$verified.Complete(); $verified.Dispose()",
    "$wrongVerifyMessage = ''",
    "try { $wrong = [ZugfolgeAnnualArtifactPublisher]::VerifyPair($Root, $OutputRelative, $DataBytes, ('0' * 64), $CompletionBytes, $CompletionSha); try { $wrong.Complete() } finally { $wrong.Dispose() }; $wrongVerifyMessage = 'unexpected-success' } catch { $wrongVerifyMessage = $_.Exception.GetBaseException().Message }",
    "$value = @{ committedBoth=([IO.File]::Exists($output) -and [IO.File]::Exists($completion)); committedProof=$committedProof; marker=[IO.File]::ReadAllText((Join-Path $outputParent 'foreign-marker.txt')); parentRenameBlocked=$parentRenameBlocked; proof=$proof; renameBlocked=$renameBlocked; rolledBack=$rolledBack; sourceWriteBlocked=$sourceWriteBlocked; tamperedLeftNothing=$tamperedLeftNothing; tamperedMessage=$tamperedMessage; verifyParentRenameBlocked=$verifyParentRenameBlocked; verifyProof=$verifyProof; verifyRenameBlocked=$verifyRenameBlocked; verifyWriteBlocked=$verifyWriteBlocked; writeBlocked=$writeBlocked; wrongVerifyMessage=$wrongVerifyMessage }",
    "[Console]::Out.WriteLine(($value | ConvertTo-Json -Depth 8 -Compress))",
    "",
  ].join("\r\n"));
  const executed = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    harness, HELPER_PATH, root, stagedData, stagedCompletion, tamperedCompletion, outputRelativeFile,
    String(dataBytes.length), dataProof.sha256, String(completionBytes.length), sha256(completionBytes),
    String(tamperedCompletionBytes.length), sha256(tamperedCompletionBytes),
  ], { cwd: "C:\\Windows\\System32" });
  const result = JSON.parse(executed.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1));
  assert.equal(result.writeBlocked, true, JSON.stringify(result));
  assert.equal(result.sourceWriteBlocked, true, JSON.stringify(result));
  assert.equal(result.renameBlocked, true, JSON.stringify(result));
  assert.equal(result.parentRenameBlocked, true, JSON.stringify(result));
  assert.equal(result.rolledBack, true, JSON.stringify(result));
  assert.equal(result.tamperedLeftNothing, true, JSON.stringify(result));
  assert.match(result.tamperedMessage, /Annual-Completion ist nicht kanonisch/);
  assert.equal(result.committedBoth, true, JSON.stringify(result));
  assert.equal(result.verifyWriteBlocked, true, JSON.stringify(result));
  assert.equal(result.verifyRenameBlocked, true, JSON.stringify(result));
  assert.equal(result.verifyParentRenameBlocked, true, JSON.stringify(result));
  assert.match(result.wrongVerifyMessage, /Staging-SHA-256 driftet/);
  assert.equal(result.marker, "foreign-marker\n");
  assert.deepEqual(result.proof.artifact, {
    bytes: dataBytes.length,
    dev: result.proof.artifact.dev,
    file: outputRelativeFile,
    ino: result.proof.artifact.ino,
    sha256: dataProof.sha256,
  });
  assert.deepEqual(result.proof.completion, {
    bytes: completionBytes.length,
    dev: result.proof.completion.dev,
    file: `${outputRelativeFile}.zugfolge-complete.json`,
    ino: result.proof.completion.ino,
    sha256: sha256(completionBytes),
  });
  assert.match(result.proof.artifact.dev, /^\d+$/u);
  assert.match(result.proof.artifact.ino, /^\d+$/u);
  assert.match(result.proof.completion.dev, /^\d+$/u);
  assert.match(result.proof.completion.ino, /^\d+$/u);
  assert.deepEqual(result.verifyProof, result.committedProof);
  assert.ok((await readFile(output)).equals(dataBytes));
  assert.ok((await readFile(outputCompletion)).equals(completionBytes));
});

test("PowerShell 5.1: harter Kill zwischen Artifact und Completion ist exakt und fremddatenschonend recoverbar", WINDOWS_ONLY, async (t) => {
  const root = await temporaryDirectory(t, "zfrbrecovery");
  const stage = join(root, "stage");
  const outputDirectory = join(root, "out");
  const outputRelativeFile = "out/annual-plan.json";
  const output = join(root, ...outputRelativeFile.split("/"));
  const outputCompletion = `${output}.zugfolge-complete.json`;
  const stagedData = join(stage, "annual-plan.json");
  const stagedCompletion = join(stage, "annual-plan.completion.json");
  const gapMarker = join(root, "artifact-created.marker");
  const crashHarness = join(root, "crash-between-pair.ps1");
  const recoverHarness = join(root, "recover-pair.ps1");
  const rejectHarness = join(root, "reject-foreign-pair.ps1");
  const dataBytes = canonicalBytes({ phase: "annual-plan", trains: 23 });
  const dataSha = sha256(dataBytes);
  const completionFor = (file) => canonicalBytes({
    artifact: { bytes: dataBytes.length, file, sha256: dataSha },
    schema: "zugfolge-germany-annual-create-new-artifact-completion/v1",
  });
  const completionBytes = completionFor(outputRelativeFile);
  await Promise.all([mkdir(stage), mkdir(outputDirectory)]);
  await Promise.all([writeFile(stagedData, dataBytes), writeFile(stagedCompletion, completionBytes)]);
  const commonParameters = "[string] $Dll, [string] $Root, [string] $Data, [string] $Completion, [string] $OutputRelative, [Int64] $DataBytes, [string] $DataSha, [Int64] $CompletionBytes, [string] $CompletionSha";
  await writeFile(crashHarness, [
    `param(${commonParameters}, [string] $Marker)`,
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "$hook = [Action]{ [IO.File]::WriteAllText($Marker, 'artifact-held'); Start-Sleep -Seconds 30 }",
    "$pair = [ZugfolgeAnnualArtifactPublisher]::PublishOrRecoverPairWithTestHook($Root, $Data, $Completion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha, $hook)",
    "try { $pair.Commit() } finally { $pair.Dispose() }",
    "",
  ].join("\r\n"));
  await writeFile(recoverHarness, [
    `param(${commonParameters})`,
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "function Proof($pair) { return @{ artifact=@{ bytes=$pair.Artifact.Bytes; file=$pair.Artifact.File; sha256=$pair.Artifact.Sha256; dev=$pair.Artifact.Identity.Dev; ino=$pair.Artifact.Identity.Ino }; completion=@{ bytes=$pair.Completion.Bytes; file=$pair.Completion.File; sha256=$pair.Completion.Sha256; dev=$pair.Completion.Identity.Dev; ino=$pair.Completion.Identity.Ino } } }",
    "$pair = [ZugfolgeAnnualArtifactPublisher]::PublishOrRecoverPair($Root, $Data, $Completion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$recovered = Proof $pair; $pair.Commit(); $pair.Dispose()",
    "$verify = [ZugfolgeAnnualArtifactPublisher]::VerifyPair($Root, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$verified = Proof $verify; $verify.Complete(); $verify.Dispose()",
    "$again = [ZugfolgeAnnualArtifactPublisher]::PublishOrRecoverPair($Root, $Data, $Completion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha)",
    "$existing = Proof $again; $again.Commit(); $again.Dispose()",
    "[Console]::Out.WriteLine((@{ existing=$existing; recovered=$recovered; verified=$verified } | ConvertTo-Json -Depth 8 -Compress))",
    "",
  ].join("\r\n"));
  await writeFile(rejectHarness, [
    `param(${commonParameters})`,
    "$ErrorActionPreference = 'Stop'",
    "$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($Dll))",
    "$message = ''",
    "try { $pair = [ZugfolgeAnnualArtifactPublisher]::PublishOrRecoverPair($Root, $Data, $Completion, $OutputRelative, $DataBytes, $DataSha, $CompletionBytes, $CompletionSha); try { $pair.Rollback() } finally { $pair.Dispose() }; $message = 'unexpected-success' } catch { $message = $_.Exception.GetBaseException().Message }",
    "[Console]::Out.WriteLine((@{ message=$message } | ConvertTo-Json -Compress))",
    "",
  ].join("\r\n"));
  const baseArguments = [
    HELPER_PATH, root, stagedData, stagedCompletion, outputRelativeFile,
    String(dataBytes.length), dataSha, String(completionBytes.length), sha256(completionBytes),
  ];
  const crashing = spawn(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    crashHarness, ...baseArguments, gapMarker,
  ], { cwd: "C:\\Windows\\System32", stdio: "ignore", windowsHide: true });
  t.after(() => { try { crashing.kill("SIGKILL"); } catch {} });
  const closed = new Promise((resolveClose, rejectClose) => {
    crashing.once("error", rejectClose);
    crashing.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  assert.equal((await waitForFileBytes(gapMarker)).toString("utf8"), "artifact-held");
  assert.ok((await readFile(output)).equals(dataBytes), "Kill-Hook muss hinter dem vollstaendig gehaltenen Artifact liegen.");
  await assert.rejects(readFile(outputCompletion), { code: "ENOENT" });
  assert.equal(crashing.kill("SIGKILL"), true);
  const crashResult = await closed;
  assert.notEqual(crashResult.code, 0);
  assert.ok((await readFile(output)).equals(dataBytes));
  await assert.rejects(readFile(outputCompletion), { code: "ENOENT" });
  const recoveredRun = await execute(POWERSHELL_51, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    recoverHarness, ...baseArguments,
  ], { cwd: "C:\\Windows\\System32" });
  const recovered = JSON.parse(recoveredRun.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1));
  assert.deepEqual(recovered.recovered, recovered.verified);
  assert.deepEqual(recovered.verified, recovered.existing);
  assert.ok((await readFile(output)).equals(dataBytes));
  assert.ok((await readFile(outputCompletion)).equals(completionBytes));

  const rejectForeign = async ({ relativeFile, artifactBytes, completionBytes: existingCompletionBytes }) => {
    const directory = join(root, ...relativeFile.split("/").slice(0, -1));
    const artifact = join(root, ...relativeFile.split("/"));
    const completion = `${artifact}.zugfolge-complete.json`;
    const staged = join(stage, `${relativeFile.replaceAll("/", "-")}.completion.json`);
    const expectedCompletion = completionFor(relativeFile);
    await mkdir(directory);
    await writeFile(artifact, artifactBytes);
    if (existingCompletionBytes) await writeFile(completion, existingCompletionBytes);
    await writeFile(staged, expectedCompletion);
    const executed = await execute(POWERSHELL_51, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", rejectHarness,
      HELPER_PATH, root, stagedData, staged, relativeFile, String(dataBytes.length), dataSha,
      String(expectedCompletion.length), sha256(expectedCompletion),
    ], { cwd: "C:\\Windows\\System32" });
    const result = JSON.parse(executed.stdout.toString("utf8").trim().split(/\r?\n/u).at(-1));
    assert.notEqual(result.message, "unexpected-success");
    assert.ok((await readFile(artifact)).equals(artifactBytes));
    if (existingCompletionBytes) assert.ok((await readFile(completion)).equals(existingCompletionBytes));
    else await assert.rejects(readFile(completion), { code: "ENOENT" });
  };
  await rejectForeign({ relativeFile: "foreign-artifact/annual-plan.json", artifactBytes: Buffer.from("foreign-artifact\n") });
  await rejectForeign({
    relativeFile: "foreign-completion/annual-plan.json",
    artifactBytes: dataBytes,
    completionBytes: Buffer.from("foreign-completion\n"),
  });
});

test("Preparation-only Generator erzeugt Vendor-TAR und Toolchain-Manifest deterministisch", async (t) => {
  const root = await temporaryDirectory(t, "zugfolge-rebuild-inputs-");
  const vendorRoot = join(root, "vendor-root");
  await mkdir(join(vendorRoot, ".cargo"), { recursive: true });
  await mkdir(join(vendorRoot, "vendor", "crate-1.0.0", "src"), { recursive: true });
  await writeFile(join(vendorRoot, ".cargo", "config.toml"), "[source.crates-io]\nreplace-with = \"vendored-sources\"\n\n[source.vendored-sources]\ndirectory = \"vendor\"\n");
  await writeFile(join(vendorRoot, "vendor", "crate-1.0.0", ".cargo-checksum.json"), "{\"files\":{},\"package\":null}\n");
  await writeFile(join(vendorRoot, "vendor", "crate-1.0.0", "src", "lib.rs"), "pub fn pinned() {}\n");
  const tarA = join(root, "vendor-a.tar");
  const tarB = join(root, "vendor-b.tar");
  const firstTar = await execute(process.execPath, [PREPARATION_PATH, "vendor-tar", vendorRoot, tarA]);
  const secondTar = await execute(process.execPath, [PREPARATION_PATH, "vendor-tar", vendorRoot, tarB]);
  const [tarABytes, tarBBytes] = await Promise.all([readFile(tarA), readFile(tarB)]);
  assert.ok(tarABytes.equals(tarBBytes));
  assert.deepEqual(JSON.parse(firstTar.stdout), { bytes: tarABytes.length, path: tarA, sha256: sha256(tarABytes) });
  assert.deepEqual(JSON.parse(secondTar.stdout), { bytes: tarBBytes.length, path: tarB, sha256: sha256(tarBBytes) });
  assert.equal(tarABytes.subarray(257, 262).toString("ascii"), "ustar");
  assert.match(tarABytes.toString("utf8"), /comment=cargo-vendor-tree-v1/);
  const toolchainRoot = join(root, "toolchain");
  await mkdir(join(toolchainRoot, "bin"), { recursive: true });
  await mkdir(join(toolchainRoot, "lib", "rustlib"), { recursive: true });
  await writeFile(join(toolchainRoot, "bin", "cargo.exe"), "cargo-bytes\n");
  await writeFile(join(toolchainRoot, "bin", "rustc.exe"), "rustc-bytes\n");
  await writeFile(join(toolchainRoot, "lib", "rustlib", "helper.dll"), "helper-bytes\n");
  const manifestA = join(root, "manifest-a.json");
  const manifestB = join(root, "manifest-b.json");
  await execute(process.execPath, [PREPARATION_PATH, "toolchain-manifest", toolchainRoot, "test-toolchain-v1", manifestA]);
  await execute(process.execPath, [PREPARATION_PATH, "toolchain-manifest", toolchainRoot, "test-toolchain-v1", manifestB]);
  const [manifestABytes, manifestBBytes] = await Promise.all([readFile(manifestA), readFile(manifestB)]);
  assert.ok(manifestABytes.equals(manifestBBytes));
  const manifest = JSON.parse(manifestABytes);
  assert.equal(manifest.schema, "zugfolge-operational-validator-toolchain-manifest/v1");
  assert.deepEqual(manifest.directories, ["bin", "lib", "lib/rustlib"]);
  assert.deepEqual(manifest.files.map(({ file }) => file), ["bin/cargo.exe", "bin/rustc.exe", "lib/rustlib/helper.dll"]);
  assert.ok(manifest.files.every(({ bytes, sha256: hash }) => bytes > 0 && /^[a-f0-9]{64}$/u.test(hash)));
});

test("Workflow bindet Spec-Pfade, privaten GitHub-Assettransport und Sigstore-Verifikation", async () => {
  const [workflow, executionAuthorityWorkflow, runner] = await Promise.all([
    readFile(WORKFLOW_PATH, "utf8"),
    readFile(EXECUTION_AUTHORITY_WORKFLOW_PATH, "utf8"),
    readFile(WORKFLOW_RUNNER_PATH, "utf8"),
  ]);
  for (const required of [
    "preserved_validator_asset_id:", "api.github.com/repos/larynxberlin-rgb/Zugfolge/releases/assets",
    "Authorization: Bearer", "--proto '=https' --proto-redir '=https'",
    "subject-path: ${{ steps.evidence-paths.outputs.subjects }}",
    "path: ${{ steps.evidence-paths.outputs.artifact_paths }}",
    "path: ${{ steps.evidence-paths.outputs.authority_paths }}",
    "operational-validator-authority-infra-deutschland-2026.5-${{ github.run_id }}-${{ github.run_attempt }}",
    "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    "gh attestation verify", "--deny-self-hosted-runners", "--source-digest $env:GITHUB_SHA",
    "GITHUB_REF_PROTECTED -cne 'true'",
    "$spec.binaries.preserved.file",
    "$spec.authority.annualExecutorPlan.directContractFile",
    "$spec.authority.annualExecutorPlan.planFile",
    '"$($spec.authority.annualExecutorPlan.planFile).zugfolge-complete.json"',
    "$spec.authority.annualExecutorPlan.startEvidenceFile",
    '"$($spec.authority.annualExecutorPlan.startEvidenceFile).zugfolge-complete.json"',
    "zugfolge-germany-annual-create-new-artifact-completion/v1",
    "Annual-Completion ist nicht bytekanonisch",
    "$subjects",
  ]) assert.ok(workflow.includes(required), `Workflow bindet ${required} nicht.`);
  assert.doesNotMatch(workflow, /preserved_validator_url/u);
  assert.doesNotMatch(workflow, /zugfolge-infra-release-rebuild-[a-f0-9]{40}-official\.exe/u);
  for (const required of [
    "operator-approved-hash-binding-not-source-reexecution-v1",
    "environment: operational-release-approval",
    "operational-validator-authority-infra-deutschland-2026[.]5-",
    "Plan-Authority besitzt nicht exakt eine verifizierte Attestation mit der vollstaendigen Subjectmenge",
    "subject-name: var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json",
    "subject-name: var/derived/germany-2026.5/operational-infrastructure-v2.outer-execution-receipt.json.zugfolge-complete.json",
    "[IO.File]::AppendAllText($env:GITHUB_OUTPUT",
  ]) assert.ok(executionAuthorityWorkflow.includes(required), `Execution-Authority-Workflow bindet ${required} nicht.`);
  assert.doesNotMatch(executionAuthorityWorkflow, /Out-File\s+-LiteralPath\s+\$env:GITHUB_OUTPUT/u);
  const workflowLines = executionAuthorityWorkflow.split(/\r?\n/u);
  const runBodies = [];
  for (let index = 0; index < workflowLines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(workflowLines[index]);
    if (match === null) continue;
    const indentation = match[1].length;
    const body = [];
    for (index += 1; index < workflowLines.length; index += 1) {
      const line = workflowLines[index];
      const contentIndentation = /^(\s*)/u.exec(line)[1].length;
      if (line.trim() !== "" && contentIndentation <= indentation) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    runBodies.push(body.join("\n"));
  }
  assert.ok(runBodies.length > 0);
  for (const body of runBodies) {
    assert.doesNotMatch(body, /\$\{\{/u, "GitHub-Ausdruecke duerfen nicht in PowerShell-Quelltext interpoliert werden.");
  }
  for (const variable of [
    "PLAN_AUTHORITY_ARTIFACT_ID",
    "OUTER_RECEIPT_BYTES",
    "OUTER_RECEIPT_SHA256",
    "OUTER_COMPLETION_BYTES",
    "OUTER_COMPLETION_SHA256",
  ]) {
    assert.match(executionAuthorityWorkflow, new RegExp(`\\$env:${variable}`, "u"));
  }
  assert.match(runner, /phase = "materialize-validator-rebuild-v3"/u);
  assert.match(runner, /phase = "materialize-annual-plan-evidence-v1"/u);
  assert.match(runner, /GITHUB_ACTIONS === "true"/u);
  assert.match(runner, /createGermanyOperationalAnchoredRunnerInvocation/u);
  assert.doesNotMatch(runner, /operational-validator-rebuild-evidence-cli/u);
});

test("Node-Syntax aller Rebuild-v3-Produzenten bleibt gueltig", async () => {
  for (const file of [IMPLEMENTATION_PATH, HELPER_BUILDER_PATH, PREPARATION_PATH, WORKFLOW_RUNNER_PATH]) {
    await execute(process.execPath, ["--check", file]);
  }
});
