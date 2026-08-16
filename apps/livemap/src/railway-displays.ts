import { icon, type IconName } from "@zugfolge/design-system";
import type {
  PassengerInformationDisplayV1,
  StationBoardCall,
  StationBoardV1,
} from "@zugfolge/livemap-stream";

export type FisVariant = "suburban" | "regional" | "long-distance";
export type BoardMovement = "arrival" | "departure";
export type SplitFlapMotionMode = "normal" | "reduced" | "none";

export const SPLIT_FLAP_MOTION_STORAGE_KEY = "zugfolge:split-flap-motion";

const FIS_VARIANT_LABEL: Readonly<Record<FisVariant, string>> = Object.freeze({
  suburban: "S-Bahn",
  regional: "Regionalverkehr",
  "long-distance": "Fernverkehr",
});

const FIS_VARIANT_ICON: Readonly<Record<FisVariant, IconName>> = Object.freeze({
  suburban: "train-suburban",
  regional: "train-regional",
  "long-distance": "train-long-distance",
});

const BOARD_STATUS_LABEL: Readonly<Record<StationBoardCall["status"], string>> = Object.freeze({
  scheduled: "planmäßig",
  boarding: "Einstieg",
  arrived: "angekommen",
  departed: "abgefahren",
  cancelled: "fällt aus",
});

const FLAP_FIELD_WIDTHS = Object.freeze({
  time: 5,
  train: 12,
  route: 22,
  platform: 5,
  status: 12,
});

const FLAP_ALPHABET = " ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789-./";

export type SplitFlapRowStatus = StationBoardCall["status"] | "delayed" | "early";

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

function appendIcon(target: HTMLElement, name: IconName): void {
  const template = document.createElement("template");
  template.innerHTML = icon(name);
  target.append(template.content);
}

function clockLabel(seconds: number): string {
  const daySeconds = ((seconds % 86_400) + 86_400) % 86_400;
  const hours = Math.floor(daySeconds / 3_600);
  const minutes = Math.floor((daySeconds % 3_600) / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function minuteCount(seconds: number): number {
  return Math.max(1, Math.round(Math.abs(seconds) / 60));
}

function delayLabel(seconds: number): string {
  if (Math.abs(seconds) < 60) return "planmäßig";
  return `${seconds > 0 ? "+" : "−"}${minuteCount(seconds)} min`;
}

function delayAccessibleLabel(seconds: number): string {
  if (Math.abs(seconds) < 60) return "planmäßig";
  const minutes = minuteCount(seconds);
  return seconds > 0
    ? `${minutes} ${minutes === 1 ? "Minute" : "Minuten"} später`
    : `${minutes} ${minutes === 1 ? "Minute" : "Minuten"} früher`;
}

function fisTrainLabel(category: string, trainNumber: string): string {
  const normalizedCategory = category.trim();
  const normalizedNumber = trainNumber.trim();
  const compactCategory = normalizedCategory.toLocaleUpperCase("de").replace(/[^A-ZÄÖÜ0-9]/g, "");
  if (["LONGDISTANCE", "SUBURBAN", "REGIONAL", "FREIGHT", "SUPPLEMENTARY"].includes(compactCategory)) {
    return normalizedNumber;
  }
  if (normalizedNumber.toLocaleUpperCase("de").startsWith(normalizedCategory.toLocaleUpperCase("de"))) {
    return normalizedNumber;
  }
  return `${normalizedCategory} ${normalizedNumber}`.trim();
}

/** Ordnet nur anhand der vorhandenen Zuggattung ein; unbekannte Werte bleiben Regionalverkehr. */
export function fisVariantForCategory(category: string): FisVariant {
  const normalized = category.trim().toLocaleUpperCase("de");
  const compact = normalized.replace(/[^A-ZÄÖÜ0-9]/g, "");
  if (
    normalized.includes("S-BAHN")
    || compact === "SUBURBAN"
    || /^S(?:\d|$)/.test(compact)
  ) return "suburban";
  if (
    normalized.includes("FERNVERKEHR")
    || compact === "LONGDISTANCE"
    || /^(?:ICE|ECE|IC|EC|EN|NJ|RJ|TGV|THA)(?:\d|$)/.test(compact)
  ) return "long-distance";
  return "regional";
}

export interface FisDisplayModel {
  readonly variant: FisVariant;
  readonly variantLabel: string;
  readonly iconName: IconName;
  readonly trainLabel: string;
  readonly destination?: string;
  readonly nextStop?: string;
  readonly followingStops: readonly string[];
  readonly delayText: string;
  readonly delayAccessibleText: string;
  readonly delayed: boolean;
  readonly statusCode: string;
  readonly statusText: string;
  readonly cancelled: boolean;
  readonly messages: readonly string[];
}

const FIS_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  planned: "Geplant",
  running: "Unterwegs",
  waiting: "Wartet",
  at_platform: "Am Bahnsteig",
  completed: "Beendet",
  cancelled: "Fällt aus",
  outside: "Außerhalb des Spielgebiets",
  "ready-at-boundary": "An der Netzgrenze bereit",
  "waiting-for-capacity": "Wartet auf freie Kapazität",
  "completed-outside": "Außerhalb beendet",
});

/** Exakte Verdichtung des bestehenden FIS-Vertrags, ohne Halte oder Ausstattung zu erfinden. */
export function fisDisplayModel(fis: PassengerInformationDisplayV1): FisDisplayModel {
  const variant = fisVariantForCategory(fis.category);
  const normalizedStatus = fis.status.trim().toLocaleLowerCase("de");
  return Object.freeze({
    variant,
    variantLabel: FIS_VARIANT_LABEL[variant],
    iconName: FIS_VARIANT_ICON[variant],
    trainLabel: fisTrainLabel(fis.category, fis.trainNumber),
    ...(fis.destination === undefined ? {} : { destination: fis.destination }),
    ...(fis.nextStop === undefined ? {} : { nextStop: fis.nextStop }),
    followingStops: Object.freeze([...fis.followingStops]),
    delayText: delayLabel(fis.delaySeconds),
    delayAccessibleText: delayAccessibleLabel(fis.delaySeconds),
    delayed: fis.delaySeconds >= 60,
    statusCode: fis.status,
    statusText: FIS_STATUS_LABEL[normalizedStatus] ?? fis.status,
    cancelled: normalizedStatus === "cancelled",
    messages: Object.freeze([...fis.messages]),
  });
}

function fisHeader(model: FisDisplayModel): HTMLElement {
  const header = element("header", undefined, "fis-display__header");
  const identity = element("div", undefined, "fis-display__identity");
  appendIcon(identity, model.iconName);
  const labels = element("div");
  labels.append(
    element("span", model.variantLabel, "fis-display__mode"),
    element("h2", model.trainLabel, "fis-display__train"),
  );
  identity.append(labels);
  const operation = element("div", undefined, "fis-display__operation");
  const status = element("span", undefined, model.cancelled ? "fis-display__status is-cancelled" : "fis-display__status");
  if (model.cancelled) appendIcon(status, "disruption");
  status.append(element("span", model.statusText));
  const delay = element("output", model.delayText, model.delayed ? "fis-display__delay is-delayed" : "fis-display__delay");
  delay.setAttribute("aria-label", `Fahrplanlage: ${model.delayAccessibleText}`);
  operation.append(status, delay);
  header.append(identity, operation);
  return header;
}

function missingValue(label: string): HTMLElement {
  return element("span", `${label} nicht verfügbar`, "fis-display__missing");
}

function stopPearlString(model: FisDisplayModel): HTMLElement {
  const list = element("ol", undefined, "fis-pearl-string");
  if (model.nextStop !== undefined) {
    const next = element("li", undefined, "is-next");
    next.append(element("span", undefined, "fis-pearl-string__point"), element("strong", model.nextStop));
    list.append(next);
  }
  for (const stop of model.followingStops) {
    const item = element("li");
    item.append(element("span", undefined, "fis-pearl-string__point"), element("span", stop));
    list.append(item);
  }
  if (list.childElementCount === 0) {
    const empty = element("li", undefined, "is-empty");
    empty.append(missingValue("Fahrtverlauf"));
    list.append(empty);
  }
  return list;
}

function suburbanFisBody(model: FisDisplayModel): HTMLElement {
  const body = element("div", undefined, "fis-display__body fis-display__body--suburban");
  const destination = element("div", undefined, "fis-display__destination");
  destination.append(element("span", "Richtung", "fis-display__label"));
  destination.append(model.destination === undefined ? missingValue("Ziel") : element("strong", model.destination));
  const next = element("div", undefined, "fis-display__next");
  appendIcon(next, "station");
  const nextText = element("div");
  nextText.append(element("span", "Nächster Halt", "fis-display__label"));
  nextText.append(model.nextStop === undefined ? missingValue("Nächster Halt") : element("strong", model.nextStop));
  next.append(nextText);
  body.append(destination, next, stopPearlString(model));
  return body;
}

function regionalFisBody(model: FisDisplayModel): HTMLElement {
  const body = element("div", undefined, "fis-display__body fis-display__body--regional");
  const destination = element("div", undefined, "fis-display__destination");
  destination.append(element("span", "Fahrtziel", "fis-display__label"));
  destination.append(model.destination === undefined ? missingValue("Ziel") : element("strong", model.destination));
  const next = element("div", undefined, "fis-display__next");
  appendIcon(next, "station");
  const nextText = element("div");
  nextText.append(element("span", "Nächster Halt", "fis-display__label"));
  nextText.append(model.nextStop === undefined ? missingValue("Nächster Halt") : element("strong", model.nextStop));
  next.append(nextText);
  body.append(destination, next);
  if (model.followingStops.length > 0) {
    const following = element("section", undefined, "fis-display__following");
    following.append(element("h3", "Danach"));
    const list = document.createElement("ol");
    model.followingStops.forEach((stop) => list.append(element("li", stop)));
    following.append(list);
    body.append(following);
  } else {
    body.append(missingValue("Weitere Halte"));
  }
  return body;
}

function longDistanceFisBody(model: FisDisplayModel): HTMLElement {
  const body = element("div", undefined, "fis-display__body fis-display__body--long-distance");
  const destination = element("div", undefined, "fis-display__destination");
  destination.append(element("span", "Fahrtziel", "fis-display__label"));
  destination.append(model.destination === undefined ? missingValue("Ziel") : element("strong", model.destination));
  const next = element("div", undefined, "fis-display__next");
  appendIcon(next, "station");
  const nextText = element("div");
  nextText.append(element("span", "Nächster Halt", "fis-display__label"));
  nextText.append(model.nextStop === undefined ? missingValue("Nächster Halt") : element("strong", model.nextStop));
  next.append(nextText);
  const journey = element("section", undefined, "fis-display__journey");
  journey.append(element("h3", "Fahrtverlauf"), stopPearlString(model));
  body.append(destination, next, journey);
  return body;
}

function fisMessages(model: FisDisplayModel): HTMLElement | undefined {
  if (model.messages.length === 0) return undefined;
  const messages = element("section", undefined, "fis-display__messages");
  messages.setAttribute("aria-label", "Fahrgastinformationen");
  for (const message of model.messages) {
    const item = element("p");
    appendIcon(item, "information");
    item.append(element("span", message));
    messages.append(item);
  }
  return messages;
}

/** Drei datengetriebene, markenfreie FIS-Varianten mit derselben API. */
export function renderFisDisplay(fis: PassengerInformationDisplayV1): HTMLElement {
  const model = fisDisplayModel(fis);
  const display = element("section", undefined, `fis-display fis-display--${model.variant}`);
  display.dataset["variant"] = model.variant;
  display.setAttribute("aria-label", `Fahrgastinformation für ${model.trainLabel}`);
  display.append(fisHeader(model));
  display.append(model.variant === "suburban"
    ? suburbanFisBody(model)
    : model.variant === "long-distance"
      ? longDistanceFisBody(model)
      : regionalFisBody(model));
  const messages = fisMessages(model);
  if (messages !== undefined) display.append(messages);
  return display;
}

export interface SplitFlapRowModel {
  readonly key: string;
  readonly time: string;
  readonly scheduledTime?: string;
  readonly train: string;
  readonly route: string;
  readonly platform: string;
  readonly status: string;
  readonly statusCode: SplitFlapRowStatus;
}

export interface SplitFlapBoardModel {
  readonly movement: BoardMovement;
  readonly title: "Ankunft" | "Abfahrt";
  readonly routeHeading: "Von" | "Nach";
  readonly at: string;
  readonly rows: readonly SplitFlapRowModel[];
  readonly loadedAnnouncement: string;
  readonly updatedAnnouncement: string;
}

function boardStatus(call: StationBoardCall): Readonly<{ label: string; code: SplitFlapRowStatus }> {
  if (call.status !== "scheduled") {
    return Object.freeze({ label: BOARD_STATUS_LABEL[call.status], code: call.status });
  }
  const deviationSeconds = call.expectedTimeS - call.scheduledTimeS;
  if (Math.abs(deviationSeconds) < 60) {
    return Object.freeze({ label: BOARD_STATUS_LABEL.scheduled, code: "scheduled" });
  }
  return Object.freeze({
    label: delayLabel(deviationSeconds),
    code: deviationSeconds > 0 ? "delayed" : "early",
  });
}

export function splitFlapBoardModel(
  calls: readonly StationBoardCall[],
  movement: BoardMovement,
  atS: number,
): SplitFlapBoardModel {
  const title = movement === "arrival" ? "Ankunft" : "Abfahrt";
  const rows = calls.map((call) => {
    const status = boardStatus(call);
    return Object.freeze({
      key: `${call.trainId}:${call.scheduledTimeS}`,
      time: clockLabel(call.expectedTimeS),
      ...(call.expectedTimeS === call.scheduledTimeS ? {} : { scheduledTime: clockLabel(call.scheduledTimeS) }),
      train: `${call.category} ${call.trainNumber}`.trim(),
      route: movement === "arrival" ? (call.origin ?? "nicht verfügbar") : (call.destination ?? "nicht verfügbar"),
      platform: call.platform ?? "—",
      status: status.label,
      statusCode: status.code,
    });
  });
  const snapshot = `Stand ${clockLabel(atS)}, ${rows.length} ${rows.length === 1 ? "Fahrt" : "Fahrten"}.`;
  return Object.freeze({
    movement,
    title,
    routeHeading: movement === "arrival" ? "Von" : "Nach",
    at: clockLabel(atS),
    rows: Object.freeze(rows),
    loadedAnnouncement: `${title}stafel geladen. ${snapshot}`,
    updatedAnnouncement: `${title}stafel aktualisiert. ${snapshot}`,
  });
}

export function splitFlapBoardHasSemanticChange(
  previous: SplitFlapBoardModel | undefined,
  current: SplitFlapBoardModel,
): boolean {
  if (previous === undefined || previous.movement !== current.movement || previous.rows.length !== current.rows.length) {
    return true;
  }
  return current.rows.some((row, index) => {
    const old = previous.rows[index];
    return old === undefined
      || old.key !== row.key
      || old.time !== row.time
      || old.scheduledTime !== row.scheduledTime
      || old.train !== row.train
      || old.route !== row.route
      || old.platform !== row.platform
      || old.status !== row.status
      || old.statusCode !== row.statusCode;
  });
}

export function splitFlapBoardAnnouncement(
  previous: SplitFlapBoardModel | undefined,
  current: SplitFlapBoardModel,
): string | undefined {
  if (!splitFlapBoardHasSemanticChange(previous, current)) return undefined;
  return previous?.movement === current.movement
    ? current.updatedAnnouncement
    : current.loadedAnnouncement;
}

/** Festes Segmentfeld wie bei einer mechanischen Fallblattanzeige. */
export function splitFlapCharacters(value: string, width: number): readonly string[] {
  if (!Number.isSafeInteger(width) || width < 1) throw new RangeError("Fallblattbreite muss positiv sein.");
  const characters = Array.from(value.toLocaleUpperCase("de"));
  const visible = characters.length <= width
    ? characters
    : [...characters.slice(0, Math.max(0, width - 1)), "…"];
  return Object.freeze([...visible, ...Array.from({ length: width - visible.length }, () => " ")]);
}

export function splitFlapSequence(
  previous: string,
  target: string,
  motion: SplitFlapMotionMode,
): readonly string[] {
  if (previous === target || motion !== "normal") return Object.freeze([]);
  const previousIndex = FLAP_ALPHABET.indexOf(previous);
  const targetIndex = FLAP_ALPHABET.indexOf(target);
  if (previousIndex < 0 || targetIndex < 0) return Object.freeze([target]);
  const distance = (targetIndex - previousIndex + FLAP_ALPHABET.length) % FLAP_ALPHABET.length;
  const offsets = distance <= 3 ? Array.from({ length: distance }, (_, index) => index + 1) : [1, 2, distance];
  return Object.freeze(offsets.map((offset) => FLAP_ALPHABET[(previousIndex + offset) % FLAP_ALPHABET.length]!));
}

export interface SplitFlapCharacterTransition {
  readonly changed: boolean;
  readonly from: string;
  readonly intermediate: readonly string[];
  readonly to: string;
}

/** Reine Zeichenfolge fuer einen gezielten alt→neu-Wechsel. */
export function splitFlapCharacterTransition(
  previous: string,
  target: string,
  motion: SplitFlapMotionMode,
): SplitFlapCharacterTransition {
  const changed = previous !== target;
  return Object.freeze({
    changed,
    from: previous,
    intermediate: changed ? splitFlapSequence(previous, target, motion) : Object.freeze([]),
    to: target,
  });
}

export function splitFlapFieldTransitions(
  previousValue: string | undefined,
  targetValue: string,
  width: number,
  motion: SplitFlapMotionMode,
): readonly SplitFlapCharacterTransition[] {
  const currentCharacters = splitFlapCharacters(targetValue, width);
  const previousCharacters = previousValue === undefined
    ? Array.from({ length: width }, () => " ")
    : splitFlapCharacters(previousValue, width);
  return Object.freeze(currentCharacters.map((character, characterIndex) =>
    splitFlapCharacterTransition(previousCharacters[characterIndex]!, character, motion)));
}

function flapCharacter(
  transition: SplitFlapCharacterTransition,
  rowIndex: number,
  characterIndex: number,
): HTMLElement {
  const segment = element("span", undefined, "flap-character");
  segment.dataset["character"] = transition.to;
  segment.classList.toggle("is-changed", transition.changed);
  if (transition.intermediate.length === 0) {
    segment.append(element("span", transition.to, "flap-character__final"));
    return segment;
  }
  const baseDelay = rowIndex * 92 + characterIndex * 14;
  const completeDelay = baseDelay + (transition.intermediate.length - 1) * 68 + 136;
  segment.style.setProperty("--flap-complete", `${completeDelay}ms`);
  segment.append(
    element("span", transition.from, "flap-character__final flap-character__final--old"),
    element("span", transition.to, "flap-character__final flap-character__final--new"),
  );
  transition.intermediate.forEach((intermediate, stepIndex) => {
    const step = element("span", undefined, "flap-character__step");
    step.style.setProperty("--flap-delay", `${baseDelay + stepIndex * 68}ms`);
    const upper = element("span", undefined, "flap-character__upper");
    const lower = element("span", undefined, "flap-character__lower");
    upper.append(element("span", stepIndex === 0 ? transition.from : transition.intermediate[stepIndex - 1]!));
    lower.append(element("span", intermediate));
    step.append(upper, lower);
    segment.append(step);
  });
  return segment;
}

function flapField(
  value: string,
  previousValue: string | undefined,
  width: number,
  className: string,
  rowIndex: number,
  motion: SplitFlapMotionMode,
): HTMLElement {
  const field = element("span", undefined, `flap-field flap-field--${className}`);
  field.setAttribute("aria-hidden", "true");
  splitFlapFieldTransitions(previousValue, value, width, motion).forEach((transition, characterIndex) => {
    field.append(flapCharacter(transition, rowIndex, characterIndex));
  });
  return field;
}

function modelRowsByKey(model: SplitFlapBoardModel | undefined): ReadonlyMap<string, SplitFlapRowModel> {
  return new Map(model?.rows.map((row) => [row.key, row]) ?? []);
}

function visualBoard(
  model: SplitFlapBoardModel,
  previous: SplitFlapBoardModel | undefined,
  motion: SplitFlapMotionMode,
): HTMLElement {
  const scroll = element("div", undefined, "split-flap-scroll");
  const table = element("table", undefined, "split-flap-board");
  table.setAttribute("aria-hidden", "true");
  const head = document.createElement("thead");
  const heading = document.createElement("tr");
  ["Zeit", "Zug", model.routeHeading, "Gleis", "Hinweis"].forEach((label) => heading.append(element("th", label)));
  head.append(heading);
  const body = document.createElement("tbody");
  const previousRows = modelRowsByKey(previous);
  for (const [rowIndex, row] of model.rows.entries()) {
    const old = previousRows.get(row.key);
    const current = document.createElement("tr");
    current.dataset["status"] = row.statusCode;
    const time = element("td");
    time.append(flapField(row.time, old?.time, FLAP_FIELD_WIDTHS.time, "time", rowIndex, motion));
    if (row.scheduledTime !== undefined) time.append(element("span", `Plan ${row.scheduledTime}`, "flap-scheduled-time"));
    const train = element("td");
    train.append(flapField(row.train, old?.train, FLAP_FIELD_WIDTHS.train, "train", rowIndex, motion));
    const route = element("td");
    route.append(flapField(row.route, old?.route, FLAP_FIELD_WIDTHS.route, "route", rowIndex, motion));
    const platform = element("td");
    platform.append(flapField(row.platform, old?.platform, FLAP_FIELD_WIDTHS.platform, "platform", rowIndex, motion));
    const status = element("td");
    status.append(flapField(row.status, old?.status, FLAP_FIELD_WIDTHS.status, "status", rowIndex, motion));
    current.append(time, train, route, platform, status);
    body.append(current);
  }
  if (model.rows.length === 0) {
    const empty = document.createElement("tr");
    const cell = element("td", "Keine aktuellen Fahrten", "split-flap-empty");
    cell.colSpan = 5;
    empty.append(cell);
    body.append(empty);
  }
  table.append(head, body);
  scroll.append(table);
  return scroll;
}

function accessibleBoard(model: SplitFlapBoardModel): HTMLElement {
  const table = element("table", undefined, "split-flap-accessible zf-sr-only");
  table.append(element("caption", `${model.title} · aktuelle Bahnhofsinformation`));
  const head = document.createElement("thead");
  const heading = document.createElement("tr");
  ["Zeit", "Planzeit", "Zug", model.routeHeading, "Gleis", "Hinweis"].forEach((label) => heading.append(element("th", label)));
  head.append(heading);
  const body = document.createElement("tbody");
  for (const row of model.rows) {
    const current = document.createElement("tr");
    [row.time, row.scheduledTime ?? row.time, row.train, row.route, row.platform, row.status]
      .forEach((value) => current.append(element("td", value)));
    body.append(current);
  }
  table.append(head, body);
  return table;
}

export interface SplitFlapRenderOptions {
  readonly previous?: SplitFlapBoardModel;
  readonly motion?: SplitFlapMotionMode;
  /** Nur echte Datenaktualisierungen, nie lokale Bewegungswahl, werden angesagt. */
  readonly announce?: boolean;
}

/**
 * Sichtbare Mechanik und assistive Tabelle sind getrennt. Nur die kompakte
 * Aktualisierungsmeldung ist eine Live-Region; Zwischenzeichen bleiben stumm.
 */
export function renderSplitFlapBoard(
  calls: readonly StationBoardCall[],
  movement: BoardMovement,
  atS: number,
  options: SplitFlapRenderOptions = {},
): HTMLElement {
  const model = splitFlapBoardModel(calls, movement, atS);
  const motion = options.motion ?? "normal";
  const section = element("section", undefined, `board-section flap-motion-${motion}`);
  section.dataset["movement"] = movement;
  const heading = element("h2", undefined, "board-heading");
  const headingText = element("span", model.title);
  appendIcon(heading, movement === "arrival" ? "station" : "platform");
  heading.append(headingText);
  section.append(heading, visualBoard(model, options.previous, motion), accessibleBoard(model));
  const announcement = (options.announce ?? true)
    ? splitFlapBoardAnnouncement(options.previous, model)
    : undefined;
  if (announcement !== undefined) {
    const live = element("p", announcement, "split-flap-live zf-sr-only");
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");
    section.append(live);
  }
  return section;
}

export function initialSplitFlapMotion(
  storage?: Pick<Storage, "getItem">,
  reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
): SplitFlapMotionMode {
  try {
    const targetStorage = storage ?? globalThis.sessionStorage;
    const stored = targetStorage?.getItem(SPLIT_FLAP_MOTION_STORAGE_KEY);
    if (stored === "normal" || stored === "reduced" || stored === "none") return stored;
  } catch {
    // Session-Speicher ist Komfort, nie Voraussetzung fuer die Live-Lage.
  }
  return reducedMotion ? "reduced" : "normal";
}

function storeSplitFlapMotion(mode: SplitFlapMotionMode): void {
  try {
    globalThis.sessionStorage?.setItem(SPLIT_FLAP_MOTION_STORAGE_KEY, mode);
  } catch {
    // Die lokale Wahl wirkt trotzdem fuer die geoeffnete Detailansicht.
  }
}

function motionControl(mode: SplitFlapMotionMode, onChange: (next: SplitFlapMotionMode) => void): HTMLElement {
  const field = element("label", undefined, "split-flap-motion-control");
  const label = element("span", "Fallblattbewegung");
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Bewegung der Fallblattanzeige");
  ([
    ["normal", "Normal"],
    ["reduced", "Reduziert · sofort"],
    ["none", "Aus · statisch"],
  ] as const).forEach(([value, text]) => {
    const option = element("option", text);
    option.value = value;
    option.selected = value === mode;
    select.append(option);
  });
  select.addEventListener("change", () => {
    const next = select.value;
    if (next !== "normal" && next !== "reduced" && next !== "none") return;
    storeSplitFlapMotion(next);
    onChange(next);
  });
  field.append(label, select, element("small", "Nur lokal in dieser Sitzung · ohne Ton"));
  return field;
}

export interface StationBoardDisplayState {
  readonly departure: SplitFlapBoardModel;
  readonly arrival: SplitFlapBoardModel;
  readonly activeMovement: BoardMovement;
}

export function stationBoardDisplayState(
  board: StationBoardV1,
  previous?: StationBoardDisplayState,
): StationBoardDisplayState {
  return Object.freeze({
    departure: splitFlapBoardModel(board.departures, "departure", board.atS),
    arrival: splitFlapBoardModel(board.arrivals, "arrival", board.atS),
    activeMovement: previous?.activeMovement ?? "departure",
  });
}

export function stationBoardDisplayStateWithMovement(
  state: StationBoardDisplayState,
  activeMovement: BoardMovement,
): StationBoardDisplayState {
  return Object.freeze({ ...state, activeMovement });
}

const previousStationBoards = new Map<string, StationBoardDisplayState>();
const STATION_BOARD_HISTORY_LIMIT = 24;

function rememberStationBoard(
  key: string,
  model: StationBoardDisplayState,
): void {
  previousStationBoards.delete(key);
  previousStationBoards.set(key, model);
  if (previousStationBoards.size <= STATION_BOARD_HISTORY_LIMIT) return;
  const oldestKey = previousStationBoards.keys().next().value as string | undefined;
  if (oldestKey !== undefined) previousStationBoards.delete(oldestKey);
}

/** Gemeinsame lokale Bewegungswahl fuer Ankunft und Abfahrt eines Bahnhofs. */
export function renderStationSplitFlapDisplays(board: StationBoardV1): HTMLElement {
  let motion = initialSplitFlapMotion();
  const root = element("section", undefined, "station-boards");
  const boardHost = element("div", undefined, "station-boards__tables");
  const historyKey = `${board.worldId}:${board.stationId}`;
  const previous = previousStationBoards.get(historyKey);
  let current = stationBoardDisplayState(board, previous);
  const showMovement = (movement: BoardMovement, persist: boolean): void => {
    current = stationBoardDisplayStateWithMovement(current, movement);
    boardHost.querySelectorAll<HTMLElement>(".board-section").forEach((section) => {
      section.hidden = section.dataset["movement"] !== current.activeMovement;
    });
    if (persist) rememberStationBoard(historyKey, current);
  };
  const renderBoards = (
    previousState: StationBoardDisplayState | undefined,
    announce: boolean,
  ): void => {
    boardHost.replaceChildren(
      renderSplitFlapBoard(board.departures, "departure", board.atS, {
        motion,
        announce: announce && current.activeMovement === "departure",
        ...(previousState === undefined ? {} : { previous: previousState.departure }),
      }),
      renderSplitFlapBoard(board.arrivals, "arrival", board.atS, {
        motion,
        announce: announce && current.activeMovement === "arrival",
        ...(previousState === undefined ? {} : { previous: previousState.arrival }),
      }),
    );
    showMovement(current.activeMovement, false);
  };
  const movementControl = element("fieldset", undefined, "split-flap-movement-control");
  movementControl.append(element("legend", "Tafelansicht", "zf-sr-only"));
  ([
    ["departure", "Abfahrt"],
    ["arrival", "Ankunft"],
  ] as const).forEach(([value, label]) => {
    const option = element("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `station-board-${board.worldId}-${board.stationId}`;
    input.value = value;
    input.checked = value === current.activeMovement;
    input.addEventListener("change", () => {
      if (input.checked) showMovement(value, true);
    });
    option.append(input, element("span", label));
    movementControl.append(option);
  });
  const control = motionControl(motion, (next) => {
    motion = next;
    renderBoards(current, false);
  });
  renderBoards(previous, true);
  rememberStationBoard(historyKey, current);
  const controls = element("div", undefined, "station-board-controls");
  controls.append(movementControl, control);
  root.append(controls, boardHost);
  return root;
}
