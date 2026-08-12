import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

const GRUNDGERUEST = {
  domains: [{ id: "kern", title: "Kern", status: "active", paths: ["kern/**"], rules: [] }],
  brandTokenHashes: [],
  allowedLicenses: ["MIT"],
  deniedLicenses: [],
  licenseExceptions: [],
  ignore: [],
};

function lies(teile: Record<string, unknown> = {}): ReturnType<typeof parseConfig> {
  return parseConfig(JSON.stringify({ ...GRUNDGERUEST, ...teile }));
}

describe("parseConfig", () => {
  it("liest eine vollständige Konfiguration", () => {
    const config = lies();
    expect(config.domains).toHaveLength(1);
    expect(config.domains[0]?.status).toBe("active");
  });

  it("weist ungültiges JSON zurück", () => {
    expect(() => parseConfig("{")).toThrow(/gültiges JSON/);
  });

  it("weist einen unbekannten Status zurück", () => {
    const domains = [{ ...GRUNDGERUEST.domains[0], status: "vielleicht" }];
    expect(() => lies({ domains })).toThrow(/unbekannten Status/);
  });

  it("weist doppelte Domänen zurück", () => {
    const domains = [GRUNDGERUEST.domains[0], GRUNDGERUEST.domains[0]];
    expect(() => lies({ domains })).toThrow(/ist doppelt/);
  });

  it("weist eine Domäne ohne Pfade zurück", () => {
    const domains = [{ ...GRUNDGERUEST.domains[0], paths: [] }];
    expect(() => lies({ domains })).toThrow(/keine Pfade/);
  });

  it("weist eine Lizenzausnahme ohne tragfähige Begründung zurück", () => {
    // Eine Ausnahme ohne Grund ist eine Allowlist mit Umweg — und genau die
    // Stelle, an der ein Rechteproblem später niemandem mehr auffällt.
    const licenseExceptions = [{ package: "x", license: "MPL-2.0", reason: "passt schon" }];
    expect(() => lies({ licenseExceptions })).toThrow(/Begründung/);
  });

  it("nimmt eine Lizenzausnahme mit Begründung an", () => {
    const licenseExceptions = [
      {
        package: "lightningcss*",
        license: "MPL-2.0",
        reason: "Entwicklungsabhängigkeit, unverändert eingebunden, nicht ausgeliefert.",
      },
    ];
    expect(lies({ licenseExceptions }).licenseExceptions).toHaveLength(1);
  });

  it("hält den lokalen Artefaktspeicher aus dem Wächterlauf", () => {
    const produktiv = parseConfig(
      readFileSync(new URL("../guards.config.json", import.meta.url), "utf8"),
    );
    expect(produktiv.ignore).toEqual(expect.arrayContaining(["var", "var/**"]));
  });
});
