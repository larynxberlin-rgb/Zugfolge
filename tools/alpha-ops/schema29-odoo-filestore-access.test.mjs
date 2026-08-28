import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectSchema29OdooFilestore,
  openSchema29OdooFilestore,
  sealSchema29OdooFilestore,
  validateLegacyOdooSchema29WriteProbe,
  validateSchema29OdooFilestoreSealReceipt,
} from "./schema29-odoo-filestore-access.mjs";

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  return value;
}

function canonicalSha256(value) {
  return createHash("sha256").update(JSON.stringify(sortedValue(value))).digest("hex");
}

function probeReceipt(overrides = {}) {
  const baseline = "a".repeat(64);
  const blob = "b".repeat(64);
  const payload = {
    blobBytes: 73,
    blobRelativePath: `ab/${"c".repeat(40)}`,
    blobSha256: blob,
    cleanupComplete: true,
    createdFileCount: 1,
    databaseName: "zugfolge_odoo_recovery_v1_schema29_runtime_test",
    directReadSha256: blob,
    filestoreBeforeTreeSha256: baseline,
    filestoreFinalTreeSha256: baseline,
    filestoreWrittenTreeSha256: "d".repeat(64),
    fsynced: true,
    legacyOdooImageDigest: `sha256:${"e".repeat(64)}`,
    odooReadSha256: blob,
    recoveryId: "rollback-2026.4-001",
    rolledBack: true,
    schema: "zugfolge-legacy-odoo-schema29-write-probe/v2",
    temporaryAttachmentId: 43,
    temporaryRecordId: 42,
    ...overrides,
  };
  return { ...payload, receiptHash: canonicalSha256(payload) };
}

test("legacy Odoo probe cleanup helpers pass their Python negative matrix", { skip: process.platform === "win32" }, () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./legacy-schema29-odoo-write-probe.test.py", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("legacy Odoo v2 probe requires a real fsynced attachment write and exact cleanup", () => {
  const receipt = validateLegacyOdooSchema29WriteProbe(probeReceipt());
  assert.equal(receipt.createdFileCount, 1);
  assert.throws(() => validateLegacyOdooSchema29WriteProbe(probeReceipt({ cleanupComplete: false })), /Cleanup/u);
  assert.throws(() => validateLegacyOdooSchema29WriteProbe(probeReceipt({ filestoreFinalTreeSha256: "f".repeat(64) })), /Schreib- und Cleanup-Zyklus/u);
  assert.throws(() => validateLegacyOdooSchema29WriteProbe(probeReceipt({ blobRelativePath: "../escape" })), /Hashpfad/u);
});

test("seal receipt rejects final tree drift", () => {
  const payload = {
    baselineFilestoreTreeSha256: "a".repeat(64),
    fileCount: 1,
    finalAccessSha256: "b".repeat(64),
    finalFilestoreTreeSha256: "c".repeat(64),
    odooProbeReceiptHash: "d".repeat(64),
    odooProbeReceiptSha256: "e".repeat(64),
    openReceiptHash: "f".repeat(64),
    openReceiptSha256: "0".repeat(64),
    ownerGid: 101,
    ownerUid: 100,
    recoveryId: "rollback-2026.4-001",
    schema: "zugfolge-schema29-odoo-filestore-seal/v1",
    sealedAt: "2026-08-26T10:02:00.000Z",
  };
  assert.throws(
    () => validateSchema29OdooFilestoreSealReceipt({ ...payload, receiptHash: canonicalSha256(payload) }),
    /finalen Baumdrift/u,
  );
});

test("open and seal are create-new, receipt-bound mode transitions around an unchanged baseline tree", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-schema29-odoo-cycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = join(directory, "evidence");
  const filestoreRoot = join(directory, "filestores");
  const database = "zugfolge_odoo_recovery_v1_schema29_runtime_test";
  const filestore = join(filestoreRoot, database);
  await mkdir(evidence);
  await mkdir(filestore, { recursive: true });
  let owner = await lstat(filestore);
  if (owner.uid === 0 || owner.gid === 0) {
    await chown(filestore, 1000, 1000);
    owner = await lstat(filestore);
  }
  await chmod(filestore, 0o500);
  const baseline = createHash("sha256").update("").digest("hex");
  const previousWorldId = "00000000-0000-4000-8000-000000000014";
  const heads = [{
    publisherSequence: "10", regionId: "de-sn-leipzig", revision: "10", stateHash: "1".repeat(64),
    updatedAt: "2026-08-26T10:00:00.000Z", worldId: previousWorldId,
  }];
  const beforePayload = {
    baselineReceiptHash: "2".repeat(64), baselineReceiptSha256: "3".repeat(64),
    candidateReleaseId: "infra-deutschland-2026.4", capturedAt: "2026-08-26T10:00:10.000Z",
    gameRestoreBackendSha256: "4".repeat(64), gameRestoreEndpointSha256: "5".repeat(64),
    gameRestoreReceiptSha256: "6".repeat(64), gameRestoreStateSha256: "7".repeat(64),
    heads, headsSha256: canonicalSha256(heads), odooFilestoreTreeSha256: baseline,
    odooRestoreEndpointSha256: "8".repeat(64), odooRestoreReceiptSha256: "9".repeat(64),
    odooRestoreStateSha256: "a".repeat(64), previousReleaseId: "infra-deutschland-2026.2",
    previousWorldId, recoveryId: "rollback-2026.4-001", schema: "zugfolge-production-schema29-runtime-before/v1",
  };
  const beforePath = join(evidence, "rollback-2026.4-001.schema29-runtime-before.json");
  await writeFile(beforePath, `${JSON.stringify({ ...beforePayload, receiptHash: canonicalSha256(beforePayload) })}\n`);
  const openPath = join(evidence, "rollback-2026.4-001.schema29-odoo-filestore-open.json");
  const sealPath = join(evidence, "rollback-2026.4-001.schema29-odoo-filestore-seal.json");
  const probePath = join(evidence, "rollback-2026.4-001.schema29-odoo-runtime-write.json");
  const environment = {
    PRODUCTION_RECOVERY_EVIDENCE_ROOT: evidence,
    PRODUCTION_RECOVERY_ID: "rollback-2026.4-001",
    PRODUCTION_RECOVERY_ODOO_RUNTIME_GID: String(owner.gid),
    PRODUCTION_RECOVERY_ODOO_RUNTIME_UID: String(owner.uid),
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_OPEN_OUTPUT_PATH: openPath,
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_OPEN_RECEIPT_PATH: openPath,
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_ROOT: filestoreRoot,
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_SEAL_OUTPUT_PATH: sealPath,
    PRODUCTION_SCHEMA29_ODOO_LEGACY_PROBE_PATH: probePath,
    PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH: filestore,
    PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE: database,
    PRODUCTION_SCHEMA29_RUNTIME_BEFORE_RECEIPT_PATH: beforePath,
  };

  await openSchema29OdooFilestore({ environment, now: () => new Date("2026-08-26T10:00:20.000Z") });
  const writable = await inspectSchema29OdooFilestore(filestore, { expectedAccess: "owner-writable", expectedGid: owner.gid, expectedUid: owner.uid });
  assert.equal(writable.treeSha256, baseline);
  await writeFile(probePath, `${JSON.stringify(probeReceipt({ filestoreBeforeTreeSha256: baseline, filestoreFinalTreeSha256: baseline }))}\n`);
  await sealSchema29OdooFilestore({ environment, now: () => new Date("2026-08-26T10:00:30.000Z") });
  const readOnly = await inspectSchema29OdooFilestore(filestore, { expectedAccess: "read-only", expectedGid: owner.gid, expectedUid: owner.uid });
  assert.equal(readOnly.treeSha256, baseline);
  assert.equal(JSON.parse(await readFile(sealPath, "utf8")).finalFilestoreTreeSha256, baseline);
  await assert.rejects(openSchema29OdooFilestore({ environment }), /create-new/u);
});

test("filestore inspection distinguishes RO despite RW mount, exact owner and symlinks", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-schema29-odoo-access-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = "zugfolge_odoo_recovery_v1_schema29_runtime_test";
  const filestore = join(directory, database);
  const bucket = join(filestore, "ab");
  const blob = join(bucket, "c".repeat(40));
  await mkdir(bucket, { recursive: true });
  await writeFile(blob, "baseline");
  const owner = await lstat(filestore);
  await chmod(blob, 0o400);
  await chmod(bucket, 0o500);
  await chmod(filestore, 0o500);

  const readOnly = await inspectSchema29OdooFilestore(filestore, { expectedAccess: "read-only", expectedGid: owner.gid, expectedUid: owner.uid });
  assert.equal(readOnly.access, "read-only");
  await assert.rejects(
    inspectSchema29OdooFilestore(filestore, { expectedAccess: "owner-writable", expectedGid: owner.gid, expectedUid: owner.uid }),
    /trotz RW-Mount/u,
  );

  await chmod(filestore, 0o700);
  await chmod(bucket, 0o700);
  await chmod(blob, 0o600);
  const writable = await inspectSchema29OdooFilestore(filestore, { expectedAccess: "owner-writable", expectedGid: owner.gid, expectedUid: owner.uid });
  assert.equal(writable.treeSha256, readOnly.treeSha256);
  await assert.rejects(
    inspectSchema29OdooFilestore(filestore, { expectedAccess: "owner-writable", expectedGid: owner.gid, expectedUid: owner.uid + 1 }),
    /Runtime-Owner/u,
  );

  await symlink(blob, join(filestore, "cd"));
  await assert.rejects(
    inspectSchema29OdooFilestore(filestore, { expectedAccess: "owner-writable", expectedGid: owner.gid, expectedUid: owner.uid }),
    /Symlink/u,
  );
});

test("open action rejects a traversing filestore target before reading evidence", { skip: process.platform === "win32" }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zugfolge-schema29-odoo-traversal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = join(directory, "evidence");
  const filestoreRoot = join(directory, "filestores");
  const database = "zugfolge_odoo_recovery_v1_schema29_runtime_test";
  await mkdir(evidence);
  await mkdir(join(filestoreRoot, database), { recursive: true });
  await mkdir(join(directory, "outside"));
  const owner = await lstat(join(filestoreRoot, database));
  const environment = {
    PRODUCTION_RECOVERY_EVIDENCE_ROOT: evidence,
    PRODUCTION_RECOVERY_ID: "rollback-2026.4-001",
    PRODUCTION_RECOVERY_ODOO_RUNTIME_GID: String(owner.gid),
    PRODUCTION_RECOVERY_ODOO_RUNTIME_UID: String(owner.uid),
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_OPEN_OUTPUT_PATH: join(evidence, "rollback-2026.4-001.schema29-odoo-filestore-open.json"),
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_OPEN_RECEIPT_PATH: join(evidence, "rollback-2026.4-001.schema29-odoo-filestore-open.json"),
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_ROOT: filestoreRoot,
    PRODUCTION_SCHEMA29_ODOO_FILESTORE_SEAL_OUTPUT_PATH: join(evidence, "rollback-2026.4-001.schema29-odoo-filestore-seal.json"),
    PRODUCTION_SCHEMA29_ODOO_LEGACY_PROBE_PATH: join(evidence, "probe.json"),
    PRODUCTION_SCHEMA29_ODOO_RESTORED_FILESTORE_PATH: join(filestoreRoot, database, "..", "..", "outside"),
    PRODUCTION_SCHEMA29_ODOO_RESTORE_DATABASE: database,
    PRODUCTION_SCHEMA29_RUNTIME_BEFORE_RECEIPT_PATH: join(evidence, "before.json"),
  };
  await assert.rejects(openSchema29OdooFilestore({ environment }), /direkte Kind/u);
});
