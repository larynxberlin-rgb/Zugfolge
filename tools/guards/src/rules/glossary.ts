/**
 * Das Domänenglossar muss maschinell benutzbar bleiben.
 *
 * Ein Glossar, das niemand prüft, driftet innerhalb weniger Monate von der
 * Wirklichkeit weg und wird dann von niemandem mehr gelesen. Diese Regel hält
 * es benutzbar: vollständige Zeilen, eindeutige Begriffe, eindeutige
 * Bezeichner, stabile Sortierung.
 */

import type { Finding, Rule, SourceFile } from "../types.js";

/** Pfad des Glossars, relativ zur Wurzel. */
export const GLOSSARPFAD = "docs/glossar.md";

/** Mindestzahl an Einträgen, damit das Glossar nicht zur Attrappe wird. */
export const MINDESTEINTRAEGE = 40;

/** Ein Glossareintrag. */
export interface GlossaryEntry {
  readonly term: string;
  readonly identifier: string;
  readonly meaning: string;
  readonly source: string;
  readonly line: number;
}

/** Vergleichsschlüssel: umlautfrei, kleingeschrieben, sprachunabhängig. */
export function sortSchluessel(begriff: string): string {
  return begriff
    .toLowerCase()
    .replaceAll("ä", "a")
    .replaceAll("ö", "o")
    .replaceAll("ü", "u")
    .replaceAll("ß", "ss")
    .replace(/[^a-z0-9]/g, "");
}

/** Liest die Tabellenzeilen des Glossars. */
export function parseGlossary(text: string): GlossaryEntry[] {
  const eintraege: GlossaryEntry[] = [];
  const zeilen = text.split("\n");

  for (let index = 0; index < zeilen.length; index += 1) {
    const zeile = (zeilen[index] ?? "").trim();
    if (!zeile.startsWith("|") || !zeile.endsWith("|")) {
      continue;
    }
    const spalten = zeile
      .slice(1, -1)
      .split("|")
      .map((spalte) => spalte.trim());
    if (spalten.length !== 4) {
      continue;
    }
    const [term, identifier, meaning, source] = spalten;
    if (term === undefined || identifier === undefined) {
      continue;
    }
    if (/^-+$/.test(term) || term === "Begriff") {
      continue;
    }
    eintraege.push({
      term,
      identifier,
      meaning: meaning ?? "",
      source: source ?? "",
      line: index + 1,
    });
  }

  return eintraege;
}

function pruefeEintraege(eintraege: readonly GlossaryEntry[]): Finding[] {
  const befunde: Finding[] = [];
  const begriffe = new Map<string, number>();
  const bezeichner = new Map<string, number>();
  let vorherigerSchluessel = "";

  for (const eintrag of eintraege) {
    const melde = (message: string): void => {
      befunde.push({ rule: "glossary", path: GLOSSARPFAD, line: eintrag.line, message });
    };

    if (eintrag.meaning.length === 0 || eintrag.source.length === 0) {
      melde(
        `'${eintrag.term}' hat keine Bedeutung oder keine Quelle. ` +
          "Ein Glossareintrag ohne Herkunft ist eine Behauptung.",
      );
    }

    const ersterBegriff = begriffe.get(eintrag.term);
    if (ersterBegriff !== undefined) {
      melde(`'${eintrag.term}' steht schon in Zeile ${ersterBegriff}.`);
    } else {
      begriffe.set(eintrag.term, eintrag.line);
    }

    if (eintrag.identifier !== "—") {
      const ersterBezeichner = bezeichner.get(eintrag.identifier);
      if (ersterBezeichner !== undefined) {
        melde(
          `Bezeichner '${eintrag.identifier}' steht schon in Zeile ${ersterBezeichner}. ` +
            "Ein Bezeichner bedeutet genau eine Sache.",
        );
      } else {
        bezeichner.set(eintrag.identifier, eintrag.line);
      }
    }

    const schluessel = sortSchluessel(eintrag.term);
    if (schluessel < vorherigerSchluessel) {
      melde(`'${eintrag.term}' steht nicht in alphabetischer Reihenfolge.`);
    }
    vorherigerSchluessel = schluessel;
  }

  return befunde;
}

/** Prüft Aufbau und Vollständigkeit des Domänenglossars. */
export const glossaryRule: Rule = {
  id: "glossary",
  title: "Domänenglossar bleibt maschinell benutzbar",
  scope: "repository",
  check(files: readonly SourceFile[]): Finding[] {
    const glossar = files.find((datei) => datei.path === GLOSSARPFAD);
    if (glossar === undefined) {
      return [
        {
          rule: "glossary",
          path: GLOSSARPFAD,
          line: 0,
          message: "Das Domänenglossar fehlt.",
        },
      ];
    }

    const eintraege = parseGlossary(glossar.text);
    const befunde = pruefeEintraege(eintraege);

    if (eintraege.length < MINDESTEINTRAEGE) {
      befunde.push({
        rule: "glossary",
        path: GLOSSARPFAD,
        line: 0,
        message:
          `Nur ${eintraege.length} Einträge, erwartet sind mindestens ${MINDESTEINTRAEGE}. ` +
          "Ein zu dünnes Glossar wird nicht benutzt und veraltet unbemerkt.",
      });
    }

    return befunde;
  },
};
