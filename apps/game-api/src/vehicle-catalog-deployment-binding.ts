import { alphaCanonicalJson, alphaHash } from "@zugfolge/alpha";
import {
  FLEET_AUTHORITY_RELEASE_SCHEMA_V2,
  type FleetWorldInitialization,
  type OperationalSimulationInitialization,
} from "@zugfolge/runtime-native";
import { createHash } from "node:crypto";

export const VEHICLE_CATALOG_DEPLOYMENT_BINDING_SCHEMA =
  "zugfolge-vehicle-catalog-deployment-binding/v1" as const;
export const VEHICLE_CATALOG_COMPILE_RECEIPT_SCHEMA =
  "zugfolge-vehicle-catalog-compile-receipt/v4" as const;
export const VEHICLE_CATALOG_COMPILER_VERSION =
  "zugfolge-vehicle-catalog-compiler/v4" as const;
export const OPERATIONAL_VEHICLE_INVENTORY_SCHEMA =
  "zugfolge-operational-vehicle-inventory/v2" as const;
export const VEHICLE_CATALOG_COMPILER_INPUT_FILES_SCHEMA =
  "zugfolge-vehicle-catalog-compiler-input-files/v1" as const;
const FLEET_AUTHORITY_CATALOG_SCHEMA =
  "zugfolge-fleet-authority-release-catalog/v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface VehicleCatalogCompileReceiptV4 {
  readonly schemaVersion: typeof VEHICLE_CATALOG_COMPILE_RECEIPT_SCHEMA;
  readonly compilerVersion: typeof VEHICLE_CATALOG_COMPILER_VERSION;
  readonly sourceCatalogReleaseId: string;
  readonly worldSeedId: string;
  readonly worldId: string;
  readonly producedAt: number;
  readonly economyReleaseId: string;
  readonly economyReleaseSha256: string;
  readonly economyProjectionSha256: string;
  readonly sourceCatalogSha256: string;
  readonly worldSeedSha256: string;
  readonly compiledCatalogSha256: string;
  readonly fleetAuthoritySha256: string;
  readonly fleetAuthorityCatalogSha256: string;
  readonly operationalInventorySha256: string;
  readonly outputSetSha256: string;
}

export interface OperationalVehicleInventoryV2 {
  readonly schemaVersion: typeof OPERATIONAL_VEHICLE_INVENTORY_SCHEMA;
  readonly releaseId: string;
  readonly worldId: string;
  readonly catalogReleaseId: string;
  readonly vehicleTypes: readonly unknown[];
  readonly vehicles: readonly unknown[];
  readonly formations: readonly unknown[];
}

export interface VehicleCatalogDeploymentBindingV1 {
  readonly schemaVersion: typeof VEHICLE_CATALOG_DEPLOYMENT_BINDING_SCHEMA;
  readonly compilerInputFiles: {
    readonly schemaVersion: typeof VEHICLE_CATALOG_COMPILER_INPUT_FILES_SCHEMA;
    readonly sourceCatalogSha256: string;
    readonly worldSeedSha256: string;
    readonly compiledCatalogSha256: string;
  };
  readonly receipt: VehicleCatalogCompileReceiptV4;
  readonly operationalInventory: OperationalVehicleInventoryV2;
}

export interface VehicleCatalogDeploymentFacts {
  readonly worldId: string;
  readonly economyReleaseId: string;
  readonly economyReleaseSha256: string;
  readonly blueprintFleetHash: string;
  readonly fleet: FleetWorldInitialization;
  readonly regionalSimulation: OperationalSimulationInitialization;
}

function invalid(message: string): never {
  throw new TypeError(`Ungueltige Fahrzeugkatalog-Deployment-Bindung: ${message}`);
}

function exactRecord(
  value: unknown,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${name} muss ein Objekt sein.`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((field) => !Object.hasOwn(record, field));
  const unknown = Object.keys(record).filter((field) => !allowed.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    return invalid(`${name} besitzt nicht exakt die erwarteten Felder.`);
  }
  return record;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim() !== value) {
    return invalid(`${name} muss eine nichtleere randfreie Zeichenkette sein.`);
  }
  return value;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    return invalid(`${name} muss ein kleingeschriebener SHA-256 sein.`);
  }
  return value;
}

function safeNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${name} muss eine sichere nichtnegative Ganzzahl sein.`);
  }
  return value as number;
}

/** Exakte Hashdarstellung des Rust-Compilers: serde_json pretty plus LF. */
export function compilerPrettyJsonSha256(value: unknown): string {
  const encoded = JSON.stringify(value, null, 2);
  if (encoded === undefined) invalid("Artefakt ist nicht als JSON serialisierbar.");
  return createHash("sha256").update(`${encoded}\n`, "utf8").digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return alphaCanonicalJson(left) === alphaCanonicalJson(right);
}

function parseReceipt(value: unknown): VehicleCatalogCompileReceiptV4 {
  const fields = [
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
  ] as const;
  const receipt = exactRecord(value, "receipt", fields);
  if (receipt["schemaVersion"] !== VEHICLE_CATALOG_COMPILE_RECEIPT_SCHEMA) {
    invalid("receipt.schemaVersion ist unbekannt.");
  }
  if (receipt["compilerVersion"] !== VEHICLE_CATALOG_COMPILER_VERSION) {
    invalid("receipt.compilerVersion ist unbekannt.");
  }
  for (const field of [
    "sourceCatalogReleaseId",
    "worldSeedId",
    "worldId",
    "economyReleaseId",
  ] as const) nonEmptyString(receipt[field], `receipt.${field}`);
  safeNonNegativeInteger(receipt["producedAt"], "receipt.producedAt");
  for (const field of [
    "economyReleaseSha256",
    "economyProjectionSha256",
    "sourceCatalogSha256",
    "worldSeedSha256",
    "compiledCatalogSha256",
    "fleetAuthoritySha256",
    "fleetAuthorityCatalogSha256",
    "operationalInventorySha256",
    "outputSetSha256",
  ] as const) sha256(receipt[field], `receipt.${field}`);
  return receipt as unknown as VehicleCatalogCompileReceiptV4;
}

function parseInventory(value: unknown): OperationalVehicleInventoryV2 {
  const inventory = exactRecord(value, "operationalInventory", [
    "schemaVersion",
    "releaseId",
    "worldId",
    "catalogReleaseId",
    "vehicleTypes",
    "vehicles",
    "formations",
  ]);
  if (inventory["schemaVersion"] !== OPERATIONAL_VEHICLE_INVENTORY_SCHEMA) {
    invalid("operationalInventory.schemaVersion ist unbekannt.");
  }
  for (const field of ["releaseId", "worldId", "catalogReleaseId"] as const) {
    nonEmptyString(inventory[field], `operationalInventory.${field}`);
  }
  for (const field of ["vehicleTypes", "vehicles", "formations"] as const) {
    if (!Array.isArray(inventory[field])) invalid(`operationalInventory.${field} muss eine Liste sein.`);
  }
  return inventory as unknown as OperationalVehicleInventoryV2;
}

function parseCompilerInputFiles(value: unknown): VehicleCatalogDeploymentBindingV1["compilerInputFiles"] {
  const files = exactRecord(value, "compilerInputFiles", [
    "schemaVersion",
    "sourceCatalogSha256",
    "worldSeedSha256",
    "compiledCatalogSha256",
  ]);
  if (files["schemaVersion"] !== VEHICLE_CATALOG_COMPILER_INPUT_FILES_SCHEMA) {
    invalid("compilerInputFiles.schemaVersion ist unbekannt.");
  }
  for (const field of [
    "sourceCatalogSha256",
    "worldSeedSha256",
    "compiledCatalogSha256",
  ] as const) sha256(files[field], `compilerInputFiles.${field}`);
  return files as unknown as VehicleCatalogDeploymentBindingV1["compilerInputFiles"];
}

function expectedOperationalFormations(inventory: OperationalVehicleInventoryV2): readonly unknown[] {
  return inventory.formations.map((value, index) => {
    const formation = exactRecord(value, `operationalInventory.formations[${index}]`, [
      "id",
      "vehicleIds",
      "pathReceiptId",
      "performance",
    ], ["predecessorId"]);
    nonEmptyString(formation["id"], `operationalInventory.formations[${index}].id`);
    nonEmptyString(formation["pathReceiptId"], `operationalInventory.formations[${index}].pathReceiptId`);
    if (!Array.isArray(formation["vehicleIds"])) {
      invalid(`operationalInventory.formations[${index}].vehicleIds muss eine Liste sein.`);
    }
    return {
      id: formation["id"],
      predecessorId: formation["predecessorId"] ?? null,
      vehicleIds: formation["vehicleIds"],
    };
  });
}

function expectedFleetFormations(inventory: OperationalVehicleInventoryV2): readonly unknown[] {
  return inventory.formations.map((value, index) => {
    const formation = value as Record<string, unknown>;
    const performance = exactRecord(
      formation["performance"],
      `operationalInventory.formations[${index}].performance`,
      [
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
      ],
    );
    if (typeof performance["mobile"] !== "boolean") {
      invalid(`operationalInventory.formations[${index}].performance.mobile muss boolesch sein.`);
    }
    const base = {
      id: formation["id"],
      vehicleIds: formation["vehicleIds"],
      pathReceiptId: formation["pathReceiptId"],
    };
    const acceleration = safeNonNegativeInteger(
      performance["accelerationMmps2"],
      `operationalInventory.formations[${index}].performance.accelerationMmps2`,
    );
    const deceleration = safeNonNegativeInteger(
      performance["serviceBrakeMmps2"],
      `operationalInventory.formations[${index}].performance.serviceBrakeMmps2`,
    );
    if (acceleration === 0 || deceleration === 0) {
      if (performance["mobile"]) {
        invalid(`operationalInventory.formations[${index}] ist mobil ohne positive Fahrdynamik.`);
      }
    }
    // Fleet Authority v2 leitet die FormationDynamics aus seinen Rohwerten
    // selbst ab. Der interne Build-/Game-API-Intent transportiert deshalb
    // weder den Operational-Pruefwert noch einen anderen Clientwert.
    return base;
  });
}

/**
 * Verifiziert den nicht-zirkulaeren Compiler→Deployment-Beweis. Der Receipt
 * hasht nur Compilerartefakte; erst danach bindet die Alpha-Signatur den
 * Receipt samt Operational-Inventar und allen uebrigen Weltartefakten.
 */
export function validateVehicleCatalogDeploymentBinding(
  value: unknown,
  facts: VehicleCatalogDeploymentFacts,
): asserts value is VehicleCatalogDeploymentBindingV1 | undefined {
  if (facts.fleet.authorityRelease.schemaVersion !== FLEET_AUTHORITY_RELEASE_SCHEMA_V2) {
    if (value !== undefined) invalid("Legacy-Authority-v1 darf keinen v2-Compilerbeweis behaupten.");
    if (facts.fleet.producedAt !== 0) invalid("Legacy-Authority-v1 ist nur mit producedAt 0 kompatibel.");
    return;
  }
  if (value === undefined) {
    invalid("Authority-v2 darf ohne signierten Compilerbeweis nicht produktiv registriert werden.");
  }
  const binding = exactRecord(value, "binding", [
    "schemaVersion",
    "compilerInputFiles",
    "receipt",
    "operationalInventory",
  ]);
  if (binding["schemaVersion"] !== VEHICLE_CATALOG_DEPLOYMENT_BINDING_SCHEMA) {
    invalid("binding.schemaVersion ist unbekannt.");
  }
  parseCompilerInputFiles(binding["compilerInputFiles"]);
  const receipt = parseReceipt(binding["receipt"]);
  const inventory = parseInventory(binding["operationalInventory"]);

  if (
    receipt.worldId !== facts.worldId
    || receipt.worldId !== facts.fleet.worldId
    || inventory.worldId !== facts.worldId
    || receipt.producedAt !== facts.fleet.producedAt
    || receipt.sourceCatalogReleaseId !== inventory.catalogReleaseId
    || receipt.economyReleaseId !== facts.economyReleaseId
    || receipt.economyReleaseSha256 !== facts.economyReleaseSha256
    || facts.fleet.authorityRelease.economyReleaseId !== facts.economyReleaseId
    || facts.fleet.authorityRelease.economyReleaseSha256 !== facts.economyReleaseSha256
  ) {
    invalid("Welt-, Seed-Zeit-, Katalog- oder Economy-Bindung ist widerspruechlich.");
  }

  const fleetAuthorityHash = compilerPrettyJsonSha256(facts.fleet.authorityRelease);
  const fleetAuthorityCatalog = {
    schemaVersion: FLEET_AUTHORITY_CATALOG_SCHEMA,
    entries: [{
      worldId: facts.worldId,
      producedAt: facts.fleet.producedAt,
      authorityRelease: facts.fleet.authorityRelease,
    }],
  };
  const fleetAuthorityCatalogHash = compilerPrettyJsonSha256(fleetAuthorityCatalog);
  const operationalInventoryHash = compilerPrettyJsonSha256(inventory);
  const outputSetHash = compilerPrettyJsonSha256({
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
    fleetAuthoritySha256: fleetAuthorityHash,
    fleetAuthorityCatalogSha256: fleetAuthorityCatalogHash,
    operationalInventorySha256: operationalInventoryHash,
  });
  if (
    receipt.fleetAuthoritySha256 !== fleetAuthorityHash
    || receipt.fleetAuthorityCatalogSha256 !== fleetAuthorityCatalogHash
    || receipt.operationalInventorySha256 !== operationalInventoryHash
    || receipt.outputSetSha256 !== outputSetHash
    || alphaHash("zugfolge-fleet-authority-runtime/v1", facts.fleet.authorityRelease)
      !== facts.blueprintFleetHash
  ) {
    invalid("Receipt- oder Blueprint-Hash bindet nicht die signierten Compilerartefakte.");
  }

  if (
    !sameJson(inventory.vehicleTypes, facts.regionalSimulation.vehicleTypes)
    || !sameJson(inventory.vehicles, facts.regionalSimulation.vehicles)
    || !sameJson(expectedOperationalFormations(inventory), facts.regionalSimulation.formations)
    || !sameJson(expectedFleetFormations(inventory), facts.fleet.formations ?? [])
  ) {
    invalid("Fleet-Formation oder Operational-Initialisierung weicht vom Compilerinventar ab.");
  }
}

export function bindVehicleCatalogDeployment(
  compilerInputFiles: unknown,
  receipt: unknown,
  operationalInventory: unknown,
  facts: VehicleCatalogDeploymentFacts,
): VehicleCatalogDeploymentBindingV1 {
  const binding = {
    schemaVersion: VEHICLE_CATALOG_DEPLOYMENT_BINDING_SCHEMA,
    compilerInputFiles,
    receipt,
    operationalInventory,
  };
  validateVehicleCatalogDeploymentBinding(binding, facts);
  return structuredClone(binding) as VehicleCatalogDeploymentBindingV1;
}
