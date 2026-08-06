import { describe, expect, it } from "vitest";

import { brandRule, hashToken } from "./rules/brand.js";
import { createCoverageRule, MONOREPOPFAD } from "./rules/coverage.js";
import { GLOSSARPFAD, MINDESTEINTRAEGE, parseGlossary, sortSchluessel } from "./rules/glossary.js";
import { ALL_RULES } from "./rules/index.js";
import { worldIdRule } from "./rules/world-id.js";
import { sourceFile, testConfig, testDomain } from "./testing.js";
import type { Domain, SourceFile } from "./types.js";

describe("Regelverzeichnis", () => {
  it("hat eindeutige Kennungen", () => {
    const kennungen = ALL_RULES.map((regel) => regel.id);
    expect(new Set(kennungen).size).toBe(kennungen.length);
  });

  it("beschreibt jede Regel", () => {
    for (const regel of ALL_RULES) {
      expect(regel.title.length).toBeGreaterThan(10);
    }
  });
});

describe("world-id", () => {
  it("meldet eine SQL-Tabelle ohne Weltbezug", () => {
    const text = "CREATE TABLE train_run (\n  id uuid primary key,\n  nummer text\n);";
    const befunde = worldIdRule.check([sourceFile("db/001.sql", text)], testConfig());
    expect(befunde).toHaveLength(1);
    expect(befunde[0]?.message).toContain("train_run");
  });

  it("lässt eine Tabelle mit Weltbezug zu", () => {
    const text = "CREATE TABLE train_run (\n  world_id uuid not null,\n  id uuid\n);";
    expect(worldIdRule.check([sourceFile("db/001.sql", text)], testConfig())).toEqual([]);
  });

  it("prüft jede Tabelle einer Datei einzeln", () => {
    const text =
      "CREATE TABLE a (world_id uuid, x int);\nCREATE TABLE b (y int);\n" +
      "CREATE TABLE c (world_id uuid);\n";
    const befunde = worldIdRule.check([sourceFile("db/001.sql", text)], testConfig());
    expect(befunde).toHaveLength(1);
    expect(befunde[0]?.line).toBe(2);
  });

  it("meldet ein Drizzle-Schema ohne Weltbezug", () => {
    const text = 'export const laeufe = pgTable("train_run", {\n  id: uuid("id"),\n});';
    expect(worldIdRule.check([sourceFile("packages/db/schema.ts", text)], testConfig()))
      .toHaveLength(1);
  });
});

describe("glossary", () => {
  const kopf = "| Begriff | Bezeichner | Bedeutung | Quelle |\n|---|---|---|---|\n";
  const glossarRegel = ALL_RULES.find((regel) => regel.id === "glossary");

  function pruefe(text: string): string[] {
    return (glossarRegel?.check([sourceFile(GLOSSARPFAD, text)], testConfig()) ?? []).map(
      (befund) => befund.message,
    );
  }

  it("liest die Tabellenzeilen", () => {
    const eintraege = parseGlossary(`${kopf}| Trasse | Path | Fahrweg | infrastruktur.md |\n`);
    expect(eintraege).toHaveLength(1);
    expect(eintraege[0]?.identifier).toBe("Path");
  });

  it("sortiert umlautunabhängig", () => {
    expect(sortSchluessel("Übergabe")).toBe("ubergabe");
    expect(sortSchluessel("Sperrzeit (Treppe)")).toBe("sperrzeittreppe");
  });

  it("meldet doppelte Begriffe", () => {
    const text = `${kopf}| A | Ae | x | q |\n| A | Af | y | q |\n`;
    expect(pruefe(text).some((meldung) => meldung.includes("steht schon"))).toBe(true);
  });

  it("meldet doppelte Bezeichner", () => {
    const text = `${kopf}| A | Same | x | q |\n| B | Same | y | q |\n`;
    expect(pruefe(text).some((meldung) => meldung.includes("Bezeichner"))).toBe(true);
  });

  it("meldet unsortierte Einträge", () => {
    const text = `${kopf}| Zug | A | x | q |\n| Anschluss | B | y | q |\n`;
    expect(pruefe(text).some((meldung) => meldung.includes("Reihenfolge"))).toBe(true);
  });

  it("meldet fehlende Bedeutung oder Quelle", () => {
    const text = `${kopf}| A | Ae |  | q |\n`;
    expect(pruefe(text).some((meldung) => meldung.includes("Behauptung"))).toBe(true);
  });

  it("meldet ein zu dünnes Glossar", () => {
    const text = `${kopf}| A | Ae | x | q |\n`;
    expect(pruefe(text).some((meldung) => meldung.includes(String(MINDESTEINTRAEGE)))).toBe(true);
  });

  it("meldet ein fehlendes Glossar", () => {
    const befunde = glossarRegel?.check([sourceFile("README.md", "")], testConfig()) ?? [];
    expect(befunde).toHaveLength(1);
    expect(befunde[0]?.message).toContain("fehlt");
  });
});

describe("coverage", () => {
  const regel = createCoverageRule(["no-floats", "coverage"]);
  const monorepo = sourceFile(MONOREPOPFAD, "Domänen: kern, spaeter");

  function nachrichten(dateien: readonly SourceFile[], domains: readonly Domain[]): string[] {
    return regel.check(dateien, testConfig({ domains })).map((befund) => befund.message);
  }

  it("meldet eine aktive Domäne ohne Dateien", () => {
    const domains = [testDomain({ id: "kern", status: "active", paths: ["kern/**"] })];
    expect(nachrichten([monorepo], domains).some((m) => m.includes("verschoben"))).toBe(true);
  });

  it("meldet eine geplante Domäne, die schon Code hat", () => {
    const domains = [testDomain({ id: "spaeter", status: "planned", paths: ["spaeter/**"] })];
    const dateien = [monorepo, sourceFile("spaeter/src/lib.rs", "")];
    expect(nachrichten(dateien, domains).some((m) => m.includes("'active'"))).toBe(true);
  });

  it("meldet eine unbekannte Regelkennung", () => {
    const domains = [
      testDomain({ id: "kern", status: "active", paths: ["kern/**"], rules: ["gibt-es-nicht"] }),
    ];
    const dateien = [monorepo, sourceFile("kern/src/lib.rs", "")];
    expect(nachrichten(dateien, domains).some((m) => m.includes("unbekannte Regel"))).toBe(true);
  });

  it("meldet eine Domäne, die nicht beschrieben ist", () => {
    const domains = [testDomain({ id: "unbeschrieben", status: "active", paths: ["u/**"] })];
    const dateien = [monorepo, sourceFile("u/src/lib.rs", "")];
    expect(nachrichten(dateien, domains).some((m) => m.includes("nicht beschrieben"))).toBe(true);
  });

  it("schweigt, wenn alles stimmt", () => {
    const domains = [
      testDomain({ id: "kern", status: "active", paths: ["kern/**"], rules: ["no-floats"] }),
      testDomain({ id: "spaeter", status: "planned", paths: ["spaeter/**"] }),
    ];
    expect(nachrichten([monorepo, sourceFile("kern/src/lib.rs", "")], domains)).toEqual([]);
  });
});

describe("no-brand-citation", () => {
  it("schweigt mit leerer Liste", () => {
    const dateien = [sourceFile("docs/a.md", "Beispielwort steht hier.")];
    expect(brandRule.check(dateien, testConfig())).toEqual([]);
  });

  it("meldet ein Wort, ohne es zu nennen", () => {
    const config = testConfig({ brandTokenHashes: [hashToken("Beispielwort")] });
    const dateien = [sourceFile("docs/a.md", "Hier steht beispielwort mittendrin.")];
    const befunde = brandRule.check(dateien, config);
    expect(befunde).toHaveLength(1);
    expect(befunde[0]?.message).not.toContain("eispielwort");
  });

  it("übergeht kurze Wörter", () => {
    const config = testConfig({ brandTokenHashes: [hashToken("ab")] });
    expect(brandRule.check([sourceFile("a.md", "ab ab ab")], config)).toEqual([]);
  });
});
