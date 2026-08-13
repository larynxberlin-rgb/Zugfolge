import { GENERATED_GLOSSARY_ENTRIES } from "./generated.js";

export interface GlossaryEntry {
  readonly term: string;
  readonly code: string;
  readonly definition: string;
}

export const GLOSSARY_ENTRIES: readonly GlossaryEntry[] = GENERATED_GLOSSARY_ENTRIES;

function normalize(value: string): string {
  return value
    .toLocaleLowerCase("de-DE")
    .replaceAll("ß", "ss")
    .replaceAll("ae", "a")
    .replaceAll("oe", "o")
    .replaceAll("ue", "u")
    .normalize("NFKD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .trim();
}

export function filterGlossary(query: string, entries: readonly GlossaryEntry[] = GLOSSARY_ENTRIES): readonly GlossaryEntry[] {
  const needle = normalize(query);
  if (needle === "") return entries;
  return entries.filter((entry) => normalize(`${entry.term} ${entry.code} ${entry.definition}`).includes(needle));
}

export function glossaryEntryByCode(code: string): GlossaryEntry | undefined {
  return GLOSSARY_ENTRIES.find((entry) => entry.code === code);
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
  close.textContent = "Schließen";
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
  let returnFocus: HTMLElement = opener;
  const render = () => {
    const matches = filterGlossary(search.value);
    list.replaceChildren(...matches.map(entryNode));
    status.textContent = `${matches.length} Begriffe`;
  };
  const openContextEntry = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest<HTMLElement>("[data-glossary-code]");
    if (trigger === null || !root.contains(trigger)) return;
    const codeValue = trigger.dataset.glossaryCode ?? "";
    const entry = glossaryEntryByCode(codeValue);
    if (entry === undefined) return;
    returnFocus = trigger;
    search.value = entry.code;
    render();
    dialog.showModal();
    search.focus();
  };
  search.addEventListener("input", render);
  opener.addEventListener("click", () => {
    returnFocus = opener;
    dialog.showModal();
    search.focus();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    (returnFocus.isConnected ? returnFocus : opener).focus();
  });
  dialog.append(header, label, status, list);
  host.append(opener, dialog);
  root.append(host);
  root.addEventListener("click", openContextEntry);
  render();
  return () => {
    root.removeEventListener("click", openContextEntry);
    host.remove();
  };
}
