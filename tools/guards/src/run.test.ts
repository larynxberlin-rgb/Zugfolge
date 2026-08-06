import { describe, expect, it } from "vitest";

import { filesForRule, formatFindings, runRules } from "./run.js";
import { sourceFile, testConfig, testDomain } from "./testing.js";
import type { Finding, Rule, SourceFile } from "./types.js";

function meldeAlles(id: string, scope: Rule["scope"]): Rule {
  return {
    id,
    title: `Testregel ${id}`,
    scope,
    check(files: readonly SourceFile[]): Finding[] {
      return files.map((datei) => ({ rule: id, path: datei.path, line: 1, message: "Treffer" }));
    },
  };
}

const config = testConfig({
  domains: [
    testDomain({ id: "kern", paths: ["kern/**"], rules: ["eng"] }),
    testDomain({ id: "rand", paths: ["rand/**"], rules: [] }),
  ],
});

const dateien = [
  sourceFile("kern/a.rs", ""),
  sourceFile("rand/b.ts", ""),
  sourceFile("docs/c.md", ""),
];

describe("filesForRule", () => {
  it("liefert nur die Dateien der Domänen, die die Regel führen", () => {
    expect(filesForRule(dateien, config, "eng").map((datei) => datei.path)).toEqual(["kern/a.rs"]);
  });

  it("liefert nichts, wenn keine Domäne die Regel führt", () => {
    expect(filesForRule(dateien, config, "kennt-niemand")).toEqual([]);
  });
});

describe("runRules", () => {
  it("beschränkt domänengebundene Regeln auf ihre Domäne", () => {
    const befunde = runRules(dateien, config, [meldeAlles("eng", "domains")]);
    expect(befunde.map((befund) => befund.path)).toEqual(["kern/a.rs"]);
  });

  it("lässt Repositoriumsregeln über alles laufen", () => {
    const befunde = runRules(dateien, config, [meldeAlles("weit", "repository")]);
    expect(befunde).toHaveLength(3);
  });

  it("sortiert die Befunde stabil", () => {
    const befunde = runRules(dateien, config, [
      meldeAlles("zweite", "repository"),
      meldeAlles("erste", "repository"),
    ]);
    expect(befunde[0]?.rule).toBe("erste");
    expect(befunde.map((befund) => befund.path).slice(0, 3)).toEqual([
      "docs/c.md",
      "kern/a.rs",
      "rand/b.ts",
    ]);
  });
});

describe("formatFindings", () => {
  it("meldet Fehlerfreiheit deutlich", () => {
    expect(formatFindings([])).toContain("keine Befunde");
  });

  it("nennt Ort und Grund", () => {
    const text = formatFindings([
      { rule: "no-floats", path: "a.rs", line: 12, message: "Gleitkomma" },
      { rule: "no-floats", path: "b.rs", line: 0, message: "ganze Datei" },
    ]);
    expect(text).toContain("a.rs:12");
    expect(text).toContain("b.rs\n");
    expect(text).toContain("2 Befund(e).");
  });
});
