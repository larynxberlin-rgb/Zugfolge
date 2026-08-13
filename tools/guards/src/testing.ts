/** Hilfsmittel für die Tests der Wächter. */

import type { Domain, GuardConfig, SourceFile } from "./types.js";

/** Eine Datei im Speicher. */
export function sourceFile(path: string, text: string): SourceFile {
  return { path, text };
}

/** Eine Domäne mit sinnvollen Vorgaben. */
export function testDomain(teile: Partial<Domain> & Pick<Domain, "id">): Domain {
  return {
    title: `Domäne ${teile.id}`,
    status: "active",
    paths: [`${teile.id}/**`],
    rules: [],
    ...teile,
  };
}

/** Eine Konfiguration mit sinnvollen Vorgaben. */
export function testConfig(teile: Partial<GuardConfig> = {}): GuardConfig {
  return {
    domains: [testDomain({ id: "beispiel" })],
    coverageExceptions: [],
    brandTokenHashes: [],
    allowedLicenses: ["MIT"],
    deniedLicenses: ["AGPL-3.0-only"],
    licenseExceptions: [],
    ignore: [],
    ...teile,
  };
}
