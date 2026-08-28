import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildGermanyOperationalDirectSystemLaunchContract,
  GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_BINDINGS,
  GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_FILE,
  GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
  GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTEXT_SCHEMA,
  serializeGermanyOperationalDirectSystemLaunchContract,
  validateGermanyOperationalDirectSystemLaunchContract,
} from "./build-operational-infrastructure-v2-direct-system-launch-contract.mjs";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const OUTER_BOOTSTRAP = join(REPOSITORY_ROOT, "tools/region-import/germany/operational-infrastructure-v2-direct-contract-launcher.windows.ps1");
const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve_) => setTimeout(resolve_, 20));
    }
  }
  throw new Error(`Zeitlimit beim Warten auf ${path}.`);
}

function testContract({ source, executionPinsFile = "pins.json" }) {
  const sourceBytes = Buffer.from(source, "utf8");
  return {
    schema: GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_SCHEMA,
    releaseId: "infra-deutschland-2026.5",
    platform: "win32",
    executionPins: {
      file: executionPinsFile,
      bytes: 1,
      sha256: "1".repeat(64),
      schema: "zugfolge-germany-operational-v2-execution-pins/v1",
    },
    trustedExecutor: {
      file: "tools/trusted-executor.exe",
      buildCommit: "3".repeat(40),
      bytes: 1,
      sha256: "4".repeat(64),
    },
    launcher: {
      file: "tools/region-import/germany/operational-infrastructure-v2-system-launcher.windows.ps1",
      mode: "windows-system-powershell-held-bundle-v1",
      sourceBytes: 1,
      sourceSha256: "2".repeat(64),
    },
    dynamicBindings: GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_BINDINGS.map((entry) => ({ ...entry })),
    bootstrap: {
      mode: "held-contract-inline-powershell-v1",
      sourceEncoding: "utf-8",
      sourceBase64: sourceBytes.toString("base64"),
      sourceBytes: sourceBytes.length,
      sourceSha256: sha256(sourceBytes),
    },
  };
}

function launchContext() {
  return Object.fromEntries(Object.entries({
    schema: GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTEXT_SCHEMA,
    runtimePath: String.raw`C:\runtime\node.exe`,
    executionPinsPath: "pins.json",
    specificationPath: "specification.json",
    sourceRoot: "source",
    candidatePath: "candidate.json",
    candidateSidecarPath: "candidate-sidecar.json",
    reportPath: "report.json",
    nativeReceiptPath: "native-receipt.json",
  }).sort(([left], [right]) => left.localeCompare(right, "en")));
}

function launchEnvironment(root, contractFile, contract, contractBytes, extra = {}) {
  const contextBase64 = Buffer.from(JSON.stringify(launchContext()), "utf8").toString("base64");
  return {
    SystemRoot: String.raw`C:\Windows`,
    WINDIR: String.raw`C:\Windows`,
    ComSpec: String.raw`C:\Windows\System32\cmd.exe`,
    PATH: String.raw`C:\Windows\System32;C:\Windows`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PSModulePath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\Modules`,
    TEMP: String.raw`C:\Windows\System32`,
    TMP: String.raw`C:\Windows\System32`,
    ZUGFOLGE_OPERATIONAL_WORKSPACE_ROOT: root,
    ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_PATH: contractFile,
    ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_BYTES: String(contractBytes.length),
    ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_SHA256: sha256(contractBytes),
    ZUGFOLGE_OPERATIONAL_LAUNCH_CONTRACT_SCHEMA: contract.schema,
    ZUGFOLGE_OPERATIONAL_EXPECTED_RELEASE_ID: contract.releaseId,
    ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_FILE: contract.executionPins.file,
    ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_BYTES: String(contract.executionPins.bytes),
    ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_SHA256: contract.executionPins.sha256,
    ZUGFOLGE_OPERATIONAL_EXPECTED_EXECUTION_PINS_SCHEMA: contract.executionPins.schema,
    ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_FILE: contract.trustedExecutor.file,
    ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_BUILD_COMMIT: contract.trustedExecutor.buildCommit,
    ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_BYTES: String(contract.trustedExecutor.bytes),
    ZUGFOLGE_OPERATIONAL_EXPECTED_TRUSTED_EXECUTOR_SHA256: contract.trustedExecutor.sha256,
    ZUGFOLGE_OPERATIONAL_LAUNCH_CONTEXT_BASE64: contextBase64,
    ...extra,
  };
}

async function collect(child) {
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const result = await new Promise((resolve_) => {
    child.once("error", (error) => resolve_({ error, status: null }));
    child.once("exit", (status, signal) => resolve_({ status, signal }));
  });
  return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

test("eingecheckter Direct-System-Launch-Vertrag ist kanonisch aus den finalen Annual-Pins ableitbar", async () => {
  const expected = await buildGermanyOperationalDirectSystemLaunchContract();
  const actualBytes = await readFile(join(REPOSITORY_ROOT, ...GERMANY_OPERATIONAL_DIRECT_SYSTEM_LAUNCH_CONTRACT_FILE.split("/")));
  assert.deepEqual(actualBytes, serializeGermanyOperationalDirectSystemLaunchContract(expected));
  assert.deepEqual(validateGermanyOperationalDirectSystemLaunchContract(JSON.parse(actualBytes)), expected);
});

test("Direct-System-Launch-Vertrag weist fremde Nested-Felder fail-closed ab", () => {
  const base = testContract({
    source: "param($Contract,$Context,[string]$WorkspaceRoot)",
    executionPinsFile: "tools/region-import/germany/operational-infrastructure-v2-execution-pins.annual-2026.5.json",
  });
  assert.equal(validateGermanyOperationalDirectSystemLaunchContract(base), base);
  const canonicalRoundTrip = JSON.parse(serializeGermanyOperationalDirectSystemLaunchContract(base));
  assert.equal(validateGermanyOperationalDirectSystemLaunchContract(canonicalRoundTrip), canonicalRoundTrip);
  const driftedBinding = structuredClone(canonicalRoundTrip);
  driftedBinding.dynamicBindings[0].properties = [...driftedBinding.dynamicBindings[0].properties].reverse();
  assert.throws(
    () => validateGermanyOperationalDirectSystemLaunchContract(driftedBinding),
    /kanonische Base64-Kontextbindung/u,
  );
  for (const field of ["executionPins", "launcher", "bootstrap"]) {
    const changed = structuredClone(base);
    changed[field].foreign = "forbidden";
    assert.throws(
      () => validateGermanyOperationalDirectSystemLaunchContract(changed),
      /ungueltig|ungueltige/u,
      `fremdes ${field}-Feld wurde akzeptiert`,
    );
  }
});

test("gehaltener Annual-Launch-Vertrag blockiert A-B-A zwischen Open und Start", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-contract-aba-"));
  const contractPath = join(root, "contract.json");
  const opened = join(root, "opened.marker");
  const proceed = join(root, "continue.marker");
  const backup = join(root, "contract.backup.json");
  const inner = [
    "param($Contract,$Context,[string]$WorkspaceRoot)",
    `[IO.File]::WriteAllText('${opened.replaceAll("'", "''")}', 'open')`,
    `$deadline=[DateTime]::UtcNow.AddSeconds(10);while(-not [IO.File]::Exists('${proceed.replaceAll("'", "''")}')){if([DateTime]::UtcNow -gt $deadline){throw 'timeout'};[Threading.Thread]::Sleep(20)}`,
    "[Console]::Out.Write('held-contract-ok')",
  ].join(";");
  const contract = testContract({ source: inner });
  const contractBytes = serializeGermanyOperationalDirectSystemLaunchContract(contract);
  await writeFile(contractPath, contractBytes, { flag: "wx" });
  const child = spawn(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", OUTER_BOOTSTRAP,
  ], {
    cwd: String.raw`C:\Windows\System32`,
    env: launchEnvironment(root, relative(root, contractPath), contract, contractBytes),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    await waitForFile(opened);
    await assert.rejects(rename(contractPath, backup), (error) => error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES");
    await assert.rejects(writeFile(contractPath, Buffer.from("B")), (error) => error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES");
    await writeFile(proceed, "continue", { flag: "wx" });
    const result = await collect(child);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "held-contract-ok");
    assert.deepEqual(await readFile(contractPath), contractBytes);
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

test("Annual-Launch weist eine fremde Prozessumgebung vor Contractwirkung ab", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-operational-contract-binding-"));
  const contractPath = join(root, "contract.json");
  const effect = join(root, "effect.marker");
  const inner = `param($Contract,$Context,[string]$WorkspaceRoot);[IO.File]::WriteAllText('${effect.replaceAll("'", "''")}','effect')`;
  const contract = testContract({ source: inner });
  const contractBytes = serializeGermanyOperationalDirectSystemLaunchContract(contract);
  await writeFile(contractPath, contractBytes, { flag: "wx" });
  const child = spawn(POWERSHELL, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", OUTER_BOOTSTRAP,
  ], {
    cwd: String.raw`C:\Windows\System32`,
    env: launchEnvironment(root, relative(root, contractPath), contract, contractBytes, {
      ZUGFOLGE_OPERATIONAL_FOREIGN: "forbidden",
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  try {
    const result = await collect(child);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fremde Umgebungsvariable/u);
    await assert.rejects(access(effect));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
