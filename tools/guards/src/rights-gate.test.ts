import { describe, expect, it } from "vitest";

import { RECHTEPFAD, REGISTERPFAD, rightsGateRule } from "./rules/rights-gate.js";
import { sourceFile, testConfig } from "./testing.js";
import type { SourceFile } from "./types.js";

/** Ein vollständiger, gültiger Registereintrag als Ausgangspunkt. */
function eintrag(teile: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "osm-pbf-lhe",
    titel: "OSM-PBF-Extract",
    status: "freigegeben",
    lizenz: "ODbL-1.0",
    bereitstellung: "Versionierter Extract",
    attribution: "© OpenStreetMap-Mitwirkende",
    nutzung: "Rohgraph",
    entscheidung: { datum: "2026-08-06", pruefer: "larynxberlin" },
    hinweis: "Share-alike trifft den InfraRelease.",
    milestone: "M1.2",
    ...teile,
  };
}

/** Baut den Registertext aus einer Liste von Einträgen. */
function register(...quellen: Record<string, unknown>[]): string {
  return JSON.stringify({ version: 1, quellen }, null, 2);
}

/** Eine Beschreibung, die jede genannte id erwähnt. */
function beschreibung(...ids: string[]): SourceFile {
  return sourceFile(RECHTEPFAD, `# Rechte-Gate\n\n${ids.join(", ")}\n`);
}

function pruefe(...dateien: SourceFile[]): string[] {
  return rightsGateRule.check(dateien, testConfig()).map((befund) => befund.message);
}

describe("rights-gate — Register", () => {
  it("schweigt bei einem vollständigen Register mit Beschreibung", () => {
    const dateien = [
      sourceFile(REGISTERPFAD, register(eintrag())),
      beschreibung("osm-pbf-lhe"),
    ];
    expect(rightsGateRule.check(dateien, testConfig())).toEqual([]);
  });

  it("meldet ein fehlendes Register", () => {
    const befunde = pruefe(beschreibung());
    expect(befunde.some((m) => m.includes("Quellenregister fehlt"))).toBe(true);
  });

  it("meldet ungültiges JSON", () => {
    const befunde = pruefe(sourceFile(REGISTERPFAD, "{ kaputt"), beschreibung());
    expect(befunde.some((m) => m.includes("JSON"))).toBe(true);
  });

  it("meldet einen unbekannten Status", () => {
    const dateien = [
      sourceFile(REGISTERPFAD, register(eintrag({ status: "vielleicht" }))),
      beschreibung("osm-pbf-lhe"),
    ];
    expect(pruefe(...dateien).some((m) => m.includes("unbekannten Status"))).toBe(true);
  });

  it("meldet eine Freigabe ohne Lizenz", () => {
    const dateien = [
      sourceFile(REGISTERPFAD, register(eintrag({ lizenz: "" }))),
      beschreibung("osm-pbf-lhe"),
    ];
    expect(pruefe(...dateien).some((m) => m.includes("keine 'lizenz'"))).toBe(true);
  });

  it("meldet eine Freigabe ohne dokumentierte Entscheidung", () => {
    const dateien = [
      sourceFile(REGISTERPFAD, register(eintrag({ entscheidung: null }))),
      beschreibung("osm-pbf-lhe"),
    ];
    expect(pruefe(...dateien).some((m) => m.includes("dokumentierte Entscheidung"))).toBe(true);
  });

  it("meldet eine doppelte id", () => {
    const dateien = [
      sourceFile(REGISTERPFAD, register(eintrag(), eintrag())),
      beschreibung("osm-pbf-lhe"),
    ];
    expect(pruefe(...dateien).some((m) => m.includes("steht schon"))).toBe(true);
  });

  it("lässt eine gesperrte Quelle ohne Entscheidung zu, verlangt aber einen Hinweis", () => {
    const gesperrt = eintrag({ status: "gesperrt", entscheidung: null, hinweis: "" });
    const dateien = [
      sourceFile(REGISTERPFAD, register(gesperrt)),
      beschreibung("osm-pbf-lhe"),
    ];
    const befunde = pruefe(...dateien);
    expect(befunde.some((m) => m.includes("dokumentierte Entscheidung"))).toBe(false);
    expect(befunde.some((m) => m.includes("'hinweis'"))).toBe(true);
  });

  it("meldet eine Quelle, die in der Beschreibung fehlt", () => {
    const dateien = [
      sourceFile(REGISTERPFAD, register(eintrag())),
      beschreibung("eine-andere-quelle"),
    ];
    expect(pruefe(...dateien).some((m) => m.includes("nicht beschrieben"))).toBe(true);
  });

  it("meldet eine fehlende Beschreibung", () => {
    const befunde = pruefe(sourceFile(REGISTERPFAD, register(eintrag())));
    expect(befunde.some((m) => m.includes("Beschreibung fehlt"))).toBe(true);
  });
});

describe("rights-gate — Importmarker (Invariante 8)", () => {
  const gueltigesRegister = () =>
    sourceFile(
      REGISTERPFAD,
      register(eintrag(), eintrag({ id: "rinf", status: "gesperrt", entscheidung: null })),
    );
  const doku = () => beschreibung("osm-pbf-lhe", "rinf");

  it("lässt einen Import an einer freigegebenen Quelle zu", () => {
    const importdatei = sourceFile("crates/zugfolge-infra/src/lib.rs", "// zugfolge:quelle=osm-pbf-lhe");
    expect(pruefe(gueltigesRegister(), doku(), importdatei)).toEqual([]);
  });

  it("meldet einen Import an einer nicht freigegebenen Quelle", () => {
    const importdatei = sourceFile("crates/zugfolge-infra/src/lib.rs", "// zugfolge:quelle=rinf");
    expect(pruefe(gueltigesRegister(), doku(), importdatei).some((m) => m.includes("gesperrt"))).toBe(
      true,
    );
  });

  it("meldet einen Import an einer unbekannten Quelle", () => {
    const importdatei = sourceFile("crates/zugfolge-infra/src/lib.rs", "// zugfolge:quelle=erfunden");
    expect(
      pruefe(gueltigesRegister(), doku(), importdatei).some((m) => m.includes("nicht steht")),
    ).toBe(true);
  });

  it("übergeht die Quellennennung im Register und in der Beschreibung selbst", () => {
    // Beide nennen 'rinf' im Klartext, aber ohne den Marker — kein Import.
    expect(pruefe(gueltigesRegister(), doku())).toEqual([]);
  });
});
