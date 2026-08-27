import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

import { DATABASE_AUTHORITATIVE_TABLES } from "../alpha-ops/database-cutover-schema-contract.mjs";
import { keycloakColumnSignature, loadKeycloakObjectCatalog } from "../alpha-ops/keycloak-public-to-schema.mjs";

const EXTENSION_RELATIONS = Object.freeze(["geography_columns", "geometry_columns", "spatial_ref_sys"]);
const EXPECTED_CAPTURE_COUNTS = Object.freeze({ relations: 154, columns: 1186, constraints: 463, indexes: 407, triggers: 4, sequences: 0, views: 2, types: 0 });

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  }
  return value;
}

function schemaNeutralValue(value) {
  if (Array.isArray(value)) return value.map(schemaNeutralValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, schemaNeutralValue(value[key])]));
  }
  if (typeof value === "string") return value.replace(/\b(?:public|keycloak)\./gu, "<schema>.").replace(/\s+/gu, " ").trim();
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function signature(values) {
  return Object.freeze({ count: values.length, sha256: sha256(Buffer.from(JSON.stringify(schemaNeutralValue(values)), "utf8")) });
}

export function deriveKeycloakSelectionSignatures(selected) {
  exactKeys(selected, ["relations", "columns", "constraints", "indexes", "triggers", "sequences", "views", "types"], "Keycloak-Katalogselektion");
  return Object.fromEntries(Object.entries(selected).map(([name, values]) => [
    name,
    name === "columns" ? keycloakColumnSignature(values) : signature(values),
  ]));
}

function exactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} fehlt.`);
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} besitzt fremde oder fehlende Felder.`);
}

export function auditKeycloakPublicCatalogCapture(capture, captureBytes, gzipBytes, catalog) {
  exactKeys(capture, ["types", "views", "columns", "indexes", "triggers", "relations", "sequences", "constraints", "catalogSchema", "serverVersionNum"], "PG16-public-Katalogcapture");
  invariant(capture.catalogSchema === "zugfolge-production-public-pg-catalog/v1", "PG16-public-Katalogcapture besitzt ein unbekanntes Schema.");
  invariant(Math.trunc(Number(capture.serverVersionNum) / 10_000) === 16, "PG16-public-Katalogcapture stammt nicht aus PostgreSQL 16.");
  invariant(captureBytes.length === catalog.productionSnapshot.canonicalJsonBytes, "PG16-public-Katalogcapture besitzt eine unerwartete Bytegroesse.");
  invariant(sha256(captureBytes) === catalog.productionSnapshot.canonicalJsonSha256, "PG16-public-Katalogcapture besitzt einen unerwarteten kanonischen Hash.");
  invariant(sha256(gzipBytes) === catalog.productionSnapshot.gzipSha256, "PG16-public-Katalogcapture besitzt einen unerwarteten Gzip-Hash.");
  for (const [name, count] of Object.entries(EXPECTED_CAPTURE_COUNTS)) {
    invariant(Array.isArray(capture[name]) && capture[name].length === count, `PG16-public-Katalogcapture.${name} besitzt nicht exakt ${count} Eintraege.`);
  }

  const relationNames = capture.relations.map(({ name }) => name).sort();
  invariant(new Set(relationNames).size === relationNames.length, "PG16-public-Katalogcapture besitzt doppelte Relationen.");
  const gameNames = [...DATABASE_AUTHORITATIVE_TABLES].sort();
  const keycloakNames = [...catalog.objects.tables];
  const selectedNames = relationNames.filter((name) => !gameNames.includes(name) && !EXTENSION_RELATIONS.includes(name));
  invariant(JSON.stringify(selectedNames) === JSON.stringify(keycloakNames), "PG16-public-Katalogcapture trennt nicht exakt den eingecheckten Keycloak-Satz ab.");
  invariant(
    JSON.stringify([...gameNames, ...keycloakNames, ...EXTENSION_RELATIONS].sort()) === JSON.stringify(relationNames),
    "PG16-public-Katalogcapture enthaelt eine unbekannte oder nicht klassifizierte Relation.",
  );

  const selected = {
    relations: capture.relations.filter(({ name }) => keycloakNames.includes(name)),
    columns: capture.columns.filter(({ relation }) => keycloakNames.includes(relation)),
    constraints: capture.constraints.filter(({ relation }) => keycloakNames.includes(relation)),
    indexes: capture.indexes.filter(({ relation }) => keycloakNames.includes(relation)),
    triggers: capture.triggers.filter(({ relation }) => keycloakNames.includes(relation)),
    sequences: [],
    views: [],
    types: [],
  };
  const signatures = deriveKeycloakSelectionSignatures(selected);
  invariant(JSON.stringify(sortedValue(signatures)) === JSON.stringify(sortedValue(catalog.signatures)), "Abgeleitete Keycloak-Signaturen weichen vom eingecheckten Objektkatalog ab.");
  return Object.freeze({
    schema: "keycloak-public-catalog-selection-audit/v1",
    capture: Object.freeze({ bytes: captureBytes.length, sha256: sha256(captureBytes), gzipSha256: sha256(gzipBytes) }),
    selection: Object.freeze({ gameRelations: gameNames.length, keycloakRelations: keycloakNames.length, extensionRelations: EXTENSION_RELATIONS.length }),
    signatures,
    objectCatalogSha256: catalog.catalogSha256,
  });
}

export async function auditKeycloakPublicCatalogFile(path) {
  const base64Bytes = await readFile(path);
  const gzipBytes = Buffer.from(base64Bytes.toString("ascii").replace(/\s+/gu, ""), "base64");
  invariant(gzipBytes.length > 0, "PG16-public-Katalogcapture ist kein nichtleeres Base64-Gzip-Artefakt.");
  const captureBytes = gunzipSync(gzipBytes);
  let capture;
  try {
    capture = JSON.parse(captureBytes.toString("utf8"));
  } catch {
    throw new Error("PG16-public-Katalogcapture ist kein JSON.");
  }
  return auditKeycloakPublicCatalogCapture(capture, captureBytes, gzipBytes, await loadKeycloakObjectCatalog());
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = await auditKeycloakPublicCatalogFile(process.argv[2] ?? "");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
