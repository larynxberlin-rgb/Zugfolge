import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("der produktive Start gleicht alle drei Browser-Clients idempotent ab", async () => {
  const compose = await readFile(new URL("../../compose.alpha.yml", import.meta.url), "utf8");
  const script = await readFile(new URL("./reconcile-keycloak-clients.mjs", import.meta.url), "utf8");
  assert.match(compose, /keycloak-reconcile:/);
  assert.match(compose, /reconcile-keycloak-clients\.mjs/);
  assert.match(script, /\["operations-center", process\.env\.OPERATIONS_CENTER_URL\]/);
  assert.match(script, /method: "PUT"/);
  assert.match(script, /accessTokenLifespan: 900/);
});
