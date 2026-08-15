import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("die Anmeldefehlerseite bietet sichere Wiederherstellung im Zugfolge-Design", async () => {
  const template = await readFile(new URL("../../ops/alpha/keycloak/themes/zugfolge/login/error.ftl", import.meta.url), "utf8");
  assert.match(template, /Erneut anmelden/);
  assert.match(template, /Zurück zu Zugfolge/);
  assert.match(template, /kcSanitize/);
  assert.doesNotMatch(template, /session_code|access_token|refresh_token/);
});
