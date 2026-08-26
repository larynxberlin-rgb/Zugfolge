import { constants as fileConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, open, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertProductionSchema29RuntimeBeforeReceiptUnchanged,
  readProductionSchema29RuntimeBeforeReceipt,
} from "./production-schema29-runtime-snapshot.mjs";

const OPEN_SCHEMA = "zugfolge-schema29-odoo-filestore-open/v1";
const SEAL_SCHEMA = "zugfolge-schema29-odoo-filestore-seal/v1";
const ODOO_PROBE_SCHEMA = "zugfolge-legacy-odoo-schema29-write-probe/v2";
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const SAFE_DATABASE = /^zugfolge_odoo_recovery_v1_[a-z0-9_]+$/u;
const HASH_PATH = /^[a-f0-9]{2}\/[a-f0-9]{40}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
  return value;
}

function numericIdentity(environment, name) {
  const value = requiredEnvironment(environment, name);
  invariant(/^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value)), `${name} muss eine numerische Nicht-root-Identitaet sein.`);
  return Number(value);
}

function exactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} besitzt fremde oder fehlende Felder.`);
  return value;
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalInstant(value, label) {
  invariant(typeof value === "string" && new Date(value).toISOString() === value, `${label} ist kein kanonischer UTC-Zeitpunkt.`);
  return value;
}

async function stableJson(path, label) {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  invariant(before.isFile() && !before.isSymbolicLink() && before.size > 0n && before.size <= 4_194_304n, `${label} ist keine sichere JSON-Datei.`);
  const bytes = await readFile(absolute);
  const after = await lstat(absolute, { bigint: true });
  invariant(sameIdentity(before, after) && before.size === after.size && before.mtimeNs === after.mtimeNs, `${label} aenderte sich beim Lesen.`);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} ist kein gueltiges JSON.`); }
  return Object.freeze({ absolute, identity: before, sha256: createHash("sha256").update(bytes).digest("hex"), value });
}

async function assertJsonUnchanged(artifact, label) {
  const after = await stableJson(artifact.absolute, label);
  invariant(sameIdentity(artifact.identity, after.identity) && artifact.sha256 === after.sha256, `${label} wurde nach der Validierung ausgetauscht.`);
}

async function containedOutput(rootPath, outputPath, label) {
  const rootInput = resolve(rootPath);
  const rootInputStatus = await lstat(rootInput, { bigint: true });
  invariant(rootInputStatus.isDirectory() && !rootInputStatus.isSymbolicLink(), `${label}-Evidence-Wurzel ist unsicher.`);
  const root = await realpath(rootInput);
  invariant(root !== resolve(sep), `${label}-Evidence-Wurzel ist zu breit.`);
  const absolute = resolve(outputPath);
  invariant(await realpath(dirname(absolute)) === root, `${label} muss direkt in der Evidence-Wurzel liegen.`);
  invariant(/^[a-z0-9][a-z0-9._-]*\.json$/u.test(basename(absolute)), `${label} besitzt keinen sicheren Dateinamen.`);
  try { await lstat(absolute); } catch (error) { if (error?.code === "ENOENT") return absolute; throw error; }
  throw new Error(`${label} existiert bereits; der Beleg ist create-new.`);
}

async function publishCreateNew(path, value) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  let linked = false;
  try {
    await handle.writeFile(`${JSON.stringify(sortedValue(value), null, 2)}\n`);
    await handle.sync();
    await handle.close();
    await link(temporary, path);
    linked = true;
    const directoryHandle = await open(dirname(path), fileConstants.O_RDONLY | (process.platform === "win32" ? 0 : fileConstants.O_DIRECTORY));
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    await unlink(temporary);
  } catch (error) {
    try { await handle.close(); } catch { /* primaerer Fehler bleibt massgeblich */ }
    if (linked) { try { await unlink(path); } catch { /* nur eigener Beleg */ } }
    try { await unlink(temporary); } catch { /* primaerer Fehler bleibt massgeblich */ }
    throw error;
  }
}

function accessEnvironment(environment) {
  const recoveryId = requiredEnvironment(environment, "PRODUCTION_RECOVERY_ID");
  const databaseName = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE");
  invariant(SAFE_ID.test(recoveryId), "PRODUCTION_RECOVERY_ID ist nicht kanonisch.");
  invariant(SAFE_DATABASE.test(databaseName), "Schema-29-Odoo-Runtime-Datenbank ist nicht sicher gebunden.");
  const openOutputPath = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_FILESTORE_OPEN_OUTPUT_PATH");
  const openReceiptPath = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_FILESTORE_OPEN_RECEIPT_PATH");
  invariant(resolve(openOutputPath) === resolve(openReceiptPath), "Schema-29-Odoo-Filestore-Open-Ausgabe und -Eingang muessen derselbe create-new-Beleg sein.");
  const probePath = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_LEGACY_PROBE_PATH");
  const runtimeBeforePath = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_RUNTIME_BEFORE_RECEIPT_PATH");
  const sealOutputPath = requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_FILESTORE_SEAL_OUTPUT_PATH");
  invariant(new Set([resolve(openOutputPath), resolve(probePath), resolve(runtimeBeforePath), resolve(sealOutputPath)]).size === 4, "Schema-29-Odoo-Filestore-Belege muessen getrennte Pfade besitzen.");
  return Object.freeze({
    databaseName,
    evidenceRoot: requiredEnvironment(environment, "PRODUCTION_RECOVERY_EVIDENCE_ROOT"),
    filestoreRoot: requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_FILESTORE_ROOT"),
    filestorePath: requiredEnvironment(environment, "PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH"),
    openOutputPath,
    openReceiptPath,
    owner: Object.freeze({
      gid: numericIdentity(environment, "PRODUCTION_RECOVERY_ODOO_RUNTIME_GID"),
      uid: numericIdentity(environment, "PRODUCTION_RECOVERY_ODOO_RUNTIME_UID"),
    }),
    probePath,
    recoveryId,
    runtimeBeforePath,
    sealOutputPath,
  });
}

async function boundFilestorePath(configuration) {
  const rootInput = resolve(configuration.filestoreRoot);
  const rootStatus = await lstat(rootInput, { bigint: true });
  invariant(rootStatus.isDirectory() && !rootStatus.isSymbolicLink(), "Schema-29-Odoo-Filestore-Wurzel ist kein direktes Verzeichnis.");
  const root = await realpath(rootInput);
  invariant(root !== resolve(sep), "Schema-29-Odoo-Filestore-Wurzel ist zu breit.");
  const targetInput = resolve(configuration.filestorePath);
  invariant(targetInput === resolve(rootInput, configuration.databaseName), "Schema-29-Odoo-Runtime-Filestore muss das datenbankbenannte direkte Kind der festen Wurzel sein.");
  const targetStatus = await lstat(targetInput, { bigint: true });
  invariant(targetStatus.isDirectory() && !targetStatus.isSymbolicLink(), "Schema-29-Odoo-Runtime-Filestore ist kein direktes Verzeichnis.");
  const target = await realpath(targetInput);
  invariant(dirname(target) === root && basename(target) === configuration.databaseName, "Schema-29-Odoo-Runtime-Filestore verlaesst die feste Wurzel.");
  return target;
}

function assertAccess(status, isDirectory, expectedAccess, owner, label) {
  const mode = Number(status.mode) & 0o777;
  invariant(Number(status.uid) === owner.uid && Number(status.gid) === owner.gid, `${label} gehoert nicht dem gebundenen Odoo-Runtime-Owner.`);
  if (expectedAccess === "read-only") {
    invariant((mode & 0o222) === 0, `${label} ist trotz Read-only-Vertrag beschreibbar.`);
  } else if (expectedAccess === "owner-writable") {
    invariant((mode & 0o200) !== 0, `${label} ist trotz RW-Mount fuer den Odoo-Runtime-Owner nicht beschreibbar.`);
    if (process.platform !== "win32") {
      invariant((mode & 0o022) === 0, `${label} ist fuer Gruppe oder Andere beschreibbar.`);
      invariant((mode & (isDirectory ? 0o500 : 0o400)) === (isDirectory ? 0o500 : 0o400), `${label} besitzt nicht die erforderlichen Owner-Lese-/Ausfuehrungsrechte.`);
    }
  }
}

async function stableFileSha256(path, expectedIdentity, label) {
  const flags = process.platform === "win32" ? fileConstants.O_RDONLY : fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW;
  const handle = await open(path, flags);
  const hash = createHash("sha256");
  try {
    const opened = await handle.stat({ bigint: true });
    invariant(opened.isFile() && sameIdentity(opened, expectedIdentity), `${label} wurde beim Oeffnen ausgetauscht.`);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0n;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      size += BigInt(bytesRead);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    const installed = await lstat(path, { bigint: true });
    invariant(sameIdentity(opened, after) && sameIdentity(after, installed) && after.size === size && after.mtimeNs === opened.mtimeNs, `${label} aenderte sich beim Lesen.`);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function collectFilestoreEntries(root, owner, { expectedAccess = "any", strictPaths = true } = {}) {
  invariant(["any", "owner-writable", "read-only"].includes(expectedAccess), "Schema-29-Odoo-Filestore-Zugriffsvertrag ist unbekannt.");
  const entries = [];
  async function visit(path, relativePath, depth) {
    const status = await lstat(path, { bigint: true });
    invariant(!status.isSymbolicLink(), "Schema-29-Odoo-Filestore enthaelt einen Symlink.");
    const isDirectory = status.isDirectory();
    invariant(isDirectory || status.isFile(), "Schema-29-Odoo-Filestore enthaelt einen unzulaessigen Dateityp.");
    assertAccess(status, isDirectory, expectedAccess, owner, relativePath === "." ? "Schema-29-Odoo-Filestore" : `Schema-29-Odoo-Filestoreeintrag '${relativePath}'`);
    if (strictPaths && relativePath !== ".") {
      invariant((isDirectory && depth === 1 && /^[a-f0-9]{2}$/u.test(relativePath)) || (!isDirectory && HASH_PATH.test(relativePath)), `Schema-29-Odoo-Filestore enthaelt den unsicheren Pfad '${relativePath}'.`);
    }
    const entry = { absolute: path, depth, identity: status, isDirectory, mode: Number(status.mode) & 0o777, relativePath, sha256: null };
    entries.push(entry);
    if (!isDirectory) {
      entry.sha256 = await stableFileSha256(path, status, `Schema-29-Odoo-Filestoredatei '${relativePath}'`);
      return;
    }
    const children = await readdir(path, { withFileTypes: true });
    children.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const child of children) {
      invariant(child.name !== "." && child.name !== ".." && !child.name.includes("/") && !child.name.includes("\\"), "Schema-29-Odoo-Filestore enthaelt einen unsicheren Namen.");
      const childRelative = relativePath === "." ? child.name : `${relativePath}/${child.name}`;
      await visit(resolve(path, child.name), childRelative, depth + 1);
    }
  }
  await visit(root, ".", 0);
  const files = entries.filter((entry) => !entry.isDirectory).sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
  const treeSha256 = createHash("sha256").update(files.map(({ relativePath, sha256 }) => `${sha256}  ./${relativePath}\n`).join(""), "utf8").digest("hex");
  const access = entries.map(({ isDirectory, mode, relativePath }) => ({ gid: owner.gid, mode, path: relativePath, type: isDirectory ? "directory" : "file", uid: owner.uid }));
  return Object.freeze({ access: expectedAccess, accessSha256: canonicalSha256(access), entries, fileCount: files.length, ownerGid: owner.gid, ownerUid: owner.uid, treeSha256 });
}

export async function inspectSchema29OdooFilestore(rootPath, { expectedAccess, expectedGid, expectedUid, strictPaths = true }) {
  const configuration = { databaseName: basename(resolve(rootPath)), filestorePath: rootPath, filestoreRoot: dirname(resolve(rootPath)) };
  const root = await boundFilestorePath(configuration);
  const owner = Object.freeze({ gid: expectedGid, uid: expectedUid });
  invariant(Number.isSafeInteger(owner.uid) && owner.uid > 0 && Number.isSafeInteger(owner.gid) && owner.gid > 0, "Schema-29-Odoo-Filestore-Owner ist ungueltig.");
  const result = await collectFilestoreEntries(root, owner, { expectedAccess, strictPaths });
  return Object.freeze({ access: result.access, accessSha256: result.accessSha256, fileCount: result.fileCount, ownerGid: result.ownerGid, ownerUid: result.ownerUid, root, treeSha256: result.treeSha256 });
}

async function chmodStableEntry(entry, mode, owner) {
  const before = await lstat(entry.absolute, { bigint: true });
  invariant(sameIdentity(before, entry.identity) && !before.isSymbolicLink(), "Schema-29-Odoo-Filestorepfad wurde vor dem Moduswechsel ausgetauscht.");
  if (process.platform === "win32") {
    await chmod(entry.absolute, mode);
  } else {
    const flags = fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | (entry.isDirectory ? fileConstants.O_DIRECTORY : 0);
    const handle = await open(entry.absolute, flags);
    try {
      const opened = await handle.stat({ bigint: true });
      invariant(sameIdentity(opened, entry.identity) && Number(opened.uid) === owner.uid && Number(opened.gid) === owner.gid, "Schema-29-Odoo-Filestorepfad wurde vor dem Moduswechsel ausgetauscht.");
      await handle.chmod(mode);
      const after = await handle.stat({ bigint: true });
      invariant(sameIdentity(opened, after), "Schema-29-Odoo-Filestorepfad wurde beim Moduswechsel ausgetauscht.");
    } finally {
      await handle.close();
    }
  }
  const after = await lstat(entry.absolute, { bigint: true });
  invariant(sameIdentity(before, after) && Number(after.uid) === owner.uid && Number(after.gid) === owner.gid, "Schema-29-Odoo-Filestorepfad wurde nach dem Moduswechsel ausgetauscht.");
}

async function setFilestoreAccess(root, owner, writable) {
  const collected = await collectFilestoreEntries(root, owner, { expectedAccess: "any", strictPaths: false });
  const entries = [...collected.entries].sort((left, right) => writable
    ? left.depth - right.depth || Number(left.isDirectory) - Number(right.isDirectory)
    : Number(left.isDirectory) - Number(right.isDirectory) || right.depth - left.depth);
  for (const entry of entries) await chmodStableEntry(entry, writable ? (entry.isDirectory ? 0o700 : 0o600) : (entry.isDirectory ? 0o500 : 0o400), owner);
}

export function validateLegacyOdooSchema29WriteProbe(value, expected = {}) {
  exactKeys(value, [
    "blobBytes", "blobRelativePath", "blobSha256", "cleanupComplete", "createdFileCount", "databaseName",
    "directReadSha256", "filestoreBeforeTreeSha256", "filestoreFinalTreeSha256", "filestoreWrittenTreeSha256",
    "fsynced", "legacyOdooImageDigest", "odooReadSha256", "receiptHash", "recoveryId", "rolledBack", "schema",
    "temporaryAttachmentId", "temporaryRecordId",
  ], "Legacy-Odoo-Schema-29-Filestore-Probe");
  invariant(value.schema === ODOO_PROBE_SCHEMA && SAFE_ID.test(value.recoveryId) && SAFE_DATABASE.test(value.databaseName), "Legacy-Odoo-Schema-29-Filestore-Probe besitzt keinen gueltigen Vertrag.");
  invariant(value.rolledBack === true && value.cleanupComplete === true && value.fsynced === true, "Legacy-Odoo-Schema-29-Filestore-Probe belegt Rollback, fsync und Cleanup nicht.");
  invariant(Number.isSafeInteger(value.temporaryRecordId) && value.temporaryRecordId > 0 && Number.isSafeInteger(value.temporaryAttachmentId) && value.temporaryAttachmentId > 0, "Legacy-Odoo-Schema-29-Filestore-Probe besitzt keine temporaeren ORM-Identitaeten.");
  invariant(Number.isSafeInteger(value.blobBytes) && value.blobBytes > 0 && Number.isSafeInteger(value.createdFileCount) && value.createdFileCount > 0, "Legacy-Odoo-Schema-29-Filestore-Probe belegt keinen Dateischreibzugriff.");
  invariant(HASH_PATH.test(value.blobRelativePath), "Legacy-Odoo-Schema-29-Filestore-Probe besitzt keinen sicheren Odoo-Hashpfad.");
  for (const hash of [value.blobSha256, value.directReadSha256, value.filestoreBeforeTreeSha256, value.filestoreFinalTreeSha256, value.filestoreWrittenTreeSha256, value.odooReadSha256, value.receiptHash]) invariant(SHA256.test(hash), "Legacy-Odoo-Schema-29-Filestore-Probe besitzt einen ungueltigen SHA-256.");
  invariant(value.directReadSha256 === value.blobSha256 && value.odooReadSha256 === value.blobSha256, "Legacy-Odoo-Schema-29-Filestore-Probe hat das Blob nicht bytegleich gelesen.");
  invariant(value.filestoreWrittenTreeSha256 !== value.filestoreBeforeTreeSha256 && value.filestoreFinalTreeSha256 === value.filestoreBeforeTreeSha256, "Legacy-Odoo-Schema-29-Filestore-Probe belegt keinen Schreib- und Cleanup-Zyklus.");
  for (const key of ["recoveryId", "databaseName", "legacyOdooImageDigest", "filestoreBeforeTreeSha256"]) if (expected[key] !== undefined) invariant(value[key] === expected[key], `Legacy-Odoo-Schema-29-Filestore-Probe bindet ${key} nicht.`);
  const { receiptHash, ...payload } = value;
  invariant(receiptHash === canonicalSha256(payload), "Legacy-Odoo-Schema-29-Filestore-Probe besitzt keinen kanonischen Receipt-Hash.");
  return value;
}

export function validateSchema29OdooFilestoreOpenReceipt(value, expected = {}) {
  exactKeys(value, [
    "baselineFilestoreTreeSha256", "beforeAccessSha256", "fileCount", "openedAccessSha256", "openedAt", "ownerGid",
    "ownerUid", "receiptHash", "recoveryId", "runtimeBeforeReceiptHash", "runtimeBeforeReceiptSha256", "schema",
  ], "Schema-29-Odoo-Filestore-Open-Beleg");
  invariant(value.schema === OPEN_SCHEMA && SAFE_ID.test(value.recoveryId), "Schema-29-Odoo-Filestore-Open-Beleg besitzt keinen gueltigen Vertrag.");
  invariant(Number.isSafeInteger(value.ownerUid) && value.ownerUid > 0 && Number.isSafeInteger(value.ownerGid) && value.ownerGid > 0 && Number.isSafeInteger(value.fileCount) && value.fileCount >= 0, "Schema-29-Odoo-Filestore-Open-Beleg besitzt keine sichere Owner-/Dateibindung.");
  for (const hash of [value.baselineFilestoreTreeSha256, value.beforeAccessSha256, value.openedAccessSha256, value.runtimeBeforeReceiptHash, value.runtimeBeforeReceiptSha256, value.receiptHash]) invariant(SHA256.test(hash), "Schema-29-Odoo-Filestore-Open-Beleg besitzt einen ungueltigen SHA-256.");
  canonicalInstant(value.openedAt, "Schema-29-Odoo-Filestore-Open-Zeitpunkt");
  invariant(value.beforeAccessSha256 !== value.openedAccessSha256, "Schema-29-Odoo-Filestore-Open-Beleg belegt keinen echten Moduswechsel.");
  for (const key of ["recoveryId", "baselineFilestoreTreeSha256", "runtimeBeforeReceiptHash", "ownerUid", "ownerGid"]) if (expected[key] !== undefined) invariant(value[key] === expected[key], `Schema-29-Odoo-Filestore-Open-Beleg bindet ${key} nicht.`);
  const { receiptHash, ...payload } = value;
  invariant(receiptHash === canonicalSha256(payload), "Schema-29-Odoo-Filestore-Open-Beleg besitzt keinen kanonischen Receipt-Hash.");
  return value;
}

export function validateSchema29OdooFilestoreSealReceipt(value, expected = {}) {
  exactKeys(value, [
    "baselineFilestoreTreeSha256", "fileCount", "finalAccessSha256", "finalFilestoreTreeSha256", "odooProbeReceiptHash",
    "odooProbeReceiptSha256", "openReceiptHash", "openReceiptSha256", "ownerGid", "ownerUid", "receiptHash", "recoveryId",
    "schema", "sealedAt",
  ], "Schema-29-Odoo-Filestore-Seal-Beleg");
  invariant(value.schema === SEAL_SCHEMA && SAFE_ID.test(value.recoveryId), "Schema-29-Odoo-Filestore-Seal-Beleg besitzt keinen gueltigen Vertrag.");
  invariant(value.finalFilestoreTreeSha256 === value.baselineFilestoreTreeSha256, "Schema-29-Odoo-Filestore-Seal-Beleg meldet einen finalen Baumdrift.");
  invariant(Number.isSafeInteger(value.ownerUid) && value.ownerUid > 0 && Number.isSafeInteger(value.ownerGid) && value.ownerGid > 0 && Number.isSafeInteger(value.fileCount) && value.fileCount >= 0, "Schema-29-Odoo-Filestore-Seal-Beleg besitzt keine sichere Owner-/Dateibindung.");
  for (const hash of [value.baselineFilestoreTreeSha256, value.finalAccessSha256, value.finalFilestoreTreeSha256, value.odooProbeReceiptHash, value.odooProbeReceiptSha256, value.openReceiptHash, value.openReceiptSha256, value.receiptHash]) invariant(SHA256.test(hash), "Schema-29-Odoo-Filestore-Seal-Beleg besitzt einen ungueltigen SHA-256.");
  canonicalInstant(value.sealedAt, "Schema-29-Odoo-Filestore-Seal-Zeitpunkt");
  for (const key of ["recoveryId", "baselineFilestoreTreeSha256", "openReceiptHash", "odooProbeReceiptHash", "ownerUid", "ownerGid"]) if (expected[key] !== undefined) invariant(value[key] === expected[key], `Schema-29-Odoo-Filestore-Seal-Beleg bindet ${key} nicht.`);
  const { receiptHash, ...payload } = value;
  invariant(receiptHash === canonicalSha256(payload), "Schema-29-Odoo-Filestore-Seal-Beleg besitzt keinen kanonischen Receipt-Hash.");
  return value;
}

export async function readSchema29OdooFilestoreOpenReceipt(path, expected = {}) {
  const artifact = await stableJson(path, "Schema-29-Odoo-Filestore-Open-Beleg");
  return Object.freeze({ artifact, receipt: validateSchema29OdooFilestoreOpenReceipt(artifact.value, expected) });
}

export async function readSchema29OdooFilestoreSealReceipt(path, expected = {}) {
  const artifact = await stableJson(path, "Schema-29-Odoo-Filestore-Seal-Beleg");
  return Object.freeze({ artifact, receipt: validateSchema29OdooFilestoreSealReceipt(artifact.value, expected) });
}

export async function openSchema29OdooFilestore({ environment = process.env, now = () => new Date() } = {}) {
  const configuration = accessEnvironment(environment);
  const outputPath = await containedOutput(configuration.evidenceRoot, configuration.openOutputPath, "Schema-29-Odoo-Filestore-Open-Beleg");
  const root = await boundFilestorePath(configuration);
  const { artifact: beforeArtifact, receipt: before } = await readProductionSchema29RuntimeBeforeReceipt(configuration.runtimeBeforePath, { recoveryId: configuration.recoveryId });
  const initial = await collectFilestoreEntries(root, configuration.owner, { expectedAccess: "read-only", strictPaths: true });
  invariant(initial.treeSha256 === before.odooFilestoreTreeSha256, "Schema-29-Odoo-Runtime-Filestore weicht vor dem Oeffnen vom gebundenen Before-Baum ab.");
  let opened;
  try {
    await setFilestoreAccess(root, configuration.owner, true);
    opened = await collectFilestoreEntries(root, configuration.owner, { expectedAccess: "owner-writable", strictPaths: true });
    invariant(opened.treeSha256 === initial.treeSha256 && opened.fileCount === initial.fileCount, "Schema-29-Odoo-Runtime-Filestore driftete beim Oeffnen.");
    const payload = {
      baselineFilestoreTreeSha256: initial.treeSha256,
      beforeAccessSha256: initial.accessSha256,
      fileCount: initial.fileCount,
      openedAccessSha256: opened.accessSha256,
      openedAt: now().toISOString(),
      ownerGid: configuration.owner.gid,
      ownerUid: configuration.owner.uid,
      recoveryId: configuration.recoveryId,
      runtimeBeforeReceiptHash: before.receiptHash,
      runtimeBeforeReceiptSha256: beforeArtifact.sha256,
      schema: OPEN_SCHEMA,
    };
    const receipt = validateSchema29OdooFilestoreOpenReceipt({ ...payload, receiptHash: canonicalSha256(payload) });
    await assertProductionSchema29RuntimeBeforeReceiptUnchanged(beforeArtifact);
    await publishCreateNew(outputPath, receipt);
    return Object.freeze({ outputPath, receiptHash: receipt.receiptHash });
  } catch (error) {
    try { await setFilestoreAccess(root, configuration.owner, false); } catch (resealError) {
      throw new AggregateError([error, resealError], "Schema-29-Odoo-Filestore konnte nach fehlgeschlagenem Oeffnen nicht sicher versiegelt werden.");
    }
    throw error;
  }
}

export async function sealSchema29OdooFilestore({ environment = process.env, now = () => new Date() } = {}) {
  const configuration = accessEnvironment(environment);
  const outputPath = await containedOutput(configuration.evidenceRoot, configuration.sealOutputPath, "Schema-29-Odoo-Filestore-Seal-Beleg");
  const root = await boundFilestorePath(configuration);
  let openArtifact;
  let openReceipt;
  let probeArtifact;
  let probe;
  let validationError;
  try {
    ({ artifact: openArtifact, receipt: openReceipt } = await readSchema29OdooFilestoreOpenReceipt(configuration.openReceiptPath, {
      recoveryId: configuration.recoveryId,
      ownerGid: configuration.owner.gid,
      ownerUid: configuration.owner.uid,
    }));
    probeArtifact = await stableJson(configuration.probePath, "Legacy-Odoo-Schema-29-Filestore-Probe");
    probe = validateLegacyOdooSchema29WriteProbe(probeArtifact.value, {
      databaseName: configuration.databaseName,
      filestoreBeforeTreeSha256: openReceipt.baselineFilestoreTreeSha256,
      recoveryId: configuration.recoveryId,
    });
  } catch (error) {
    validationError = error;
  }
  try {
    await setFilestoreAccess(root, configuration.owner, false);
  } catch (resealError) {
    if (validationError !== undefined) throw new AggregateError([validationError, resealError], "Schema-29-Odoo-Filestore-Beleg war ungueltig und der Baum konnte nicht versiegelt werden.");
    throw resealError;
  }
  if (validationError !== undefined) throw validationError;
  const final = await collectFilestoreEntries(root, configuration.owner, { expectedAccess: "read-only", strictPaths: true });
  invariant(final.treeSha256 === openReceipt.baselineFilestoreTreeSha256 && probe.filestoreFinalTreeSha256 === final.treeSha256, "Schema-29-Odoo-Runtime-Filestore besitzt nach Cleanup einen finalen Baumdrift.");
  invariant(final.fileCount === openReceipt.fileCount, "Schema-29-Odoo-Runtime-Filestore besitzt nach Cleanup eine andere Dateimenge.");
  const payload = {
    baselineFilestoreTreeSha256: openReceipt.baselineFilestoreTreeSha256,
    fileCount: final.fileCount,
    finalAccessSha256: final.accessSha256,
    finalFilestoreTreeSha256: final.treeSha256,
    odooProbeReceiptHash: probe.receiptHash,
    odooProbeReceiptSha256: probeArtifact.sha256,
    openReceiptHash: openReceipt.receiptHash,
    openReceiptSha256: openArtifact.sha256,
    ownerGid: configuration.owner.gid,
    ownerUid: configuration.owner.uid,
    recoveryId: configuration.recoveryId,
    schema: SEAL_SCHEMA,
    sealedAt: now().toISOString(),
  };
  const receipt = validateSchema29OdooFilestoreSealReceipt({ ...payload, receiptHash: canonicalSha256(payload) });
  await Promise.all([
    assertJsonUnchanged(openArtifact, "Schema-29-Odoo-Filestore-Open-Beleg"),
    assertJsonUnchanged(probeArtifact, "Legacy-Odoo-Schema-29-Filestore-Probe"),
  ]);
  await publishCreateNew(outputPath, receipt);
  return Object.freeze({ outputPath, receiptHash: receipt.receiptHash });
}

export async function emergencyResealSchema29OdooFilestore({ environment = process.env } = {}) {
  const configuration = accessEnvironment(environment);
  const root = await boundFilestorePath(configuration);
  await setFilestoreAccess(root, configuration.owner, false);
  const final = await collectFilestoreEntries(root, configuration.owner, { expectedAccess: "read-only", strictPaths: false });
  return Object.freeze({ accessSha256: final.accessSha256, fileCount: final.fileCount, treeSha256: final.treeSha256 });
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const action = process.argv[2];
    invariant(process.argv.length === 3 && ["emergency-reseal", "open", "seal"].includes(action), "Aufruf: schema29-odoo-filestore-access.mjs <open|seal|emergency-reseal>");
    const result = action === "open"
      ? await openSchema29OdooFilestore()
      : action === "seal"
        ? await sealSchema29OdooFilestore()
        : await emergencyResealSchema29OdooFilestore();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 65;
  }
}

export const SCHEMA29_ODOO_FILESTORE_OPEN_SCHEMA = OPEN_SCHEMA;
export const SCHEMA29_ODOO_FILESTORE_SEAL_SCHEMA = SEAL_SCHEMA;
