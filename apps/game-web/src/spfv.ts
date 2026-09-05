import { escapeHtml, railwayBrand, railwayNavigation } from "@zugfolge/design-system";
import { parseEuroCents, formatCents } from "./cooperation.js";

export interface SpfvLineDraft {
  readonly lineId?: string;
  readonly name: string;
  readonly stopIds: readonly string[];
  readonly headwayS: number;
  readonly fareCents: string;
  readonly formationId: string;
  readonly validFromS: number;
  readonly validUntilS: number;
  readonly referenceTrainId?: string;
}
export interface SpfvCatalog {
  readonly schemaVersion: "zugfolge-spfv-catalog/v1";
  readonly worldId: string; readonly operatorId: string;
  readonly periodId: string; readonly periodStartS: number; readonly periodEndS: number;
  readonly asOfS: number; readonly releaseId: string;
  readonly defaultHeadwayS: number;
  readonly stops: readonly { readonly id: string; readonly label: string }[];
  readonly formations: readonly { readonly id: string; readonly label: string; readonly seats: number; readonly firstClassSeats?: number; readonly bicyclePlaces?: number; readonly wheelchairPlaces?: number }[];
  readonly lines: readonly (Omit<SpfvLineDraft, "lineId"> & { readonly id: string })[];
}
export interface SpfvPreview {
  readonly schemaVersion: "zugfolge-spfv-preview/v1";
  readonly worldId: string; readonly operatorId: string; readonly previewId: string;
  readonly source: "forecast" | "observed" | "assumption"; readonly asOfS: number; readonly releaseId: string;
  readonly requestedPassengers: number | null; readonly servedPassengers: number | null; readonly unservedPassengers: number | null;
  readonly capacity: number | null; readonly fareRevenueCents: string | null; readonly costsCents: string | null;
  readonly conflicts: readonly string[]; readonly connectionEffects: readonly string[];
  readonly confirmationAllowed: boolean;
}
export interface SpfvSubmission { readonly lineId: string; readonly status: "submitted"; readonly planningRequestIds: readonly string[] }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Fernverkehrsdaten fehlen.");
  return value as Record<string, unknown>;
}
function identifier(value: unknown): value is string { return typeof value === "string" && value.trim() !== ""; }
function count(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function context(data: Record<string, unknown>, worldId: string, operatorId: string, schema: string): void {
  if (data["schemaVersion"] !== schema || data["worldId"] !== worldId || data["operatorId"] !== operatorId || !identifier(data["releaseId"]) || !count(data["asOfS"])) throw new Error("Fernverkehrsdaten passen nicht zu deiner Welt und deinem Unternehmen.");
}
export function parseSpfvCatalog(value: unknown, worldId: string, operatorId: string): SpfvCatalog {
  const data = object(value); context(data, worldId, operatorId, "zugfolge-spfv-catalog/v1");
  if (!identifier(data["periodId"]) || !count(data["periodStartS"]) || !count(data["periodEndS"]) || Number(data["periodEndS"]) <= Number(data["periodStartS"]) || !count(data["defaultHeadwayS"]) || data["defaultHeadwayS"] === 0 || !Array.isArray(data["stops"]) || !Array.isArray(data["formations"]) || !Array.isArray(data["lines"])) throw new Error("Planungszeitraum oder Angebotskatalog fehlen.");
  for (const entry of data["stops"]) { const row = object(entry); if (!identifier(row["id"]) || !identifier(row["label"])) throw new Error("Ein freigegebener Halt ist unvollständig."); }
  for (const entry of data["formations"]) { const row = object(entry); if (!identifier(row["id"]) || !identifier(row["label"]) || !count(row["seats"]) || !["firstClassSeats", "bicyclePlaces", "wheelchairPlaces"].every((key) => row[key] === undefined || count(row[key]))) throw new Error("Zugverband enthält keine belegte Kapazität."); }
  for (const entry of data["lines"]) {
    const row = object(entry);
    if (!identifier(row["id"]) || !identifier(row["name"]) || !Array.isArray(row["stopIds"]) || row["stopIds"].length < 2 || !row["stopIds"].every(identifier) || !count(row["headwayS"]) || row["headwayS"] === 0 || typeof row["fareCents"] !== "string" || !/^(0|[1-9]\d*)$/.test(row["fareCents"]) || !identifier(row["formationId"]) || !count(row["validFromS"]) || !count(row["validUntilS"]) || Number(row["validUntilS"]) <= Number(row["validFromS"])) throw new Error("Gespeicherte Linie ist unvollständig.");
  }
  return data as unknown as SpfvCatalog;
}
export function parseSpfvPreview(value: unknown, worldId: string, operatorId: string): SpfvPreview {
  const data = object(value); context(data, worldId, operatorId, "zugfolge-spfv-preview/v1");
  if (!identifier(data["previewId"]) || !["forecast", "observed", "assumption"].includes(String(data["source"])) || !["requestedPassengers", "servedPassengers", "unservedPassengers", "capacity"].every((key) => data[key] === null || count(data[key])) || !["fareRevenueCents", "costsCents"].every((key) => data[key] === null || typeof data[key] === "string" && /^(0|[1-9]\d*)$/.test(data[key] as string)) || !["conflicts", "connectionEffects"].every((key) => Array.isArray(data[key]) && (data[key] as unknown[]).every((item) => typeof item === "string")) || typeof data["confirmationAllowed"] !== "boolean") throw new Error("Die Angebotsprüfung ist unvollständig. Bitte erneut prüfen.");
  return data as unknown as SpfvPreview;
}
export function parseSpfvDraft(fields: Readonly<Record<string, string>>, stopIds: readonly string[], catalog: SpfvCatalog, referenceTrainId?: string): SpfvLineDraft {
  const name = (fields["name"] ?? "").trim();
  if (name === "" || name.length > 100) throw new Error("Gib deiner Linie einen Namen mit höchstens 100 Zeichen.");
  if (stopIds.length < 2 || stopIds.length > 32 || new Set(stopIds).size !== stopIds.length || stopIds.some((id) => !catalog.stops.some((stop) => stop.id === id))) throw new Error("Wähle 2 bis 32 unterschiedliche, freigegebene Halte in Fahrtrichtung.");
  const unsigned = (key: string): number => {
    const raw = fields[key] ?? "";
    if (!/^\d+$/.test(raw) || !count(Number(raw))) throw new Error("Takt und Zeiten müssen ganze, nichtnegative Zahlen sein.");
    return Number(raw);
  };
  const headwayS = unsigned("headwayMinutes") * 60;
  const validFromS = (unsigned("firstDay") - 1) * 86_400 + clockSeconds(fields["firstTime"] ?? "");
  const validUntilS = (unsigned("lastDay") - 1) * 86_400 + clockSeconds(fields["lastTime"] ?? "");
  if (!Number.isSafeInteger(headwayS) || headwayS <= 0) throw new Error("Wähle einen Takt ab einer Minute.");
  if (!Number.isSafeInteger(validFromS) || !Number.isSafeInteger(validUntilS) || validFromS < catalog.periodStartS || validUntilS > catalog.periodEndS || validUntilS <= validFromS) throw new Error("Die erste Abfahrt und das Betriebsende müssen in der angezeigten Periode liegen; das Ende folgt auf den Beginn.");
  const formationId = fields["formationId"] ?? "";
  if (!catalog.formations.some((formation) => formation.id === formationId)) throw new Error("Wähle einen verfügbaren Zugverband mit belegter Kapazität.");
  const fareCents = parseEuroCents(fields["fareEuro"] ?? "");
  if (BigInt(fareCents) < 0n) throw new Error("Der Fahrpreis darf nicht negativ sein.");
  return { name, stopIds: [...stopIds], headwayS, fareCents, formationId, validFromS, validUntilS, ...(fields["lineId"] ? { lineId: fields["lineId"] } : {}), ...(referenceTrainId ? { referenceTrainId } : {}) };
}
function clockSeconds(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (match === null) throw new Error("Gib eine gültige Weltzeit als Stunde und Minute an.");
  return Number(match[1]) * 3_600 + Number(match[2]) * 60;
}
function clock(seconds: number): string { return `${String(Math.floor(seconds % 86_400 / 3_600)).padStart(2, "0")}:${String(Math.floor(seconds % 3_600 / 60)).padStart(2, "0")}`; }
export function spfvTime(seconds: number): string { return `Tag ${Math.floor(seconds / 86_400) + 1}, ${clock(seconds)}`; }
export function spfvReturnDestination(livemapUrl: string, pageUrl: string, worldId: string): string {
  const destination = new URL(livemapUrl || "/", pageUrl);
  const source = new URL(pageUrl); destination.searchParams.set("world", worldId);
  for (const key of ["operator", "focus", "trainScope", "trainQuery", "demand"] as const) { const value = source.searchParams.get(key); if (value !== null) destination.searchParams.set(key, value); }
  if (!destination.searchParams.has("focus") && source.searchParams.get("train")) destination.searchParams.set("focus", `train:${source.searchParams.get("train")}`);
  return destination.href;
}
export interface SpfvViewState {
  readonly worldId: string; readonly operatorId: string; readonly liveUrl: string;
  readonly catalog?: SpfvCatalog; readonly draft?: SpfvLineDraft; readonly stopIds: readonly string[];
  readonly preview?: SpfvPreview; readonly busy: boolean; readonly message: string; readonly error: boolean;
  readonly referenceTrainId?: string; readonly submission?: SpfvSubmission;
}
const numberLabel = (value: number | null): string => value === null ? "nicht verfügbar" : value.toLocaleString("de-DE");
export function spfvPreviewMarkup(preview: SpfvPreview, draft: SpfvLineDraft, catalog: SpfvCatalog): string {
  const formation = catalog.formations.find((item) => item.id === draft.formationId);
  const source = { forecast: "Prognose", observed: "Messwert", assumption: "Modellannahme" }[preview.source];
  return `<section class="spfv-preview zf-surface" aria-labelledby="preview-title" tabindex="-1"><p class="eyebrow">DEIN ANGEBOT IM VERGLEICH</p><h2 id="preview-title">${escapeHtml(draft.name)}</h2><p class="spfv-provenance">${source} · Stand ${spfvTime(preview.asOfS)} · ${escapeHtml(catalog.periodId)}</p><dl class="spfv-facts"><div><dt>Betroffene Fahrt</dt><dd>${escapeHtml(draft.referenceTrainId ?? "Neue Fernverkehrslinie")}</dd></div><div><dt>Streckenabschnitt</dt><dd>${draft.stopIds.map((id) => escapeHtml(catalog.stops.find((stop) => stop.id === id)?.label ?? id)).join(" → ")}</dd></div><div><dt>Zeitraum & Takt</dt><dd>${spfvTime(draft.validFromS)} bis ${spfvTime(draft.validUntilS)} · alle ${draft.headwayS / 60} min</dd></div><div><dt>Plätze je Fahrt</dt><dd>${numberLabel(preview.capacity)}</dd></div><div><dt>Komfort & Platzarten</dt><dd>${escapeHtml(formation?.label ?? "nicht verfügbar")}<br>1. Klasse: ${numberLabel(formation?.firstClassSeats ?? null)} · Fahrradplätze: ${numberLabel(formation?.bicyclePlaces ?? null)} · Rollstuhlplätze: ${numberLabel(formation?.wheelchairPlaces ?? null)}</dd></div><div><dt>Fahrpreis je Abschnitt</dt><dd>${formatCents(draft.fareCents)}</dd></div></dl><div class="spfv-metrics"><div><strong>${numberLabel(preview.requestedPassengers)}</strong><span>Nachfrage im Zeitraum</span></div><div><strong>${numberLabel(preview.servedPassengers)}</strong><span>Bediente Reisende</span></div><div><strong>${numberLabel(preview.unservedPassengers)}</strong><span>Weiterhin offen</span></div></div><dl class="spfv-facts"><div><dt>Fahrgelderlös im Zeitraum</dt><dd>${preview.fareRevenueCents === null ? "nicht verfügbar" : formatCents(preview.fareRevenueCents)}</dd></div><div><dt>Betriebskosten im Zeitraum</dt><dd>${preview.costsCents === null ? "nicht verfügbar" : formatCents(preview.costsCents)}</dd></div></dl><h3>Anschlusswirkung</h3><ul>${preview.connectionEffects.map((effect) => `<li>${escapeHtml(effect)}</li>`).join("") || "<li>Keine Anschlusswirkung im Prüfstand ausgewiesen; Anschlussqualität nicht nachgewiesen.</li>"}</ul><h3>Trassenprüfung</h3><ul>${preview.conflicts.map((conflict) => `<li>${escapeHtml(conflict)}</li>`).join("") || "<li>Keine Konflikte im vorliegenden Prüfstand ausgewiesen. Die endgültige Vergabe erfolgt durch die Trassenplanung.</li>"}</ul><details><summary>Datengrundlage</summary><p>Release ${escapeHtml(preview.releaseId)}. Prognosen sind keine garantierten Erlöse. Fehlende Zahlen sind keine Nullwerte.</p></details><p>Mit der Bestätigung reichst du diese Linie zur Trassenplanung ein. Sie fährt erst nach bestätigter Trassenvergabe und betrieblicher Freigabe.</p><button id="spfv-confirm" class="zf-button primary" type="button"${preview.confirmationAllowed ? "" : " disabled"}>Linie verbindlich zur Planung einreichen</button>${preview.confirmationAllowed ? "" : "<p>Einreichung gesperrt. Behebe die genannten Voraussetzungen und prüfe dein Angebot erneut.</p>"}</section>`;
}
export function renderSpfv(state: SpfvViewState): string {
  const query = new URLSearchParams({ world: state.worldId, operator: state.operatorId });
  const destination = (view: string, section?: string): string => { const params = new URLSearchParams(query); params.set("view", view); if (section) params.set("section", section); return `?${params}`; };
  const catalog = state.catalog;
  const draft = state.draft;
  const first = draft?.validFromS ?? (catalog === undefined ? 0 : Math.max(catalog.periodStartS, Math.ceil((catalog.asOfS + 1) / 60) * 60));
  const last = draft?.validUntilS ?? catalog?.periodEndS ?? 0;
  const selectedFormation = draft?.formationId ?? "";
  const form = catalog === undefined ? `<section class="zf-surface spfv-card"><h2>${state.busy ? "Dein Angebot wird geladen …" : "Fernverkehrsplanung nicht verfügbar"}</h2><p>${state.operatorId === "" ? "Wähle dein Unternehmen, um eine eigene Linie zu planen." : "Der Server muss Nachfrage, Halte und verfügbare Zugverbände für deine Welt bereitstellen."}</p><button id="spfv-retry" class="zf-button" type="button"${state.busy ? " disabled" : ""}>Erneut laden</button></section>` : `<section class="zf-surface spfv-card"><p class="spfv-provenance">${escapeHtml(catalog.periodId)} · ${spfvTime(catalog.periodStartS)} bis ${spfvTime(catalog.periodEndS)}<br>Stand ${spfvTime(catalog.asOfS)}</p><form id="spfv-form"><label>Linie bearbeiten<select id="spfv-line"><option value="">Neue Fernverkehrslinie</option>${catalog.lines.map((line) => `<option value="${escapeHtml(line.id)}"${draft?.lineId === line.id ? " selected" : ""}>${escapeHtml(line.name)}</option>`).join("")}</select></label><input type="hidden" name="lineId" value="${escapeHtml(draft?.lineId ?? "")}"><label>Linienname<input name="name" maxlength="100" required value="${escapeHtml(draft?.name ?? "")}" placeholder="Zum Beispiel: Fernlinie Nord"></label><fieldset><legend>Halte in Fahrtrichtung</legend><ol id="spfv-stops" class="spfv-stops">${state.stopIds.map((id, index) => `<li><strong>${escapeHtml(catalog.stops.find((stop) => stop.id === id)?.label ?? id)}</strong><button type="button" data-stop-up="${index}" aria-label="Halt ${index + 1} nach oben"${index === 0 ? " disabled" : ""}>↑</button><button type="button" data-stop-down="${index}" aria-label="Halt ${index + 1} nach unten"${index === state.stopIds.length - 1 ? " disabled" : ""}>↓</button><button type="button" data-stop-remove="${index}" aria-label="${escapeHtml(catalog.stops.find((stop) => stop.id === id)?.label ?? id)} entfernen">Entfernen</button></li>`).join("") || "<li>Füge mindestens Start und Ziel hinzu.</li>"}</ol><div class="spfv-add-stop"><label>Freigegebener Halt<select id="spfv-stop-option"><option value="">Halt auswählen</option>${catalog.stops.filter((stop) => !state.stopIds.includes(stop.id)).map((stop) => `<option value="${escapeHtml(stop.id)}">${escapeHtml(stop.label)}</option>`).join("")}</select></label><button id="spfv-add-stop" class="zf-button" type="button"${state.stopIds.length >= 32 ? " disabled" : ""}>Halt hinzufügen</button></div></fieldset><div class="spfv-field-grid"><label>Takt in Minuten<input name="headwayMinutes" inputmode="numeric" type="number" min="1" step="1" required value="${(draft?.headwayS ?? catalog.defaultHeadwayS) / 60}"></label><label>Fahrpreis je Abschnitt in Euro<input name="fareEuro" inputmode="decimal" required value="${draft === undefined ? "" : `${BigInt(draft.fareCents) / 100n},${String(BigInt(draft.fareCents) % 100n).padStart(2, "0")}`}" placeholder="0,00"></label><label>Erste Abfahrt · Welttag<input name="firstDay" inputmode="numeric" type="number" min="1" step="1" required value="${Math.floor(first / 86_400) + 1}"></label><label>Erste Abfahrt · Weltzeit<input name="firstTime" type="time" required value="${clock(first)}"></label><label>Betriebsende · Welttag<input name="lastDay" inputmode="numeric" type="number" min="1" step="1" required value="${Math.floor(last / 86_400) + 1}"></label><label>Betriebsende · Weltzeit<input name="lastTime" type="time" required value="${clock(last)}"></label></div><label>Zugverband & Kapazität<select name="formationId" required><option value="">Verfügbaren Zugverband wählen</option>${catalog.formations.map((formation) => `<option value="${escapeHtml(formation.id)}"${selectedFormation === formation.id ? " selected" : ""}>${escapeHtml(formation.label)} · ${formation.seats} Plätze</option>`).join("")}</select></label><p class="spfv-hint">Abfahrten beginnen ab der ersten Zeit und enden vor dem Betriebsende. Der Server prüft Halte, Nachfrage, Komfort, verfügbare Plätze und konkurrierende Trassen gemeinsam. Eine Änderung verwirft die vorherige Vorschau.</p><button class="zf-button primary" type="submit"${state.busy ? " disabled" : ""}>${state.busy ? "Angebot wird geprüft …" : "Nachfrage & Trassen prüfen"}</button></form></section>`;
  return `<a class="skip" href="#spfv-title">Zur Fernverkehrsplanung</a><div class="shell planner-shell spfv-shell"><header class="topbar">${railwayBrand(state.liveUrl)}<span class="planner-header-title">FAHRPLANWERKSTATT</span></header>${railwayNavigation([{page:"map",href:state.liveUrl},{page:"planner",href:destination("diagram")},{page:"operations",href:destination("journey","operations")},{page:"markets",href:destination("journey","markets")},{page:"company",href:destination("journey","company")}],"planner")}<main><section class="context"><div><p class="eyebrow">DEINE NÄCHSTE VERBINDUNG</p><h1 id="spfv-title">Fernverkehr planen</h1></div><a class="zf-button" href="${escapeHtml(state.liveUrl)}">Zur ausgewählten Karte</a></section>${state.referenceTrainId ? `<p class="spfv-reference">Ausgewählte Fahrt: ${escapeHtml(state.referenceTrainId)}</p>` : ""}${state.message ? `<p class="notice notice--${state.error ? "error" : "status"}" role="${state.error ? "alert" : "status"}">${escapeHtml(state.message)}</p>` : ""}${state.submission ? `<section class="spfv-card zf-surface" role="status"><h2>Linie zur Planung eingereicht</h2><p>${escapeHtml(state.submission.lineId)} · ${state.submission.planningRequestIds.length} Trassenanträge. Die Linie wartet auf Trassenvergabe und betriebliche Freigabe.</p><a class="zf-button" href="${destination("diagram")}">Trassenplanung öffnen</a></section>` : ""}<div class="spfv-workspace">${form}${state.preview && draft && catalog ? spfvPreviewMarkup(state.preview, draft, catalog) : `<aside class="spfv-card zf-surface spfv-empty-preview"><h2>Welche Verbindung lohnt sich?</h2><p>Lege Halte, Takt, Tarif und Zugverband fest. Die Vorschau zeigt anschließend Nachfrage, Platzangebot, Kosten und Anschlusswirkung getrennt.</p><p>Fehlende Nachfragewerte werden ausdrücklich als nicht verfügbar angezeigt.</p></aside>`}</div></main></div>`;
}
