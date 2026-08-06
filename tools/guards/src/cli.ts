/**
 * Befehlszeile der Wächter.
 *
 * ```text
 * node dist/cli.js                     alle Regeln
 * node dist/cli.js --rule=no-payment-tier
 * node dist/cli.js --list              Regeln auflisten
 * node dist/cli.js brand:add <wort>    Wort in die Hashliste aufnehmen
 * ```
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { CONFIG_PATH, repositoryRoot } from "./paths.js";
import { readRepository } from "./repo.js";
import { hashToken } from "./rules/brand.js";
import { ALL_RULES } from "./rules/index.js";
import { formatFindings, runRules } from "./run.js";

function brandAdd(wurzel: string, wort: string): number {
  const pfad = join(wurzel, CONFIG_PATH);
  const roh = JSON.parse(readFileSync(pfad, "utf8")) as Record<string, unknown>;
  const bisher = Array.isArray(roh["brandTokenHashes"])
    ? (roh["brandTokenHashes"] as string[])
    : [];
  const hash = hashToken(wort);

  if (bisher.includes(hash)) {
    process.stdout.write("Der Begriff steht bereits in der Liste.\n");
    return 0;
  }

  bisher.push(hash);
  bisher.sort();
  roh["brandTokenHashes"] = bisher;
  writeFileSync(pfad, `${JSON.stringify(roh, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Aufgenommen. In ${CONFIG_PATH} steht der Hash, nicht das Wort — das ist der Zweck.\n`,
  );
  return 0;
}

function main(argv: readonly string[]): number {
  const wurzel = repositoryRoot();

  if (argv[0] === "brand:add") {
    const wort = argv[1];
    if (wort === undefined || wort.length === 0) {
      process.stderr.write("Aufruf: brand:add <wort>\n");
      return 2;
    }
    return brandAdd(wurzel, wort);
  }

  if (argv.includes("--list")) {
    for (const regel of ALL_RULES) {
      process.stdout.write(`${regel.id.padEnd(24)} ${regel.scope.padEnd(11)} ${regel.title}\n`);
    }
    return 0;
  }

  const nurRegel = argv.find((argument) => argument.startsWith("--rule="))?.slice("--rule=".length);
  const regeln = nurRegel === undefined ? ALL_RULES : ALL_RULES.filter((r) => r.id === nurRegel);

  if (regeln.length === 0) {
    process.stderr.write(`Unbekannte Regel '${nurRegel ?? ""}'. --list zeigt alle.\n`);
    return 2;
  }

  const config = loadConfig(join(wurzel, CONFIG_PATH));
  const dateien = readRepository(wurzel, config.ignore);
  const befunde = runRules(dateien, config, regeln);

  process.stdout.write(
    `Wächter: ${regeln.length} Regel(n) über ${dateien.length} Datei(en).\n`,
  );
  process.stdout.write(`${formatFindings(befunde)}\n`);

  return befunde.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
