import { GTFS_JOURNEY_CHAIN_SCHEMA, type JourneyChain, type JourneyChainTripInput } from "./journey-chain.js";
import { canonicalPlanningJson, GtfsPlanningError, planningSha256 } from "./planning.js";

const MAXIMUM_JOURNEYS_PER_LINE = 100_000;

/** Versionierte Angebotsregel; GTFS liefert Referenzwerte, keine Spielzug-IDs. */
export interface GameTimetableSpecification {
  readonly schemaVersion?: "zugfolge-game-timetable-generation/v1";
  readonly version: string;
  readonly departureGridSeconds: number;
  readonly minimumRunningSeconds: number;
  readonly requireEligibleTerminals?: boolean;
}

export interface GameTimetableTripInput extends JourneyChainTripInput {
  readonly frequencies?: readonly { readonly startS: number; readonly endS: number; readonly headwayS: number }[];
  readonly stops: readonly (JourneyChainTripInput["stops"][number] & {
    /** Releasegebundene Betriebsstelle; ohne Bindung ist die regionale Station die Referenz. */
    readonly nodeId?: string;
    /** Expliziter Infrastrukturbeleg für den gesamten Weg zum nächsten Halt. */
    readonly pathToNextInRegion?: boolean;
    readonly terminalEligibility?: {
      readonly kind: "station" | "halt" | "unknown";
      readonly canTurn: boolean;
      readonly evidenceId: string;
    };
  })[];
}

export interface GameTimetableLine {
  readonly lineId: string;
  readonly routeShortName: string;
  readonly directionId: string;
  readonly headsign: string;
  readonly adjustment?: {
    readonly reason: "unchanged" | "adapted-to-operational-stations";
    readonly referenceOriginName: string;
    readonly referenceDestinationName: string;
    readonly originName: string;
    readonly destinationName: string;
    readonly terminalEvidenceIds: readonly [string, string];
  };
  readonly stopIds: readonly string[];
  readonly reference: {
    readonly sourceRouteIds: readonly string[];
    readonly sourceTripIds: readonly string[];
    readonly firstDepartureS: number;
    readonly lastDepartureS: number;
    readonly medianHeadwayS: number | null;
    readonly runningSeconds: readonly number[];
    readonly dwellSeconds: readonly number[];
  };
  readonly journeyCount: number;
}

export interface GameTimetableAdjustment {
  readonly sourceTripId: string;
  readonly referenceOriginStopId: string;
  readonly referenceDestinationStopId: string;
  readonly sectionStopIds: readonly string[];
  readonly generatedStopIds: readonly string[];
  readonly reason: "retained-operational-terminals" | "trimmed-to-operational-stations" | "no-eligible-terminal-pair";
}

export interface GameTimetableInput {
  readonly worldId: string;
  readonly regionId: string;
  readonly releaseId: string;
  readonly serviceDate: string;
  readonly seed: string;
  readonly specification: GameTimetableSpecification;
  readonly trips: readonly GameTimetableTripInput[];
}

export interface GameTimetableJourney extends JourneyChain {
  readonly lineId: string;
  readonly generation: "game-timetable/v1";
  readonly generationIndex: number;
  readonly sourceTripIds: readonly string[];
  readonly sourceRouteIds: readonly string[];
}

function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new GtfsPlanningError(`${name} ist keine sichere Ganzzahl >= ${minimum}.`);
}

function identity(prefix: string, value: unknown): string {
  return `${prefix}-${planningSha256(canonicalPlanningJson(value)).slice(0, 24)}`;
}

export function gameTimetableLineId(input: { readonly regionId: string; readonly designation: string; readonly directionId: string; readonly nodeIds: readonly string[] }): string {
  return identity("game-line", { schema: "zugfolge-game-line/v1", ...input });
}

export function gameTimetableJourneyId(input: { readonly regionId: string; readonly lineId: string; readonly serviceDate: string; readonly seed: string; readonly index: number }): string {
  return identity("game-trip", { schema: "zugfolge-game-trip/v1", ...input });
}

export function gameTimetableLegId(journeyChainId: string): string {
  return identity("game-leg", { journeyChainId });
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? sorted[middle - 1]! + Math.floor((sorted[middle]! - sorted[middle - 1]!) / 2)
    : sorted[middle]!;
}

/** Gemeinsame Taktregel für Betriebsfahrplan und Ausschreibungs-Mengengerüst. */
export function generateGameDepartures(input: {
  readonly referenceDepartures: readonly number[];
  readonly seed: string;
  readonly lineId: string;
  readonly departureGridSeconds: number;
}): { readonly departures: readonly number[]; readonly medianHeadwayS: number | null } {
  integer(input.departureGridSeconds, "departureGridSeconds", 1);
  const departures = [...new Set(input.referenceDepartures)].sort((left, right) => left - right);
  if (departures.length === 0) throw new GtfsPlanningError("Die Taktreferenz besitzt keine Abfahrt.");
  departures.forEach((value) => integer(value, "referenceDepartures"));
  const headways = departures.slice(1).map((value, index) => value - departures[index]!);
  const headway = headways.length > 0 ? median(headways) : null;
  // Der Seed legt die Sekundenlage auf einem Minutenraster fest. Die erste
  // Referenzfahrt begrenzt den Betriebsbeginn, bestimmt aber keine echte Fahrt.
  const phase = Number(BigInt(`0x${planningSha256(canonicalPlanningJson({ seed: input.seed, lineId: input.lineId })).slice(0, 16)}`) % BigInt(input.departureGridSeconds));
  const first = Math.floor(departures[0]! / input.departureGridSeconds) * input.departureGridSeconds + phase;
  const last = Math.floor(departures.at(-1)! / input.departureGridSeconds) * input.departureGridSeconds + phase;
  integer(first, "generatedFirstDepartureS");
  integer(last, "generatedLastDepartureS");
  const generated = [first];
  if (headway !== null) {
    const count = Math.floor((last - first) / headway) + 1;
    if (count > MAXIMUM_JOURNEYS_PER_LINE) throw new GtfsPlanningError("Generierter Linientakt überschreitet 100000 Fahrten je Verkehrstag.");
    for (let index = 1; index < count; index += 1) {
      const departure = first + index * headway;
      integer(departure, "generatedDepartureS");
      generated.push(departure);
    }
  }
  return { departures: generated, medianHeadwayS: headway };
}

/**
 * Kürzt jede Referenz an Außenhalten oder belegten Außenpfaden. Ein Wiedereintritt
 * bildet eine eigenständige Linie; Einzelhalte und reine Außenfahrten entfallen.
 * Erst danach entstehen aus Takt und medianen Abschnittszeiten neue Spielzüge.
 */
export function compileGameTimetable(input: GameTimetableInput): {
  readonly chains: readonly GameTimetableJourney[];
  readonly lines: readonly GameTimetableLine[];
  readonly adjustments: readonly GameTimetableAdjustment[];
  readonly metrics: {
    readonly touchedTripCount: number;
    readonly generatedJourneyCount: number;
    readonly generatedLineCount: number;
    readonly discardedSingleStopSectionCount: number;
    readonly excludedOutsideTripCount: number;
  };
} {
  for (const [name, value] of Object.entries({ worldId: input.worldId, regionId: input.regionId, releaseId: input.releaseId, seed: input.seed, specificationVersion: input.specification.version })) {
    if (typeof value !== "string" || value.trim() === "") throw new GtfsPlanningError(`${name} fehlt.`);
  }
  if (!/^\d{8}$/.test(input.serviceDate)) throw new GtfsPlanningError("serviceDate ist kein GTFS-Verkehrstag.");
  integer(input.specification.departureGridSeconds, "departureGridSeconds", 1);
  integer(input.specification.minimumRunningSeconds, "minimumRunningSeconds", 1);
  type Reference = { trip: GameTimetableTripInput; stops: GameTimetableTripInput["stops"]; departures: number[] };
  const groups = new Map<string, Reference[]>();
  const adjustments: GameTimetableAdjustment[] = [];
  let touchedTripCount = 0;
  let excludedOutsideTripCount = 0;
  let discardedSingleStopSectionCount = 0;
  for (const trip of [...input.trips].sort((left, right) => left.sourceTripId.localeCompare(right.sourceTripId))) {
    const sorted = [...trip.stops].sort((left, right) => left.stopSequence - right.stopSequence);
    for (const [index, stop] of sorted.entries()) {
      integer(stop.stopSequence, "stopSequence");
      integer(stop.arrivalS, "arrivalS");
      integer(stop.departureS, "departureS");
      if (stop.arrivalS > stop.departureS || (index > 0 && (sorted[index - 1]!.departureS > stop.arrivalS || sorted[index - 1]!.stopSequence >= stop.stopSequence))) {
        throw new GtfsPlanningError(`GTFS-Referenz '${trip.sourceTripId}' besitzt ungültige Haltzeiten oder Haltreihenfolge.`);
      }
    }
    if (!sorted.some((stop) => stop.inRegion)) {
      if (input.specification.requireEligibleTerminals === true && sorted.length > 0) adjustments.push({ sourceTripId: trip.sourceTripId, referenceOriginStopId: sorted[0]!.stopId, referenceDestinationStopId: sorted.at(-1)!.stopId, sectionStopIds: [], generatedStopIds: [], reason: "no-eligible-terminal-pair" });
      excludedOutsideTripCount += 1;
      continue;
    }
    touchedTripCount += 1;
    let start = 0;
    while (start < sorted.length) {
      if (!sorted[start]!.inRegion) { start += 1; continue; }
      let end = start;
      while (end + 1 < sorted.length && sorted[end + 1]!.inRegion && sorted[end]!.pathToNextInRegion !== false) end += 1;
      const sectionStops = sorted.slice(start, end + 1);
      start = end + 1;
      let stops = sectionStops;
      if (input.specification.requireEligibleTerminals === true) {
        const eligible = (stop: GameTimetableTripInput["stops"][number]) => stop.terminalEligibility?.kind === "station"
          && stop.terminalEligibility.canTurn === true && typeof stop.terminalEligibility.evidenceId === "string" && stop.terminalEligibility.evidenceId.trim() !== "";
        const indices = sectionStops.flatMap((stop, index) => eligible(stop) ? [index] : []);
        const nodeAt = (index: number) => sectionStops[index]!.nodeId ?? sectionStops[index]!.stopId;
        const earliest = indices[0];
        const earliestOther = earliest === undefined ? undefined : indices.find((index) => nodeAt(index) !== nodeAt(earliest));
        let first = -1;
        let last = -1;
        for (const candidateLast of indices) {
          const candidateFirst = nodeAt(candidateLast) !== nodeAt(earliest!) ? earliest : earliestOther;
          if (candidateFirst === undefined || candidateFirst >= candidateLast) continue;
          if (candidateLast - candidateFirst > last - first
            || (candidateLast - candidateFirst === last - first && candidateFirst < first)) {
            first = candidateFirst;
            last = candidateLast;
          }
        }
        const distinct = first >= 0;
        stops = distinct ? sectionStops.slice(first, last + 1) : [];
        adjustments.push({ sourceTripId: trip.sourceTripId, referenceOriginStopId: sorted[0]!.stopId, referenceDestinationStopId: sorted.at(-1)!.stopId, sectionStopIds: sectionStops.map((stop) => stop.stopId), generatedStopIds: stops.map((stop) => stop.stopId), reason: !distinct ? "no-eligible-terminal-pair" : first === 0 && last === sectionStops.length - 1 ? "retained-operational-terminals" : "trimmed-to-operational-stations" });
      }
      if (stops.length < 2) { discardedSingleStopSectionCount += 1; continue; }
      const lineId = gameTimetableLineId({
        regionId: input.regionId,
        designation: trip.routeShortName, directionId: trip.directionId,
        nodeIds: stops.map((stop) => stop.nodeId ?? stop.stopId),
      });
      const departures: number[] = [];
      if ((trip.frequencies?.length ?? 0) > 0) {
        for (const frequency of trip.frequencies!) {
          integer(frequency.startS, "frequencies.startS");
          integer(frequency.endS, "frequencies.endS");
          integer(frequency.headwayS, "frequencies.headwayS", 1);
          if (frequency.endS <= frequency.startS) throw new GtfsPlanningError("GTFS-Frequenzfenster besitzt keine positive Dauer.");
          const count = Math.ceil((frequency.endS - frequency.startS) / frequency.headwayS);
          if (count + departures.length > MAXIMUM_JOURNEYS_PER_LINE) throw new GtfsPlanningError("GTFS-Frequenzreferenz überschreitet 100000 Fahrten je Verkehrstag.");
          for (let index = 0; index < count; index += 1) {
            const departure = frequency.startS + index * frequency.headwayS + (stops[0]!.departureS - sorted[0]!.departureS);
            integer(departure, "frequencyDepartureS");
            departures.push(departure);
          }
        }
      } else departures.push(stops[0]!.departureS);
      const references = groups.get(lineId) ?? [];
      references.push({ trip, stops, departures });
      groups.set(lineId, references);
    }
  }
  const chains: GameTimetableJourney[] = [];
  const lines: GameTimetableLine[] = [];
  for (const [lineId, references] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const representative = references[0]!;
    const sourceTripIds = [...new Set(references.map((reference) => reference.trip.sourceTripId))].sort();
    const sourceRouteIds = [...new Set(references.map((reference) => reference.trip.routeId))].sort();
    const departures = references.flatMap((reference) => reference.departures).sort((left, right) => left - right);
    const generated = generateGameDepartures({ referenceDepartures: departures, seed: input.seed, lineId, departureGridSeconds: input.specification.departureGridSeconds });
    const runningSeconds = representative.stops.slice(1).map((_, index) => Math.max(input.specification.minimumRunningSeconds, median(references.map((reference) => reference.stops[index + 1]!.arrivalS - reference.stops[index]!.departureS))));
    const dwellSeconds = representative.stops.map((_, index) => index === 0 || index === representative.stops.length - 1 ? 0 : median(references.map((reference) => reference.stops[index]!.departureS - reference.stops[index]!.arrivalS)));
    const headsign = representative.stops.at(-1)!.stopName;
    const origin = representative.stops[0]!;
    const destination = representative.stops.at(-1)!;
    const orderedReference = [...representative.trip.stops].sort((left, right) => left.stopSequence - right.stopSequence);
    const referenceOrigin = orderedReference[0]!;
    const referenceDestination = orderedReference.at(-1)!;
    lines.push({ lineId, routeShortName: representative.trip.routeShortName, directionId: representative.trip.directionId, headsign, stopIds: representative.stops.map((stop) => stop.stopId), reference: { sourceRouteIds, sourceTripIds, firstDepartureS: departures[0]!, lastDepartureS: departures.at(-1)!, medianHeadwayS: generated.medianHeadwayS, runningSeconds, dwellSeconds }, journeyCount: generated.departures.length,
      ...(input.specification.requireEligibleTerminals === true ? { adjustment: {
        reason: origin.stopId === referenceOrigin.stopId && destination.stopId === referenceDestination.stopId ? "unchanged" as const : "adapted-to-operational-stations" as const,
        referenceOriginName: referenceOrigin.stopName,
        referenceDestinationName: referenceDestination.stopName,
        originName: origin.stopName,
        destinationName: destination.stopName,
        terminalEvidenceIds: [origin.terminalEligibility!.evidenceId, destination.terminalEligibility!.evidenceId] as const,
      } } : {}),
    });
    for (const [index, departure] of generated.departures.entries()) {
      const journeyChainId = gameTimetableJourneyId({ regionId: input.regionId, lineId, serviceDate: input.serviceDate, seed: input.seed, index });
      const legId = gameTimetableLegId(journeyChainId);
      let elapsed = 0;
      const stops = representative.stops.map((stop, stopIndex) => {
        if (stopIndex > 0) elapsed += runningSeconds[stopIndex - 1]!;
        const arrivalS = departure + elapsed;
        elapsed += dwellSeconds[stopIndex]!;
        integer(departure + elapsed, "generatedDepartureS");
        return { stopId: stop.stopId, stopSequence: stopIndex + 1, arrivalS, departureS: departure + elapsed };
      });
      chains.push({ schemaVersion: GTFS_JOURNEY_CHAIN_SCHEMA, journeyChainId, worldId: input.worldId, regionId: input.regionId, releaseId: input.releaseId, specificationVersion: input.specification.version, sourceTripId: sourceTripIds[0]!, serviceId: `game-service-${input.serviceDate}`, routeId: lineId, routeShortName: representative.trip.routeShortName, headsign, directionId: representative.trip.directionId, orderable: true, lineId, generation: "game-timetable/v1", generationIndex: index, sourceTripIds, sourceRouteIds, legs: [{ kind: "playable", legId, sequence: 0, qualityClass: "B", orderable: true, entryPortalId: null, exitPortalId: null, planningWindows: [], stops }] });
    }
  }
  return { chains, lines, adjustments, metrics: { touchedTripCount, generatedJourneyCount: chains.length, generatedLineCount: lines.length, discardedSingleStopSectionCount, excludedOutsideTripCount } };
}
