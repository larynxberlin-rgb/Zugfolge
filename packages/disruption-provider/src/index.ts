import { createHash } from "node:crypto";

// zugfolge:quelle=strecken-info-public

export const PROVIDER_SET_ID = "public-infrastructure-restrictions/de-v1" as const;
export const PROVIDER_SNAPSHOT_SCHEMA = "zugfolge-provider-snapshot/v1" as const;
export const PROVIDER_REFRESH_INTERVAL_MS = 30 * 60 * 1_000;
export const PROVIDER_STALE_AFTER_MS = 2 * PROVIDER_REFRESH_INTERVAL_MS;
export const PROVIDER_VISIBLE_HORIZON_HOURS = 360;
export const PROVIDER_VISIBLE_HORIZON_MS = PROVIDER_VISIBLE_HORIZON_HOURS * 60 * 60 * 1_000;
export const DEFAULT_PROVIDER_ORIGIN = "https://strecken-info.de";

const REGIONS = ["MITTE", "NORD", "OST", "SUED", "SUEDOST", "SUEDWEST", "WEST"] as const;
const WEEKDAYS = ["SONNTAG", "MONTAG", "DIENSTAG", "MITTWOCH", "DONNERSTAG", "FREITAG", "SAMSTAG"] as const;

export type DisruptionEffect =
  | "closure"
  | "single-track"
  | "speed-restriction"
  | "traffic-hold"
  | "route-deviation"
  | "vehicle-restriction";

export interface ScheduleRule {
  readonly fromDate: string;
  readonly untilDate: string;
  readonly weekdays: readonly string[];
  readonly startsAtLocal: string;
  readonly endsAtLocal: string;
}

export interface RestrictionLocation {
  readonly routeNumbers: readonly number[];
  readonly operatingPointCodes: readonly string[];
  readonly operatingPointNames: readonly string[];
  readonly coordinateMillimetres: readonly Readonly<{ x: number; y: number }>[];
}

export interface NormalizedRestriction {
  readonly id: string;
  readonly kind: "planned" | "unplanned";
  readonly effect: DisruptionEffect;
  readonly causeCode: number;
  readonly fineCauseId: string;
  readonly sourceRecordId: string;
  readonly location: RestrictionLocation;
  readonly schedule: readonly ScheduleRule[];
  readonly continuousInterval?: Readonly<{ startsAtMs: number; endsAtMs: number }>;
}

export interface DiscardedProviderRecord {
  readonly sourceRecordId: string;
  readonly reason: "effectless" | "invalid" | "unmapped-cause";
}

export interface ProviderSnapshot {
  readonly schemaVersion: typeof PROVIDER_SNAPSHOT_SCHEMA;
  readonly providerSetId: typeof PROVIDER_SET_ID;
  readonly fetchedAt: string;
  readonly revision: number;
  readonly sourceVersion: string;
  readonly sourceDataTimestamps: Readonly<{ planned: string; unplanned: string }>;
  readonly snapshotHash: string;
  readonly raw: Readonly<{
    handshake: unknown;
    plannedWorks: unknown;
    operationalIncidents: unknown;
    scheduledTrafficPauses: unknown;
  }>;
  readonly restrictions: readonly NormalizedRestriction[];
  readonly discarded: readonly DiscardedProviderRecord[];
}

export interface MaterializedRestriction extends Omit<NormalizedRestriction, "schedule" | "continuousInterval"> {
  readonly startsAtMs: number;
  readonly endsAtMs: number;
}

export interface ProviderRevision {
  readonly revision: number;
  readonly sourceVersion: string;
  readonly plannedDataTimestamp: string;
  readonly unplannedDataTimestamp: string;
  readonly raw: unknown;
}

export interface ProviderClientOptions {
  readonly origin?: string;
  readonly fetch?: typeof fetch;
  readonly readRevision?: () => Promise<ProviderRevision>;
  readonly timeoutMs?: number;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} ist kein Objekt.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} fehlt.`);
  return value;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function integerList(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => Number.isSafeInteger(item) && item >= 0)
    : [];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const input = value as Record<string, unknown>;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(kind: string, sourceRecordId: string): string {
  return `restriction-${sha256(`${kind}\u0000${sourceRecordId}`).slice(0, 24)}`;
}

function mappedEffect(value: string): DisruptionEffect | undefined {
  switch (value) {
    case "TOTALSPERRUNG":
    case "AUSFALL":
      return "closure";
    case "GGL_MIT_ZS_6":
    case "GGL_MIT_ZS_8":
      return "single-track";
    case "FAHRZEITVERLAENGERUNG":
      return "traffic-hold";
    case "UMLEITUNG":
    case "ABWEICHUNG_VOM_FPL":
    case "UMLEITUNG_UNTER_ERLEICHTERTEN_BEDINGUNGEN":
    case "TEILAUSFALL":
      return "route-deviation";
    case "ZURUECKHALTEN_VON_ZUEGEN":
      return "traffic-hold";
    default:
      return undefined;
  }
}

function strongestEffect(values: readonly string[]): DisruptionEffect | undefined {
  const effects = values.map(mappedEffect).filter((item): item is DisruptionEffect => item !== undefined);
  const order: readonly DisruptionEffect[] = ["closure", "single-track", "route-deviation", "traffic-hold", "speed-restriction", "vehicle-restriction"];
  return order.find((candidate) => effects.includes(candidate));
}

interface CauseMapping { readonly causeCode: number; readonly fineCauseId: string }

function incidentCause(value: string): CauseMapping | undefined {
  const key = value.toLocaleLowerCase("de-DE");
  const mappings: readonly [readonly string[], CauseMapping][] = [
    [["gleislage"], { causeCode: 23, fineCauseId: "track.geometry" }],
    [["weichen"], { causeCode: 26, fineCauseId: "switch.drive" }],
    [["brücken", "bruecken"], { causeCode: 22, fineCauseId: "structure.bridge" }],
    [["rotausleuchtung", "gleisfreimeld"], { causeCode: 25, fineCauseId: "signalling.track-occupation" }],
    [["stellwerk"], { causeCode: 25, fineCauseId: "signalling.interlocking" }],
    [["signal"], { causeCode: 25, fineCauseId: "signalling.signal" }],
    [["unfall am bahnübergang", "unfall am bahnuebergang"], { causeCode: 90, fineCauseId: "dangerous-event.level-crossing" }],
    [["bü ", "bahnübergang", "bahnuebergang"], { causeCode: 24, fineCauseId: "level-crossing.drive" }],
    [["dammrutsch", "hangrutsch"], { causeCode: 23, fineCauseId: "track.slope" }],
    [["hindernis"], { causeCode: 85, fineCauseId: "third-party.object-track" }],
    [["entgleis"], { causeCode: 90, fineCauseId: "dangerous-event.derailment" }],
    [["haltbegriff"], { causeCode: 90, fineCauseId: "dangerous-event.signal-passed" }],
    [["böschungsbrand", "boeschungsbrand", "brand"], { causeCode: 85, fineCauseId: "third-party.fire" }],
    [["oberleitung"], { causeCode: 20, fineCauseId: "traction-power.overhead-line" }],
    [["unregelmäßigkeiten bau", "unregelmaessigkeiten bau"], { causeCode: 32, fineCauseId: "construction.overrun" }],
    [["fahrzeugstörung", "fahrzeugstoerung"], { causeCode: 64, fineCauseId: "traction-unit.control-system" }],
    [["nachbarinfrastruktur"], { causeCode: 41, fineCauseId: "previous-infrastructure.diversion" }],
    [["unterbesetzung", "nichtbesetzung"], { causeCode: 18, fineCauseId: "operations-staff.unavailable" }],
    [["störung am fahrweg", "stoerung am fahrweg"], { causeCode: 23, fineCauseId: "track.superstructure" }],
    [["störung an signalanlagen", "stoerung an signalanlagen"], { causeCode: 25, fineCauseId: "signalling.signal" }],
    [["gefährliches ereignis", "gefaehrliches ereignis"], { causeCode: 90, fineCauseId: "dangerous-event.infrastructure-safety" }],
  ];
  return mappings.find(([needles]) => needles.some((needle) => key.includes(needle)))?.[1];
}

function coordinates(value: unknown): Readonly<{ x: number; y: number }>[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const result: { x: number; y: number }[] = [];
  for (const item of values) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const point = item as Record<string, unknown>;
    if (typeof point["x"] === "number" && Number.isFinite(point["x"]) && typeof point["y"] === "number" && Number.isFinite(point["y"])) {
      result.push({ x: Math.round(point["x"] * 1_000), y: Math.round(point["y"] * 1_000) });
    }
  }
  return result;
}

function locationFromPlanned(row: Record<string, unknown>): RestrictionLocation {
  const coordinatePair = row["koordinaten"];
  const points = coordinatePair && typeof coordinatePair === "object" && !Array.isArray(coordinatePair)
    ? coordinates(Object.values(coordinatePair as Record<string, unknown>))
    : [];
  return {
    routeNumbers: integerList(row["streckennummern"]),
    operatingPointCodes: [optionalText(row["ril100Von"]), optionalText(row["ril100Bis"])].map((item) => item.trim()).filter(Boolean),
    operatingPointNames: [optionalText(row["langnameVon"]), optionalText(row["langnameBis"])].map((item) => item.trim()).filter(Boolean),
    coordinateMillimetres: points,
  };
}

function locationFromIncident(row: Record<string, unknown>): RestrictionLocation {
  const operatingPointCodes: string[] = [];
  const operatingPointNames: string[] = [];
  const routeNumbers: number[] = [];
  if (Array.isArray(row["betriebsstellen"])) for (const value of row["betriebsstellen"]) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const code = optionalText((value as Record<string, unknown>)["ril100"]).trim();
      if (code) operatingPointCodes.push(code);
      const name = optionalText((value as Record<string, unknown>)["langname"]).trim();
      if (name) operatingPointNames.push(name);
    }
  }
  if (Array.isArray(row["abschnitte"])) for (const value of row["abschnitte"]) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const section = value as Record<string, unknown>;
    if (Number.isSafeInteger(section["streckennummer"])) routeNumbers.push(section["streckennummer"] as number);
    for (const endpoint of [section["von"], section["bis"]]) {
      if (typeof endpoint === "object" && endpoint !== null && !Array.isArray(endpoint)) {
        const code = optionalText((endpoint as Record<string, unknown>)["ril100"]).trim();
        if (code) operatingPointCodes.push(code);
        const name = optionalText((endpoint as Record<string, unknown>)["langname"]).trim();
        if (name) operatingPointNames.push(name);
      }
    }
  }
  return {
    routeNumbers: [...new Set(routeNumbers)].sort((a, b) => a - b),
    operatingPointCodes: [...new Set(operatingPointCodes)].sort(),
    operatingPointNames: [...new Set(operatingPointNames)].sort(),
    coordinateMillimetres: coordinates(row["koordinaten"]),
  };
}

function scheduleRules(value: unknown): ScheduleRule[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const rule = record(item, `gueltigkeiten[${index}]`);
    const fromDate = text(rule["vonDatum"], `gueltigkeiten[${index}].vonDatum`);
    const untilDate = text(rule["bisDatum"], `gueltigkeiten[${index}].bisDatum`);
    const startsAtLocal = text(rule["vonUhrzeit"], `gueltigkeiten[${index}].vonUhrzeit`);
    const endsAtLocal = text(rule["bisUhrzeit"], `gueltigkeiten[${index}].bisUhrzeit`);
    const weekdays = stringList(rule["wochentage"]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(untilDate) || !/^\d{2}:\d{2}:\d{2}$/.test(startsAtLocal) || !/^\d{2}:\d{2}:\d{2}$/.test(endsAtLocal) || weekdays.some((day) => !WEEKDAYS.includes(day as typeof WEEKDAYS[number]))) {
      throw new TypeError(`gueltigkeiten[${index}] ist ungueltig.`);
    }
    return { fromDate, untilDate, weekdays, startsAtLocal, endsAtLocal };
  });
}

function parseBerlinLocal(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value);
  if (match === null) throw new TypeError(`Lokaler Zeitpunkt '${value}' ist ungueltig.`);
  return berlinPartsToEpochMs(...match.slice(1).map(Number) as [number, number, number, number, number, number]);
}

function lastSunday(year: number, month: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return lastDay - new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
}

function berlinPartsToEpochMs(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) throw new TypeError("Lokaler Zeitpunkt ist ausserhalb der Grenzen.");
  let offsetHours = 1;
  if (month > 3 && month < 10) offsetHours = 2;
  if (month === 3) {
    const transition = lastSunday(year, 3);
    if (day > transition || (day === transition && hour >= 3)) offsetHours = 2;
    if (day === transition && hour === 2) throw new TypeError("Lokaler Zeitpunkt liegt in der Sommerzeitluecke.");
  }
  if (month === 10) {
    const transition = lastSunday(year, 10);
    if (day < transition || (day === transition && hour < 3)) offsetHours = 2;
  }
  const epoch = Date.UTC(year, month - 1, day, hour - offsetHours, minute, second);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new TypeError("Lokales Datum ist ungueltig.");
  return epoch;
}

function continuousInterval(value: unknown): Readonly<{ startsAtMs: number; endsAtMs: number }> {
  const interval = record(value, "zeitraum");
  const startsAtMs = parseBerlinLocal(text(interval["beginn"], "zeitraum.beginn"));
  const endsAtMs = parseBerlinLocal(text(interval["ende"], "zeitraum.ende"));
  if (startsAtMs >= endsAtMs) throw new TypeError("zeitraum endet nicht nach dem Beginn.");
  return { startsAtMs, endsAtMs };
}

function normalizePlanned(value: unknown, discarded: DiscardedProviderRecord[]): NormalizedRestriction | undefined {
  const row = record(value, "Baustelle");
  const sourceRecordId = text(row["baustellenID"], "baustellenID");
  const effect = mappedEffect(optionalText(row["wirkung"]));
  if (effect === undefined) {
    discarded.push({ sourceRecordId, reason: "effectless" });
    return undefined;
  }
  const fineCauseId = effect === "route-deviation" ? "construction.diversion" : effect === "traffic-hold" ? "construction.work-zone" : "construction.temporary-speed";
  return {
    id: stableId("planned", sourceRecordId), kind: "planned", effect, causeCode: 31, fineCauseId,
    sourceRecordId, location: locationFromPlanned(row), schedule: scheduleRules(row["gueltigkeiten"]),
  };
}

function normalizeIncident(value: unknown, discarded: DiscardedProviderRecord[]): NormalizedRestriction | undefined {
  const row = record(value, "Stoerung");
  const sourceRecordId = text(row["key"], "key");
  const effects = Array.isArray(row["wirkungenMitVerkehrsarten"])
    ? row["wirkungenMitVerkehrsarten"].map((item) => optionalText(record(item, "wirkung")["wirkung"]))
    : [];
  const effect = strongestEffect(effects);
  if (effect === undefined) {
    discarded.push({ sourceRecordId, reason: "effectless" });
    return undefined;
  }
  const cause = incidentCause([optionalText(row["subcause"]), optionalText(row["cause"]), optionalText(row["text"])].join(" "));
  if (cause === undefined) {
    discarded.push({ sourceRecordId, reason: "unmapped-cause" });
    return undefined;
  }
  return {
    id: stableId("unplanned", sourceRecordId), kind: "unplanned", effect, ...cause,
    sourceRecordId, location: locationFromIncident(row), schedule: [], continuousInterval: continuousInterval(row["zeitraum"]),
  };
}

function normalizePause(value: unknown, discarded: DiscardedProviderRecord[]): NormalizedRestriction | undefined {
  const row = record(value, "Streckenruhe");
  const sourceRecordId = text(row["streckenruhenId"], "streckenruhenId");
  const code = text(row["ril100"], "ril100").trim();
  const rules = scheduleRules(row["gueltigkeiten"]);
  if (rules.length === 0) {
    discarded.push({ sourceRecordId, reason: "invalid" });
    return undefined;
  }
  return {
    id: stableId("planned-pause", sourceRecordId), kind: "planned", effect: "traffic-hold",
    causeCode: 31, fineCauseId: "construction.replacement-service-wait", sourceRecordId,
    location: {
      routeNumbers: [],
      operatingPointCodes: [code],
      operatingPointNames: [optionalText(row["bstLangname"]).trim()].filter(Boolean),
      coordinateMillimetres: coordinates(row["koordinaten"]),
    },
    schedule: rules,
  };
}

export function normalizeProviderPayload(raw: ProviderSnapshot["raw"]): Pick<ProviderSnapshot, "restrictions" | "discarded"> {
  const discarded: DiscardedProviderRecord[] = [];
  const planned = Array.isArray(raw.plannedWorks) ? raw.plannedWorks : (() => { throw new TypeError("Baustellenantwort ist keine Liste."); })();
  const incidents = Array.isArray(raw.operationalIncidents) ? raw.operationalIncidents : (() => { throw new TypeError("Stoerungsantwort ist keine Liste."); })();
  const pauses = Array.isArray(raw.scheduledTrafficPauses) ? raw.scheduledTrafficPauses : (() => { throw new TypeError("Streckenruhenantwort ist keine Liste."); })();
  const restrictions = [
    ...planned.map((item) => normalizePlanned(item, discarded)),
    ...incidents.map((item) => normalizeIncident(item, discarded)),
    ...pauses.map((item) => normalizePause(item, discarded)),
  ].filter((item): item is NormalizedRestriction => item !== undefined).sort((a, b) => a.id.localeCompare(b.id));
  discarded.sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId));
  return { restrictions, discarded };
}

function parseDate(value: string): readonly [number, number, number] {
  const parts = value.split("-").map(Number);
  if (parts.length !== 3) throw new TypeError(`Datum '${value}' ist ungueltig.`);
  return parts as unknown as readonly [number, number, number];
}

function parseTime(value: string): readonly [number, number, number] {
  const parts = value.split(":").map(Number);
  if (parts.length !== 3) throw new TypeError(`Uhrzeit '${value}' ist ungueltig.`);
  return parts as unknown as readonly [number, number, number];
}

export function materializeRestrictions(snapshot: Pick<ProviderSnapshot, "restrictions">, fromMs: number, untilMs: number): MaterializedRestriction[] {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(untilMs) || fromMs >= untilMs) throw new RangeError("Materialisierungsfenster ist ungueltig.");
  const result: MaterializedRestriction[] = [];
  for (const restriction of snapshot.restrictions) {
    if (restriction.continuousInterval !== undefined) {
      const { startsAtMs, endsAtMs } = restriction.continuousInterval;
      if (startsAtMs < untilMs && endsAtMs > fromMs) result.push(materialized(restriction, `${restriction.id}-${startsAtMs}`, startsAtMs, endsAtMs));
    }
    for (const rule of restriction.schedule) {
      const [year, month, day] = parseDate(rule.fromDate);
      const [untilYear, untilMonth, untilDay] = parseDate(rule.untilDate);
      let cursor = Date.UTC(year, month - 1, day);
      const last = Date.UTC(untilYear, untilMonth - 1, untilDay);
      while (cursor <= last) {
        const date = new Date(cursor);
        if (rule.weekdays.includes(WEEKDAYS[date.getUTCDay()]!)) {
          const [startHour, startMinute, startSecond] = parseTime(rule.startsAtLocal);
          const [endHour, endMinute, endSecond] = parseTime(rule.endsAtLocal);
          const starts = berlinPartsToEpochMs(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), startHour, startMinute, startSecond);
          let ends = berlinPartsToEpochMs(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), endHour, endMinute, endSecond);
          if (ends <= starts) {
            const next = new Date(cursor + 86_400_000);
            ends = berlinPartsToEpochMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), endHour, endMinute, endSecond);
          }
          if (starts < untilMs && ends > fromMs) result.push(materialized(restriction, `${restriction.id}-${starts}`, starts, ends));
        }
        cursor += 86_400_000;
      }
    }
  }
  return result.sort((a, b) => a.startsAtMs - b.startsAtMs || a.id.localeCompare(b.id));
}

function materialized(restriction: NormalizedRestriction, id: string, startsAtMs: number, endsAtMs: number): MaterializedRestriction {
  return {
    id,
    kind: restriction.kind,
    effect: restriction.effect,
    causeCode: restriction.causeCode,
    fineCauseId: restriction.fineCauseId,
    sourceRecordId: restriction.sourceRecordId,
    location: restriction.location,
    startsAtMs,
    endsAtMs,
  };
}

async function defaultRevisionReader(origin: string, timeoutMs: number): Promise<ProviderRevision> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^http/, "ws")}/api/websocket`);
    const timer = setTimeout(() => { socket.close(); reject(new Error("Provider-Handshake hat das Zeitlimit ueberschritten.")); }, timeoutMs);
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "HANDSHAKE", revision: null })));
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Provider-Handshake fehlgeschlagen.")); });
    socket.addEventListener("message", (event) => {
      try {
        const raw: unknown = JSON.parse(String(event.data));
        const message = record(raw, "Handshake");
        if (message["type"] !== "HANDSHAKE" || !Number.isSafeInteger(message["revision"]) || (message["revision"] as number) < 1) throw new TypeError("Provider-Handshake besitzt keine gueltige Revision.");
        const config = record(message["config"], "Handshake.config");
        clearTimeout(timer); socket.close();
        resolve({ revision: message["revision"] as number, sourceVersion: text(config["version"], "config.version"), plannedDataTimestamp: text(message["baustellenDatenstand"], "baustellenDatenstand"), unplannedDataTimestamp: text(message["stoerungenDatenstand"], "stoerungenDatenstand"), raw });
      } catch (error) { clearTimeout(timer); socket.close(); reject(error); }
    });
  });
}

export class PublicInfrastructureRestrictionsClient {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #readRevision: () => Promise<ProviderRevision>;
  readonly #timeoutMs: number;

  constructor(options: ProviderClientOptions = {}) {
    this.#origin = (options.origin ?? DEFAULT_PROVIDER_ORIGIN).replace(/\/$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#readRevision = options.readRevision ?? (() => defaultRevisionReader(this.#origin, this.#timeoutMs));
  }

  async #post(path: string, revision: number): Promise<unknown> {
    const response = await this.#fetch(`${this.#origin}/api/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "JavaScript" },
      body: JSON.stringify({ revision, filter: { baustellenAktiv: true, baustellenNurTotalsperrung: false, streckenruhenAktiv: true, stoerungenAktiv: true, wirkungsdauer: 0, zeitraum: { type: "ROLLIEREND", stunden: PROVIDER_VISIBLE_HORIZON_HOURS }, regionalbereiche: REGIONS, streckennummern: [], betriebsstellen: [] } }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`Provider '${path}' antwortete mit HTTP ${response.status}.`);
    return response.json() as Promise<unknown>;
  }

  async fetchSnapshot(fetchedAt: Date): Promise<ProviderSnapshot> {
    if (Number.isNaN(fetchedAt.getTime())) throw new RangeError("Abrufzeitpunkt ist ungueltig.");
    const revision = await this.#readRevision();
    const [plannedWorks, operationalIncidents, scheduledTrafficPauses] = await Promise.all([
      this.#post("baustellen", revision.revision), this.#post("stoerungen", revision.revision), this.#post("streckenruhen", revision.revision),
    ]);
    const raw = { handshake: revision.raw, plannedWorks, operationalIncidents, scheduledTrafficPauses } as const;
    const normalized = normalizeProviderPayload(raw);
    const hashInput = { revision: revision.revision, sourceVersion: revision.sourceVersion, raw };
    return {
      schemaVersion: PROVIDER_SNAPSHOT_SCHEMA, providerSetId: PROVIDER_SET_ID, fetchedAt: fetchedAt.toISOString(), revision: revision.revision,
      sourceVersion: revision.sourceVersion,
      sourceDataTimestamps: { planned: revision.plannedDataTimestamp, unplanned: revision.unplannedDataTimestamp },
      snapshotHash: sha256(canonicalJson(hashInput)), raw, ...normalized,
    };
  }
}
