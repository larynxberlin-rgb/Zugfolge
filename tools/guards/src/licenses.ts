/**
 * Lizenz-Scan der Node-Abhängigkeiten.
 *
 * Der Scan wertet die Ausgabe von `pnpm licenses list --json` aus. Er ist
 * absichtlich streng: Was nicht in der Allowlist steht, gilt als ungeklärt und
 * bricht die CI. Das ist unbequem — und genau richtig für ein Projekt, dessen
 * Rechteschutz eine Grundsatzentscheidung ist (E16) und dessen `.gitignore`
 * ganze Schichten aus dem öffentlichen Repositorium heraushält.
 */

/** Eine Abhängigkeit mit ihrer Lizenzangabe. */
export interface DependencyLicense {
  readonly name: string;
  readonly versions: readonly string[];
  readonly license: string;
}

/** Das Urteil über eine Lizenzangabe. */
export type LicenseVerdict = "allowed" | "denied" | "unknown";

/** Eine bewertete Abhängigkeit. */
export interface LicenseResult extends DependencyLicense {
  readonly verdict: LicenseVerdict;
}

function alsTexte(wert: unknown): string[] {
  if (Array.isArray(wert)) {
    return wert.filter((eintrag): eintrag is string => typeof eintrag === "string");
  }
  return typeof wert === "string" ? [wert] : [];
}

/**
 * Liest die JSON-Ausgabe von `pnpm licenses list --json`.
 *
 * pnpm gruppiert nach Lizenz: `{ "MIT": [ { name, versions, … } ] }`. Eine
 * flache Liste wird ebenfalls angenommen, damit ein Formatwechsel den Scan
 * nicht lautlos leer laufen lässt.
 */
export function parsePnpmLicenses(roh: unknown): DependencyLicense[] {
  const ergebnis: DependencyLicense[] = [];

  const nimm = (eintrag: unknown, fallback: string): void => {
    if (typeof eintrag !== "object" || eintrag === null) {
      return;
    }
    const objekt = eintrag as Record<string, unknown>;
    const name = typeof objekt["name"] === "string" ? objekt["name"] : "(ohne Namen)";
    const lizenz = typeof objekt["license"] === "string" ? objekt["license"] : fallback;
    const versionen = alsTexte(objekt["versions"] ?? objekt["version"]);
    ergebnis.push({ name, versions: versionen, license: lizenz });
  };

  if (Array.isArray(roh)) {
    for (const eintrag of roh) {
      nimm(eintrag, "UNKNOWN");
    }
  } else if (typeof roh === "object" && roh !== null) {
    for (const [lizenz, eintraege] of Object.entries(roh as Record<string, unknown>)) {
      if (!Array.isArray(eintraege)) {
        continue;
      }
      for (const eintrag of eintraege) {
        nimm(eintrag, lizenz);
      }
    }
  }

  ergebnis.sort((links, rechts) => (links.name < rechts.name ? -1 : 1));
  return ergebnis;
}

function tokenisiere(ausdruck: string): string[] {
  return ausdruck
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter((teil) => teil.length > 0);
}

/**
 * Wertet einen SPDX-Ausdruck gegen eine Menge zulässiger Kennungen aus.
 *
 * Unterstützt `OR`, `AND`, Klammern und `WITH`. Bei `A WITH B` gilt zuerst der
 * vollständige Ausdruck; ist nur `A` erlaubt, zählt das ebenfalls — eine
 * Ausnahme erweitert die Rechte, sie schränkt sie nicht ein.
 */
export function satisfiesLicense(expression: string, allowed: ReadonlySet<string>): boolean {
  const marken = tokenisiere(expression);
  let position = 0;

  const istErlaubt = (kennung: string): boolean =>
    allowed.has(kennung) || allowed.has(kennung.replace(/\+$/, ""));

  const oderAusdruck = (): boolean => {
    let ergebnis = undAusdruck();
    while (marken[position]?.toUpperCase() === "OR") {
      position += 1;
      const rechts = undAusdruck();
      ergebnis = ergebnis || rechts;
    }
    return ergebnis;
  };

  const undAusdruck = (): boolean => {
    let ergebnis = grundwert();
    while (marken[position]?.toUpperCase() === "AND") {
      position += 1;
      const rechts = grundwert();
      ergebnis = ergebnis && rechts;
    }
    return ergebnis;
  };

  const grundwert = (): boolean => {
    const marke = marken[position];
    if (marke === undefined) {
      return false;
    }
    if (marke === "(") {
      position += 1;
      const inhalt = oderAusdruck();
      if (marken[position] === ")") {
        position += 1;
      }
      return inhalt;
    }
    position += 1;
    if (marken[position]?.toUpperCase() === "WITH" && marken[position + 1] !== undefined) {
      const ausnahme = marken[position + 1] ?? "";
      position += 2;
      return istErlaubt(`${marke} WITH ${ausnahme}`) || istErlaubt(marke);
    }
    return istErlaubt(marke);
  };

  const ergebnis = oderAusdruck();
  return ergebnis && position === marken.length;
}

/** Bewertet alle Abhängigkeiten. */
export function classifyLicenses(
  dependencies: readonly DependencyLicense[],
  allowed: readonly string[],
  denied: readonly string[],
): LicenseResult[] {
  const erlaubt = new Set(allowed);
  const verboten = new Set(denied);

  return dependencies.map((abhaengigkeit): LicenseResult => {
    if (satisfiesLicense(abhaengigkeit.license, erlaubt)) {
      return { ...abhaengigkeit, verdict: "allowed" };
    }
    const marken = tokenisiere(abhaengigkeit.license);
    const trifftVerbot = marken.some((marke) => verboten.has(marke));
    return { ...abhaengigkeit, verdict: trifftVerbot ? "denied" : "unknown" };
  });
}

/** Ein Bericht in Markdown, geeignet als CI-Artefakt. */
export function licenseReport(results: readonly LicenseResult[]): string {
  const zeilen: string[] = [
    "# Lizenzbericht der Node-Abhängigkeiten",
    "",
    "Erzeugt von `@zugfolge/guards`. Grundlage: `pnpm licenses list --json`.",
    "",
    "| Paket | Version(en) | Lizenz | Urteil |",
    "|-------|-------------|--------|--------|",
  ];
  for (const ergebnis of results) {
    const urteil =
      ergebnis.verdict === "allowed"
        ? "zulässig"
        : ergebnis.verdict === "denied"
          ? "**unzulässig**"
          : "**ungeklärt**";
    zeilen.push(
      `| ${ergebnis.name} | ${ergebnis.versions.join(", ")} | ${ergebnis.license} | ${urteil} |`,
    );
  }
  zeilen.push("");
  return zeilen.join("\n");
}
