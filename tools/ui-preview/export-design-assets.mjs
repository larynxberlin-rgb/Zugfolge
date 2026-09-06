import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { escapeHtml, icon, railwayBrand } from "../../packages/design-system/dist/index.js";

// Documentation exports use the same rendered paths and tokens as the game.
const output = new URL("../../docs/brand/", import.meta.url);
const css = await readFile(new URL("../../packages/design-system/src/railway.css", import.meta.url), "utf8");
const token = (name) => {
  const value = css.match(new RegExp(`--zf-${name}:\\s*(#[a-fA-F0-9]+)`))?.[1];
  if (!value) throw new Error(`Missing design token: ${name}`);
  return value;
};
const mark = railwayBrand("/").match(/<svg viewBox="0 0 32 32">(.*?)<\/svg>/)?.[1];
if (!mark) throw new Error("Railway mark missing from the rendered brand");
const markDrawing = `<rect width="38" height="38" rx="8" fill="${token("brand")}"/><svg x="4" y="4" width="30" height="30" viewBox="0 0 32 32" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${mark}</svg>`;
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="152" height="152" viewBox="0 0 38 38" role="img" aria-labelledby="title"><title id="title">Zugfolge – rotes Gleiszeichen</title>${markDrawing}</svg>\n`;

const items = [
  ["map", "LiveMap", "Deutschland im Blick"],
  ["clock", "Fahrplan", "Fahrten und Zeitlagen"],
  ["train", "Betrieb", "Züge und Entscheidungen"],
  ["market", "Markt", "Aufträge und Fahrzeuge"],
  ["company", "Unternehmen", "Finanzen und Flotte"],
  ["mail", "Postfach", "Nachrichten und Fristen"],
  ["layers", "Kartenebenen", "Ansicht auswählen"],
  ["route", "Fahrt planen", "Nächste Fahrt vorbereiten"],
  ["check", "Bestätigt", "Aktion abgeschlossen"],
  ["warning", "Aufmerksamkeit", "Hinweis mit Klartext"],
  ["lock", "Geschützt", "Berechtigung erforderlich"],
  ["close", "Schließen", "Zurück zur Übersicht"],
];
const cells = items.map(([name, label, description], index) => {
  const x = 32 + index % 3 * 294;
  const y = 142 + Math.floor(index / 3) * 112;
  const drawing = icon(name).replace('<svg class="zf-icon"', '<svg x="18" y="22" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"');
  return `<g transform="translate(${x} ${y})"><rect width="278" height="94" rx="10" fill="${token("surface-1")}" stroke="${token("line")}"/>${drawing}<text x="61" y="36" font-size="16" font-weight="600">${escapeHtml(label)}</text><text x="61" y="59" font-size="12" fill="${token("text-muted")}">${escapeHtml(description)}</text></g>`;
}).join("\n");
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="930" height="662" viewBox="0 0 930 662" role="img" aria-labelledby="title desc">
<title id="title">Zugfolge – Zeichen und Symbole</title><desc id="desc">Das rote Gleiszeichen und zwölf Symbole aus dem gemeinsamen Design-System, jeweils mit Beschriftung.</desc>
<rect width="930" height="662" rx="16" fill="${token("canvas")}"/>
<g font-family="Inter, Segoe UI, sans-serif" fill="${token("text")}" color="${token("text")}">
<g transform="translate(32 32) scale(1.5)">${markDrawing}</g>
<text x="108" y="57" font-size="23" font-weight="800" letter-spacing="2">ZUGFOLGE</text>
<text x="108" y="81" font-size="13" fill="${token("text-muted")}">DEINE BAHN. DEINE WELT.</text>
<text x="32" y="123" font-size="13" fill="${token("text-muted")}">ZEICHEN &amp; SYMBOLE · GEMEINSAM MIT DER SPIELEROBERFLÄCHE</text>
${cells}
<text x="32" y="626" font-size="12" fill="${token("text-muted")}">Symbole begleiten Klartext. Farbe allein erklärt keinen Betriebszustand.</text>
</g></svg>\n`;
await mkdir(output, { recursive: true });
await writeFile(new URL("zugfolge-rail-mark.svg", output), markSvg);
await writeFile(new URL("zugfolge-symbols.svg", output), sheet);
console.log(`Exported railway mark and symbol sheet to ${fileURLToPath(output)}`);
