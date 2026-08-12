import type {
  LivemapObjectDetailV1,
  OwnerTrainDetailV1,
  PublicTrain,
  PublicTrainDetailV1,
  StationBoardCall,
  StationBoardV1,
} from "@zugfolge/livemap-stream";

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

export function objectDetailPanel(detail: LivemapObjectDetailV1): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(titleBlock(detail.kind.toLocaleUpperCase("de"), detail.name));
  const quality = element("p", `Klasse ${detail.qualityClass}`, `quality quality-${detail.qualityClass.toLowerCase()}`);
  quality.setAttribute("aria-label", `Datenqualität Klasse ${detail.qualityClass}`);
  fragment.append(quality);

  const list = document.createElement("dl");
  addDefinition(list, "Objektkennung", detail.id);
  addDefinition(list, "Infrastrukturstand", detail.infrastructureReleaseId);
  for (const fact of detail.facts) {
    addDefinition(list, fact.label, `${fact.value}${fact.unit === undefined ? "" : ` ${fact.unit}`}`);
  }
  fragment.append(list);
  if (detail.qualityClass === "C") {
    fragment.append(element("p", "Nur Kartenkontext: Dieses Objekt ist nicht für Trassenbestellung oder Fahrdienstleitung freigegeben.", "quality-note"));
  }
  return fragment;
}

const BOARD_STATUS_LABEL: Readonly<Record<StationBoardCall["status"], string>> = Object.freeze({
  scheduled: "planmäßig",
  boarding: "Einstieg",
  arrived: "angekommen",
  departed: "abgefahren",
  cancelled: "fällt aus",
});

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
  const boardHeader = element("div", undefined, "board-brand");
  boardHeader.append(element("span", board.stationName), element("time", `Stand ${clockLabel(board.atS)}`));
  fragment.append(boardHeader, boardTable(board.departures, "Abfahrt"), boardTable(board.arrivals, "Ankunft"));
  return fragment;
}

function fisPanel(detail: PublicTrainDetailV1): HTMLElement {
  const fis = element("section", undefined, "fis-monitor");
  fis.setAttribute("aria-labelledby", "fis-title");
  const top = element("div", undefined, "fis-topline");
  const title = element("h2", `${detail.fis.category} ${detail.fis.trainNumber}`, "fis-train");
  title.id = "fis-title";
  top.append(title, element("span", minuteLabel(detail.fis.delaySeconds), detail.fis.delaySeconds > 60 ? "fis-delay" : "fis-ontime"));
  fis.append(top);
  if (detail.fis.destination !== undefined) fis.append(element("p", `Fahrtziel ${detail.fis.destination}`, "fis-destination"));
  fis.append(element("p", detail.fis.nextStop === undefined ? "Nächster Halt wird noch nicht projiziert" : `Nächster Halt ${detail.fis.nextStop}`, "fis-next"));
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
  let estimateNote: HTMLElement | undefined;
  addDefinition(list, "Status", train.status);
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
    addDefinition(list, "Letztes Grenzportal", externalTrain.fromPortalId);
    addDefinition(list, "Nächstes Grenzportal", externalTrain.toPortalId ?? "keine Wiedereinfahrt");
  }
  fragment.append(list);
  if (estimateNote !== undefined) fragment.append(estimateNote);
  fragment.append(fisPanel(detail));
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
