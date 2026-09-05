import {
  GTFS_PLANNING_SCHEMA,
  canonicalPlanningJson,
  createGtfsPlanningEnvelope,
  gtfsLocalMidnightEpochSeconds,
  gtfsPlanningIdentityNamespace,
  gtfsPlanningLotId,
  gtfsPlanningPatternId,
  type GtfsLinePolicy,
  type GtfsPlanningEnvelope,
  type GtfsPlanningSource,
  type GtfsPlanningSnapshot,
  type GtfsServicePattern,
} from "./planning.js";

export interface RegionalPlanningJourney {
  readonly id: string;
  readonly directionId: string;
  readonly sourceRouteId: string;
  readonly sourceRouteIds?: readonly string[];
  readonly sourceTripIds?: readonly string[];
  readonly presentation?: GtfsServicePattern["presentation"];
  readonly routeLengthMm: number;
  readonly edgeIds: readonly string[];
  readonly stops: readonly {
    readonly stopId: string;
    readonly name: string;
    readonly arrivalS: number;
    readonly departureS: number;
  }[];
}

export interface RegionalServicePlanningInput {
  readonly worldId: string;
  readonly revision: number;
  readonly producedAt: number;
  readonly source: GtfsPlanningSource;
  readonly sourceTimetableHash: string;
  readonly timetableGeneration: NonNullable<GtfsPlanningSnapshot["timetableGeneration"]>;
  readonly infrastructureVersion: string;
  readonly rulesVersion: string;
  readonly serviceDate: string;
  readonly smallLotMaximumTrainKmPerDay: number;
  readonly lines: readonly {
    readonly policy: GtfsLinePolicy;
    /** Vom geprueften Tagesumlauf abgeleiteter Fahrzeugbedarf. */
    readonly peakVehicles: number;
    readonly journeys: readonly RegionalPlanningJourney[];
  }[];
}

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function integer(value: number, name: string, minimum = 0): number {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} ist keine sichere Ganzzahl ab ${minimum}.`);
  return value;
}

function ceil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** Projiziert den erzeugten Spieltagesfahrplan; es werden keine GTFS-Fahrten importiert. */
export function buildRegionalServicePlanning(input: RegionalServicePlanningInput): GtfsPlanningEnvelope {
  invariant(/^[a-f0-9]{64}$/u.test(input.sourceTimetableHash), "Spielplanung besitzt keine Fahrplan-Hashbindung.");
  invariant(input.timetableGeneration.specification.schemaVersion === "zugfolge-game-timetable-generation/v1" && input.timetableGeneration.seed.trim() !== "", "Spielplanung besitzt keine versionierte Fahrplangenerierung mit Seed.");
  invariant(input.lines.length > 0 && new Set(input.lines.map(({ policy }) => policy.lineId)).size === input.lines.length, "Spielplanung besitzt keine eindeutigen Linien.");
  integer(input.smallLotMaximumTrainKmPerDay, "Kleinlosgrenze", 1);
  const namespace = gtfsPlanningIdentityNamespace({ ...input, serviceDates: [input.serviceDate] });
  const midnight = gtfsLocalMidnightEpochSeconds(input.serviceDate, input.source.timeZone);
  const patterns: GtfsServicePattern[] = [];
  const journeyIds = new Set<string>();
  const lots = [...input.lines].sort((a, b) => a.policy.lineId.localeCompare(b.policy.lineId)).map((line) => {
    const policy = line.policy;
    integer(line.peakVehicles, "Umlaufbedarf", 1);
    integer(policy.energyWhPerTrainKm, "Energieansatz");
    integer(policy.facilityMinutesPerVehicleDay, "Anlagenansatz");
    integer(policy.overnightBasisPoints, "Nachtquote");
    invariant(policy.overnightBasisPoints <= 10_000, "Nachtquote uebersteigt 100 Prozent.");
    invariant(line.journeys.length > 0, `Linie '${policy.lineId}' besitzt keine Spiel-Fahrten.`);
    const grouped = new Map<string, RegionalPlanningJourney[]>();
    for (const journey of line.journeys) {
      invariant(journey.id.trim() !== "" && !journeyIds.has(journey.id), "Spiel-Fahrtkennung fehlt oder ist doppelt.");
      journeyIds.add(journey.id);
      integer(journey.routeLengthMm, "Laufweglaenge", 1);
      invariant(journey.edgeIds.length > 0 && journey.edgeIds.every((id) => id.trim() !== ""), "Spiel-Fahrt besitzt keine Infrastrukturkanten.");
      invariant(journey.stops.length >= 2 && new Set(journey.stops.map((stop) => stop.stopId)).size === journey.stops.length, "Spiel-Fahrt braucht mindestens zwei eindeutige Binnenhalte.");
      for (const [index, stop] of journey.stops.entries()) {
        invariant(stop.stopId.trim() !== "" && stop.name.trim() !== "", "Spiel-Fahrt besitzt einen unbenannten Halt.");
        integer(stop.arrivalS, "Ankunft");
        integer(stop.departureS, "Abfahrt");
        invariant(stop.departureS >= stop.arrivalS && (index === 0 || stop.arrivalS > journey.stops[index - 1]!.departureS), "Spiel-Fahrt besitzt ruecklaeufige oder fahrzeitlose Halte.");
      }
      const key = canonicalPlanningJson({ directionId: journey.directionId, stopIds: journey.stops.map((stop) => stop.stopId) });
      const group = grouped.get(key) ?? [];
      if (group.length > 0) invariant(group[0]!.routeLengthMm === journey.routeLengthMm && canonicalPlanningJson(group[0]!.edgeIds) === canonicalPlanningJson(journey.edgeIds), "Gleiches Spielmuster besitzt widerspruechliche Infrastrukturwege.");
      group.push(journey);
      grouped.set(key, group);
    }
    const linePatterns = [...grouped.values()].map((journeys): GtfsServicePattern => {
      journeys.sort((a, b) => a.stops[0]!.departureS - b.stops[0]!.departureS || a.id.localeCompare(b.id));
      const first = journeys[0]!;
      const nodeIds = first.stops.map((stop) => stop.stopId);
      const distanceMeters = Number(ceil(BigInt(first.routeLengthMm), 1_000n));
      const totalTrainMeters = BigInt(distanceMeters) * BigInt(journeys.length);
      const gaps = journeys.slice(1).map((journey, index) => journey.stops[0]!.departureS - journeys[index]!.stops[0]!.departureS).filter((gap) => gap > 0).sort((a, b) => a - b);
      const serviceSeconds = journeys.reduce((sum, journey) => sum + BigInt(journey.stops.at(-1)!.arrivalS - journey.stops[0]!.departureS), 0n);
      return {
        id: gtfsPlanningPatternId(namespace, policy.lineId, first.directionId, nodeIds),
        lineId: policy.lineId,
        directionId: first.directionId,
        ...(first.presentation === undefined ? {} : { presentation: first.presentation }),
        sourceRouteIds: [...new Set(journeys.flatMap((journey) => journey.sourceRouteIds ?? [journey.sourceRouteId]))].sort(),
        stopIds: nodeIds,
        stopNames: first.stops.map((stop) => stop.name),
        nodeIds,
        edgeIds: [...new Set(first.edgeIds)],
        distanceMeters,
        journeys: journeys.map((journey) => ({
          id: journey.id,
          sourceTripId: journey.sourceTripIds?.[0] ?? journey.id,
          ...(journey.sourceTripIds === undefined ? {} : { sourceTripIds: journey.sourceTripIds }),
          serviceDate: input.serviceDate,
          departureServiceSeconds: journey.stops[0]!.departureS,
          arrivalServiceSeconds: journey.stops.at(-1)!.arrivalS,
          departureEpochSeconds: midnight + journey.stops[0]!.departureS,
          arrivalEpochSeconds: midnight + journey.stops.at(-1)!.arrivalS,
        })),
        metrics: {
          journeyCount: journeys.length,
          totalTrainMeters: totalTrainMeters.toString(),
          totalStops: (BigInt(journeys.length) * BigInt(first.stops.length)).toString(),
          totalServiceSeconds: serviceSeconds.toString(),
          totalEnergyWh: ceil(totalTrainMeters * BigInt(policy.energyWhPerTrainKm), 1_000n).toString(),
          medianHeadwaySeconds: gaps.length === 0 ? null : gaps[Math.floor((gaps.length - 1) / 2)]!,
          maximumOperatingSpanSeconds: journeys.reduce((maximum, journey) => Math.max(maximum, journey.stops.at(-1)!.arrivalS), 0) - first.stops[0]!.departureS,
          peakVehicles: line.peakVehicles,
        },
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
    patterns.push(...linePatterns);
    const sum = (key: "totalTrainMeters" | "totalStops" | "totalServiceSeconds" | "totalEnergyWh") => linePatterns.reduce((total, pattern) => total + BigInt(pattern.metrics[key]), 0n);
    const size = integer(Number(ceil(sum("totalTrainMeters"), 1_000n)), "Losgroesse");
    return {
      id: gtfsPlanningLotId(namespace, [policy.lineId]),
      lineIds: [policy.lineId],
      patternIds: linePatterns.map((pattern) => pattern.id),
      connectingNodeIds: [],
      size,
      attractiveness: integer(line.journeys.length * 100 + new Set(linePatterns.flatMap((pattern) => pattern.nodeIds)).size * 10, "Losattraktivitaet"),
      smallLot: size <= input.smallLotMaximumTrainKmPerDay,
      specificationBasis: {
        sampleServiceDays: 1,
        totalTrainMeters: sum("totalTrainMeters").toString(),
        totalStops: sum("totalStops").toString(),
        totalServiceSeconds: sum("totalServiceSeconds").toString(),
        totalEnergyWh: sum("totalEnergyWh").toString(),
        peakVehicles: line.peakVehicles,
        facilityMinutesPerDay: integer(line.peakVehicles * policy.facilityMinutesPerVehicleDay, "Anlagenbedarf"),
        overnightUnits: Number(ceil(BigInt(line.peakVehicles) * BigInt(policy.overnightBasisPoints), 10_000n)),
        protectionUnits: policy.requiredProtection.length === 0 ? 0 : line.peakVehicles,
        requirements: { ...policy.requirements, requiredEquipment: [...policy.requirements.requiredEquipment] },
      },
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return createGtfsPlanningEnvelope({
    schema: GTFS_PLANNING_SCHEMA,
    worldId: input.worldId,
    revision: input.revision,
    producedAt: input.producedAt,
    source: input.source,
    sourceTimetableHash: input.sourceTimetableHash,
    timetableGeneration: input.timetableGeneration,
    infrastructureVersion: input.infrastructureVersion,
    rulesVersion: input.rulesVersion,
    serviceDates: [input.serviceDate],
    patterns: patterns.sort((a, b) => a.id.localeCompare(b.id)),
    lots,
  });
}
