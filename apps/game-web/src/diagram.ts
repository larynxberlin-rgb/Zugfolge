export interface Station {
  readonly id: string;
  readonly name: string;
  readonly km: number;
}
export interface TrainCall {
  readonly stationId: string;
  readonly minute: number;
}
export interface TrainPath {
  readonly id: string;
  readonly number: string;
  readonly direction: "up" | "down";
  readonly calls: readonly TrainCall[];
}
export type OccupationPhase =
  | "formation"
  | "approach"
  | "running"
  | "clearing"
  | "release"
  | "buffer";
export interface OccupationStep {
  readonly trainId: string;
  readonly resource: string;
  readonly stationId: string;
  readonly phase: OccupationPhase;
  readonly startMinute: number;
  readonly endMinute: number;
}
export interface Conflict {
  readonly id: string;
  readonly trainIds: readonly [string, string];
  readonly resource: string;
  readonly kind: "sequence" | "exclusion";
  readonly startMinute: number;
  readonly endMinute: number;
  readonly minimumHeadwayMinutes: number;
  readonly proposedShiftMinutes: number;
}
export interface DiagramData {
  readonly corridor: string;
  readonly stations: readonly Station[];
  readonly trains: readonly TrainPath[];
  readonly occupations: readonly OccupationStep[];
  readonly conflicts: readonly Conflict[];
}
export const phaseLabels: Readonly<Record<OccupationPhase, string>> = {
  formation: "Fahrstraße bilden",
  approach: "Annäherung",
  running: "Fahrt",
  clearing: "Räumung",
  release: "Auflösung",
  buffer: "Puffer",
};
export const sampleData: DiagramData = {
  corridor: "Halle–Leipzig",
  stations: [
    { id: "halle", name: "Halle (Saale) Hbf", km: 0 },
    { id: "schkeuditz", name: "Schkeuditz", km: 13 },
    { id: "leutzsch", name: "Leipzig-Leutzsch", km: 27 },
    { id: "leipzig", name: "Leipzig Hbf", km: 34 },
  ],
  trains: [
    {
      id: "t1",
      number: "R 74018",
      direction: "down",
      calls: [
        { stationId: "halle", minute: 430 },
        { stationId: "schkeuditz", minute: 442 },
        { stationId: "leutzsch", minute: 453 },
        { stationId: "leipzig", minute: 460 },
      ],
    },
    {
      id: "t2",
      number: "R 74021",
      direction: "up",
      calls: [
        { stationId: "leipzig", minute: 432 },
        { stationId: "leutzsch", minute: 439 },
        { stationId: "schkeuditz", minute: 452 },
        { stationId: "halle", minute: 465 },
      ],
    },
    {
      id: "t3",
      number: "G 61244",
      direction: "down",
      calls: [
        { stationId: "halle", minute: 441 },
        { stationId: "schkeuditz", minute: 454 },
        { stationId: "leutzsch", minute: 466 },
        { stationId: "leipzig", minute: 473 },
      ],
    },
    {
      id: "t4",
      number: "R 74023",
      direction: "up",
      calls: [
        { stationId: "leipzig", minute: 451 },
        { stationId: "leutzsch", minute: 458 },
        { stationId: "schkeuditz", minute: 471 },
        { stationId: "halle", minute: 484 },
      ],
    },
  ],
  occupations: [
    {
      trainId: "t1",
      resource: "Block SKZ–LL",
      stationId: "schkeuditz",
      phase: "formation",
      startMinute: 446,
      endMinute: 447,
    },
    {
      trainId: "t1",
      resource: "Block SKZ–LL",
      stationId: "schkeuditz",
      phase: "approach",
      startMinute: 447,
      endMinute: 449,
    },
    {
      trainId: "t1",
      resource: "Block SKZ–LL",
      stationId: "schkeuditz",
      phase: "running",
      startMinute: 449,
      endMinute: 452,
    },
    {
      trainId: "t1",
      resource: "Block SKZ–LL",
      stationId: "leutzsch",
      phase: "clearing",
      startMinute: 452,
      endMinute: 453,
    },
    {
      trainId: "t1",
      resource: "Block SKZ–LL",
      stationId: "leutzsch",
      phase: "release",
      startMinute: 453,
      endMinute: 454,
    },
    {
      trainId: "t1",
      resource: "Block SKZ–LL",
      stationId: "leutzsch",
      phase: "buffer",
      startMinute: 454,
      endMinute: 455,
    },
  ],
  conflicts: [
    {
      id: "c1",
      trainIds: ["t1", "t2"],
      resource: "Block Schkeuditz–Leutzsch · 3. Gleis",
      kind: "sequence",
      startMinute: 449,
      endMinute: 452,
      minimumHeadwayMinutes: 4,
      proposedShiftMinutes: 3,
    },
    {
      id: "c2",
      trainIds: ["t3", "t4"],
      resource: "Fahrstraße 32N · Leipzig-Leutzsch",
      kind: "exclusion",
      startMinute: 457,
      endMinute: 459,
      minimumHeadwayMinutes: 3,
      proposedShiftMinutes: 2,
    },
  ],
};

export const formatMinute = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export const extent = (data: DiagramData): readonly [number, number] => {
  const m = data.trains.flatMap((t) => t.calls.map((c) => c.minute));
  return [
    Math.floor((Math.min(...m) - 5) / 5) * 5,
    Math.ceil((Math.max(...m) + 5) / 5) * 5,
  ];
};
export function stationY(data: DiagramData, id: string, height = 460): number {
  const s = data.stations.find((x) => x.id === id);
  if (!s) throw new Error(`Unbekannte Betriebsstelle: ${id}`);
  const max = Math.max(...data.stations.map((x) => x.km));
  return 54 + (s.km / max) * (height - 92);
}
export function timeX(data: DiagramData, minute: number, width = 980): number {
  const [from, to] = extent(data);
  return 150 + ((minute - from) / (to - from)) * (width - 180);
}
export const pathPoints = (data: DiagramData, train: TrainPath): string =>
  train.calls
    .map((c) => `${timeX(data, c.minute)},${stationY(data, c.stationId)}`)
    .join(" ");
export const conflictsForTrain = (
  data: DiagramData,
  id: string,
): readonly Conflict[] => data.conflicts.filter((c) => c.trainIds.includes(id));
export function shiftedData(
  data: DiagramData,
  trainId: string,
  minutes: number,
): DiagramData {
  return {
    ...data,
    trains: data.trains.map((train) =>
      train.id === trainId
        ? {
            ...train,
            calls: train.calls.map((call) => ({
              ...call,
              minute: call.minute + minutes,
            })),
          }
        : train,
    ),
    occupations: data.occupations.map((occupation) =>
      occupation.trainId === trainId
        ? {
            ...occupation,
            startMinute: occupation.startMinute + minutes,
            endMinute: occupation.endMinute + minutes,
          }
        : occupation,
    ),
    conflicts: data.conflicts.filter(
      (conflict) =>
        !conflict.trainIds.includes(trainId) ||
        Math.abs(minutes) < conflict.proposedShiftMinutes,
    ),
  };
}
