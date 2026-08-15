import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const realmPath = new URL("../../ops/alpha/keycloak/zugfolge-realm.json", import.meta.url);

test("alle Browseroberflaechen besitzen getrennte, eng begrenzte OIDC-Clients", async () => {
  const realm = JSON.parse(await readFile(realmPath, "utf8"));
  const clients = new Map(realm.clients.map((client) => [client.clientId, client]));
  const gameWeb = clients.get("game-web");
  const livemap = clients.get("livemap");
  const operationsCenter = clients.get("operations-center");

  assert.deepEqual(gameWeb.redirectUris, ["${GAME_WEB_URL}/*"]);
  assert.deepEqual(gameWeb.webOrigins, ["${GAME_WEB_URL}"]);
  assert.equal(gameWeb.publicClient, true);

  assert.deepEqual(livemap.redirectUris, ["${LIVEMAP_URL}/*"]);
  assert.deepEqual(livemap.webOrigins, ["${LIVEMAP_URL}"]);
  assert.equal(livemap.publicClient, true);
  assert.equal(livemap.standardFlowEnabled, true);
  assert.equal(
    livemap.protocolMappers[0]?.config?.["included.client.audience"],
    "game-api",
  );
  assert.deepEqual(operationsCenter.redirectUris, ["${OPERATIONS_CENTER_URL}/*"]);
  assert.deepEqual(operationsCenter.webOrigins, ["${OPERATIONS_CENTER_URL}"]);
  assert.equal(operationsCenter.publicClient, true);
  assert.equal(realm.accessTokenLifespan, 900);
});
