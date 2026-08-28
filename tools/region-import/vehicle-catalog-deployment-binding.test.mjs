import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import {
  alphaWorldGenerationSourcesSha256,
  assertVehicleCatalogProofInputs,
  bindVehicleCatalogDeploymentArtifacts,
  compilerFleetFormations,
  compilerPrettyJsonSha256,
  selectVehicleCatalogAuthority,
  verifyVehicleCatalogCompilerReplay,
} from "./vehicle-catalog-deployment-binding.mjs";

const FIXTURES = new URL("../../crates/zugfolge-fleet/tests/fixtures/", import.meta.url);
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
let generatedRoot;
let generatedOutput;

async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, FIXTURES), "utf8"));
}

async function generatedCompilerOutput() {
  if (generatedOutput !== undefined) return generatedOutput;
  generatedRoot = await mkdtemp(join(tmpdir(), "zugfolge-vehicle-binder-test-"));
  generatedOutput = join(generatedRoot, "output");
  const result = spawnSync(
    "cargo",
    [
      "run", "-q", "-p", "zugfolge-fleet", "--bin", "zugfolge-vehicle-catalog", "--",
      fileURLToPath(new URL("vehicle-catalog-source-v2.json", FIXTURES)),
      fileURLToPath(new URL("vehicle-world-seed-v3.json", FIXTURES)),
      generatedOutput,
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return generatedOutput;
}

after(async () => {
  if (generatedRoot !== undefined) await rm(generatedRoot, { recursive: true, force: true });
});

function changed(value, edit) {
  const copy = structuredClone(value);
  edit(copy);
  return copy;
}

async function inputs() {
  const [fleetCatalog, receipt, operationalInventory] = await Promise.all([
    fixture("fleet-authority-release-catalog-v1.json"),
    fixture("vehicle-catalog-compile-receipt-v4.json"),
    fixture("operational-vehicle-inventory-v2.json"),
  ]);
  const entry = fleetCatalog.entries[0];
  const output = await generatedCompilerOutput();
  const compilerEvidence = await verifyVehicleCatalogCompilerReplay({
    sourceCatalogPath: fileURLToPath(new URL("vehicle-catalog-source-v2.json", FIXTURES)),
    worldSeedPath: fileURLToPath(new URL("vehicle-world-seed-v3.json", FIXTURES)),
    compiledCatalogPath: join(output, "vehicle-catalog-v3.json"),
    fleetCatalogPath: fileURLToPath(new URL("fleet-authority-release-catalog-v1.json", FIXTURES)),
    operationalInventoryPath: fileURLToPath(new URL("operational-vehicle-inventory-v2.json", FIXTURES)),
    receiptPath: fileURLToPath(new URL("vehicle-catalog-compile-receipt-v4.json", FIXTURES)),
    fleetAuthority: entry.authorityRelease,
  });
  const fleet = {
    schemaVersion: "zugfolge-fleet-world-initialize/v2",
    worldId: entry.worldId,
    producedAt: entry.producedAt,
    authorityRelease: entry.authorityRelease,
    formations: compilerFleetFormations(operationalInventory),
  };
  const regionalSimulation = {
    vehicleTypes: operationalInventory.vehicleTypes,
    vehicles: operationalInventory.vehicles,
    formations: operationalInventory.formations.map((formation) => ({
      id: formation.id,
      predecessorId: formation.predecessorId ?? null,
      vehicleIds: formation.vehicleIds,
    })),
  };
  return {
    fleetCatalog,
    receipt,
    operationalInventory,
    fleet,
    regionalSimulation,
    economyRelease: {
      version: receipt.economyReleaseId,
      checksum: receipt.economyReleaseSha256,
    },
    blueprintFleetHash: compilerEvidence.runtimeAuthorityReleaseHash,
    compilerEvidence,
  };
}

test("Build-Binder akzeptiert exakt den echten Rust-Compiler-Ausgabesatz", async () => {
  const input = await inputs();
  assert.equal(
    compilerPrettyJsonSha256(input.fleetCatalog),
    input.receipt.fleetAuthorityCatalogSha256,
  );
  assert.equal(Object.hasOwn(input.fleet.formations[0], "dynamics"), false);
  assert.match(input.compilerEvidence.runtimeAuthorityReleaseHash, /^[a-f0-9]{64}$/u);
  assert.doesNotThrow(() => bindVehicleCatalogDeploymentArtifacts(input));
});

test("Rust-Replay verweigert frei ersetzte und neu versiegelte Receipt-Eingabehashes", async () => {
  const output = await generatedCompilerOutput();
  const [fleetCatalog, receipt] = await Promise.all([
    fixture("fleet-authority-release-catalog-v1.json"),
    fixture("vehicle-catalog-compile-receipt-v4.json"),
  ]);
  receipt.sourceCatalogSha256 = "1".repeat(64);
  receipt.worldSeedSha256 = "2".repeat(64);
  receipt.economyProjectionSha256 = "3".repeat(64);
  receipt.compiledCatalogSha256 = "4".repeat(64);
  receipt.outputSetSha256 = compilerPrettyJsonSha256({
    schemaVersion: receipt.schemaVersion,
    compilerVersion: receipt.compilerVersion,
    sourceCatalogReleaseId: receipt.sourceCatalogReleaseId,
    worldSeedId: receipt.worldSeedId,
    worldId: receipt.worldId,
    producedAt: receipt.producedAt,
    economyReleaseId: receipt.economyReleaseId,
    sourceCatalogSha256: receipt.sourceCatalogSha256,
    worldSeedSha256: receipt.worldSeedSha256,
    economyReleaseSha256: receipt.economyReleaseSha256,
    economyProjectionSha256: receipt.economyProjectionSha256,
    compiledCatalogSha256: receipt.compiledCatalogSha256,
    fleetAuthoritySha256: receipt.fleetAuthoritySha256,
    fleetAuthorityCatalogSha256: receipt.fleetAuthorityCatalogSha256,
    operationalInventorySha256: receipt.operationalInventorySha256,
  });
  const forgedReceiptPath = join(generatedRoot, "forged-receipt.json");
  await writeFile(forgedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");

  await assert.rejects(() => verifyVehicleCatalogCompilerReplay({
    sourceCatalogPath: fileURLToPath(new URL("vehicle-catalog-source-v2.json", FIXTURES)),
    worldSeedPath: fileURLToPath(new URL("vehicle-world-seed-v3.json", FIXTURES)),
    compiledCatalogPath: join(output, "vehicle-catalog-v3.json"),
    fleetCatalogPath: fileURLToPath(new URL("fleet-authority-release-catalog-v1.json", FIXTURES)),
    operationalInventoryPath: fileURLToPath(new URL("operational-vehicle-inventory-v2.json", FIXTURES)),
    receiptPath: forgedReceiptPath,
    fleetAuthority: fleetCatalog.entries[0].authorityRelease,
  }), /nicht bytegleich/u);
});

test("Build-Binder verweigert Seed-Zeit, Economy, Operational und OutputSet separat", async () => {
  const input = await inputs();
  for (const changed of [
    { ...input, fleet: { ...input.fleet, producedAt: 0 } },
    { ...input, economyRelease: { ...input.economyRelease, checksum: "0".repeat(64) } },
    {
      ...input,
      regionalSimulation: {
        ...input.regionalSimulation,
        vehicles: [{ ...input.regionalSimulation.vehicles[0], orientation: "against" }],
      },
    },
    {
      ...input,
      receipt: { ...input.receipt, outputSetSha256: "0".repeat(64) },
    },
    { ...input, blueprintFleetHash: "0".repeat(64) },
    {
      ...input,
      fleet: {
        ...input.fleet,
        formations: input.fleet.formations.map((formation) => ({
          ...formation,
          dynamics: { accelerationMmPerS2: 1_000, decelerationMmPerS2: 900 },
        })),
      },
    },
  ]) {
    assert.throws(() => bindVehicleCatalogDeploymentArtifacts(changed));
  }
});

test("CLI-Gate verlangt fuer v2 alle fuenf Beweise und fuer v1 keinen", () => {
  const v1 = "zugfolge-fleet-authority-release/v1";
  const v2 = "zugfolge-fleet-authority-release/v2";
  const receipt = Buffer.from("receipt");
  const inventory = Buffer.from("inventory");
  const source = Buffer.from("source");
  const seed = Buffer.from("seed");
  const compiled = Buffer.from("compiled");

  assert.equal(assertVehicleCatalogProofInputs(v1, undefined, undefined, undefined, undefined, undefined), false);
  assert.equal(assertVehicleCatalogProofInputs(v2, receipt, inventory, source, seed, compiled), true);
  for (const args of [
    [v1, receipt, undefined, undefined, undefined, undefined],
    [v1, receipt, inventory, source, seed, compiled],
    [v2, undefined, undefined, undefined, undefined, undefined],
    [v2, receipt, inventory, source, seed, undefined],
    [v2, receipt, inventory, source, undefined, compiled],
  ]) {
    assert.throws(() => assertVehicleCatalogProofInputs(...args));
  }
  assert.throws(() => assertVehicleCatalogProofInputs("zugfolge-fleet-authority-release/v99", undefined, undefined, undefined, undefined, undefined));
});

test("Legacy-v1-Vorlagen brauchen keinen Eintrag fuer die neu gebaute Welt", () => {
  const legacy = {
    schemaVersion: "zugfolge-fleet-authority-release-catalog/v1",
    entries: [{
      worldId: "00000000-0000-4000-8000-000000000999",
      authorityRelease: { schemaVersion: "zugfolge-fleet-authority-release/v1" },
    }],
  };
  const selected = selectVehicleCatalogAuthority(
    legacy,
    "00000000-0000-4000-8000-000000000014",
  );
  assert.equal(selected.schemaVersion, "zugfolge-fleet-authority-release/v1");
  assert.equal(selected.entry, undefined);
});

test("Generatorprovenienz bindet Hauptskript, Binder und Fleet-v2-Migrationscompiler", () => {
  const main = Buffer.from("build-alpha-world:v1", "utf8");
  const binder = Buffer.from("vehicle-binder:v1", "utf8");
  const migration = Buffer.from("fleet-migration:v1", "utf8");
  const baseline = alphaWorldGenerationSourcesSha256(main, binder, migration);

  assert.equal(alphaWorldGenerationSourcesSha256(main, binder, migration), baseline);
  assert.notEqual(
    alphaWorldGenerationSourcesSha256(main, Buffer.from("vehicle-binder:manipulated", "utf8"), migration),
    baseline,
  );
  assert.notEqual(
    alphaWorldGenerationSourcesSha256(Buffer.from("build-alpha-world:manipulated", "utf8"), binder, migration),
    baseline,
  );
  assert.notEqual(
    alphaWorldGenerationSourcesSha256(main, binder, Buffer.from("fleet-migration:manipulated", "utf8")),
    baseline,
  );
  assert.throws(() => alphaWorldGenerationSourcesSha256(main, binder), /Migrationscompiler/u);
});

test("Pre-Sign-Binder prueft Receipt, Inventar und Formationsperformance exakt", async () => {
  const input = await inputs();
  const mutations = [
    {
      expected: /exakt/u,
      value: { ...input, receipt: changed(input.receipt, (receipt) => { receipt.forged = true; }) },
    },
    {
      expected: /exakt/u,
      value: { ...input, receipt: changed(input.receipt, (receipt) => { delete receipt.worldSeedId; }) },
    },
    {
      expected: /sichere nichtnegative Ganzzahl/u,
      value: { ...input, receipt: changed(input.receipt, (receipt) => { receipt.producedAt = Number.MAX_SAFE_INTEGER + 1; }) },
    },
    {
      expected: /SHA-256/u,
      value: { ...input, receipt: changed(input.receipt, (receipt) => { receipt.outputSetSha256 = "G".repeat(64); }) },
    },
    {
      expected: /exakt/u,
      value: { ...input, operationalInventory: changed(input.operationalInventory, (inventory) => { inventory.forged = true; }) },
    },
    {
      expected: /muss eine Liste/u,
      value: { ...input, operationalInventory: changed(input.operationalInventory, (inventory) => { inventory.vehicleTypes = {}; }) },
    },
    {
      expected: /exakt/u,
      value: { ...input, operationalInventory: changed(input.operationalInventory, (inventory) => { inventory.formations[0].forged = true; }) },
    },
    {
      expected: /exakt/u,
      value: { ...input, operationalInventory: changed(input.operationalInventory, (inventory) => { delete inventory.formations[0].performance.mobile; }) },
    },
    {
      expected: /boolesch/u,
      value: { ...input, operationalInventory: changed(input.operationalInventory, (inventory) => { inventory.formations[0].performance.mobile = "true"; }) },
    },
    {
      expected: /sichere nichtnegative Ganzzahl/u,
      value: { ...input, operationalInventory: changed(input.operationalInventory, (inventory) => { inventory.formations[0].performance.accelerationMmps2 = Number.MAX_SAFE_INTEGER + 1; }) },
    },
    {
      expected: /positive Fahrdynamik/u,
      value: { ...input, operationalInventory: changed(input.operationalInventory, (inventory) => { inventory.formations[0].performance.accelerationMmps2 = 0; }) },
    },
  ];

  for (const mutation of mutations) {
    assert.throws(() => bindVehicleCatalogDeploymentArtifacts(mutation.value), mutation.expected);
  }
});
