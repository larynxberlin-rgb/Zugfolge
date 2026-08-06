/** Einlesen des Arbeitsbaums. */

import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

import { matchesAny } from "./glob.js";
import type { SourceFile } from "./types.js";

/**
 * Dateiendungen, die die Wächter lesen.
 *
 * Eine Allowlist und keine Blocklist: Ein neues Binärformat darf nicht
 * versehentlich als Text gelesen werden, nur weil niemand daran gedacht hat.
 */
const TEXTENDUNGEN = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".toml",
  ".yaml",
  ".yml",
  ".sql",
  ".md",
  ".sh",
  ".ps1",
]);

/** Dateien ohne Endung, die trotzdem gelesen werden. */
const TEXTDATEINAMEN = new Set(["LICENSE", "CLA", "Dockerfile", "Makefile"]);

function istText(name: string): boolean {
  const punkt = name.lastIndexOf(".");
  if (punkt <= 0) {
    return TEXTDATEINAMEN.has(name);
  }
  return TEXTENDUNGEN.has(name.slice(punkt));
}

/** Liest den Arbeitsbaum ab `root`, ohne die ignorierten Pfade. */
export function readRepository(root: string, ignore: readonly string[]): SourceFile[] {
  const dateien: SourceFile[] = [];
  sammle(root, root, ignore, dateien);
  dateien.sort((links, rechts) => (links.path < rechts.path ? -1 : 1));
  return dateien;
}

function sammle(
  root: string,
  ordner: string,
  ignore: readonly string[],
  ziel: SourceFile[],
): void {
  for (const eintrag of readdirSync(ordner, { withFileTypes: true })) {
    const absolut = join(ordner, eintrag.name);
    const relativ = relative(root, absolut).split(sep).join(posix.sep);

    if (matchesAny(relativ, ignore)) {
      continue;
    }

    if (eintrag.isDirectory()) {
      sammle(root, absolut, ignore, ziel);
      continue;
    }

    if (eintrag.isFile() && istText(eintrag.name)) {
      ziel.push({ path: relativ, text: readFileSync(absolut, "utf8") });
    }
  }
}

/** Alle Pfade des Arbeitsbaums, auch die nicht als Text gelesenen. */
export function listPaths(root: string, ignore: readonly string[]): string[] {
  const pfade: string[] = [];
  sammlePfade(root, root, ignore, pfade);
  pfade.sort((links, rechts) => (links < rechts ? -1 : 1));
  return pfade;
}

function sammlePfade(
  root: string,
  ordner: string,
  ignore: readonly string[],
  ziel: string[],
): void {
  for (const eintrag of readdirSync(ordner, { withFileTypes: true })) {
    const absolut = join(ordner, eintrag.name);
    const relativ = relative(root, absolut).split(sep).join(posix.sep);

    if (matchesAny(relativ, ignore)) {
      continue;
    }

    if (eintrag.isDirectory()) {
      sammlePfade(root, absolut, ignore, ziel);
    } else if (eintrag.isFile()) {
      ziel.push(relativ);
    }
  }
}
