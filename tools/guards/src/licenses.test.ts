import { describe, expect, it } from "vitest";

import {
  classifyLicenses,
  licenseReport,
  parsePnpmLicenses,
  satisfiesLicense,
} from "./licenses.js";

const ERLAUBT = new Set(["MIT", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "ISC"]);

describe("satisfiesLicense", () => {
  it("erkennt einfache Kennungen", () => {
    expect(satisfiesLicense("MIT", ERLAUBT)).toBe(true);
    expect(satisfiesLicense("GPL-3.0-only", ERLAUBT)).toBe(false);
  });

  it("wertet ODER aus", () => {
    expect(satisfiesLicense("MIT OR GPL-3.0-only", ERLAUBT)).toBe(true);
    expect(satisfiesLicense("GPL-3.0-only OR SSPL-1.0", ERLAUBT)).toBe(false);
  });

  it("wertet UND aus", () => {
    expect(satisfiesLicense("MIT AND ISC", ERLAUBT)).toBe(true);
    expect(satisfiesLicense("MIT AND GPL-3.0-only", ERLAUBT)).toBe(false);
  });

  it("wertet Klammern aus", () => {
    expect(satisfiesLicense("(MIT OR GPL-3.0-only) AND ISC", ERLAUBT)).toBe(true);
    expect(satisfiesLicense("(GPL-3.0-only OR SSPL-1.0) AND MIT", ERLAUBT)).toBe(false);
  });

  it("kennt Ausnahmen mit WITH", () => {
    expect(satisfiesLicense("Apache-2.0 WITH LLVM-exception", ERLAUBT)).toBe(true);
    expect(satisfiesLicense("GPL-3.0-only WITH Classpath-exception-2.0", ERLAUBT)).toBe(false);
  });

  it("hält einen leeren Ausdruck für ungeklärt", () => {
    expect(satisfiesLicense("", ERLAUBT)).toBe(false);
    expect(satisfiesLicense("UNKNOWN", ERLAUBT)).toBe(false);
  });
});

describe("parsePnpmLicenses", () => {
  it("liest die nach Lizenz gruppierte Ausgabe", () => {
    const roh = {
      MIT: [{ name: "typescript", versions: ["5.9.2"], license: "MIT" }],
      ISC: [{ name: "lru-cache", versions: ["10.0.0"] }],
    };
    const gelesen = parsePnpmLicenses(roh);
    expect(gelesen).toHaveLength(2);
    expect(gelesen[0]?.name).toBe("lru-cache");
    expect(gelesen[0]?.license).toBe("ISC");
  });

  it("liest auch eine flache Liste", () => {
    const gelesen = parsePnpmLicenses([{ name: "a", version: "1.0.0", license: "MIT" }]);
    expect(gelesen[0]?.versions).toEqual(["1.0.0"]);
  });

  it("bleibt bei unbekanntem Format leer, statt still grün zu sein", () => {
    expect(parsePnpmLicenses("keine Ahnung")).toEqual([]);
    expect(parsePnpmLicenses(null)).toEqual([]);
  });
});

describe("classifyLicenses", () => {
  const abhaengigkeiten = [
    { name: "a", versions: ["1"], license: "MIT" },
    { name: "b", versions: ["1"], license: "AGPL-3.0-only" },
    { name: "c", versions: ["1"], license: "Irgendwas-1.0" },
  ];

  it("trennt zulässig, unzulässig und ungeklärt", () => {
    const ergebnisse = classifyLicenses(abhaengigkeiten, ["MIT"], ["AGPL-3.0-only"]);
    expect(ergebnisse.map((ergebnis) => ergebnis.verdict)).toEqual([
      "allowed",
      "denied",
      "unknown",
    ]);
  });

  it("berichtet in Markdown", () => {
    const bericht = licenseReport(classifyLicenses(abhaengigkeiten, ["MIT"], ["AGPL-3.0-only"]));
    expect(bericht).toContain("| a | 1 | MIT | zulässig |");
    expect(bericht).toContain("**unzulässig**");
    expect(bericht).toContain("**ungeklärt**");
  });
});
