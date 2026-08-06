import { describe, expect, it } from "vitest";

import { layerSeparationRule } from "./rules/layer-separation.js";
import { sourceFile, testConfig } from "./testing.js";

function pruefe(path: string, text = ""): string[] {
  return layerSeparationRule.check([sourceFile(path, text)], testConfig()).map((b) => b.message);
}

describe("layer-separation", () => {
  it("meldet eine Balancing-Datei im öffentlichen Baum", () => {
    expect(pruefe("data/balancing/spnv.json").some((m) => m.includes("Proprietäre Schicht"))).toBe(
      true,
    );
  });

  it("meldet einen als Text abgelegten EconomyRelease", () => {
    expect(pruefe("welt/tarife.economyrelease.json").length).toBe(1);
  });

  it("meldet ein Markenasset", () => {
    expect(pruefe("assets/brand/logo.svg").length).toBe(1);
  });

  it("lässt gewöhnliche Dateien in Ruhe", () => {
    expect(pruefe("docs/economy.md")).toEqual([]);
    expect(pruefe("packages/economy/src/ledger.ts")).toEqual([]);
    expect(pruefe("data/economy-report.md")).toEqual([]);
  });

  it("achtet die sichtbare Ausnahme", () => {
    const text = "// guards:allow layer-separation — Beispieldatensatz für den Test der Pipeline\n{}";
    expect(pruefe("data/economy/beispiel.json", text)).toEqual([]);
  });
});
