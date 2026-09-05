import { describe, expect, it } from "vitest";
import { readGameHintPreferences } from "./game-hints.js";

describe("Lokale Spielhinweise", () => {
  it("bleibt bei gesperrtem, beschädigtem oder fremdem Speicher nutzbar", () => {
    for (const storage of [undefined, { getItem() { throw new Error("blocked"); } }, { getItem: () => "{" }, { getItem: () => '{"enabled":"false","visited":[]}' }]) {
      expect(readGameHintPreferences(storage)).toEqual({ enabled: true, visited: [] });
    }
  });
  it("erhält bewusstes Abschalten und verwirft ungültige Leseeinträge", () => {
    expect(readGameHintPreferences({ getItem: () => '{"enabled":false,"visited":["map-entry",null,42,"entry-contract"]}' }))
      .toEqual({ enabled: false, visited: ["map-entry", "entry-contract"] });
  });
});
