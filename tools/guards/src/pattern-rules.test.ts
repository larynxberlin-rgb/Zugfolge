import { describe, expect, it } from "vitest";

import { PATTERN_RULES } from "./rules/pattern-rules.js";
import { sourceFile, testConfig } from "./testing.js";
import type { Rule } from "./types.js";

function regel(id: string): Rule {
  const gefunden = PATTERN_RULES.find((eintrag) => eintrag.id === id);
  if (gefunden === undefined) {
    throw new Error(`Regel '${id}' fehlt`);
  }
  return gefunden;
}

function pruefe(id: string, path: string, text: string): string[] {
  return regel(id)
    .check([sourceFile(path, text)], testConfig())
    .map((befund) => `${befund.path}:${befund.line}`);
}

describe("no-payment-tier", () => {
  it("meldet Bezahlstatus in einer spielentscheidenden Domäne", () => {
    expect(pruefe("no-payment-tier", "packages/demand/src/zone.ts", "const paymentTier = 2;"))
      .toEqual(["packages/demand/src/zone.ts:1"]);
    expect(pruefe("no-payment-tier", "a.rs", "if operator.is_premium { boost() }")).toHaveLength(1);
    expect(pruefe("no-payment-tier", "a.ts", "const e = entitlements.get(id);")).toHaveLength(1);
    expect(pruefe("no-payment-tier", "a.ts", "subscription_level")).toHaveLength(1);
  });

  it("lässt unverdächtigen Code in Ruhe", () => {
    expect(pruefe("no-payment-tier", "a.ts", "const takt = plan.headwaySeconds;")).toEqual([]);
    expect(pruefe("no-payment-tier", "a.rs", "let entgelt = trassenentgelt_cent;")).toEqual([]);
  });
});

describe("no-floats", () => {
  it("meldet Gleitkommatypen in Rust", () => {
    expect(pruefe("no-floats", "a.rs", "let masse: f64 = 0.0;")).toEqual(["a.rs:1"]);
  });

  it("prüft nur Rust", () => {
    expect(pruefe("no-floats", "a.ts", "const x: f64 = 1;")).toEqual([]);
  });

  it("achtet die sichtbare Ausnahme", () => {
    const text = "// guards:allow no-floats — Fahrdynamik rechnet einmalig\nlet v: f64 = 1.0;";
    expect(pruefe("no-floats", "a.rs", text)).toEqual([]);
  });
});

describe("no-wallclock", () => {
  it("meldet gelesene Uhrzeit in Rust und TypeScript", () => {
    expect(pruefe("no-wallclock", "a.rs", "let jetzt = SystemTime::now();")).toHaveLength(1);
    expect(pruefe("no-wallclock", "a.rs", "let jetzt = Utc::now();")).toHaveLength(1);
    expect(pruefe("no-wallclock", "a.ts", "const jetzt = Date.now();")).toHaveLength(1);
    expect(pruefe("no-wallclock", "a.ts", "const jetzt = new Date();")).toHaveLength(1);
  });

  it("lässt einen mitgegebenen Zeitpunkt zu", () => {
    expect(pruefe("no-wallclock", "a.ts", "const t = new Date(kommando.at);")).toEqual([]);
    expect(pruefe("no-wallclock", "a.rs", "let t = SimTime::from_seconds(60);")).toEqual([]);
  });
});

describe("no-random", () => {
  it("meldet ungesäten Zufall", () => {
    expect(pruefe("no-random", "a.ts", "const x = Math.random();")).toHaveLength(1);
    expect(pruefe("no-random", "a.rs", "let x = rand::random::<u64>();")).toHaveLength(1);
    expect(pruefe("no-random", "a.rs", "let mut rng = thread_rng();")).toHaveLength(1);
  });

  it("lässt den Substream zu", () => {
    expect(pruefe("no-random", "a.rs", "let mut rng = seed.substream(Substream::Tiebreak);"))
      .toEqual([]);
  });
});

describe("no-unordered-iteration", () => {
  it("meldet ungeordnete Mengen", () => {
    expect(pruefe("no-unordered-iteration", "a.rs", "use std::collections::HashMap;"))
      .toHaveLength(1);
    expect(pruefe("no-unordered-iteration", "a.rs", "let m: HashMap<u16, i64> = todo!();"))
      .toHaveLength(1);
  });

  it("lässt die Erwähnung im Fließtext zu", () => {
    const text = "/// BTreeMap statt HashMap, weil die Reihenfolge zählt.";
    expect(pruefe("no-unordered-iteration", "a.rs", text)).toEqual([]);
  });
});

describe("no-db-in-core", () => {
  it("meldet Datenbank- und Netzabhängigkeiten im Manifest", () => {
    expect(pruefe("no-db-in-core", "crates/x/Cargo.toml", 'sqlx = "0.8"')).toHaveLength(1);
    expect(pruefe("no-db-in-core", "crates/x/Cargo.toml", 'reqwest = "0.12"')).toHaveLength(1);
    expect(pruefe("no-db-in-core", "packages/x/package.json", '    "drizzle-orm": "^0.44.0"'))
      .toHaveLength(1);
  });

  it("prüft nur Manifeste", () => {
    expect(pruefe("no-db-in-core", "crates/x/src/lib.rs", 'sqlx = "0.8"')).toEqual([]);
  });
});

describe("language", () => {
  it("meldet eine fremde Lizenzkennung im eigenen Manifest", () => {
    expect(pruefe("language", "crates/x/Cargo.toml", 'license = "MIT"')).toHaveLength(1);
    expect(pruefe("language", "packages/x/package.json", '  "license": "Apache-2.0"'))
      .toHaveLength(1);
  });

  it("lässt die eigene Kennung und den Workspace-Verweis zu", () => {
    const eigen = 'license = "LicenseRef-PolyForm-Shield-1.0.0"';
    expect(pruefe("language", "Cargo.toml", eigen)).toEqual([]);
    expect(pruefe("language", "crates/x/Cargo.toml", "license.workspace = true")).toEqual([]);
  });

  it("lässt fremde Lizenzmetadaten außerhalb eigener Paketmanifeste zu", () => {
    expect(pruefe("language", "tools/tiles/source-catalog.json", '"license": "OFL-1.1"'))
      .toEqual([]);
  });

  it("meldet die Selbstbezeichnung als Open Source", () => {
    expect(pruefe("language", "README.md", "Zugfolge ist Open Source und frei.")).toHaveLength(1);
  });

  it("lässt das Schreiben über die Definition zu", () => {
    const texte = [
      "Die Open Source Definition verlangt erlaubte abgeleitete Werke.",
      "Das Projekt heißt Source Available, niemals Open Source.",
      "Zugfolge ist ausdrücklich nicht Open Source.",
    ];
    for (const text of texte) {
      expect(pruefe("language", "docs/geschaeft.md", text)).toEqual([]);
    }
  });
});
