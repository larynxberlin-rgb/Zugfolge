import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createGermanyOperationalAnchoredRunnerInvocation,
  decodeGermanyOperationalAnchoredRunnerResult,
  executeGermanyOperationalPinnedValidator,
  GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
  GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND,
  GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE,
  germanyOperationalSystemLauncherSourceProof,
  integratedGermanyOperationalProvenance,
  loadGermanyOperationalExecutionPins,
  proveGermanyOperationalExecutionContext,
  serializeGermanyOperationalExecutionPins,
  validateGermanyOperationalExecutionProofAgainstPins,
  validateGermanyOperationalProvenance,
} from "./operational-infrastructure-v2-execution-pins.mjs";
import {
  buildGermanyOperationalAnchoredBundleFromEntrypoint,
  buildGermanyOperationalAnchoredRunnerBundle,
} from "./build-operational-infrastructure-v2-runner-bundle.mjs";
import { buildGermanyOperationalSystemLauncherSources } from "./build-operational-infrastructure-v2-system-launchers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, "../../..");
const RELEASE_ID = "infra-deutschland-2099.1";
const BUILD_COMMIT = "e".repeat(40);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function windowsAnchorHelperEnvironment() {
  const path = resolve(REPOSITORY_ROOT, ...GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE.split("/"));
  const bytes = await readFile(path);
  return {
    ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_PATH: path,
    ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_BYTES: String(bytes.length),
    ZUGFOLGE_OPERATIONAL_ANCHOR_HELPER_SHA256: sha256(bytes),
    ZUGFOLGE_OPERATIONAL_ANCHOR_TIMEOUT_MILLISECONDS: "120000",
  };
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function localImportSpecifier(fromFile, toFile) {
  const value = relative(dirname(fromFile), toFile).replaceAll("\\", "/");
  return value.startsWith(".") ? value : `./${value}`;
}

async function proof(path, file, schema) {
  const bytes = await readFile(path);
  return {
    file,
    bytes: bytes.length,
    sha256: sha256(bytes),
    ...(schema === undefined ? {} : { schema }),
  };
}

async function executorFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-execution-pins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const validatorFile = process.platform === "win32" ? "tools/preserved-node.exe" : "tools/preserved-node";
  const paths = {
    root,
    runner: join(root, "tools", "region-import", "germany", "run-capture-operational-infrastructure-v2.mjs"),
    bundle: join(root, "tools", "region-import", "germany", "run-capture-operational-infrastructure-v2.anchored-bundle.mjs"),
    captureRoot: join(root, "tools", "region-import", "germany", "capture-operational-infrastructure-v2-native-receipt.mjs"),
    commandBuilder: join(root, "tools", "region-import", "germany", "print-operational-infrastructure-v2-system-launch-command.mjs"),
    executionPinsImplementation: join(root, "tools", "region-import", "germany", "operational-infrastructure-v2-execution-pins.mjs"),
    linuxLauncherRoot: join(root, "tools", "region-import", "germany", "operational-infrastructure-v2-system-launcher.linux.py"),
    windowsLauncherRoot: join(root, "tools", "region-import", "germany", "operational-infrastructure-v2-system-launcher.windows.ps1"),
    windowsAnchorHelper: join(root, ...GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE.split("/")),
    publisherRoot: join(root, "tools", "region-import", "germany", "publish-operational-infrastructure-v2.mjs"),
    dependency: join(root, "tools", "region-import", "germany", "dependency.mjs"),
    validator: join(root, "tools", process.platform === "win32" ? "preserved-node.exe" : "preserved-node"),
    script: join(root, "derive-germany-operational-v2"),
    pins: join(root, "tools", "execution-pins.json"),
    rebuildSpecification: join(root, "tools", "rebuild-spec.json"),
    rebuildEvidence: join(root, "tools", "rebuild-evidence.json"),
    specification: join(root, "tools", "specification.json"),
    sourceRoot: join(root, "var", "input"),
    candidate: join(root, "var", "derived", "operational-infrastructure-v2.candidate.json"),
    report: join(root, "var", "derived", "operational-infrastructure-v2.derivation-report.json"),
    annualLaunchContract: join(root, "tools", "direct-system-launch.json"),
  };
  await Promise.all([
    mkdir(dirname(paths.runner), { recursive: true }),
    mkdir(paths.sourceRoot, { recursive: true }),
    mkdir(dirname(paths.candidate), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(process.execPath, paths.validator),
    writeFile(paths.runner, 'import "./dependency.mjs";\n', { flag: "wx" }),
    writeFile(paths.captureRoot, "export const captureRoot = true;\n", { flag: "wx" }),
    copyFile(join(HERE, "print-operational-infrastructure-v2-system-launch-command.mjs"), paths.commandBuilder),
    copyFile(join(HERE, "operational-infrastructure-v2-execution-pins.mjs"), paths.executionPinsImplementation),
    copyFile(join(HERE, "operational-infrastructure-v2-system-launcher.linux.py"), paths.linuxLauncherRoot),
    copyFile(join(HERE, "operational-infrastructure-v2-system-launcher.windows.ps1"), paths.windowsLauncherRoot),
    ...(process.platform === "win32"
      ? [copyFile(join(REPOSITORY_ROOT, ...GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE.split("/")), paths.windowsAnchorHelper)]
      : []),
    writeFile(paths.publisherRoot, "export const publisherRoot = true;\n", { flag: "wx" }),
    writeFile(paths.dependency, "export const dependency = true;\n", { flag: "wx" }),
    writeFile(paths.rebuildSpecification, '{"schema":"fixture-rebuild-spec/v1"}\n', { flag: "wx" }),
    writeFile(paths.rebuildEvidence, '{"schema":"fixture-rebuild-evidence/v1"}\n', { flag: "wx" }),
    writeFile(paths.specification, '{}\n', { flag: "wx" }),
  ]);
  const validatorProof = await proof(paths.validator, validatorFile);
  const rebuild = {
    specification: await proof(paths.rebuildSpecification, "tools/rebuild-spec.json"),
    evidence: await proof(paths.rebuildEvidence, "tools/rebuild-evidence.json", "fixture-rebuild-evidence/v1"),
    sourceCommit: BUILD_COMMIT,
  };

  async function prepare(scriptSource, { bundleSource = "// fixture anchored bundle\n", stdoutMaxBytes = 4096 } = {}) {
    for (const path of [paths.script, paths.pins, paths.bundle]) await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await unlink(paths.dependency).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await Promise.all([
      writeFile(paths.script, scriptSource, { flag: "wx" }),
      writeFile(paths.bundle, bundleSource, { flag: "wx" }),
      writeFile(paths.dependency, "export const dependency = true;\n", { flag: "wx" }),
    ]);
    const runnerProof = await proof(paths.runner, "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs");
    const bundleProof = await proof(paths.bundle, "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs");
    const captureRootProof = await proof(paths.captureRoot, "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs");
    const linuxLauncherRootProof = await proof(paths.linuxLauncherRoot, "tools/region-import/germany/operational-infrastructure-v2-system-launcher.linux.py");
    const windowsLauncherRootProof = await proof(paths.windowsLauncherRoot, "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1");
    const windowsAnchorHelperProof = process.platform === "win32"
      ? await proof(paths.windowsAnchorHelper, GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE)
      : null;
    const publisherRootProof = await proof(paths.publisherRoot, "tools/region-import/germany/publish-operational-infrastructure-v2.mjs");
    const platformLauncherRootProof = process.platform === "win32" ? windowsLauncherRootProof : linuxLauncherRootProof;
    const importClosure = [
      captureRootProof,
      await proof(paths.dependency, "tools/region-import/germany/dependency.mjs"),
      platformLauncherRootProof,
      ...(windowsAnchorHelperProof === null ? [] : [windowsAnchorHelperProof]),
      publisherRootProof,
      runnerProof,
    ].sort((left, right) => left.file.localeCompare(right.file, "en"));
    const pins = {
      schema: GERMANY_OPERATIONAL_EXECUTION_PINS_SCHEMA,
      releaseId: RELEASE_ID,
      runner: {
        anchorHelper: windowsAnchorHelperProof,
        bundle: bundleProof,
        entrypoint: runnerProof,
        roots: [captureRootProof, publisherRootProof, runnerProof],
        importClosure,
        invocation: {
          mode: "system-launcher-held-bundle-stdin-v1",
          nodeArguments: ["--input-type=module", "-"],
          nodeOptions: null,
        },
        launcher: germanyOperationalSystemLauncherSourceProof(process.platform),
        runtime: {
          id: "nodejs-24-operational-runner-v1",
          platform: process.platform,
          bytes: validatorProof.bytes,
          sha256: validatorProof.sha256,
        },
      },
      validator: {
        file: validatorProof.file,
        buildCommit: BUILD_COMMIT,
        bytes: validatorProof.bytes,
        sha256: validatorProof.sha256,
        rebuildSpecification: rebuild.specification.file,
        rebuildEvidence: rebuild.evidence.file,
      },
      command: {
        name: "derive-germany-operational-v2",
        argumentPrefix: [],
        argumentFiles: [],
        arguments: [
          "derive-germany-operational-v2",
          "{specification}",
          "{sourceRoot}",
          "{candidate}",
          "{report}",
        ],
        stdoutMaxBytes,
      },
    };
    await writeFile(paths.pins, serializeGermanyOperationalExecutionPins(pins, RELEASE_ID), { flag: "wx" });
    const executionPinsSource = await loadGermanyOperationalExecutionPins({
      workspaceRoot: root,
      executionPinsPath: paths.pins,
      expectedReleaseId: RELEASE_ID,
    });
    const executionContextProof = await proveGermanyOperationalExecutionContext({
      workspaceRoot: root,
      executionPins: pins,
      verifyCurrentInvocation: false,
    });
    let annualLaunchProofBase64;
    if (process.platform === "win32") {
      await unlink(paths.annualLaunchContract).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      const contract = canonicalValue({
        bootstrap: {},
        dynamicBindings: [],
        executionPins: executionPinsSource.proof,
        launcher: {},
        platform: "win32",
        releaseId: RELEASE_ID,
        schema: "zugfolge-operational-v2-direct-system-launch-contract/v1",
        trustedExecutor: {
          buildCommit: BUILD_COMMIT,
          bytes: validatorProof.bytes,
          file: validatorProof.file,
          sha256: validatorProof.sha256,
        },
      });
      const contractBytes = Buffer.from(`${JSON.stringify(contract)}\n`, "utf8");
      await writeFile(paths.annualLaunchContract, contractBytes, { flag: "wx" });
      const annualLaunch = canonicalValue({
        contract: {
          bytes: contractBytes.length,
          file: "tools/direct-system-launch.json",
          releaseId: RELEASE_ID,
          schema: contract.schema,
          sha256: sha256(contractBytes),
        },
        executionPins: executionPinsSource.proof,
        mode: "held-direct-contract-windows-v1",
        trustedExecutor: contract.trustedExecutor,
      });
      annualLaunchProofBase64 = Buffer.from(JSON.stringify(annualLaunch), "utf8").toString("base64");
    }
    return { executionPinsSource, runnerProof: executionContextProof, annualLaunchProofBase64 };
  }

  async function execute(prepared, options = {}) {
    return executeGermanyOperationalPinnedValidator({
      workspaceRoot: root,
      executionPinsSource: prepared.executionPinsSource,
      runnerProof: prepared.runnerProof,
      validatorRebuild: rebuild,
      specificationPath: paths.specification,
      sourceRoot: paths.sourceRoot,
      candidatePath: paths.candidate,
      reportPath: paths.report,
      annualLaunchProofBase64: prepared.annualLaunchProofBase64,
      runnerPhase: "derive-and-capture-v1",
      ...options,
    });
  }

  async function directBundle(prepared, { beforeSpawn, env = {}, nodePath = process.execPath } = {}) {
    const arguments_ = [
      paths.pins,
      paths.specification,
      paths.sourceRoot,
      paths.candidate,
      `${paths.candidate}.sidecar.json`,
      paths.report,
      `${paths.candidate}.native-receipt.json`,
    ];
    const invocation = await createGermanyOperationalAnchoredRunnerInvocation({
      workspaceRoot: root,
      executionPinsPath: paths.pins,
      arguments: arguments_,
      nodePath,
      annualLaunchProofBase64: prepared.annualLaunchProofBase64,
    });
    await beforeSpawn?.({ invocation, arguments: arguments_ });
    const result = spawnSync(invocation.command, invocation.arguments, {
      cwd: invocation.cwd,
      encoding: "utf8",
      env: { ...invocation.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
      shell: false,
      windowsHide: true,
    });
    return { invocation, result, decode: () => decodeGermanyOperationalAnchoredRunnerResult(result, invocation.expected) };
  }

  async function assertNoExecutionLeak() {
    const executionRoots = (await readdir(dirname(paths.candidate)))
      .filter((entry) => entry.startsWith(".operational-v2-exec-"));
    assert.ok(
      executionRoots.every((entry) => entry.startsWith(".operational-v2-exec-retained-owned-cleanup-")),
      "kein aktiver oder unmarkierter Execution-Root darf nach dem Lauf verbleiben",
    );
  }

  return { paths, validatorProof, rebuild, prepare, execute, directBundle, assertNoExecutionLeak };
}

test("Annual Execution-Pins laden die aba354e-Bytes und beweisen die vollstaendige aktuelle Importclosure", async () => {
  const executionPinsPath = join(HERE, "operational-infrastructure-v2-execution-pins.annual-2026.5.json");
  const source = await loadGermanyOperationalExecutionPins({
    workspaceRoot: REPOSITORY_ROOT,
    executionPinsPath,
    expectedReleaseId: "infra-deutschland-2026.5",
  });
  assert.equal(source.value.validator.buildCommit, "aba354ec1937452a491087626ec0adea36ef6695");
  assert.equal(source.value.validator.bytes, 8_382_277);
  assert.equal(source.value.validator.sha256, "c35e72e352ae573e0416035fc4f0d233af5668864c0bd8df7333337e87bb7fd4");
  assert.equal(source.value.runner.bundle.file, "tools/region-import/germany/run-capture-operational-infrastructure-v2.anchored-bundle.mjs");
  assert.equal(source.value.runner.entrypoint.file, "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs");
  assert.deepEqual(source.value.runner.invocation, {
    mode: "system-launcher-held-bundle-stdin-v1",
    nodeArguments: ["--input-type=module", "-"],
    nodeOptions: null,
  });
  assert.deepEqual(source.value.runner.launcher, germanyOperationalSystemLauncherSourceProof("win32"));
  assert.deepEqual(source.value.runner.runtime, {
    id: "nodejs-24-operational-runner-v1",
    platform: "win32",
    bytes: 92_825_416,
    sha256: "3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237",
  });
  assert.deepEqual(source.value.runner.roots.map(({ file }) => file), [
    "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs",
    "tools/region-import/germany/publish-operational-infrastructure-v2.mjs",
    "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs",
  ]);
  const runner = await proveGermanyOperationalExecutionContext({
    workspaceRoot: REPOSITORY_ROOT,
    executionPins: source.value,
    verifyCurrentInvocation: false,
  });
  assert.equal(runner.importClosure.length, source.value.runner.importClosure.length);
  assert.deepEqual(runner.entrypoint, runner.importClosure.find(({ file }) => file === source.value.runner.entrypoint.file));
});

test("eingechecktes Runner-Bundle ist deterministisch neu gebaut und besitzt nur node:-Laufzeitkanten", async () => {
  const expected = await buildGermanyOperationalAnchoredRunnerBundle();
  const actual = await readFile(join(HERE, "run-capture-operational-infrastructure-v2.anchored-bundle.mjs"));
  assert.deepEqual(actual, expected);
  assert.doesNotMatch(actual.toString("utf8"), /source-noneligible-v1/u);
  assert.match(actual.toString("utf8"), /anchored-stdin-bundle-v1/u);
});

test("eingecheckte OS-Launcher-Datenfiles sind deterministisch und bytegleich zu ihren Source-Proofs", async () => {
  for (const [file, expected] of buildGermanyOperationalSystemLauncherSources()) {
    const actual = await readFile(join(REPOSITORY_ROOT, ...file.split("/")));
    assert.deepEqual(actual, expected, file);
    const platform = file.endsWith(".ps1") ? "win32" : "linux";
    const sourceProof = germanyOperationalSystemLauncherSourceProof(platform);
    assert.equal(actual.length, sourceProof.sourceBytes);
    assert.equal(sha256(actual), sourceProof.sourceSha256);
  }
});

test("direkter Quell-.mjs-Aufruf ist hart noneligible und startet keinen Release-Runner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-source-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = join(root, "native-receipt.json");
  const result = spawnSync(process.execPath, [
    join(HERE, "run-capture-operational-infrastructure-v2.mjs"),
    "pins.json", "spec.json", ".", "candidate.json", "sidecar.json", "report.json", marker,
  ], { cwd: root, encoding: "utf8", env: { ...process.env }, shell: false, windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /direkte \.mjs-Aufruf ist nur Quellcode|keine releasefaehigen/u);
  await assert.rejects(readFile(marker), (error) => error?.code === "ENOENT");
});

test("optionaler Command-Printer besitzt keine Prozesskante und bleibt aus der Release-Closure ausgeschlossen", { skip: process.platform !== "win32" }, async (t) => {
  const printerPath = join(HERE, "print-operational-infrastructure-v2-system-launch-command.mjs");
  const printerSource = await readFile(printerPath, "utf8");
  assert.doesNotMatch(printerSource, /node:child_process|\bspawn(?:Sync)?\s*\(|\bexec(?:File|Sync)?\s*\(/u);
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-command-printer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeReceipt = join(root, "must-not-exist.native-receipt.json");
  const executionPinsPath = join(HERE, "operational-infrastructure-v2-execution-pins.annual-2026.5.json");
  const result = spawnSync(process.execPath, [
    printerPath,
    process.execPath,
    executionPinsPath,
    join(HERE, "operational-infrastructure.annual-2026.5.json"),
    REPOSITORY_ROOT,
    join(root, "candidate.json"),
    join(root, "candidate.sidecar.json"),
    join(root, "report.json"),
    nativeReceipt,
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_MODE: "command-printer-must-not-reexec-v1",
      ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH: join(root, "forbidden-parser-child.exe"),
    },
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout);
  const pins = (await loadGermanyOperationalExecutionPins({ workspaceRoot: REPOSITORY_ROOT, executionPinsPath })).value;
  assert.equal(metadata.schema, "zugfolge-operational-v2-direct-system-launch-command/v1");
  assert.equal(metadata.mode, "source-only-print-direct-command-v1");
  assert.deepEqual(metadata.directCommand, {
    handoff: "diagnostic-copy-only-v1",
    releaseExecutionEligible: false,
    requiredVerification: "none-diagnostic-output-is-never-a-release-entrypoint",
  });
  assert.deepEqual(metadata.commandBuilder, {
    file: "tools/region-import/germany/print-operational-infrastructure-v2-system-launch-command.mjs",
    causal: false,
    releaseEvidenceEligible: false,
  });
  assert.equal(pins.runner.roots.some(({ file }) => file === metadata.commandBuilder.file), false);
  assert.equal(pins.runner.importClosure.some(({ file }) => file === metadata.commandBuilder.file), false);
  assert.deepEqual(metadata.expected, {
    bundle: pins.runner.bundle,
    launcher: pins.runner.launcher,
    runtime: pins.runner.runtime,
  });
  for (const field of ["command", "arguments", "cwd", "environment"]) {
    assert.equal(Object.hasOwn(metadata, field), false, `Diagnoseausgabe darf ${field} nicht transportieren.`);
  }
  assert.doesNotMatch(result.stdout, /BEGIN EXACT DIRECT OS COMMAND|EncodedCommand|run-capture-operational-infrastructure-v2\.mjs/u);
  await assert.rejects(readFile(nativeReceipt), (error) => error?.code === "ENOENT");
});

test("direkter Systemlauncher bindet sieben CLI-Werte, Runtime, Bundle und bereinigte Umgebung", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: `
      const args = Array.from({length: 7}, (_, index) => process.env[\`ZUGFOLGE_OPERATIONAL_RUNNER_CLI_\${index}\`]);
      process.stdout.write(JSON.stringify({
        args,
        argv: process.argv,
        nodeOptions: process.env.NODE_OPTIONS ?? null,
        corProfiler: process.env.COR_PROFILER_PATH ?? null,
        coreClrProfiler: process.env.CORECLR_PROFILER_PATH ?? null,
        dotnetHooks: process.env.DOTNET_STARTUP_HOOKS ?? null,
        helperBytes: process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_BYTES ?? null,
        helperPath: process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_PATH ?? null,
        helperSha256: process.env.ZUGFOLGE_OPERATIONAL_RUNNER_ANCHOR_HELPER_SHA256 ?? null,
        psModulePath: process.env.PSModulePath ?? null,
        marker: "held-bundle",
      }) + "\\n");
    `,
  });
  const hostileLoader = join(value.paths.root, "foreign-loader.dll");
  const direct = await value.directBundle(prepared, { env: {
    NODE_OPTIONS: "--import=foreign.mjs",
    COR_ENABLE_PROFILING: "1",
    COR_PROFILER: "{11111111-1111-1111-1111-111111111111}",
    COR_PROFILER_PATH: hostileLoader,
    CORECLR_ENABLE_PROFILING: "1",
    CORECLR_PROFILER: "{11111111-1111-1111-1111-111111111111}",
    CORECLR_PROFILER_PATH: hostileLoader,
    DOTNET_STARTUP_HOOKS: hostileLoader,
    PSModulePath: dirname(hostileLoader),
  } });
  const decoded = direct.decode();
  assert.equal(decoded.status, 0);
  assert.equal(decoded.signal, null);
  const receipt = JSON.parse(decoded.stdout.toString("utf8"));
  assert.equal(receipt.marker, "held-bundle");
  assert.equal(receipt.args.length, 7);
  assert.deepEqual(receipt.argv.slice(1), ["-"]);
  assert.equal(receipt.nodeOptions, null);
  assert.equal(receipt.corProfiler, null);
  assert.equal(receipt.coreClrProfiler, null);
  assert.equal(receipt.dotnetHooks, null);
  if (process.platform === "win32") {
    assert.equal(receipt.helperPath, value.paths.windowsAnchorHelper);
    assert.equal(receipt.helperBytes, String(prepared.executionPinsSource.value.runner.anchorHelper.bytes));
    assert.equal(receipt.helperSha256, prepared.executionPinsSource.value.runner.anchorHelper.sha256);
  } else {
    assert.equal(receipt.helperPath, null);
    assert.equal(receipt.helperBytes, null);
    assert.equal(receipt.helperSha256, null);
  }
  assert.equal(receipt.psModulePath, null);
});

test("Systemlauncher transportiert einen gebundenen Kindprozessfehler ohne den Ankerbeleg zu verlieren", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: `
      process.stderr.write("gebundener Kindprozessfehler\\n");
      process.exit(17);
    `,
  });
  const direct = await value.directBundle(prepared);
  const decoded = direct.decode();
  assert.equal(direct.result.status, 94);
  assert.equal(decoded.status, 17);
  assert.equal(decoded.signal, null);
  assert.equal(decoded.stdout.length, 0);
  assert.equal(decoded.stderr.toString("utf8"), "gebundener Kindprozessfehler\n");
});

test("Windows-Node-Runner bevorzugt System32 trotz ungueltiger App-Directory-dbghelp.dll", { skip: process.platform !== "win32" }, async (t) => {
  const value = await executorFixture(t);
  const runtimeDirectory = join(value.paths.root, "hostile-node-runtime");
  const runtimePath = join(runtimeDirectory, "node.exe");
  const sidecarPath = join(runtimeDirectory, "dbghelp.dll");
  await mkdir(runtimeDirectory);
  await copyFile(process.execPath, runtimePath);
  await writeFile(sidecarPath, "invalid attacker-controlled dbghelp image\n", { flag: "wx" });
  const cleanEnvironment = {
    SystemRoot: String.raw`C:\Windows`,
    WINDIR: String.raw`C:\Windows`,
    PATH: String.raw`C:\Windows\System32;C:\Windows`,
  };
  const unmitigated = spawnSync(runtimePath, ["--version"], {
    cwd: value.paths.root,
    encoding: "utf8",
    env: cleanEnvironment,
    shell: false,
    windowsHide: true,
  });
  assert.notEqual(unmitigated.status, 0, "die ungehärtete Kontrollausführung muss die bösartige App-Directory-DLL laden wollen");

  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: `
      import { spawnSync } from "node:child_process";
      const reexec = spawnSync(process.execPath, ["--version"], { encoding: "utf8", env: process.env, shell: false, windowsHide: true });
      process.stdout.write(JSON.stringify({marker:"system32-node", reexecStatus: reexec.status, reexecVersion: reexec.stdout.trim()}) + "\\n");
    `,
  });
  const direct = await value.directBundle(prepared, { nodePath: runtimePath });
  const decoded = direct.decode();
  assert.equal(decoded.status, 0);
  assert.deepEqual(JSON.parse(decoded.stdout.toString("utf8")), { marker: "system32-node", reexecStatus: 0, reexecVersion: process.version });
  assert.equal(await readFile(sidecarPath, "utf8"), "invalid attacker-controlled dbghelp image\n");
});

test("Linux sealed Runtime-Reexec startet den echten Closure-Parser aus dem gehaltenen memfd", { skip: process.platform !== "linux" }, async (t) => {
  const value = await executorFixture(t);
  const probeEntrypoint = join(value.paths.root, "closure-parser-probe.mjs");
  await writeFile(probeEntrypoint, `
    import { readFileSync } from "node:fs";
    import { proveGermanyOperationalExecutionContext } from ${JSON.stringify(localImportSpecifier(probeEntrypoint, join(HERE, "operational-infrastructure-v2-execution-pins.mjs")))};
    const workspaceRoot = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT;
    const pinsPath = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_0;
    const pins = JSON.parse(readFileSync(pinsPath, "utf8"));
    const proof = await proveGermanyOperationalExecutionContext({ workspaceRoot, executionPins: pins });
    process.stdout.write(JSON.stringify({ closureFiles: proof.importClosure.map(({ file }) => file), reexec: process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH }) + "\\n");
  `, { flag: "wx" });
  const bundle = await buildGermanyOperationalAnchoredBundleFromEntrypoint({
    entrypoint: probeEntrypoint,
    expectedContextMarkers: 0,
  });
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', { bundleSource: bundle });
  const direct = await value.directBundle(prepared);
  const decoded = direct.decode();
  assert.equal(decoded.status, 0);
  const receipt = JSON.parse(decoded.stdout.toString("utf8"));
  assert.deepEqual(receipt.closureFiles, prepared.executionPinsSource.value.runner.importClosure.map(({ file }) => file));
  assert.match(receipt.reexec, /^\/proc\/[1-9][0-9]*\/fd\/[0-9]+$/u);
});

test("Linux Closure-Parser verwirft einen falschen Runtime-Reexec-Anker fail-closed", { skip: process.platform !== "linux" }, async (t) => {
  const value = await executorFixture(t);
  const marker = join(value.paths.root, "false-reexec-accepted.txt");
  const probeEntrypoint = join(value.paths.root, "false-reexec-probe.mjs");
  await writeFile(probeEntrypoint, `
    import { readFileSync, writeFileSync } from "node:fs";
    import { proveGermanyOperationalExecutionContext } from ${JSON.stringify(localImportSpecifier(probeEntrypoint, join(HERE, "operational-infrastructure-v2-execution-pins.mjs")))};
    process.env.ZUGFOLGE_OPERATIONAL_RUNNER_NODE_REEXEC_PATH = "/proc/999999999/fd/99";
    const workspaceRoot = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_WORKSPACE_ROOT;
    const pins = JSON.parse(readFileSync(process.env.ZUGFOLGE_OPERATIONAL_RUNNER_CLI_0, "utf8"));
    await proveGermanyOperationalExecutionContext({ workspaceRoot, executionPins: pins });
    writeFileSync(${JSON.stringify(marker)}, "accepted\\n");
  `, { flag: "wx" });
  const bundle = await buildGermanyOperationalAnchoredBundleFromEntrypoint({
    entrypoint: probeEntrypoint,
    expectedContextMarkers: 0,
  });
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', { bundleSource: bundle });
  const direct = await value.directBundle(prepared);
  assert.notEqual(direct.result.status, 0);
  assert.throws(direct.decode, /System-Bundle-Launcher/u);
  await assert.rejects(readFile(marker), (error) => error?.code === "ENOENT");
});

test("vor dem Anchor gedriftetes Bundle fuehrt fremde Bytes niemals aus und erzeugt keinen Erfolgsbeleg", async (t) => {
  const value = await executorFixture(t);
  const foreignMarker = join(value.paths.root, "foreign-bundle-started.txt");
  const bundleBackup = join(value.paths.root, "owned-bundle.backup.mjs");
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: 'process.stdout.write("owned\\n");\n',
  });
  const original = await readFile(value.paths.bundle);
  await writeFile(bundleBackup, original, { flag: "wx" });
  const foreign = `
    import { copyFileSync, unlinkSync, writeFileSync } from "node:fs";
    try { unlinkSync(${JSON.stringify(value.paths.bundle)}); copyFileSync(${JSON.stringify(bundleBackup)}, ${JSON.stringify(value.paths.bundle)}); } catch {}
    writeFileSync(${JSON.stringify(foreignMarker)}, "started\\n");
    process.stdout.write("foreign\\n");
  `;
  const replaced = await value.directBundle(prepared, {
    beforeSpawn: async () => {
      await unlink(value.paths.bundle);
      await writeFile(value.paths.bundle, foreign, { flag: "wx" });
    },
  });
  assert.notEqual(replaced.result.status, 0);
  assert.throws(replaced.decode, /System-Bundle-Launcher|System-Bundle-Ankerbeleg/u);
  await assert.rejects(readFile(foreignMarker), (error) => error?.code === "ENOENT");
  if (!original.equals(await readFile(value.paths.bundle))) {
    await unlink(value.paths.bundle);
    await writeFile(value.paths.bundle, original, { flag: "wx" });
  }
  assert.deepEqual(await readFile(value.paths.bundle), original);
});

test("vor dem Anchor gedriftete Runtime fuehrt fremde Bytes niemals aus und erzeugt keinen Erfolgsbeleg", async (t) => {
  const value = await executorFixture(t);
  const runtimePath = join(value.paths.root, process.platform === "win32" ? "runtime-node.exe" : "runtime-node");
  const runtimeBackup = join(value.paths.root, process.platform === "win32" ? "runtime-node.backup.exe" : "runtime-node.backup");
  const marker = join(value.paths.root, "foreign-runtime-started.txt");
  await copyFile(process.execPath, runtimePath);
  await copyFile(process.execPath, runtimeBackup);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: `
      import { copyFileSync, unlinkSync, writeFileSync } from "node:fs";
      try { unlinkSync(${JSON.stringify(runtimePath)}); copyFileSync(${JSON.stringify(runtimeBackup)}, ${JSON.stringify(runtimePath)}); } catch {}
      writeFileSync(${JSON.stringify(marker)}, "started\\n");
      process.stdout.write("foreign runtime\\n");
    `,
  });
  const original = await readFile(runtimePath);
  const foreign = Buffer.concat([original, Buffer.from([0x5a])]);
  const replaced = await value.directBundle(prepared, {
    nodePath: runtimePath,
    beforeSpawn: async () => {
      await unlink(runtimePath);
      await writeFile(runtimePath, foreign, { flag: "wx" });
    },
  });
  assert.notEqual(replaced.result.status, 0);
  assert.throws(replaced.decode, /System-Bundle-Launcher|System-Bundle-Ankerbeleg/u);
  await assert.rejects(readFile(marker), (error) => error?.code === "ENOENT");
  if (!original.equals(await readFile(runtimePath))) {
    await unlink(runtimePath);
    await writeFile(runtimePath, original, { flag: "wx" });
  }
  assert.deepEqual(await readFile(runtimePath), original);
});

test("Windows haelt Bundle und Runtime nach Hashbindung bis zum A-Prozessende gegen B-Austausch gesperrt", { skip: process.platform !== "win32" }, async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: `
      import { renameSync, unlinkSync, writeFileSync } from "node:fs";
      const targets = {
        bundle: process.env.ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SOURCE_PATH,
        runtime: process.env.ZUGFOLGE_OPERATIONAL_RUNNER_RUNTIME_SOURCE_PATH,
      };
      const outcomes = {};
      for (const [name, path] of Object.entries(targets)) {
        outcomes[name] = {};
        try { writeFileSync(path, Buffer.from([0x42]), { flag: "r+" }); outcomes[name].write = null; }
        catch (error) { outcomes[name].write = error.code; }
        try { renameSync(path, path + ".foreign-b"); outcomes[name].rename = null; }
        catch (error) { outcomes[name].rename = error.code; }
        try { unlinkSync(path); outcomes[name].unlink = null; }
        catch (error) { outcomes[name].unlink = error.code; }
      }
      process.stdout.write(JSON.stringify(outcomes) + "\\n");
    `,
  });
  const direct = await value.directBundle(prepared);
  const decoded = direct.decode();
  const outcomes = JSON.parse(decoded.stdout.toString("utf8"));
  for (const result of [outcomes.bundle, outcomes.runtime]) {
    assert.match(result.write, /^(?:EBUSY|EACCES|EPERM)$/u);
    assert.match(result.rename, /^(?:EBUSY|EACCES|EPERM)$/u);
    assert.match(result.unlink, /^(?:EBUSY|EACCES|EPERM)$/u);
  }
  assert.equal(sha256(await readFile(value.paths.bundle)), direct.invocation.expected.bundle.sha256);
  assert.equal(sha256(await readFile(process.execPath)), direct.invocation.expected.runtime.sha256);
});

test("Linux startet nach held Hashbindung selbst bei Bundle-und-Runtime-A-B-A weiterhin nur versiegelte A-Bytes", { skip: process.platform !== "linux" }, async (t) => {
  const value = await executorFixture(t);
  const marker = join(value.paths.root, "foreign-b-executed.txt");
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: `
      import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
      import { createHash } from "node:crypto";
      const marker = ${JSON.stringify(marker)};
      const bundlePath = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_BUNDLE_SOURCE_PATH;
      const runtimePath = process.env.ZUGFOLGE_OPERATIONAL_RUNNER_RUNTIME_SOURCE_PATH;
      const bundleBackup = bundlePath + ".held-a-backup";
      const runtimeBackup = runtimePath + ".held-a-backup";
      const bundleA = readFileSync(bundlePath);
      const runtimeA = readFileSync(runtimePath);
      renameSync(bundlePath, bundleBackup);
      writeFileSync(bundlePath, 'import { writeFileSync } from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', "B\\n");\\n', { flag: "wx" });
      renameSync(runtimePath, runtimeBackup);
      writeFileSync(runtimePath, Buffer.concat([runtimeA, Buffer.from([0x42])]), { flag: "wx", mode: 0o700 });
      unlinkSync(bundlePath);
      renameSync(bundleBackup, bundlePath);
      unlinkSync(runtimePath);
      renameSync(runtimeBackup, runtimePath);
      process.stdout.write(JSON.stringify({
        bundleSha256: createHash("sha256").update(readFileSync(bundlePath)).digest("hex"),
        runtimeSha256: createHash("sha256").update(readFileSync(runtimePath)).digest("hex"),
      }) + "\\n");
    `,
  });
  const direct = await value.directBundle(prepared);
  const decoded = direct.decode();
  assert.equal(decoded.status, 0);
  const receipt = JSON.parse(decoded.stdout.toString("utf8"));
  assert.equal(receipt.bundleSha256, direct.invocation.expected.bundle.sha256);
  assert.equal(receipt.runtimeSha256, direct.invocation.expected.runtime.sha256);
  await assert.rejects(readFile(marker), (error) => error?.code === "ENOENT");
});

test("Systemlauncher propagiert Bundlefehler als eigenen Nonzero-Exit ohne Receipt oder Proof", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: 'process.stderr.write("bundle failure\\n"); process.exit(7);\n',
  });
  const failed = await value.directBundle(prepared);
  assert.notEqual(failed.result.status, 0);
  const decoded = failed.decode();
  assert.equal(failed.result.status, 94);
  assert.deepEqual({ status: decoded.status, signal: decoded.signal }, { status: 7, signal: null });
  assert.equal(decoded.stdout.length, 0);
  assert.equal(decoded.stderr.toString("utf8"), "bundle failure\n");
  await assert.rejects(readFile(`${value.paths.candidate}.native-receipt.json`), (error) => error?.code === "ENOENT");
});

test("privater Systemlauncher-Temp-Root bewahrt fremde Dateien und blockiert den Erfolgsbeleg", async (t) => {
  const value = await executorFixture(t);
  const pointer = join(value.paths.root, "private-temp-pointer.json");
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: `
      import { mkdirSync, renameSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const root = process.env.TEMP ?? process.env.TMPDIR;
      const moved = root + ".foreign-swap";
      let active = root;
      try { renameSync(root, moved); mkdirSync(root); active = root; } catch {}
      writeFileSync(join(active, "foreign.txt"), "preserve me\\n");
      writeFileSync(${JSON.stringify(pointer)}, JSON.stringify({ active, moved }));
      process.stdout.write("{}\\n");
    `,
  });
  const result = await value.directBundle(prepared);
  assert.notEqual(result.result.status, 0);
  assert.throws(result.decode, /System-Bundle-Launcher/u);
  const locations = JSON.parse(await readFile(pointer, "utf8"));
  assert.equal(await readFile(join(locations.active, "foreign.txt"), "utf8"), "preserve me\n");
  t.after(() => rm(locations.active, { recursive: true, force: true }));
  if (locations.moved !== locations.active) t.after(() => rm(locations.moved, { recursive: true, force: true }));
});

test("uebergrosser Bundle-stdout erzeugt keinen Erfolgsbeleg", async (t) => {
  const value = await executorFixture(t);

  const oversize = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: 'process.stdout.write("x".repeat(2 * 1024 * 1024));\n',
  });
  const oversized = await value.directBundle(oversize);
  assert.notEqual(oversized.result.status, 0);
  assert.throws(oversized.decode, /System-Bundle-Launcher|System-Bundle-Ankerbeleg/u);
});

test("Windows-Systemlauncher verwirft gepinnte beliebige Executable-Bytes ohne Node-24-Laufzeit", { skip: process.platform !== "win32" }, async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n', {
    bundleSource: 'process.stdout.write("must-not-run\\n");\n',
  });
  const commandPath = String.raw`C:\Windows\System32\cmd.exe`;
  const commandBytes = await readFile(commandPath);
  const pins = structuredClone(prepared.executionPinsSource.value);
  pins.runner.runtime = {
    ...pins.runner.runtime,
    bytes: commandBytes.length,
    sha256: sha256(commandBytes),
  };
  await unlink(value.paths.pins);
  await writeFile(value.paths.pins, serializeGermanyOperationalExecutionPins(pins, RELEASE_ID), { flag: "wx" });
  const direct = await value.directBundle(prepared, { nodePath: commandPath });
  assert.notEqual(direct.result.status, 0);
  assert.throws(direct.decode, /System-Bundle-Launcher|System-Bundle-Ankerbeleg/u);
  assert.doesNotMatch(direct.result.stdout, /must-not-run/u);
});

test("gepinntes Binary startet held-copy Bytes und liefert exakt einen begrenzten JSON-Datensatz", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write(JSON.stringify({ok:true,kind:"native"}) + "\\n");\n');
  const result = await value.execute(prepared);
  assert.deepEqual(result.nativeReceipt, { ok: true, kind: "native" });
  assert.equal(result.executionProof.validator.preserved.sha256, value.validatorProof.sha256);
  assert.equal(result.executionProof.validator.executed.sha256, value.validatorProof.sha256);
  assert.equal(result.executionProof.stdout.recordCount, 1);
  assert.deepEqual(result.executionProof.exit, { code: 0, signal: null });
  await value.assertNoExecutionLeak();
});

test("Windows startet die gehashten Copy-Bytes unter einem exklusiven Write-/Delete-Handle", { skip: process.platform !== "win32" }, async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare(`
    import { renameSync, writeFileSync } from "node:fs";
    const failures = {};
    try { writeFileSync(process.execPath, Buffer.from([0x5a]), { flag: "r+" }); failures.write = null; }
    catch (error) { failures.write = error.code; }
    try { renameSync(process.execPath, process.execPath + ".foreign"); failures.rename = null; }
    catch (error) { failures.rename = error.code; }
    process.stdout.write(JSON.stringify(failures) + "\\n");
  `);
  const previousSystemRoot = process.env.SystemRoot;
  const previousWindir = process.env.WINDIR;
  process.env.SystemRoot = join(value.paths.root, "attacker-system-root");
  process.env.WINDIR = join(value.paths.root, "attacker-windir");
  let result;
  try {
    result = await value.execute(prepared);
  } finally {
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
    if (previousWindir === undefined) delete process.env.WINDIR;
    else process.env.WINDIR = previousWindir;
  }
  assert.match(result.nativeReceipt.write, /^(?:EBUSY|EACCES|EPERM)$/u);
  assert.match(result.nativeReceipt.rename, /^(?:EBUSY|EACCES|EPERM)$/u);
  assert.equal(result.executionProof.validator.executed.mode, "windows-exclusive-handle-launch-v1");
  await value.assertNoExecutionLeak();
});

test("Windows-Validator bevorzugt System32 trotz ungueltiger App-Directory-dbghelp.dll", { skip: process.platform !== "win32" }, async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write(JSON.stringify({marker:"system32-validator"}) + "\\n");\n');
  let sidecarPath;
  let unmitigatedStatus;
  const result = await value.execute(prepared, {
    hooks: {
      beforeValidatorSpawn: async ({ executionPath }) => {
        sidecarPath = join(dirname(executionPath), "dbghelp.dll");
        await writeFile(sidecarPath, "invalid attacker-controlled dbghelp image\n", { flag: "wx" });
        const unmitigated = spawnSync(executionPath, ["--version"], {
          cwd: value.paths.root,
          encoding: "utf8",
          env: {
            SystemRoot: String.raw`C:\Windows`,
            WINDIR: String.raw`C:\Windows`,
            PATH: String.raw`C:\Windows\System32;C:\Windows`,
          },
          shell: false,
          windowsHide: true,
        });
        unmitigatedStatus = unmitigated.status;
      },
      beforeExecutionDirectoryRetentionCheck: async () => {
        await unlink(sidecarPath);
      },
    },
  });
  assert.notEqual(unmitigatedStatus, 0, "die ungehärtete Kontrollausführung muss die bösartige App-Directory-DLL laden wollen");
  assert.deepEqual(result.nativeReceipt, { marker: "system32-validator" });
  assert.equal(result.executionProof.validator.executed.mode, "windows-exclusive-handle-launch-v1");
  await value.assertNoExecutionLeak();
});

test("Windows-Mitigation startet auch den echten preserved Rust-Validator", { skip: process.platform !== "win32" }, async (t) => {
  const annualPins = JSON.parse(await readFile(join(HERE, "operational-infrastructure-v2-execution-pins.annual-2026.5.json"), "utf8"));
  const preservedValidatorPath = resolve(REPOSITORY_ROOT, annualPins.validator.file);
  if (!existsSync(preservedValidatorPath)) {
    t.skip("lokales preserved Validator-Artefakt fehlt");
    return;
  }
  const validatorBytes = await readFile(preservedValidatorPath);
  assert.equal(validatorBytes.length, annualPins.validator.bytes);
  assert.equal(sha256(validatorBytes), annualPins.validator.sha256);
  const compilerTemp = await mkdtemp(join(tmpdir(), "zugfolge-operational-real-validator-launcher-"));
  t.after(() => rm(compilerTemp, { recursive: true, force: true }));
  const result = spawnSync(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", join(HERE, "operational-infrastructure-v2-system-launcher.windows.ps1"),
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...(await windowsAnchorHelperEnvironment()),
      SystemRoot: String.raw`C:\Windows`,
      WINDIR: String.raw`C:\Windows`,
      ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
      PATH: String.raw`C:\Windows\System32;C:\Windows`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: compilerTemp,
      TMP: compilerTemp,
      ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE: "validator",
      ZUGFOLGE_OPERATIONAL_ANCHOR_PATH: preservedValidatorPath,
      ZUGFOLGE_OPERATIONAL_ANCHOR_CWD: REPOSITORY_ROOT,
      ZUGFOLGE_OPERATIONAL_ANCHOR_BYTES: String(validatorBytes.length),
      ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256: sha256(validatorBytes),
      ZUGFOLGE_OPERATIONAL_ANCHOR_MAX_BYTES: String(1024 * 1024),
      ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_COUNT: "1",
      ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_0: "--help",
    },
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.anchorBytes, validatorBytes.length);
  assert.equal(envelope.anchorSha256, sha256(validatorBytes));
  assert.equal(envelope.status, 1);
  assert.match(Buffer.from(envelope.stderrBase64, "base64").toString("utf8"), /Aufruf: zugfolge-infra-release/u);
});

test("Windows-Mitigation blockiert echten Validator-DotLocal-Bad-Image fail-closed", { skip: process.platform !== "win32" }, async (t) => {
  const annualPins = JSON.parse(await readFile(join(HERE, "operational-infrastructure-v2-execution-pins.annual-2026.5.json"), "utf8"));
  const preservedValidatorPath = resolve(REPOSITORY_ROOT, annualPins.validator.file);
  if (!existsSync(preservedValidatorPath)) {
    t.skip("lokales preserved Validator-Artefakt fehlt");
    return;
  }
  const attackRoot = await mkdtemp(join(tmpdir(), "zugfolge-operational-real-validator-dotlocal-bad-image-"));
  t.after(() => rm(attackRoot, { recursive: true, force: true }));
  const validatorPath = join(attackRoot, "validator.exe");
  const invalidSourcePath = join(attackRoot, "invalid-userenv.rs");
  const markerPath = join(attackRoot, "dotlocal-loaded.txt");
  await copyFile(preservedValidatorPath, validatorPath);
  await writeFile(`${validatorPath}.local`, "", { flag: "wx" });
  await writeFile(invalidSourcePath, String.raw`
use std::ffi::c_void;

#[unsafe(no_mangle)]
pub extern "system" fn DllMain(_module: *mut c_void, reason: u32, _reserved: *mut c_void) -> i32 {
    if reason == 1 {
        if let Ok(path) = std::env::var("ZUGFOLGE_DOTLOCAL_MARKER") {
            let _ = std::fs::write(path, b"loaded\n");
        }
    }
    1
}
`, { flag: "wx" });
  const compile = spawnSync("rustc", ["--crate-type", "cdylib", "--edition", "2024", invalidSourcePath, "-o", join(attackRoot, "USERENV.dll")], {
    cwd: attackRoot,
    encoding: "utf8",
    env: { ...process.env },
    shell: false,
    windowsHide: true,
  });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
  const validatorBytes = await readFile(validatorPath);
  assert.equal(sha256(validatorBytes), annualPins.validator.sha256);

  const commonEnvironment = {
    SystemRoot: String.raw`C:\Windows`,
    WINDIR: String.raw`C:\Windows`,
    ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
    PATH: String.raw`C:\Windows\System32;C:\Windows`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: attackRoot,
    TMP: attackRoot,
    ZUGFOLGE_DOTLOCAL_MARKER: markerPath,
  };
  const unmitigated = spawnSync(validatorPath, ["--help"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: commonEnvironment,
    shell: false,
    windowsHide: true,
  });
  assert.equal(unmitigated.error, undefined);
  assert.equal(unmitigated.status >>> 0, 0xc0000139, `ungehaertete DotLocal-Kontrolle muss an der fehlenden USERENV-Schnittstelle scheitern, erhielt ${unmitigated.status}`);
  assert.doesNotMatch(unmitigated.stderr, /Aufruf: zugfolge-infra-release/u);
  await assert.rejects(readFile(markerPath), (error) => error?.code === "ENOENT");

  const mitigated = spawnSync(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", join(HERE, "operational-infrastructure-v2-system-launcher.windows.ps1"),
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...commonEnvironment,
      ...(await windowsAnchorHelperEnvironment()),
      ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE: "validator",
      ZUGFOLGE_OPERATIONAL_ANCHOR_PATH: validatorPath,
      ZUGFOLGE_OPERATIONAL_ANCHOR_CWD: REPOSITORY_ROOT,
      ZUGFOLGE_OPERATIONAL_ANCHOR_BYTES: String(validatorBytes.length),
      ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256: sha256(validatorBytes),
      ZUGFOLGE_OPERATIONAL_ANCHOR_MAX_BYTES: String(1024 * 1024),
      ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_COUNT: "1",
      ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_0: "--help",
    },
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  assert.equal(mitigated.status, 0, mitigated.stderr);
  const envelope = JSON.parse(mitigated.stdout);
  assert.ok(
    new Set([0xc0000130, 0xc0000428]).has(envelope.status >>> 0),
    `Mitigation muss die umgeleitete Nicht-Microsoft-DLL mit IMAGE_LOAD_POLICY blockieren, erhielt ${envelope.status}`,
  );
  assert.doesNotMatch(Buffer.from(envelope.stderrBase64, "base64").toString("utf8"), /Aufruf: zugfolge-infra-release/u);
  await assert.rejects(readFile(markerPath), (error) => error?.code === "ENOENT");
});

test("Windows-Mitigation blockiert echte Node-und-Validator-DotLocal-Codeausfuehrung fail-closed", { skip: process.platform !== "win32" }, async (t) => {
  const annualPins = JSON.parse(await readFile(join(HERE, "operational-infrastructure-v2-execution-pins.annual-2026.5.json"), "utf8"));
  const preservedValidatorPath = resolve(REPOSITORY_ROOT, annualPins.validator.file);
  if (!existsSync(preservedValidatorPath)) {
    t.skip("lokales preserved Validator-Artefakt fehlt");
    return;
  }
  const attackRoot = await mkdtemp(join(tmpdir(), "zugfolge-operational-real-validator-dotlocal-"));
  t.after(() => rm(attackRoot, { recursive: true, force: true }));
  const validatorPath = join(attackRoot, "validator.exe");
  const maliciousSourcePath = join(attackRoot, "malicious-userenv.rs");
  const maliciousDllPath = join(attackRoot, "USERENV.dll");
  const markerPath = join(attackRoot, "dotlocal-loaded.txt");
  await copyFile(preservedValidatorPath, validatorPath);
  await writeFile(`${validatorPath}.local`, "", { flag: "wx" });
  await writeFile(maliciousSourcePath, String.raw`
use std::ffi::c_void;

#[unsafe(no_mangle)]
pub extern "system" fn DllMain(_module: *mut c_void, reason: u32, _reserved: *mut c_void) -> i32 {
    if reason == 1 {
        if let Ok(path) = std::env::var("ZUGFOLGE_DOTLOCAL_MARKER") {
            let _ = std::fs::write(path, b"loaded\n");
        }
    }
    1
}

#[unsafe(no_mangle)]
pub extern "system" fn GetUserProfileDirectoryW(_token: *mut c_void, _profile: *mut u16, _size: *mut u32) -> i32 {
    0
}
`, { flag: "wx" });
  const compile = spawnSync("rustc", ["--crate-type", "cdylib", "--edition", "2024", maliciousSourcePath, "-o", maliciousDllPath], {
    cwd: attackRoot,
    encoding: "utf8",
    env: { ...process.env },
    shell: false,
    windowsHide: true,
  });
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
  const validatorBytes = await readFile(validatorPath);
  assert.equal(sha256(validatorBytes), annualPins.validator.sha256);

  const commonEnvironment = {
    SystemRoot: String.raw`C:\Windows`,
    WINDIR: String.raw`C:\Windows`,
    ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
    PATH: String.raw`C:\Windows\System32;C:\Windows`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    TEMP: attackRoot,
    TMP: attackRoot,
    ZUGFOLGE_DOTLOCAL_MARKER: markerPath,
  };
  const unmitigated = spawnSync(validatorPath, ["--help"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: commonEnvironment,
    shell: false,
    windowsHide: true,
  });
  assert.equal(await readFile(markerPath, "utf8"), "loaded\n", `ungehärtete Kontrolle lud die DotLocal-DLL nicht: ${unmitigated.stderr}`);
  await unlink(markerPath);

  const mitigated = spawnSync(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", join(HERE, "operational-infrastructure-v2-system-launcher.windows.ps1"),
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...commonEnvironment,
      ...(await windowsAnchorHelperEnvironment()),
      ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE: "validator",
      ZUGFOLGE_OPERATIONAL_ANCHOR_PATH: validatorPath,
      ZUGFOLGE_OPERATIONAL_ANCHOR_CWD: REPOSITORY_ROOT,
      ZUGFOLGE_OPERATIONAL_ANCHOR_BYTES: String(validatorBytes.length),
      ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256: sha256(validatorBytes),
      ZUGFOLGE_OPERATIONAL_ANCHOR_MAX_BYTES: String(1024 * 1024),
      ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_COUNT: "1",
      ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_0: "--help",
    },
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  assert.equal(mitigated.status, 0, mitigated.stderr);
  const envelope = JSON.parse(mitigated.stdout);
  assert.notEqual(envelope.status, 1, "DotLocal-Angriff darf den echten Validator nicht bis zur CLI starten");
  assert.doesNotMatch(Buffer.from(envelope.stderrBase64, "base64").toString("utf8"), /Aufruf: zugfolge-infra-release/u);
  await assert.rejects(readFile(markerPath), (error) => error?.code === "ENOENT");

  const nodePath = join(attackRoot, "node.exe");
  await copyFile(process.execPath, nodePath);
  await writeFile(`${nodePath}.local`, "", { flag: "wx" });
  const unmitigatedNode = spawnSync(nodePath, ["--version"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: commonEnvironment,
    shell: false,
    windowsHide: true,
  });
  assert.equal(await readFile(markerPath, "utf8"), "loaded\n", `ungehärtete Node-Kontrolle lud die DotLocal-DLL nicht: ${unmitigatedNode.stderr}`);
  await unlink(markerPath);
  const nodeBytes = await readFile(nodePath);
  const mitigatedNode = spawnSync(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", join(HERE, "operational-infrastructure-v2-system-launcher.windows.ps1"),
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...commonEnvironment,
      ...(await windowsAnchorHelperEnvironment()),
      ZUGFOLGE_OPERATIONAL_LAUNCHER_PURPOSE: "validator",
      ZUGFOLGE_OPERATIONAL_ANCHOR_PATH: nodePath,
      ZUGFOLGE_OPERATIONAL_ANCHOR_CWD: REPOSITORY_ROOT,
      ZUGFOLGE_OPERATIONAL_ANCHOR_BYTES: String(nodeBytes.length),
      ZUGFOLGE_OPERATIONAL_ANCHOR_SHA256: sha256(nodeBytes),
      ZUGFOLGE_OPERATIONAL_ANCHOR_MAX_BYTES: String(1024 * 1024),
      ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_COUNT: "1",
      ZUGFOLGE_OPERATIONAL_ANCHOR_ARG_0: "--version",
    },
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    windowsHide: true,
  });
  assert.equal(mitigatedNode.status, 0, mitigatedNode.stderr);
  const nodeEnvelope = JSON.parse(mitigatedNode.stdout);
  assert.equal(nodeEnvelope.status, 0, "gehaerteter Node-Start muss auf die Microsoft-System-DLL zurueckfallen");
  assert.match(Buffer.from(nodeEnvelope.stdoutBase64, "base64").toString("utf8"), /^v\d+\.\d+\.\d+\r?\n$/u);
  await assert.rejects(readFile(markerPath), (error) => error?.code === "ENOENT");
});

test("Windows startet auch eine schnell endende fremde PE bei Replace-Execute-Restore-ABA niemals", { skip: process.platform !== "win32" }, async (t) => {
  const value = await executorFixture(t);
  const foreignExecutable = join(value.paths.root, "foreign-node.exe");
  const marker = join(value.paths.root, "foreign-pe-started.txt");
  await copyFile(process.execPath, foreignExecutable);
  await writeFile(foreignExecutable, Buffer.from([0x5a]), { flag: "a" });
  const prepared = await value.prepare(`
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "started\\n");
    process.stdout.write("{}\\n");
  `);
  await assert.rejects(
    value.execute(prepared, {
      hooks: {
        beforeValidatorSpawn: async ({ executionPath }) => {
          await unlink(executionPath);
          await copyFile(foreignExecutable, executionPath);
        },
      },
    }),
    (error) => {
      const errors = error instanceof AggregateError ? error.errors : [error];
      return errors.some((entry) => /Exklusiver Windows-Validator-Launcher|falschen SHA-256/u.test(entry?.message ?? ""));
    },
  );
  await assert.rejects(readFile(marker), (error) => error?.code === "ENOENT");
});

test("Linux uebernimmt in-place gedriftete Inode-Bytes niemals in den versiegelten memfd", { skip: process.platform !== "linux" }, async (t) => {
  const value = await executorFixture(t);
  const marker = join(value.paths.root, "in-place-child-started.txt");
  const prepared = await value.prepare(`
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "started\\n");
    process.stdout.write("{}\\n");
  `);
  await assert.rejects(
    value.execute(prepared, {
      hooks: {
        beforeValidatorSpawn: async ({ executionPath }) => {
          const bytes = await readFile(executionPath);
          bytes[0] ^= 0xff;
          await writeFile(executionPath, bytes);
        },
      },
    }),
    /versiegelten Linux-memfd-Start.*driftete|gepinnten Bytes/u,
  );
  await assert.rejects(readFile(marker), (error) => error?.code === "ENOENT");
  await value.assertNoExecutionLeak();
});

test("Linux-Launcher und versiegelter Validator erben weder LD_PRELOAD noch Python-Injektionspfade", { skip: process.platform !== "linux" }, async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare(`
    process.stdout.write(JSON.stringify({
      ldPreload: process.env.LD_PRELOAD ?? null,
      ldLibraryPath: process.env.LD_LIBRARY_PATH ?? null,
      pythonPath: process.env.PYTHONPATH ?? null,
    }) + "\\n");
  `);
  const names = ["LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.LD_PRELOAD = "/tmp/foreign-preload.so";
  process.env.LD_LIBRARY_PATH = "/tmp/foreign-library-path";
  process.env.PYTHONPATH = "/tmp/foreign-python-path";
  let result;
  try {
    result = await value.execute(prepared);
  } finally {
    for (const [name, prior] of previous) {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
  }
  assert.deepEqual(result.nativeReceipt, { ldPreload: null, ldLibraryPath: null, pythonPath: null });
  assert.equal(result.executionProof.validator.executed.mode, "linux-sealed-memfd-launch-v1");
  await value.assertNoExecutionLeak();
});

test("fremd ersetzter Execution-Root bleibt beim retained Cleanup identitygleich am Originalpfad", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n');
  let foreignMarker;
  let foreignIdentity;
  await assert.rejects(
    value.execute(prepared, {
      hooks: {
        beforeExecutionDirectoryRetentionCheck: async ({ executionDirectory }) => {
          await rename(executionDirectory, `${executionDirectory}.owned-moved`);
          await mkdir(executionDirectory);
          foreignMarker = join(executionDirectory, "foreign-owner.txt");
          await writeFile(foreignMarker, "preserve me\n", { flag: "wx" });
          foreignIdentity = await lstat(executionDirectory, { bigint: true });
        },
      },
    }),
    AggregateError,
  );
  const after = await lstat(dirname(foreignMarker), { bigint: true });
  assert.equal(after.dev, foreignIdentity.dev);
  assert.equal(after.ino, foreignIdentity.ino);
  assert.equal(await readFile(foreignMarker, "utf8"), "preserve me\n");
});

test("vor der retained Cleanup-Pruefung eingeschleuste Fremddatei bleibt am Originalpfad", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n');
  let executionDirectory;
  await assert.rejects(
    value.execute(prepared, {
      hooks: {
        beforeExecutionDirectoryRetentionCheck: async (context) => {
          ({ executionDirectory } = context);
          await writeFile(join(executionDirectory, "foreign-race.txt"), "foreign owned-entry race\n", { flag: "wx" });
        },
      },
    }),
    AggregateError,
  );
  assert.equal(
    await readFile(join(executionDirectory, "foreign-race.txt"), "utf8"),
    "foreign owned-entry race\n",
  );
});

test("vor Runner-Start veraenderter statischer Import scheitert gegen immutable Byte-Pins ohne Kindprozess", async (t) => {
  const value = await executorFixture(t);
  const marker = join(value.paths.root, "child-started.txt");
  const prepared = await value.prepare(`
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(marker)}, "started\\n");
    process.stdout.write("{}\\n");
  `);
  await writeFile(value.paths.dependency, "// pre-run drift\n", { flag: "a" });
  await assert.rejects(value.execute(prepared), /unveraenderlichen Byte-Pin|vor der Validator-Ausfuehrung/u);
  await assert.rejects(readFile(marker), (error) => error?.code === "ENOENT");
  await value.assertNoExecutionLeak();
});

test("Execution-Pins-v1 weist jeden Argumentpraefix und jede Argumentdatei fail-closed ab", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n');
  for (const argument of ["wrapper", "config.toml", "C:drive-relative", "@response", "tools/wrapper.mjs"]) {
    assert.throws(
      () => serializeGermanyOperationalExecutionPins({
        ...prepared.executionPinsSource.value,
        command: { ...prepared.executionPinsSource.value.command, argumentPrefix: [argument] },
      }, RELEASE_ID),
      /keinen Argumentpraefix und keine Argumentdateien/u,
      argument,
    );
  }
  const forbiddenArgumentFile = await proof(value.paths.script, "derive-germany-operational-v2");
  assert.throws(
    () => serializeGermanyOperationalExecutionPins({
      ...prepared.executionPinsSource.value,
      command: {
        ...prepared.executionPinsSource.value.command,
        argumentFiles: [forbiddenArgumentFile],
      },
    }, RELEASE_ID),
    /keinen Argumentpraefix und keine Argumentdateien/u,
  );
});

test("Node --import und NODE_OPTIONS koennen keinen eligible Runner-Beleg erzeugen", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n');
  const preloadPath = join(value.paths.root, "preload.mjs");
  const childPath = join(value.paths.root, "runner-invocation-child.mjs");
  const preloadMarker = join(value.paths.root, "preload-ran.txt");
  const eligibleMarker = join(value.paths.root, "eligible-proof.txt");
  await writeFile(preloadPath, `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(preloadMarker)}, "preload ran\\n");
  `, { flag: "wx" });
  await writeFile(childPath, `
    import { writeFileSync } from "node:fs";
    import {
      loadGermanyOperationalExecutionPins,
      proveGermanyOperationalExecutionContext,
    } from ${JSON.stringify(pathToFileURL(join(HERE, "operational-infrastructure-v2-execution-pins.mjs")).href)};
    const source = await loadGermanyOperationalExecutionPins({
      workspaceRoot: ${JSON.stringify(value.paths.root)},
      executionPinsPath: ${JSON.stringify(value.paths.pins)},
      expectedReleaseId: ${JSON.stringify(RELEASE_ID)},
    });
    await proveGermanyOperationalExecutionContext({ workspaceRoot: ${JSON.stringify(value.paths.root)}, executionPins: source.value });
    writeFileSync(${JSON.stringify(eligibleMarker)}, "eligible\\n");
  `, { flag: "wx" });
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(preloadPath).href, childPath], {
    cwd: value.paths.root,
    encoding: "utf8",
    env: environment,
    shell: false,
    windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ohne Loader oder Preloads|Runner-Aufruf driftet/u);
  assert.equal(await readFile(preloadMarker, "utf8"), "preload ran\n");
  await assert.rejects(readFile(eligibleMarker), (error) => error?.code === "ENOENT");

  const nodeOptionsResult = spawnSync(process.execPath, [childPath], {
    cwd: value.paths.root,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` },
    shell: false,
    windowsHide: true,
  });
  assert.notEqual(nodeOptionsResult.status, 0);
  assert.match(nodeOptionsResult.stderr, /darf NODE_OPTIONS nicht verwenden/u);
  await assert.rejects(readFile(eligibleMarker), (error) => error?.code === "ENOENT");
  await value.assertNoExecutionLeak();
});

test("nicht gepinnte Loader und Junction-Ahnen koennen keine Runner-Closure einschleusen", async (t) => {
  const value = await executorFixture(t);
  await writeFile(value.paths.runner, 'import "workspace-loader";\n');
  await assert.rejects(
    value.prepare('process.stdout.write("{}\\n");\n'),
    /nicht gepinnten Modulbezeichner workspace-loader/u,
  );

  await writeFile(value.paths.runner, 'const embedded = "require("; import/* pinned */"./dependency.mjs";\n');
  await value.prepare('process.stdout.write("{}\\n");\n');
  await writeFile(value.paths.runner, 'import/* unpinned */("./dependency.mjs");\n');
  await assert.rejects(
    value.prepare('process.stdout.write("{}\\n");\n'),
    /nicht gepinnte Loader: dynamic-import/u,
  );

  await writeFile(value.paths.runner, 'import { createRequire as cr } from "node:module"; const req = cr(import.meta.url); req("./dependency.cjs");\n');
  await assert.rejects(
    value.prepare('process.stdout.write("{}\\n");\n'),
    /nicht gepinnte Loader: commonjs-create-require/u,
  );
  await writeFile(value.paths.runner, 'import { register as r } from "node:module"; r("./loader.mjs", import.meta.url);\n');
  await assert.rejects(
    value.prepare('process.stdout.write("{}\\n");\n'),
    /nicht gepinnte Loader: node-module-loader-api/u,
  );
  await writeFile(value.paths.runner, 'const run = globalThis.eval; run("import(\\"./dependency.mjs\\")");\n');
  await assert.rejects(
    value.prepare('process.stdout.write("{}\\n");\n'),
    /nicht gepinnte Loader: runtime-eval/u,
  );
  await writeFile(value.paths.runner, 'const Ctor = Function; new Ctor("return import(\\"./dependency.mjs\\")")();\n');
  await assert.rejects(
    value.prepare('process.stdout.write("{}\\n");\n'),
    /nicht gepinnte Loader: runtime-function-constructor/u,
  );

  await writeFile(value.paths.runner, 'import "./dependency.mjs";\n');
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n');
  const realDependencies = join(value.paths.root, "real-dependencies");
  const aliasedDirectory = join(dirname(value.paths.runner), "aliased");
  const aliasedDependency = join(realDependencies, "dependency.mjs");
  await mkdir(realDependencies);
  await writeFile(aliasedDependency, "export const aliased = true;\n", { flag: "wx" });
  await symlink(realDependencies, aliasedDirectory, "junction");
  await writeFile(value.paths.runner, 'import "./aliased/dependency.mjs";\n');
  const runnerFileProof = await proof(value.paths.runner, "tools/region-import/germany/run-capture-operational-infrastructure-v2.mjs");
  const captureRootProof = await proof(value.paths.captureRoot, "tools/region-import/germany/capture-operational-infrastructure-v2-native-receipt.mjs");
  const linuxLauncherRootProof = await proof(value.paths.linuxLauncherRoot, "tools/region-import/germany/operational-infrastructure-v2-system-launcher.linux.py");
  const windowsLauncherRootProof = await proof(value.paths.windowsLauncherRoot, "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1");
  const platformLauncherRootProof = process.platform === "win32" ? windowsLauncherRootProof : linuxLauncherRootProof;
  const windowsAnchorHelperProof = process.platform === "win32"
    ? await proof(value.paths.windowsAnchorHelper, GERMANY_OPERATIONAL_WINDOWS_ANCHOR_HELPER_FILE)
    : null;
  const publisherRootProof = await proof(value.paths.publisherRoot, "tools/region-import/germany/publish-operational-infrastructure-v2.mjs");
  const aliasedFileProof = await proof(aliasedDependency, "tools/region-import/germany/aliased/dependency.mjs");
  const pins = {
    ...prepared.executionPinsSource.value,
    runner: {
      anchorHelper: windowsAnchorHelperProof,
      bundle: { ...prepared.executionPinsSource.value.runner.bundle },
      entrypoint: runnerFileProof,
      roots: [captureRootProof, publisherRootProof, runnerFileProof],
      importClosure: [aliasedFileProof, captureRootProof, platformLauncherRootProof, ...(windowsAnchorHelperProof === null ? [] : [windowsAnchorHelperProof]), publisherRootProof, runnerFileProof]
        .sort((left, right) => left.file.localeCompare(right.file, "en")),
      invocation: { ...prepared.executionPinsSource.value.runner.invocation },
      launcher: { ...prepared.executionPinsSource.value.runner.launcher },
      runtime: { ...prepared.executionPinsSource.value.runner.runtime },
    },
  };
  await assert.rejects(
    proveGermanyOperationalExecutionContext({ workspaceRoot: value.paths.root, executionPins: pins, verifyCurrentInvocation: false }),
    /symbolischen Link oder Junction-Ahnen/u,
  );

  await writeFile(
    value.paths.pins,
    `${JSON.stringify(prepared.executionPinsSource.value, null, 2)}\n`,
  );
  await assert.rejects(
    loadGermanyOperationalExecutionPins({
      workspaceRoot: value.paths.root,
      executionPinsPath: value.paths.pins,
      expectedReleaseId: RELEASE_ID,
    }),
    /kanonische Byteform/u,
  );
});

test("Mehrfach-stdout, Uebergroesse, Exit und Signal erzeugen keinen Execution-Proof und leaken keine Ausfuehrungskopie", async (t) => {
  const value = await executorFixture(t);
  for (const [name, source, options, expected] of [
    ["multiple", 'process.stdout.write("{}\\n{}\\n");\n', {}, /exakt einen kompakten JSON-stdout-Datensatz/u],
    ["oversize", 'process.stdout.write("x".repeat(8192));\n', { stdoutMaxBytes: 128 }, /begrenzt|stdout|maxBuffer|ENOBUFS/u],
    ["exit", 'process.stderr.write("injected exit\\n"); process.exit(7);\n', {}, /Exit 7/u],
    ["signal", 'process.kill(process.pid, "SIGTERM");\n', {}, /Signal|Exit|exakt gestartet/u],
  ]) {
    const prepared = await value.prepare(source, options);
    await assert.rejects(value.execute(prepared), expected, name);
    await value.assertNoExecutionLeak();
  }
});

test("Importdrift waehrend des Kindprozesses wird nach dem Exit fail-closed erkannt", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare(`
    import { appendFileSync } from "node:fs";
    appendFileSync(${JSON.stringify(value.paths.dependency)}, "// drift\\n");
    process.stdout.write("{}\\n");
  `);
  await assert.rejects(value.execute(prepared), /Importclosure.*drift|Runner.*drift/u);
  await value.assertNoExecutionLeak();
});

test("fremd ersetztes Binary und fremdes Receipt bleiben trotz gleicher Pfade fail-closed", async (t) => {
  const value = await executorFixture(t);
  const prepared = await value.prepare('process.stdout.write("{}\\n");\n');
  await unlink(value.paths.validator);
  await writeFile(value.paths.validator, "foreign binary\n", { flag: "wx" });
  await assert.rejects(value.execute(prepared), /Validator driftet von Execution-Pins/u);
  await value.assertNoExecutionLeak();

  await unlink(value.paths.validator);
  await copyFile(process.execPath, value.paths.validator);
  const refreshed = await value.prepare('process.stdout.write(JSON.stringify({receipt:"owned"}) + "\\n");\n');
  const execution = await value.execute(refreshed);
  const provenance = integratedGermanyOperationalProvenance({
    executionPinsProof: refreshed.executionPinsSource.proof,
    executionProof: execution.executionProof,
    nativeReceipt: execution.nativeReceipt,
  });
  assert.equal(provenance.producerKind, GERMANY_OPERATIONAL_INTEGRATED_PRODUCER_KIND);
  const wrongPinsDigest = structuredClone(execution.executionProof);
  wrongPinsDigest.executionPinsSha256 = "f".repeat(64);
  assert.throws(
    () => validateGermanyOperationalExecutionProofAgainstPins(
      wrongPinsDigest,
      refreshed.executionPinsSource.value,
      { nativeReceipt: execution.nativeReceipt },
    ),
    /kanonischen SHA-256.*Execution-Pins/u,
  );
  assert.throws(
    () => validateGermanyOperationalProvenance(provenance, { nativeReceipt: { receipt: "foreign" } }),
    /anderes strukturiertes Native-Receipt/u,
  );
  await value.assertNoExecutionLeak();
});
