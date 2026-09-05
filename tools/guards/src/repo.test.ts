import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readRepository } from "./repo.js";
import { createCoverageRule } from "./rules/coverage.js";
import { testConfig } from "./testing.js";

const wurzeln: string[] = [];

function arbeitsbaum(dateien: Record<string, string | Uint8Array>): string {
  const wurzel = mkdtempSync(join(tmpdir(), "zugfolge-guards-"));
  wurzeln.push(wurzel);
  for (const [pfad, inhalt] of Object.entries(dateien)) {
    const ziel = join(wurzel, pfad);
    mkdirSync(dirname(ziel), { recursive: true });
    writeFileSync(ziel, inhalt);
  }
  return wurzel;
}

afterEach(() => {
  for (const wurzel of wurzeln.splice(0)) {
    rmSync(wurzel, { recursive: true, force: true });
  }
});

describe("readRepository", () => {
  it("meldet bisher unzugeordnete Python- und JSX-Quellen im echten Arbeitsbaum", () => {
    const wurzel = arbeitsbaum({
      "tools/new-import/extract.py": "print('Infrastruktur')\n",
      "apps/new-app/src/view.jsx": "export const View = () => <p>Zug</p>;\n",
      "docs/monorepo.md": "# Domänen\n",
    });
    const dateien = readRepository(wurzel, []);
    const befunde = createCoverageRule([]).check(dateien, testConfig({ domains: [] }));
    expect(befunde.map((befund) => befund.message)).toEqual([
      expect.stringContaining("apps/new-app/src/view.jsx"),
      expect.stringContaining("tools/new-import/extract.py"),
    ]);
  });

  it("liest nur Textformate und sortiert normalisierte Pfade", () => {
    const wurzel = arbeitsbaum({
      "z/src/main.ts": "const zug = 'Größe';\n",
      "assets/map.pmtiles": new Uint8Array([0, 255, 254]),
      "Dockerfile": "FROM scratch\n",
      "LICENSE": "Rechte\n",
      "a/readme.md": "# Bahnhof\n",
    });
    expect(readRepository(wurzel, [])).toEqual([
      { path: "Dockerfile", text: "FROM scratch\n" },
      { path: "LICENSE", text: "Rechte\n" },
      { path: "a/readme.md", text: "# Bahnhof\n" },
      { path: "z/src/main.ts", text: "const zug = 'Größe';\n" },
    ]);
  });

  it("schneidet ignorierte Verzeichnisse ab und beachtet dateibezogene Muster", () => {
    const wurzel = arbeitsbaum({
      "node_modules/external/index.js": "ignoriert",
      "apps/map/node_modules/external/index.js": "ignoriert",
      "apps/map/dist/index.js": "ignoriert",
      "apps/map/src/view.test.ts": "ignoriert",
      "apps/map/src/view.ts": "gelesen",
      "apps/map/src/node_modules_info.ts": "ebenfalls gelesen",
    });
    expect(readRepository(wurzel, ["**/node_modules", "**/dist", "**/*.test.ts"]))
      .toEqual([
        { path: "apps/map/src/node_modules_info.ts", text: "ebenfalls gelesen" },
        { path: "apps/map/src/view.ts", text: "gelesen" },
      ]);
  });
});
