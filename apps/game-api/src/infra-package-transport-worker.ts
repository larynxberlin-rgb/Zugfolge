/** Begrenzter Worker-Adapter fuer die vollstaendige Kartenpaket-Transportpruefung. */

import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";

const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1_024;
const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_QUEUED = 4;

interface ModuleIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly sha256: string;
}

interface ModuleGraphEntry extends ModuleIdentity {
  readonly url: string;
}

interface TransportWorkerExecution<T> {
  readonly result: Promise<T>;
  readonly settled: Promise<void>;
}

interface TransportVerificationResult {
  readonly packageId: string;
  readonly version: string;
  readonly manifestSha256: string;
}

interface WorkerSuccess {
  readonly ok: true;
  readonly value: unknown;
}

interface WorkerFailure {
  readonly ok: false;
  readonly error: string;
}

type WorkerResponse = WorkerSuccess | WorkerFailure;

export interface LocalMapPackageVerifierOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  /** Ausschliesslich fuer fokussierte Importfenster-Racetests. */
  readonly beforeImportDelayMs?: number;
  /** Ausschliesslich fuer fokussierte Importfenster-Racetests. */
  readonly beforeImportMarkerPath?: string;
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

function workerResponse(value: unknown): WorkerResponse {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Kartenpaket-Worker lieferte keine Objektantwort.");
  const record = value as Record<string, unknown>;
  if (record["ok"] === false) {
    invariant(Object.keys(record).sort().join(",") === "error,ok", "Kartenpaket-Worker lieferte ein unbekanntes Fehlerantwortschema.");
    invariant(typeof record["error"] === "string" && record["error"] !== "", "Kartenpaket-Worker lieferte keinen Fehlertext.");
    return { ok: false, error: record["error"] };
  }
  invariant(
    record["ok"] === true && Object.keys(record).sort().join(",") === "ok,value",
    "Kartenpaket-Worker lieferte ein unbekanntes Antwortschema.",
  );
  return { ok: true, value: record["value"] };
}

function transportVerificationResult(result: unknown): TransportVerificationResult {
  invariant(result !== null && typeof result === "object" && !Array.isArray(result), "Kartenpaket-Worker lieferte keinen Paketbeleg.");
  const verified = result as Record<string, unknown>;
  invariant(
    Object.keys(verified).sort().join(",") === "manifestSha256,packageId,version"
      && typeof verified["packageId"] === "string" && verified["packageId"] !== ""
      && typeof verified["version"] === "string" && verified["version"] !== ""
      && typeof verified["manifestSha256"] === "string" && SHA256.test(verified["manifestSha256"]),
    "Kartenpaket-Worker lieferte keinen vollstaendigen Paketbeleg.",
  );
  return {
    packageId: verified["packageId"],
    version: verified["version"],
    manifestSha256: verified["manifestSha256"],
  };
}

function moduleGraph(value: unknown): readonly ModuleGraphEntry[] {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), "Kartenpaket-Worker lieferte keinen Modulgraphen.");
  const record = value as Record<string, unknown>;
  invariant(Object.keys(record).join(",") === "moduleGraph" && Array.isArray(record["moduleGraph"]), "Kartenpaket-Worker lieferte ein unbekanntes Modulgraph-Schema.");
  invariant(record["moduleGraph"].length > 0 && record["moduleGraph"].length <= 4_096, "Kartenpaket-Modulgraph ist leer oder zu gross.");
  const seen = new Set<string>();
  return record["moduleGraph"].map((entry: unknown): ModuleGraphEntry => {
    invariant(entry !== null && typeof entry === "object" && !Array.isArray(entry), "Kartenpaket-Modulgraph enthaelt keinen Objektknoten.");
    const node = entry as Record<string, unknown>;
    invariant(
      Object.keys(node).sort().join(",") === "dev,ino,mtimeMs,sha256,size,url"
        && typeof node["url"] === "string" && node["url"].startsWith("file:")
        && typeof node["dev"] === "number" && Number.isFinite(node["dev"])
        && typeof node["ino"] === "number" && Number.isFinite(node["ino"])
        && typeof node["size"] === "number" && Number.isSafeInteger(node["size"]) && node["size"] > 0
        && typeof node["mtimeMs"] === "number" && Number.isFinite(node["mtimeMs"])
        && typeof node["sha256"] === "string" && SHA256.test(node["sha256"]),
      "Kartenpaket-Modulgraph enthaelt einen ungueltigen Knoten.",
    );
    invariant(!seen.has(node["url"]), "Kartenpaket-Modulgraph enthaelt einen doppelten URL-Knoten.");
    seen.add(node["url"]);
    return {
      url: node["url"],
      dev: node["dev"],
      ino: node["ino"],
      size: node["size"],
      mtimeMs: node["mtimeMs"],
      sha256: node["sha256"],
    };
  });
}

async function moduleIdentity(path: string): Promise<ModuleIdentity> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") throw new Error(`Kartenpaket-Pruefmodul '${path}' fehlt.`);
    throw error;
  }
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `Kartenpaket-Pruefmodul '${path}' muss eine regulaere, symlinkfreie Datei sein.`);
  invariant(samePath(await realpath(path), path), `Kartenpaket-Pruefmodul '${path}' oder ein Elternpfad ist verlinkt.`);
  const bytes = await readFile(path);
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function sameIdentity(left: ModuleIdentity, right: ModuleIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.sha256 === right.sha256;
}

class BoundedTransportWorkLimiter {
  readonly #maximumActive: number;
  readonly #maximumQueued: number;
  #active = 0;
  readonly #queue: Array<{
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timeout: NodeJS.Timeout;
  }> = [];

  constructor(maximumActive: number, maximumQueued: number) {
    this.#maximumActive = maximumActive;
    this.#maximumQueued = maximumQueued;
  }

  async run<T>(
    deadlineMs: number,
    work: (remainingMs: number) => Promise<TransportWorkerExecution<T>>,
  ): Promise<T> {
    await this.#acquire(deadlineMs);
    let execution: TransportWorkerExecution<T>;
    try {
      const remainingMs = deadlineMs - Date.now();
      invariant(remainingMs > 0, "Kartenpaket-Transportpruefung hat ihre Gesamtdeadline bereits in der Warteschlange ueberschritten.");
      execution = await work(remainingMs);
    } catch (error) {
      this.#release();
      throw error;
    }
    void execution.settled.finally(() => this.#release()).catch(() => undefined);
    return execution.result;
  }

  async #acquire(deadlineMs: number): Promise<void> {
    if (this.#active < this.#maximumActive) {
      this.#active += 1;
      return;
    }
    invariant(this.#queue.length < this.#maximumQueued, "Zu viele Kartenpaket-Transportpruefungen warten bereits.");
    const remainingMs = deadlineMs - Date.now();
    invariant(remainingMs > 0, "Kartenpaket-Transportpruefung hat ihre Gesamtdeadline bereits vor der Warteschlange ueberschritten.");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const queued = {
        resolve: resolvePromise,
        reject: rejectPromise,
        timeout: setTimeout(() => {
          const index = this.#queue.indexOf(queued);
          if (index >= 0) this.#queue.splice(index, 1);
          rejectPromise(new Error("Kartenpaket-Transportpruefung hat ihre Gesamtdeadline in der Warteschlange ueberschritten."));
        }, remainingMs),
      };
      queued.timeout.unref();
      this.#queue.push(queued);
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next !== undefined) {
      clearTimeout(next.timeout);
      next.resolve();
      return;
    }
    this.#active -= 1;
  }
}

const TRANSPORT_WORKER_SOURCE = String.raw`
const { createHash } = require("node:crypto");
const { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } = require("node:fs");
const { registerHooks } = require("node:module");
const { join, resolve } = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { parentPort, workerData } = require("node:worker_threads");

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.sha256 === right.sha256;
}

function send(message) {
  const serialized = JSON.stringify(message);
  if (Buffer.byteLength(serialized, "utf8") > workerData.maxOutputBytes) {
    parentPort.postMessage({ ok: false, error: "Kartenpaket-Workerantwort ueberschreitet das Ausgabelimit." });
    return;
  }
  parentPort.postMessage(message);
}

function observeFileModule(url) {
  const path = fileURLToPath(url);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Kartenpaket-ESM-Abhaengigkeit ist nicht regulaer und symlinkfrei: " + url);
  if (!samePath(realpathSync(path), path)) throw new Error("Kartenpaket-ESM-Abhaengigkeit oder ein Elternpfad ist verlinkt: " + url);
  const source = readFileSync(path);
  return { source, identity: {
    url,
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: createHash("sha256").update(source).digest("hex"),
  } };
}

const expectedGraph = workerData.moduleGraph === undefined
  ? undefined
  : new Map(workerData.moduleGraph.map((entry) => [entry.url, entry]));
const observedGraph = new Map();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const protocol = new URL(resolved.url).protocol;
    if (!["node:", "file:", "data:"].includes(protocol)) {
      throw new Error("Kartenpaket-Pruefmodul verwendet ein nicht isolierbares Modulprotokoll: " + protocol);
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    const protocol = new URL(url).protocol;
    if (protocol === "node:" || protocol === "data:") return nextLoad(url, context);
    if (protocol !== "file:") throw new Error("Kartenpaket-Pruefmodul verwendet eine nicht gepinnte Abhaengigkeit: " + url);
    const observed = observeFileModule(url);
    if (expectedGraph !== undefined) {
      const expected = expectedGraph.get(url);
      if (expected === undefined) throw new Error("Kartenpaket-Pruefmodul hat eine neue, nicht gepinnte ESM-Abhaengigkeit geladen: " + url);
      if (!sameIdentity(observed.identity, expected)) throw new Error("Kartenpaket-ESM-Abhaengigkeit wurde seit dem Prozessstart ausgetauscht: " + url);
    }
    const previous = observedGraph.get(url);
    if (previous !== undefined && !sameIdentity(previous, observed.identity)) {
      throw new Error("Kartenpaket-ESM-Abhaengigkeit wechselte waehrend desselben Imports: " + url);
    }
    observedGraph.set(url, observed.identity);
    const loaded = nextLoad(url, context);
    if (!["module", "commonjs", "json"].includes(loaded.format)) {
      throw new Error("Kartenpaket-Pruefmodul verwendet ein nicht isolierbares Dateimodulformat: " + String(loaded.format));
    }
    return { ...loaded, source: observed.source };
  },
});

function assertGraphCurrent() {
  if (expectedGraph !== undefined) {
    if (observedGraph.size !== expectedGraph.size) throw new Error("Kartenpaket-ESM-Abhaengigkeitsgraph ist unvollstaendig.");
    for (const url of expectedGraph.keys()) {
      if (!observedGraph.has(url)) throw new Error("Gepinnte Kartenpaket-ESM-Abhaengigkeit wurde nicht geladen: " + url);
    }
  }
  for (const [url, identity] of observedGraph) {
    if (!sameIdentity(observeFileModule(url).identity, identity)) {
      throw new Error("Kartenpaket-ESM-Abhaengigkeit wurde waehrend der Pruefung ausgetauscht: " + url);
    }
  }
}

function mirrorPackageTree(sourceRoot, destinationRoot) {
  const sourceMetadata = lstatSync(sourceRoot);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink() || !samePath(realpathSync(sourceRoot), sourceRoot)) {
    throw new Error("Kartenpaket-Quellwurzel ist nicht regulaer und symlinkfrei.");
  }
  mkdirSync(destinationRoot, { mode: 0o700 });
  const visit = (sourceDirectory, destinationDirectory) => {
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const sourcePath = join(sourceDirectory, entry.name);
      const destinationPath = join(destinationDirectory, entry.name);
      const metadata = lstatSync(sourcePath);
      if (metadata.isSymbolicLink()) throw new Error("Kartenpaket-Quellbaum enthaelt einen symbolischen Link: " + sourcePath);
      if (metadata.isDirectory()) {
        if (!samePath(realpathSync(sourcePath), sourcePath)) throw new Error("Kartenpaket-Quellverzeichnis oder ein Elternpfad ist verlinkt: " + sourcePath);
        mkdirSync(destinationPath, { mode: 0o700 });
        visit(sourcePath, destinationPath);
        continue;
      }
      if (!metadata.isFile() || !samePath(realpathSync(sourcePath), sourcePath)) {
        throw new Error("Kartenpaket-Quelldatei ist nicht regulaer und symlinkfrei: " + sourcePath);
      }
      linkSync(sourcePath, destinationPath);
      const linked = lstatSync(destinationPath);
      if (!linked.isFile() || linked.isSymbolicLink() || linked.dev !== metadata.dev || linked.ino !== metadata.ino) {
        throw new Error("Kartenpaket-Quelldatei wurde waehrend der isolierten Spiegelung ausgetauscht: " + sourcePath);
      }
    }
  };
  visit(sourceRoot, destinationRoot);
}

async function run() {
  const entryUrl = pathToFileURL(workerData.modulePath).href + "?identity=" + workerData.moduleIdentity.sha256;
  const initialEntry = observeFileModule(entryUrl).identity;
  if (!sameIdentity(initialEntry, workerData.moduleIdentity)) throw new Error("Kartenpaket-Pruefmodul wurde seit dem Prozessstart ausgetauscht.");
  if (workerData.action === "verify" && workerData.beforeImportMarkerPath !== undefined) {
    writeFileSync(workerData.beforeImportMarkerPath, "ready", { encoding: "utf8", flag: "wx" });
  }
  if (workerData.action === "verify" && workerData.beforeImportDelayMs > 0) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, workerData.beforeImportDelayMs));
  }
  const loaded = await import(entryUrl);
  assertGraphCurrent();
  if (typeof loaded.verifyMapPackageTransport !== "function") throw new Error("Konfiguriertes Kartenpaket-Pruefmodul exportiert verifyMapPackageTransport nicht.");
  if (workerData.action === "probe") {
    send({
      ok: true,
      value: { moduleGraph: [...observedGraph.values()].sort((left, right) => left.url.localeCompare(right.url, "en")) },
    });
    return;
  }
  mirrorPackageTree(workerData.sourcePackageRoot, workerData.packageRoot);
  const verified = await loaded.verifyMapPackageTransport(workerData.packageRoot);
  assertGraphCurrent();
  const value = {
    packageId: verified && verified.manifest && verified.manifest.packageId,
    version: verified && verified.manifest && verified.manifest.version,
    manifestSha256: verified && verified.manifestSha256,
  };
  if (typeof value.packageId !== "string" || value.packageId === ""
    || typeof value.version !== "string" || value.version === ""
    || typeof value.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.manifestSha256)) {
    throw new Error("Kartenpaket-Transportpruefung lieferte keinen vollstaendigen Paketbeleg.");
  }
  send({ ok: true, value });
}

run().catch((error) => {
  const raw = error instanceof Error ? error.message : String(error);
  send({ ok: false, error: raw.slice(0, Math.max(64, workerData.maxOutputBytes - 128)) });
});
`;

async function removeTransportIsolationRoot(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  try {
    const metadata = await lstat(path);
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Kartenpaket-Worker-Isolationswurzel wurde vor der Bereinigung ausgetauscht.");
    invariant(samePath(await realpath(path), path), "Kartenpaket-Worker-Isolationswurzel oder ein Elternpfad wurde vor der Bereinigung verlinkt.");
    await rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function executeTransportWorker(input: {
  readonly action: "probe" | "verify";
  readonly modulePath: string;
  readonly moduleIdentity: ModuleIdentity;
  readonly moduleGraph?: readonly ModuleGraphEntry[];
  readonly packageRoot?: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly beforeImportDelayMs: number;
  readonly beforeImportMarkerPath?: string;
}): Promise<TransportWorkerExecution<unknown>> {
  let isolationRoot: string | undefined;
  let workerInput: typeof input & { readonly sourcePackageRoot?: string } = input;
  if (input.action === "verify") {
    invariant(input.packageRoot !== undefined, "Kartenpaket-Worker besitzt keine Paketwurzel.");
    const sourcePackageRoot = resolve(input.packageRoot);
    isolationRoot = await mkdtemp(join(dirname(sourcePackageRoot), ".game-map-worker-"));
    workerInput = {
      ...input,
      sourcePackageRoot,
      packageRoot: join(isolationRoot, "package"),
    };
  }
  try {
    const worker = new Worker(TRANSPORT_WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      stdout: true,
      stderr: true,
      workerData: workerInput,
      resourceLimits: {
        maxOldGenerationSizeMb: 512,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 8,
      },
    });
    let response: WorkerResponse | undefined;
    let responseCount = 0;
    let outputBytes = 0;
    let failure: Error | undefined;
    let exitCode: number | undefined;
    let exitObserved = false;
    let terminationRequested = false;
    let terminationSettled = true;
    let finished = false;
    let timeout: NodeJS.Timeout | undefined;
    let resolveCompletion!: (value: unknown) => void;
    let rejectCompletion!: (error: Error) => void;
    let rejectEarly!: (error: Error) => void;
    let earlyFailureSignalled = false;

    const completion = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });
    const earlyFailure = new Promise<never>((_resolvePromise, rejectPromise) => {
      rejectEarly = rejectPromise;
    });

    const finishAfterExit = () => {
      if (finished || !exitObserved || !terminationSettled) return;
      finished = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (failure !== undefined) {
        rejectCompletion(failure);
        return;
      }
      if (exitCode !== 0) {
        rejectCompletion(new Error(`Kartenpaket-Worker endete mit Code ${String(exitCode)}.`));
        return;
      }
      if (responseCount !== 1 || response === undefined) {
        rejectCompletion(new Error("Kartenpaket-Worker lieferte nicht exakt einen Beleg."));
        return;
      }
      if (response.ok === false) {
        rejectCompletion(new Error(response.error));
        return;
      }
      resolveCompletion(response.value);
    };
    const terminateAfterFailure = (error: Error) => {
      failure ??= error;
      if (!earlyFailureSignalled) {
        earlyFailureSignalled = true;
        rejectEarly(failure);
      }
      if (terminationRequested) return;
      terminationRequested = true;
      if (timeout !== undefined) clearTimeout(timeout);
      terminationSettled = false;
      void worker.terminate()
        .catch((terminationError: unknown) => {
          failure ??= new Error(`Kartenpaket-Worker konnte nicht beendet werden: ${terminationError instanceof Error ? terminationError.message : String(terminationError)}`);
        })
        .finally(() => {
          terminationSettled = true;
          finishAfterExit();
        });
    };
    const observeOutput = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > input.maxOutputBytes) {
        terminateAfterFailure(new Error("Kartenpaket-Worker ueberschreitet das Ausgabelimit."));
      }
    };
    worker.stdout?.on("data", observeOutput);
    worker.stderr?.on("data", observeOutput);
    worker.on("message", (message: unknown) => {
      responseCount += 1;
      if (responseCount !== 1) {
        terminateAfterFailure(new Error("Kartenpaket-Worker lieferte mehr als eine Antwort."));
        return;
      }
      let bytes: number;
      try {
        bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      } catch {
        terminateAfterFailure(new Error("Kartenpaket-Workerantwort ist nicht begrenzt serialisierbar."));
        return;
      }
      if (bytes > input.maxOutputBytes) {
        terminateAfterFailure(new Error("Kartenpaket-Workerantwort ueberschreitet das Ausgabelimit."));
        return;
      }
      try {
        response = workerResponse(message);
      } catch (error) {
        terminateAfterFailure(error instanceof Error ? error : new Error(String(error)));
      }
    });
    worker.once("error", (error: unknown) => terminateAfterFailure(new Error(`Kartenpaket-Worker ist fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`)));
    worker.once("exit", (code) => {
      exitCode = code;
      exitObserved = true;
      finishAfterExit();
    });
    timeout = setTimeout(
      () => terminateAfterFailure(new Error("Kartenpaket-Transportpruefung hat ihr Zeitlimit ueberschritten.")),
      input.timeoutMs,
    );
    timeout.unref();
    const completionWithCleanup = completion.finally(async () => removeTransportIsolationRoot(isolationRoot));
    return {
      result: Promise.race([completionWithCleanup, earlyFailure]),
      settled: completionWithCleanup.then(() => undefined, () => undefined),
    };
  } catch (error) {
    await removeTransportIsolationRoot(isolationRoot);
    throw error;
  }
}

/**
 * Pinnt das konfigurierte ESM-Pruefmodul beim Prozessstart und fuehrt jede
 * vollstaendige Transportpruefung in einem begrenzten Worker statt im
 * Fastify-Hauptthread aus. Die native Operational-v2-Semantik bleibt getrennt.
 */
export async function createLocalMapPackageVerifier(
  modulePath: string,
  options: LocalMapPackageVerifierOptions = {},
): Promise<(packageRoot: string) => Promise<TransportVerificationResult>> {
  const trustedModulePath = resolve(modulePath);
  const trustedIdentity = await moduleIdentity(trustedModulePath);
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Kartenpaket-Prueftimeout", 60 * 60 * 1_000);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "Kartenpaket-Ausgabelimit", 1 * 1_024 * 1_024);
  const maximumActive = positiveInteger(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, "Kartenpaket-Parallelitaet", 4);
  const maximumQueued = positiveInteger(options.maxQueued ?? DEFAULT_MAX_QUEUED, "Kartenpaket-Warteschlange", 32);
  const beforeImportDelayMs = options.beforeImportDelayMs ?? 0;
  invariant(
    Number.isSafeInteger(beforeImportDelayMs) && beforeImportDelayMs >= 0 && beforeImportDelayMs <= 2_000,
    "Kartenpaket-Importverzoegerung ist ausserhalb des erlaubten Bereichs.",
  );
  invariant(
    options.beforeImportMarkerPath === undefined
      || (options.beforeImportMarkerPath !== "" && isAbsolute(options.beforeImportMarkerPath)),
    "Kartenpaket-Importmarker muss ein absoluter Pfad sein.",
  );
  const beforeImportMarkerPath = options.beforeImportMarkerPath === undefined ? undefined : resolve(options.beforeImportMarkerPath);
  const probeExecution = await executeTransportWorker({
    action: "probe",
    modulePath: trustedModulePath,
    moduleIdentity: trustedIdentity,
    timeoutMs,
    maxOutputBytes,
    beforeImportDelayMs,
    beforeImportMarkerPath,
  });
  const probe = await probeExecution.result;
  const trustedModuleGraph = moduleGraph(probe);
  const limiter = new BoundedTransportWorkLimiter(maximumActive, maximumQueued);

  return async (packageRoot) => {
    const deadlineMs = Date.now() + timeoutMs;
    return limiter.run(deadlineMs, async (remainingMs) => {
    invariant(
      sameIdentity(await moduleIdentity(trustedModulePath), trustedIdentity),
      "Kartenpaket-Pruefmodul wurde seit dem Prozessstart ausgetauscht.",
    );
    const workerTimeoutMs = deadlineMs - Date.now();
    invariant(workerTimeoutMs > 0, "Kartenpaket-Transportpruefung hat ihre Gesamtdeadline vor dem Workerstart ueberschritten.");
    const execution = await executeTransportWorker({
      action: "verify",
      modulePath: trustedModulePath,
      moduleIdentity: trustedIdentity,
      moduleGraph: trustedModuleGraph,
      packageRoot: resolve(packageRoot),
      timeoutMs: Math.min(remainingMs, workerTimeoutMs),
      maxOutputBytes,
      beforeImportDelayMs,
      beforeImportMarkerPath,
    });
    return {
      result: execution.result.then(transportVerificationResult),
      settled: execution.settled,
    };
  });
  };
}
