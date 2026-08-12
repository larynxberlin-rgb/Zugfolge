import {
  FLEET_AUTHORITY_RELEASE_SCHEMA,
  type FleetAuthorityRelease,
} from "@zugfolge/runtime-native";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import { compareUtf8 } from "./utf8.js";

export const FLEET_AUTHORITY_RELEASE_CATALOG_SCHEMA =
  "zugfolge-fleet-authority-release-catalog/v1" as const;

export type FleetAuthorityReleaseCatalog = Readonly<
  Record<string, FleetAuthorityRelease>
>;

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_U16 = 65_535;
const MAX_U32 = 4_294_967_295;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const CATALOG_FIELDS = ["schemaVersion", "entries"] as const;
const ENTRY_FIELDS = ["worldId", "authorityRelease"] as const;
const RELEASE_FIELDS = [
  "schemaVersion",
  "releaseId",
  "referenceYear",
  "assets",
  "personnelPools",
  "pathReceipts",
] as const;
const ASSET_FIELDS = [
  "id",
  "numericId",
  "operatorId",
  "vehicleTypeId",
  "classDesignation",
  "tradeName",
  "buildYear",
  "acquisitionYear",
  "procurementChannel",
  "approvedLineIds",
  "maintenanceDeadlines",
  "installedProtection",
  "technical",
  "passenger",
  "deliveredAt",
  "retiredAt",
] as const;
const MAINTENANCE_FIELDS = ["kind", "dueAt"] as const;
const TECHNICAL_REQUIRED_FIELDS = [
  "lengthMm",
  "massKg",
  "maximumSpeedKph",
  "traction",
  "electricSystems",
] as const;
const TECHNICAL_OPTIONAL_FIELDS = [
  // Ein Altrelease darf noch ein Referenz-Fahrprofil je Fahrzeug enthalten.
  // Neue Lokdaten tragen stattdessen Leistung und Zugkraft; die wirksame
  // Dynamik wird erst für den konkreten Wagenpark signiert.
  "accelerationMmPerS2",
  "decelerationMmPerS2",
  "continuousPowerKw",
  "startingTractiveEffortKn",
  "brakeWeightKg",
  "role",
  "controlStands",
] as const;
const PASSENGER_FIELDS = [
  "seats",
  "firstClassSeats",
  "accessible",
  "bicyclePlaces",
  "wheelchairPlaces",
  "equipment",
  "operatingCostCentsPerTrainKm",
  "replacementPlan",
] as const;
const PERSONNEL_POOL_FIELDS = [
  "id",
  "numericId",
  "operatorId",
  "capacitySeconds",
  "minimumRestSeconds",
  "classDesignations",
  "pathReceiptIds",
  "qualificationHash",
] as const;
const PATH_RECEIPT_FIELDS = [
  "id",
  "numericRouteId",
  "operatorId",
  "serviceLineIds",
  "decision",
  "validFrom",
  "validUntil",
  "platformLengthsMm",
  "electrifications",
  "requiredProtection",
  "approvedClasses",
  "plannerStateHash",
  "conflictCheckHash",
] as const;

const PROCUREMENT_CHANNELS = ["new-build", "leasing", "used"] as const;
const PROTECTION_SYSTEMS = ["pzb", "lzb", "etcs-level1", "etcs-level2"] as const;
const TRACTIONS = ["unpowered", "electric", "diesel", "battery"] as const;
const POWER_SYSTEMS = ["ac15kv", "ac25kv", "dc750v", "dc1500v", "dc3000v"] as const;
const VEHICLE_ROLES = ["locomotive", "powered-unit", "coach", "control-car"] as const;
const PATH_DECISIONS = ["confirmed", "requested", "rejected"] as const;
const ELECTRIFICATIONS = [
  "unelectrified",
  "overhead-ac15kv",
  "overhead-ac25kv",
  "overhead-dc1500v",
  "overhead-dc3000v",
] as const;

function invalid(message: string): never {
  throw new TypeError(`Ungueltiger M5-Authority-Katalog: ${message}`);
}

function exactRecord(
  value: unknown,
  name: string,
  fields: readonly string[],
  optionalFields: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${name} muss ein Objekt sein.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  const expected = new Set([...fields, ...optionalFields]);
  const missing = fields.filter((field) => !Object.hasOwn(record, field));
  const unknown = actual.filter((field) => !expected.has(field));
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      missing.length > 0 ? `fehlend: ${missing.join(", ")}` : undefined,
      unknown.length > 0 ? `unbekannt: ${unknown.join(", ")}` : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    return invalid(`${name} besitzt nicht exakt die erwarteten Felder (${details.join("; ")}).`);
  }
  return record;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return invalid(`${name} muss eine nichtleere Zeichenkette sein.`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    return invalid(
      `${name} muss eine sichere Ganzzahl zwischen ${minimum} und ${maximum} sein.`,
    );
  }
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") return invalid(`${name} muss boolesch sein.`);
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  name: string,
  choices: T,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    return invalid(`${name} besitzt einen unbekannten Enum-Wert.`);
  }
  return value;
}

function arrayValue(value: unknown, name: string, nonEmpty = false): readonly unknown[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    return invalid(`${name} muss ${nonEmpty ? "eine nichtleere " : "eine "}Liste sein.`);
  }
  return value;
}

function rejectDuplicateKeys(
  values: readonly unknown[],
  name: string,
  keyOf: (value: unknown, index: number) => string | number,
): void {
  const keys = new Set<string | number>();
  for (const [index, value] of values.entries()) {
    const key = keyOf(value, index);
    if (keys.has(key)) return invalid(`${name} enthaelt den doppelten Wert '${key}'.`);
    keys.add(key);
  }
}

function stringArray(value: unknown, name: string): readonly string[] {
  const values = arrayValue(value, name);
  const strings = values.map((item, index) => nonEmptyString(item, `${name}[${index}]`));
  rejectDuplicateKeys(strings, name, (item) => item as string);
  return strings;
}

function enumArray<const T extends readonly string[]>(
  value: unknown,
  name: string,
  choices: T,
  nonEmpty = false,
): readonly T[number][] {
  const values = arrayValue(value, name, nonEmpty);
  const enums = values.map((item, index) => enumValue(item, `${name}[${index}]`, choices));
  rejectDuplicateKeys(enums, name, (item) => item as string);
  return enums;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    return invalid(`${name} muss ein kleingeschriebener SHA-256-Hash sein.`);
  }
  return value;
}

interface TechnicalContext {
  readonly traction: (typeof TRACTIONS)[number];
  readonly role: (typeof VEHICLE_ROLES)[number];
}

function optionalSafeInteger(
  record: Record<string, unknown>,
  field: string,
  name: string,
): number | undefined {
  if (!Object.hasOwn(record, field)) return undefined;
  return safeInteger(record[field], `${name}.${field}`);
}

function validateTechnical(value: unknown, name: string): TechnicalContext {
  const technical = exactRecord(value, name, TECHNICAL_REQUIRED_FIELDS, TECHNICAL_OPTIONAL_FIELDS);
  safeInteger(technical["lengthMm"], `${name}.lengthMm`, 1);
  safeInteger(technical["massKg"], `${name}.massKg`, 1);
  safeInteger(technical["maximumSpeedKph"], `${name}.maximumSpeedKph`, 1, MAX_U16);
  const traction = enumValue(technical["traction"], `${name}.traction`, TRACTIONS);
  const role = Object.hasOwn(technical, "role")
    ? enumValue(technical["role"], `${name}.role`, VEHICLE_ROLES)
    : "powered-unit";
  const electricSystems = enumArray(
    technical["electricSystems"],
    `${name}.electricSystems`,
    POWER_SYSTEMS,
  );
  if ((traction === "electric") !== (electricSystems.length > 0)) {
    invalid(`${name} besitzt inkonsistente Traktion und elektrische Systeme.`);
  }
  const acceleration = optionalSafeInteger(technical, "accelerationMmPerS2", name);
  const deceleration = optionalSafeInteger(technical, "decelerationMmPerS2", name);
  if ((acceleration === undefined) !== (deceleration === undefined)) {
    invalid(`${name} muss Beschleunigung und Bremsvermoegen gemeinsam angeben oder auslassen.`);
  }
  const continuousPower = optionalSafeInteger(technical, "continuousPowerKw", name) ?? 0;
  const startingForce = optionalSafeInteger(technical, "startingTractiveEffortKn", name) ?? 0;
  optionalSafeInteger(technical, "brakeWeightKg", name);
  if (traction === "unpowered") {
    if (acceleration !== undefined || continuousPower !== 0 || startingForce !== 0) {
      invalid(`${name} darf als nicht angetriebenes Fahrzeug keine Fahr- oder Antriebswerte tragen.`);
    }
  } else if (acceleration === undefined && (continuousPower <= 0 || startingForce <= 0)) {
    invalid(`${name} ohne Alt-Fahrprofil braucht Leistung und Anfahrzugkraft.`);
  } else if (acceleration !== undefined && (acceleration <= 0 || deceleration! <= 0)) {
    invalid(`${name} besitzt kein positives Alt-Fahrprofil.`);
  }
  const controlStands = Object.hasOwn(technical, "controlStands")
    ? exactRecord(technical["controlStands"], `${name}.controlStands`, ["front", "rear"])
    : { front: true, rear: true };
  const front = booleanValue(controlStands["front"], `${name}.controlStands.front`);
  const rear = booleanValue(controlStands["rear"], `${name}.controlStands.rear`);
  if (role === "coach" && (traction !== "unpowered" || front || rear)) {
    invalid(`${name} ist als Reisezugwagen nur unpowered und ohne Fuehrerstand zulaessig.`);
  }
  if (role === "control-car" && (traction !== "unpowered" || (!front && !rear))) {
    invalid(`${name} ist als Steuerwagen nur unpowered und mit Fuehrerstand zulaessig.`);
  }
  if ((role === "locomotive" || role === "powered-unit") && traction === "unpowered") {
    invalid(`${name} braucht als angetriebenes Fahrzeug eine Traktion.`);
  }
  return { traction, role };
}

function validatePassenger(value: unknown, name: string, role: TechnicalContext["role"]): void {
  const passenger = exactRecord(value, name, PASSENGER_FIELDS);
  const seats = safeInteger(
    passenger["seats"],
    `${name}.seats`,
    role === "locomotive" ? 0 : 1,
    MAX_U32,
  );
  const firstClassSeats = safeInteger(
    passenger["firstClassSeats"],
    `${name}.firstClassSeats`,
    0,
    MAX_U32,
  );
  if (firstClassSeats > seats) invalid(`${name}.firstClassSeats uebersteigt seats.`);
  booleanValue(passenger["accessible"], `${name}.accessible`);
  safeInteger(passenger["bicyclePlaces"], `${name}.bicyclePlaces`, 0, MAX_U16);
  safeInteger(passenger["wheelchairPlaces"], `${name}.wheelchairPlaces`, 0, MAX_U16);
  stringArray(passenger["equipment"], `${name}.equipment`);
  safeInteger(
    passenger["operatingCostCentsPerTrainKm"],
    `${name}.operatingCostCentsPerTrainKm`,
    0,
    MAX_U32,
  );
  booleanValue(passenger["replacementPlan"], `${name}.replacementPlan`);
}

function validateAsset(value: unknown, name: string): void {
  const asset = exactRecord(value, name, ASSET_FIELDS);
  nonEmptyString(asset["id"], `${name}.id`);
  safeInteger(asset["numericId"], `${name}.numericId`, 1);
  nonEmptyString(asset["operatorId"], `${name}.operatorId`);
  safeInteger(asset["vehicleTypeId"], `${name}.vehicleTypeId`, 1);
  nonEmptyString(asset["classDesignation"], `${name}.classDesignation`);
  nonEmptyString(asset["tradeName"], `${name}.tradeName`);
  const buildYear = safeInteger(asset["buildYear"], `${name}.buildYear`, 1, MAX_U16);
  const acquisitionYear = safeInteger(
    asset["acquisitionYear"],
    `${name}.acquisitionYear`,
    1,
    MAX_U16,
  );
  if (buildYear > acquisitionYear) invalid(`${name} wurde vor seinem Baujahr beschafft.`);
  enumValue(asset["procurementChannel"], `${name}.procurementChannel`, PROCUREMENT_CHANNELS);
  stringArray(asset["approvedLineIds"], `${name}.approvedLineIds`);

  const deadlines = arrayValue(asset["maintenanceDeadlines"], `${name}.maintenanceDeadlines`, true);
  for (const [index, rawDeadline] of deadlines.entries()) {
    const deadlineName = `${name}.maintenanceDeadlines[${index}]`;
    const deadline = exactRecord(rawDeadline, deadlineName, MAINTENANCE_FIELDS);
    nonEmptyString(deadline["kind"], `${deadlineName}.kind`);
    safeInteger(deadline["dueAt"], `${deadlineName}.dueAt`);
  }
  rejectDuplicateKeys(deadlines, `${name}.maintenanceDeadlines.kind`, (rawDeadline, index) => {
    const deadline = exactRecord(
      rawDeadline,
      `${name}.maintenanceDeadlines[${index}]`,
      MAINTENANCE_FIELDS,
    );
    return nonEmptyString(deadline["kind"], `${name}.maintenanceDeadlines[${index}].kind`);
  });

  const installedProtection = enumArray(
    asset["installedProtection"],
    `${name}.installedProtection`,
    PROTECTION_SYSTEMS,
  );
  // LZB wird stets zusammen mit PZB eingebaut. ETCS bleibt davon bewusst
  // ausgenommen: reine ETCS-Fahrzeuge duerfen auf reinen ETCS-Strecken fahren.
  if (installedProtection.includes("lzb") && !installedProtection.includes("pzb")) {
    invalid(`${name}.installedProtection darf LZB nur zusammen mit PZB enthalten.`);
  }
  const technical = validateTechnical(asset["technical"], `${name}.technical`);
  validatePassenger(asset["passenger"], `${name}.passenger`, technical.role);
  const deliveredAt = safeInteger(asset["deliveredAt"], `${name}.deliveredAt`);
  const retiredAt = safeInteger(asset["retiredAt"], `${name}.retiredAt`);
  if (retiredAt <= deliveredAt) invalid(`${name} besitzt kein positives Verfuegbarkeitsfenster.`);
}

function validatePersonnelPool(value: unknown, name: string): void {
  const pool = exactRecord(value, name, PERSONNEL_POOL_FIELDS);
  nonEmptyString(pool["id"], `${name}.id`);
  safeInteger(pool["numericId"], `${name}.numericId`, 1);
  nonEmptyString(pool["operatorId"], `${name}.operatorId`);
  safeInteger(pool["capacitySeconds"], `${name}.capacitySeconds`, 1, MAX_U32);
  safeInteger(pool["minimumRestSeconds"], `${name}.minimumRestSeconds`, 0, MAX_U32);
  stringArray(pool["classDesignations"], `${name}.classDesignations`);
  stringArray(pool["pathReceiptIds"], `${name}.pathReceiptIds`);
  sha256(pool["qualificationHash"], `${name}.qualificationHash`);
}

function validatePathReceipt(value: unknown, name: string): void {
  const receipt = exactRecord(value, name, PATH_RECEIPT_FIELDS);
  nonEmptyString(receipt["id"], `${name}.id`);
  safeInteger(receipt["numericRouteId"], `${name}.numericRouteId`, 1);
  nonEmptyString(receipt["operatorId"], `${name}.operatorId`);
  stringArray(receipt["serviceLineIds"], `${name}.serviceLineIds`);
  enumValue(receipt["decision"], `${name}.decision`, PATH_DECISIONS);
  const validFrom = safeInteger(receipt["validFrom"], `${name}.validFrom`);
  const validUntil = safeInteger(receipt["validUntil"], `${name}.validUntil`);
  if (validUntil <= validFrom) invalid(`${name} besitzt kein positives Gueltigkeitsfenster.`);

  const platformLengths = arrayValue(
    receipt["platformLengthsMm"],
    `${name}.platformLengthsMm`,
    true,
  );
  for (const [index, length] of platformLengths.entries()) {
    safeInteger(length, `${name}.platformLengthsMm[${index}]`, 1);
  }
  enumArray(
    receipt["electrifications"],
    `${name}.electrifications`,
    ELECTRIFICATIONS,
    true,
  );
  enumArray(
    receipt["requiredProtection"],
    `${name}.requiredProtection`,
    PROTECTION_SYSTEMS,
  );
  stringArray(receipt["approvedClasses"], `${name}.approvedClasses`);
  sha256(receipt["plannerStateHash"], `${name}.plannerStateHash`);
  sha256(receipt["conflictCheckHash"], `${name}.conflictCheckHash`);
}

function validateAuthorityRelease(value: unknown, name: string): asserts value is FleetAuthorityRelease {
  const release = exactRecord(value, name, RELEASE_FIELDS);
  if (release["schemaVersion"] !== FLEET_AUTHORITY_RELEASE_SCHEMA) {
    invalid(`${name}.schemaVersion ist unbekannt.`);
  }
  nonEmptyString(release["releaseId"], `${name}.releaseId`);
  const referenceYear = safeInteger(release["referenceYear"], `${name}.referenceYear`, 1, MAX_U16);

  const assets = arrayValue(release["assets"], `${name}.assets`, true);
  for (const [index, asset] of assets.entries()) validateAsset(asset, `${name}.assets[${index}]`);
  rejectDuplicateKeys(assets, `${name}.assets.id`, (rawAsset, index) => {
    const asset = exactRecord(rawAsset, `${name}.assets[${index}]`, ASSET_FIELDS);
    return nonEmptyString(asset["id"], `${name}.assets[${index}].id`);
  });
  rejectDuplicateKeys(assets, `${name}.assets.numericId`, (rawAsset, index) => {
    const asset = exactRecord(rawAsset, `${name}.assets[${index}]`, ASSET_FIELDS);
    return safeInteger(asset["numericId"], `${name}.assets[${index}].numericId`, 1);
  });
  for (const [index, rawAsset] of assets.entries()) {
    const asset = exactRecord(rawAsset, `${name}.assets[${index}]`, ASSET_FIELDS);
    const buildYear = safeInteger(asset["buildYear"], `${name}.assets[${index}].buildYear`, 1, MAX_U16);
    if (buildYear > referenceYear) invalid(`${name}.assets[${index}].buildYear liegt nach referenceYear.`);
  }

  const pools = arrayValue(release["personnelPools"], `${name}.personnelPools`);
  for (const [index, pool] of pools.entries()) {
    validatePersonnelPool(pool, `${name}.personnelPools[${index}]`);
  }
  rejectDuplicateKeys(pools, `${name}.personnelPools.id`, (rawPool, index) => {
    const pool = exactRecord(rawPool, `${name}.personnelPools[${index}]`, PERSONNEL_POOL_FIELDS);
    return nonEmptyString(pool["id"], `${name}.personnelPools[${index}].id`);
  });
  rejectDuplicateKeys(pools, `${name}.personnelPools.numericId`, (rawPool, index) => {
    const pool = exactRecord(rawPool, `${name}.personnelPools[${index}]`, PERSONNEL_POOL_FIELDS);
    return safeInteger(pool["numericId"], `${name}.personnelPools[${index}].numericId`, 1);
  });

  const receipts = arrayValue(release["pathReceipts"], `${name}.pathReceipts`);
  for (const [index, receipt] of receipts.entries()) {
    validatePathReceipt(receipt, `${name}.pathReceipts[${index}]`);
  }
  rejectDuplicateKeys(receipts, `${name}.pathReceipts.id`, (rawReceipt, index) => {
    const receipt = exactRecord(rawReceipt, `${name}.pathReceipts[${index}]`, PATH_RECEIPT_FIELDS);
    return nonEmptyString(receipt["id"], `${name}.pathReceipts[${index}].id`);
  });
  rejectDuplicateKeys(receipts, `${name}.pathReceipts.numericRouteId`, (rawReceipt, index) => {
    const receipt = exactRecord(rawReceipt, `${name}.pathReceipts[${index}]`, PATH_RECEIPT_FIELDS);
    return safeInteger(receipt["numericRouteId"], `${name}.pathReceipts[${index}].numericRouteId`, 1);
  });

  const receiptsById = new Map<string, Record<string, unknown>>();
  for (const [index, rawReceipt] of receipts.entries()) {
    const receipt = exactRecord(rawReceipt, `${name}.pathReceipts[${index}]`, PATH_RECEIPT_FIELDS);
    receiptsById.set(nonEmptyString(receipt["id"], `${name}.pathReceipts[${index}].id`), receipt);
  }
  for (const [index, rawPool] of pools.entries()) {
    const poolName = `${name}.personnelPools[${index}]`;
    const pool = exactRecord(rawPool, poolName, PERSONNEL_POOL_FIELDS);
    const operatorId = nonEmptyString(pool["operatorId"], `${poolName}.operatorId`);
    for (const receiptId of stringArray(pool["pathReceiptIds"], `${poolName}.pathReceiptIds`)) {
      const receipt = receiptsById.get(receiptId);
      if (receipt === undefined) invalid(`${poolName} verweist auf unbekannten Trassenbeleg '${receiptId}'.`);
      if (receipt["operatorId"] !== operatorId) {
        invalid(`${poolName} verweist auf einen Trassenbeleg eines fremden Betreibers.`);
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return Object.freeze(value) as T;
}

function parseCatalog(raw: string): FleetAuthorityReleaseCatalog {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new TypeError("ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH enthaelt kein gueltiges JSON.", {
      cause: error,
    });
  }

  const catalog = exactRecord(value, "Katalog", CATALOG_FIELDS);
  if (catalog["schemaVersion"] !== FLEET_AUTHORITY_RELEASE_CATALOG_SCHEMA) {
    invalid("Katalog.schemaVersion ist unbekannt.");
  }
  const entries = arrayValue(catalog["entries"], "Katalog.entries", true);
  const releases = new Map<string, FleetAuthorityRelease>();
  for (const [index, rawEntry] of entries.entries()) {
    const entryName = `Katalog.entries[${index}]`;
    const entry = exactRecord(rawEntry, entryName, ENTRY_FIELDS);
    const worldId = nonEmptyString(entry["worldId"], `${entryName}.worldId`);
    if (!UUID_PATTERN.test(worldId)) {
      invalid(`${entryName}.worldId muss eine kleingeschriebene kanonische UUID sein.`);
    }
    if (releases.has(worldId)) invalid(`Katalog.entries enthaelt Welt '${worldId}' mehrfach.`);
    validateAuthorityRelease(entry["authorityRelease"], `${entryName}.authorityRelease`);
    const cloned = structuredClone(entry["authorityRelease"]);
    releases.set(worldId, deepFreeze(cloned));
  }

  const ordered = [...releases.entries()].sort(([left], [right]) => compareUtf8(left, right));
  return deepFreeze(Object.fromEntries(ordered)) as FleetAuthorityReleaseCatalog;
}

/**
 * Laedt den ausschliesslich serverseitig konfigurierten M5-Authority-Katalog.
 * Jeder Fehler an Pfad, Bytes oder Vertrag stoppt den Start fail-closed.
 */
export async function loadFleetAuthorityReleaseCatalog(
  configurationPath: string | undefined,
): Promise<FleetAuthorityReleaseCatalog> {
  if (configurationPath === undefined || configurationPath.length === 0) {
    throw new TypeError("ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH fehlt.");
  }
  if (!isAbsolute(configurationPath)) {
    throw new TypeError("ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH muss absolut sein.");
  }

  let metadata;
  try {
    metadata = await lstat(configurationPath);
  } catch (error) {
    throw new Error("ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH kann nicht gelesen werden.", {
      cause: error,
    });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError(
      "ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH muss eine regulaere Datei und darf kein Symlink sein.",
    );
  }
  if (metadata.size === 0 || metadata.size > MAX_CATALOG_BYTES) {
    throw new TypeError(
      `ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH muss zwischen 1 und ${MAX_CATALOG_BYTES} Bytes gross sein.`,
    );
  }

  const bytes = await readFile(configurationPath);
  if (bytes.byteLength !== metadata.size || bytes.byteLength > MAX_CATALOG_BYTES) {
    throw new Error("Der M5-Authority-Katalog wurde waehrend des Ladens veraendert.");
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError("ZUGFOLGE_FLEET_AUTHORITY_RELEASE_PATH ist kein gueltiges UTF-8.", {
      cause: error,
    });
  }
  return parseCatalog(raw);
}
