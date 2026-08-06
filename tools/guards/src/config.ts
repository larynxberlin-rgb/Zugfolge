/** Einlesen und Prüfen von `guards.config.json`. */

import { readFileSync } from "node:fs";

import type { Domain, GuardConfig } from "./types.js";

function istObjekt(wert: unknown): wert is Record<string, unknown> {
  return typeof wert === "object" && wert !== null && !Array.isArray(wert);
}

function feldTexte(quelle: Record<string, unknown>, feld: string): string[] {
  const wert = quelle[feld];
  if (!Array.isArray(wert) || wert.some((eintrag) => typeof eintrag !== "string")) {
    throw new Error(`guards.config.json: '${feld}' muss eine Liste von Zeichenketten sein`);
  }
  return wert as string[];
}

function feldText(quelle: Record<string, unknown>, feld: string, wo: string): string {
  const wert = quelle[feld];
  if (typeof wert !== "string" || wert.length === 0) {
    throw new Error(`guards.config.json: ${wo} braucht ein nichtleeres '${feld}'`);
  }
  return wert;
}

function leseDomain(roh: unknown, index: number): Domain {
  if (!istObjekt(roh)) {
    throw new Error(`guards.config.json: domains[${index}] ist kein Objekt`);
  }
  const wo = `domains[${index}]`;
  const id = feldText(roh, "id", wo);
  const status = feldText(roh, "status", `Domäne '${id}'`);
  if (status !== "active" && status !== "planned") {
    throw new Error(`guards.config.json: Domäne '${id}' hat unbekannten Status '${status}'`);
  }
  const paths = feldTexte(roh, "paths");
  if (paths.length === 0) {
    throw new Error(`guards.config.json: Domäne '${id}' hat keine Pfade`);
  }
  return {
    id,
    title: feldText(roh, "title", `Domäne '${id}'`),
    status,
    paths,
    rules: feldTexte(roh, "rules"),
  };
}

/** Liest eine Konfiguration aus JSON-Text. */
export function parseConfig(text: string): GuardConfig {
  let roh: unknown;
  try {
    roh = JSON.parse(text);
  } catch (fehler) {
    throw new Error(`guards.config.json ist kein gültiges JSON: ${String(fehler)}`);
  }
  if (!istObjekt(roh)) {
    throw new Error("guards.config.json muss ein Objekt enthalten");
  }

  const domainsRoh = roh["domains"];
  if (!Array.isArray(domainsRoh) || domainsRoh.length === 0) {
    throw new Error("guards.config.json: 'domains' fehlt oder ist leer");
  }
  const domains = domainsRoh.map(leseDomain);

  const gesehen = new Set<string>();
  for (const domain of domains) {
    if (gesehen.has(domain.id)) {
      throw new Error(`guards.config.json: Domäne '${domain.id}' ist doppelt`);
    }
    gesehen.add(domain.id);
  }

  return {
    domains,
    brandTokenHashes: feldTexte(roh, "brandTokenHashes"),
    allowedLicenses: feldTexte(roh, "allowedLicenses"),
    deniedLicenses: feldTexte(roh, "deniedLicenses"),
    ignore: feldTexte(roh, "ignore"),
  };
}

/** Liest eine Konfiguration aus einer Datei. */
export function loadConfig(path: string): GuardConfig {
  return parseConfig(readFileSync(path, "utf8"));
}
