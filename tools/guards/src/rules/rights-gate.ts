/**
 * Invariante 8 — kein Import ohne dokumentierte Rechtefreigabe (Rechte-Gate, M0.4).
 *
 * Das Gate hat zwei Hälften, und beide gehören zusammen:
 *
 * 1. **Das Register muss halten, was es verspricht.** Ein Freigabestatus ist
 *    nur dann eine Freigabe, wenn Lizenz, Bereitstellungsweg und — bei
 *    'freigegeben' — eine datierte Entscheidung danebenstehen. Sonst ist
 *    'freigegeben' ein Wort ohne Deckung. Diese Hälfte greift ab heute.
 *
 * 2. **Kein Import zieht an einer nicht freigegebenen Quelle.** Ein Import
 *    kennzeichnet seine Herkunft mit dem Marker `zugfolge:quelle=<id>`. Der
 *    Wächter prüft, dass jede so genannte Quelle im Register steht und dort
 *    'freigegeben' ist. Diese Hälfte greift ins Leere, solange es keinen
 *    Import gibt — und schlägt in dem Augenblick an, in dem der erste entsteht.
 *    Genau wie `world-id` steht sie deshalb schon hier und nicht erst in M1.
 *
 * Fachliche Herleitung, Statusmodell und Prozess: docs/rechte.md.
 */

import type { Finding, Rule, SourceFile } from "../types.js";

/** Pfad des maschinenlesbaren Quellenregisters, relativ zur Wurzel. */
export const REGISTERPFAD = "tools/guards/quellenregister.json";

/** Pfad der fachlichen Rechte-Gate-Beschreibung, relativ zur Wurzel. */
export const RECHTEPFAD = "docs/rechte.md";

/** Die zulässigen Freigabestatus. */
export const STATUSWERTE = [
  "freigegeben",
  "entwicklung",
  "pruefung",
  "gesperrt",
  "ausgeschlossen",
] as const;

export type Freigabestatus = (typeof STATUSWERTE)[number];

/** Status, die eine dokumentierte Entscheidung (Datum, Prüfer) voraussetzen. */
const BRAUCHT_ENTSCHEIDUNG = new Set<string>(["freigegeben", "entwicklung", "ausgeschlossen"]);

/** Status, die einen erklärenden Hinweis voraussetzen. */
const BRAUCHT_HINWEIS = new Set<string>(["entwicklung", "pruefung", "gesperrt", "ausgeschlossen"]);

/** Nur eine so freigegebene Quelle darf ein Import tragen. */
const IMPORTFAEHIG = "freigegeben";

/** Marker, mit dem ein Import seine Herkunft nennt: `zugfolge:quelle=<id>`. */
const HERKUNFTSMARKER = /zugfolge:quelle=([a-z0-9-]+)/g;

/** Ein Registereintrag, so weit die Prüfung ihn braucht. */
export interface RegistryEntry {
  readonly id: string;
  readonly status: string;
  readonly line: number;
}

function melde(path: string, line: number, message: string): Finding {
  return { rule: "rights-gate", path, line, message };
}

function zeileVon(text: string, teilzeichenkette: string): number {
  const offset = text.indexOf(teilzeichenkette);
  if (offset < 0) {
    return 0;
  }
  let zeile = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      zeile += 1;
    }
  }
  return zeile;
}

function istObjekt(wert: unknown): wert is Record<string, unknown> {
  return typeof wert === "object" && wert !== null && !Array.isArray(wert);
}

function istNichtleererText(wert: unknown): wert is string {
  return typeof wert === "string" && wert.trim().length > 0;
}

/**
 * Liest die Einträge des Registers und meldet jeden strukturellen Mangel.
 *
 * Gibt beides zurück: die Befunde und die Einträge, die überhaupt lesbar waren.
 * Die Einträge braucht der Aufrufer für die Freigabeprüfung der Importmarker.
 */
export function pruefeRegister(datei: SourceFile): {
  findings: Finding[];
  entries: RegistryEntry[];
} {
  const findings: Finding[] = [];
  const entries: RegistryEntry[] = [];

  let roh: unknown;
  try {
    roh = JSON.parse(datei.text);
  } catch (fehler) {
    findings.push(melde(datei.path, 0, `Kein gültiges JSON: ${String(fehler)}.`));
    return { findings, entries };
  }

  if (!istObjekt(roh) || !Array.isArray(roh["quellen"])) {
    findings.push(melde(datei.path, 0, "Das Register braucht ein Feld 'quellen' mit einer Liste."));
    return { findings, entries };
  }

  const quellen = roh["quellen"];
  if (quellen.length === 0) {
    findings.push(
      melde(datei.path, 0, "Das Register ist leer — ohne Quellen gibt es nichts freizugeben."),
    );
  }

  const gesehen = new Map<string, number>();

  for (let index = 0; index < quellen.length; index += 1) {
    const eintrag = quellen[index];
    if (!istObjekt(eintrag)) {
      findings.push(melde(datei.path, 0, `quellen[${index}] ist kein Objekt.`));
      continue;
    }

    const id = eintrag["id"];
    if (!istNichtleererText(id) || !/^[a-z0-9-]+$/.test(id)) {
      findings.push(
        melde(datei.path, 0, `quellen[${index}] hat keine gültige 'id' (klein, Ziffern, Bindestrich).`),
      );
      continue;
    }
    const zeile = zeileVon(datei.text, `"id": "${id}"`);
    const meldeEintrag = (message: string): void => {
      findings.push(melde(datei.path, zeile, `Quelle '${id}': ${message}`));
    };

    const ersteZeile = gesehen.get(id);
    if (ersteZeile !== undefined) {
      meldeEintrag(`steht schon in Zeile ${ersteZeile}. Eine Quellen-id bezeichnet genau eine Quelle.`);
    } else {
      gesehen.set(id, zeile);
    }

    const status = eintrag["status"];
    if (typeof status !== "string" || !(STATUSWERTE as readonly string[]).includes(status)) {
      meldeEintrag(
        `hat den unbekannten Status '${String(status)}'. Zulässig: ${STATUSWERTE.join(", ")}.`,
      );
      // Ohne gültigen Status ist der Eintrag für die Freigabeprüfung wertlos.
      entries.push({ id, status: typeof status === "string" ? status : "", line: zeile });
      continue;
    }

    for (const feld of ["titel", "bereitstellung", "nutzung", "milestone"] as const) {
      if (!istNichtleererText(eintrag[feld])) {
        meldeEintrag(`hat kein '${feld}'. Ohne das ist der Eintrag eine Behauptung.`);
      }
    }

    if (status === IMPORTFAEHIG && !istNichtleererText(eintrag["lizenz"])) {
      meldeEintrag("ist 'freigegeben', nennt aber keine 'lizenz'. Eine Freigabe ohne Lizenz ist keine.");
    }

    if (BRAUCHT_HINWEIS.has(status) && !istNichtleererText(eintrag["hinweis"])) {
      meldeEintrag(`hat Status '${status}', aber keinen 'hinweis' mit Grund oder offenen Punkten.`);
    }

    if (BRAUCHT_ENTSCHEIDUNG.has(status)) {
      const entscheidung = eintrag["entscheidung"];
      const datum = istObjekt(entscheidung) ? entscheidung["datum"] : undefined;
      const pruefer = istObjekt(entscheidung) ? entscheidung["pruefer"] : undefined;
      if (typeof datum !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(datum) || !istNichtleererText(pruefer)) {
        meldeEintrag(
          `hat Status '${status}', aber keine dokumentierte Entscheidung ` +
            "('entscheidung.datum' als JJJJ-MM-TT und 'entscheidung.pruefer'). " +
            "Ohne dokumentierte Freigabe kein Import (Invariante 8).",
        );
      }
    }

    entries.push({ id, status, line: zeile });
  }

  return { findings, entries };
}

/** Prüft, dass jede registrierte Quelle in docs/rechte.md beschrieben ist. */
function pruefeBeschreibung(
  entries: readonly RegistryEntry[],
  rechteDoku: SourceFile | undefined,
): Finding[] {
  if (rechteDoku === undefined) {
    return [
      melde(
        RECHTEPFAD,
        0,
        "Die fachliche Rechte-Gate-Beschreibung fehlt — das Register hätte keinen erklärten Ort.",
      ),
    ];
  }
  const findings: Finding[] = [];
  for (const eintrag of entries) {
    if (!rechteDoku.text.includes(eintrag.id)) {
      findings.push(
        melde(
          REGISTERPFAD,
          eintrag.line,
          `Quelle '${eintrag.id}' ist in ${RECHTEPFAD} nicht beschrieben. ` +
            "Ein stilles Register wird nicht gelesen.",
        ),
      );
    }
  }
  return findings;
}

/** Prüft die Herkunftsmarker aller Dateien gegen das Register (Invariante 8). */
function pruefeImporte(
  files: readonly SourceFile[],
  entries: readonly RegistryEntry[],
): Finding[] {
  const findings: Finding[] = [];
  const nachId = new Map(entries.map((eintrag) => [eintrag.id, eintrag]));

  for (const datei of files) {
    // Register und Beschreibung nennen Quellen, ohne sie zu importieren.
    if (datei.path === REGISTERPFAD || datei.path === RECHTEPFAD) {
      continue;
    }
    const zeilen = datei.text.split("\n");
    for (let index = 0; index < zeilen.length; index += 1) {
      const zeile = zeilen[index] ?? "";
      for (const treffer of zeile.matchAll(HERKUNFTSMARKER)) {
        const id = treffer[1] ?? "";
        const eintrag = nachId.get(id);
        if (eintrag === undefined) {
          findings.push(
            melde(
              datei.path,
              index + 1,
              `Import nennt die Quelle '${id}', die im Register nicht steht ` +
                `(${REGISTERPFAD}). Ohne dokumentierte Freigabe kein Import (Invariante 8).`,
            ),
          );
        } else if (eintrag.status !== IMPORTFAEHIG) {
          findings.push(
            melde(
              datei.path,
              index + 1,
              `Import zieht an Quelle '${id}' mit Status '${eintrag.status}'. ` +
                "Nur eine 'freigegebene' Quelle darf importiert werden (Invariante 8).",
            ),
          );
        }
      }
    }
  }
  return findings;
}

/**
 * Rechte-Gate: das Register hält, was es verspricht, und kein Import zieht an
 * einer nicht freigegebenen Quelle.
 */
export const rightsGateRule: Rule = {
  id: "rights-gate",
  title: "Kein Import ohne dokumentierte Rechtefreigabe",
  scope: "repository",
  check(files: readonly SourceFile[]): Finding[] {
    const register = files.find((datei) => datei.path === REGISTERPFAD);
    if (register === undefined) {
      return [
        melde(
          REGISTERPFAD,
          0,
          "Das Quellenregister fehlt. Invariante 8 verlangt einen dokumentierten " +
            "Freigabestatus je Datenquelle.",
        ),
      ];
    }

    const { findings, entries } = pruefeRegister(register);
    const rechteDoku = files.find((datei) => datei.path === RECHTEPFAD);
    findings.push(...pruefeBeschreibung(entries, rechteDoku));
    findings.push(...pruefeImporte(files, entries));
    return findings;
  },
};
