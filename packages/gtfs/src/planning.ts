import { createHash } from "node:crypto";

export const GTFS_PLANNING_SCHEMA = "zugfolge-gtfs-planning/v1" as const;

export type GtfsRow = Readonly<Record<string, string>>;

export interface GtfsTables {
  readonly agency: readonly GtfsRow[];
  readonly stops: readonly GtfsRow[];
  readonly routes: readonly GtfsRow[];
  readonly trips: readonly GtfsRow[];
  readonly stopTimes: readonly GtfsRow[];
  readonly calendar: readonly GtfsRow[];
  readonly calendarDates: readonly GtfsRow[];
  readonly frequencies: readonly GtfsRow[];
}

export interface GtfsPlanningSource {
  readonly sourceId: string;
  readonly feedUrl: string;
  readonly archiveSha256: string;
  readonly capturedAt: string;
  readonly timeZone: string;
  readonly sourceLicense: string;
  readonly attribution: string;
}

export interface PlanningInfrastructureNode {
  readonly id: string;
}

export interface PlanningInfrastructureEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly distanceMeters: number;
  readonly active: boolean;
  readonly bidirectional: boolean;
  readonly electrification: "none" | "ac" | "dc" | "third-rail";
}

export interface GtfsStopNodeMapping {
  readonly gtfsStopId: string;
  readonly nodeId: string;
}

export interface GtfsPatternInfrastructureMapping {
  readonly lineId: string;
  readonly routeId: string;
  readonly directionId?: string;
  readonly stopIds: readonly string[];
  readonly edgeIds: readonly string[];
}

export interface PlanningVehicleRequirements {
  readonly minimumSeats: number;
  readonly minimumMaximumSpeedKph?: number;
  readonly firstClassBasisPoints: number;
  readonly accessible: boolean;
  readonly bicyclePlaces: number;
  readonly wheelchairPlaces: number;
  readonly requiredEquipment: readonly string[];
}

export interface GtfsLinePolicy {
  readonly lineId: string;
  readonly energyWhPerTrainKm: number;
  readonly facilityMinutesPerVehicleDay: number;
  readonly minimumTurnaroundSeconds: number;
  readonly overnightBasisPoints: number;
  readonly requiredProtection: readonly string[];
  readonly requirements: PlanningVehicleRequirements;
}

export interface GtfsPlanningRules {
  readonly version: string;
  readonly maxLinesPerLot: number;
  readonly smallLotMaximumTrainKmPerDay: number;
  readonly allowedRouteTypes: readonly string[];
  readonly linePolicies: readonly GtfsLinePolicy[];
}

export interface GtfsPlanningInput {
  readonly worldId: string;
  readonly revision: number;
  readonly producedAt: number;
  readonly serviceDates: readonly string[];
  readonly source: GtfsPlanningSource;
  readonly tables: GtfsTables;
  readonly infrastructure: {
    readonly version: string;
    readonly nodes: readonly PlanningInfrastructureNode[];
    readonly edges: readonly PlanningInfrastructureEdge[];
    readonly stopMappings: readonly GtfsStopNodeMapping[];
    readonly patternMappings: readonly GtfsPatternInfrastructureMapping[];
  };
  readonly rules: GtfsPlanningRules;
}

export interface PlannedJourney {
  readonly sourceTripId: string;
  readonly serviceDate: string;
  readonly departureServiceSeconds: number;
  readonly arrivalServiceSeconds: number;
  readonly departureEpochSeconds: number;
  readonly arrivalEpochSeconds: number;
}

export interface GtfsServicePattern {
  readonly id: string;
  readonly lineId: string;
  readonly directionId: string;
  readonly sourceRouteIds: readonly string[];
  readonly stopIds: readonly string[];
  readonly stopNames: readonly string[];
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly distanceMeters: number;
  readonly journeys: readonly PlannedJourney[];
  readonly metrics: {
    readonly journeyCount: number;
    readonly totalTrainMeters: string;
    readonly totalStops: string;
    readonly totalServiceSeconds: string;
    readonly totalEnergyWh: string;
    readonly medianHeadwaySeconds: number | null;
    readonly maximumOperatingSpanSeconds: number;
    readonly peakVehicles: number;
  };
}

export interface GtfsServiceLot {
  readonly id: string;
  readonly lineIds: readonly string[];
  readonly patternIds: readonly string[];
  readonly connectingNodeIds: readonly string[];
  readonly size: number;
  readonly attractiveness: number;
  readonly smallLot: boolean;
  readonly specificationBasis: {
    readonly sampleServiceDays: number;
    readonly totalTrainMeters: string;
    readonly totalStops: string;
    readonly totalServiceSeconds: string;
    readonly totalEnergyWh: string;
    readonly peakVehicles: number;
    readonly facilityMinutesPerDay: number;
    readonly overnightUnits: number;
    readonly protectionUnits: number;
    readonly requirements: PlanningVehicleRequirements;
  };
}

export interface GtfsPlanningSnapshot {
  readonly schema: typeof GTFS_PLANNING_SCHEMA;
  readonly worldId: string;
  readonly revision: number;
  readonly producedAt: number;
  readonly source: GtfsPlanningSource;
  readonly infrastructureVersion: string;
  readonly rulesVersion: string;
  readonly serviceDates: readonly string[];
  readonly patterns: readonly GtfsServicePattern[];
  readonly lots: readonly GtfsServiceLot[];
}

export interface GtfsPlanningEnvelope {
  readonly snapshot: GtfsPlanningSnapshot;
  readonly snapshotHash: string;
}

export class GtfsPlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GtfsPlanningError";
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GtfsPlanningError(message);
}

function nonEmpty(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
}

function safeInteger(value: unknown, name: string, minimum = 0): asserts value is number {
  invariant(Number.isSafeInteger(value) && (value as number) >= minimum, `${name} ist keine sichere Ganzzahl >= ${minimum}.`);
}

function decimal(value: unknown, name: string): asserts value is string {
  invariant(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), `${name} ist keine nichtnegative Dezimalzahl.`);
}

function uniqueStrings(values: readonly string[], name: string, allowEmpty = false): void {
  invariant(allowEmpty || values.length > 0, `${name} ist leer.`);
  values.forEach((value, index) => nonEmpty(value, `${name}[${index}]`));
  invariant(new Set(values).size === values.length, `${name} enthält doppelte Werte.`);
}

/** RFC-4180-kompatibler Parser für die im statischen GTFS verwendeten CSV-Dateien. */
export function parseGtfsCsv(text: string): readonly GtfsRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  invariant(!quoted, "Nicht geschlossene CSV-Anführungszeichen.");
  if (field !== "" || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  const header = rows.shift();
  invariant(header !== undefined && header.length > 0, "GTFS-Datei besitzt keinen Header.");
  const names = header.map((value, index) => index === 0 ? value.replace(/^\uFEFF/, "") : value);
  uniqueStrings(names, "GTFS-Header");
  return rows.map((values) => Object.freeze(Object.fromEntries(names.map((name, index) => [name, values[index] ?? ""]))));
}

export function parseGtfsFiles(files: Readonly<Record<string, string>>): GtfsTables {
  const required = ["agency.txt", "stops.txt", "routes.txt", "trips.txt", "stop_times.txt"] as const;
  for (const name of required) invariant(typeof files[name] === "string", `GTFS-Datei '${name}' fehlt.`);
  const table = (name: string): readonly GtfsRow[] => typeof files[name] === "string" ? parseGtfsCsv(files[name]) : [];
  const calendar = table("calendar.txt");
  const calendarDates = table("calendar_dates.txt");
  invariant(calendar.length > 0 || calendarDates.length > 0, "GTFS enthält weder calendar.txt noch calendar_dates.txt.");
  return Object.freeze({
    agency: table("agency.txt"),
    stops: table("stops.txt"),
    routes: table("routes.txt"),
    trips: table("trips.txt"),
    stopTimes: table("stop_times.txt"),
    calendar,
    calendarDates,
    frequencies: table("frequencies.txt"),
  });
}

export function gtfsServiceSeconds(value: string): number {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(value);
  invariant(match !== null, `Ungültige GTFS-Zeit '${value}'.`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  invariant(minutes < 60 && seconds < 60, `Ungültige GTFS-Zeit '${value}'.`);
  const result = hours * 3_600 + minutes * 60 + seconds;
  safeInteger(result, `GTFS-Zeit '${value}'`);
  return result;
}

export function gtfsLocalMidnightEpochSeconds(serviceDate: string, timeZone: string): number {
  invariant(/^\d{8}$/.test(serviceDate), `Ungültiger Verkehrstag '${serviceDate}'.`);
  nonEmpty(timeZone, "timeZone");
  const desired = Date.UTC(Number(serviceDate.slice(0, 4)), Number(serviceDate.slice(4, 6)) - 1, Number(serviceDate.slice(6, 8)));
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new GtfsPlanningError(`Unbekannte GTFS-Zeitzone '${timeZone}'.`);
  }
  let candidate = desired;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts["year"]), Number(parts["month"]) - 1, Number(parts["day"]), Number(parts["hour"]), Number(parts["minute"]), Number(parts["second"]));
    candidate += desired - represented;
  }
  return Math.floor(candidate / 1_000);
}

function serviceDateObject(serviceDate: string): Date {
  return new Date(`${serviceDate.slice(0, 4)}-${serviceDate.slice(4, 6)}-${serviceDate.slice(6, 8)}T12:00:00Z`);
}

export function activeGtfsServiceIds(tables: Pick<GtfsTables, "calendar" | "calendarDates">, serviceDate: string): ReadonlySet<string> {
  invariant(/^\d{8}$/.test(serviceDate), `Ungültiger Verkehrstag '${serviceDate}'.`);
  const active = new Set<string>();
  const weekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][serviceDateObject(serviceDate).getUTCDay()]!;
  for (const row of tables.calendar) {
    if (row["start_date"]! <= serviceDate && row["end_date"]! >= serviceDate && row[weekday] === "1") active.add(row["service_id"]!);
  }
  for (const exception of tables.calendarDates) {
    if (exception["date"] !== serviceDate) continue;
    if (exception["exception_type"] === "1") active.add(exception["service_id"]!);
    if (exception["exception_type"] === "2") active.delete(exception["service_id"]!);
  }
  return active;
}

/** Sortiert Objektschlüssel rekursiv; nur JSON-Werte und sichere Ganzzahlen sind zulässig. */
export function canonicalPlanningJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPlanningJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        invariant(item !== undefined, `Kanonischer GTFS-Wert enthält undefined in '${key}'.`);
        return `${JSON.stringify(key)}:${canonicalPlanningJson(item)}`;
      })
      .join(",")}}`;
  }
  invariant(value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number", "GTFS-Plan enthält einen nicht unterstützten Wert.");
  if (typeof value === "number") safeInteger(value, "Kanonischer GTFS-Zahlenwert", Number.MIN_SAFE_INTEGER);
  return JSON.stringify(value);
}

export function planningSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function gtfsPlanningSnapshotHash(snapshot: GtfsPlanningSnapshot): string {
  return planningSha256(canonicalPlanningJson(snapshot));
}

function mappingKey(routeId: string, directionId: string, stopIds: readonly string[]): string {
  return `${routeId}\u001e${directionId}\u001e${stopIds.join("\u001f")}`;
}

function contiguousSubsequenceIndex(values: readonly string[], candidate: readonly string[]): number {
  if (candidate.length > values.length) return -1;
  for (let start = 0; start <= values.length - candidate.length; start += 1) {
    if (candidate.every((value, offset) => values[start + offset] === value)) return start;
  }
  return -1;
}

function patternId(worldId: string, lineId: string, directionId: string, nodeIds: readonly string[]): string {
  return `sp-${planningSha256(canonicalPlanningJson({ worldId, lineId, directionId, nodeIds })).slice(0, 20)}`;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function peakVehicles(journeys: readonly PlannedJourney[], turnaroundSeconds: number): number {
  const events = journeys.flatMap((journey) => [
    { at: journey.departureEpochSeconds, delta: 1 },
    { at: journey.arrivalEpochSeconds + turnaroundSeconds, delta: -1 },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let peak = 0;
  for (const event of events) {
    current += event.delta;
    peak = Math.max(peak, current);
  }
  return peak;
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  invariant(value >= 0n && divisor > 0n, "Ungültige Ganzzahldivision in der GTFS-Planung.");
  return (value + divisor - 1n) / divisor;
}

function maximumOperatingSpan(journeys: readonly PlannedJourney[]): number {
  const byDate = new Map<string, PlannedJourney[]>();
  for (const journey of journeys) {
    const values = byDate.get(journey.serviceDate) ?? [];
    values.push(journey);
    byDate.set(journey.serviceDate, values);
  }
  let maximum = 0;
  for (const values of byDate.values()) {
    maximum = Math.max(maximum, Math.max(...values.map((value) => value.arrivalServiceSeconds)) - Math.min(...values.map((value) => value.departureServiceSeconds)));
  }
  return maximum;
}

function headways(journeys: readonly PlannedJourney[]): readonly number[] {
  const byDate = new Map<string, number[]>();
  for (const journey of journeys) {
    const departures = byDate.get(journey.serviceDate) ?? [];
    departures.push(journey.departureServiceSeconds);
    byDate.set(journey.serviceDate, departures);
  }
  return [...byDate.values()].flatMap((departures) => {
    departures.sort((left, right) => left - right);
    return departures.slice(1).map((departure, index) => departure - departures[index]!).filter((difference) => difference > 0);
  });
}

interface ResolvedMapping {
  readonly mapping: GtfsPatternInfrastructureMapping;
  readonly nodeIds: readonly string[];
  readonly stopNames: readonly string[];
  readonly distanceMeters: number;
}

function resolveMappings(input: GtfsPlanningInput): ReadonlyMap<string, ResolvedMapping> {
  const nodeIds = new Set(input.infrastructure.nodes.map((node) => node.id));
  invariant(nodeIds.size === input.infrastructure.nodes.length, "Infrastruktur enthält doppelte Knoten-IDs.");
  const edges = new Map(input.infrastructure.edges.map((edge) => [edge.id, edge]));
  invariant(edges.size === input.infrastructure.edges.length, "Infrastruktur enthält doppelte Kanten-IDs.");
  const stops = new Map(input.tables.stops.map((stop) => [stop["stop_id"]!, stop]));
  const stopNodes = new Map(input.infrastructure.stopMappings.map((mapping) => [mapping.gtfsStopId, mapping.nodeId]));
  invariant(stopNodes.size === input.infrastructure.stopMappings.length, "GTFS-Haltestelle wurde mehrfach zugeordnet.");
  for (const mapping of input.infrastructure.stopMappings) {
    invariant(stops.has(mapping.gtfsStopId), `Zugeordnete GTFS-Haltestelle '${mapping.gtfsStopId}' fehlt im Feed.`);
    invariant(nodeIds.has(mapping.nodeId), `Zugeordneter Infrastrukturknoten '${mapping.nodeId}' fehlt.`);
  }

  const result = new Map<string, ResolvedMapping>();
  for (const [index, mapping] of input.infrastructure.patternMappings.entries()) {
    const name = `patternMappings[${index}]`;
    nonEmpty(mapping.lineId, `${name}.lineId`);
    nonEmpty(mapping.routeId, `${name}.routeId`);
    uniqueStrings(mapping.stopIds, `${name}.stopIds`);
    uniqueStrings(mapping.edgeIds, `${name}.edgeIds`);
    invariant(mapping.stopIds.length >= 2, `${name} braucht mindestens zwei Halte.`);
    const mappedNodes = mapping.stopIds.map((stopId) => {
      const nodeId = stopNodes.get(stopId);
      invariant(nodeId !== undefined, `${name}: GTFS-Halt '${stopId}' ist keinem Infrastrukturknoten zugeordnet.`);
      return nodeId;
    });
    let current = mappedNodes[0]!;
    const pathNodes = [current];
    let distanceMeters = 0;
    for (const edgeId of mapping.edgeIds) {
      const edge = edges.get(edgeId);
      invariant(edge !== undefined, `${name}: Infrastrukturkante '${edgeId}' fehlt.`);
      invariant(edge.active, `${name}: Infrastrukturkante '${edgeId}' ist nicht befahrbar.`);
      safeInteger(edge.distanceMeters, `${name}.${edgeId}.distanceMeters`, 1);
      let next: string;
      if (edge.fromNodeId === current) next = edge.toNodeId;
      else if (edge.bidirectional && edge.toNodeId === current) next = edge.fromNodeId;
      else throw new GtfsPlanningError(`${name}: Kante '${edgeId}' schließt nicht gerichtet an '${current}' an.`);
      invariant(nodeIds.has(next), `${name}: Kante '${edgeId}' verweist auf unbekannten Knoten '${next}'.`);
      current = next;
      pathNodes.push(current);
      distanceMeters += edge.distanceMeters;
      safeInteger(distanceMeters, `${name}.distanceMeters`, 1);
    }
    let previousIndex = -1;
    for (const nodeId of mappedNodes) {
      const indexInPath = pathNodes.indexOf(nodeId, previousIndex + 1);
      invariant(indexInPath > previousIndex, `${name}: Haltknoten '${nodeId}' liegt nicht in korrekter Reihenfolge auf dem Pfad.`);
      previousIndex = indexInPath;
    }
    invariant(previousIndex === pathNodes.length - 1, `${name}: Der Infrastrukturpfad endet nicht am letzten GTFS-Halt.`);
    const key = mappingKey(mapping.routeId, mapping.directionId ?? "", mapping.stopIds);
    invariant(!result.has(key), `${name}: dieselbe externe Linienvariante wurde doppelt zugeordnet.`);
    result.set(key, {
      mapping,
      nodeIds: Object.freeze([...mappedNodes]),
      stopNames: Object.freeze(mapping.stopIds.map((stopId) => stops.get(stopId)?.["stop_name"] ?? stopId)),
      distanceMeters,
    });
  }
  return result;
}

function expandedJourneyTimes(tripId: string, baseDeparture: number, baseArrival: number, frequencies: ReadonlyMap<string, readonly GtfsRow[]>): readonly { departure: number; arrival: number; suffix: string }[] {
  const rows = frequencies.get(tripId) ?? [];
  if (rows.length === 0) return [{ departure: baseDeparture, arrival: baseArrival, suffix: "scheduled" }];
  const result: { departure: number; arrival: number; suffix: string }[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    const start = gtfsServiceSeconds(row["start_time"]!);
    const end = gtfsServiceSeconds(row["end_time"]!);
    const headway = Number(row["headway_secs"]);
    safeInteger(headway, `frequencies[${tripId}].headway_secs`, 1);
    invariant(end > start, `frequencies[${tripId}] besitzt kein positives Fenster.`);
    for (let departure = start, instance = 0; departure < end; departure += headway, instance += 1) {
      result.push({ departure, arrival: departure + (baseArrival - baseDeparture), suffix: `frequency-${rowIndex}-${instance}` });
    }
  }
  return result;
}

function combineRequirements(requirements: readonly PlanningVehicleRequirements[]): PlanningVehicleRequirements {
  invariant(requirements.length > 0, "Los besitzt keine Fahrzeuganforderungen.");
  return Object.freeze({
    minimumSeats: Math.max(...requirements.map((value) => value.minimumSeats)),
    ...(
      requirements.some((value) => value.minimumMaximumSpeedKph !== undefined)
        ? { minimumMaximumSpeedKph: Math.max(...requirements.map((value) => value.minimumMaximumSpeedKph ?? 0)) }
        : {}
    ),
    firstClassBasisPoints: Math.max(...requirements.map((value) => value.firstClassBasisPoints)),
    accessible: requirements.some((value) => value.accessible),
    bicyclePlaces: Math.max(...requirements.map((value) => value.bicyclePlaces)),
    wheelchairPlaces: Math.max(...requirements.map((value) => value.wheelchairPlaces)),
    requiredEquipment: Object.freeze([...new Set(requirements.flatMap((value) => value.requiredEquipment))].sort()),
  });
}

interface PlannedLine {
  readonly id: string;
  readonly patternIds: readonly string[];
  readonly nodeIds: ReadonlySet<string>;
  readonly journeys: readonly PlannedJourney[];
  readonly policy: GtfsLinePolicy;
  readonly conservativeVehiclePeak: number;
  readonly totalTrainMeters: bigint;
  readonly totalStops: bigint;
  readonly totalServiceSeconds: bigint;
  readonly totalEnergyWh: bigint;
}

function connected(left: PlannedLine, right: PlannedLine): boolean {
  return [...left.nodeIds].some((nodeId) => right.nodeIds.has(nodeId));
}

function lotLineGroups(lines: readonly PlannedLine[], maximum: number): readonly (readonly PlannedLine[])[] {
  safeInteger(maximum, "maxLinesPerLot", 1);
  const remaining = new Map(lines.map((line) => [line.id, line]));
  const groups: PlannedLine[][] = [];
  while (remaining.size > 0) {
    const seed = [...remaining.values()].sort((left, right) => left.id.localeCompare(right.id))[0]!;
    remaining.delete(seed.id);
    const group = [seed];
    while (group.length < maximum) {
      const candidates = [...remaining.values()]
        .filter((candidate) => group.some((member) => connected(member, candidate)))
        .sort((left, right) => left.id.localeCompare(right.id));
      const next = candidates[0];
      if (next === undefined) break;
      remaining.delete(next.id);
      group.push(next);
    }
    groups.push(group);
  }
  return groups;
}

function validateRules(rules: GtfsPlanningRules): ReadonlyMap<string, GtfsLinePolicy> {
  nonEmpty(rules.version, "rules.version");
  safeInteger(rules.maxLinesPerLot, "rules.maxLinesPerLot", 1);
  safeInteger(rules.smallLotMaximumTrainKmPerDay, "rules.smallLotMaximumTrainKmPerDay", 1);
  uniqueStrings(rules.allowedRouteTypes, "rules.allowedRouteTypes");
  const policies = new Map<string, GtfsLinePolicy>();
  for (const [index, policy] of rules.linePolicies.entries()) {
    const name = `linePolicies[${index}]`;
    nonEmpty(policy.lineId, `${name}.lineId`);
    invariant(!policies.has(policy.lineId), `${name}: Linie '${policy.lineId}' besitzt mehrere Regeln.`);
    safeInteger(policy.energyWhPerTrainKm, `${name}.energyWhPerTrainKm`, 1);
    safeInteger(policy.facilityMinutesPerVehicleDay, `${name}.facilityMinutesPerVehicleDay`);
    safeInteger(policy.minimumTurnaroundSeconds, `${name}.minimumTurnaroundSeconds`);
    safeInteger(policy.overnightBasisPoints, `${name}.overnightBasisPoints`);
    invariant(policy.overnightBasisPoints <= 10_000, `${name}.overnightBasisPoints liegt über 10000.`);
    uniqueStrings(policy.requiredProtection, `${name}.requiredProtection`, true);
    safeInteger(policy.requirements.minimumSeats, `${name}.minimumSeats`, 1);
    if (policy.requirements.minimumMaximumSpeedKph !== undefined) safeInteger(policy.requirements.minimumMaximumSpeedKph, `${name}.minimumMaximumSpeedKph`, 1);
    safeInteger(policy.requirements.firstClassBasisPoints, `${name}.firstClassBasisPoints`);
    invariant(policy.requirements.firstClassBasisPoints <= 10_000, `${name}.firstClassBasisPoints liegt über 10000.`);
    invariant(typeof policy.requirements.accessible === "boolean", `${name}.accessible fehlt.`);
    safeInteger(policy.requirements.bicyclePlaces, `${name}.bicyclePlaces`);
    safeInteger(policy.requirements.wheelchairPlaces, `${name}.wheelchairPlaces`);
    uniqueStrings(policy.requirements.requiredEquipment, `${name}.requiredEquipment`, true);
    policies.set(policy.lineId, policy);
  }
  return policies;
}

/**
 * Normalisiert ein versionsfixiertes GTFS gegen eine explizite, befahrbare
 * Infrastrukturzuordnung und bildet daraus deterministische SPNV-Lose.
 */
export function buildGtfsPlanningSnapshot(input: GtfsPlanningInput): GtfsPlanningSnapshot {
  nonEmpty(input.worldId, "worldId");
  safeInteger(input.revision, "revision");
  safeInteger(input.producedAt, "producedAt");
  nonEmpty(input.infrastructure.version, "infrastructure.version");
  uniqueStrings(input.serviceDates, "serviceDates");
  invariant(input.serviceDates.every((date) => /^\d{8}$/.test(date)), "serviceDates enthält ein ungültiges Datum.");
  invariant([...input.serviceDates].sort().every((date, index) => date === input.serviceDates[index]), "serviceDates muss aufsteigend sortiert sein.");
  nonEmpty(input.source.sourceId, "source.sourceId");
  nonEmpty(input.source.feedUrl, "source.feedUrl");
  invariant(/^[a-f0-9]{64}$/.test(input.source.archiveSha256), "source.archiveSha256 ist kein SHA-256.");
  invariant(!Number.isNaN(Date.parse(input.source.capturedAt)), "source.capturedAt ist kein Zeitpunkt.");
  gtfsLocalMidnightEpochSeconds(input.serviceDates[0]!, input.source.timeZone);
  nonEmpty(input.source.sourceLicense, "source.sourceLicense");
  nonEmpty(input.source.attribution, "source.attribution");
  const policies = validateRules(input.rules);
  const resolvedMappings = resolveMappings(input);
  const routes = new Map(input.tables.routes.map((route) => [route["route_id"]!, route]));
  const timesByTrip = new Map<string, GtfsRow[]>();
  for (const stopTime of input.tables.stopTimes) {
    const tripId = stopTime["trip_id"]!;
    const values = timesByTrip.get(tripId) ?? [];
    values.push(stopTime);
    timesByTrip.set(tripId, values);
  }
  for (const values of timesByTrip.values()) values.sort((left, right) => Number(left["stop_sequence"]) - Number(right["stop_sequence"]));
  const frequencies = new Map<string, GtfsRow[]>();
  for (const frequency of input.tables.frequencies) {
    const tripId = frequency["trip_id"]!;
    const values = frequencies.get(tripId) ?? [];
    values.push(frequency);
    frequencies.set(tripId, values);
  }

  const accumulators = new Map<string, { resolved: ResolvedMapping; routeIds: Set<string>; journeys: PlannedJourney[] }>();
  for (const serviceDate of input.serviceDates) {
    const activeServices = activeGtfsServiceIds(input.tables, serviceDate);
    const midnight = gtfsLocalMidnightEpochSeconds(serviceDate, input.source.timeZone);
    for (const trip of input.tables.trips) {
      if (!activeServices.has(trip["service_id"]!)) continue;
      const route = routes.get(trip["route_id"]!);
      if (route === undefined || !input.rules.allowedRouteTypes.includes(route["route_type"]!)) continue;
      const stopTimes = timesByTrip.get(trip["trip_id"]!) ?? [];
      if (stopTimes.length < 2) continue;
      const stopIds = stopTimes.map((stopTime) => stopTime["stop_id"]!);
      const directionId = trip["direction_id"] ?? "";
      const matchingMappings = [...resolvedMappings.values()]
        .filter((candidate) =>
          candidate.mapping.routeId === trip["route_id"]!
          && (candidate.mapping.directionId ?? "") === directionId
          && contiguousSubsequenceIndex(stopIds, candidate.mapping.stopIds) >= 0)
        .sort((left, right) => right.mapping.stopIds.length - left.mapping.stopIds.length);
      const resolved = matchingMappings[0];
      if (resolved === undefined) continue;
      invariant(
        matchingMappings[1] === undefined || matchingMappings[1].mapping.stopIds.length !== resolved.mapping.stopIds.length,
        `GTFS-Fahrt '${trip["trip_id"]!}' passt auf mehrere gleich spezifische Infrastrukturzuordnungen.`,
      );
      const policy = policies.get(resolved.mapping.lineId);
      invariant(policy !== undefined, `Für Linie '${resolved.mapping.lineId}' fehlt eine versionierte Planungsregel.`);
      const segmentStart = contiguousSubsequenceIndex(stopIds, resolved.mapping.stopIds);
      invariant(segmentStart >= 0, "Interner Fehler bei der GTFS-Segmentzuordnung.");
      const segmentTimes = stopTimes.slice(segmentStart, segmentStart + resolved.mapping.stopIds.length);
      const tripDeparture = gtfsServiceSeconds(stopTimes[0]!["departure_time"]!);
      const tripArrival = gtfsServiceSeconds(stopTimes.at(-1)!["arrival_time"]!);
      const segmentDeparture = gtfsServiceSeconds(segmentTimes[0]!["departure_time"]!);
      const segmentArrival = gtfsServiceSeconds(segmentTimes.at(-1)!["arrival_time"]!);
      invariant(tripArrival > tripDeparture && segmentArrival > segmentDeparture, `GTFS-Fahrt '${trip["trip_id"]!}' besitzt keine positive Fahrzeit.`);
      const id = patternId(input.worldId, resolved.mapping.lineId, directionId, resolved.nodeIds);
      const accumulator = accumulators.get(id) ?? { resolved, routeIds: new Set<string>(), journeys: [] };
      invariant(accumulator.resolved.mapping.lineId === resolved.mapping.lineId && accumulator.resolved.nodeIds.join("\u001f") === resolved.nodeIds.join("\u001f"), `Stabile Pattern-ID '${id}' ist kollidiert.`);
      accumulator.routeIds.add(trip["route_id"]!);
      for (const expanded of expandedJourneyTimes(trip["trip_id"]!, tripDeparture, tripArrival, frequencies)) {
        const shift = expanded.departure - tripDeparture;
        accumulator.journeys.push(Object.freeze({
          sourceTripId: `${trip["trip_id"]!}:${expanded.suffix}`,
          serviceDate,
          departureServiceSeconds: segmentDeparture + shift,
          arrivalServiceSeconds: segmentArrival + shift,
          departureEpochSeconds: midnight + segmentDeparture + shift,
          arrivalEpochSeconds: midnight + segmentArrival + shift,
        }));
      }
      accumulators.set(id, accumulator);
    }
  }
  invariant(accumulators.size > 0, "Keine aktive GTFS-Fahrt besitzt eine vollständige Infrastrukturzuordnung.");

  const patterns: GtfsServicePattern[] = [];
  for (const [id, accumulator] of accumulators) {
    const policy = policies.get(accumulator.resolved.mapping.lineId)!;
    const journeys = accumulator.journeys.sort((left, right) => left.departureEpochSeconds - right.departureEpochSeconds || left.sourceTripId.localeCompare(right.sourceTripId));
    const totalTrainMeters = BigInt(accumulator.resolved.distanceMeters) * BigInt(journeys.length);
    const totalStops = BigInt(accumulator.resolved.mapping.stopIds.length) * BigInt(journeys.length);
    const totalServiceSeconds = journeys.reduce((sum, journey) => sum + BigInt(journey.arrivalServiceSeconds - journey.departureServiceSeconds), 0n);
    const totalEnergyWh = ceilDivide(totalTrainMeters * BigInt(policy.energyWhPerTrainKm), 1_000n);
    patterns.push(Object.freeze({
      id,
      lineId: accumulator.resolved.mapping.lineId,
      directionId: accumulator.resolved.mapping.directionId ?? "",
      sourceRouteIds: Object.freeze([...accumulator.routeIds].sort()),
      stopIds: Object.freeze([...accumulator.resolved.mapping.stopIds]),
      stopNames: accumulator.resolved.stopNames,
      nodeIds: accumulator.resolved.nodeIds,
      edgeIds: Object.freeze([...accumulator.resolved.mapping.edgeIds]),
      distanceMeters: accumulator.resolved.distanceMeters,
      journeys: Object.freeze([...journeys]),
      metrics: Object.freeze({
        journeyCount: journeys.length,
        totalTrainMeters: totalTrainMeters.toString(),
        totalStops: totalStops.toString(),
        totalServiceSeconds: totalServiceSeconds.toString(),
        totalEnergyWh: totalEnergyWh.toString(),
        medianHeadwaySeconds: median(headways(journeys)),
        maximumOperatingSpanSeconds: maximumOperatingSpan(journeys),
        peakVehicles: peakVehicles(journeys, policy.minimumTurnaroundSeconds),
      }),
    }));
  }
  patterns.sort((left, right) => left.lineId.localeCompare(right.lineId) || left.id.localeCompare(right.id));

  const linesById = new Map<string, GtfsServicePattern[]>();
  for (const pattern of patterns) {
    const values = linesById.get(pattern.lineId) ?? [];
    values.push(pattern);
    linesById.set(pattern.lineId, values);
  }
  const lines: PlannedLine[] = [...linesById].map(([lineId, linePatterns]) => {
    const policy = policies.get(lineId)!;
    const journeys = linePatterns.flatMap((pattern) => pattern.journeys);
    return {
      id: lineId,
      patternIds: Object.freeze(linePatterns.map((pattern) => pattern.id).sort()),
      nodeIds: new Set(linePatterns.flatMap((pattern) => pattern.nodeIds)),
      journeys: Object.freeze(journeys),
      policy,
      // Ohne einen belastbaren block_id-/Umlaufnachweis werden Gegenrichtungen
      // nicht zu einem vermeintlich durchgebundenen Umlauf zusammengezogen.
      conservativeVehiclePeak: linePatterns.reduce((sum, pattern) => sum + pattern.metrics.peakVehicles, 0),
      totalTrainMeters: linePatterns.reduce((sum, pattern) => sum + BigInt(pattern.metrics.totalTrainMeters), 0n),
      totalStops: linePatterns.reduce((sum, pattern) => sum + BigInt(pattern.metrics.totalStops), 0n),
      totalServiceSeconds: linePatterns.reduce((sum, pattern) => sum + BigInt(pattern.metrics.totalServiceSeconds), 0n),
      totalEnergyWh: linePatterns.reduce((sum, pattern) => sum + BigInt(pattern.metrics.totalEnergyWh), 0n),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const lots: GtfsServiceLot[] = lotLineGroups(lines, input.rules.maxLinesPerLot).map((group) => {
    invariant(group.length === 1 || group.slice(1).every((line, index) => group.slice(0, index + 1).some((member) => connected(member, line))), "Losgenerator hat unverbundene Linien gebündelt.");
    const lineIds = group.map((line) => line.id).sort();
    const patternIds = group.flatMap((line) => line.patternIds).sort();
    const nodeCounts = new Map<string, number>();
    for (const line of group) for (const nodeId of line.nodeIds) nodeCounts.set(nodeId, (nodeCounts.get(nodeId) ?? 0) + 1);
    const connectingNodeIds = [...nodeCounts].filter(([, count]) => count > 1).map(([nodeId]) => nodeId).sort();
    const totalTrainMeters = group.reduce((sum, line) => sum + line.totalTrainMeters, 0n);
    const totalStops = group.reduce((sum, line) => sum + line.totalStops, 0n);
    const totalServiceSeconds = group.reduce((sum, line) => sum + line.totalServiceSeconds, 0n);
    const totalEnergyWh = group.reduce((sum, line) => sum + line.totalEnergyWh, 0n);
    const allJourneys = group.flatMap((line) => line.journeys);
    // Ohne verlässliche GTFS-block_id darf der Planer weder zwischen Linien
    // noch zwischen Gegenrichtungen einen Fahrzeugübergang erfinden.
    const peak = group.reduce((sum, line) => sum + line.conservativeVehiclePeak, 0);
    const averageTrainKmPerDay = Number(ceilDivide(totalTrainMeters, BigInt(input.serviceDates.length) * 1_000n));
    safeInteger(averageTrainKmPerDay, "Losgröße");
    const averageJourneysPerDay = Math.ceil(allJourneys.length / input.serviceDates.length);
    const uniqueStops = new Set(group.flatMap((line) => [...line.nodeIds])).size;
    const attractiveness = averageJourneysPerDay * 100 + uniqueStops * 10;
    safeInteger(attractiveness, "Losattraktivität");
    const facilityMinutesPerDay = group.reduce((sum, line) => sum + line.conservativeVehiclePeak * line.policy.facilityMinutesPerVehicleDay, 0);
    const overnightUnits = group.reduce((sum, line) => sum + Number(ceilDivide(BigInt(line.conservativeVehiclePeak * line.policy.overnightBasisPoints), 10_000n)), 0);
    const protectionUnits = group.reduce((sum, line) => sum + (line.policy.requiredProtection.length > 0 ? line.conservativeVehiclePeak : 0), 0);
    const id = `lot-${planningSha256(canonicalPlanningJson({ worldId: input.worldId, lineIds })).slice(0, 20)}`;
    return Object.freeze({
      id,
      lineIds: Object.freeze(lineIds),
      patternIds: Object.freeze(patternIds),
      connectingNodeIds: Object.freeze(connectingNodeIds),
      size: averageTrainKmPerDay,
      attractiveness,
      smallLot: averageTrainKmPerDay <= input.rules.smallLotMaximumTrainKmPerDay,
      specificationBasis: Object.freeze({
        sampleServiceDays: input.serviceDates.length,
        totalTrainMeters: totalTrainMeters.toString(),
        totalStops: totalStops.toString(),
        totalServiceSeconds: totalServiceSeconds.toString(),
        totalEnergyWh: totalEnergyWh.toString(),
        peakVehicles: peak,
        facilityMinutesPerDay,
        overnightUnits,
        protectionUnits,
        requirements: combineRequirements(group.map((line) => line.policy.requirements)),
      }),
    });
  }).sort((left, right) => left.id.localeCompare(right.id));

  const snapshot: GtfsPlanningSnapshot = Object.freeze({
    schema: GTFS_PLANNING_SCHEMA,
    worldId: input.worldId,
    revision: input.revision,
    producedAt: input.producedAt,
    source: Object.freeze({ ...input.source }),
    infrastructureVersion: input.infrastructure.version,
    rulesVersion: input.rules.version,
    serviceDates: Object.freeze([...input.serviceDates]),
    patterns: Object.freeze(patterns),
    lots: Object.freeze(lots),
  });
  return validateGtfsPlanningSnapshot(snapshot);
}

export function validateGtfsPlanningSnapshot(snapshot: GtfsPlanningSnapshot): GtfsPlanningSnapshot {
  invariant(snapshot.schema === GTFS_PLANNING_SCHEMA, "Unbekanntes GTFS-Planungsschema.");
  nonEmpty(snapshot.worldId, "worldId");
  safeInteger(snapshot.revision, "revision");
  safeInteger(snapshot.producedAt, "producedAt");
  invariant(/^[a-f0-9]{64}$/.test(snapshot.source.archiveSha256), "Feed-Hash ist kein SHA-256.");
  uniqueStrings(snapshot.serviceDates, "serviceDates");
  invariant(snapshot.patterns.length > 0, "GTFS-Planung besitzt keine Service-Patterns.");
  invariant(snapshot.lots.length > 0, "GTFS-Planung besitzt keine Lose.");
  uniqueStrings(snapshot.patterns.map((pattern) => pattern.id), "patterns[].id");
  uniqueStrings(snapshot.lots.map((lot) => lot.id), "lots[].id");
  const patternIds = new Set(snapshot.patterns.map((pattern) => pattern.id));
  for (const [index, pattern] of snapshot.patterns.entries()) {
    const name = `patterns[${index}]`;
    nonEmpty(pattern.lineId, `${name}.lineId`);
    uniqueStrings(pattern.stopIds, `${name}.stopIds`);
    uniqueStrings(pattern.nodeIds, `${name}.nodeIds`);
    uniqueStrings(pattern.edgeIds, `${name}.edgeIds`);
    safeInteger(pattern.distanceMeters, `${name}.distanceMeters`, 1);
    safeInteger(pattern.metrics.journeyCount, `${name}.journeyCount`, 1);
    decimal(pattern.metrics.totalTrainMeters, `${name}.totalTrainMeters`);
    decimal(pattern.metrics.totalStops, `${name}.totalStops`);
    decimal(pattern.metrics.totalServiceSeconds, `${name}.totalServiceSeconds`);
    decimal(pattern.metrics.totalEnergyWh, `${name}.totalEnergyWh`);
    invariant(pattern.journeys.length === pattern.metrics.journeyCount, `${name}.journeyCount stimmt nicht.`);
  }
  const assignedPatterns = new Set<string>();
  for (const [index, lot] of snapshot.lots.entries()) {
    const name = `lots[${index}]`;
    uniqueStrings(lot.lineIds, `${name}.lineIds`);
    uniqueStrings(lot.patternIds, `${name}.patternIds`);
    invariant(lot.patternIds.every((id) => patternIds.has(id)), `${name} verweist auf unbekanntes Pattern.`);
    invariant(lot.patternIds.every((id) => !assignedPatterns.has(id)), `${name} enthält ein bereits vergebenes Pattern.`);
    lot.patternIds.forEach((id) => assignedPatterns.add(id));
    safeInteger(lot.size, `${name}.size`);
    safeInteger(lot.attractiveness, `${name}.attractiveness`);
    invariant(typeof lot.smallLot === "boolean", `${name}.smallLot fehlt.`);
    safeInteger(lot.specificationBasis.sampleServiceDays, `${name}.sampleServiceDays`, 1);
    decimal(lot.specificationBasis.totalTrainMeters, `${name}.totalTrainMeters`);
    decimal(lot.specificationBasis.totalStops, `${name}.totalStops`);
    decimal(lot.specificationBasis.totalServiceSeconds, `${name}.totalServiceSeconds`);
    decimal(lot.specificationBasis.totalEnergyWh, `${name}.totalEnergyWh`);
    safeInteger(lot.specificationBasis.peakVehicles, `${name}.peakVehicles`, 1);
  }
  invariant(assignedPatterns.size === patternIds.size, "Nicht jedes Service-Pattern ist genau einem Los zugeordnet.");
  canonicalPlanningJson(snapshot);
  return snapshot;
}

export function createGtfsPlanningEnvelope(snapshot: GtfsPlanningSnapshot): GtfsPlanningEnvelope {
  validateGtfsPlanningSnapshot(snapshot);
  return Object.freeze({ snapshot, snapshotHash: gtfsPlanningSnapshotHash(snapshot) });
}

export function validateGtfsPlanningEnvelope(envelope: GtfsPlanningEnvelope): GtfsPlanningEnvelope {
  validateGtfsPlanningSnapshot(envelope.snapshot);
  invariant(/^[a-f0-9]{64}$/.test(envelope.snapshotHash), "GTFS-Planungshash ist kein SHA-256.");
  invariant(envelope.snapshotHash === gtfsPlanningSnapshotHash(envelope.snapshot), "GTFS-Planungshash gehört nicht zum Snapshot.");
  return envelope;
}
