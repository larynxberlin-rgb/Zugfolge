import type {
  LivemapObjectDetailV1,
  OwnerTrainDetailV1,
  PublicTrain,
  PublicTrainDetailV1,
  StationBoardV1,
} from "@zugfolge/livemap-stream";
import { externalStatusLabel, operatingStatusLabel, railwayPlaceLabel } from "./presentation.js";
import type { OperatingStatus, PublicExternalTrain } from "./protocol.js";
import { renderFisDisplay, renderStationSplitFlapDisplays } from "./railway-displays.js";

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className !== undefined) node.className = className;
  return node;
}

function addDefinition(list: HTMLDListElement, term: string, value: string, className?: string): void {
  list.append(element("dt", term), element("dd", value, className));
}

function minuteLabel(seconds: number): string {
  if (seconds === 0) return "0 min";
  const sign = seconds > 0 ? "+" : "−";
  return `${sign}${Math.floor(Math.abs(seconds) / 60)} min`;
}

const ESTIMATE_METHOD_LABEL = Object.freeze({
  "topological-track": "Fahrtfortschritt auf einem Darstellungsgleis",
  "route-corridor": "Fahrtfortschritt im geplanten Streckenkorridor",
  "anchor-hold": "Letzte belastbare Kartenlage",
});

function uncertaintyLabel(uncertaintyMm: number): string {
  const metres = Math.ceil(uncertaintyMm / 1_000);
  if (metres < 1_000) {
    const roundedMetres = Math.max(100, Math.ceil(metres / 100) * 100);
    return `ungefähr ± ${roundedMetres} m`;
  }
  return `ungefähr ± ${Math.ceil(metres / 1_000)} km`;
}

export interface TrainMapPositionSummary {
  readonly definitions: readonly { readonly term: string; readonly value: string }[];
  readonly note?: string;
}

/** Spielertext ohne technische Scheingenauigkeit oder betriebliche Wirkung. */
export function trainMapPositionSummary(train: PublicTrain): TrainMapPositionSummary {
  if (train.mapPosition !== undefined) {
    return Object.freeze({
      definitions: Object.freeze([
        Object.freeze({ term: "Kartenlage", value: "bestätigt" }),
        Object.freeze({ term: "Infrastrukturstand", value: train.mapPosition.infrastructureReleaseId }),
        Object.freeze({ term: "Gleis", value: train.mapPosition.trackId }),
        Object.freeze({ term: "Position", value: `${Math.floor(train.mapPosition.offsetMm / 1_000)} m` }),
      ]),
    });
  }
  const estimate = train.mapEstimate;
  if (estimate === undefined) return Object.freeze({ definitions: Object.freeze([]) });
  return Object.freeze({
    definitions: Object.freeze([
      Object.freeze({
        term: "Kartenlage",
        value: estimate.method === "anchor-hold" ? "letzte Lage (?)" : "geschätzt (≈)",
      }),
      Object.freeze({ term: "Infrastrukturstand", value: estimate.infrastructureReleaseId }),
      Object.freeze({ term: "Ableitung", value: ESTIMATE_METHOD_LABEL[estimate.method] }),
      Object.freeze({ term: "Unsicherheitsbereich", value: uncertaintyLabel(estimate.uncertaintyMm) }),
    ]),
    note: estimate.method === "anchor-hold"
      ? "Der Marker bleibt an der letzten belastbaren Stelle. Die Fahrt läuft im System weiter; das Fragezeichen ist kein Stillstandssignal."
      : "Der Marker folgt dem bekannten Fahrtverlauf. Die graue Schätzung dient nur der Orientierung und hat keine Wirkung auf Fahrweg, Konflikte oder Fahrdienstleitung.",
  });
}

function clockLabel(seconds: number): string {
  const daySeconds = ((seconds % 86_400) + 86_400) % 86_400;
  const hours = Math.floor(daySeconds / 3_600);
  const minutes = Math.floor((daySeconds % 3_600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function titleBlock(eyebrow: string, title: string, subtitle?: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(element("p", eyebrow, "eyebrow"), element("h1", title));
  if (subtitle !== undefined && subtitle !== "") fragment.append(element("p", subtitle, "subtitle"));
  return fragment;
}

export function loadingPanel(label: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(element("p", "KARTENOBJEKT", "eyebrow"), element("p", `${label} wird geladen …`, "panel-status"));
  return fragment;
}

export function messagePanel(message: string, tone: "quiet" | "error" = "quiet"): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(element("p", "LIVE-LAGE", "eyebrow"), element("p", message, tone === "error" ? "panel-status error" : "panel-status"));
  return fragment;
}

export interface PlayerObjectSummary {
  readonly eyebrow: string;
  readonly title: string;
  readonly definitions: readonly { readonly term: string; readonly value: string }[];
}

function objectFact(detail: LivemapObjectDetailV1, ...labels: readonly string[]): string | undefined {
  const fact = detail.facts.find((entry) => labels.includes(entry.label));
  return fact === undefined ? undefined : `${fact.value}${fact.unit === undefined ? "" : ` ${fact.unit}`}`;
}

/** Verdichtet den technischen Releasekatalog in das mentale Modell des Spielers. */
export function playerObjectSummary(detail: LivemapObjectDetailV1): PlayerObjectSummary {
  const definitions: { term: string; value: string }[] = [];
  const add = (term: string, value: string | undefined): void => {
    if (value !== undefined && value.trim() !== "") definitions.push({ term, value });
  };
  if (detail.kind === "track") {
    const kbs = objectFact(detail, "KBS-Bezeichnung", "Kursbuchstrecke");
    const officialName = objectFact(detail, "Streckenbezeichnung");
    add("KBS", kbs);
    add("VzG-Streckennummer", objectFact(detail, "Streckennummer"));
    const maximum = objectFact(detail, "Zulaessige Geschwindigkeit", "Zulässige Geschwindigkeit");
    const forward = objectFact(detail, "Geschwindigkeit in Geometrierichtung");
    const backward = objectFact(detail, "Geschwindigkeit gegen Geometrierichtung");
    add("Vzul", maximum ?? (forward === backward ? forward : [forward, backward].filter((value): value is string => value !== undefined).join(" / ") || undefined));
    add("Elektrifizierung", objectFact(detail, "Elektrifizierung"));
    add("Gleise", objectFact(detail, "Gleiszahl", "Gleiszahl im Streckenabschnitt"));
    return Object.freeze({ eyebrow: "STRECKE", title: kbs ?? officialName ?? detail.name, definitions: Object.freeze(definitions) });
  }
  if (detail.kind === "station" || detail.kind === "operating-point") {
    add("RIL 100", objectFact(detail, "RIL-100-Kürzel", "RL100-Kuerzel"));
    add("EVA / UIC", objectFact(detail, "EVA-/UIC-Nummer"));
    add("Betriebsstellenart", objectFact(detail, "Betriebsstellenart"));
    return Object.freeze({ eyebrow: detail.kind === "station" ? "BAHNHOF" : "BETRIEBSSTELLE", title: detail.name, definitions: Object.freeze(definitions) });
  }
  if (detail.kind === "signal") {
    add("Bezeichnung", objectFact(detail, "Signalbezeichnung"));
    add("Wirkrichtung", objectFact(detail, "Wirkrichtung"));
    add("Blockgrenze", objectFact(detail, "Blockgrenze"));
    return Object.freeze({ eyebrow: "SIGNAL", title: detail.name, definitions: Object.freeze(definitions) });
  }
  for (const fact of detail.facts) {
    if (["Datenqualitaet", "Betriebsmodell", "Fuer Fahrwege nutzbar"].includes(fact.label)) continue;
    add(fact.label, `${fact.value}${fact.unit === undefined ? "" : ` ${fact.unit}`}`);
    if (definitions.length === 4) break;
  }
  return Object.freeze({ eyebrow: "KARTENOBJEKT", title: detail.name, definitions: Object.freeze(definitions) });
}

export function objectDetailPanel(detail: LivemapObjectDetailV1): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const summary = playerObjectSummary(detail);
  fragment.append(titleBlock(summary.eyebrow, summary.title));

  const list = document.createElement("dl");
  for (const definition of summary.definitions) addDefinition(list, definition.term, definition.value);
  fragment.append(list);

  const technical = document.createElement("details");
  technical.className = "technical-object-details";
  technical.append(element("summary", "Technische Details"));
  const quality = element("p", `Datenqualität Klasse ${detail.qualityClass}`, `quality quality-${detail.qualityClass.toLowerCase()}`);
  quality.setAttribute("aria-label", `Datenqualität Klasse ${detail.qualityClass}`);
  const technicalList = document.createElement("dl");
  addDefinition(technicalList, "Objektkennung", detail.id);
  addDefinition(technicalList, "Infrastrukturstand", detail.infrastructureReleaseId);
  for (const fact of detail.facts) addDefinition(technicalList, fact.label, `${fact.value}${fact.unit === undefined ? "" : ` ${fact.unit}`}`);
  technical.append(quality, technicalList);
  if (detail.qualityClass === "C") technical.append(element("p", "Nur Datenbestand: Dieses Objekt ist nicht für Bestellung oder Fahrdienstleitung freigegeben.", "quality-note"));
  fragment.append(technical);
  return fragment;
}

export interface StationBoardSummary {
  readonly definitions: readonly { readonly term: string; readonly value: string }[];
}

/** Statistik des sichtbaren Fahrplanfensters; bewusst keine vorgetäuschte Langzeitstatistik. */
export function stationBoardSummary(board: StationBoardV1): StationBoardSummary {
  const trains = new Map<string, { delaySeconds: number; cancelled: boolean }>();
  const platforms = new Set<string>();
  const categories = new Set<string>();
  for (const call of [...board.departures, ...board.arrivals]) {
    const previous = trains.get(call.trainId);
    const delaySeconds = Math.max(0, call.expectedTimeS - call.scheduledTimeS);
    trains.set(call.trainId, {
      delaySeconds: Math.max(previous?.delaySeconds ?? 0, delaySeconds),
      cancelled: (previous?.cancelled ?? false) || call.status === "cancelled",
    });
    if (call.platform !== undefined && call.platform.trim() !== "") platforms.add(call.platform.trim());
    if (call.category.trim() !== "") categories.add(call.category.trim());
  }
  const running = [...trains.values()].filter((train) => !train.cancelled);
  const onTime = running.filter((train) => train.delaySeconds <= 300).length;
  const punctuality = running.length === 0 ? "–" : `${Math.round((onTime / running.length) * 100)} %`;
  return Object.freeze({
    definitions: Object.freeze([
      Object.freeze({ term: "Fahrten im aktuellen Fenster", value: String(trains.size) }),
      Object.freeze({ term: "Pünktlich bis 5 min", value: punctuality }),
      Object.freeze({ term: "Ausfälle", value: String([...trains.values()].filter((train) => train.cancelled).length) }),
      Object.freeze({ term: "Gleise mit Verkehr", value: String(platforms.size) }),
      Object.freeze({ term: "Zuggattungen", value: [...categories].sort((left, right) => left.localeCompare(right, "de")).join(", ") || "–" }),
    ]),
  });
}

export function stationPanel(detail: LivemapObjectDetailV1, board: StationBoardV1): DocumentFragment {
  const fragment = objectDetailPanel(detail);
  fragment.append(element("hr", undefined, "panel-divider"));
  const snapshot = element("section", undefined, "station-snapshot");
  snapshot.append(element("h2", "Aktuelles Stationsbild"));
  const statistics = element("dl", undefined, "station-statistics");
  for (const definition of stationBoardSummary(board).definitions) {
    const statistic = element("div");
    statistic.append(element("dt", definition.term), element("dd", definition.value));
    statistics.append(statistic);
  }
  snapshot.append(statistics);
  const boardHeader = element("div", undefined, "board-brand");
  boardHeader.append(element("span", board.stationName), element("time", `Stand ${clockLabel(board.atS)}`));
  fragment.append(snapshot, boardHeader, renderStationSplitFlapDisplays(board));
  return fragment;
}

export function trainPanel(detail: PublicTrainDetailV1, owner: OwnerTrainDetailV1 | undefined): DocumentFragment {
  const train = detail.train;
  const fragment = document.createDocumentFragment();
  fragment.append(titleBlock("ZUGLAUF", train.trainNumber, `${train.operator} · ${train.category}`));
  const list = document.createElement("dl");
  let estimateNote: HTMLElement | undefined;
  addDefinition(list, "Status", "progressBasisPoints" in train
    ? externalStatusLabel(train.status as PublicExternalTrain["status"])
    : operatingStatusLabel(train.status as OperatingStatus));
  addDefinition(list, "Verspätung", minuteLabel(train.delaySeconds), train.delaySeconds > 60 ? "warn" : undefined);
  if (detail.movement === "network" && "speedMmPerSecond" in detail.train) {
    const networkTrain = detail.train;
    addDefinition(list, "Geschwindigkeit", `${Math.round((networkTrain.speedMmPerSecond * 36) / 10_000)} km/h`);
    addDefinition(list, "Nächster Betriebspunkt", networkTrain.nextOperatingPoint);
    const mapSummary = trainMapPositionSummary(networkTrain);
    mapSummary.definitions.forEach(({ term, value }) => addDefinition(list, term, value));
    if (mapSummary.note !== undefined) estimateNote = element("p", mapSummary.note, "position-estimate-note");
  } else if ("progressBasisPoints" in detail.train) {
    const externalTrain = detail.train;
    addDefinition(list, "Außenlauf", `${Math.floor(externalTrain.progressBasisPoints / 100)} %`);
    addDefinition(list, "Letztes Grenzportal", railwayPlaceLabel(externalTrain.fromPortalId));
    addDefinition(list, "Nächstes Grenzportal", externalTrain.toPortalId ?? "keine Wiedereinfahrt");
  }
  fragment.append(list);
  if (estimateNote !== undefined) fragment.append(estimateNote);
  fragment.append(renderFisDisplay(detail.fis));
  if (owner !== undefined) {
    const privateSection = element("section", undefined, "owner-details");
    privateSection.append(element("h2", "Eigener Zug · interne Betriebsdaten"));
    const ownerList = document.createElement("dl");
    if (owner.formationLabel !== undefined) addDefinition(ownerList, "Formation", owner.formationLabel);
    addDefinition(ownerList, "Fahrzeuge", owner.vehicleIds.join(", ") || "nicht gebunden");
    addDefinition(ownerList, "Personaldienste", owner.personnelDutyIds.join(", ") || "nicht gebunden");
    addDefinition(ownerList, "Fahrwegressourcen", String(owner.pathResourceIds.length));
    if (owner.fixedCostCents !== undefined) addDefinition(ownerList, "Fixkosten", `${owner.fixedCostCents} ct`);
    privateSection.append(ownerList);
    fragment.append(privateSection);
  } else {
    fragment.append(element("p", "Bei fremden Zügen werden ausschließlich öffentliche Betriebs- und Fahrgastinformationen angezeigt.", "privacy-note"));
  }
  return fragment;
}
