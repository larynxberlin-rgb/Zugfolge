#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateOperationalInfrastructureV2Native,
  validateOperationalInfrastructureV2NativeReceipt,
} from "./materialize-operational-infrastructure-v2.mjs";

const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const OUTPUT_BUFFER_BYTES = 1024 * 1024;
const MAX_ESCAPED_KEY_BYTES = 512;
const MAX_PROTECTION_ARRAY_BYTES = 64 * 1024;
const MAX_JSON_NESTING_DEPTH = 256;
const LEGACY_KEY = "requiredProtectionSystems";
const AVAILABLE_KEY = "availableProtectionSystems";
const SIMULTANEOUS_KEY = "simultaneouslyRequiredProtectionSystems";
const LEGACY_TOKEN = Buffer.from(JSON.stringify(LEGACY_KEY), "utf8");
const AVAILABLE_TOKEN = Buffer.from(JSON.stringify(AVAILABLE_KEY), "utf8");
const SIMULTANEOUS_TOKEN = Buffer.from(JSON.stringify(SIMULTANEOUS_KEY), "utf8");
const INSERTED_SIMULTANEOUS_FIELD = Buffer.from(`,${JSON.stringify(SIMULTANEOUS_KEY)}:[]`, "utf8");
const KNOWN_PROTECTION_SYSTEMS = new Set(["etcs-level1", "etcs-level2", "lzb", "pzb"]);
const RECEIPT_SCHEMA = "zugfolge-operational-v2-protection-fields-migration-receipt/v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Migrationsausgabe existiert bereits; create-new verweigert jede Ueberschreibung.");
}

async function stableFileProof(path, label, chunkBytes) {
  const before = await lstat(path);
  invariant(before.isFile() && !before.isSymbolicLink() && before.size > 0, `${label} ist keine nichtleere regulaere Datei.`);
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: chunkBytes })) {
    digest.update(chunk);
    bytes += chunk.length;
  }
  const after = await lstat(path);
  invariant(
    after.isFile()
      && !after.isSymbolicLink()
      && after.size === before.size
      && after.mtimeMs === before.mtimeMs
      && bytes === before.size,
    `${label} aenderte sich waehrend der Hashbildung.`,
  );
  return Object.freeze({ bytes, sha256: digest.digest("hex") });
}

class BufferedFileSink {
  constructor(fileDescriptor) {
    this.fileDescriptor = fileDescriptor;
    this.buffer = Buffer.allocUnsafe(OUTPUT_BUFFER_BYTES);
    this.offset = 0;
    this.bytes = 0;
    this.digest = createHash("sha256");
  }

  append(value) {
    let source = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    while (source.length > 0) {
      const writable = Math.min(source.length, this.buffer.length - this.offset);
      source.copy(this.buffer, this.offset, 0, writable);
      this.offset += writable;
      source = source.subarray(writable);
      if (this.offset === this.buffer.length) this.flush();
    }
  }

  flush() {
    if (this.offset === 0) return;
    const bytes = this.buffer.subarray(0, this.offset);
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(this.fileDescriptor, bytes, written, bytes.length - written);
    }
    this.digest.update(bytes);
    this.bytes += bytes.length;
    this.offset = 0;
  }

  finish() {
    this.flush();
    fsyncSync(this.fileDescriptor);
    return Object.freeze({ bytes: this.bytes, sha256: this.digest.digest("hex") });
  }
}

function decodedTargetKey(rawKey) {
  if (rawKey.equals(LEGACY_TOKEN)) return LEGACY_KEY;
  if (rawKey.equals(AVAILABLE_TOKEN)) return AVAILABLE_KEY;
  if (rawKey.equals(SIMULTANEOUS_TOKEN)) return SIMULTANEOUS_KEY;
  if (!rawKey.includes(0x5c)) return undefined;
  let decoded;
  try {
    decoded = JSON.parse(rawKey.toString("utf8"));
  } catch {
    return undefined;
  }
  return [LEGACY_KEY, AVAILABLE_KEY, SIMULTANEOUS_KEY].includes(decoded) ? decoded : undefined;
}

function normalizeLegacyArray(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`requiredProtectionSystems ist kein gueltiges JSON-Array: ${error instanceof Error ? error.message : String(error)}`);
  }
  invariant(Array.isArray(value) && value.length > 0, "requiredProtectionSystems muss eine nichtleere Systemliste sein.");
  const legacySystems = new Set([...KNOWN_PROTECTION_SYSTEMS, "etcs"]);
  invariant(
    value.every((system) => typeof system === "string" && legacySystems.has(system))
      && new Set(value).size === value.length
      && value.every((system, index) => index === 0 || value[index - 1] < system),
    `requiredProtectionSystems muss ausschliesslich aktuelle Systeme oder den generischen Legacy-Wert etcs eindeutig und kanonisch sortiert enthalten: ${JSON.stringify(value)}`,
  );
  const genericEtcsDropped = value.includes("etcs") ? 1 : 0;
  const canonical = value.filter((system) => system !== "etcs");
  const pzbFallbackApplied = canonical.length === 0 ? 1 : 0;
  if (pzbFallbackApplied === 1) canonical.push("pzb");
  invariant(canonical.every((system) => KNOWN_PROTECTION_SYSTEMS.has(system)), "Legacy-Normalisierung erzeugte ein unbekanntes Zugsicherungssystem.");
  return Object.freeze({
    bytes: genericEtcsDropped === 0 ? bytes : Buffer.from(JSON.stringify(canonical), "utf8"),
    genericEtcsDropped,
    pzbFallbackApplied,
  });
}

class ProtectionFieldTransformer {
  constructor(sink) {
    this.sink = sink;
    this.mode = "normal";
    this.stack = [];
    this.stringEscaped = false;
    this.keyBuffer = Buffer.allocUnsafe(MAX_ESCAPED_KEY_BYTES);
    this.keyLength = 0;
    this.legacyBuffer = Buffer.allocUnsafe(MAX_PROTECTION_ARRAY_BYTES);
    this.legacyLength = 0;
    this.legacyArrayStart = -1;
    this.legacyArrayDepth = 0;
    this.legacyArrayInString = false;
    this.legacyArrayEscaped = false;
    this.replacements = 0;
    this.genericEtcsDropped = 0;
    this.pzbFallbackApplied = 0;
  }

  top() {
    return this.stack.at(-1);
  }

  appendLegacyByte(byte) {
    invariant(this.legacyLength < this.legacyBuffer.length, "requiredProtectionSystems-Array ueberschreitet die feste Migrationsgrenze von 64 KiB.");
    this.legacyBuffer[this.legacyLength] = byte;
    this.legacyLength += 1;
  }

  beginLegacyField() {
    this.legacyLength = 0;
    AVAILABLE_TOKEN.copy(this.legacyBuffer, this.legacyLength);
    this.legacyLength += AVAILABLE_TOKEN.length;
    this.legacyArrayStart = -1;
    this.mode = "legacy-colon";
  }

  completeKey() {
    const rawKey = this.keyBuffer.subarray(0, this.keyLength);
    const target = decodedTargetKey(rawKey);
    if (target === AVAILABLE_KEY || target === SIMULTANEOUS_KEY) {
      throw new Error("Eingabe besitzt bereits aktuelle oder gemischte Operational-v2-Zugsicherungsfelder; Einmalmigration verweigert die Verarbeitung.");
    }
    if (target === LEGACY_KEY) {
      this.beginLegacyField();
      return;
    }
    this.sink.append(rawKey);
    this.mode = "normal";
  }

  completeLegacyArray() {
    const arrayBytes = this.legacyBuffer.subarray(this.legacyArrayStart, this.legacyLength);
    const normalized = normalizeLegacyArray(arrayBytes);
    this.sink.append(this.legacyBuffer.subarray(0, this.legacyArrayStart));
    this.sink.append(normalized.bytes);
    this.sink.append(INSERTED_SIMULTANEOUS_FIELD);
    this.replacements += 1;
    this.genericEtcsDropped += normalized.genericEtcsDropped;
    this.pzbFallbackApplied += normalized.pzbFallbackApplied;
    this.mode = "normal";
  }

  process(chunk) {
    let copyStart = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index];

      if (this.mode === "string-value" || this.mode === "oversized-key") {
        if (this.stringEscaped) {
          this.stringEscaped = false;
        } else if (byte === 0x5c) {
          this.stringEscaped = true;
        } else if (byte === 0x22) {
          this.mode = "normal";
        }
        continue;
      }

      if (this.mode === "key") {
        if (this.keyLength === this.keyBuffer.length) {
          this.sink.append(this.keyBuffer);
          copyStart = index;
          this.mode = "oversized-key";
          if (this.stringEscaped) this.stringEscaped = false;
          else if (byte === 0x5c) this.stringEscaped = true;
          else if (byte === 0x22) this.mode = "normal";
          continue;
        }
        this.keyBuffer[this.keyLength] = byte;
        this.keyLength += 1;
        if (this.stringEscaped) {
          this.stringEscaped = false;
        } else if (byte === 0x5c) {
          this.stringEscaped = true;
        } else if (byte === 0x22) {
          this.completeKey();
          copyStart = index + 1;
        }
        continue;
      }

      if (this.mode === "legacy-colon") {
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
          this.appendLegacyByte(byte);
          continue;
        }
        invariant(byte === 0x3a, "requiredProtectionSystems-Key wird nicht von einem Doppelpunkt gefolgt.");
        this.appendLegacyByte(byte);
        const object = this.top();
        invariant(object?.type === "object", "requiredProtectionSystems steht nicht in einem JSON-Objekt.");
        object.expectingKey = false;
        this.mode = "legacy-array-start";
        continue;
      }

      if (this.mode === "legacy-array-start") {
        if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
          this.appendLegacyByte(byte);
          continue;
        }
        invariant(byte === 0x5b, "requiredProtectionSystems besitzt keinen Arraywert.");
        this.legacyArrayStart = this.legacyLength;
        this.appendLegacyByte(byte);
        this.legacyArrayDepth = 1;
        this.legacyArrayInString = false;
        this.legacyArrayEscaped = false;
        this.mode = "legacy-array";
        continue;
      }

      if (this.mode === "legacy-array") {
        this.appendLegacyByte(byte);
        if (this.legacyArrayInString) {
          if (this.legacyArrayEscaped) {
            this.legacyArrayEscaped = false;
          } else if (byte === 0x5c) {
            this.legacyArrayEscaped = true;
          } else if (byte === 0x22) {
            this.legacyArrayInString = false;
          }
        } else if (byte === 0x22) {
          this.legacyArrayInString = true;
        } else if (byte === 0x5b) {
          this.legacyArrayDepth += 1;
        } else if (byte === 0x5d) {
          this.legacyArrayDepth -= 1;
          if (this.legacyArrayDepth === 0) {
            this.completeLegacyArray();
            copyStart = index + 1;
          }
        }
        continue;
      }

      if (byte === 0x22) {
        const object = this.top();
        if (object?.type === "object" && object.expectingKey) {
          this.sink.append(chunk.subarray(copyStart, index));
          this.keyLength = 1;
          this.keyBuffer[0] = byte;
          this.stringEscaped = false;
          this.mode = "key";
          copyStart = index + 1;
        } else {
          this.mode = "string-value";
          this.stringEscaped = false;
        }
      } else if (byte === 0x7b) {
        invariant(this.stack.length < MAX_JSON_NESTING_DEPTH, `Operational-v2-Eingabe ueberschreitet die feste JSON-Schachtelungsgrenze von ${MAX_JSON_NESTING_DEPTH}.`);
        this.stack.push({ type: "object", expectingKey: true });
      } else if (byte === 0x5b) {
        invariant(this.stack.length < MAX_JSON_NESTING_DEPTH, `Operational-v2-Eingabe ueberschreitet die feste JSON-Schachtelungsgrenze von ${MAX_JSON_NESTING_DEPTH}.`);
        this.stack.push({ type: "array" });
      } else if (byte === 0x7d) {
        invariant(this.top()?.type === "object", "JSON-Objektgrenzen sind unausgeglichen.");
        this.stack.pop();
      } else if (byte === 0x5d) {
        invariant(this.top()?.type === "array", "JSON-Arraygrenzen sind unausgeglichen.");
        this.stack.pop();
      } else if (byte === 0x2c) {
        const object = this.top();
        if (object?.type === "object") object.expectingKey = true;
      } else if (byte === 0x3a) {
        const object = this.top();
        if (object?.type === "object") object.expectingKey = false;
      }
    }

    if (["normal", "string-value", "oversized-key"].includes(this.mode)) {
      this.sink.append(chunk.subarray(copyStart));
    }
  }

  finish() {
    invariant(this.mode === "normal", "Operational-v2-Eingabe endet innerhalb eines JSON-Tokens oder Legacy-Feldes.");
    invariant(this.stack.length === 0, "Operational-v2-Eingabe besitzt unausgeglichene JSON-Grenzen.");
    invariant(this.replacements > 0, "Keine requiredProtectionSystems-Felder gefunden; Einmalmigration verweigert einen Null-Lauf.");
    return Object.freeze({
      replacements: this.replacements,
      genericEtcsDropped: this.genericEtcsDropped,
      pzbFallbackApplied: this.pzbFallbackApplied,
    });
  }
}

function expectedPositiveInteger(value, name) {
  invariant(Number.isSafeInteger(value) && value > 0, `${name} muss eine positive sichere Ganzzahl sein.`);
  return value;
}

function expectedNonNegativeInteger(value, name) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${name} muss eine nichtnegative sichere Ganzzahl sein.`);
  return value;
}

export async function migrateOperationalV2ProtectionFields({
  inputPath,
  outputPath,
  expectedReleaseId,
  expectedSourceBytes,
  expectedSourceSha256,
  expectedReplacements,
  expectedGenericEtcsDropped,
  expectedPzbFallbackApplied,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  validateCurrent = validateOperationalInfrastructureV2Native,
}) {
  invariant(Number.isSafeInteger(chunkBytes) && chunkBytes > 0, "Streaming-Chunkgroesse muss eine positive sichere Ganzzahl sein.");
  invariant(typeof expectedReleaseId === "string" && expectedReleaseId.trim() === expectedReleaseId && expectedReleaseId !== "", "Erwartete InfraRelease-ID fehlt.");
  expectedPositiveInteger(expectedSourceBytes, "Erwartete Legacy-Quellbytezahl");
  invariant(/^[a-f0-9]{64}$/u.test(expectedSourceSha256 ?? ""), "Erwarteter Legacy-Quell-SHA-256 muss aus exakt 64 kleinen Hexadezimalzeichen bestehen.");
  expectedPositiveInteger(expectedReplacements, "Erwartete Ersetzungszahl");
  expectedNonNegativeInteger(expectedGenericEtcsDropped, "Erwartete Zahl entfernter generischer ETCS-Werte");
  expectedNonNegativeInteger(expectedPzbFallbackApplied, "Erwartete Zahl angewendeter PZB-Fallbacks");
  invariant(typeof validateCurrent === "function", "Aktueller nativer Operational-v2-Validator fehlt.");
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  invariant(input !== output, "Quelle und Migrationsausgabe muessen getrennte Dateien sein.");
  await mkdir(dirname(output), { recursive: true });
  await assertMissing(output);

  const sourceBefore = await stableFileProof(input, "Operational-v2-Legacyquelle", chunkBytes);
  invariant(
    sourceBefore.bytes === expectedSourceBytes && sourceBefore.sha256 === expectedSourceSha256,
    `Operational-v2-Legacyquelle verletzt ihre festen Pins: ${sourceBefore.bytes} Bytes / ${sourceBefore.sha256}.`,
  );
  const temporary = `${output}.${process.pid}.${randomUUID()}.migration-building`;
  let fileDescriptor;
  try {
    fileDescriptor = openSync(temporary, "wx", 0o644);
    const sink = new BufferedFileSink(fileDescriptor);
    const transformer = new ProtectionFieldTransformer(sink);
    const sourceDigest = createHash("sha256");
    let sourceBytes = 0;
    for await (const chunk of createReadStream(input, { highWaterMark: chunkBytes })) {
      sourceDigest.update(chunk);
      sourceBytes += chunk.length;
      transformer.process(chunk);
    }
    const counters = transformer.finish();
    const outputProof = sink.finish();
    closeSync(fileDescriptor);
    fileDescriptor = undefined;

    const sourceAfter = Object.freeze({ bytes: sourceBytes, sha256: sourceDigest.digest("hex") });
    invariant(
      sourceAfter.bytes === sourceBefore.bytes && sourceAfter.sha256 === sourceBefore.sha256,
      "Operational-v2-Legacyquelle aenderte sich zwischen Vorpruefung und Migration.",
    );
    invariant(counters.replacements === expectedReplacements, `Legacy-Korpus driftete: ${counters.replacements} statt ${expectedReplacements} erwartete Ersetzungen.`);
    invariant(counters.genericEtcsDropped === expectedGenericEtcsDropped, `Legacy-Korpus driftete: ${counters.genericEtcsDropped} statt ${expectedGenericEtcsDropped} erwartete generische ETCS-Entfernungen.`);
    invariant(counters.pzbFallbackApplied === expectedPzbFallbackApplied, `Legacy-Korpus driftete: ${counters.pzbFallbackApplied} statt ${expectedPzbFallbackApplied} erwartete PZB-Fallbacks.`);
    const temporaryMetadata = await lstat(temporary);
    invariant(
      temporaryMetadata.isFile() && !temporaryMetadata.isSymbolicLink() && temporaryMetadata.size === outputProof.bytes,
      "Temporaere Migrationsausgabe verletzt ihre Bytebindung.",
    );
    const nativeReceipt = validateOperationalInfrastructureV2NativeReceipt(
      await validateCurrent(temporary, expectedReleaseId),
      expectedReleaseId,
    );
    invariant(
      nativeReceipt.sourceBytes === outputProof.bytes && nativeReceipt.sourceSha256 === outputProof.sha256,
      "Aktueller nativer Operational-v2-Validator ist nicht an die migrierten Bytes gebunden.",
    );
    const publicationProof = await stableFileProof(temporary, "Nativ validierte Migrationsausgabe", chunkBytes);
    invariant(
      publicationProof.bytes === outputProof.bytes && publicationProof.sha256 === outputProof.sha256,
      "Nativ validierte Migrationsausgabe aenderte sich vor dem create-new Link.",
    );

    try {
      linkSync(temporary, output);
    } catch (error) {
      if (error?.code === "EEXIST") throw new Error("Migrationsausgabe existiert bereits; create-new verweigert jede Ueberschreibung.");
      throw error;
    }
    return Object.freeze({
      schema: RECEIPT_SCHEMA,
      expectedReleaseId,
      replacements: counters.replacements,
      genericEtcsDropped: counters.genericEtcsDropped,
      pzbFallbackApplied: counters.pzbFallbackApplied,
      sourceBytes: sourceAfter.bytes,
      sourceSha256: sourceAfter.sha256,
      outputBytes: outputProof.bytes,
      outputSha256: outputProof.sha256,
      nativeCanonicalBytes: nativeReceipt.bytes,
      nativeCanonicalSha256: nativeReceipt.sha256,
      nativeStateHash: nativeReceipt.stateHash,
      output,
    });
  } finally {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function parseCounter(value, flag) {
  invariant(/^(0|[1-9][0-9]*)$/u.test(value ?? ""), `${flag} verlangt eine nichtnegative Dezimalzahl ohne Vorzeichen.`);
  const parsed = Number(value);
  invariant(Number.isSafeInteger(parsed), `${flag} ueberschreitet den sicheren Ganzzahlbereich.`);
  return parsed;
}

export function parseMigrationCliArguments(arguments_) {
  const [inputPath, outputPath, ...options] = arguments_;
  invariant(inputPath && outputPath, "Legacy-Quelle und create-new Ausgabe fehlen.");
  invariant(options.length % 2 === 0, "Jede Migrationsoption verlangt genau einen Wert.");
  const parsed = new Map();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    invariant([
      "--expected-release-id",
      "--expected-source-bytes",
      "--expected-source-sha256",
      "--expected-replacements",
      "--expected-generic-etcs-dropped",
      "--expected-pzb-fallback-applied",
    ].includes(flag), `Unbekannte Migrationsoption: ${flag ?? "<fehlt>"}.`);
    invariant(!parsed.has(flag), `Migrationsoption ${flag} wurde doppelt angegeben.`);
    invariant(value !== undefined && value !== "", `Migrationsoption ${flag} besitzt keinen Wert.`);
    parsed.set(flag, value);
  }
  for (const flag of [
    "--expected-release-id",
    "--expected-source-bytes",
    "--expected-source-sha256",
    "--expected-replacements",
    "--expected-generic-etcs-dropped",
    "--expected-pzb-fallback-applied",
  ]) invariant(parsed.has(flag), `Pflichtoption ${flag} fehlt.`);
  return Object.freeze({
    inputPath,
    outputPath,
    expectedReleaseId: parsed.get("--expected-release-id"),
    expectedSourceBytes: parseCounter(parsed.get("--expected-source-bytes"), "--expected-source-bytes"),
    expectedSourceSha256: parsed.get("--expected-source-sha256"),
    expectedReplacements: parseCounter(parsed.get("--expected-replacements"), "--expected-replacements"),
    expectedGenericEtcsDropped: parseCounter(parsed.get("--expected-generic-etcs-dropped"), "--expected-generic-etcs-dropped"),
    expectedPzbFallbackApplied: parseCounter(parsed.get("--expected-pzb-fallback-applied"), "--expected-pzb-fallback-applied"),
  });
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  let configuration;
  try {
    configuration = parseMigrationCliArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write("Aufruf: migrate-operational-v2-protection-fields.mjs LEGACY.json NEW.json --expected-release-id ID --expected-source-bytes N --expected-source-sha256 SHA256 --expected-replacements N --expected-generic-etcs-dropped N --expected-pzb-fallback-applied N\n");
    process.exitCode = 1;
  }
  if (configuration !== undefined) migrateOperationalV2ProtectionFields(configuration)
    .then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
