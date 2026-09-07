import { escapeHtml } from "@zugfolge/design-system";

export interface RouteCatalogStation { readonly id: string; readonly code: string; readonly name: string }
export interface RouteCatalog {
  readonly worldId: string;
  readonly releaseId: string;
  readonly stations: readonly RouteCatalogStation[];
  readonly segments: readonly { readonly fromStationId: string; readonly toStationId: string }[];
}
export interface ImportedRoute {
  readonly worldId: string;
  readonly releaseId: string;
  readonly stations: readonly RouteCatalogStation[];
  readonly manualMappings?: readonly { readonly sourceName: string; readonly sourceCode: string; readonly stationId: string }[];
}
interface CsvRoutePoint { readonly name: string; readonly code: string }
interface RouteMappingRequirement extends CsvRoutePoint { readonly candidates: readonly RouteCatalogStation[] }
interface PendingRouteMapping {
  readonly points: readonly CsvRoutePoint[];
  readonly catalog: RouteCatalog;
  readonly requirements: readonly RouteMappingRequirement[];
  readonly choices: Map<string, string>;
  activeCode: string;
}
const MAX_BYTES = 1_048_576;
const MAX_POINTS = 512;
const identifier = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value.length <= 300;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stationCode = (value: string): string => value.trim().toUpperCase();

export function parseRouteCatalog(value: unknown, worldId: string): RouteCatalog {
  if (!record(value) || value["worldId"] !== worldId || !identifier(value["releaseId"])
    || !Array.isArray(value["stations"]) || !Array.isArray(value["segments"])) throw new Error("Der Fahrwegkatalog passt nicht zu deiner Spielwelt.");
  const stations = value["stations"];
  if (!stations.every((row) => record(row) && identifier(row["id"]) && typeof row["code"] === "string" && row["code"].length <= 300 && identifier(row["name"]))
    || new Set(stations.map((row) => row["id"])).size !== stations.length) throw new Error("Der Fahrwegkatalog enthält unvollständige Betriebsstellen.");
  const ids = new Set(stations.map((row) => row["id"]));
  if (!value["segments"].every((row) => record(row) && ids.has(row["fromStationId"]) && ids.has(row["toStationId"]))) throw new Error("Der Fahrwegkatalog enthält unbekannte Streckenpunkte.");
  return value as unknown as RouteCatalog;
}

/** Striktes Semikolon-CSV: Anführungszeichen, CRLF und mehrzeilige Felder. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const finishField = (): void => { row.push(field); field = ""; closed = false; };
  const finishRow = (): void => {
    finishField();
    if (row.some((value) => value.trim() !== "")) rows.push(row);
    row = [];
    if (rows.length > MAX_POINTS + 1) throw new Error("Der CSV-Laufweg darf höchstens 512 Betriebsstellen enthalten.");
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; closed = true; }
      } else field += char;
    } else if (char === ";") finishField();
    else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      finishRow();
    } else if (char === '"' && field === "" && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error("Die CSV-Datei enthält fehlerhafte Anführungszeichen.");
      field += char;
    }
  }
  if (quoted) throw new Error("Die CSV-Datei endet innerhalb eines Textfelds.");
  if (field !== "" || row.length > 0 || closed) finishRow();
  return rows;
}

function parseCsvPoints(bytes: ArrayBuffer): readonly CsvRoutePoint[] {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) throw new Error("Wähle einen CSV-Export des Laufwegs mit höchstens 1 MiB.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder("windows-1252", { fatal: true }).decode(bytes); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error("Die Datei ist kein lesbarer CSV-Export des Laufwegs.");
  const rows = csvRows(text.replace(/^\uFEFF/, ""));
  const header = rows.shift()?.map((value) => value.trim()) ?? [];
  const names = ["Lfd. km", "Betriebsstelle", "Betriebsstelle (kurz)"];
  if (names.some((name) => header.filter((value) => value === name).length !== 1)) throw new Error("Wähle im Trassenfinder unter „Exporte zur gefundenen Route“ den „CSV-Export des Laufwegs“.");
  if (rows.length < 2) throw new Error("Der Laufweg muss mindestens Start und Ziel enthalten.");
  const nameColumn = header.indexOf("Betriebsstelle");
  const codeColumn = header.indexOf("Betriebsstelle (kurz)");
  const codes = new Set<string>();
  return rows.map((row, index) => {
    if (row.length !== header.length) throw new Error(`CSV-Zeile ${index + 2} hat eine falsche Spaltenzahl.`);
    const code = stationCode(row[codeColumn] ?? "");
    const name = (row[nameColumn] ?? "").trim();
    if (code === "" || name === "") throw new Error(`In CSV-Zeile ${index + 2} fehlen Name oder Kürzel der Betriebsstelle.`);
    if (code.length > 300 || name.length > 300) throw new Error(`Name oder Kürzel in CSV-Zeile ${index + 2} ist zu lang.`);
    if (codes.has(code)) throw new Error(`${name} (${code}) kommt mehrfach vor. Laufwege mit wiederholten Betriebsstellen werden noch nicht unterstützt.`);
    codes.add(code);
    return { code, name };
  });
}
function catalogueByCode(catalog: RouteCatalog): ReadonlyMap<string, readonly RouteCatalogStation[]> {
  const byCode = new Map<string, RouteCatalogStation[]>();
  for (const station of catalog.stations) {
    const code = stationCode(station.code);
    if (code !== "") byCode.set(code, [...(byCode.get(code) ?? []), station]);
  }
  return byCode;
}
function mappingRequirements(points: readonly CsvRoutePoint[], catalog: RouteCatalog): readonly RouteMappingRequirement[] {
  const byCode = catalogueByCode(catalog);
  return points.flatMap((point) => {
    const candidates = byCode.get(point.code) ?? [];
    return candidates.length === 1 ? [] : [{ ...point, candidates }];
  });
}
function resolveRoutePoints(points: readonly CsvRoutePoint[], catalog: RouteCatalog, mappings: ReadonlyMap<string, string> = new Map()): ImportedRoute {
  const byCode = catalogueByCode(catalog);
  const nativeStations = new Map(catalog.stations.map((station) => [station.id, station]));
  for (const code of mappings.keys()) if (!points.some((point) => point.code === code)) throw new Error("Eine Zuordnung gehört nicht zu diesem CSV-Laufweg.");
  const seen = new Set<string>();
  const manualMappings: { sourceName: string; sourceCode: string; stationId: string }[] = [];
  const stations = points.map(({ code, name }) => {
    const matches = byCode.get(code) ?? [];
    const selected = mappings.get(code);
    if (matches.length === 1 && selected !== undefined && selected !== matches[0]!.id) throw new Error(`${name} (${code}) ist bereits eindeutig zugeordnet und darf nicht überschrieben werden.`);
    if (matches.length === 0 && selected === undefined) throw new Error(`${name} (${code}) ist in dieser Spielwelt nicht eindeutig zugeordnet. Es wurde kein Fahrweg übernommen.`);
    if (matches.length > 1 && selected === undefined) throw new Error(`${name} (${code}) ist in dieser Spielwelt mehrdeutig. Es wurde kein Fahrweg übernommen.`);
    const station = matches.length === 1 ? matches[0]! : selected === undefined ? undefined : nativeStations.get(selected);
    if (!station) throw new Error(`Die gewählte Betriebsstelle für ${name} (${code}) fehlt in deiner Spielwelt.`);
    if (matches.length > 1 && !matches.some((match) => match.id === station.id)) throw new Error(`Wähle für ${name} (${code}) einen der angezeigten Katalogtreffer.`);
    if (matches.length !== 1) manualMappings.push({ sourceName: name, sourceCode: code, stationId: station.id });
    if (seen.has(station.id)) throw new Error(`${name} (${code}) kommt mehrfach vor. Laufwege mit wiederholten Betriebsstellen werden noch nicht unterstützt.`);
    seen.add(station.id);
    return station;
  });
  const connections = new Set(catalog.segments.flatMap((segment) => [JSON.stringify([segment.fromStationId, segment.toStationId]), JSON.stringify([segment.toStationId, segment.fromStationId])]));
  for (let index = 1; index < stations.length; index++) {
    const from = stations[index - 1]!; const to = stations[index]!;
    if (!connections.has(JSON.stringify([from.id, to.id]))) throw new Error(`Zwischen ${from.name} und ${to.name} fehlt eine direkte Verbindung im Spielnetz. Es wurde kein Fahrweg übernommen.`);
  }
  return { worldId: catalog.worldId, releaseId: catalog.releaseId, stations, ...(manualMappings.length ? { manualMappings } : {}) };
}
export function parseTrassenfinderCsv(bytes: ArrayBuffer, catalog: RouteCatalog, mappings?: ReadonlyMap<string, string>): ImportedRoute {
  return resolveRoutePoints(parseCsvPoints(bytes), catalog, mappings);
}

export function routeViaStationIds(route: ImportedRoute): readonly string[] { return route.stations.slice(1, -1).map((station) => station.id); }
export function routeMatchesEndpoints(route: ImportedRoute, originId: string, destinationId: string): boolean {
  return route.stations[0]?.id === originId && route.stations.at(-1)?.id === destinationId;
}

export class RouteImportSession {
  readonly scope: string;
  candidate: ImportedRoute | undefined;
  applied: ImportedRoute | undefined;
  pendingMapping: PendingRouteMapping | undefined;
  busy = false;
  error = "";
  notice = "";
  changed: () => void = () => undefined;
  #revision = 0;
  constructor(scope: string) { this.scope = scope; }
  assertReady(): void {
    if (this.pendingMapping) throw new Error("Ordne zuerst alle CSV-Betriebsstellen zu und prüfe den vollständigen Fahrweg oder entferne die Vorgabe.");
    if (this.busy || this.candidate) throw new Error("Übernimm oder entferne zuerst den vorgemerkten Fahrweg.");
    if (this.error !== "") throw new Error("Behebe den Importfehler oder wähle „Ohne Fahrwegvorgabe fortfahren“.");
  }
  clear(notice = ""): void {
    ++this.#revision; this.candidate = undefined; this.applied = undefined; this.pendingMapping = undefined; this.busy = false; this.error = ""; this.notice = notice; this.changed();
  }
  async read(file: { readonly size: number; arrayBuffer(): Promise<ArrayBuffer> }, loadCatalog: () => Promise<RouteCatalog>): Promise<void> {
    this.clear(); const revision = this.#revision; this.busy = true; this.changed();
    try {
      if (file.size === 0 || file.size > MAX_BYTES) throw new Error("Wähle einen CSV-Export des Laufwegs mit höchstens 1 MiB.");
      const [bytes, catalog] = await Promise.all([file.arrayBuffer(), loadCatalog()]);
      if (revision !== this.#revision) return;
      const points = parseCsvPoints(bytes);
      const requirements = mappingRequirements(points, catalog);
      if (requirements.length) this.pendingMapping = { points, catalog, requirements, choices: new Map(), activeCode: requirements[0]!.code };
      else this.candidate = resolveRoutePoints(points, catalog);
    } catch (value) {
      if (revision !== this.#revision) return;
      this.error = value instanceof Error ? value.message : "Der Laufweg konnte nicht gelesen werden.";
    } finally { if (revision === this.#revision) { this.busy = false; this.changed(); } }
  }
  selectMappingPoint(code: string): void {
    if (!this.pendingMapping?.requirements.some((point) => point.code === code)) throw new Error("Diese Betriebsstelle gehört nicht zu den offenen Zuordnungen.");
    this.pendingMapping.activeCode = code; this.changed();
  }
  setMapping(code: string, stationId: string): void {
    const pending = this.pendingMapping;
    const requirement = pending?.requirements.find((point) => point.code === code);
    if (!pending || !requirement) throw new Error("Diese Betriebsstelle braucht keine manuelle Zuordnung.");
    if (stationId === "") pending.choices.delete(code);
    else {
      if (!pending.catalog.stations.some((station) => station.id === stationId)) throw new Error("Die gewählte Betriebsstelle fehlt in deiner Spielwelt.");
      if (requirement.candidates.length && !requirement.candidates.some((station) => station.id === stationId)) throw new Error("Wähle einen der angezeigten Katalogtreffer.");
      pending.choices.set(code, stationId);
    }
    this.error = ""; this.changed();
  }
  reviewMappings(): void {
    const pending = this.pendingMapping;
    if (!pending) return;
    if (pending.requirements.some((point) => !pending.choices.has(point.code))) throw new Error("Ordne jede CSV-Betriebsstelle ausdrücklich einer Betriebsstelle im Spielnetz zu.");
    const candidate = resolveRoutePoints(pending.points, pending.catalog, pending.choices);
    this.pendingMapping = undefined; this.candidate = candidate; this.error = ""; this.changed();
  }
  apply(): ImportedRoute | undefined {
    if (!this.candidate || this.busy) return undefined;
    this.applied = this.candidate; this.candidate = undefined; this.error = ""; this.notice = ""; this.changed();
    return this.applied;
  }
}

function mappingMarkup(session: RouteImportSession | undefined): string {
  const pending = session?.pendingMapping;
  if (!pending) return "";
  const active = pending.requirements.find((point) => point.code === pending.activeCode)!;
  const stations = new Map(pending.catalog.stations.map((station) => [station.id, station]));
  const candidates = active.candidates.length ? active.candidates : pending.catalog.stations;
  const chosen = pending.choices.get(active.code);
  const next = pending.requirements.find((point) => point.code !== active.code && !pending.choices.has(point.code));
  return `<section class="route-mapping" aria-label="CSV-Betriebsstellen zuordnen"><h4>Betriebsstellen deiner Spielwelt zuordnen</h4><p>Ordne die folgenden Betriebsstellen deiner Spielwelt zu. Diese Auswahl gilt nur für diesen Fahrweg.</p><label>CSV-Betriebsstelle<select data-route-map-point>${pending.requirements.map((point) => `<option value="${escapeHtml(point.code)}"${point.code === active.code ? " selected" : ""}>${escapeHtml(point.name)} (${escapeHtml(point.code)})${pending.choices.has(point.code) ? " · zugeordnet" : " · offen"}</option>`).join("")}</select></label><p><strong>${escapeHtml(active.name)} (${escapeHtml(active.code)})</strong> aus deiner CSV-Datei${active.candidates.length > 1 ? " · mehrere passende Kürzel im Spielnetz" : " · Kürzel im Spielnetz nicht gefunden"}.</p><label>Betriebsstelle im Spielnetz<select data-route-map-station><option value="">Betriebsstelle auswählen</option>${candidates.map((station) => `<option value="${escapeHtml(station.id)}"${chosen === station.id ? " selected" : ""}>${escapeHtml(station.name)} (${escapeHtml(station.code)})</option>`).join("")}</select></label>${next ? `<button type="button" class="secondary" data-route-map-next="${escapeHtml(next.code)}">Nächsten offenen Punkt zuordnen</button>` : ""}<p><strong>${pending.choices.size} von ${pending.requirements.length} zugeordnet</strong></p><ol class="route-import-points" tabindex="0" aria-label="Deine Zuordnungen">${pending.requirements.map((point) => {
    const station = stations.get(pending.choices.get(point.code) ?? "");
    return `<li>${escapeHtml(point.name)} (${escapeHtml(point.code)}) → ${station ? `${escapeHtml(station.name)} (${escapeHtml(station.code)})` : "noch nicht zugeordnet"}</li>`;
  }).join("")}</ol><button type="button" data-route-map-review>Zuordnungen prüfen</button><p class="form-hint">Prüfe anschließend den vollständigen Fahrweg und übernimm ihn.</p></section>`;
}

export function routeImportMarkup(session?: RouteImportSession): string {
  const route = session?.candidate ?? session?.applied;
  const manual = new Map(route?.manualMappings?.map((mapping) => [mapping.stationId, mapping]) ?? []);
  const preview = route === undefined ? "" : `<p><strong>${session?.candidate ? "Vorschau · noch nicht übernommen" : "Übernommener Fahrweg"}</strong> · ${route.stations.length} Betriebsstellen</p><ol class="route-import-points" tabindex="0" aria-label="Betriebsstellen in Fahrtrichtung">${route.stations.map((station) => {
    const source = manual.get(station.id);
    return `<li>${escapeHtml(station.name)} <small>(${escapeHtml(station.code)})</small>${source ? `<small class="route-mapping-source">Deine Zuordnung aus CSV: ${escapeHtml(source.sourceName)} (${escapeHtml(source.sourceCode)}) → ${escapeHtml(station.name)} (${escapeHtml(station.code)})</small>` : ""}</li>`;
  }).join("")}</ol>${session?.candidate ? '<button type="button" data-route-apply>Fahrweg übernehmen</button>' : ""}`;
  return `<fieldset class="route-import"><legend>Fahrweg mit Trassenfinder planen</legend><p><a href="https://trassenfinder.de/" target="_blank" rel="noopener noreferrer">Trassenfinder.de öffnen ↗</a></p><p>Plane dort deine Route. Wähle „Exporte zur gefundenen Route“ → „CSV-Export des Laufwegs“ und öffne die Datei hier.</p><label>CSV-Laufweg auswählen<input type="file" accept=".csv,text/csv" data-route-file${session?.busy ? " disabled" : ""}></label><p class="form-hint">Fahrzeiten im Trassenfinder sind unverbindlich. Die Datei wird lokal gelesen. Übernommen wird nur die Reihenfolge der Betriebsstellen, ohne Halte, Zeiten oder Preise. Zugfolge wählt die Gleise und prüft die Trasse im Spielnetz.</p><div aria-live="polite"${session?.busy ? ' aria-busy="true"' : ""}>${session?.busy ? "Laufweg wird mit deiner Spielwelt abgeglichen …" : ""}${session?.error ? `<p role="alert">${escapeHtml(session.error)}</p>` : ""}${session?.notice ? `<p>${escapeHtml(session.notice)}</p>` : ""}${mappingMarkup(session)}${preview}</div>${route || session?.busy || session?.error || session?.pendingMapping ? `<button type="button" class="secondary" data-route-remove>${session?.error ? "Ohne Fahrwegvorgabe fortfahren" : "Fahrweg entfernen"}</button>` : ""}</fieldset>`;
}

export function mountRouteImport(host: HTMLElement, session: RouteImportSession, options: {
  readonly loadCatalog: () => Promise<RouteCatalog>;
  readonly apply: (route: ImportedRoute) => void;
  readonly remove: () => void;
  readonly disabled?: boolean;
}): void {
  const render = (): void => {
    if (!host.isConnected) return;
    host.innerHTML = routeImportMarkup(session);
    if (options.disabled) host.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, button, select").forEach((control) => { control.disabled = true; });
    const mappingAction = (action: () => void, focus: string): void => {
      try { action(); host.querySelector<HTMLElement>(focus)?.focus(); }
      catch (value) { session.error = value instanceof Error ? value.message : "Die Zuordnung konnte nicht geprüft werden."; render(); }
    };
    host.querySelector<HTMLSelectElement>("[data-route-map-point]")?.addEventListener("change", (event) => mappingAction(() => session.selectMappingPoint((event.currentTarget as HTMLSelectElement).value), "[data-route-map-point]"));
    host.querySelector<HTMLSelectElement>("[data-route-map-station]")?.addEventListener("change", (event) => mappingAction(() => session.setMapping(session.pendingMapping!.activeCode, (event.currentTarget as HTMLSelectElement).value), "[data-route-map-station]"));
    host.querySelector<HTMLButtonElement>("[data-route-map-next]")?.addEventListener("click", (event) => mappingAction(() => session.selectMappingPoint((event.currentTarget as HTMLButtonElement).dataset["routeMapNext"]!), "[data-route-map-station]"));
    host.querySelector("[data-route-map-review]")?.addEventListener("click", () => mappingAction(() => session.reviewMappings(), "[data-route-apply]"));
    host.querySelector<HTMLInputElement>("[data-route-file]")?.addEventListener("change", (event) => {
      const file = (event.currentTarget as HTMLInputElement).files?.[0];
      if (file) { options.remove(); void session.read(file, options.loadCatalog); }
    });
    host.querySelector("[data-route-apply]")?.addEventListener("click", () => {
      try { if (session.candidate) { options.apply(session.candidate); session.apply(); } }
      catch (value) { session.error = value instanceof Error ? value.message : "Der Fahrweg konnte nicht übernommen werden."; render(); }
    });
    host.querySelector("[data-route-remove]")?.addEventListener("click", () => { session.clear("Die Trassenplanung bestimmt den Fahrweg wieder automatisch."); options.remove(); });
  };
  session.changed = render; render();
}
