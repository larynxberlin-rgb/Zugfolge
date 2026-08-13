import {
  BLOCKING_PHASES,
  PLANNING_PROJECTION_SCHEMA_VERSION,
  type PlanningProjectionV1,
} from "@zugfolge/planning-projection";

const block = { id: "block-skz-ll", kind: "block" as const, label: "Block Schkeuditz–Leutzsch" };
const route = { id: "route-32n", kind: "route" as const, label: "Fahrstrasse 32N · Leipzig-Leutzsch" };

export const demoProjection: PlanningProjectionV1 = {
  schemaVersion: PLANNING_PROJECTION_SCHEMA_VERSION,
  projectionRevision: 1,
  worldId: "demo-lhe",
  corridor: { id: "halle-leipzig", name: "Halle–Leipzig" },
  stations: [
    { id: "halle", name: "Halle (Saale) Hbf", distanceMm: 0 },
    { id: "schkeuditz", name: "Schkeuditz", distanceMm: 13_000_000 },
    { id: "leutzsch", name: "Leipzig-Leutzsch", distanceMm: 27_000_000 },
    { id: "leipzig", name: "Leipzig Hbf", distanceMm: 34_000_000 },
  ],
  trains: [
    {
      id: "demo-t1",
      number: "R 74018",
      direction: "with-chainage",
      calls: [
        { stationId: "halle", timeS: 25_800 },
        { stationId: "schkeuditz", timeS: 26_520 },
        { stationId: "leutzsch", timeS: 27_180 },
        { stationId: "leipzig", timeS: 27_600 },
      ],
    },
    {
      id: "demo-t2",
      number: "R 74021",
      direction: "against-chainage",
      calls: [
        { stationId: "leipzig", timeS: 25_920 },
        { stationId: "leutzsch", timeS: 26_340 },
        { stationId: "schkeuditz", timeS: 27_120 },
        { stationId: "halle", timeS: 27_900 },
      ],
    },
  ],
  occupations: [
    ...BLOCKING_PHASES.map((phase, index) => ({
      trainId: "demo-t1",
      resource: block,
      governingStationId: index < 3 ? "schkeuditz" : "leutzsch",
      phase,
      startS: 26_760 + index * 70,
      endS: 26_830 + index * 70,
      startDistanceMm: index <= 3 ? 13_000_000 : 27_000_000,
      endDistanceMm: index < 3 ? 13_000_000 : 27_000_000,
    })),
    ...BLOCKING_PHASES.map((phase, index) => ({
      trainId: "demo-t2",
      resource: block,
      governingStationId: index < 3 ? "leutzsch" : "schkeuditz",
      phase,
      startS: 26_700 + index * 70,
      endS: 26_770 + index * 70,
      startDistanceMm: index <= 3 ? 27_000_000 : 13_000_000,
      endDistanceMm: index < 3 ? 27_000_000 : 13_000_000,
    })),
  ],
  conflicts: [
    {
      id: "demo-conflict-opposing",
      kind: "opposing-move",
      resource: block,
      window: { startS: 26_840, endS: 27_050 },
      trainIds: ["demo-t1", "demo-t2"],
      explanation:
        "Beide Zugfahrten beanspruchen denselben Block in entgegengesetzter Richtung. Eine Kreuzung ist nur in einer Betriebsstelle moeglich.",
      alternative: {
        alternativeId: "demo-offer-opposing-v1",
        trainId: "demo-t2",
        departureShiftS: 420,
        explanation:
          "Die spaetere Zeitlage laesst R 74018 den eingleisigen Block vollstaendig raeumen.",
      },
    },
    {
      id: "demo-conflict-route",
      kind: "route-exclusion",
      resource: route,
      window: { startS: 27_080, endS: 27_170 },
      trainIds: ["demo-t1", "demo-t2"],
      explanation:
        "Die beiden Fahrstraßen teilen eine Weiche und können nicht gleichzeitig gestellt werden.",
      alternative: null,
    },
  ],
};

/** Ausschliesslich fuer `?demo=1`; der Produktivpfad wartet immer auf den Server. */
export function applyDemoAlternative(
  projection: PlanningProjectionV1,
  alternativeId: string,
): PlanningProjectionV1 {
  const conflict = projection.conflicts.find(
    (candidate) => candidate.alternative?.alternativeId === alternativeId,
  );
  const alternative = conflict?.alternative;
  if (conflict === undefined || alternative === null || alternative === undefined) {
    return projection;
  }
  return {
    ...projection,
    projectionRevision: projection.projectionRevision + 1,
    trains: projection.trains.map((train) =>
      train.id === alternative.trainId
        ? {
            ...train,
            calls: train.calls.map((call) => ({
              ...call,
              timeS: call.timeS + alternative.departureShiftS,
            })),
          }
        : train,
    ),
    occupations: projection.occupations.map((occupation) =>
      occupation.trainId === alternative.trainId
        ? {
            ...occupation,
            startS: occupation.startS + alternative.departureShiftS,
            endS: occupation.endS + alternative.departureShiftS,
          }
        : occupation,
    ),
    conflicts: projection.conflicts.filter((candidate) => candidate.id !== conflict.id),
  };
}
