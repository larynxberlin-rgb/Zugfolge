import { createHash } from "node:crypto";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createInfraOperationalV2NativeVerifier,
  type InfraOperationalNativeExecFile,
} from "./infra-operational-native-verifier.js";
import type { InfraOperationalV2NativeValidationInput } from "./infra-package-staging.js";

const RELEASE_ID = "infra-deutschland-2026.3";
const STATE_HASH = "d".repeat(64);
const roots: string[] = [];

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(): Promise<InfraOperationalV2NativeValidationInput> {
  const packageRoot = await mkdtemp(join(tmpdir(), "zugfolge-native-stage-test-"));
  roots.push(packageRoot);
  await mkdir(join(packageRoot, "parts"));
  const first = Buffer.from('{"directedEdges":{},');
  const second = Buffer.from('"id":"infra-deutschland-2026.3"}\n');
  await writeFile(join(packageRoot, "parts", "operational.part-00001"), first);
  await writeFile(join(packageRoot, "parts", "operational.part-00002"), second);
  const complete = Buffer.concat([first, second]);
  return {
    packageRoot,
    expectedInfraReleaseId: RELEASE_ID,
    artifact: {
      id: "operational-infrastructure-2026.3",
      installPath: "operational-infrastructure-v2.json",
      bytes: complete.length,
      sha256: sha256(complete),
      parts: [
        {
          partId: "first",
          packagePath: "parts/operational.part-00001",
          bytes: first.length,
          sha256: sha256(first),
        },
        {
          partId: "second",
          packagePath: "parts/operational.part-00002",
          bytes: second.length,
          sha256: sha256(second),
        },
      ],
    },
  };
}

async function executableFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zugfolge-native-binary-test-"));
  roots.push(root);
  const binary = join(root, process.platform === "win32" ? "zugfolge-infra-release.exe" : "zugfolge-infra-release");
  await writeFile(binary, process.platform === "win32" ? "MZtest-validator\n" : "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  if (process.platform !== "win32") await chmod(binary, 0o700);
  return binary;
}

function receipt(input: InfraOperationalV2NativeValidationInput, overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schema: "operational-infrastructure-v2",
    infraReleaseId: input.expectedInfraReleaseId,
    sourceBytes: input.artifact.bytes,
    sourceSha256: input.artifact.sha256,
    bytes: input.artifact.bytes,
    sha256: input.artifact.sha256,
    stateHash: STATE_HASH,
    validationMode: "native-streaming-redb-v1",
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("createInfraOperationalV2NativeVerifier", () => {
  it("bricht beim Start mit fehlender oder relativer Binary ab", async () => {
    await expect(createInfraOperationalV2NativeVerifier("zugfolge-infra-release"))
      .rejects.toThrow("absoluter Pfad");
    const root = await mkdtemp(join(tmpdir(), "zugfolge-native-missing-test-"));
    roots.push(root);
    await expect(createInfraOperationalV2NativeVerifier(join(root, process.platform === "win32" ? "missing.exe" : "missing")))
      .rejects.toThrow("fehlt");
  });

  it("bricht beim Start mit nicht ausfuehrbarer Binary ab", async () => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-native-mode-test-"));
    roots.push(root);
    const binary = join(root, process.platform === "win32" ? "zugfolge-infra-release.exe" : "zugfolge-infra-release");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(binary, 0o600);
    await expect(createInfraOperationalV2NativeVerifier(binary)).rejects.toThrow(/nicht ausfuehrbar|keine ausfuehrbare/);
  });

  it("bricht beim Start mit verlinkter Binary ab", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "zugfolge-native-link-test-"));
    roots.push(root);
    const linkPath = process.platform === "win32" ? join(root, "binary-parent") : join(root, "zugfolge-infra-release");
    const binary = process.platform === "win32" ? join(linkPath, basename(process.execPath)) : linkPath;
    try {
      await symlink(
        process.platform === "win32" ? dirname(process.execPath) : process.execPath,
        linkPath,
        process.platform === "win32" ? "junction" : "file",
      );
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "EPERM") {
        context.skip();
        return;
      }
      throw error;
    }
    try {
      await expect(createInfraOperationalV2NativeVerifier(binary)).rejects.toThrow(/symlinkfreie Datei|verlinkt/);
    } finally {
      if (process.platform === "win32") await rmdir(linkPath);
      else await unlink(linkPath);
    }
  });

  it("komponiert Paketteile symlinkfrei und bindet den nativen Beleg bytegenau", async () => {
    const input = await fixture();
    const trustedBinary = await executableFixture();
    let candidatePath: string | undefined;
    let snapshotPath: string | undefined;
    let observedOptions: Parameters<InfraOperationalNativeExecFile>[2] | undefined;
    const execFile: InfraOperationalNativeExecFile = (binary, arguments_, options, callback) => {
      snapshotPath = binary;
      expect(binary).not.toBe(trustedBinary);
      expect(basename(binary)).toBe(process.platform === "win32" ? "validator.exe" : "validator");
      expect(arguments_[0]).toBe("validate-operational-infrastructure-v2");
      expect(arguments_[2]).toBe(RELEASE_ID);
      candidatePath = arguments_[1];
      observedOptions = options;
      void (async () => {
        const metadata = await lstat(candidatePath!);
        expect(metadata.isFile()).toBe(true);
        expect(metadata.isSymbolicLink()).toBe(false);
        const bytes = await readFile(candidatePath!);
        expect(bytes.length).toBe(input.artifact.bytes);
        expect(sha256(bytes)).toBe(input.artifact.sha256);
        callback(null, receipt(input), "");
      })();
    };
    const verifier = await createInfraOperationalV2NativeVerifier(trustedBinary, {
      execFile,
      timeoutMs: 12_345,
      maxOutputBytes: 65_536,
    });

    await expect(verifier(input)).resolves.toEqual({
      schema: "operational-infrastructure-v2",
      infraReleaseId: RELEASE_ID,
      stateHash: STATE_HASH,
    });
    expect(observedOptions).toMatchObject({
      timeout: 12_345,
      maxBuffer: 65_536,
      shell: false,
      windowsHide: true,
      killSignal: "SIGKILL",
    });
    await expect(lstat(candidatePath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(snapshotPath!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("verwirft einen nativen Beleg ohne exakte Quell- und Kanonikalbindung", async () => {
    const input = await fixture();
    const trustedBinary = await executableFixture();
    const execFile: InfraOperationalNativeExecFile = (_binary, _arguments, _options, callback) => {
      callback(null, receipt(input, { sourceSha256: "e".repeat(64) }), "");
    };
    const verifier = await createInfraOperationalV2NativeVerifier(trustedBinary, { execFile });
    await expect(verifier(input)).rejects.toThrow("nicht bytegenau");
  });

  it("verwirft einen Austausch des konfigurierten Validators unmittelbar nach dem Prozessstart", async () => {
    const input = await fixture();
    const trustedBinary = await executableFixture();
    const original = await readFile(trustedBinary);
    const mutated = Buffer.from(original);
    mutated[mutated.length - 1] = mutated[mutated.length - 1]! ^ 0xff;
    const execFile: InfraOperationalNativeExecFile = (_snapshot, _arguments, _options, callback) => {
      writeFileSync(trustedBinary, mutated);
      callback(null, receipt(input), "");
    };
    const verifier = await createInfraOperationalV2NativeVerifier(trustedBinary, { execFile });

    await expect(verifier(input)).rejects.toThrow(/waehrend des Prozessstarts|nach dem Prozessende/u);
  });

  it("verwirft ein Source-A-nach-B-nach-A-Rennen und führt ausschließlich die private gepinnte Validator-Kopie aus", async () => {
    const input = await fixture();
    const trustedBinary = await executableFixture();
    const original = await readFile(trustedBinary);
    const originalMetadata = statSync(trustedBinary);
    const mutated = Buffer.from(original);
    mutated[mutated.length - 1] = mutated[mutated.length - 1]! ^ 0xff;
    let executedSnapshot: Buffer | undefined;
    const execFile: InfraOperationalNativeExecFile = (snapshot, _arguments, _options, callback) => {
      writeFileSync(trustedBinary, mutated);
      executedSnapshot = Buffer.from(readFileSync(snapshot));
      writeFileSync(trustedBinary, original);
      utimesSync(trustedBinary, originalMetadata.atime, originalMetadata.mtime);
      callback(null, receipt(input), "");
    };
    const verifier = await createInfraOperationalV2NativeVerifier(trustedBinary, { execFile });

    await expect(verifier(input)).rejects.toThrow("ausgetauscht");
    expect(executedSnapshot).toEqual(original);
  });

  it("begrenzt auch bei parallelen Aufrufen die nativen Prozesse", async () => {
    const input = await fixture();
    const trustedBinary = await executableFixture();
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const execFile: InfraOperationalNativeExecFile = (_binary, _arguments, _options, callback) => {
      active += 1;
      calls += 1;
      maximumActive = Math.max(maximumActive, active);
      setTimeout(() => {
        active -= 1;
        callback(null, receipt(input), "");
      }, 20);
    };
    const verifier = await createInfraOperationalV2NativeVerifier(trustedBinary, {
      execFile,
      maxConcurrent: 1,
      maxQueued: 2,
    });

    await Promise.all([verifier(input), verifier(input), verifier(input)]);
    expect(calls).toBe(3);
    expect(maximumActive).toBe(1);
  });

  it("blockiert den Event Loop waehrend der nativen Validierung nicht", async () => {
    const input = await fixture();
    const trustedBinary = await executableFixture();
    let nativeCompleted = false;
    const execFile: InfraOperationalNativeExecFile = (_binary, _arguments, _options, callback) => {
      setTimeout(() => {
        nativeCompleted = true;
        callback(null, receipt(input), "");
      }, 20);
    };
    const verifier = await createInfraOperationalV2NativeVerifier(trustedBinary, { execFile });

    const verification = verifier(input);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nativeCompleted).toBe(false);
    await expect(verification).resolves.toMatchObject({
      infraReleaseId: RELEASE_ID,
      stateHash: STATE_HASH,
    });
  });
});
