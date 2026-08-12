import { describe, expect, it } from "vitest";

import { GLOSSARY_ENTRIES, filterGlossary } from "./index.js";

describe("M9.3 Glossar-Layer", () => {
  it("findet deutsche Fachbegriffe, Code-Bezeichner und diakritische Schreibweisen reproduzierbar", () => {
    expect(filterGlossary("trasse").map((entry) => entry.code)).toContain("path");
    expect(filterGlossary("oeffentliche stelle").map((entry) => entry.code)).toContain("authority");
    expect(filterGlossary("four_eyes").map((entry) => entry.term)).toEqual(["Vier-Augen-Prinzip"]);
    expect(filterGlossary("")).toBe(GLOSSARY_ENTRIES);
  });
});
