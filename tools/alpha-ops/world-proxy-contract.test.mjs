import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("Operations Center liegt vor dem Game-Web-Fallback und besitzt eine eigene App-Kennung", async () => {
  const caddy = await readFile(new URL("ops/alpha/Caddyfile.world.example", root), "utf8");
  const operations = caddy.indexOf("handle_path /operations/*");
  const fallback = caddy.indexOf("handle {");
  assert.ok(operations >= 0 && fallback > operations);
  assert.match(caddy, /operations-center:4175/);
  const html = await readFile(new URL("apps/operations-center/index.html", root), "utf8");
  assert.match(html, /name="zugfolge-app" content="operations-center"/);
  assert.match(html, /runtime-config\.js/);
});
