/** Auffinden der Repositoriumswurzel. */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Datei, die die Wurzel des Monorepos kennzeichnet. */
const WURZELMARKE = "pnpm-workspace.yaml";

/** Sucht von `start` aufwärts die Repositoriumswurzel. */
export function findRepositoryRoot(start: string): string {
  let ordner = start;
  for (;;) {
    if (existsSync(join(ordner, WURZELMARKE))) {
      return ordner;
    }
    const eltern = dirname(ordner);
    if (eltern === ordner) {
      throw new Error(`Repositoriumswurzel nicht gefunden (${WURZELMARKE} fehlt über ${start})`);
    }
    ordner = eltern;
  }
}

/** Die Wurzel, ausgehend vom Ort dieses Moduls. */
export function repositoryRoot(): string {
  return findRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
}

/** Pfad der Wächterkonfiguration, relativ zur Wurzel. */
export const CONFIG_PATH = "tools/guards/guards.config.json";
