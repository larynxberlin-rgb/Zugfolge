import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { alphaCanonicalJson, alphaHash } from "../../packages/alpha/dist/index.js";

export const VEHICLE_CATALOG_DEPLOYMENT_BINDING_SCHEMA = "zugfolge-vehicle-catalog-deployment-binding/v1";
const RECEIPT_SCHEMA = "zugfolge-vehicle-catalog-compile-receipt/v4";
const COMPILER_VERSION = "zugfolge-vehicle-catalog-compiler/v4";
const INVENTORY_SCHEMA = "zugfolge-operational-vehicle-inventory/v2";
const WRAPPER_SCHEMA = "zugfolge-fleet-authority-release-catalog/v1";
const AUTHORITY_SCHEMA_V1 = "zugfolge-fleet-authority-release/v1";
const AUTHORITY_SCHEMA_V2 = "zugfolge-fleet-authority-release/v2";
const GENERATION_SOURCES_SCHEMA = "zugfolge-alpha-world-generation-sources/v2";
const COMPILER_INPUTS_SCHEMA = "zugfolge-vehicle-catalog-compiler-input-files/v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VERIFIED_COMPILER_EVIDENCE = new WeakSet();
const COMPILER_OUTPUT_FILES = Object.freeze({
  compiledCatalog: "vehicle-catalog-v3.json",
  fleetAuthority: "fleet-authority-release-v2.json",
  fleetCatalog: "fleet-authority-release-catalog-v1.json",
  operationalInventory: "operational-vehicle-inventory-v2.json",
  receipt: "vehicle-catalog-compile-receipt-v4.json",
});

const RECEIPT_FIELDS = [
  "schemaVersion",
  "compilerVersion",
  "sourceCatalogReleaseId",
  "worldSeedId",
  "worldId",
  "producedAt",
  "economyReleaseId",
  "economyReleaseSha256",
  "economyProjectionSha256",
  "sourceCatalogSha256",
  "worldSeedSha256",
  "compiledCatalogSha256",
  "fleetAuthoritySha256",
  "fleetAuthorityCatalogSha256",
  "operationalInventorySha256",
  "outputSetSha256",
];
const RECEIPT_HASH_FIELDS = [
  "economyReleaseSha256",
  "economyProjectionSha256",
  "sourceCatalogSha256",
  "worldSeedSha256",
  "compiledCatalogSha256",
  "fleetAuthoritySha256",
  "fleetAuthorityCatalogSha256",
  "operationalInventorySha256",
  "outputSetSha256",
];
const INVENTORY_FIELDS = [
  "schemaVersion",
  "releaseId",
  "worldId",
  "catalogReleaseId",
  "vehicleTypes",
  "vehicles",
  "formations",
];
const FORMATION_FIELDS = ["id", "vehicleIds", "pathReceiptId", "performance"];
const PERFORMANCE_FIELDS = [
  "lengthMm",
  "massKg",
  "maximumSpeedMmps",
  "powerWatts",
  "accelerationMmps2",
  "serviceBrakeMmps2",
  "emergencyBrakeMmps2",
  "frontControlStandAvailable",
  "rearControlStandAvailable",
  "protectionSystems",
  "mobile",
];

function invariant(condition, message) {
  if (!condition) throw new Error(`Fahrzeugkatalog-Deployment-Bindung: ${message}`);
}

function exactRecord(value, name, required, optional = []) {
  invariant(typeof value === "object" && value !== null && !Array.isArray(value), `${name} muss ein Objekt sein.`);
  const allowed = new Set([...required, ...optional]);
  invariant(
    required.every((field) => Object.hasOwn(value, field))
      && Object.keys(value).every((field) => allowed.has(field)),
    `${name} besitzt nicht exakt die erwarteten Felder.`,
  );
  return value;
}

function nonEmptyString(value, name) {
  invariant(typeof value === "string" && value.trim() !== "" && value.trim() === value, `${name} muss eine nichtleere randfreie Zeichenkette sein.`);
  return value;
}

function safeNonNegativeInteger(value, name) {
  invariant(Number.isSafeInteger(value) && value >= 0, `${name} muss eine sichere nichtnegative Ganzzahl sein.`);
  return value;
}

function sha256Value(value, name) {
  invariant(typeof value === "string" && SHA256_PATTERN.test(value), `${name} muss ein kleingeschriebener SHA-256 sein.`);
  return value;
}

function parseReceipt(value) {
  const receipt = exactRecord(value, "receipt", RECEIPT_FIELDS);
  invariant(receipt.schemaVersion === RECEIPT_SCHEMA, "receipt.schemaVersion ist unbekannt.");
  invariant(receipt.compilerVersion === COMPILER_VERSION, "receipt.compilerVersion ist unbekannt.");
  for (const field of ["sourceCatalogReleaseId", "worldSeedId", "worldId", "economyReleaseId"]) {
    nonEmptyString(receipt[field], `receipt.${field}`);
  }
  safeNonNegativeInteger(receipt.producedAt, "receipt.producedAt");
  for (const field of RECEIPT_HASH_FIELDS) sha256Value(receipt[field], `receipt.${field}`);
  return receipt;
}

function parsedFormations(inventory) {
  return inventory.formations.map((value, index) => {
    const name = `operationalInventory.formations[${index}]`;
    const formation = exactRecord(value, name, FORMATION_FIELDS, ["predecessorId"]);
    nonEmptyString(formation.id, `${name}.id`);
    nonEmptyString(formation.pathReceiptId, `${name}.pathReceiptId`);
    invariant(Array.isArray(formation.vehicleIds), `${name}.vehicleIds muss eine Liste sein.`);
    const performance = exactRecord(formation.performance, `${name}.performance`, PERFORMANCE_FIELDS);
    invariant(typeof performance.mobile === "boolean", `${name}.performance.mobile muss boolesch sein.`);
    const acceleration = safeNonNegativeInteger(
      performance.accelerationMmps2,
      `${name}.performance.accelerationMmps2`,
    );
    const serviceBrake = safeNonNegativeInteger(
      performance.serviceBrakeMmps2,
      `${name}.performance.serviceBrakeMmps2`,
    );
    if (performance.mobile) {
      invariant(acceleration > 0 && serviceBrake > 0, `${name} ist mobil ohne positive Fahrdynamik.`);
    }
    return { formation, performance };
  });
}

function parseInventory(value) {
  const inventory = exactRecord(value, "operationalInventory", INVENTORY_FIELDS);
  invariant(inventory.schemaVersion === INVENTORY_SCHEMA, "operationalInventory.schemaVersion ist unbekannt.");
  for (const field of ["releaseId", "worldId", "catalogReleaseId"]) {
    nonEmptyString(inventory[field], `operationalInventory.${field}`);
  }
  for (const field of ["vehicleTypes", "vehicles", "formations"]) {
    invariant(Array.isArray(inventory[field]), `operationalInventory.${field} muss eine Liste sein.`);
  }
  parsedFormations(inventory);
  return inventory;
}

export function compilerPrettyJsonSha256(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`, "utf8").digest("hex");
}

function bytesSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonBytes(value, name) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Fahrzeugkatalog-Deployment-Bindung: ${name} ist kein gueltiges JSON: ${error.message}`);
  }
}

/**
 * Fuehrt den eingecheckten Rust-Compiler aus genau Source und Seed erneut aus
 * und verlangt bytegleiche fuenf Ausgaben. Nur das hierbei erzeugte, intern
 * markierte Evidence-Objekt darf spaeter in den Pre-Sign-Binder gelangen.
 */
export async function verifyVehicleCatalogCompilerReplay({
  sourceCatalogPath,
  worldSeedPath,
  compiledCatalogPath,
  fleetCatalogPath,
  operationalInventoryPath,
  receiptPath,
  fleetAuthority,
  repositoryRoot = REPOSITORY_ROOT,
}) {
  for (const [name, value] of Object.entries({
    sourceCatalogPath,
    worldSeedPath,
    compiledCatalogPath,
    fleetCatalogPath,
    operationalInventoryPath,
    receiptPath,
  })) {
    nonEmptyString(value, name);
  }
  const [
    sourceCatalogBytes,
    worldSeedBytes,
    compiledCatalogBytes,
    fleetCatalogBytes,
    operationalInventoryBytes,
    receiptBytes,
  ] = await Promise.all([
    readFile(sourceCatalogPath),
    readFile(worldSeedPath),
    readFile(compiledCatalogPath),
    readFile(fleetCatalogPath),
    readFile(operationalInventoryPath),
    readFile(receiptPath),
  ]);
  const sourceCatalog = parseJsonBytes(sourceCatalogBytes, "Source-Katalog");
  const worldSeed = parseJsonBytes(worldSeedBytes, "Welt-Seed");
  const compiledCatalog = parseJsonBytes(compiledCatalogBytes, "kompilierter Katalog");
  const receipt = parseReceipt(parseJsonBytes(receiptBytes, "Compile-Receipt"));
  invariant(
    sourceCatalog?.schemaVersion === "zugfolge-vehicle-catalog-source/v2"
      && worldSeed?.schemaVersion === "zugfolge-vehicle-world-seed/v3"
      && compiledCatalog?.schemaVersion === "zugfolge-vehicle-catalog/v3",
    "Compiler-Eingaben besitzen nicht Source-v2, Seed-v3 und Catalog-v3.",
  );

  const temporaryRoot = await mkdtemp(join(tmpdir(), "zugfolge-vehicle-catalog-replay-"));
  const outputDirectory = join(temporaryRoot, "output");
  try {
    const replay = spawnSync(
      "cargo",
      [
        "run", "-q", "-p", "zugfolge-fleet", "--bin", "zugfolge-vehicle-catalog", "--",
        resolve(sourceCatalogPath), resolve(worldSeedPath), outputDirectory,
      ],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    invariant(
      replay.error === undefined && replay.status === 0,
      `deterministischer Rust-Recompile ist fehlgeschlagen:\n${replay.stderr ?? ""}\n${replay.stdout ?? ""}`,
    );
    const supplied = {
      compiledCatalog: compiledCatalogBytes,
      fleetAuthority: Buffer.from(`${JSON.stringify(fleetAuthority, null, 2)}\n`, "utf8"),
      fleetCatalog: fleetCatalogBytes,
      operationalInventory: operationalInventoryBytes,
      receipt: receiptBytes,
    };
    for (const [kind, filename] of Object.entries(COMPILER_OUTPUT_FILES)) {
      const replayed = await readFile(join(outputDirectory, filename));
      invariant(
        replayed.equals(supplied[kind]),
        `Rust-Recompile und vorgelegtes Artefakt '${filename}' sind nicht bytegleich.`,
      );
    }
    invariant(
      replay.stdout.trim().split(/\r?\n/u).at(-1) === receipt.outputSetSha256,
      "Rust-Recompile meldet einen anderen OutputSet-Hash als das Receipt.",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const evidence = Object.freeze({
    schemaVersion: COMPILER_INPUTS_SCHEMA,
    sourceCatalog,
    worldSeed,
    compiledCatalog,
    sourceCatalogFileSha256: bytesSha256(sourceCatalogBytes),
    worldSeedFileSha256: bytesSha256(worldSeedBytes),
    compiledCatalogFileSha256: bytesSha256(compiledCatalogBytes),
  });
  VERIFIED_COMPILER_EVIDENCE.add(evidence);
  return evidence;
}

/** Domain-separierter Provenienz-Hash aller sicherheitsrelevanten Buildquellen. */
export function alphaWorldGenerationSourcesSha256(buildAlphaWorldBytes, vehicleBinderBytes) {
  return compilerPrettyJsonSha256({
    schemaVersion: GENERATION_SOURCES_SCHEMA,
    sources: [
      {
        path: "tools/region-import/build-alpha-world.mjs",
        sha256: bytesSha256(buildAlphaWorldBytes),
      },
      {
        path: "tools/region-import/vehicle-catalog-deployment-binding.mjs",
        sha256: bytesSha256(vehicleBinderBytes),
      },
    ],
  });
}

/** Exaktes CLI-Eingabegate: v2 braucht alle fuenf Beweise, v1 darf keinen tragen. */
export function assertVehicleCatalogProofInputs(
  authoritySchema,
  receiptInput,
  inventoryInput,
  sourceCatalogInput,
  worldSeedInput,
  compiledCatalogInput,
) {
  invariant(
    authoritySchema === AUTHORITY_SCHEMA_V1 || authoritySchema === AUTHORITY_SCHEMA_V2,
    "Fleet-Authority-Schema ist unbekannt.",
  );
  const inputs = [
    receiptInput,
    inventoryInput,
    sourceCatalogInput,
    worldSeedInput,
    compiledCatalogInput,
  ];
  const present = inputs.filter((input) => input !== undefined).length;
  if (authoritySchema === AUTHORITY_SCHEMA_V2) {
    invariant(
      present === inputs.length,
      "Authority-v2 verlangt Receipt-v4, Operational-Inventory-v2, Source-v2, Seed-v3 und Catalog-v3 gemeinsam.",
    );
    return true;
  }
  invariant(present === 0, "Legacy-Authority-v1 darf keine v2-Compilerbeweise behaupten.");
  return false;
}

/**
 * Legacy-v1-Kataloge liefern nur weltunabhaengige Vorlagen und brauchen daher
 * keinen Eintrag fuer die neu gebaute Welt. Erst Authority-v2 ist ein exakter,
 * einzelweltgebundener Compiler-Wrapper.
 */
export function selectVehicleCatalogAuthority(fleetCatalog, worldId) {
  const wrapper = exactRecord(fleetCatalog, "fleetCatalog", ["schemaVersion", "entries"]);
  invariant(wrapper.schemaVersion === WRAPPER_SCHEMA, "Fleet-Katalog-Schema ist unbekannt.");
  invariant(Array.isArray(wrapper.entries) && wrapper.entries.length > 0, "Fleet-Katalog besitzt keine Authority-Eintraege.");
  const schemas = new Set(wrapper.entries.map((entry) => entry?.authorityRelease?.schemaVersion));
  invariant(schemas.size === 1, "Fleet-Katalog darf Authority-v1 und Authority-v2 nicht mischen.");
  const [schemaVersion] = schemas;
  invariant(
    schemaVersion === AUTHORITY_SCHEMA_V1 || schemaVersion === AUTHORITY_SCHEMA_V2,
    "Fleet-Authority-Schema ist unbekannt.",
  );
  if (schemaVersion === AUTHORITY_SCHEMA_V1) return { schemaVersion, entry: undefined };
  invariant(wrapper.entries.length === 1, "Authority-v2-Compilerwrapper muss genau einen Welteintrag besitzen.");
  const entry = wrapper.entries[0];
  invariant(entry?.worldId === worldId, "Authority-v2-Katalog besitzt keinen Eintrag fuer die Alpha-Welt.");
  return { schemaVersion, entry };
}

function sameJson(left, right) {
  return alphaCanonicalJson(left) === alphaCanonicalJson(right);
}

function outputSetHash(receipt, hashes) {
  return compilerPrettyJsonSha256({
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
    fleetAuthoritySha256: hashes.fleetAuthority,
    fleetAuthorityCatalogSha256: hashes.wrapper,
    operationalInventorySha256: hashes.inventory,
  });
}

export function compilerFleetFormations(inventory) {
  // Fleet Authority v2 ist die einzige Ableitungsinstanz fuer
  // FormationDynamics. Der interne Build-Intent transportiert nie den
  // Operational-Pruefwert als vermeintliche Client-Autoritaet.
  const parsedInventory = parseInventory(inventory);
  return parsedInventory.formations.map((formation) => ({
    id: formation.id,
    vehicleIds: formation.vehicleIds,
    pathReceiptId: formation.pathReceiptId,
  }));
}

export function bindVehicleCatalogDeploymentArtifacts({
  fleetCatalog,
  receipt,
  operationalInventory,
  fleet,
  regionalSimulation,
  economyRelease,
  blueprintFleetHash,
  compilerEvidence,
}) {
  invariant(fleet?.authorityRelease?.schemaVersion === AUTHORITY_SCHEMA_V2, "Binder ist nur fuer Authority-v2 zulaessig.");
  invariant(
    typeof compilerEvidence === "object"
      && compilerEvidence !== null
      && VERIFIED_COMPILER_EVIDENCE.has(compilerEvidence),
    "Binder verlangt den erfolgreichen deterministischen Rust-Recompile derselben Eingabedateien.",
  );
  const wrapper = exactRecord(fleetCatalog, "fleetCatalog", ["schemaVersion", "entries"]);
  invariant(wrapper.schemaVersion === WRAPPER_SCHEMA && Array.isArray(wrapper.entries) && wrapper.entries.length === 1, "Wrapper ist kein atomarer Compiler-v1-Katalog.");
  const entry = exactRecord(wrapper.entries[0], "fleetCatalog.entries[0]", ["worldId", "producedAt", "authorityRelease"]);
  nonEmptyString(entry.worldId, "fleetCatalog.entries[0].worldId");
  safeNonNegativeInteger(entry.producedAt, "fleetCatalog.entries[0].producedAt");
  invariant(entry.worldId === fleet.worldId && entry.producedAt === fleet.producedAt, "Wrapper bindet Welt oder producedAt nicht an die Fleet-Initialisierung.");
  invariant(sameJson(entry.authorityRelease, fleet.authorityRelease), "Wrapper und Fleet-Initialisierung enthalten verschiedene Authorities.");
  receipt = parseReceipt(receipt);
  operationalInventory = parseInventory(operationalInventory);
  invariant(
    compilerEvidence.sourceCatalog.releaseId === receipt.sourceCatalogReleaseId
      && compilerEvidence.worldSeed.seedId === receipt.worldSeedId
      && compilerEvidence.worldSeed.worldId === receipt.worldId
      && compilerEvidence.worldSeed.producedAt === receipt.producedAt
      && compilerEvidence.compiledCatalog.releaseId === receipt.sourceCatalogReleaseId
      && compilerPrettyJsonSha256(compilerEvidence.compiledCatalog) === receipt.compiledCatalogSha256,
    "Rust-verifizierte Source-, Seed- oder Catalog-Eingabe widerspricht dem Receipt.",
  );
  invariant(
    receipt.worldId === fleet.worldId
      && receipt.producedAt === fleet.producedAt
      && operationalInventory.worldId === fleet.worldId
      && receipt.sourceCatalogReleaseId === operationalInventory.catalogReleaseId,
    "Receipt, Welt, Seed-Zeit und Operational-Inventar widersprechen sich.",
  );
  invariant(
    receipt.economyReleaseId === economyRelease.version
      && receipt.economyReleaseSha256 === economyRelease.checksum
      && fleet.authorityRelease.economyReleaseId === economyRelease.version
      && fleet.authorityRelease.economyReleaseSha256 === economyRelease.checksum,
    "EconomyRelease ist nicht durch Receipt und Fleet gemeinsam gebunden.",
  );
  const hashes = {
    fleetAuthority: compilerPrettyJsonSha256(fleet.authorityRelease),
    wrapper: compilerPrettyJsonSha256(wrapper),
    inventory: compilerPrettyJsonSha256(operationalInventory),
  };
  invariant(
    receipt.fleetAuthoritySha256 === hashes.fleetAuthority
      && receipt.fleetAuthorityCatalogSha256 === hashes.wrapper
      && receipt.operationalInventorySha256 === hashes.inventory
      && receipt.outputSetSha256 === outputSetHash(receipt, hashes),
    "Receipt- oder OutputSet-Hash stimmt nicht mit den echten Compilerbytes ueberein.",
  );
  invariant(
    alphaHash("zugfolge-fleet-authority-runtime/v1", fleet.authorityRelease) === blueprintFleetHash,
    "Blueprint bindet nicht den Fleet-Authority-Hash.",
  );
  invariant(
    sameJson(operationalInventory.vehicleTypes, regionalSimulation.vehicleTypes)
      && sameJson(operationalInventory.vehicles, regionalSimulation.vehicles)
      && sameJson(
        operationalInventory.formations.map((formation) => ({
          id: formation.id,
          predecessorId: formation.predecessorId ?? null,
          vehicleIds: formation.vehicleIds,
        })),
        regionalSimulation.formations,
      )
      && sameJson(compilerFleetFormations(operationalInventory), fleet.formations ?? []),
    "Fleet-Formationen oder Operational-Initialisierung weichen vom Compilerinventar ab.",
  );
  return {
    schemaVersion: VEHICLE_CATALOG_DEPLOYMENT_BINDING_SCHEMA,
    compilerInputFiles: {
      schemaVersion: compilerEvidence.schemaVersion,
      sourceCatalogSha256: compilerEvidence.sourceCatalogFileSha256,
      worldSeedSha256: compilerEvidence.worldSeedFileSha256,
      compiledCatalogSha256: compilerEvidence.compiledCatalogFileSha256,
    },
    receipt: structuredClone(receipt),
    operationalInventory: structuredClone(operationalInventory),
  };
}
