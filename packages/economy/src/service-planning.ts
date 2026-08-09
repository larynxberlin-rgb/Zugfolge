import {
  GTFS_PLANNING_SCHEMA,
  validateGtfsPlanningEnvelope,
  type GtfsPlanningEnvelope,
  type GtfsServiceLot,
} from "@zugfolge/gtfs";

import type { ServiceSpecification } from "./tender.js";
import type { Lot } from "./world.js";

export type { GtfsPlanningEnvelope } from "@zugfolge/gtfs";

export interface GtfsPlanningLotReference {
  readonly planningRevision: number;
  readonly snapshotHash: string;
  readonly lotId: string;
}

export interface TenderPlanningEvidence extends GtfsPlanningLotReference {
  readonly source: typeof GTFS_PLANNING_SCHEMA;
}

export class ServicePlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServicePlanningError";
  }
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ServicePlanningError(message);
}

function scaleCeil(value: string, days: number, sampleDays: number, unitDivisor = 1n): bigint {
  const numerator = BigInt(value) * BigInt(days);
  const divisor = BigInt(sampleDays) * unitDivisor;
  return (numerator + divisor - 1n) / divisor;
}

export function lotsFromGtfsPlanning(envelope: GtfsPlanningEnvelope, expectedWorldId: string): readonly Lot[] {
  validateGtfsPlanningEnvelope(envelope);
  invariant(envelope.snapshot.worldId === expectedWorldId, "GTFS-Planung verletzt Weltisolation.");
  return Object.freeze(envelope.snapshot.lots.map((lot) => Object.freeze({
    id: lot.id,
    size: lot.size,
    attractiveness: lot.attractiveness,
  })));
}

export function resolveGtfsPlanningLot(
  envelope: GtfsPlanningEnvelope,
  expectedWorldId: string,
  reference: GtfsPlanningLotReference,
): GtfsServiceLot {
  validateGtfsPlanningEnvelope(envelope);
  invariant(envelope.snapshot.worldId === expectedWorldId, "GTFS-Planung verletzt Weltisolation.");
  invariant(envelope.snapshot.revision === reference.planningRevision, "GTFS-Planungsrevision stimmt nicht überein.");
  invariant(envelope.snapshotHash === reference.snapshotHash, "GTFS-Planungshash stimmt nicht überein.");
  const lot = envelope.snapshot.lots.find((candidate) => candidate.id === reference.lotId);
  invariant(lot !== undefined, "Referenziertes GTFS-Los ist im Snapshot nicht vorhanden.");
  return lot;
}

/** Leitet jede mengen- und fahrzeugrelevante Angabe serverseitig aus dem Snapshot ab. */
export function deriveGtfsServiceSpecification(
  envelope: GtfsPlanningEnvelope,
  expectedWorldId: string,
  reference: GtfsPlanningLotReference,
  periodDurationSeconds: number,
): { readonly lot: GtfsServiceLot; readonly specification: ServiceSpecification; readonly evidence: TenderPlanningEvidence } {
  invariant(Number.isSafeInteger(periodDurationSeconds) && periodDurationSeconds > 0 && periodDurationSeconds % 86_400 === 0, "Vertragsperiode muss aus ganzen, positiven Verkehrstagen bestehen.");
  const lot = resolveGtfsPlanningLot(envelope, expectedWorldId, reference);
  const days = periodDurationSeconds / 86_400;
  const basis = lot.specificationBasis;
  const specification: ServiceSpecification = Object.freeze({
    lines: Object.freeze([...lot.lineIds]),
    trainKmPerPeriod: scaleCeil(basis.totalTrainMeters, days, basis.sampleServiceDays, 1_000n),
    stopsPerPeriod: scaleCeil(basis.totalStops, days, basis.sampleServiceDays),
    serviceHoursPerPeriod: scaleCeil(basis.totalServiceSeconds, days, basis.sampleServiceDays, 3_600n),
    facilityHoursPerPeriod: (BigInt(basis.facilityMinutesPerDay) * BigInt(days) + 59n) / 60n,
    energyKwhPerPeriod: scaleCeil(basis.totalEnergyWh, days, basis.sampleServiceDays, 1_000n),
    vehicleCount: BigInt(basis.peakVehicles),
    overnightUnits: BigInt(basis.overnightUnits),
    protectionUnits: BigInt(basis.protectionUnits),
    requirements: Object.freeze({
      minimumSeats: basis.requirements.minimumSeats,
      ...(basis.requirements.minimumMaximumSpeedKph === undefined ? {} : { minimumMaximumSpeedKph: basis.requirements.minimumMaximumSpeedKph }),
      firstClassBasisPoints: basis.requirements.firstClassBasisPoints,
      accessible: basis.requirements.accessible,
      bicyclePlaces: basis.requirements.bicyclePlaces,
      wheelchairPlaces: basis.requirements.wheelchairPlaces,
      requiredEquipment: Object.freeze([...basis.requirements.requiredEquipment]),
    }),
  });
  invariant(specification.trainKmPerPeriod > 0n && specification.serviceHoursPerPeriod > 0n, "GTFS-Los ergibt keine positive Verkehrsleistung.");
  return Object.freeze({
    lot,
    specification,
    evidence: Object.freeze({
      source: GTFS_PLANNING_SCHEMA,
      planningRevision: reference.planningRevision,
      snapshotHash: reference.snapshotHash,
      lotId: reference.lotId,
    }),
  });
}
