import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as verifyEd25519,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const PART_BYTES = 100 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const PACKAGE_SCHEMA = "zugfolge-map-package/v1";
const DELIVERY_SCHEMA = "zugfolge-map-delivery-release/v1";
const SOURCES_SCHEMA = "zugfolge-map-delivery-sources/v1";
const QUALITY_SCHEMA = "zugfolge-final-infrastructure-quality-report/v1";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InfraPackageStagingError(message);
}

export class InfraPackageStagingError extends Error {
  constructor(message: string, readonly code = "invalid_infra_package") {
    super(message);
    this.name = "InfraPackageStagingError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} muss ein Objekt sein.`);
  return value as Record<string, unknown>;
}

function safeId(value: unknown, label: string): string {
  invariant(typeof value === "string" && SAFE_ID.test(value), `${label} ist keine sichere ID.`);
  return value;
}

function portablePath(value: unknown, label: string): string {
  invariant(typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes("\0") && !value.includes("://") && !value.startsWith("/") && !/^[a-z]:/i.test(value), `${label} ist kein sicherer relativer Pfad.`);
  invariant(value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), `${label} enthält ein unsicheres Segment.`);
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalManifest(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface PackagePart {
  readonly partId: string;
  readonly packagePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface PackageFile {
  readonly id: string;
  readonly kind: string;
  readonly installPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly parts: readonly PackagePart[];
}

interface ParsedPackageManifest {
  readonly manifest: Record<string, unknown>;
  readonly packageId: string;
  readonly version: string;
  readonly files: readonly PackageFile[];
  readonly parts: readonly PackagePart[];
}

function parsePackageManifest(bytes: Buffer): ParsedPackageManifest {
  invariant(bytes.length > 0 && bytes.length <= MAX_MANIFEST_BYTES, "Paketmanifest hat eine unzulässige Größe.");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new InfraPackageStagingError("Paketmanifest ist kein gültiges JSON."); }
  const manifest = record(value, "Paketmanifest");
  invariant(manifest["schema"] === PACKAGE_SCHEMA && manifest["format"] === "directory-parts", "Paketmanifest hat ein unbekanntes Schema oder Format.");
  invariant(bytes.toString("utf8") === canonicalManifest(manifest), "Paketmanifest ist nicht kanonisch serialisiert.");
  const packageId = safeId(manifest["packageId"], "packageId");
  const version = safeId(manifest["version"], "version");
  invariant(manifest["partBytes"] === PART_BYTES, "Jahrespaket muss das 100-MiB-Transportprofil verwenden.");
  const artifacts = manifest["artifacts"];
  const auxiliaryFiles = manifest["auxiliaryFiles"];
  invariant(Array.isArray(artifacts) && artifacts.length === 2 && Array.isArray(auxiliaryFiles) && auxiliaryFiles.length >= 6, "Paketinventar ist unvollständig.");
  invariant(artifacts.filter((entry) => record(entry, "Artefakt")["kind"] === "basemap").length === 1, "Paket braucht genau eine Basemap.");
  invariant(artifacts.filter((entry) => record(entry, "Artefakt")["kind"] === "infrastructure").length === 1, "Paket braucht genau eine Infrastrukturdatei.");
  const readModels = auxiliaryFiles.filter((entry) => record(entry, "Hilfsdatei")["kind"] === "read-model");
  const trainProjections = auxiliaryFiles.filter((entry) => record(entry, "Hilfsdatei")["kind"] === "train-map-projection");
  invariant(readModels.length === 1 && record(readModels[0], "ReadModel")["installPath"] === "read-model.sqlite", "Paket braucht genau ein öffentliches read-model.sqlite in der Releasewurzel.");
  invariant(trainProjections.length === 1 && record(trainProjections[0], "Zugpositionsprojektion")["installPath"] === "train-map-projection.sqlite", "Paket braucht genau eine eigenständige train-map-projection.sqlite in der Releasewurzel.");

  const ids = new Set<string>();
  const paths = new Set<string>();
  const partIds = new Set<string>();
  const files: PackageFile[] = [];
  for (const raw of [...artifacts, ...auxiliaryFiles]) {
    const entry = record(raw, "Paketdatei");
    const id = safeId(entry["id"], "Paketdatei-ID");
    invariant(!ids.has(id), `Paketdatei-ID ${id} ist doppelt.`);
    ids.add(id);
    const installPath = portablePath(entry["installPath"], `${id}.installPath`);
    invariant(!paths.has(installPath.toLowerCase()), `Installationspfad ${installPath} ist doppelt.`);
    paths.add(installPath.toLowerCase());
    const fileBytes = entry["bytes"];
    invariant(Number.isSafeInteger(fileBytes) && (fileBytes as number) > 0 && SHA256.test(String(entry["sha256"])), `${id} hat keine gültige Bytezahl oder Prüfsumme.`);
    invariant(Array.isArray(entry["parts"]) && entry["parts"].length > 0, `${id} besitzt keine Paketteile.`);
    let sum = 0;
    const parts: PackagePart[] = [];
    for (const [index, rawPart] of (entry["parts"] as unknown[]).entries()) {
      const part = record(rawPart, `${id}.parts[${index}]`);
      const packagePath = portablePath(part["path"], `${id}.parts[${index}].path`);
      const partBytes = part["bytes"];
      const partSha = String(part["sha256"]);
      invariant(Number.isSafeInteger(partBytes) && (partBytes as number) > 0 && (partBytes as number) <= PART_BYTES && SHA256.test(partSha), `${packagePath} hat keine gültige Bytezahl oder Prüfsumme.`);
      invariant(!paths.has(packagePath.toLowerCase()), `Paketpfad ${packagePath} ist doppelt.`);
      paths.add(packagePath.toLowerCase());
      const partId = sha256(`${id}\0${index}\0${partSha}`).slice(0, 32);
      invariant(!partIds.has(partId), "Paketteilkennung kollidiert.");
      partIds.add(partId);
      parts.push({ partId, packagePath, bytes: partBytes as number, sha256: partSha });
      sum += partBytes as number;
      invariant(Number.isSafeInteger(sum), `${id} ist zu groß.`);
    }
    invariant(sum === fileBytes, `${id}: Summe der Teile stimmt nicht.`);
    files.push({ id, kind: String(entry["kind"]), installPath, bytes: fileBytes as number, sha256: String(entry["sha256"]), parts });
  }
  return { manifest, packageId, version, files, parts: files.flatMap(({ parts }) => parts) };
}

async function hashFile(path: string): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function writeStream(path: string, source: AsyncIterable<Buffer | string>, maximumBytes: number): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const handle = await open(path, "wx");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      invariant(bytes <= maximumBytes, "Upload überschreitet die erwartete Bytezahl.");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset);
        invariant(result.bytesWritten > 0, "Upload konnte nicht vollständig geschrieben werden.");
        offset += result.bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function renameAtomic(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(source, destination); return; } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (!["EACCES", "EBUSY", "EPERM"].includes(code) || attempt >= 5) throw error;
      await delay(25 * (2 ** attempt));
    }
  }
}

interface Session {
  readonly schema: "zugfolge-infra-package-upload-session/v1";
  readonly importId: string;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  readonly packageId?: string;
  readonly version?: string;
  readonly parts?: readonly PackagePart[];
}

interface ManifestState {
  readonly schema: "zugfolge-infra-package-upload-manifest/v1";
  readonly packageId: string;
  readonly version: string;
  readonly parts: readonly PackagePart[];
}

interface FinalizationReceipt {
  readonly schema: "zugfolge-infra-package-upload-receipt/v1";
  readonly uploadStatus: "closed";
  readonly importId: string;
  readonly manifestBytes: number;
  readonly manifestSha256: string;
  readonly packageId: string;
  readonly version: string;
  readonly parts: readonly PackagePart[];
  readonly stageName: string;
  readonly qualification: InfraPackageQualification;
}

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
}

async function ensureRegularDirectory(path: string): Promise<void> {
  try { await mkdir(path); } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), `${path} muss ein regulaeres Verzeichnis sein.`);
}

async function readRegularJson(path: string): Promise<unknown> {
  const metadata = await lstat(path);
  invariant(metadata.isFile() && !metadata.isSymbolicLink(), `${path} muss eine regulaere JSON-Datei sein.`);
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export interface InfraUploadContentProof {
  readonly bytes: number;
  readonly sha256: string;
}

export interface InfraPackageQualification {
  readonly packageId: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly deliveryReleaseId: string;
  readonly signatureStatus: "missing" | "verified";
  readonly activationEligible: boolean;
}

export interface InfraPackageVerifierResult {
  readonly packageId: string;
  readonly version: string;
  readonly manifestSha256: string;
}

export type InfraPackageVerifier = (packageRoot: string) => Promise<InfraPackageVerifierResult>;

export async function createLocalMapPackageVerifier(modulePath: string): Promise<InfraPackageVerifier> {
  const trustedModulePath = await realpath(resolve(modulePath));
  const loaded = await import(pathToFileURL(trustedModulePath).href) as {
    readonly verifyMapPackage?: (packageRoot: string) => Promise<{
      readonly manifest: { readonly packageId: string; readonly version: string };
      readonly manifestSha256: string;
    }>;
  };
  invariant(typeof loaded.verifyMapPackage === "function", "Konfiguriertes Kartenpaket-Prüfmodul exportiert verifyMapPackage nicht.");
  return async (packageRoot) => {
    const verified = await loaded.verifyMapPackage!(packageRoot);
    return {
      packageId: verified.manifest.packageId,
      version: verified.manifest.version,
      manifestSha256: verified.manifestSha256,
    };
  };
}

export class InfraPackageStaging {
  readonly #root: string;
  readonly #trustedReleaseKeys: Readonly<Record<string, string>>;
  readonly #packageVerifier: InfraPackageVerifier;
  readonly #importLocks = new Map<string, Promise<void>>();

  constructor(root: string, options: { readonly packageVerifier: InfraPackageVerifier; readonly trustedReleaseKeys?: Readonly<Record<string, string>> }) {
    this.#root = resolve(root);
    this.#packageVerifier = options.packageVerifier;
    this.#trustedReleaseKeys = options.trustedReleaseKeys ?? {};
  }

  async initialize(): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    const metadata = await lstat(this.#root);
    invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Stagingwurzel muss ein reguläres Verzeichnis sein.");
    await ensureRegularDirectory(join(this.#root, ".receiving"));
    await ensureRegularDirectory(join(this.#root, ".receipts"));
    await ensureRegularDirectory(join(this.#root, "staged"));
  }

  async #withImportLock<T>(importId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#importLocks.get(importId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.then(() => gate);
    this.#importLocks.set(importId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#importLocks.get(importId) === tail) this.#importLocks.delete(importId);
    }
  }

  async expectedManifest(importId: string): Promise<InfraUploadContentProof> {
    const receipt = await this.#readReceipt(importId);
    const session = receipt ?? await this.#readSession(importId);
    return { bytes: session.manifestBytes, sha256: session.manifestSha256 };
  }

  async expectedPart(importId: string, partId: string): Promise<InfraUploadContentProof> {
    const receipt = await this.#readReceipt(importId);
    const session = receipt ?? await this.#readSession(importId);
    invariant(Array.isArray(session.parts), "Paketmanifest wurde noch nicht hochgeladen.");
    const part = session.parts.find((candidate) => candidate.partId === partId);
    invariant(part !== undefined, "Unbekannte serverseitige Paketteilkennung.");
    return { bytes: part.bytes, sha256: part.sha256 };
  }

  #sessionRoot(importId: string): string {
    return join(this.#root, ".receiving", safeId(importId, "importId"));
  }

  #receiptPath(importId: string): string {
    return join(this.#root, ".receipts", `${safeId(importId, "importId")}.json`);
  }

  async #readReceipt(importId: string): Promise<FinalizationReceipt | undefined> {
    let value: unknown;
    try { value = await readRegularJson(this.#receiptPath(importId)); } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    const receipt = record(value, "Finalisierungsbeleg") as unknown as FinalizationReceipt;
    invariant(
      receipt.schema === "zugfolge-infra-package-upload-receipt/v1" && receipt.uploadStatus === "closed" &&
      receipt.importId === importId && Number.isSafeInteger(receipt.manifestBytes) && receipt.manifestBytes > 0 &&
      SHA256.test(receipt.manifestSha256) && SAFE_ID.test(receipt.packageId) && SAFE_ID.test(receipt.version) &&
      Array.isArray(receipt.parts),
      "Persistierter Finalisierungsbeleg ist ungültig.",
    );
    const expectedStageName = `${receipt.packageId}-${receipt.version}-${receipt.manifestSha256.slice(0, 16)}`;
    invariant(receipt.stageName === expectedStageName, "Finalisierungsbeleg besitzt ein abweichendes Stagingziel.");
    const signatureQualificationIsConsistent =
      receipt.qualification.signatureStatus === "missing"
        ? receipt.qualification.activationEligible === false
        : receipt.qualification.signatureStatus === "verified"
          && receipt.qualification.activationEligible === true;
    invariant(
      receipt.qualification.packageId === receipt.packageId && receipt.qualification.version === receipt.version &&
      receipt.qualification.manifestSha256 === receipt.manifestSha256 &&
      signatureQualificationIsConsistent,
      "Finalisierungsbeleg besitzt eine unzulässige Qualifikation.",
    );
    return receipt;
  }

  async #persistReceipt(receipt: FinalizationReceipt): Promise<FinalizationReceipt> {
    const path = this.#receiptPath(receipt.importId);
    const temporaryPath = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "wx", flush: true });
      try {
        await link(temporaryPath, path);
        return receipt;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = await this.#readReceipt(receipt.importId);
        invariant(existing !== undefined && JSON.stringify(existing) === JSON.stringify(receipt), "Parallel persistierter Finalisierungsbeleg weicht ab.");
        return existing;
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async #ensureActiveSessionDirectories(importId: string): Promise<void> {
    const sessionRoot = this.#sessionRoot(importId);
    await ensureRegularDirectory(sessionRoot);
    await ensureRegularDirectory(join(sessionRoot, "package"));
    await ensureRegularDirectory(join(sessionRoot, "package", "parts"));
  }

  async #ensurePackageParent(importId: string, packagePath: string): Promise<string> {
    let parent = join(this.#sessionRoot(importId), "package");
    const rootMetadata = await lstat(parent);
    invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Paketwurzel muss ein reguläres Verzeichnis sein.");
    const segments = packagePath.split("/");
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      await ensureRegularDirectory(parent);
    }
    return join(parent, segments.at(-1)!);
  }

  async #readSession(importId: string): Promise<Session> {
    const root = this.#sessionRoot(importId);
    const rootMetadata = await lstat(root);
    invariant(rootMetadata.isDirectory() && !rootMetadata.isSymbolicLink(), "Uploadsitzung muss ein reguläres Verzeichnis sein.");
    const session = await readRegularJson(join(root, "session.json")) as Session;
    try {
      const state = await readRegularJson(join(root, "manifest-state.json")) as ManifestState;
      invariant(state.schema === "zugfolge-infra-package-upload-manifest/v1", "Persistierter Manifestzustand hat ein unbekanntes Schema.");
      return { ...session, packageId: state.packageId, version: state.version, parts: state.parts };
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return session;
      throw error;
    }
  }

  async #persistManifestState(importId: string, parsed: ParsedPackageManifest): Promise<void> {
    const path = join(this.#sessionRoot(importId), "manifest-state.json");
    const state: ManifestState = {
      schema: "zugfolge-infra-package-upload-manifest/v1",
      packageId: parsed.packageId,
      version: parsed.version,
      parts: parsed.parts,
    };
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as ManifestState;
      invariant(JSON.stringify(existing) === JSON.stringify(state), "Import-ID besitzt einen abweichenden Manifestzustand.");
      return;
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const temporaryPath = `${path}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", flag: "wx", flush: true });
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const existing = JSON.parse(await readFile(path, "utf8")) as ManifestState;
        invariant(JSON.stringify(existing) === JSON.stringify(state), "Parallel persistierter Manifestzustand weicht ab.");
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async begin(importId: string, manifest: { readonly bytes: number; readonly sha256: string }): Promise<{ readonly status: "created" | "reused" }> {
    await this.initialize();
    safeId(importId, "importId");
    invariant(Number.isSafeInteger(manifest.bytes) && manifest.bytes > 0 && manifest.bytes <= MAX_MANIFEST_BYTES && SHA256.test(manifest.sha256), "Manifest-Metadaten sind ungültig.");
    return this.#withImportLock(importId, async () => {
      const receipt = await this.#readReceipt(importId);
      if (receipt) {
        invariant(receipt.manifestBytes === manifest.bytes && receipt.manifestSha256 === manifest.sha256, "Abgeschlossene Import-ID gehört zu einem anderen Manifest.");
        return { status: "reused" };
      }
      const sessionRoot = this.#sessionRoot(importId);
      try {
        const existing = await this.#readSession(importId);
        invariant(existing.manifestBytes === manifest.bytes && existing.manifestSha256 === manifest.sha256, "Import-ID gehört zu einem anderen Manifest.");
        return { status: "reused" };
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      await this.#ensureActiveSessionDirectories(importId);
      const session: Session = { schema: "zugfolge-infra-package-upload-session/v1", importId, manifestBytes: manifest.bytes, manifestSha256: manifest.sha256 };
      const temporarySessionPath = join(sessionRoot, `.session-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
      try {
        await writeFile(temporarySessionPath, `${JSON.stringify(session)}\n`, { encoding: "utf8", flag: "wx", flush: true });
        try {
          await link(temporarySessionPath, join(sessionRoot, "session.json"));
          return { status: "created" };
        } catch (error) {
          if (errorCode(error) !== "EEXIST") throw error;
          const existing = await this.#readSession(importId);
          invariant(existing.manifestBytes === manifest.bytes && existing.manifestSha256 === manifest.sha256, "Parallel verwendete Import-ID gehört zu einem anderen Manifest.");
          return { status: "reused" };
        }
      } finally {
        await rm(temporarySessionPath, { force: true });
      }
    });
  }

  async uploadManifest(importId: string, proof: InfraUploadContentProof, source: AsyncIterable<Buffer | string>): Promise<{ readonly status: "stored" | "reused"; readonly parts: readonly PackagePart[] }> {
    return this.#withImportLock(importId, async () => {
    invariant((await this.#readReceipt(importId)) === undefined, "Uploadsitzung ist bereits endgültig abgeschlossen.");
    const session = await this.#readSession(importId);
    invariant(proof.bytes === session.manifestBytes && proof.sha256 === session.manifestSha256, "Signierter Manifestbeleg stimmt nicht mit der Uploadsitzung überein.");
    const packageRoot = join(this.#sessionRoot(importId), "package");
    const packageMetadata = await lstat(packageRoot);
    invariant(packageMetadata.isDirectory() && !packageMetadata.isSymbolicLink(), "Paketwurzel muss ein reguläres Verzeichnis sein.");
    const finalPath = join(packageRoot, "manifest.json");
    try {
      const observed = await hashFile(finalPath);
      invariant(observed.bytes === session.manifestBytes && observed.sha256 === session.manifestSha256, "Bereits gespeichertes Manifest ist beschädigt.");
      const parsed = parsePackageManifest(await readFile(finalPath));
      await this.#persistManifestState(importId, parsed);
      return { status: "reused", parts: parsed.parts };
    } catch (error) {
      if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const temporaryPath = join(this.#sessionRoot(importId), `.manifest-uploading-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const observed = await writeStream(temporaryPath, source, session.manifestBytes);
      invariant(observed.bytes === session.manifestBytes && observed.sha256 === session.manifestSha256, "Manifest-Upload stimmt nicht mit Bytezahl oder SHA-256 überein.");
      const bytes = await readFile(temporaryPath);
      const parsed = parsePackageManifest(bytes);
      let status: "stored" | "reused" = "stored";
      try {
        await link(temporaryPath, finalPath);
      } catch (error) {
        if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const existing = await hashFile(finalPath);
        invariant(existing.bytes === session.manifestBytes && existing.sha256 === session.manifestSha256, "Parallel gespeichertes Manifest ist beschädigt.");
        status = "reused";
      }
      const checksumPath = join(packageRoot, "manifest.sha256");
      const checksumBytes = Buffer.from(`${session.manifestSha256}  manifest.json\n`, "ascii");
      const temporaryChecksumPath = `${checksumPath}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await writeFile(temporaryChecksumPath, checksumBytes, { flag: "wx", flush: true });
        try {
          await link(temporaryChecksumPath, checksumPath);
        } catch (error) {
          if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
          invariant((await readFile(checksumPath)).equals(checksumBytes), "Persistierte Manifestprüfsumme weicht ab.");
        }
      } finally {
        await rm(temporaryChecksumPath, { force: true });
      }
      await this.#persistManifestState(importId, parsed);
      return { status, parts: parsed.parts };
    } finally {
      await rm(temporaryPath, { force: true });
    }
    });
  }

  async uploadPart(importId: string, partId: string, proof: InfraUploadContentProof, source: AsyncIterable<Buffer | string>): Promise<{ readonly status: "stored" | "reused" }> {
    return this.#withImportLock(importId, async () => {
    invariant((await this.#readReceipt(importId)) === undefined, "Uploadsitzung ist bereits endgültig abgeschlossen.");
    const session = await this.#readSession(importId);
    invariant(Array.isArray(session.parts), "Paketmanifest wurde noch nicht hochgeladen.");
    const part = session.parts.find((candidate) => candidate.partId === partId);
    invariant(part !== undefined, "Unbekannte serverseitige Paketteilkennung.");
    invariant(proof.bytes === part.bytes && proof.sha256 === part.sha256, "Signierter Paketteilbeleg stimmt nicht mit dem serverseitigen Inventar überein.");
    const finalPath = await this.#ensurePackageParent(importId, part.packagePath);
    const temporaryPath = join(this.#sessionRoot(importId), `.part-${part.partId}-uploading-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      const observed = await writeStream(temporaryPath, source, part.bytes);
      invariant(observed.bytes === part.bytes && observed.sha256 === part.sha256, "Paketteil stimmt nicht mit Bytezahl oder SHA-256 überein.");
      invariant((await this.#readReceipt(importId)) === undefined, "Uploadsitzung wurde während des Paketteil-Uploads endgültig abgeschlossen.");
      try {
        await link(temporaryPath, finalPath);
        return { status: "stored" };
      } catch (error) {
        if (!(error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const existing = await hashFile(finalPath);
        invariant(existing.bytes === part.bytes && existing.sha256 === part.sha256, "Parallel gespeichertes Paketteil ist beschädigt.");
        return { status: "reused" };
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
    });
  }

  async #cleanupSession(importId: string): Promise<void> {
    const sessionRoot = this.#sessionRoot(importId);
    try {
      const metadata = await lstat(sessionRoot);
      invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Uploadsitzung kann nicht sicher bereinigt werden.");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    await rm(sessionRoot, { recursive: true, force: true });
  }

  async #completeReceipt(receipt: FinalizationReceipt): Promise<InfraPackageQualification & { readonly stagePath: string }> {
    const session: Session = {
      schema: "zugfolge-infra-package-upload-session/v1",
      importId: receipt.importId,
      manifestBytes: receipt.manifestBytes,
      manifestSha256: receipt.manifestSha256,
      packageId: receipt.packageId,
      version: receipt.version,
      parts: receipt.parts,
    };
    const stagePath = join(this.#root, "staged", receipt.stageName);
    let qualification: InfraPackageQualification;
    try {
      qualification = await verifyStagedPackage(stagePath, session, this.#packageVerifier, this.#trustedReleaseKeys);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const packageRoot = join(this.#sessionRoot(receipt.importId), "package");
      const packageMetadata = await lstat(packageRoot);
      invariant(packageMetadata.isDirectory() && !packageMetadata.isSymbolicLink(), "Paketwurzel muss ein reguläres Verzeichnis sein.");
      const parsed = parsePackageManifest(await readFile(join(packageRoot, "manifest.json")));
      invariant(parsed.packageId === session.packageId && parsed.version === session.version, "Finalisierungsbeleg und Paketmanifest weichen ab.");
      const verified = await this.#packageVerifier(packageRoot);
      invariant(verified.packageId === parsed.packageId && verified.version === parsed.version && verified.manifestSha256 === session.manifestSha256, "Game-Paketprüfung und Finalisierungsbeleg weichen voneinander ab.");
      qualification = await qualifyDeliveryPackage(packageRoot, parsed, this.#trustedReleaseKeys, session.manifestSha256);
      invariant(JSON.stringify(qualification) === JSON.stringify(receipt.qualification), "Erneute Paketqualifikation weicht vom Finalisierungsbeleg ab.");
      try {
        await renameAtomic(packageRoot, stagePath);
      } catch (renameError) {
        if (!["EEXIST", "ENOENT", "ENOTEMPTY"].includes(errorCode(renameError))) throw renameError;
        qualification = await verifyStagedPackage(stagePath, session, this.#packageVerifier, this.#trustedReleaseKeys);
      }
    }
    invariant(JSON.stringify(qualification) === JSON.stringify(receipt.qualification), "Geprüftes Stagingziel weicht vom Finalisierungsbeleg ab.");
    await this.#cleanupSession(receipt.importId);
    return { ...qualification, stagePath };
  }

  async finalize(importId: string): Promise<InfraPackageQualification & { readonly stagePath: string }> {
    await this.initialize();
    safeId(importId, "importId");
    return this.#withImportLock(importId, async () => {
      const existingReceipt = await this.#readReceipt(importId);
      if (existingReceipt) return this.#completeReceipt(existingReceipt);

      const sessionRoot = this.#sessionRoot(importId);
      const session = await this.#readSession(importId);
      invariant(session.packageId !== undefined && session.version !== undefined && Array.isArray(session.parts), "Paketmanifest wurde noch nicht vollständig angenommen.");
      const packageRoot = join(sessionRoot, "package");
      const packageMetadata = await lstat(packageRoot);
      invariant(packageMetadata.isDirectory() && !packageMetadata.isSymbolicLink(), "Paketwurzel muss ein reguläres Verzeichnis sein.");
      const parsed = parsePackageManifest(await readFile(join(packageRoot, "manifest.json")));
      invariant(parsed.packageId === session.packageId && parsed.version === session.version, "Persistierte Sitzung und Paketmanifest weichen ab.");
      const verified = await this.#packageVerifier(packageRoot);
      invariant(verified.packageId === parsed.packageId && verified.version === parsed.version && verified.manifestSha256 === session.manifestSha256, "Game-Paketprüfung und Uploadsitzung weichen voneinander ab.");
      const qualification = await qualifyDeliveryPackage(packageRoot, parsed, this.#trustedReleaseKeys, session.manifestSha256);
      const stageName = `${session.packageId}-${session.version}-${session.manifestSha256.slice(0, 16)}`;
      const receipt = await this.#persistReceipt({
        schema: "zugfolge-infra-package-upload-receipt/v1",
        uploadStatus: "closed",
        importId,
        manifestBytes: session.manifestBytes,
        manifestSha256: session.manifestSha256,
        packageId: session.packageId,
        version: session.version,
        parts: session.parts,
        stageName,
        qualification,
      });
      const stagePath = join(this.#root, "staged", stageName);
      let finalQualification = qualification;
      try {
        await renameAtomic(packageRoot, stagePath);
      } catch (error) {
        if (!["EEXIST", "ENOENT", "ENOTEMPTY"].includes(errorCode(error))) throw error;
        finalQualification = await verifyStagedPackage(stagePath, session, this.#packageVerifier, this.#trustedReleaseKeys);
      }
      invariant(JSON.stringify(finalQualification) === JSON.stringify(receipt.qualification), "Stagingziel weicht vom terminalen Finalisierungsbeleg ab.");
      await this.#cleanupSession(importId);
      return { ...finalQualification, stagePath };
    });
  }
}

async function verifyStagedPackage(
  stagePath: string,
  session: Session,
  packageVerifier: InfraPackageVerifier,
  trustedReleaseKeys: Readonly<Record<string, string>>,
): Promise<InfraPackageQualification> {
  const metadata = await lstat(stagePath);
  invariant(metadata.isDirectory() && !metadata.isSymbolicLink(), "Stagingziel ist kein reguläres Paketverzeichnis.");
  const manifestBytes = await readFile(join(stagePath, "manifest.json"));
  invariant(manifestBytes.length === session.manifestBytes && sha256(manifestBytes) === session.manifestSha256, "Stagingziel gehört zu einem anderen Paketmanifest.");
  const parsed = parsePackageManifest(manifestBytes);
  invariant(parsed.packageId === session.packageId && parsed.version === session.version, "Stagingziel gehört zu einem anderen Paket.");
  const verified = await packageVerifier(stagePath);
  invariant(verified.packageId === parsed.packageId && verified.version === parsed.version && verified.manifestSha256 === session.manifestSha256, "Wiederverwendetes Stagingziel besteht die Game-Paketprüfung nicht.");
  return qualifyDeliveryPackage(stagePath, parsed, trustedReleaseKeys, session.manifestSha256);
}

async function readPackagedJson(packageRoot: string, file: PackageFile): Promise<{ readonly value: Record<string, unknown>; readonly bytes: Buffer }> {
  invariant(file.bytes <= MAX_MANIFEST_BYTES, `${file.kind} ist für ein öffentliches JSON-Manifest zu groß.`);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (const part of file.parts) {
    const chunk = await readFile(join(packageRoot, ...part.packagePath.split("/")));
    chunks.push(chunk);
    bytes += chunk.length;
  }
  invariant(bytes === file.bytes, `${file.kind} ist unvollständig.`);
  const buffer = Buffer.concat(chunks, bytes);
  let value: unknown;
  try { value = JSON.parse(buffer.toString("utf8")); } catch { throw new InfraPackageStagingError(`${file.kind} ist kein gültiges JSON.`); }
  return { value: record(value, file.kind), bytes: buffer };
}

async function qualifyDeliveryPackage(
  packageRoot: string,
  parsed: ParsedPackageManifest,
  trustedKeys: Readonly<Record<string, string>>,
  manifestSha256: string,
): Promise<InfraPackageQualification> {
  const deliveryFile = parsed.files.find(({ kind }) => kind === "release-manifest");
  const sourcesFile = parsed.files.find(({ kind }) => kind === "source-manifest");
  const qualityFile = parsed.files.find(({ kind }) => kind === "quality-manifest");
  invariant(deliveryFile !== undefined && sourcesFile !== undefined && qualityFile !== undefined, "Öffentliche Delivery-, Quellen- oder Qualitätsdatei fehlt.");
  const [delivery, sources, quality] = await Promise.all([
    readPackagedJson(packageRoot, deliveryFile), readPackagedJson(packageRoot, sourcesFile), readPackagedJson(packageRoot, qualityFile),
  ]);
  invariant(delivery.value["schema"] === DELIVERY_SCHEMA, "release.json ist kein vollständiger öffentlicher Delivery-Release.");
  const releaseId = safeId(delivery.value["releaseId"], "Delivery releaseId");
  invariant(delivery.value["packageId"] === parsed.packageId && delivery.value["packageVersion"] === parsed.version, "Delivery-Release ist nicht an dieses Paket gebunden.");
  const bindings = record(delivery.value["bindings"], "Delivery bindings");
  invariant(bindings["packageManifestSchema"] === PACKAGE_SCHEMA && bindings["sourcesSha256"] === sha256(sources.bytes) && bindings["qualitySha256"] === sha256(quality.bytes), "Delivery-Release bindet Paketvertrag, Quellen oder Qualität nicht bytegenau.");
  invariant(Array.isArray(delivery.value["artifacts"]), "Delivery-Release besitzt kein vollständiges Artefaktinventar.");
  const deliveredArtifacts = [...(delivery.value["artifacts"] as unknown[])].map((entry) => {
    const artifact = record(entry, "Delivery-Artefakt");
    const id = safeId(artifact["id"], "Delivery-Artefakt-ID");
    const kind = String(artifact["kind"]);
    const installPath = portablePath(artifact["installPath"], `${id}.installPath`);
    invariant(Number.isSafeInteger(artifact["bytes"]) && (artifact["bytes"] as number) > 0 && SHA256.test(String(artifact["sha256"])), `Delivery-Artefakt ${id} hat keinen Byte-SHA-Vertrag.`);
    invariant(Object.keys(artifact).sort().join(",") === "bytes,id,installPath,kind,sha256", `Delivery-Artefakt ${id} besitzt unerwartete Felder.`);
    return { id, kind, installPath, bytes: artifact["bytes"] as number, sha256: String(artifact["sha256"]) };
  }).sort((left, right) => left.id.localeCompare(right.id, "en"));
  const expectedArtifacts = parsed.files
    .filter(({ kind }) => !["release-manifest", "source-manifest"].includes(kind))
    .map(({ id, kind, installPath, bytes, sha256: fileSha256 }) => ({ id, kind, installPath, bytes, sha256: fileSha256 }))
    .sort((left, right) => left.id.localeCompare(right.id, "en"));
  invariant(JSON.stringify(deliveredArtifacts) === JSON.stringify(expectedArtifacts), "Delivery-Release bindet nicht exakt alle ausgelieferten Artefakte.");
  invariant(sources.value["schema"] === SOURCES_SCHEMA && sources.value["releaseId"] === releaseId && Array.isArray(sources.value["sources"]), "sources.json hat keinen gebundenen öffentlichen Quellenvertrag.");
  const sourceEntries = sources.value["sources"] as unknown[];
  invariant(sourceEntries.length > 0 && sourceEntries.every((entry) => {
    const source = record(entry, "Quelle");
    return source["approved"] === true && typeof source["license"] === "string" && typeof source["attribution"] === "string" && source["attribution"].trim() !== "";
  }), "Öffentliche Quellenfreigabe ist unvollständig.");
  invariant(sourceEntries.some((entry) => /openstreetmap/i.test(String(record(entry, "Quelle")["attribution"]))) && sourceEntries.some((entry) => /protomaps/i.test(String(record(entry, "Quelle")["attribution"]))), "Basemap-Attributionen für OpenStreetMap und Protomaps fehlen.");
  invariant(quality.value["schema"] === QUALITY_SCHEMA && quality.value["releaseId"] === releaseId, "quality.json ist nicht an den Delivery-Release gebunden.");
  const policy = record(quality.value["policy"], "Qualitätspolicy");
  const summary = record(quality.value["summary"], "Qualitätszusammenfassung");
  invariant(
    policy["classAFromSingleSourceOrAutomatedInference"] === false &&
      policy["nonPublicSourceRawDataShipped"] === false &&
      !("internalStationPlanRawDataShipped" in policy),
    "Qualitätspolicy verletzt das öffentliche Sicherheitsmodell.",
  );
  invariant(summary["visibleLayers"] === 10 && typeof policy["classC"] === "string" && /not orderable/i.test(policy["classC"]), "Klasse C ist nicht ausdrücklich sichtbar und unbestellbar.");
  const gates = record(delivery.value["approvalGates"], "Delivery approvalGates");
  invariant(record(gates["rights"], "Rechte-Gate")["status"] === "passed" && record(gates["quality"], "Qualitäts-Gate")["status"] === "passed", "Rechte- oder Qualitätsgate ist nicht bestanden.");
  const signatureGate = record(gates["signature"], "Signatur-Gate");
  if (signatureGate["status"] === "missing") {
    invariant(
      delivery.value["signature"] === null && delivery.value["releaseHash"] === undefined,
      "Unsignierter Delivery-Release darf keine Signatur oder Hashfreigabe behaupten.",
    );
    return {
      packageId: parsed.packageId,
      version: parsed.version,
      manifestSha256,
      deliveryReleaseId: releaseId,
      signatureStatus: "missing",
      activationEligible: false,
    };
  }
  invariant(signatureGate["status"] === "passed", "Delivery-Signaturgate ist weder bestanden noch explizit fehlend.");
  const signature = record(delivery.value["signature"], "Delivery-Signatur");
  const keyId = safeId(signature["keyId"], "Delivery-Signaturschlüssel");
  invariant(
    signature["algorithm"] === "Ed25519"
      && signatureGate["algorithm"] === "Ed25519"
      && signatureGate["keyId"] === keyId,
    "Delivery-Signatur und Freigabegate besitzen keine gemeinsame Ed25519-Bindung.",
  );
  invariant(
    Object.keys(signature).sort().join(",") === "algorithm,keyId,valueBase64"
      && Object.keys(signatureGate).sort().join(",") === "algorithm,keyId,status",
    "Delivery-Signaturvertrag besitzt unerwartete Felder.",
  );
  const releaseHash = String(delivery.value["releaseHash"] ?? "");
  invariant(SHA256.test(releaseHash), "Delivery-Release besitzt keinen gültigen Releasehash.");
  const signingPayload = { ...delivery.value };
  delete signingPayload["releaseHash"];
  delete signingPayload["signature"];
  invariant(releaseHash === sha256(canonicalManifest(signingPayload)), "Delivery-Releasehash bindet nicht den kanonischen Inhalt.");
  const signatureBase64 = String(signature["valueBase64"] ?? "");
  invariant(/^[A-Za-z0-9+/]{86}==$/.test(signatureBase64), "Delivery-Signatur besitzt keine kanonische Ed25519-Kodierung.");
  const signatureBytes = Buffer.from(signatureBase64, "base64");
  const trustedKeyPem = trustedKeys[keyId];
  invariant(typeof trustedKeyPem === "string" && trustedKeyPem.trim() !== "", `Delivery-Signaturschlüssel '${keyId}' ist nicht vertrauenswürdig.`);
  let publicKey;
  try {
    publicKey = createPublicKey(trustedKeyPem);
  } catch {
    throw new InfraPackageStagingError(`Delivery-Signaturschlüssel '${keyId}' ist ungültig.`);
  }
  invariant(
    publicKey.asymmetricKeyType === "ed25519"
      && signatureBytes.length === 64
      && verifyEd25519(null, Buffer.from(releaseHash, "hex"), publicKey, signatureBytes),
    "Delivery-Release besitzt keine gültige vertrauenswürdige Ed25519-Signatur.",
  );
  return {
    packageId: parsed.packageId,
    version: parsed.version,
    manifestSha256,
    deliveryReleaseId: releaseId,
    signatureStatus: "verified",
    activationEligible: true,
  };
}

export interface InfraUploadSigningKey {
  readonly id: string;
  readonly secret: string;
}

export function infraUploadSignature(input: {
  readonly key: InfraUploadSigningKey;
  readonly timestamp: string;
  readonly method: string;
  readonly pathname: string;
  readonly contentBytes: number;
  readonly contentSha256: string;
}): string {
  invariant(Number.isSafeInteger(input.contentBytes) && input.contentBytes >= 0 && SHA256.test(input.contentSha256), "Upload-Signaturmetadaten sind ungültig.");
  return createHmac("sha256", input.key.secret)
    .update(`${input.timestamp}\n${input.method.toUpperCase()}\n${input.pathname}\n${input.contentBytes}\n${input.contentSha256}`, "utf8")
    .digest("hex");
}

export function verifyInfraUploadSignature(input: {
  readonly keyId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly method: string;
  readonly pathname: string;
  readonly contentBytes: number;
  readonly contentSha256: string;
  readonly keys: readonly InfraUploadSigningKey[];
  readonly now?: Date;
}): void {
  const key = input.keys.find(({ id }) => id === input.keyId);
  invariant(key !== undefined, "Unbekannter Infra-Upload-Schlüssel.");
  const issued = new Date(input.timestamp);
  const now = input.now ?? new Date();
  invariant(!Number.isNaN(issued.getTime()) && Math.abs(now.getTime() - issued.getTime()) <= 5 * 60_000, "Infra-Upload-Signatur ist abgelaufen.");
  const expected = Buffer.from(infraUploadSignature({ ...input, key }), "hex");
  const supplied = Buffer.from(input.signature, "hex");
  invariant(expected.length === supplied.length && timingSafeEqual(expected, supplied), "Infra-Upload-Signatur ist ungültig.");
}

export const INFRA_PACKAGE_PART_BYTES = PART_BYTES;
