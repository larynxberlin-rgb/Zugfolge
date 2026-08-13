import { describe, expect, it } from "vitest";

import { brandRule, hashToken } from "./rules/brand.js";
import { createCoverageRule, MONOREPOPFAD } from "./rules/coverage.js";
import { decisionConsistencyRule } from "./rules/decision-consistency.js";
import { GLOSSARPFAD, MINDESTEINTRAEGE, parseGlossary, sortSchluessel } from "./rules/glossary.js";
import { ALL_RULES } from "./rules/index.js";
import { worldIdRule } from "./rules/world-id.js";
import { rustReleasePipelineRule } from "./rules/rust-release-pipeline.js";
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

  it("lässt die Weltwurzeltabelle 'worlds' ohne eigene world_id zu", () => {
    const text = "CREATE TABLE worlds (\n  id uuid primary key,\n  name text\n);";
    expect(worldIdRule.check([sourceFile("db/001.sql", text)], testConfig())).toEqual([]);
  });

  it("erlaubt eine Tabelle ohne world_id nur mit sichtbarer Ausnahme", () => {
    const text =
      "-- guards:allow world-id — Testfixtur, keine echte Tabelle\n" +
      "CREATE TABLE spike_only (\n  id uuid primary key\n);";
    expect(worldIdRule.check([sourceFile("db/001.sql", text)], testConfig())).toEqual([]);
  });

  it("meldet einen SQL-Index ohne world_id", () => {
    const text =
      'CREATE TABLE train_run (world_id uuid not null, id uuid, started_at timestamptz);\n' +
      'CREATE INDEX train_run_started_idx ON train_run (started_at);';
    const befunde = worldIdRule.check([sourceFile("db/001.sql", text)], testConfig());
    expect(befunde).toHaveLength(1);
    expect(befunde[0]?.message).toContain("train_run_started_idx");
  });

  it("lässt einen SQL-Index mit world_id zu, auch mit USING-Klausel", () => {
    const text =
      'CREATE TABLE train_run (world_id uuid not null, id uuid, started_at timestamptz);\n' +
      'CREATE INDEX train_run_world_started_idx ON train_run USING btree (world_id, started_at);';
    expect(worldIdRule.check([sourceFile("db/001.sql", text)], testConfig())).toEqual([]);
  });

  it("braucht keinen world_id-Index auf der Weltwurzeltabelle", () => {
    const text =
      "CREATE TABLE worlds (id uuid primary key, name text);\n" +
      "CREATE INDEX worlds_name_idx ON worlds (name);";
    expect(worldIdRule.check([sourceFile("db/001.sql", text)], testConfig())).toEqual([]);
  });

  it("meldet einen Drizzle-Index ohne worldId", () => {
    const text =
      'export const laeufe = pgTable("train_run", {\n' +
      '  worldId: uuid("world_id").notNull(),\n' +
      '  startedAt: timestamp("started_at"),\n' +
      "}, (table) => [\n" +
      '  index("train_run_started_idx").on(table.startedAt),\n' +
      "]);";
    const befunde = worldIdRule.check([sourceFile("packages/db/schema.ts", text)], testConfig());
    expect(befunde).toHaveLength(1);
    expect(befunde[0]?.message).toContain("train_run_started_idx");
  });

  it("lässt einen Drizzle-Index mit worldId zu", () => {
    const text =
      'export const laeufe = pgTable("train_run", {\n' +
      '  worldId: uuid("world_id").notNull(),\n' +
      '  startedAt: timestamp("started_at"),\n' +
      "}, (table) => [\n" +
      '  index("train_run_world_started_idx").on(table.worldId, table.startedAt),\n' +
      "]);";
    expect(worldIdRule.check([sourceFile("packages/db/schema.ts", text)], testConfig())).toEqual([]);
  });
  it("meldet produktive SELECT-, UPDATE- und DELETE-Queries ohne Weltfilter", () => {
    for (const [name, query] of [
      ["select", "return db.select().from(trainRuns).where(eq(trainRuns.id, id));"],
      ["update", "return tx.update(trainRuns).set({ status: 'done' }).where(eq(trainRuns.id, id));"],
      ["delete", "return db.delete(trainRuns).where(eq(trainRuns.id, id));"],
    ] as const) {
      const findings = worldIdRule.check([sourceFile(`packages/example/src/${name}.ts`, query)], testConfig());
      expect(findings.map((finding) => finding.message)).toEqual([expect.stringContaining("bindet keine Welt")]);
    }
  });

  it("meldet auch rohe SELECT-, UPDATE- und DELETE-Templates ohne Weltfilter", () => {
    for (const query of [
      "await db.execute(sql`select * from train_runs where id = ${id}`);",
      "await db.execute(sql`select world_id from train_runs where id = ${id}`);",
      "await tx.execute(sql`update train_runs set state = 'done' where id = ${id}`);",
      "await db.execute(sql`delete from train_runs where id = ${id}`);",
    ]) {
      expect(worldIdRule.check([sourceFile("packages/example/src/raw.ts", query)], testConfig()))
        .toEqual([expect.objectContaining({ message: expect.stringContaining("bindet keine Welt") })]);
    }
    expect(worldIdRule.check([sourceFile(
      "packages/example/src/raw.ts",
      "await db.execute(sql`delete from ${trainRuns} where ${trainRuns.worldId} = ${worldId}`);",
    )], testConfig())).toEqual([]);
    expect(worldIdRule.check([sourceFile(
      "packages/example/src/schema-probe.ts",
      "await db.execute(sql`select world_id from train_runs limit 0`);",
    )], testConfig())).toEqual([]);
  });

  it("akzeptiert Weltfilter direkt oder ueber einen lokalen Scope-Helper", () => {
    const direct = "return db.update(trainRuns).set({ status: 'done' }).where(and(eq(trainRuns.worldId, worldId), eq(trainRuns.id, id)));";
    const helper = "function commandScope(input: { worldId: string }) { return eq(trainRuns.worldId, input.worldId); }\nreturn db.select().from(trainRuns).where(commandScope(input));";
    expect(worldIdRule.check([sourceFile("packages/example/src/direct.ts", direct)], testConfig())).toEqual([]);
    expect(worldIdRule.check([sourceFile("packages/example/src/helper.ts", helper)], testConfig())).toEqual([]);
  });

  it("wertet Property-Namen und Stringwerte nicht als Helper aus und bleibt fail-closed", () => {
    const query = [
      "const status = eq(records.worldId, worldId);",
      "const eligible = eq(records.status, 'pending');",
      "return db.select().from(records).where(eligible);",
    ].join("\n");
    expect(worldIdRule.check([sourceFile("packages/example/src/queue.ts", query)], testConfig()))
      .toEqual([expect.objectContaining({ message: expect.stringContaining("bindet keine Welt") })]);
  });

  it("akzeptiert keinen Weltfilter einer unbeteiligten Tabelle", () => {
    for (const [path, query] of [
      [
        "packages/example/src/foreign-filter.tsx",
        "return db.select().from(trainRuns).where(eq(otherTable.worldId, worldId));",
      ],
      [
        "packages/example/src/foreign-helper.mjs",
        "const foreignScope = () => eq(otherTable.worldId, worldId);\nreturn db.select().from(trainRuns).where(foreignScope());",
      ],
      [
        "packages/example/src/foreign-raw.js",
        "return db.execute(sql`select * from train_runs where ${otherTable.worldId} = ${worldId}`);",
      ],
    ] as const) {
      expect(worldIdRule.check([sourceFile(path, query)], testConfig()))
        .toEqual([expect.objectContaining({ message: expect.stringContaining("bindet keine Welt") })]);
    }
  });

  it("prueft produktive TypeScript-, JavaScript- und Moduldateien", () => {
    for (const extension of ["tsx", "js", "jsx", "mjs", "cjs"]) {
      const path = `packages/example/src/query.${extension}`;
      const query = "return db.select().from(trainRuns).where(eq(trainRuns.id, id));";
      expect(worldIdRule.check([sourceFile(path, query)], testConfig()).map((finding) => finding.path))
        .toEqual([path]);
    }
  });

  it("ignoriert Tests und verlangt bei produktiven Globalabfragen eine begruendete Ausnahme", () => {
    const query = "return db.select().from(globalReceipts).where(eq(globalReceipts.id, id));";
    expect(worldIdRule.check([sourceFile("packages/example/src/store.test.ts", query)], testConfig())).toEqual([]);
    expect(worldIdRule.check([sourceFile("packages/example/src/store.ts", `// guards:allow world-id — globale Odoo-Empfangsbelege besitzen bewusst keine Welt.\n${query}`)], testConfig())).toEqual([]);
    expect(worldIdRule.check([sourceFile("packages/example/src/store.ts", `// guards:allow world-id\n${query}`)], testConfig()).map((finding) => finding.message))
      .toEqual([expect.stringContaining("konkrete Begruendung")]);
  });

  it("schuetzt die vier im Audit beanstandeten Query-Schnitte als Negativ-Fixtures", () => {
    for (const path of [
      "packages/mailbox/src/mailbox.ts",
      "packages/commerce/src/store.ts",
      "packages/planning-worker/src/worker.ts",
      "packages/economy/src/state-store.ts",
    ]) {
      const query = "return tx.update(records).set({ status: 'done' }).where(eq(records.id, id));";
      expect(worldIdRule.check([sourceFile(path, query)], testConfig()).map((finding) => finding.path)).toEqual([path]);
    }
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

  function nachrichten(
    dateien: readonly SourceFile[],
    domains: readonly Domain[],
    coverageExceptions: readonly { path: string; reason: string }[] = [],
  ): string[] {
    return regel.check(dateien, testConfig({ domains, coverageExceptions })).map((befund) => befund.message);
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

  it("meldet ein neues Produktionspaket ohne Domänenzuordnung", () => {
    const domains = [testDomain({ id: "kern", status: "active", paths: ["kern/**"] })];
    const dateien = [
      monorepo,
      sourceFile("kern/src/lib.rs", ""),
      sourceFile("packages/neue-fachlichkeit/package.json", "{}"),
    ];
    expect(nachrichten(dateien, domains).some((m) => m.includes("keinem Wächterbereich")))
      .toBe(true);
  });

  it("akzeptiert ein ausdrücklich zugeordnetes Produktionspaket", () => {
    const domains = [
      testDomain({ id: "plattform", status: "active", paths: ["packages/bekannt/**"] }),
    ];
    const beschrieben = sourceFile(MONOREPOPFAD, "Domänen: plattform");
    expect(
      nachrichten(
        [beschrieben, sourceFile("packages/bekannt/package.json", "{}")],
        domains,
      ),
    ).toEqual([]);
  });

  it("weist einen Catch-all für Produktionspakete zurück", () => {
    const domains = [
      testDomain({ id: "plattform", status: "active", paths: ["packages/**"] }),
    ];
    const beschrieben = sourceFile(MONOREPOPFAD, "Domänen: plattform");
    expect(
      nachrichten(
        [beschrieben, sourceFile("packages/bekannt/package.json", "{}")],
        domains,
      ).some((m) => m.includes("zu breiten Pfad")),
    ).toBe(true);
  });

  it("weist Lücken und Überlappungen für jede produktive Source-Datei mit Pfadangabe zurück", () => {
    const domains = [
      testDomain({ id: "wirtschaft", paths: ["packages/cooperation/**"] }),
      testDomain({ id: "plattform", paths: ["packages/cooperation/src/shared.ts"] }),
    ];
    const beschrieben = sourceFile(MONOREPOPFAD, "Domänen: wirtschaft, plattform");
    const messages = nachrichten([
      beschrieben,
      sourceFile("packages/cooperation/src/shared.ts", "export {}"),
      sourceFile("packages/unzugeordnet/src/index.ts", "export {}"),
    ], domains);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining("packages/cooperation/src/shared.ts' überlappt"),
      expect.stringContaining("packages/unzugeordnet/src/index.ts' hat keine aktive Domäne"),
    ]));
  });

  it("prueft auch produktive Release-Werkzeuge unter tools auf genau eine Domaene", () => {
    const domains = [testDomain({ id: "infra", paths: ["tools/reference-corpus/**"] })];
    const beschrieben = sourceFile(MONOREPOPFAD, "Domänen: infra");
    const messages = nachrichten([
      beschrieben,
      sourceFile("tools/reference-corpus/cli.mjs", "export {}"),
      sourceFile("tools/region-import/germany/build-germany-release.mjs", "export {}"),
    ], domains);
    expect(messages).toEqual([expect.stringContaining("build-germany-release.mjs")]);
  });

  it("akzeptiert eine enge, begründete Lücken-Ausnahme und meldet eine veraltete Ausnahme", () => {
    const domains = [testDomain({ id: "wirtschaft", paths: ["packages/cooperation/**"] })];
    const beschrieben = sourceFile(MONOREPOPFAD, "Domänen: wirtschaft");
    const ausnahme = [{
      path: "packages/legacy/src/generated.ts",
      reason: "Generierter Kompatibilitaetsadapter ohne eigene fachliche Autoritaet.",
    }];
    expect(nachrichten([
      beschrieben,
      sourceFile("packages/cooperation/src/index.ts", "export {}"),
      sourceFile("packages/legacy/src/generated.ts", "export {}"),
    ], domains, ausnahme)).toEqual([]);
    expect(nachrichten([
      beschrieben,
      sourceFile("packages/cooperation/src/index.ts", "export {}"),
    ], domains, [{
      path: "packages/cooperation/src/index.ts",
      reason: "Diese absichtlich veraltete Testausnahme prueft die Drift-Erkennung.",
    }]))
      .toEqual(expect.arrayContaining([expect.stringContaining("ist veraltet")]));
  });

  it("schweigt, wenn alles stimmt", () => {
    const domains = [
      testDomain({ id: "kern", status: "active", paths: ["kern/**"], rules: ["no-floats"] }),
      testDomain({ id: "spaeter", status: "planned", paths: ["spaeter/**"] }),
    ];
    expect(nachrichten([monorepo, sourceFile("kern/src/lib.rs", "")], domains)).toEqual([]);
  });
});

describe("decision-consistency", () => {
  const files = [
    sourceFile("docs/entscheidungen.md", "| E1 | **Eins** | Grund |\n| E2 | **Zwei** | Grund |\n"),
    sourceFile("AGENTS.md", "E1–E2\n| E1 | Eins |\n| E2 | Zwei |\n"),
    sourceFile(
      "docs/adr/README.md",
      "E1–E2\n| [0001](0001-eins.md) | E1 | Eins |\n| [0002](0002-zwei.md) | E2 | Zwei |\n",
    ),
    sourceFile("docs/adr/0001-eins.md", "- **Status:** Angenommen (entspricht E1)"),
    sourceFile("docs/adr/0002-zwei.md", "- **Status:** Angenommen (entspricht E2)"),
    sourceFile("CLAUDE.md", "Bindende Grundlage: AGENTS.md"),
  ];

  it("akzeptiert eine lückenlose, zentral referenzierte Entscheidungsliste", () => {
    expect(decisionConsistencyRule.check(files, testConfig())).toEqual([]);
  });

  it("meldet eine neue Entscheidung, die im Agenteneinstieg fehlt", () => {
    const drift = files.map((file) =>
      file.path === "AGENTS.md"
        ? sourceFile("AGENTS.md", "E1–E1\n| E1 | Eins |\n")
        : file,
    );
    expect(decisionConsistencyRule.check(drift, testConfig()).map((finding) => finding.path))
      .toContain("AGENTS.md");
  });

  it("meldet ein fehlendes ADR", () => {
    const missing = files.filter((file) => file.path !== "docs/adr/0002-zwei.md");
    expect(decisionConsistencyRule.check(missing, testConfig()).map((finding) => finding.message))
      .toEqual(expect.arrayContaining([expect.stringContaining("genau ein ADR")]));
  });
});

describe("rust-release-pipeline", () => {
  it("meldet einen autoritativen JavaScript-Releasebuilder", () => {
    const code = 'const release = { schema: "zugfolge-infra-release/v2" };';
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("tools/region-import/release-builder.mjs", code)],
        testConfig(),
      ),
    ).toHaveLength(1);
  });

  it("prüft auch TypeScript-UI-Dateien auf das autoritative Schema", () => {
    const code = 'const release = { schema: "zugfolge-annual-infra-plan/v1" };';
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("apps/admin/src/release.tsx", code)],
        testConfig(),
      ),
    ).toHaveLength(1);
  });

  it("meldet die Referenzkorpus-Qualifikation außerhalb Rust", () => {
    const code = "export function createQualifiedReleaseManifest(input) { return input; }";
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("tools/reference-corpus/release.mjs", code)],
        testConfig(),
      ),
    ).toHaveLength(1);
  });

  it("verhindert eine zweite JavaScript-Schemakonstante für qualifizierte Releases", () => {
    const code = 'const QUALIFIED_RELEASE_SCHEMA = "zugfolge-qualified-infra-release-manifest/v1";';
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("tools/reference-corpus/schema.mjs", code)],
        testConfig(),
      ),
    ).toHaveLength(1);
  });

  it("verweigert eine reportbasierte Qualifikation ohne vollständige Artefaktbytes", () => {
    const code = "const release = qualifiedReleaseFromRust({ report: claimedReport });";
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("tools/reference-corpus/finalize.mjs", code)],
        testConfig(),
      ),
    ).toHaveLength(1);
  });

  it("verweigert einen produktiven v3-Vergleich in JavaScript", () => {
    const code = "const report = compareWithModel(corpus, model, tolerance, context);";
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("tools/reference-corpus/production.mjs", code)],
        testConfig(),
      ),
    ).toHaveLength(1);
  });

  it("erlaubt den isolierten Legacy-v2-Vorschauadapter", () => {
    const code = "return compareWithModel(corpus, model, tolerance);";
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("tools/reference-corpus/legacy-preview.mjs", code)],
        testConfig(),
      ),
    ).toEqual([]);
  });

  it("verweigert produktive JavaScript-Prüfung von Qualifikationsnachweisen", () => {
    const code = "await verifyQualificationEvidenceFiles(evidence, root);";
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("tools/reference-corpus/production-chain.mjs", code)],
        testConfig(),
      ),
    ).toHaveLength(1);
  });

  it("erlaubt einen dünnen JavaScript-Prozessaufruf", () => {
    const code = 'spawn("cargo", ["run", "--bin", "zugfolge-infra-release"]);';
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("tools/region-import/build-infra-release.mjs", code)],
        testConfig(),
      ),
    ).toEqual([]);
  });

  it("erlaubt den autoritativen Rust-Compiler", () => {
    expect(
      rustReleasePipelineRule.check(
        [sourceFile("crates/zugfolge-infra/src/release_manifest.rs", "build_public_infra_release")],
        testConfig(),
      ),
    ).toEqual([]);
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
