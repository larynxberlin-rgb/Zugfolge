/**
 * Befehlszeile des Lizenz-Scans.
 *
 * ```text
 * pnpm licenses list --json | node dist/licenses-cli.js --report=lizenzbericht.md
 * ```
 *
 * Liest bewusst von der Standardeingabe statt `pnpm` selbst aufzurufen: So ist
 * der Scan ohne installierte Abhängigkeiten testbar, und die Auswertung bleibt
 * von der Version des Paketverwalters unabhängig.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { classifyLicenses, licenseReport, parsePnpmLicenses } from "./licenses.js";
import { CONFIG_PATH, repositoryRoot } from "./paths.js";

function leseEingabe(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(argv: readonly string[]): number {
  const wurzel = repositoryRoot();
  const config = loadConfig(join(wurzel, CONFIG_PATH));

  const eingabe = leseEingabe().trim();
  if (eingabe.length === 0) {
    process.stderr.write(
      "Keine Eingabe. Erwartet wird die Ausgabe von 'pnpm licenses list --json'.\n",
    );
    return 2;
  }

  let roh: unknown;
  try {
    roh = JSON.parse(eingabe);
  } catch (fehler) {
    process.stderr.write(`Eingabe ist kein gültiges JSON: ${String(fehler)}\n`);
    return 2;
  }

  const abhaengigkeiten = parsePnpmLicenses(roh);
  if (abhaengigkeiten.length === 0) {
    process.stderr.write(
      "Der Scan hat keine Abhängigkeit gefunden. Das ist kein grünes Ergebnis, " +
        "sondern ein Hinweis auf ein geändertes Ausgabeformat.\n",
    );
    return 2;
  }

  const ergebnisse = classifyLicenses(
    abhaengigkeiten,
    config.allowedLicenses,
    config.deniedLicenses,
  );

  const berichtsziel = argv
    .find((argument) => argument.startsWith("--report="))
    ?.slice("--report=".length);
  if (berichtsziel !== undefined) {
    writeFileSync(join(wurzel, berichtsziel), licenseReport(ergebnisse), "utf8");
  }

  const beanstandet = ergebnisse.filter((ergebnis) => ergebnis.verdict !== "allowed");
  process.stdout.write(
    `Lizenz-Scan: ${ergebnisse.length} Abhängigkeit(en), ${beanstandet.length} offen.\n`,
  );

  for (const ergebnis of beanstandet) {
    const urteil = ergebnis.verdict === "denied" ? "unzulässig" : "ungeklärt";
    process.stdout.write(
      `  ${ergebnis.name}@${ergebnis.versions.join(",")} — ${ergebnis.license} (${urteil})\n`,
    );
  }

  if (beanstandet.length > 0) {
    process.stdout.write(
      "\nJede dieser Lizenzen ist zu prüfen und danach in 'allowedLicenses' oder " +
        "'deniedLicenses' einzutragen (tools/guards/guards.config.json).\n",
    );
  }

  return beanstandet.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
