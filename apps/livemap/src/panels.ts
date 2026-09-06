import type {
  LivemapObjectDetailV1,
  OwnerTrainDetailV1,
  PublicTrain,
  PublicTrainDetailV1,
  StationBoardCall,
  StationBoardV1,
} from "@zugfolge/livemap-stream";
import { formatEuroCents } from "@zugfolge/player-context";
import { externalStatusLabel, operatingStatusLabel, railwayPlaceLabel } from "./presentation.js";
import type { OperatingStatus, PublicExternalTrain } from "./protocol.js";

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
  return Object.freeze({
    definitions: Object.freeze([Object.freeze({ term: "Kartenlage", value: "Letzte bestätigte Position" })]),
    note: "Die aktuelle Position ist noch nicht bestätigt. Bis dahin bleibt der Zug an seinem letzten sicheren Standort.",
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

const BOARD_STATUS_LABEL: Readonly<Record<StationBoardCall["status"], string>> = Object.freeze({
  scheduled: "planmäßig",
  boarding: "Einstieg",
  arrived: "angekommen",
  departed: "abgefahren",
  cancelled: "fällt aus",
});

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

function boardTable(calls: readonly StationBoardCall[], movement: "Ankunft" | "Abfahrt"): HTMLElement {
  const wrapper = element("section", undefined, "board-section");
  wrapper.setAttribute("aria-labelledby", `board-${movement.toLowerCase()}`);
  const heading = element("h2", movement, "board-heading");
  heading.id = `board-${movement.toLowerCase()}`;
  const table = element("table", undefined, "split-flap-board");
  const caption = element("caption", `${movement} · aktuelle Bahnhofsinformation`, "zf-sr-only");
  const head = document.createElement("thead");
  const row = document.createElement("tr");
  ["Zeit", "Zug", movement === "Ankunft" ? "Von" : "Nach", "Gleis", "Hinweis"].forEach((label) => row.append(element("th", label)));
  head.append(row);
  const body = document.createElement("tbody");
  for (const call of calls) {
    const current = document.createElement("tr");
    if (call.status === "cancelled") current.className = "cancelled";
    const time = element("td", clockLabel(call.expectedTimeS), "flip-cell time-cell");
    if (call.expectedTimeS !== call.scheduledTimeS) {
      time.append(element("span", ` Plan ${clockLabel(call.scheduledTimeS)}`, "scheduled-time"));
    }
    const train = element("td", `${call.category} ${call.trainNumber}`, "flip-cell train-cell");
    const route = element("td", movement === "Ankunft" ? (call.origin ?? "—") : (call.destination ?? "—"), "flip-cell route-cell");
    const platform = element("td", call.platform ?? "—", "flip-cell platform-cell");
    const status = element("td", BOARD_STATUS_LABEL[call.status], "flip-cell status-cell");
    current.append(time, train, route, platform, status);
    body.append(current);
  }
  if (calls.length === 0) {
    const empty = document.createElement("tr");
    const cell = element("td", "Keine aktuellen Fahrten", "board-empty");
    cell.colSpan = 5;
    empty.append(cell);
    body.append(empty);
  }
  table.append(caption, head, body);
  wrapper.append(heading, table);
  return wrapper;
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
  fragment.append(snapshot, boardHeader, boardTable(board.departures, "Abfahrt"), boardTable(board.arrivals, "Ankunft"));
  return fragment;
}

function fisPanel(detail: PublicTrainDetailV1): HTMLElement {
  const fis = element("section", undefined, "fis-monitor");
  fis.setAttribute("aria-labelledby", "fis-title");
  const top = element("div", undefined, "fis-topline");
  const title = element("h2", `${detail.fis.category} ${detail.fis.trainNumber}`, "fis-train");
  title.id = "fis-title";
  top.append(title);
  if (detail.fis.delaySeconds !== undefined) {
    top.append(element("span", minuteLabel(detail.fis.delaySeconds), detail.fis.delaySeconds >= 60 ? "fis-delay" : "fis-ontime"));
  }
  fis.append(top);
  if (detail.fis.destination !== undefined) fis.append(element("p", `Fahrtziel ${detail.fis.destination}`, "fis-destination"));
  fis.append(element("p", detail.fis.nextStop === undefined ? "Nächster Halt noch unbekannt" : `Nächster Halt ${detail.fis.nextStop}`, "fis-next"));
  if (detail.fis.followingStops.length > 0) {
    const heading = element("h3", "Weitere Halte");
    const list = document.createElement("ol");
    detail.fis.followingStops.forEach((stop) => list.append(element("li", stop)));
    fis.append(heading, list);
  }
  detail.fis.messages.forEach((message) => fis.append(element("p", message, "fis-message")));
  return fis;
}

export function trainPanel(detail: PublicTrainDetailV1, owner: OwnerTrainDetailV1 | undefined): DocumentFragment {
  const train = detail.train;
  const fragment = document.createDocumentFragment();
  fragment.append(titleBlock("ZUGLAUF", train.trainNumber, `${train.operator} · ${train.category}`));
  const list = document.createElement("dl");
  const positionDetails = element("details", undefined, "technical-object-details");
  positionDetails.append(element("summary", "Positionsdaten ansehen"));
  const positionList = document.createElement("dl");
  let estimateNote: HTMLElement | undefined;
  addDefinition(list, "Status", "progressBasisPoints" in train
    ? externalStatusLabel(train.status as PublicExternalTrain["status"])
    : operatingStatusLabel(train.status as OperatingStatus));
  if (train.delaySeconds !== undefined) {
    addDefinition(list, "Verspätung", minuteLabel(train.delaySeconds), train.delaySeconds >= 60 ? "warn" : undefined);
  }
  if (detail.movement === "network" && "speedMmPerSecond" in detail.train) {
    const networkTrain = detail.train;
    addDefinition(list, "Geschwindigkeit", `${Math.round((networkTrain.speedMmPerSecond * 36) / 10_000)} km/h`);
    if (networkTrain.nextOperatingPoint !== undefined) {
      addDefinition(list, "Nächster Halt", networkTrain.nextOperatingPoint);
    }
    const mapSummary = trainMapPositionSummary(networkTrain);
    mapSummary.definitions.forEach(({ term, value }) => addDefinition(positionList, term, value));
    if (mapSummary.note !== undefined) estimateNote = element("p", mapSummary.note, "position-estimate-note");
  } else if ("progressBasisPoints" in detail.train) {
    const externalTrain = detail.train;
    addDefinition(list, "Außenlauf", `${Math.floor(externalTrain.progressBasisPoints / 100)} %`);
    addDefinition(list, "Letztes Grenzportal", railwayPlaceLabel(externalTrain.fromPortalId));
    addDefinition(list, "Nächstes Grenzportal", externalTrain.toPortalId ?? "keine Wiedereinfahrt");
  }
  fragment.append(list);
  if (estimateNote !== undefined) fragment.append(estimateNote);
  fragment.append(fisPanel(detail));
  if (positionList.children.length > 0) { positionDetails.append(positionList); fragment.append(positionDetails); }
  if (owner !== undefined) {
    const privateSection = element("section", undefined, "owner-details");
    privateSection.append(element("h2", "Dein Zug im Einsatz"));
    const ownerList = document.createElement("dl");
    if (owner.formationLabel !== undefined) addDefinition(ownerList, "Zugverband", owner.formationLabel);
    addDefinition(ownerList, "Fahrzeuge", owner.vehicleIds.join(", ") || "nicht gebunden");
    addDefinition(ownerList, "Personaldienste", owner.personnelDutyIds.join(", ") || "nicht gebunden");
    addDefinition(ownerList, "Fahrwegressourcen", String(owner.pathResourceIds.length));
    if (owner.fixedCostCents !== undefined) addDefinition(ownerList, "Fixkosten", formatEuroCents(owner.fixedCostCents));
    privateSection.append(ownerList);
    fragment.append(privateSection);
  }
  return fragment;
}
