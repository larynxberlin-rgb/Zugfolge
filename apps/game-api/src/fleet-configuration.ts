import {
  FLEET_AUTHORITY_RELEASE_SCHEMA,
  FLEET_AUTHORITY_RELEASE_SCHEMA_V2,
  type FleetAuthorityRelease,
  validateFleetAuthorityRelease,
} from "@zugfolge/runtime-native";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

import { compareUtf8 } from "./utf8.js";

export const FLEET_AUTHORITY_RELEASE_CATALOG_SCHEMA =
  "zugfolge-fleet-authority-release-catalog/v1" as const;

export interface FleetAuthorityWorldConfiguration {
  /** Exakter Seed-Zeitpunkt des Compiler-Artefakts. */
  readonly producedAt: number;
  readonly authorityRelease: FleetAuthorityRelease;
}

export type FleetAuthorityReleaseCatalog = Readonly<
  Record<string, Readonly<FleetAuthorityWorldConfiguration>>
>;

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CATALOG_FIELDS = ["schemaVersion", "entries"] as const;
const LEGACY_ENTRY_FIELDS = ["worldId", "authorityRelease"] as const;
const V2_ENTRY_FIELDS = ["worldId", "producedAt", "authorityRelease"] as const;

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

function arrayValue(value: unknown, name: string, nonEmpty = false): readonly unknown[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    return invalid(`${name} muss ${nonEmpty ? "eine nichtleere " : "eine "}Liste sein.`);
  }
  return value;
}

function safeNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(`${name} muss eine sichere nichtnegative Ganzzahl sein.`);
  }
  return value as number;
}

function validateAuthorityRelease(value: unknown, name: string): asserts value is FleetAuthorityRelease {
  validateFleetAuthorityRelease(value, name);
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
  const configurations = new Map<string, Readonly<FleetAuthorityWorldConfiguration>>();
  for (const [index, rawEntry] of entries.entries()) {
    const entryName = `Katalog.entries[${index}]`;
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) {
      invalid(`${entryName} muss ein Objekt sein.`);
    }
    const rawAuthorityRelease = (rawEntry as Record<string, unknown>)["authorityRelease"];
    validateAuthorityRelease(rawAuthorityRelease, `${entryName}.authorityRelease`);
    const authorityV2 = rawAuthorityRelease.schemaVersion === FLEET_AUTHORITY_RELEASE_SCHEMA_V2;
    const entry = authorityV2
      ? exactRecord(rawEntry, entryName, V2_ENTRY_FIELDS)
      : exactRecord(rawEntry, entryName, LEGACY_ENTRY_FIELDS, ["producedAt"]);
    const worldId = nonEmptyString(entry["worldId"], `${entryName}.worldId`);
    if (!UUID_PATTERN.test(worldId)) {
      invalid(`${entryName}.worldId muss eine kleingeschriebene kanonische UUID sein.`);
    }
    if (configurations.has(worldId)) invalid(`Katalog.entries enthaelt Welt '${worldId}' mehrfach.`);
    const producedAt = authorityV2
      ? safeNonNegativeInteger(entry["producedAt"], `${entryName}.producedAt`)
      : entry["producedAt"] === undefined
        ? 0
        : safeNonNegativeInteger(entry["producedAt"], `${entryName}.producedAt`);
    if (!authorityV2 && rawAuthorityRelease.schemaVersion !== FLEET_AUTHORITY_RELEASE_SCHEMA) {
      invalid(`${entryName}.authorityRelease.schemaVersion ist unbekannt.`);
    }
    if (!authorityV2 && producedAt !== 0) {
      invalid(`${entryName}.producedAt darf fuer einen Legacy-Authority-v1-Katalog nur 0 sein.`);
    }
    const cloned = structuredClone(rawAuthorityRelease);
    configurations.set(worldId, deepFreeze({ producedAt, authorityRelease: cloned }));
  }

  const ordered = [...configurations.entries()].sort(([left], [right]) => compareUtf8(left, right));
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
