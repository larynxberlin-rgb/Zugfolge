export interface Station { readonly id: string; readonly name: string; readonly km: number }
export interface TrainCall { readonly stationId: string; readonly minute: number }
export interface TrainPath { readonly id: string; readonly number: string; readonly direction: "up" | "down"; readonly calls: readonly TrainCall[]; readonly selected?: boolean }
export interface OccupationStep { readonly resource: string; readonly startMinute: number; readonly endMinute: number }
export interface Conflict { readonly id: string; readonly trainId: string; readonly opposingTrainId: string; readonly resource: string; readonly kind: "sequence" | "exclusion"; readonly startMinute: number; readonly endMinute: number; readonly minimumHeadwayMinutes: number; readonly proposedShiftMinutes: number }

export const stations: readonly Station[] = [
  { id: "halle", name: "Halle (Saale) Hbf", km: 0 }, { id: "schkeuditz", name: "Schkeuditz", km: 13 },
  { id: "leutzsch", name: "Leipzig-Leutzsch", km: 27 }, { id: "leipzig", name: "Leipzig Hbf", km: 34 },
];
export const trains: readonly TrainPath[] = [
  { id: "t1", number: "R 74018", direction: "down", selected: true, calls: [{ stationId: "halle", minute: 430 }, { stationId: "schkeuditz", minute: 442 }, { stationId: "leutzsch", minute: 453 }, { stationId: "leipzig", minute: 460 }] },
  { id: "t2", number: "R 74021", direction: "up", calls: [{ stationId: "leipzig", minute: 432 }, { stationId: "leutzsch", minute: 439 }, { stationId: "schkeuditz", minute: 452 }, { stationId: "halle", minute: 465 }] },
  { id: "t3", number: "G 61244", direction: "down", calls: [{ stationId: "halle", minute: 441 }, { stationId: "schkeuditz", minute: 454 }, { stationId: "leutzsch", minute: 466 }, { stationId: "leipzig", minute: 473 }] },
  { id: "t4", number: "R 74023", direction: "up", calls: [{ stationId: "leipzig", minute: 451 }, { stationId: "leutzsch", minute: 458 }, { stationId: "schkeuditz", minute: 471 }, { stationId: "halle", minute: 484 }] },
];
export const occupation: readonly OccupationStep[] = [
  { resource: "Block SKZ–LL", startMinute: 448, endMinute: 452 }, { resource: "Fahrstraße 32N", startMinute: 452, endMinute: 455 }, { resource: "Block LL–L", startMinute: 455, endMinute: 459 },
];
export const conflicts: readonly Conflict[] = [
  { id: "c1", trainId: "t1", opposingTrainId: "t2", resource: "Block Schkeuditz–Leutzsch · 3. Gleis", kind: "sequence", startMinute: 449, endMinute: 452, minimumHeadwayMinutes: 4, proposedShiftMinutes: 3 },
];

export const formatMinute = (minute: number): string => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
export function stationY(stationId: string, height = 460): number {
  const station = stations.find((item) => item.id === stationId);
  if (station === undefined) throw new Error(`Unbekannte Betriebsstelle: ${stationId}`);
  return 54 + station.km / 34 * (height - 92);
}
export const timeX = (minute: number, width = 980): number => 150 + (minute - 420) / 75 * (width - 180);
export function pathPoints(train: TrainPath): string { return train.calls.map((call) => `${timeX(call.minute)},${stationY(call.stationId)}`).join(" "); }
