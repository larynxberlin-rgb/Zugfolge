import { escapeHtml } from "@zugfolge/design-system";

export type DemandSource = "forecast" | "observed" | "assumption";
export interface DemandPeriod {
  readonly worldId: string;
  readonly periodId: string;
  readonly periodStartS: number;
  readonly periodEndS: number;
  readonly asOfS: number;
  readonly source: DemandSource;
  readonly releaseId: string;
}
export interface DemandStation {
  readonly stationId: string;
  readonly label: string;
  readonly longitudeE7?: number;
  readonly latitudeE7?: number;
  readonly requestedPassengers: number | null;
  readonly servedPassengers: number | null;
  readonly unservedPassengers: number | null;
  readonly populationDemand?: {
    readonly demandClass: number;
    readonly catchmentPopulation: number;
    readonly requestedPassengers: number;
    readonly topDestinations: readonly { readonly stationId: string; readonly label: string; readonly passengers: number; readonly referenceConnections: number }[];
  };
}
export interface DemandOverview extends DemandPeriod {
  readonly schemaVersion: "zugfolge-demand-overview/v1";
  readonly items: readonly DemandStation[];
  readonly zones: readonly { readonly zoneId: string; readonly label: string; readonly requestedPassengers: number | null; readonly servedPassengers: number | null; readonly unservedPassengers: number | null; readonly alternativePassengers: number | null }[];
  readonly nextCursor: string | null;
  readonly populationBasis?: {
    readonly referenceStartDate: string; readonly referenceEndDate: string;
    readonly dataRevision?: number; readonly correctedAtS?: number;
    readonly sources: readonly { readonly label: string; readonly url: string; readonly license: string;
      readonly attribution?: string; readonly licenseUrl?: string; readonly attributionUrl?: string }[];
  };
}
export interface TrainDemand extends DemandPeriod {
  readonly schemaVersion: "zugfolge-train-demand/v1";
  readonly trainId: string;
  readonly segments: readonly {
    readonly fromStationId: string; readonly fromStationLabel: string;
    readonly toStationId: string; readonly toStationLabel: string;
    readonly onboard: number | null; readonly capacity: number | null;
  }[];
  readonly stops: readonly { readonly stationId: string; readonly label: string; readonly arrivalS: number | null; readonly departureS: number | null }[];
}
export interface PassengerManifest {
  readonly schemaVersion: "zugfolge-passenger-manifest-view/v1";
  readonly worldId: string; readonly operatorId: string; readonly trainId: string;
  readonly periodId: string; readonly asOfS: number; readonly source: DemandSource | "confirmed";
  readonly items: readonly { readonly passengerId: string; readonly originLabel: string; readonly destinationLabel: string; readonly seatClass: "first" | "second"; readonly spaceNeeds: readonly string[] }[];
  readonly nextCursor: string | null;
}
const sources: Readonly<Record<DemandSource, string>> = { forecast: "Prognose", observed: "Messwert", assumption: "Modellannahme" };
export function demandNumber(value: number | null): string { return value === null ? "nicht verfügbar" : value.toLocaleString("de-DE"); }
export function demandTime(seconds: number): string {
  const day = Math.floor(seconds / 86_400) + 1;
  return `Tag ${day}, ${String(Math.floor(seconds % 86_400 / 3_600)).padStart(2, "0")}:${String(Math.floor(seconds % 3_600 / 60)).padStart(2, "0")}`;
}
export function demandPeriodMarkup(period: DemandPeriod): string {
  return `<p class="demand-provenance demand-provenance--${period.source}"><strong>${sources[period.source]}</strong> · ${escapeHtml(period.periodId)}<br>${demandTime(period.periodStartS)} bis ${demandTime(period.periodEndS)}<br>Stand ${demandTime(period.asOfS)}</p><details class="technical-object-details"><summary>Datengrundlage</summary><p>Release ${escapeHtml(period.releaseId)}. Dieses Zeitfenster ist keine Zeitreihe. Prognosen beschreiben das Modell und garantieren keine Fahrgastzahl.</p></details>`;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Nachfragedaten sind unvollständig.");
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function count(value: unknown): boolean { return value === null || Number.isSafeInteger(value) && (value as number) >= 0; }
function period(value: Record<string, unknown>, worldId: string, schema: string): void {
  if (value["schemaVersion"] !== schema || value["worldId"] !== worldId || !text(value["periodId"]) || !text(value["releaseId"]) || !["forecast", "observed", "assumption"].includes(String(value["source"])) || !["periodStartS", "periodEndS", "asOfS"].every((key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0) || (value["periodEndS"] as number) <= (value["periodStartS"] as number)) throw new Error("Nachfragedaten passen nicht zu Welt, Zeitraum oder Datengrundlage.");
}
export function parseDemandOverview(value: unknown, worldId: string): DemandOverview {
  const data = record(value); period(data, worldId, "zugfolge-demand-overview/v1");
  if (!Array.isArray(data["items"]) || data["items"].length > 50 || !(data["nextCursor"] === null || text(data["nextCursor"]))) throw new Error("Nachfrageseite ist unvollständig oder zu groß.");
  for (const item of data["items"]) {
    const row = record(item);
    if (!text(row["stationId"]) || !text(row["label"]) || !["requestedPassengers", "servedPassengers", "unservedPassengers"].every((key) => count(row[key]))) throw new Error("Stationsnachfrage ist unvollständig.");
    for (const [key, bound] of [["longitudeE7", 1_800_000_000], ["latitudeE7", 900_000_000]] as const) if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || Math.abs(row[key] as number) > bound)) throw new Error("Stationslage ist ungültig.");
    if (row["populationDemand"] !== undefined) {
      const model = record(row["populationDemand"]);
      if (data["source"] !== "assumption" || data["populationBasis"] === undefined
        || !Number.isSafeInteger(model["demandClass"]) || (model["demandClass"] as number) < 0 || (model["demandClass"] as number) > 10
        || !["catchmentPopulation", "requestedPassengers"].every((key) => model[key] !== null && count(model[key]))
        || !Array.isArray(model["topDestinations"]) || model["topDestinations"].length > 5) throw new Error("Einwohnerbasierte Nachfrage ist unvollständig.");
      const destinations = new Set<string>();
      let total = 0;
      for (const value of model["topDestinations"]) {
        const destination = record(value);
        if (!text(destination["stationId"]) || destination["stationId"] === row["stationId"] || destinations.has(destination["stationId"])
          || !text(destination["label"]) || !["passengers", "referenceConnections"].every((key) => destination[key] !== null && count(destination[key]))) throw new Error("Geschätzte Wunschziele sind unvollständig.");
        destinations.add(destination["stationId"]); total += destination["passengers"] as number;
      }
      if (total > (model["requestedPassengers"] as number)) throw new Error("Wunschziele überschreiten die Stationsnachfrage.");
    }
  }
  if (data["populationBasis"] !== undefined) {
    const basis = record(data["populationBasis"]);
    if (basis["dataRevision"] !== undefined && (!Number.isSafeInteger(basis["dataRevision"]) || (basis["dataRevision"] as number) < 1
      || basis["correctedAtS"] === null || !count(basis["correctedAtS"]))) throw new Error("Datenkorrektur besitzt keine gültige Revision.");
    if (data["source"] !== "assumption" || !["referenceStartDate", "referenceEndDate"].every((key) => typeof basis[key] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(basis[key] as string))
      || !Array.isArray(basis["sources"]) || basis["sources"].length === 0 || basis["sources"].length > 128) throw new Error("Bevölkerungs- und Fahrplangrundlage fehlt.");
    for (const value of basis["sources"]) {
      const source = record(value);
      if (!text(source["label"]) || !text(source["license"]) || typeof source["url"] !== "string" || !/^https:\/\/[^\s<>"']+$/.test(source["url"])) throw new Error("Freie Datengrundlage ist unvollständig.");
      if (source["attribution"] !== undefined && !text(source["attribution"])) throw new Error("Quellenangabe ist unvollständig.");
      for (const key of ["licenseUrl", "attributionUrl"]) if (source[key] !== undefined && (typeof source[key] !== "string" || !/^https:\/\/[^\s<>"']+$/.test(source[key] as string))) throw new Error("Quellenlink ist ungültig.");
    }
  }
  if (!Array.isArray(data["zones"]) || data["zones"].length > 50) throw new Error("Nachfragegebiete fehlen oder sind nicht begrenzt.");
  for (const item of data["zones"]) {
    const zone = record(item);
    if (!text(zone["zoneId"]) || !text(zone["label"]) || !["requestedPassengers", "servedPassengers", "unservedPassengers", "alternativePassengers"].every((key) => count(zone[key]))) throw new Error("Gebietsnachfrage ist unvollständig.");
  }
  return data as unknown as DemandOverview;
}
export function parseTrainDemand(value: unknown, worldId: string, trainId: string): TrainDemand {
  const data = record(value); period(data, worldId, "zugfolge-train-demand/v1");
  if (data["trainId"] !== trainId || !Array.isArray(data["segments"]) || !Array.isArray(data["stops"])) throw new Error("Fahrgastdaten gehören nicht zur ausgewählten Fahrt.");
  for (const item of data["segments"]) {
    const row = record(item);
    if (!["fromStationId", "fromStationLabel", "toStationId", "toStationLabel"].every((key) => text(row[key])) || !count(row["onboard"]) || !count(row["capacity"])) throw new Error("Abschnittsauslastung fehlt.");
  }
  for (const item of data["stops"]) {
    const row = record(item);
    if (!text(row["stationId"]) || !text(row["label"]) || !count(row["arrivalS"]) || !count(row["departureS"])) throw new Error("Haltdaten fehlen.");
  }
  return data as unknown as TrainDemand;
}
export function parsePassengerManifest(value: unknown, worldId: string, operatorId: string, trainId: string): PassengerManifest {
  const data = record(value);
  if (data["schemaVersion"] !== "zugfolge-passenger-manifest-view/v1" || data["worldId"] !== worldId || data["operatorId"] !== operatorId || data["trainId"] !== trainId || !text(data["periodId"]) || !Number.isSafeInteger(data["asOfS"]) || !["forecast", "observed", "assumption", "confirmed"].includes(String(data["source"])) || !Array.isArray(data["items"]) || data["items"].length > 50 || !(data["nextCursor"] === null || text(data["nextCursor"]))) throw new Error("Berechtigte Fahrgastliste ist nicht verfügbar.");
  for (const item of data["items"]) {
    const row = record(item);
    if (!["passengerId", "originLabel", "destinationLabel"].every((key) => text(row[key])) || !["first", "second"].includes(String(row["seatClass"])) || !Array.isArray(row["spaceNeeds"]) || !row["spaceNeeds"].every((need) => typeof need === "string")) throw new Error("Fahrgastliste ist unvollständig.");
  }
  return data as unknown as PassengerManifest;
}
export function demandStationTone(station: DemandStation): "unknown" | "unserved" | "served" {
  return station.servedPassengers === null ? "unknown" : station.servedPassengers > 0 ? "served" : "unserved";
}
export function demandGeoJson(items: readonly DemandStation[]) {
  return { type: "FeatureCollection" as const, features: items.flatMap((station) => station.longitudeE7 === undefined || station.latitudeE7 === undefined ? [] : [{ type: "Feature" as const, id: station.stationId, geometry: { type: "Point" as const, coordinates: [station.longitudeE7 / 10_000_000, station.latitudeE7 / 10_000_000] }, properties: { label: station.label, tone: demandStationTone(station) } }]) };
}
function populationDemandMarkup(data: DemandOverview): string {
  if (data.populationBasis === undefined) return "";
  const basis = data.populationBasis;
  return `<section class="population-demand" aria-labelledby="population-demand-title"><h2 id="population-demand-title">Stationsklassen & Wunschziele</h2>${basis.dataRevision === undefined ? "" : `<p class="demand-note">In der Administration korrigierte Modellwerte · Datenstand ${basis.dataRevision} · ${demandTime(basis.correctedAtS!)}</p>`}<p class="demand-note">Ungefähre Nachfrage aus der Einwohnerbasis des Einzugsgebiets. Klasse 0 bis 10 beschreibt seine Größe. Die Reisezahl folgt den Modellquoten im angezeigten Zeitraum. Bestehende Direktverbindungen vom ${escapeHtml(basis.referenceStartDate)} bis ${escapeHtml(basis.referenceEndDate)} geben Hinweise auf beliebte Ziele; neue Ziele bleiben möglich.</p><ul class="population-stations">${data.items.flatMap((station) => {
    const model = station.populationDemand;
    if (model === undefined) return [];
    return [`<li><h3><button type="button" data-demand-station="${escapeHtml(station.stationId)}">${escapeHtml(station.label)}</button></h3><div class="population-class"><span class="population-bars" aria-hidden="true">${Array.from({ length: 10 }, (_, index) => `<i${index < model.demandClass ? ' class="filled"' : ""}></i>`).join("")}</span><strong>Klasse ${model.demandClass}/10</strong></div><p>${demandNumber(model.catchmentPopulation)} zugeteilte Einwohner · ${demandNumber(model.requestedPassengers)} geschätzte Reisen</p><h4>Häufigste Wunschziele im Zeitraum</h4><ol>${model.topDestinations.map((destination) => `<li><span>${escapeHtml(destination.label)}</span><strong>ca. ${demandNumber(destination.passengers)}</strong><small>${demandNumber(destination.referenceConnections)} ${basis.dataRevision === undefined ? "Direktfahrten in der Referenzwoche" : "Verbindungswert der korrigierten Modellgrundlage"}</small></li>`).join("") || "<li>In diesem Zeitfenster entstehen keine Reisen.</li>"}</ol></li>`];
  }).join("")}</ul><details><summary>Freie Quellen der Modellgrundlage</summary><ul>${basis.sources.map((source) => `<li><a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.label)}</a> · ${source.licenseUrl === undefined ? escapeHtml(source.license) : `<a href="${escapeHtml(source.licenseUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.license)}</a>`}${source.attribution === undefined ? "" : `<p>${escapeHtml(source.attribution)}</p>`}${source.attributionUrl === undefined ? "" : `<a href="${escapeHtml(source.attributionUrl)}" target="_blank" rel="noopener noreferrer">Vollständige Datenquellen</a>`}</li>`).join("")}</ul></details></section>`;
}
export function demandOverviewMarkup(data: DemandOverview): string {
  return `<section class="demand-view" aria-labelledby="demand-title"><p class="eyebrow">NACHFRAGE & ANGEBOT</p><h1 id="demand-title">Wo fehlen Verbindungen?</h1>${demandPeriodMarkup(data)}${populationDemandMarkup(data)}<h2>Nachfrage nach Gebiet</h2><p class="demand-note">${data.populationBasis === undefined ? "Offene Reisen gehören zu ihrem Ausgangsgebiet. Sie sind noch keinem Bahnhof zugeordnet." : "Die Gebiete zeigen die zugeteilte Nachfragebasis ihrer Station. Offene Reisewünsche belegen noch keinen Einstieg."} Alternative Verkehrsmittel werden getrennt ausgewiesen.</p><div class="demand-table-scroll" tabindex="0" role="region" aria-label="Gebietsnachfrage als Tabelle"><table><caption>Reisen im aktuellen Zeitfenster · keine Zeitreihe</caption><thead><tr><th scope="col">Gebiet</th><th scope="col">Bedarf</th><th scope="col">Bahn</th><th scope="col">Alternative</th><th scope="col">Offen</th></tr></thead><tbody>${data.zones.map((zone) => `<tr><th scope="row">${escapeHtml(zone.label)}</th><td>${demandNumber(zone.requestedPassengers)}</td><td>${demandNumber(zone.servedPassengers)}</td><td>${demandNumber(zone.alternativePassengers)}</td><td>${demandNumber(zone.unservedPassengers)}</td></tr>`).join("") || '<tr><td colspan="5">Keine Gebietsdaten verfügbar.</td></tr>'}</tbody></table></div><h2>Stationen auf der Karte</h2><ul class="demand-legend" aria-label="Nachfragelegende"><li><i class="demand-dot served"></i> Einsteiger im Zeitraum</li><li><i class="demand-dot unserved"></i> 0 Einsteiger im Zeitraum</li><li><i class="demand-dot unknown"></i> Daten fehlen</li></ul><p class="demand-note">Die Karte zeigt die bis zu 50 Stationen dieser Seite. Einsteiger sind keine Messung offener Gebietsnachfrage. Betriebsfarben der Züge bleiben unverändert.</p><div class="demand-table-scroll" tabindex="0" role="region" aria-label="Stationseinsteiger als Tabelle"><table><caption>Einsteiger im Zeitraum</caption><thead><tr><th scope="col">Station</th><th scope="col">Einsteiger</th></tr></thead><tbody>${data.items.map((station) => `<tr><th scope="row"><button type="button" data-demand-station="${escapeHtml(station.stationId)}">${escapeHtml(station.label)}</button></th><td>${demandNumber(station.servedPassengers)}</td></tr>`).join("") || '<tr><td colspan="2">Für dieses Zeitfenster liegen keine Stationen vor.</td></tr>'}</tbody></table></div><div class="demand-pagination"><button type="button" data-demand-first>Erste Seite</button>${data.nextCursor === null ? "" : '<button type="button" data-demand-next>Nächste Seite · je 50 Gebiete & Stationen</button>'}</div></section>`;
}
export function trainDemandMarkup(data: TrainDemand): string {
  return `<section class="demand-view train-demand"><h2>Fahrgäste & Plätze</h2>${demandPeriodMarkup(data)}<details><summary>Auslastung je Streckenabschnitt</summary><ul class="demand-segments">${data.segments.map((segment) => `<li><strong>${escapeHtml(segment.fromStationLabel)} → ${escapeHtml(segment.toStationLabel)}</strong><span>${demandNumber(segment.onboard)} Fahrgäste · ${demandNumber(segment.capacity)} Plätze</span>${segment.onboard === null || segment.capacity === null ? '<small>Auslastung nicht verfügbar</small>' : segment.capacity === 0 ? '<small>Keine Plätze bereitgestellt</small>' : `<meter min="0" max="${segment.capacity}" value="${Math.min(segment.capacity, segment.onboard)}" aria-label="${escapeHtml(segment.fromStationLabel)} nach ${escapeHtml(segment.toStationLabel)}: ${segment.onboard} von ${segment.capacity} Plätzen">${segment.onboard} / ${segment.capacity}</meter>${segment.onboard > segment.capacity ? '<small>Über Kapazität</small>' : ""}`}</li>`).join("") || "<li>Keine Abschnittsdaten verfügbar.</li>"}</ul></details><details><summary>Halte & Zeiten dieser Fahrt</summary><ol class="demand-segments">${data.stops.map((stop) => `<li><strong>${escapeHtml(stop.label)}</strong><span>Ankunft ${stop.arrivalS === null ? "nicht verfügbar" : demandTime(stop.arrivalS)} · Abfahrt ${stop.departureS === null ? "nicht verfügbar" : demandTime(stop.departureS)}</span></li>`).join("") || "<li>Keine Haltdaten verfügbar.</li>"}</ol></details></section>`;
}
export function passengerManifestMarkup(data: PassengerManifest): string {
  const needs: Readonly<Record<string, string>> = { bicycle: "Fahrrad", wheelchair: "Rollstuhlplatz", stroller: "Kinderwagen" };
  return `<p>${data.source === "confirmed" ? "Bestätigter Fahrgastbestand" : sources[data.source]} · ${escapeHtml(data.periodId)} · Stand ${demandTime(data.asOfS)}</p><p>${(data.source === "confirmed" || data.source === "observed") ? "Fahrgastkennungen dieser Fahrt." : "Prognostizierte Fahrgastkennungen im berechneten Abschnitt."} Nur dein berechtigtes Unternehmen kann diese Liste öffnen.</p><ul class="demand-segments">${data.items.map((passenger) => `<li><strong>${escapeHtml(passenger.passengerId)}</strong><span>${escapeHtml(passenger.originLabel)} → ${escapeHtml(passenger.destinationLabel)}</span><small>${passenger.seatClass === "first" ? "1." : "2."} Klasse${passenger.spaceNeeds.length === 0 ? "" : ` · ${passenger.spaceNeeds.map((need) => escapeHtml(needs[need] ?? need)).join(", ")}`}</small></li>`).join("") || "<li>Keine Fahrgäste in diesem Manifestabschnitt.</li>"}</ul>${data.nextCursor === null ? "" : '<button type="button" data-manifest-next>Nächste 50 Fahrgäste</button>'}`;
}
