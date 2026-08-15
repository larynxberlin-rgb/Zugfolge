import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("alle Spieleroberflaechen beziehen dieselben Zugfolge-Gestaltungsvariablen", async () => {
  for (const source of ["apps/game-web/src/main.ts", "apps/livemap/src/main.ts", "apps/operations-center/src/main.ts"]) {
    assert.match(await readFile(new URL(`../../${source}`, import.meta.url), "utf8"), /@zugfolge\/design-system\/styles\.css/);
  }
  const liveStyle = await readFile(new URL("../../apps/livemap/src/style.css", import.meta.url), "utf8");
  assert.match(liveStyle, /--map: var\(--zf-canvas\)/);
  assert.match(liveStyle, /--focus: var\(--zf-focus\)/);
});
