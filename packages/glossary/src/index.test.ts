import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { GLOSSARY_ENTRIES, filterGlossary, glossaryEntryByCode } from "./index.js";

describe("M9.3 Glossar-Layer", () => {
  it("findet deutsche Fachbegriffe, Code-Bezeichner und diakritische Schreibweisen reproduzierbar", () => {
    expect(filterGlossary("trasse").map((entry) => entry.code)).toContain("TrainPath");
    expect(filterGlossary("aufgabentraeger").map((entry) => entry.code)).toContain("TransportAuthority");
    expect(filterGlossary("FourEyesApproval").map((entry) => entry.term)).toEqual(["Vier-Augen-Prinzip"]);
    expect(filterGlossary("durchrutschweg").map((entry) => entry.code)).toContain("OverlapPath");
    expect(filterGlossary("bremshundertstel").map((entry) => entry.code)).toEqual(["BrakePercentage"]);
    expect(filterGlossary("wendezeit").map((entry) => entry.code)).toContain("TurnaroundTime");
    expect(filterGlossary("")).toBe(GLOSSARY_ENTRIES);
    expect(glossaryEntryByCode("BlockingTime")?.term).toBe("Sperrzeit");
    expect(glossaryEntryByCode("missing")).toBeUndefined();
    expect(GLOSSARY_ENTRIES.length).toBeGreaterThan(100);
    expect(new Set(GLOSSARY_ENTRIES.map((entry) => entry.code)).size).toBe(GLOSSARY_ENTRIES.length);
  });

  it("reserviert bei 320 bis 1280 Pixeln eigenen Raum statt Aktionsflächen zu überdecken", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).toContain("position: relative");
    expect(css).not.toMatch(/\.zf-glossary\s*\{[^}]*position:\s*fixed/s);
    expect(css).toContain("max-width: 420px");
  });
});
