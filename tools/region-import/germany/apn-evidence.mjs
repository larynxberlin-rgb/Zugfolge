import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const APN_CAPTURE_SCHEMA = "zugfolge-internal-apn-capture/v1";
export const APN_ANALYSIS_SCHEMA = "zugfolge-internal-apn-analysis/v1";
export const APN_RECEIPT_DRAFT_SCHEMA = "zugfolge-internal-validation-receipt-draft/v1";
export const NORMALIZED_OPERATING_POINTS_SCHEMA = "zugfolge-normalized-infrago-operating-points/v1";
export const INFRAGO_OPERATING_PLACE_SCHEMA = "zugfolge-infrago-operating-place/v1";
export const APN_CAPTURE_VERSION = "apn-capture/1";
export const APN_ANALYSIS_VERSION = "apn-pdf-structure-analysis/1";
export const DEFAULT_APN_BASE_URL = "https://trassenfinder.de/apn/";

export const DEFAULT_APN_POLICY = Object.freeze({
  concurrency: 1,
  delayMs: 1_000,
  maxAttempts: 3,
  initialBackoffMs: 1_000,
  maximumBackoffMs: 15_000,
  requestTimeoutMs: 30_000,
  maxBytes: 64 * 1024 * 1024,
  userAgent: "Zugfolge-InfraRelease-Research/1.0 (+https://github.com/larynxberlin-rgb/Zugfolge)",
});

const CAPTURE_INDEX_FILE = "capture-index.json";
const ANALYSIS_INDEX_FILE = "analysis-index.json";
const PDF_DIRECTORY = "pdf";
const SHA256 = /^[a-f0-9]{64}$/;
const QUALITY_DIMENSIONS = new Set([
  "geometry",
  "topology",
  "speed",
  "electrification",
  "gradient",
  "trainProtection",
  "signalling",
  "conflictModel",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  const input = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : typeof value === "string" ? value : canonical(value);
  return createHash("sha256").update(input).digest("hex");
}

function requiredText(value, name) {
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value.trim();
}

function safeInteger(value, name, minimum, maximum) {
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${name} muss zwischen ${minimum} und ${maximum} liegen.`);
  return value;
}

function pathIsWithin(root, candidate) {
  const remainder = relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function normalizeForPathComparison(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function childPath(root, relativePath) {
  invariant(typeof relativePath === "string" && relativePath !== "" && !isAbsolute(relativePath), "Interner Evidenzpfad muss relativ sein.");
  const candidate = resolve(root, relativePath);
  invariant(pathIsWithin(root, candidate) && candidate !== root, `Interner Evidenzpfad verlässt die Evidenzwurzel: ${relativePath}`);
  return candidate;
}

/**
 * The evidence root must not be the repository or a descendant of it. The
 * lexical check runs before mkdir; realpath checks also catch existing links.
 */
export async function prepareExternalEvidenceRoot({ evidenceRoot, repositoryRoot }) {
  invariant(typeof evidenceRoot === "string" && isAbsolute(evidenceRoot), "Die APN-Evidenzwurzel muss als absoluter Pfad angegeben werden.");
  invariant(typeof repositoryRoot === "string" && isAbsolute(repositoryRoot), "Die Repositorywurzel muss als absoluter Pfad angegeben werden.");
  const lexicalEvidence = resolve(evidenceRoot);
  const lexicalRepository = resolve(repositoryRoot);
  invariant(!pathIsWithin(normalizeForPathComparison(lexicalRepository), normalizeForPathComparison(lexicalEvidence)), "APN-Evidenz darf nicht im Repository liegen.");
  await mkdir(lexicalEvidence, { recursive: true });
  const [realEvidence, realRepository] = await Promise.all([realpath(lexicalEvidence), realpath(lexicalRepository)]);
  invariant(!pathIsWithin(normalizeForPathComparison(realRepository), normalizeForPathComparison(realEvidence)), "APN-Evidenzwurzel verweist in das Repository.");
  return realEvidence;
}

export function normalizeRl100(value) {
  const normalized = requiredText(value, "RL100").normalize("NFKC").toUpperCase();
  invariant(normalized.length >= 2 && normalized.length <= 10 && /^[A-Z0-9]+(?: [A-Z0-9]+)*$/.test(normalized), `Ungültige RL100-Kennung: ${value}`);
  return normalized;
}

export function normalizedOperatingPoints(catalog) {
  let rows;
  if (Array.isArray(catalog)) {
    for (const [index, row] of catalog.entries()) {
      invariant(row?.schema === INFRAGO_OPERATING_PLACE_SCHEMA, `Betriebsstellen-Datensatz ${index} muss ${INFRAGO_OPERATING_PLACE_SCHEMA} verwenden.`);
    }
    rows = catalog.map((row) => ({ objectId: row.operatingPlaceId, rl100: row.rl100 }));
  } else {
    invariant(catalog?.schema === NORMALIZED_OPERATING_POINTS_SCHEMA, `Betriebsstellenkatalog muss ${NORMALIZED_OPERATING_POINTS_SCHEMA} verwenden.`);
    invariant(Array.isArray(catalog.operatingPoints), "Normalisierter Betriebsstellenkatalog enthält keine operatingPoints.");
    rows = catalog.operatingPoints;
  }
  const rl100Values = new Set();
  const objectIds = new Set();
  const result = rows.map((row, index) => {
    invariant(row !== null && typeof row === "object" && !Array.isArray(row), `operatingPoints[${index}] ist kein Objekt.`);
    const targetObjectId = requiredText(row.objectId ?? row.stationId, `operatingPoints[${index}].objectId`);
    const rl100 = normalizeRl100(row.rl100);
    invariant(!objectIds.has(targetObjectId), `Doppelte Betriebsstellen-ID ${targetObjectId}.`);
    invariant(!rl100Values.has(rl100), `Doppelte RL100-Kennung ${rl100}.`);
    objectIds.add(targetObjectId);
    rl100Values.add(rl100);
    const stationKey = sha256({ namespace: "infrago-operating-point-rl100", rl100 }).slice(0, 24);
    return { targetObjectId, rl100, stationKey };
  });
  return result.sort((left, right) => compareText(left.rl100, right.rl100) || compareText(left.targetObjectId, right.targetObjectId));
}

/** Parses the adapter's RFC 7464-style JSON sequence or a programmatic wrapper. */
export function parseNormalizedOperatingPointCatalog(text) {
  invariant(typeof text === "string" && text.trim() !== "", "Normalisierter Betriebsstellenkatalog ist leer.");
  const trimmed = text.trim();
  if (!trimmed.startsWith("\x1e")) return JSON.parse(trimmed);
  const records = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === "") continue;
    invariant(line.startsWith("\x1e"), `JSON-Sequenzzeile ${index + 1} besitzt keinen Record Separator.`);
    records.push(JSON.parse(line.slice(1)));
  }
  invariant(records.length > 0, "Normalisierte Betriebsstellen-JSON-Sequenz ist leer.");
  return records;
}

export function buildApnDownloadUrl(baseUrl, rl100) {
  const parsed = new URL(requiredText(baseUrl, "APN-Basisadresse"));
  invariant(["http:", "https:"].includes(parsed.protocol), "APN-Basisadresse muss HTTP oder HTTPS verwenden.");
  invariant(parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "", "APN-Basisadresse darf keine Zugangsdaten, Query oder Fragment enthalten.");
  const prefix = parsed.href.replace(/\/+$/, "");
  return `${prefix}/${encodeURIComponent(normalizeRl100(rl100))}`;
}

function isLoopbackUrl(value) {
  const host = new URL(value).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function normalizeApnPolicy(policy = {}) {
  const result = { ...DEFAULT_APN_POLICY, ...policy };
  safeInteger(result.concurrency, "concurrency", 1, 2);
  safeInteger(result.delayMs, "delayMs", 0, 60_000);
  safeInteger(result.maxAttempts, "maxAttempts", 1, 6);
  safeInteger(result.initialBackoffMs, "initialBackoffMs", 0, 60_000);
  safeInteger(result.maximumBackoffMs, "maximumBackoffMs", result.initialBackoffMs, 300_000);
  safeInteger(result.requestTimeoutMs, "requestTimeoutMs", 100, 300_000);
  safeInteger(result.maxBytes, "maxBytes", 1, 256 * 1024 * 1024);
  requiredText(result.userAgent, "userAgent");
  invariant(result.userAgent.length <= 300 && !/[\r\n]/.test(result.userAgent), "userAgent ist ungültig.");
  return Object.freeze(result);
}

function isoTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  invariant(!Number.isNaN(date.valueOf()), "Ungültiger Capture-Zeitpunkt.");
  return date.toISOString();
}

async function atomicWrite(path, bytes) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.${sha256(`${path}:${Date.now()}:${Math.random()}`).slice(0, 12)}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await renameWithTransientWindowsRetry(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

const TRANSIENT_WINDOWS_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Antivirus and short-lived readers can deny an otherwise atomic replacement
 * on Windows. Retry only the three documented transient sharing/permission
 * errors for a tightly bounded interval; all other errors remain fail-fast.
 */
export async function renameWithTransientWindowsRetry(source, destination, {
  renameFile = rename,
  wait = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds)),
  maximumAttempts = 10,
} = {}) {
  safeInteger(maximumAttempts, "maximumAttempts", 1, 20);
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await renameFile(source, destination);
      return;
    } catch (error) {
      if (!TRANSIENT_WINDOWS_RENAME_ERRORS.has(error?.code) || attempt === maximumAttempts) throw error;
      await wait(Math.min(10 * (2 ** (attempt - 1)), 250));
    }
  }
}

async function atomicWriteJson(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readCaptureIndex(evidenceRoot) {
  const path = childPath(evidenceRoot, CAPTURE_INDEX_FILE);
  if (!existsSync(path)) return { schema: APN_CAPTURE_SCHEMA, captureVersion: APN_CAPTURE_VERSION, entries: [] };
  const value = JSON.parse(await readFile(path, "utf8"));
  invariant(value?.schema === APN_CAPTURE_SCHEMA && value.captureVersion === APN_CAPTURE_VERSION, "Unbekannter APN-Capture-Index.");
  invariant(Array.isArray(value.entries), "APN-Capture-Index enthält keine Einträge.");
  for (const entry of value.entries) {
    invariant(typeof entry.stationKey === "string" && /^[a-f0-9]{24}$/.test(entry.stationKey), "Capture-Eintrag ohne gültigen stationKey.");
    invariant(["pending", "available", "unavailable"].includes(entry.status), `Ungültiger Capture-Status ${entry.status}.`);
  }
  return value;
}

function captureIndex(entries) {
  return {
    schema: APN_CAPTURE_SCHEMA,
    captureVersion: APN_CAPTURE_VERSION,
    entries: [...entries].sort((left, right) => compareText(left.stationKey, right.stationKey)),
  };
}

function entryBase(point, sourceUrl, attemptCount) {
  return {
    stationKey: point.stationKey,
    targetObjectId: point.targetObjectId,
    rl100: point.rl100,
    sourceUrl,
    attemptCount,
  };
}

function hasPdfMagic(bytes) {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

async function cachedEntryIsValid(evidenceRoot, entry) {
  if (entry.status !== "available" || !Number.isSafeInteger(entry.bytes) || !SHA256.test(entry.documentSha256 ?? "")) return false;
  try {
    const path = childPath(evidenceRoot, entry.storedRelativePath);
    const info = await stat(path);
    if (!info.isFile() || info.size !== entry.bytes) return false;
    const bytes = await readFile(path);
    return hasPdfMagic(bytes) && sha256(bytes) === entry.documentSha256;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

class CaptureFailure extends Error {
  constructor(reason, { retryable = false, httpStatus = null, retryAfterMs = 0 } = {}) {
    super(reason);
    this.reason = reason;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(response) {
  const raw = response.headers.get("retry-after");
  if (raw === null || !/^\d+$/.test(raw.trim())) return 0;
  return Math.min(Number.parseInt(raw, 10) * 1_000, 300_000);
}

function exponentialBackoffMs(attempt, policy, minimum = 0) {
  const value = policy.initialBackoffMs * (2 ** Math.max(0, attempt - 1));
  return Math.max(minimum, Math.min(value, policy.maximumBackoffMs));
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already closed. There is nothing left to preserve.
  }
}

async function responseBytes(response, maxBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength.trim()) && Number.parseInt(contentLength, 10) > maxBytes) {
    await cancelBody(response);
    throw new CaptureFailure("size-limit", { httpStatus: response.status });
  }
  invariant(response.body !== null, "HTTP-Antwort enthält keinen Body.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CaptureFailure("size-limit", { httpStatus: response.status });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function fetchAndInspect(fetchImpl, url, policy) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), policy.requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "application/pdf",
        "User-Agent": policy.userAgent,
      },
      signal: controller.signal,
    });
    return await inspectResponse(response, policy);
  } finally {
    clearTimeout(timeout);
  }
}

async function inspectResponse(response, policy) {
  if (!response.ok) {
    await cancelBody(response);
    if ([404, 410].includes(response.status)) throw new CaptureFailure("not-found", { httpStatus: response.status });
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new CaptureFailure(`http-${response.status}`, {
      retryable,
      httpStatus: response.status,
      retryAfterMs: retryAfterMs(response),
    });
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (contentType !== "application/pdf") {
    await cancelBody(response);
    throw new CaptureFailure("invalid-content-type", { retryable: true, httpStatus: response.status });
  }
  const bytes = await responseBytes(response, policy.maxBytes);
  if (!hasPdfMagic(bytes)) throw new CaptureFailure("invalid-pdf-magic", { retryable: true, httpStatus: response.status });
  return { bytes, contentType };
}

function startGate({ delayMs, sleep, nowMs }) {
  let tail = Promise.resolve();
  let nextStartMs = 0;
  return async () => {
    const scheduled = tail.then(async () => {
      const current = nowMs();
      const waitMs = Math.max(0, nextStartMs - current);
      if (waitMs > 0) await sleep(waitMs);
      nextStartMs = Math.max(nextStartMs, nowMs()) + delayMs;
    });
    tail = scheduled.catch(() => undefined);
    return scheduled;
  };
}

async function capturePoint({
  point,
  previous,
  evidenceRoot,
  baseUrl,
  policy,
  fetchImpl,
  waitForRequestSlot,
  sleep,
  now,
}) {
  const sourceUrl = buildApnDownloadUrl(baseUrl, point.rl100);
  const priorAttempts = Number.isSafeInteger(previous?.attemptCount) ? previous.attemptCount : 0;
  let failure = new CaptureFailure("unknown-error", { retryable: true });
  let attemptsThisRun = 0;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    attemptsThisRun += 1;
    try {
      await waitForRequestSlot();
      const { bytes, contentType } = await fetchAndInspect(fetchImpl, sourceUrl, policy);
      const storedRelativePath = `${PDF_DIRECTORY}/${point.stationKey}.pdf`;
      await atomicWrite(childPath(evidenceRoot, storedRelativePath), bytes);
      return {
        ...entryBase(point, sourceUrl, priorAttempts + attemptsThisRun),
        status: "available",
        bytes: bytes.length,
        documentSha256: sha256(bytes),
        contentType,
        storedRelativePath,
        lastCheckedAt: isoTimestamp(now),
      };
    } catch (error) {
      failure = error instanceof CaptureFailure
        ? error
        : new CaptureFailure(error?.name === "AbortError" ? "timeout" : "network-error", { retryable: true });
      if (!failure.retryable || attempt === policy.maxAttempts) break;
      await sleep(exponentialBackoffMs(attempt, policy, failure.retryAfterMs));
    }
  }
  return {
    ...entryBase(point, sourceUrl, priorAttempts + attemptsThisRun),
    status: "unavailable",
    reason: failure.reason,
    httpStatus: failure.httpStatus,
    retryable: failure.retryable,
    lastCheckedAt: isoTimestamp(now),
  };
}

/**
 * Captures all known plans into an external, resumable evidence store. It never
 * writes source bytes or source identifiers into the repository.
 */
export async function captureApnEvidence({
  catalog,
  evidenceRoot,
  repositoryRoot,
  baseUrl = DEFAULT_APN_BASE_URL,
  policy: rawPolicy = {},
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
  now = () => new Date(),
  nowMs = () => Date.now(),
  retryUnavailable = false,
} = {}) {
  invariant(typeof fetchImpl === "function", "Keine HTTP-Implementierung verfügbar.");
  const policy = normalizeApnPolicy(rawPolicy);
  invariant(isLoopbackUrl(baseUrl) || policy.delayMs >= 250, "Externe APN-Abrufe benötigen mindestens 250 ms Abstand.");
  const root = await prepareExternalEvidenceRoot({ evidenceRoot, repositoryRoot });
  await mkdir(childPath(root, PDF_DIRECTORY), { recursive: true });
  const points = normalizedOperatingPoints(catalog);
  const previousIndex = await readCaptureIndex(root);
  const previousByKey = new Map(previousIndex.entries.map((entry) => [entry.stationKey, entry]));
  const entriesByKey = new Map();
  const counters = { downloaded: 0, reused: 0, skippedUnavailable: 0 };
  for (const point of points) {
    const sourceUrl = buildApnDownloadUrl(baseUrl, point.rl100);
    const previous = previousByKey.get(point.stationKey);
    entriesByKey.set(point.stationKey, previous ?? {
      ...entryBase(point, sourceUrl, 0),
      status: "pending",
    });
  }

  const indexPath = childPath(root, CAPTURE_INDEX_FILE);
  await atomicWriteJson(indexPath, captureIndex(entriesByKey.values()));
  let persistTail = Promise.resolve();
  const persist = () => {
    const snapshot = captureIndex(entriesByKey.values());
    persistTail = persistTail.then(() => atomicWriteJson(indexPath, snapshot));
    return persistTail;
  };
  const waitForRequestSlot = startGate({ delayMs: policy.delayMs, sleep, nowMs });
  let cursor = 0;
  const worker = async () => {
    while (cursor < points.length) {
      const point = points[cursor];
      cursor += 1;
      const sourceUrl = buildApnDownloadUrl(baseUrl, point.rl100);
      const previous = previousByKey.get(point.stationKey);
      if (previous?.status === "available" && previous.sourceUrl === sourceUrl && await cachedEntryIsValid(root, previous)) {
        entriesByKey.set(point.stationKey, {
          ...previous,
          targetObjectId: point.targetObjectId,
          rl100: point.rl100,
        });
        counters.reused += 1;
        continue;
      }
      if (previous?.status === "unavailable" && previous.sourceUrl === sourceUrl && previous.retryable === false && !retryUnavailable) {
        entriesByKey.set(point.stationKey, {
          ...previous,
          targetObjectId: point.targetObjectId,
          rl100: point.rl100,
        });
        counters.skippedUnavailable += 1;
        continue;
      }
      const captured = await capturePoint({
        point,
        previous,
        evidenceRoot: root,
        baseUrl,
        policy,
        fetchImpl,
        waitForRequestSlot,
        sleep,
        now,
      });
      entriesByKey.set(point.stationKey, captured);
      if (captured.status === "available") counters.downloaded += 1;
      await persist();
    }
  };
  await Promise.all(Array.from({ length: policy.concurrency }, () => worker()));
  await persistTail;
  const index = captureIndex(entriesByKey.values());
  const statusCounts = { available: 0, unavailable: 0, pending: 0 };
  for (const entry of index.entries) statusCounts[entry.status] += 1;
  return {
    index,
    summary: {
      operatingPointCount: points.length,
      ...statusCounts,
      ...counters,
    },
  };
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function decodePdfTextBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let result = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) result += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    return result;
  }
  return bytes.toString("latin1");
}

function decodePdfLiteral(value) {
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      bytes.push(value.charCodeAt(index) & 0xff);
      continue;
    }
    index += 1;
    if (index >= value.length) break;
    const escaped = value[index];
    const simple = { n: 0x0a, r: 0x0d, t: 0x09, b: 0x08, f: 0x0c, "(": 0x28, ")": 0x29, "\\": 0x5c };
    if (Object.hasOwn(simple, escaped)) {
      bytes.push(simple[escaped]);
      continue;
    }
    if (escaped === "\r" || escaped === "\n") {
      if (escaped === "\r" && value[index + 1] === "\n") index += 1;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? "")) {
        index += 1;
        octal += value[index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    bytes.push(escaped.charCodeAt(0) & 0xff);
  }
  return decodePdfTextBytes(Buffer.from(bytes)).slice(0, 2_048);
}

function metadataValue(source, name) {
  const literal = source.match(new RegExp(`/${name}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`));
  if (literal !== null) return decodePdfLiteral(literal[1]);
  const hexadecimal = source.match(new RegExp(`/${name}\\s*<([0-9A-Fa-f\\s]+)>`));
  if (hexadecimal === null) return null;
  const compact = hexadecimal[1].replace(/\s/g, "");
  if (compact.length % 2 !== 0) return null;
  return decodePdfTextBytes(Buffer.from(compact, "hex")).slice(0, 2_048);
}

function pdfStreams(bytes, maximumDecodedBytes = 128 * 1024 * 1024) {
  const source = bytes.toString("latin1");
  const streamPattern = /\bstream(?:\r\n|\n|\r)/g;
  const decoded = [];
  let totalDecodedBytes = 0;
  let flateStreamCount = 0;
  let unsupportedFilterStreamCount = 0;
  let decodeErrorCount = 0;
  for (let match = streamPattern.exec(source); match !== null; match = streamPattern.exec(source)) {
    const dataStart = match.index + match[0].length;
    const end = source.indexOf("endstream", dataStart);
    if (end < 0) {
      decodeErrorCount += 1;
      break;
    }
    let dataEnd = end;
    if (bytes[dataEnd - 1] === 0x0a) dataEnd -= 1;
    if (bytes[dataEnd - 1] === 0x0d) dataEnd -= 1;
    const dictionaryEnd = source.lastIndexOf(">>", match.index);
    const dictionaryStart = dictionaryEnd < 0 ? -1 : source.lastIndexOf("<<", dictionaryEnd);
    const dictionary = dictionaryStart >= 0 && match.index - dictionaryStart <= 16_384
      ? source.slice(dictionaryStart, dictionaryEnd + 2)
      : "";
    const filters = [...dictionary.matchAll(/\/(FlateDecode|ASCIIHexDecode|ASCII85Decode|LZWDecode|RunLengthDecode|CCITTFaxDecode|JBIG2Decode|DCTDecode|JPXDecode)\b/g)].map((filter) => filter[1]);
    let content = bytes.subarray(dataStart, Math.max(dataStart, dataEnd));
    if (filters.length === 0) {
      // Unfiltered content streams are already usable for structural metrics.
    } else if (filters.length === 1 && filters[0] === "FlateDecode") {
      flateStreamCount += 1;
      try {
        content = inflateSync(content, { maxOutputLength: maximumDecodedBytes - totalDecodedBytes });
      } catch {
        decodeErrorCount += 1;
        streamPattern.lastIndex = end + "endstream".length;
        continue;
      }
    } else {
      unsupportedFilterStreamCount += 1;
      streamPattern.lastIndex = end + "endstream".length;
      continue;
    }
    if (totalDecodedBytes + content.length > maximumDecodedBytes) {
      decodeErrorCount += 1;
      break;
    }
    totalDecodedBytes += content.length;
    decoded.push(content);
    streamPattern.lastIndex = end + "endstream".length;
  }
  return {
    decoded,
    metrics: {
      streamCount: countMatches(source, /\bstream(?:\r\n|\n|\r)/g),
      decodedStreamCount: decoded.length,
      decodedBytes: totalDecodedBytes,
      flateStreamCount,
      unsupportedFilterStreamCount,
      decodeErrorCount,
    },
  };
}

function contentStatistics(buffers) {
  const source = buffers.map((buffer) => buffer.toString("latin1")).join("\n");
  let literalStringCount = 0;
  let literalStringBytes = 0;
  let maximumLiteralStringBytes = 0;
  let sanitized = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "%") {
      while (index < source.length && source[index] !== "\r" && source[index] !== "\n") index += 1;
      sanitized += " ";
      continue;
    }
    if (character === "(") {
      let depth = 1;
      let length = 0;
      literalStringCount += 1;
      index += 1;
      while (index < source.length && depth > 0) {
        if (source[index] === "\\") {
          index += 2;
          length += 1;
          continue;
        }
        if (source[index] === "(") depth += 1;
        if (source[index] === ")") depth -= 1;
        if (depth > 0) length += 1;
        index += 1;
      }
      index -= 1;
      literalStringBytes += length;
      maximumLiteralStringBytes = Math.max(maximumLiteralStringBytes, length);
      sanitized += " ";
      continue;
    }
    if (character === "<" && source[index + 1] !== "<") {
      while (index < source.length && source[index] !== ">") index += 1;
      sanitized += " ";
      continue;
    }
    sanitized += character;
  }
  const tokens = sanitized.match(/[^\x00-\x20()[\]<>\/{%}]+/g) ?? [];
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const operator = (name) => counts.get(name) ?? 0;
  const vectorOperators = ["m", "l", "c", "v", "y", "h", "re", "S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n", "W", "W*"];
  const vectorOperatorCounts = Object.fromEntries(vectorOperators.map((name) => [name, operator(name)]));
  const pathConstructionOperatorCount = ["m", "l", "c", "v", "y", "h", "re"].reduce((sum, name) => sum + vectorOperatorCounts[name], 0);
  const pathPaintingOperatorCount = ["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"].reduce((sum, name) => sum + vectorOperatorCounts[name], 0);
  return {
    text: {
      beginTextObjectCount: operator("BT"),
      endTextObjectCount: operator("ET"),
      showTextOperatorCount: operator("Tj") + operator("TJ"),
      fontSelectionOperatorCount: operator("Tf"),
      literalStringCount,
      literalStringBytes,
      maximumLiteralStringBytes,
    },
    vector: {
      operatorCounts: vectorOperatorCounts,
      pathConstructionOperatorCount,
      pathPaintingOperatorCount,
      rectangleOperatorCount: operator("re"),
      clippingOperatorCount: operator("W") + operator("W*"),
    },
  };
}

/** Deterministic, dependency-free structural analysis; it performs no OCR. */
export function analyzePdfBytes(input) {
  const bytes = Buffer.from(input);
  invariant(hasPdfMagic(bytes), "Analyse erwartet PDF-Magic am Dateianfang.");
  const source = bytes.toString("latin1");
  const versionMatch = source.slice(0, 16).match(/^%PDF-(\d+\.\d+)/);
  invariant(versionMatch !== null, "PDF-Version ist nicht lesbar.");
  const streams = pdfStreams(bytes);
  const content = contentStatistics(streams.decoded);
  const analysis = {
    schema: "zugfolge-internal-pdf-structure/v1",
    analysisVersion: APN_ANALYSIS_VERSION,
    document: {
      bytes: bytes.length,
      documentSha256: sha256(bytes),
    },
    metadata: {
      pdfVersion: versionMatch[1],
      pageObjectCount: countMatches(source, /\/Type\s*\/Page\b/g),
      indirectObjectCount: countMatches(source, /(?:^|[\r\n])\d+\s+\d+\s+obj\b/g),
      xrefTableCount: countMatches(source, /(?:^|[\r\n])xref(?:[\r\n])/g),
      crossReferenceStreamCount: countMatches(source, /\/Type\s*\/XRef\b/g),
      incrementalUpdateCount: Math.max(0, countMatches(source, /\bstartxref\b/g) - 1),
      encrypted: /\/Encrypt\b/.test(source),
      linearized: /\/Linearized\b/.test(source.slice(0, 4_096)),
      info: {
        title: metadataValue(source, "Title"),
        author: metadataValue(source, "Author"),
        subject: metadataValue(source, "Subject"),
        creator: metadataValue(source, "Creator"),
        producer: metadataValue(source, "Producer"),
        creationDate: metadataValue(source, "CreationDate"),
        modificationDate: metadataValue(source, "ModDate"),
      },
    },
    streams: streams.metrics,
    text: {
      ...content.text,
      fontResourceCount: countMatches(source, /\/Font\b/g),
    },
    vector: {
      ...content.vector,
      imageXObjectCount: countMatches(source, /\/Subtype\s*\/Image\b/g),
      formXObjectCount: countMatches(source, /\/Subtype\s*\/Form\b/g),
    },
  };
  return { ...analysis, analysisSha256: sha256(analysis) };
}

export function createValidationReceiptDraft({ entry, analysis }) {
  invariant(entry?.status === "available" && SHA256.test(entry.documentSha256 ?? ""), "Belegentwurf benötigt einen verfügbaren Capture-Eintrag.");
  invariant(analysis?.analysisVersion === APN_ANALYSIS_VERSION && SHA256.test(analysis.analysisSha256 ?? ""), "Belegentwurf benötigt eine gültige PDF-Analyse.");
  invariant(analysis.document.documentSha256 === entry.documentSha256, "Capture und Analyse beziehen sich auf unterschiedliche Bytes.");
  const candidateDimensions = [];
  if (analysis.vector.pathConstructionOperatorCount > 0) candidateDimensions.push("topology");
  if (analysis.text.showTextOperatorCount > 0) candidateDimensions.push("signalling");
  const identity = {
    targetObjectId: entry.targetObjectId,
    documentSha256: entry.documentSha256,
    analysisSha256: analysis.analysisSha256,
    analysisVersion: APN_ANALYSIS_VERSION,
  };
  return {
    schema: APN_RECEIPT_DRAFT_SCHEMA,
    receiptId: `station-plan-draft-${sha256(identity).slice(0, 24)}`,
    targetObjectId: entry.targetObjectId,
    status: "draft",
    classAEligible: false,
    validatedDimensions: [],
    candidateDimensions,
    sourceBindingRequired: true,
    internalEvidence: {
      stationKey: entry.stationKey,
      documentSha256: entry.documentSha256,
      analysisSha256: analysis.analysisSha256,
    },
    review: {
      required: true,
      reasons: [
        "semantic-extraction-required",
        "edge-or-way-binding-required",
        "independent-evidence-required-for-class-a",
      ],
    },
  };
}

export async function analyzeCapturedApnEvidence({ evidenceRoot, repositoryRoot } = {}) {
  const root = await prepareExternalEvidenceRoot({ evidenceRoot, repositoryRoot });
  const capture = await readCaptureIndex(root);
  const records = [];
  const unavailable = [];
  for (const entry of [...capture.entries].sort((left, right) => compareText(left.stationKey, right.stationKey))) {
    if (entry.status === "unavailable") {
      unavailable.push({
        stationKey: entry.stationKey,
        targetObjectId: entry.targetObjectId,
        rl100: entry.rl100,
        reason: entry.reason,
        httpStatus: entry.httpStatus,
      });
      continue;
    }
    if (entry.status !== "available") continue;
    invariant(await cachedEntryIsValid(root, entry), `Capture-Datei ${entry.stationKey} ist nicht mehr byteidentisch.`);
    const bytes = await readFile(childPath(root, entry.storedRelativePath));
    const analysis = analyzePdfBytes(bytes);
    records.push({
      stationKey: entry.stationKey,
      targetObjectId: entry.targetObjectId,
      rl100: entry.rl100,
      documentSha256: entry.documentSha256,
      analysis,
      receiptDraft: createValidationReceiptDraft({ entry, analysis }),
    });
  }
  const ledger = {
    schema: APN_ANALYSIS_SCHEMA,
    analysisVersion: APN_ANALYSIS_VERSION,
    records,
    unavailable,
  };
  const index = { ...ledger, ledgerSha256: sha256(ledger) };
  await atomicWriteJson(childPath(root, ANALYSIS_INDEX_FILE), index);
  return {
    index,
    summary: {
      analyzed: records.length,
      unavailable: unavailable.length,
      draftReceipts: records.length,
      ledgerSha256: index.ledgerSha256,
    },
  };
}

function forbiddenProjectionValue(value) {
  if (typeof value !== "string") return false;
  const normalized = value.toLowerCase();
  return normalized.includes("trassenfinder")
    || normalized.includes("/apn/")
    || normalized.includes("internal-evidence")
    || /https?:\/\//.test(normalized)
    || /\.pdf(?:$|[?#\s])/.test(normalized);
}

/**
 * Hard release boundary for the optional public validation marker. This is not
 * a generic attribution filter; it is intentionally strict for this one
 * internal evidence channel.
 */
export function assertReleaseSafeValidationMarker(value) {
  const visit = (current, path = "marker") => {
    if (forbiddenProjectionValue(current)) throw new Error(`${path} enthält eine interne Abruf- oder Dateikennung.`);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (current === null || typeof current !== "object") return;
    for (const [key, nested] of Object.entries(current)) {
      invariant(!/(?:apn|pdf|ocr|sourceurl|filepath|filename|rawfile|evidence|sha256)/i.test(key), `${path}.${key} ist im auslieferbaren Validierungsmarker verboten.`);
      visit(nested, `${path}.${key}`);
    }
  };
  visit(value);
  return value;
}

export function createReleaseSafeValidationMarker({
  targetObjectId,
  status = "review-required",
  validatedDimensions = [],
} = {}) {
  const objectId = requiredText(targetObjectId, "targetObjectId");
  invariant(["review-required", "accepted-secondary-validation", "unavailable"].includes(status), "Ungültiger Validierungsstatus.");
  invariant(Array.isArray(validatedDimensions), "validatedDimensions muss ein Array sein.");
  const dimensions = [...new Set(validatedDimensions)].sort(compareText);
  for (const dimension of dimensions) invariant(QUALITY_DIMENSIONS.has(dimension), `Unbekannte Qualitätsdimension ${dimension}.`);
  const payload = {
    schema: "zugfolge-secondary-validation-marker/v1",
    targetObjectId: objectId,
    status,
    classAEligible: false,
    qualityContribution: "secondary-only",
    validatedDimensions: dimensions,
  };
  const marker = { ...payload, receiptHash: sha256(payload) };
  return assertReleaseSafeValidationMarker(marker);
}
