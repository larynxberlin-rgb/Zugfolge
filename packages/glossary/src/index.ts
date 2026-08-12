export interface GlossaryEntry {
  readonly term: string;
  readonly code: string;
  readonly definition: string;
}

export const GLOSSARY_ENTRIES: readonly GlossaryEntry[] = Object.freeze([
  { term: "Aufgabentraeger", code: "authority", definition: "Oeffentliche Stelle, die SPNV-Leistungen bestellt, ausschreibt und finanziert." },
  { term: "Betriebsprogramm", code: "operating_program", definition: "Serverautoritaeres Regelwerk eines EVU fuer wiederkehrende Dispositionsentscheidungen." },
  { term: "Eigenbetrieb", code: "public_operation", definition: "Neutraler Betrieb des Aufgabentraegers, bis ein Spieler-EVU ein Los nahtlos uebernimmt." },
  { term: "EVU", code: "operator", definition: "Eisenbahnverkehrsunternehmen innerhalb genau einer Welt." },
  { term: "Fahrplanperiode", code: "schedule_period", definition: "Weltgebundener Planungs- und Vertragsabschnitt von drei bis acht Wochen." },
  { term: "Fahrstrasse", code: "route_lock", definition: "Gesicherter Weg durch konfliktbehaftete Gleis- und Weichenressourcen." },
  { term: "InfraRelease", code: "infra_release", definition: "Versionierter, gepruefter und signierter Infrastrukturstand einer Welt." },
  { term: "Konfliktressource", code: "conflict_resource", definition: "Gleis-, Weichen-, Bahnsteig- oder Fahrstrassenressource, die inkompatible gleichzeitige Belegungen ausschliesst." },
  { term: "Los", code: "lot", definition: "Zusammengefasste SPNV-Leistung, die als Einheit vergeben und betrieben wird." },
  { term: "Notvergabe", code: "emergency_award", definition: "Eng begrenzte direkte Vergabe zur Sicherung eines Mindestangebots, nicht als Wettbewerbsvorteil." },
  { term: "Qualitaetsklasse C", code: "quality_c", definition: "Sichtbarer Abschnitt mit unzureichender Datenqualitaet; er ist nicht bestellbar." },
  { term: "Trasse", code: "path", definition: "Zeitlich und raeumlich konfliktgeprueftes Nutzungsrecht fuer eine Zugfahrt." },
  { term: "Umlauf", code: "circulation", definition: "Zeitliche Folge von Fahrzeugleistungen einschliesslich Wenden, Abstellung und Werkstattbindung." },
  { term: "Vier-Augen-Prinzip", code: "four_eyes", definition: "Hochrisikoaktion braucht getrennte Personen fuer Antrag und Freigabe; das Game prueft dies erneut." },
  { term: "Weltzeit", code: "simulation_time", definition: "Explizite Simulationssekunde seit Weltepoche; sie kommt nie aus der Uhr des Simulationskerns." },
]);

function normalize(value: string): string {
  return value.normalize("NFKD").replaceAll(/\p{Diacritic}/gu, "").toLocaleLowerCase("de-DE").trim();
}

export function filterGlossary(query: string, entries: readonly GlossaryEntry[] = GLOSSARY_ENTRIES): readonly GlossaryEntry[] {
  const needle = normalize(query);
  if (needle === "") return entries;
  return entries.filter((entry) => normalize(`${entry.term} ${entry.code} ${entry.definition}`).includes(needle));
}

function entryNode(entry: GlossaryEntry): HTMLElement {
  const article = document.createElement("article");
  article.className = "zf-glossary__entry";
  const heading = document.createElement("h3");
  heading.textContent = entry.term;
  const code = document.createElement("code");
  code.textContent = entry.code;
  const definition = document.createElement("p");
  definition.textContent = entry.definition;
  article.append(heading, code, definition);
  return article;
}

export function mountGlossaryLayer(root: HTMLElement = document.body): () => void {
  root.querySelector("[data-zugfolge-glossary]")?.remove();
  const host = document.createElement("aside");
  host.dataset.zugfolgeGlossary = "true";
  host.className = "zf-glossary";
  const opener = document.createElement("button");
  opener.type = "button";
  opener.className = "zf-glossary__opener";
  opener.setAttribute("aria-haspopup", "dialog");
  opener.textContent = "Glossar";
  const dialog = document.createElement("dialog");
  dialog.className = "zf-glossary__dialog";
  dialog.setAttribute("aria-labelledby", "zf-glossary-title");
  const header = document.createElement("header");
  const title = document.createElement("h2");
  title.id = "zf-glossary-title";
  title.textContent = "Fachbegriffe";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Schliessen";
  header.append(title, close);
  const label = document.createElement("label");
  label.textContent = "Begriff suchen";
  const search = document.createElement("input");
  search.type = "search";
  search.autocomplete = "off";
  label.append(search);
  const status = document.createElement("p");
  status.className = "zf-glossary__status";
  status.setAttribute("aria-live", "polite");
  const list = document.createElement("div");
  list.className = "zf-glossary__list";
  const render = () => {
    const matches = filterGlossary(search.value);
    list.replaceChildren(...matches.map(entryNode));
    status.textContent = `${matches.length} Begriffe`;
  };
  search.addEventListener("input", render);
  opener.addEventListener("click", () => { dialog.showModal(); search.focus(); });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => opener.focus());
  dialog.append(header, label, status, list);
  host.append(opener, dialog);
  root.append(host);
  render();
  return () => host.remove();
}
