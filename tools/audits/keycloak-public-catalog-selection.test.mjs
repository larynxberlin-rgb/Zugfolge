import assert from "node:assert/strict";
import test from "node:test";

import { loadKeycloakObjectCatalog } from "../alpha-ops/keycloak-public-to-schema.mjs";
import {
  DATABASE_AUTHORITATIVE_TABLES,
  DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32,
} from "../alpha-ops/database-cutover-schema-contract.mjs";
import {
  auditKeycloakPublicCatalogCapture,
  auditKeycloakPublicCatalogFile,
  classifyKeycloakProductionCaptureRelations,
  deriveKeycloakSelectionSignatures,
} from "./keycloak-public-catalog-selection.mjs";

const capturePath = process.env.KEYCLOAK_PUBLIC_CATALOG_CAPTURE_PATH;

test("real PG16 public capture reproduces the committed Keycloak selection", { skip: capturePath === undefined }, async () => {
  const result = await auditKeycloakPublicCatalogFile(capturePath);
  assert.deepEqual(result.selection, { gameRelations: 51, keycloakRelations: 100, extensionRelations: 3 });
  assert.deepEqual(
    Object.fromEntries(Object.entries(result.signatures).map(([name, signature]) => [name, signature.count])),
    { relations: 100, columns: 614, constraints: 198, indexes: 246, triggers: 0, sequences: 0, views: 0, types: 0 },
  );
  assert.equal(result.capture.sha256, "2957676c917012447001576138f0e4cafd56276ce8f2fc61b3110581b05d2042");
  assert.equal(result.objectCatalogSha256, "d47bfd07124beea70db2e89207ce55b117afa6c671ece56eb6438f6225f6fe27");
});

test("catalog selection rejects captures with missing or foreign top-level fields", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  assert.throws(
    () => auditKeycloakPublicCatalogCapture({ foreign: true }, Buffer.from("{}"), Buffer.from("gzip"), catalog),
    /fremde oder fehlende Felder/u,
  );
});

test("catalog selection pins the historical schema-28 relation partition independently from today's schema-33 contract", async () => {
  const catalog = await loadKeycloakObjectCatalog();
  const extensionRelations = ["geography_columns", "geometry_columns", "spatial_ref_sys"];
  const relations = (gameNames) => [...gameNames, ...catalog.objects.tables, ...extensionRelations]
    .sort()
    .map((name) => ({ name }));

  const historical = classifyKeycloakProductionCaptureRelations(
    relations(DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32),
    catalog,
  );
  assert.equal(historical.gameNames.length, 51);
  assert.equal(historical.keycloakNames.length, 100);
  assert.equal(DATABASE_AUTHORITATIVE_TABLES.length, 52);

  assert.throws(
    () => classifyKeycloakProductionCaptureRelations(relations(DATABASE_AUTHORITATIVE_TABLES), catalog),
    /historische Schema-28-Relationenpartition/u,
  );
  assert.throws(
    () => classifyKeycloakProductionCaptureRelations(relations(DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32.slice(1)), catalog),
    /historische Schema-28-Relationenpartition/u,
  );
  const foreign = relations(DATABASE_AUTHORITATIVE_TABLES_SCHEMA_28_TO_32);
  foreign[0] = { name: "foreign_relation" };
  assert.throws(
    () => classifyKeycloakProductionCaptureRelations(foreign, catalog),
    /historische Schema-28-Relationenpartition/u,
  );
});

test("catalog selection shares the tombstone-neutral live-column contract", () => {
  const selected = (ordinals) => ({
    relations: [],
    columns: ordinals.map((ordinal, index) => ({
      name: ["id", "enabled", "client_id"][index],
      type: "character varying(255)",
      default: null,
      notNull: false,
      ordinal,
      identity: "",
      relation: "client",
      collation: "default",
      generated: "",
    })),
    constraints: [],
    indexes: [],
    triggers: [],
    sequences: [],
    views: [],
    types: [],
  });

  assert.deepEqual(
    deriveKeycloakSelectionSignatures(selected([2, 4, 7])).columns,
    deriveKeycloakSelectionSignatures(selected([1, 2, 3])).columns,
  );
});
