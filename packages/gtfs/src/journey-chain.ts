import { canonicalPlanningJson, planningSha256 } from "./planning.js";

export const GTFS_JOURNEY_CHAIN_SCHEMA = "zugfolge-gtfs-journey-chain/v2" as const;
export const GTFS_JOURNEY_CHAIN_IDENTITY_SCHEMA = "zugfolge-gtfs-journey-chain-identity/v2" as const;
export const GTFS_PLAYABLE_LEG_IDENTITY_SCHEMA = "zugfolge-gtfs-playable-leg-identity/v2" as const;
export const GTFS_EXTERNAL_LEG_IDENTITY_SCHEMA = "zugfolge-gtfs-external-leg-identity/v2" as const;
export const GTFS_BOUNDARY_WINDOW_IDENTITY_SCHEMA = "zugfolge-gtfs-boundary-window-identity/v2" as const;

export interface JourneyChainPortalDefinition {
  readonly portalId: string;
  readonly stopId: string;
  readonly label: string;
}

export interface JourneyChainStopInput {
  readonly stopId: string;
  readonly stopName: string;
  readonly inRegion: boolean;
  readonly stopSequence: number;
  readonly arrivalS: number;
  readonly departureS: number;
}

export interface JourneyChainTripInput {
  readonly sourceTripId: string;
  readonly serviceId: string;
  readonly routeId: string;
  readonly routeShortName: string;
  readonly headsign: string;
  readonly directionId: string;
  readonly stops: readonly JourneyChainStopInput[];
}

export interface JourneyChainCompilerInput {
  readonly worldId: string;
  readonly regionId: string;
  readonly releaseId: string;
  readonly specificationVersion: string;
  readonly boundaryWindowToleranceS: number;
  readonly fixedExternalCostCentsPerMinute: number;
  readonly portals: readonly JourneyChainPortalDefinition[];
  readonly trips: readonly JourneyChainTripInput[];
}

export interface BoundaryPlanningWindow {
  readonly windowId: string;
  readonly portalId: string;
  readonly direction: "entry" | "exit";
  readonly earliestS: number;
  readonly targetS: number;
  readonly latestS: number;
}

export interface PlayableJourneyLeg {
  readonly kind: "playable";
  readonly legId: string;
  readonly sequence: number;
  readonly qualityClass: "B" | "C";
  readonly orderable: boolean;
  readonly entryPortalId: string | null;
  readonly exitPortalId: string | null;
  readonly planningWindows: readonly BoundaryPlanningWindow[];
  readonly stops: readonly {
    readonly stopId: string;
    readonly stopSequence: number;
    readonly arrivalS: number;
    readonly departureS: number;
  }[];
}

export interface ExternalJourneyLeg {
  readonly kind: "external";
  readonly legId: string;
  readonly sequence: number;
  readonly fromPortalId: string | null;
  readonly toPortalId: string | null;
  readonly scheduledStartS: number;
  readonly scheduledEndS: number;
  readonly fixedCostCents: string;
  readonly vehicleBindingRequired: true;
  readonly personnelBindingRequired: true;
  readonly dispatchable: false;
  readonly externalStopIds: readonly string[];
}

export type JourneyLeg = PlayableJourneyLeg | ExternalJourneyLeg;

export interface JourneyChain {
  readonly schemaVersion: typeof GTFS_JOURNEY_CHAIN_SCHEMA;
  readonly journeyChainId: string;
  readonly worldId: string;
  readonly regionId: string;
  readonly releaseId: string;
  readonly specificationVersion: string;
  readonly sourceTripId: string;
  readonly serviceId: string;
  readonly routeId: string;
  readonly routeShortName: string;
  readonly headsign: string;
  readonly directionId: string;
  readonly orderable: boolean;
  readonly legs: readonly JourneyLeg[];
}

export interface JourneyChainCompilation {
  readonly chains: readonly JourneyChain[];
  readonly metrics: {
    readonly touchedTripCount: number;
    readonly journeyChainCount: number;
    readonly playableLegCount: number;
    readonly externalLegCount: number;
    readonly qualifiedBoundaryCount: number;
    readonly unresolvedBoundaryCount: number;
    readonly orderableJourneyChainCount: number;
  };
}

export class JourneyChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JourneyChainError";
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new JourneyChainError(message);
}

function text(value: string, name: string): void {
  invariant(value.trim().length > 0 && value.length <= 300, `${name} muss 1 bis 300 Zeichen besitzen.`);
}

function integer(value: number, name: string, minimum = 0): void {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} ist keine sichere Ganzzahl ab ${minimum}.`);
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${planningSha256(canonicalPlanningJson(value)).slice(0, 24)}`;
}

export function gtfsJourneyChainId(identity: {
  readonly regionId: string;
  readonly releaseId: string;
  readonly sourceTripId: string;
}): string {
  text(identity.regionId, "JourneyChain-Identitaet.regionId");
  text(identity.releaseId, "JourneyChain-Identitaet.releaseId");
  text(identity.sourceTripId, "JourneyChain-Identitaet.sourceTripId");
  return stableId("jc", {
    schemaVersion: GTFS_JOURNEY_CHAIN_IDENTITY_SCHEMA,
    regionId: identity.regionId,
    releaseId: identity.releaseId,
    sourceTripId: identity.sourceTripId,
  });
}

export function gtfsPlayableLegId(identity: {
  readonly journeyChainId: string;
  readonly sequence: number;
}): string {
  text(identity.journeyChainId, "PlayableLeg-Identitaet.journeyChainId");
  integer(identity.sequence, "PlayableLeg-Identitaet.sequence");
  return stableId("pl", {
    schemaVersion: GTFS_PLAYABLE_LEG_IDENTITY_SCHEMA,
    journeyChainId: identity.journeyChainId,
    sequence: identity.sequence,
  });
}

export function gtfsExternalLegId(identity: {
  readonly journeyChainId: string;
  readonly sequence: number;
}): string {
  text(identity.journeyChainId, "ExternalLeg-Identitaet.journeyChainId");
  integer(identity.sequence, "ExternalLeg-Identitaet.sequence");
  return stableId("el", {
    schemaVersion: GTFS_EXTERNAL_LEG_IDENTITY_SCHEMA,
    journeyChainId: identity.journeyChainId,
    sequence: identity.sequence,
  });
}

export function gtfsBoundaryPlanningWindowId(identity: {
  readonly playableLegId: string;
  readonly portalId: string;
  readonly direction: "entry" | "exit";
}): string {
  text(identity.playableLegId, "BoundaryWindow-Identitaet.playableLegId");
  text(identity.portalId, "BoundaryWindow-Identitaet.portalId");
  invariant(identity.direction === "entry" || identity.direction === "exit", "BoundaryWindow-Identitaet.direction ist ungueltig.");
  return stableId("bpw", {
    schemaVersion: GTFS_BOUNDARY_WINDOW_IDENTITY_SCHEMA,
    playableLegId: identity.playableLegId,
    portalId: identity.portalId,
    direction: identity.direction,
  });
}

function portalAt(
  portalsByStop: ReadonlyMap<string, JourneyChainPortalDefinition>,
  stop: JourneyChainStopInput,
): JourneyChainPortalDefinition | undefined {
  return portalsByStop.get(stop.stopId);
}

function portalAtBoundary(
  portalsByStop: ReadonlyMap<string, JourneyChainPortalDefinition>,
  innerStop: JourneyChainStopInput | undefined,
  adjacentOuterStop: JourneyChainStopInput | undefined,
): JourneyChainPortalDefinition | undefined {
  return innerStop === undefined
    ? (adjacentOuterStop === undefined ? undefined : portalAt(portalsByStop, adjacentOuterStop))
    : portalAt(portalsByStop, innerStop)
      ?? (adjacentOuterStop === undefined ? undefined : portalAt(portalsByStop, adjacentOuterStop));
}

function planningWindow(
  playableLegId: string,
  portal: JourneyChainPortalDefinition,
  direction: "entry" | "exit",
  targetS: number,
  toleranceS: number,
): BoundaryPlanningWindow {
  return Object.freeze({
    windowId: gtfsBoundaryPlanningWindowId({ playableLegId, portalId: portal.portalId, direction }),
    portalId: portal.portalId,
    direction,
    earliestS: Math.max(0, targetS - toleranceS),
    targetS,
    latestS: targetS + toleranceS,
  });
}

function externalCost(durationS: number, centsPerMinute: number): string {
  const minutes = Math.floor((durationS + 59) / 60);
  return (BigInt(minutes) * BigInt(centsPerMinute)).toString();
}

function validateInput(input: JourneyChainCompilerInput): ReadonlyMap<string, JourneyChainPortalDefinition> {
  for (const [name, value] of [
    ["worldId", input.worldId],
    ["regionId", input.regionId],
    ["releaseId", input.releaseId],
    ["specificationVersion", input.specificationVersion],
  ] as const) text(value, name);
  integer(input.boundaryWindowToleranceS, "boundaryWindowToleranceS");
  integer(input.fixedExternalCostCentsPerMinute, "fixedExternalCostCentsPerMinute");
  const portalsByStop = new Map<string, JourneyChainPortalDefinition>();
  const portalLabels = new Map<string, string>();
  for (const [index, portal] of input.portals.entries()) {
    text(portal.portalId, `portals[${index}].portalId`);
    text(portal.stopId, `portals[${index}].stopId`);
    text(portal.label, `portals[${index}].label`);
    invariant(!portalsByStop.has(portal.stopId), `Grenzhalt '${portal.stopId}' ist doppelt.`);
    const existingLabel = portalLabels.get(portal.portalId);
    invariant(existingLabel === undefined || existingLabel === portal.label, `Grenzportal '${portal.portalId}' besitzt widerspruechliche Bezeichnungen.`);
    portalsByStop.set(portal.stopId, Object.freeze({ ...portal }));
    portalLabels.set(portal.portalId, portal.label);
  }
  return portalsByStop;
}

function validateTrip(trip: JourneyChainTripInput): void {
  text(trip.sourceTripId, "trips[].sourceTripId");
  text(trip.serviceId, "trips[].serviceId");
  text(trip.routeId, "trips[].routeId");
  invariant(trip.stops.length >= 2, `GTFS-Fahrt '${trip.sourceTripId}' braucht mindestens zwei Halte.`);
  for (const [index, stop] of trip.stops.entries()) {
    text(stop.stopId, `trips[].stops[${index}].stopId`);
    integer(stop.stopSequence, `trips[].stops[${index}].stopSequence`);
    integer(stop.arrivalS, `trips[].stops[${index}].arrivalS`);
    integer(stop.departureS, `trips[].stops[${index}].departureS`);
    invariant(stop.arrivalS <= stop.departureS, `GTFS-Fahrt '${trip.sourceTripId}' hat Abfahrt vor Ankunft.`);
    if (index > 0) {
      const previous = trip.stops[index - 1]!;
      invariant(previous.stopSequence < stop.stopSequence, `GTFS-Fahrt '${trip.sourceTripId}' hat keine steigenden stop_sequence.`);
      invariant(previous.departureS <= stop.arrivalS, `GTFS-Fahrt '${trip.sourceTripId}' hat ruecklaeufige Zeiten.`);
    }
  }
}

/**
 * Kompiliert den gepinnten GTFS-Zuglauf in eine lueckenlose Fahrtkette.
 * Aussenlaeufe enthalten bewusst keine Infrastrukturgeometrie und sind nicht
 * disponierbar; alle Spielerfenster entstehen ausschliesslich aus Releasefakten.
 */
export function compileJourneyChains(input: JourneyChainCompilerInput): JourneyChainCompilation {
  const portalsByStop = validateInput(input);
  const chains: JourneyChain[] = [];
  let qualifiedBoundaryCount = 0;
  let unresolvedBoundaryCount = 0;

  for (const trip of [...input.trips].sort((left, right) => left.sourceTripId.localeCompare(right.sourceTripId))) {
    validateTrip(trip);
    if (!trip.stops.some((stop) => stop.inRegion)) continue;
    const chainIdentity = {
      regionId: input.regionId,
      releaseId: input.releaseId,
      sourceTripId: trip.sourceTripId,
    };
    const journeyChainId = gtfsJourneyChainId(chainIdentity);
    const legs: JourneyLeg[] = [];
    let cursor = 0;
    let legSequence = 0;
    while (cursor < trip.stops.length) {
      const inRegion = trip.stops[cursor]!.inRegion;
      let end = cursor;
      while (end + 1 < trip.stops.length && trip.stops[end + 1]!.inRegion === inRegion) end += 1;
      const selected = trip.stops.slice(cursor, end + 1);
      if (inRegion) {
        // Ein einzelner innerer Halt ist keine befahrbare regionale Leistung,
        // bleibt aber als Klasse-C-Leg im Coveragebericht sichtbar.
        const entryBoundary = cursor > 0 ? selected[0]! : undefined;
        const exitBoundary = end < trip.stops.length - 1 ? selected.at(-1)! : undefined;
        const entryPortal = entryBoundary === undefined
          ? undefined
          : portalAtBoundary(portalsByStop, entryBoundary, trip.stops[cursor - 1]);
        const exitPortal = exitBoundary === undefined
          ? undefined
          : portalAtBoundary(portalsByStop, exitBoundary, trip.stops[end + 1]);
        const boundaryCount = Number(entryBoundary !== undefined) + Number(exitBoundary !== undefined);
        const resolvedCount = Number(entryPortal !== undefined) + Number(exitPortal !== undefined);
        qualifiedBoundaryCount += resolvedCount;
        unresolvedBoundaryCount += boundaryCount - resolvedCount;
        const orderable = selected.length >= 2 && boundaryCount === resolvedCount;
        const legId = gtfsPlayableLegId({ journeyChainId, sequence: legSequence });
        const windows: BoundaryPlanningWindow[] = [];
        if (entryPortal !== undefined) {
          windows.push(planningWindow(
            legId,
            entryPortal,
            "entry",
            selected[0]!.departureS,
            input.boundaryWindowToleranceS,
          ));
        }
        if (exitPortal !== undefined) {
          windows.push(planningWindow(
            legId,
            exitPortal,
            "exit",
            selected.at(-1)!.arrivalS,
            input.boundaryWindowToleranceS,
          ));
        }
        legs.push(Object.freeze({
          kind: "playable",
          legId,
          sequence: legSequence,
          qualityClass: orderable ? "B" : "C",
          orderable,
          entryPortalId: entryPortal?.portalId ?? null,
          exitPortalId: exitPortal?.portalId ?? null,
          planningWindows: Object.freeze(windows),
          stops: Object.freeze(selected.map((stop) => Object.freeze({
            stopId: stop.stopId,
            stopSequence: stop.stopSequence,
            arrivalS: stop.arrivalS,
            departureS: stop.departureS,
          }))),
        }));
      } else {
        const previousInner = cursor > 0 ? trip.stops[cursor - 1] : undefined;
        const nextInner = end + 1 < trip.stops.length ? trip.stops[end + 1] : undefined;
        const fromPortal = previousInner === undefined
          ? undefined
          : portalAtBoundary(portalsByStop, previousInner, selected[0]);
        const toPortal = nextInner === undefined
          ? undefined
          : portalAtBoundary(portalsByStop, nextInner, selected.at(-1));
        const scheduledStartS = previousInner?.departureS ?? selected[0]!.departureS;
        const scheduledEndS = nextInner?.arrivalS ?? selected.at(-1)!.arrivalS;
        invariant(scheduledEndS >= scheduledStartS, `Außenlauf in '${trip.sourceTripId}' besitzt negative Dauer.`);
        legs.push(Object.freeze({
          kind: "external",
          legId: gtfsExternalLegId({ journeyChainId, sequence: legSequence }),
          sequence: legSequence,
          fromPortalId: fromPortal?.portalId ?? null,
          toPortalId: toPortal?.portalId ?? null,
          scheduledStartS,
          scheduledEndS,
          fixedCostCents: externalCost(scheduledEndS - scheduledStartS, input.fixedExternalCostCentsPerMinute),
          vehicleBindingRequired: true,
          personnelBindingRequired: true,
          dispatchable: false,
          externalStopIds: Object.freeze(selected.map((stop) => stop.stopId)),
        }));
      }
      legSequence += 1;
      cursor = end + 1;
    }
    const playable = legs.filter((leg): leg is PlayableJourneyLeg => leg.kind === "playable");
    const chain = Object.freeze({
      schemaVersion: GTFS_JOURNEY_CHAIN_SCHEMA,
      journeyChainId,
      worldId: input.worldId,
      regionId: input.regionId,
      releaseId: input.releaseId,
      specificationVersion: input.specificationVersion,
      sourceTripId: trip.sourceTripId,
      serviceId: trip.serviceId,
      routeId: trip.routeId,
      routeShortName: trip.routeShortName,
      headsign: trip.headsign,
      directionId: trip.directionId,
      orderable: playable.length > 0 && playable.every((leg) => leg.orderable),
      legs: Object.freeze(legs),
    } satisfies JourneyChain);
    chains.push(chain);
  }

  const playableLegCount = chains.flatMap((chain) => chain.legs).filter((leg) => leg.kind === "playable").length;
  const externalLegCount = chains.flatMap((chain) => chain.legs).filter((leg) => leg.kind === "external").length;
  return Object.freeze({
    chains: Object.freeze(chains),
    metrics: Object.freeze({
      touchedTripCount: chains.length,
      journeyChainCount: chains.length,
      playableLegCount,
      externalLegCount,
      qualifiedBoundaryCount,
      unresolvedBoundaryCount,
      orderableJourneyChainCount: chains.filter((chain) => chain.orderable).length,
    }),
  });
}
