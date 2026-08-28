/** Produktionsadapter fuer die native, streamingfaehige Operational-v2-Pruefung. */

import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import type {
  InfraOperationalV2NativeValidationInput,
  InfraOperationalV2NativeValidationReceipt,
  InfraOperationalV2NativeVerifier,
} from "./infra-package-staging.js";

const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1_024;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_QUEUED = 4;
const COPY_BUFFER_BYTES = 1 * 1_024 * 1_024;

interface ExecFileOptions {
  readonly encoding: "utf8";
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly windowsHide: true;
  readonly shell: false;
  readonly killSignal: "SIGKILL";
}

type ExecFileCallback = (
  error: (Error & { readonly code?: string | number; readonly signal?: string; readonly killed?: boolean }) | null,
  stdout: string,
  stderr: string,
) => void;

export type InfraOperationalNativeExecFile = (
  executable: string,
  arguments_: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCallback,
) => unknown;

export interface InfraOperationalNativeVerifierOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  /** Ausschliesslich fuer fokussierte Adaptertests; Produktion nutzt node:child_process.execFile. */
  readonly execFile?: InfraOperationalNativeExecFile;
}

interface ExecutableIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorCode(error: unknown): string | number | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? (error as { readonly code?: string | number }).code
    : undefined;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function positiveInteger(value: number, label: string, maximum: number): number {
  invariant(Number.isSafeInteger(value) && value > 0 && value <= maximum, `${label} ist ausserhalb des erlaubten Bereichs.`);
  return value;
}

async function executableIdentity(path: string): Promise<ExecutableIdentity> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error(`Native Operational-v2-Pruefdatei '${path}' fehlt.`);
    throw error;
  }
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `Native Operational-v2-Pruefdatei '${path}' muss eine regulaere, symlinkfreie Datei sein.`);
  const canonicalPath = await realpath(path);
  invariant(samePath(canonicalPath, path), `Native Operational-v2-Pruefdatei '${path}' oder ein Elternpfad ist verlinkt.`);
  if (process.platform === "win32") invariant(extname(path).toLowerCase() === ".exe", `Native Operational-v2-Pruefdatei '${path}' ist unter Windows nicht direkt ausfuehrbar.`);
  try {
    await access(path, constants.X_OK);
  } catch {
    throw new Error(`Native Operational-v2-Pruefdatei '${path}' ist nicht ausfuehrbar.`);
  }
  const executable = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedMetadata = await executable.stat();
    invariant(
      openedMetadata.isFile()
        && openedMetadata.dev === metadata.dev
        && openedMetadata.ino === metadata.ino
        && openedMetadata.size === metadata.size
        && openedMetadata.mtimeMs === metadata.mtimeMs,
      `Native Operational-v2-Pruefdatei '${path}' wurde waehrend des Oeffnens ausgetauscht.`,
    );
    if (process.platform === "win32") {
      const header = Buffer.alloc(2);
      const { bytesRead } = await executable.read(header, 0, header.length, 0);
      invariant(bytesRead === 2 && header.toString("ascii") === "MZ", `Native Operational-v2-Pruefdatei '${path}' ist keine ausfuehrbare Windows-Binary.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytes = 0;
    while (true) {
      const { bytesRead } = await executable.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    const afterReadMetadata = await executable.stat();
    invariant(
      afterReadMetadata.dev === openedMetadata.dev
        && afterReadMetadata.ino === openedMetadata.ino
        && afterReadMetadata.size === openedMetadata.size
        && afterReadMetadata.mtimeMs === openedMetadata.mtimeMs
        && bytes === openedMetadata.size,
      `Native Operational-v2-Pruefdatei '${path}' wurde waehrend der SHA-Pruefung ausgetauscht.`,
    );
    return {
      dev: openedMetadata.dev,
      ino: openedMetadata.ino,
      size: openedMetadata.size,
      mtimeMs: openedMetadata.mtimeMs,
      sha256: hash.digest("hex"),
    };
  } finally {
    await executable.close();
  }
}

function sameIdentity(left: ExecutableIdentity, right: ExecutableIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.sha256 === right.sha256;
}

class BoundedWorkLimiter {
  readonly #maximumActive: number;
  readonly #maximumQueued: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(maximumActive: number, maximumQueued: number) {
    this.#maximumActive = maximumActive;
    this.#maximumQueued = maximumQueued;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await work();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#maximumActive) {
      this.#active += 1;
      return;
    }
    invariant(this.#queue.length < this.#maximumQueued, "Zu viele native Operational-v2-Pruefungen warten bereits.");
    await new Promise<void>((resolvePromise) => this.#queue.push(resolvePromise));
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.#active -= 1;
  }
}

function safePackagePartPath(packageRoot: string, packagePath: string): { readonly path: string; readonly segments: readonly string[] } {
  invariant(
    packagePath.length > 0
      && !packagePath.includes("\\")
      && !packagePath.includes("\0")
      && !packagePath.startsWith("/")
      && !/^[a-z]:/i.test(packagePath),
    `Operational-v2-Paketteilpfad '${packagePath}' ist nicht portabel.`,
  );
  const segments = packagePath.split("/");
  invariant(segments.every((segment) => segment !== "" && segment !== "." && segment !== ".."), `Operational-v2-Paketteilpfad '${packagePath}' enthaelt ein unsicheres Segment.`);
  const path = resolve(packageRoot, ...segments);
  const fromRoot = relative(packageRoot, path);
  invariant(fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot), `Operational-v2-Paketteilpfad '${packagePath}' verlaesst die Paketwurzel.`);
  return { path, segments };
}

async function assertSymlinkFreeDirectoryPath(packageRoot: string, segments: readonly string[]): Promise<void> {
  let current = packageRoot;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const metadata = await lstat(current);
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `Operational-v2-Paketteilverzeichnis '${current}' ist nicht regulaer und symlinkfrei.`);
    invariant(samePath(await realpath(current), current), `Operational-v2-Paketteilverzeichnis '${current}' oder ein Elternpfad ist verlinkt.`);
  }
}

async function writeFully(output: Awaited<ReturnType<typeof open>>, buffer: Buffer, bytes: number): Promise<void> {
  let offset = 0;
  while (offset < bytes) {
    const written = await output.write(buffer, offset, bytes - offset, null);
    invariant(written.bytesWritten > 0, "Operational-v2-Temporaerdatei konnte nicht vollstaendig geschrieben werden.");
    offset += written.bytesWritten;
  }
}

async function snapshotPinnedExecutable(
  temporaryRoot: string,
  sourcePath: string,
  trustedIdentity: ExecutableIdentity,
): Promise<{ readonly path: string; readonly identity: ExecutableIdentity }> {
  const snapshotPath = join(temporaryRoot, `validator${extname(sourcePath).toLowerCase()}`);
  const source = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let output: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let bytes = 0;
  try {
    output = await open(snapshotPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o700);
    const beforeCopy = await source.stat();
    invariant(
      beforeCopy.isFile()
        && beforeCopy.dev === trustedIdentity.dev
        && beforeCopy.ino === trustedIdentity.ino
        && beforeCopy.size === trustedIdentity.size
        && beforeCopy.mtimeMs === trustedIdentity.mtimeMs,
      "Native Operational-v2-Pruefdatei wurde vor ihrer privaten Ausfuehrungskopie ausgetauscht.",
    );
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
      await writeFully(output, buffer, bytesRead);
    }
    const afterCopy = await source.stat();
    invariant(
      afterCopy.dev === beforeCopy.dev
        && afterCopy.ino === beforeCopy.ino
        && afterCopy.size === beforeCopy.size
        && afterCopy.mtimeMs === beforeCopy.mtimeMs
        && bytes === trustedIdentity.size
        && hash.digest("hex") === trustedIdentity.sha256,
      "Native Operational-v2-Pruefdatei wurde waehrend ihrer privaten Ausfuehrungskopie ausgetauscht.",
    );
    await output.sync();
  } finally {
    await Promise.all([source.close(), output?.close()]);
  }
  const identity = await executableIdentity(snapshotPath);
  invariant(
    identity.size === trustedIdentity.size && identity.sha256 === trustedIdentity.sha256,
    "Private Operational-v2-Pruefdateikopie weicht vom gepinnten Validator ab.",
  );
  return { path: snapshotPath, identity };
}

async function composeCandidate(
  temporaryRoot: string,
  input: InfraOperationalV2NativeValidationInput,
): Promise<string> {
  invariant(isAbsolute(input.packageRoot), "Operational-v2-Paketwurzel muss absolut sein.");
  const packageRoot = resolve(input.packageRoot);
  const rootMetadata = await lstat(packageRoot);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Operational-v2-Paketwurzel muss regulaer und symlinkfrei sein.");
  invariant(samePath(await realpath(packageRoot), packageRoot), "Operational-v2-Paketwurzel oder ein Elternpfad ist verlinkt.");
  invariant(input.artifact.parts.length > 0, "Operational-v2-Artefakt besitzt keine Paketteile.");
  invariant(Number.isSafeInteger(input.artifact.bytes) && input.artifact.bytes > 0 && SHA256.test(input.artifact.sha256), "Operational-v2-Artefakt besitzt keinen gueltigen Bytevertrag.");

  const candidatePath = join(temporaryRoot, "operational-infrastructure-v2.json");
  const output = await open(candidatePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  const aggregateHash = createHash("sha256");
  let aggregateBytes = 0;
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  try {
    for (const part of input.artifact.parts) {
      invariant(Number.isSafeInteger(part.bytes) && part.bytes > 0 && SHA256.test(part.sha256), `Operational-v2-Paketteil '${part.packagePath}' besitzt keinen gueltigen Bytevertrag.`);
      const located = safePackagePartPath(packageRoot, part.packagePath);
      await assertSymlinkFreeDirectoryPath(packageRoot, located.segments);
      const linkMetadata = await lstat(located.path);
      invariant(linkMetadata.isFile() && !linkMetadata.isSymbolicLink(), `Operational-v2-Paketteil '${part.packagePath}' muss eine regulaere, symlinkfreie Datei sein.`);
      invariant(samePath(await realpath(located.path), located.path), `Operational-v2-Paketteil '${part.packagePath}' oder ein Elternpfad ist verlinkt.`);

      const source = await open(located.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const partHash = createHash("sha256");
      let partBytes = 0;
      try {
        const openedMetadata = await source.stat();
        invariant(
          openedMetadata.isFile()
            && openedMetadata.dev === linkMetadata.dev
            && openedMetadata.ino === linkMetadata.ino,
          `Operational-v2-Paketteil '${part.packagePath}' wurde waehrend des Oeffnens ausgetauscht.`,
        );
        while (true) {
          const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          partBytes += bytesRead;
          aggregateBytes += bytesRead;
          invariant(Number.isSafeInteger(partBytes) && Number.isSafeInteger(aggregateBytes), "Operational-v2-Bytezaehler ist uebergelaufen.");
          partHash.update(buffer.subarray(0, bytesRead));
          aggregateHash.update(buffer.subarray(0, bytesRead));
          await writeFully(output, buffer, bytesRead);
        }
      } finally {
        await source.close();
      }
      invariant(partBytes === part.bytes && partHash.digest("hex") === part.sha256, `Operational-v2-Paketteil '${part.packagePath}' stimmt nicht mit seinem Bytevertrag ueberein.`);
    }
    invariant(aggregateBytes === input.artifact.bytes && aggregateHash.digest("hex") === input.artifact.sha256, "Zusammengesetztes Operational-v2-Artefakt stimmt nicht mit seinem Bytevertrag ueberein.");
    await output.sync();
  } finally {
    await output.close();
  }
  const candidateMetadata = await lstat(candidatePath);
  invariant(candidateMetadata.isFile() && !candidateMetadata.isSymbolicLink(), "Zusammengesetztes Operational-v2-Artefakt ist keine regulaere, symlinkfreie Datei.");
  return candidatePath;
}

async function removeTemporaryComposition(temporaryRoot: string, validatorSnapshotPath: string | undefined): Promise<void> {
  for (const path of [join(temporaryRoot, "operational-infrastructure-v2.json"), validatorSnapshotPath]) {
    if (path === undefined) continue;
    try {
      const metadata = await lstat(path);
      invariant(metadata.isFile() && !metadata.isSymbolicLink(), "Operational-v2-Temporaerdatei wurde waehrend der Bereinigung ausgetauscht.");
      await unlink(path);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  const rootMetadata = await lstat(temporaryRoot);
  invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Operational-v2-Temporaerverzeichnis wurde waehrend der Bereinigung ausgetauscht.");
  await rmdir(temporaryRoot);
}

function productionExecFile(
  executable: string,
  arguments_: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCallback,
): unknown {
  return nodeExecFile(executable, [...arguments_], options, callback);
}

async function executeNativeValidator(
  execFile: InfraOperationalNativeExecFile,
  binaryPath: string,
  candidatePath: string,
  expectedReleaseId: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      binaryPath,
      ["validate-operational-infrastructure-v2", candidatePath, expectedReleaseId],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        windowsHide: true,
        shell: false,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim();
          const suffix = detail === "" ? "" : `: ${detail}`;
          rejectPromise(new Error(`Native Operational-v2-Pruefung ist fehlgeschlagen (${String(error.code ?? error.message)})${suffix}`));
          return;
        }
        if (stderr.trim() !== "") {
          rejectPromise(new Error("Native Operational-v2-Pruefung schrieb trotz Erfolg auf stderr."));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

function validationReceipt(
  stdout: string,
  input: InfraOperationalV2NativeValidationInput,
): InfraOperationalV2NativeValidationReceipt {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim()) as unknown;
  } catch {
    throw new Error("Native Operational-v2-Pruefung lieferte keinen einzelnen gueltigen JSON-Beleg.");
  }
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Native Operational-v2-Pruefung lieferte keinen Objektbeleg.");
  const receipt = value as Record<string, unknown>;
  invariant(receipt["schema"] === "operational-infrastructure-v2", "Native Operational-v2-Pruefung lieferte ein unbekanntes Belegschema.");
  invariant(receipt["infraReleaseId"] === input.expectedInfraReleaseId, "Native Operational-v2-Pruefung ist nicht an die erwartete InfraRelease-ID gebunden.");
  invariant(
    receipt["sourceBytes"] === input.artifact.bytes
      && receipt["sourceSha256"] === input.artifact.sha256
      && receipt["bytes"] === input.artifact.bytes
      && receipt["sha256"] === input.artifact.sha256,
    "Native Operational-v2-Pruefung ist nicht bytegenau an das ausgelieferte kanonische Artefakt gebunden.",
  );
  invariant(receipt["validationMode"] === "native-streaming-redb-v1", "Native Operational-v2-Pruefung verwendete nicht den freigegebenen Streamingmodus.");
  const stateHash = receipt["stateHash"];
  invariant(typeof stateHash === "string" && SHA256.test(stateHash) && stateHash !== input.artifact.sha256, "Native Operational-v2-Pruefung lieferte keinen getrennten gueltigen Zustandshash.");
  return {
    schema: "operational-infrastructure-v2",
    infraReleaseId: input.expectedInfraReleaseId,
    stateHash,
  };
}

/**
 * Prueft die native Binary beim Prozessstart und liefert einen begrenzt
 * parallelen Verifier ohne Cargo-, Shell- oder JavaScript-Fallback.
 */
export async function createInfraOperationalV2NativeVerifier(
  binaryPath: string,
  options: InfraOperationalNativeVerifierOptions = {},
): Promise<InfraOperationalV2NativeVerifier> {
  invariant(isAbsolute(binaryPath), "Native Operational-v2-Pruefdatei muss als absoluter Pfad konfiguriert sein.");
  const trustedBinaryPath = resolve(binaryPath);
  const trustedIdentity = await executableIdentity(trustedBinaryPath);
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Operational-v2-Prueftimeout", 60 * 60 * 1_000);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "Operational-v2-Ausgabelimit", 1 * 1_024 * 1_024);
  const maximumActive = positiveInteger(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, "Operational-v2-Parallelitaet", 4);
  const maximumQueued = positiveInteger(options.maxQueued ?? DEFAULT_MAX_QUEUED, "Operational-v2-Warteschlange", 32);
  const limiter = new BoundedWorkLimiter(maximumActive, maximumQueued);
  const execFile = options.execFile ?? productionExecFile;

  const assertPinnedIdentity = async (path: string, identity: ExecutableIdentity, phase: string): Promise<void> => {
    invariant(sameIdentity(await executableIdentity(path), identity), `Native Operational-v2-Pruefdatei wurde ${phase} ausgetauscht.`);
  };

  return async (input) => limiter.run(async () => {
    await assertPinnedIdentity(trustedBinaryPath, trustedIdentity, "seit dem Prozessstart");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zugfolge-operational-v2-stage-"));
    const temporaryMetadata = await lstat(temporaryRoot);
    invariant(temporaryMetadata.isDirectory() && !temporaryMetadata.isSymbolicLink(), "Operational-v2-Temporaerverzeichnis ist nicht regulaer und symlinkfrei.");
    let validatorSnapshotPath: string | undefined;
    try {
      const validatorSnapshot = await snapshotPinnedExecutable(temporaryRoot, trustedBinaryPath, trustedIdentity);
      validatorSnapshotPath = validatorSnapshot.path;
      const candidatePath = await composeCandidate(temporaryRoot, input);
      await Promise.all([
        assertPinnedIdentity(trustedBinaryPath, trustedIdentity, "unmittelbar vor dem Prozessstart"),
        assertPinnedIdentity(validatorSnapshot.path, validatorSnapshot.identity, "unmittelbar vor dem Prozessstart der privaten Kopie"),
      ]);
      const execution = executeNativeValidator(
        execFile,
        validatorSnapshot.path,
        candidatePath,
        input.expectedInfraReleaseId,
        timeoutMs,
        maxOutputBytes,
      );
      const [executionResult, startIdentityResult] = await Promise.allSettled([
        execution,
        Promise.all([
          assertPinnedIdentity(trustedBinaryPath, trustedIdentity, "waehrend des Prozessstarts"),
          assertPinnedIdentity(validatorSnapshot.path, validatorSnapshot.identity, "waehrend des Prozessstarts der privaten Kopie"),
        ]),
      ]);
      const endIdentityResult = await Promise.allSettled([
        assertPinnedIdentity(trustedBinaryPath, trustedIdentity, "nach dem Prozessende"),
        assertPinnedIdentity(validatorSnapshot.path, validatorSnapshot.identity, "nach dem Prozessende der privaten Kopie"),
      ]);
      const rejectedStartIdentity = startIdentityResult.status === "rejected" ? startIdentityResult.reason : undefined;
      const rejectedEndIdentity = endIdentityResult.find((result) => result.status === "rejected");
      if (rejectedStartIdentity !== undefined) throw rejectedStartIdentity;
      if (rejectedEndIdentity !== undefined) throw rejectedEndIdentity.reason;
      if (executionResult.status === "rejected") throw executionResult.reason;
      return validationReceipt(executionResult.value, input);
    } finally {
      await removeTemporaryComposition(temporaryRoot, validatorSnapshotPath);
    }
  });
}
