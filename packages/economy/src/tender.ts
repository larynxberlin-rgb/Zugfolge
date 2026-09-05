import type { EconomyRelease, EconomyRules, TenderProfile } from "./release.js";
import type { TenderPlanningEvidence } from "./service-planning.js";
import { compareUtf8 } from "./utf8.js";

export interface VehicleRequirements { readonly minimumSeats: number; readonly minimumMaximumSpeedKph?: number; readonly firstClassBasisPoints: number; readonly accessible: boolean; readonly bicyclePlaces: number; readonly wheelchairPlaces: number; readonly requiredEquipment: readonly string[] }
export interface VehicleConcept extends VehicleRequirements {
  readonly formationId: string;
  readonly maximumSpeedKph: number;
  readonly operatingCostCentsPerTrainKm: number;
  readonly vehicleAgeYears: number;
  readonly traction: "electric" | "diesel" | "battery" | "hydrogen";
  readonly replacementPlan: boolean;
  /** Serverseitig aus einem unveränderlichen M5-Snapshot abgeleitet. */
  readonly evidence: {
    readonly source: "zugfolge-fleet-mobilization/v1";
    readonly fleetRevision: number;
    readonly snapshotHash: string;
    readonly formationId: string;
  };
}
export interface ServiceSpecification { readonly lines: readonly string[]; readonly trainKmPerPeriod: bigint; readonly stopsPerPeriod: bigint; readonly serviceHoursPerPeriod: bigint; readonly facilityHoursPerPeriod: bigint; readonly energyKwhPerPeriod: bigint; readonly vehicleCount: bigint; readonly overnightUnits: bigint; readonly protectionUnits: bigint; readonly requirements: VehicleRequirements }
export interface Tender { readonly id: string; readonly worldId: string; readonly lotId: string; readonly incumbentOperatorId: string | "public"; readonly profile: TenderProfile; readonly rules: EconomyRules; readonly specification: ServiceSpecification; readonly planningEvidence?: TenderPlanningEvidence; readonly announcedAt: number; readonly opensAt: number; readonly closesAt: number; readonly operatingFrom: number; readonly contractPeriods: number; readonly periodDurationSeconds: number; readonly viabilityThresholdCentsPerTrainKm: bigint; readonly status: "announced" | "open" | "awarded" | "failed" }

export function calculateViabilityThreshold(release: EconomyRelease, specification: ServiceSpecification, profile: TenderProfile): bigint {
  const r = release.rates;
  if (specification.trainKmPerPeriod <= 0n) throw new Error("Leistungsbeschreibung braucht positive Zugkilometer.");
  const total = specification.trainKmPerPeriod * r.trackPerTrainKmCents + specification.stopsPerPeriod * r.stationPerStopCents + specification.serviceHoursPerPeriod * r.personnelPerHourCents + specification.facilityHoursPerPeriod * r.facilityPerHourCents + specification.energyKwhPerPeriod * r.energyPerKwhCents + specification.vehicleCount * r.vehiclePerPeriodCents + specification.overnightUnits * r.overnightStablingPerPeriodCents + specification.protectionUnits * r.protectionEquipmentPerPeriodCents + r.administrationPerPeriodCents;
  const profiled = total + total * BigInt(profile.viabilitySurchargeBasisPoints) / 10_000n;
  return (profiled + specification.trainKmPerPeriod - 1n) / specification.trainKmPerPeriod;
}

export function createTender(input: Omit<Tender, "rules" | "viabilityThresholdCentsPerTrainKm" | "status"> & { readonly release: EconomyRelease; readonly smallLot: boolean }): Tender {
  const duration = input.closesAt - input.opensAt;
  const min = input.smallLot ? 86_400 : 3 * 86_400;
  const max = input.smallLot ? 2 * 86_400 : 7 * 86_400;
  if (duration < min || duration > max || input.announcedAt > input.opensAt || input.operatingFrom <= input.closesAt || input.contractPeriods < 2 || !Number.isInteger(input.contractPeriods) || input.periodDurationSeconds <= 0 || !Number.isInteger(input.periodDurationSeconds)) throw new Error("Ungültige Fristen im Vergabeverfahren.");
  const { release, smallLot: _smallLot, ...tender } = input;
  return Object.freeze({ ...tender, rules: release.rules, viabilityThresholdCentsPerTrainKm: calculateViabilityThreshold(release, input.specification, input.profile), status: "announced" });
}

export interface QualityPromises { readonly extraSeats: number; readonly punctualityBasisPoints: number; readonly additionalStops: number }
/** Vier vergleichbare Dimensionen; neue Halte brauchen zuerst einen Planungsnachweis. */
export const QUALITY_PROMISE_POLICY = Object.freeze({ schemaVersion: "zugfolge-quality-promises/v2", dimensionMaximumPoints: 2_500, maximumAdditionalStops: 0 } as const);
export interface Bid { readonly id: string; readonly operatorId: string; readonly orderingFeeCentsPerTrainKm: bigint; readonly vehicle: VehicleConcept; readonly promises: QualityPromises; readonly submittedAt: number }
export interface ScoreBreakdown { readonly pricePoints: number; readonly qualityPoints: number; readonly dimensions: Readonly<Record<string, number>> }

export function validateVehicle(requirements: VehicleRequirements, vehicle: VehicleConcept): readonly string[] {
  const failures: string[] = [];
  if (
    vehicle.evidence.source !== "zugfolge-fleet-mobilization/v1"
    || vehicle.evidence.formationId !== vehicle.formationId
    || !Number.isSafeInteger(vehicle.evidence.fleetRevision)
    || vehicle.evidence.fleetRevision < 0
    || !/^[a-f0-9]{64}$/.test(vehicle.evidence.snapshotHash)
  ) failures.push("fleetSnapshotEvidence");
  if (vehicle.minimumSeats < requirements.minimumSeats) failures.push("minimumSeats");
  if (requirements.minimumMaximumSpeedKph !== undefined && vehicle.maximumSpeedKph < requirements.minimumMaximumSpeedKph) failures.push("maximumSpeedKph");
  if (vehicle.firstClassBasisPoints < requirements.firstClassBasisPoints) failures.push("firstClassBasisPoints");
  if (requirements.accessible && !vehicle.accessible) failures.push("accessible");
  if (vehicle.bicyclePlaces < requirements.bicyclePlaces) failures.push("bicyclePlaces");
  if (vehicle.wheelchairPlaces < requirements.wheelchairPlaces) failures.push("wheelchairPlaces");
  for (const item of requirements.requiredEquipment) if (!vehicle.requiredEquipment.includes(item)) failures.push(`equipment:${item}`);
  return failures;
}

export function scoreBid(tender: Tender, bid: Bid): ScoreBreakdown {
  const vehicleFailures = validateVehicle(tender.specification.requirements, bid.vehicle);
  if (vehicleFailures.length > 0 || bid.orderingFeeCentsPerTrainKm > tender.viabilityThresholdCentsPerTrainKm || bid.orderingFeeCentsPerTrainKm < 0n) throw new Error(`Ungültiges Angebot: ${vehicleFailures.join(",") || "Auskömmlichkeitsgrenze"}`);
  if (Object.values(bid.promises).some((value) => !Number.isSafeInteger(value) || value < 0) || bid.promises.punctualityBasisPoints > 10_000) throw new Error("Qualitätszusagen sind außerhalb ihres Wertebereichs.");
  if (!Number.isSafeInteger(bid.vehicle.minimumSeats) || bid.promises.extraSeats > bid.vehicle.minimumSeats - tender.specification.requirements.minimumSeats) throw new Error("Sitzplatzzusage ist durch die Formation nicht nachgewiesen.");
  if (bid.promises.additionalStops > QUALITY_PROMISE_POLICY.maximumAdditionalStops) throw new Error("Zusatzhalte benoetigen einen serverseitigen Halte- und Trassennachweis; derzeit sind nur ausgeschriebene Halte zulaessig.");
  const condition = tender.profile.specialCondition;
  if (condition?.type === "additional-stop" && bid.promises.additionalStops < condition.minimumAdditionalStops) throw new Error("Sonderauflage Zusatzhalte nicht erfüllt.");
  if (condition?.type === "maximum-age" && bid.vehicle.vehicleAgeYears > condition.maximumAgeYears) throw new Error("Sonderauflage Fahrzeugalter nicht erfüllt.");
  if (condition?.type === "traction" && !condition.allowed.includes(bid.vehicle.traction)) throw new Error("Sonderauflage Traktion nicht erfüllt.");
  if (condition?.type === "replacement-plan" && !bid.vehicle.replacementPlan) throw new Error("Sonderauflage SEV-Konzept nicht erfüllt.");
  const threshold = tender.viabilityThresholdCentsPerTrainKm;
  const priceRatio = threshold === 0n ? 10_000 : Number((threshold - bid.orderingFeeCentsPerTrainKm) * 10_000n / threshold);
  const maximum = tender.rules.requirementFocusMaximumPoints;
  const uncappedFocusPoints = tender.profile.requirementFocus === "capacity"
    ? (bid.vehicle.minimumSeats - tender.specification.requirements.minimumSeats) * tender.rules.pointsPerExtraSeat
    : tender.profile.requirementFocus === "comfort"
      ? bid.vehicle.firstClassBasisPoints - tender.specification.requirements.firstClassBasisPoints
      : tender.profile.requirementFocus === "bicycle"
        ? (bid.vehicle.bicyclePlaces - tender.specification.requirements.bicyclePlaces) * tender.rules.pointsPerExtraSeat
        : bid.vehicle.accessible
          ? maximum
          : 0;
  const boundedPoints = (quantity: number, rate: number): number => {
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(rate) || quantity < 0 || rate < 0) throw new Error("Qualitaetswertung braucht sichere nichtnegative Ganzzahlen.");
    const points = BigInt(quantity) * BigInt(rate);
    return Number(points > BigInt(QUALITY_PROMISE_POLICY.dimensionMaximumPoints) ? BigInt(QUALITY_PROMISE_POLICY.dimensionMaximumPoints) : points);
  };
  const dimensions = {
    extraSeats: boundedPoints(bid.promises.extraSeats, tender.rules.pointsPerExtraSeat),
    punctuality: boundedPoints(Math.max(0, bid.promises.punctualityBasisPoints - tender.rules.qualityBaselinePunctualityBasisPoints), tender.rules.pointsPerPunctualityBasisPoint),
    additionalStops: boundedPoints(bid.promises.additionalStops, tender.rules.pointsPerAdditionalStop),
    requirementFocus: Math.min(QUALITY_PROMISE_POLICY.dimensionMaximumPoints, maximum, Math.max(0, uncappedFocusPoints)),
  };
  const qualityRatio = dimensions.extraSeats + dimensions.punctuality + dimensions.additionalStops + dimensions.requirementFocus;
  return Object.freeze({ pricePoints: Math.floor(priceRatio * tender.profile.weights.price / 10_000), qualityPoints: Math.floor(qualityRatio * tender.profile.weights.quality / 10_000), dimensions: Object.freeze(dimensions) });
}

export function assistBid(tender: Tender, input: Omit<Bid, "orderingFeeCentsPerTrainKm"> & { readonly expectedCostCentsPerTrainKm: bigint; readonly targetMarginBasisPoints: number }): Bid & { readonly preview: ScoreBreakdown } {
  const price = input.expectedCostCentsPerTrainKm + input.expectedCostCentsPerTrainKm * BigInt(input.targetMarginBasisPoints) / 10_000n;
  const bid = { ...input, orderingFeeCentsPerTrainKm: price };
  return Object.freeze({ ...bid, preview: scoreBid(tender, bid) });
}

export function awardTender(tender: Tender, bids: readonly Bid[], at: number): { readonly winner?: Bid; readonly scores: ReadonlyMap<string, ScoreBreakdown>; readonly status: "awarded" | "failed" } {
  if (at < tender.closesAt) throw new Error("Zuschlag erst bei Fristende.");
  const valid = bids.filter((b) => b.submittedAt <= tender.closesAt).flatMap((bid) => { try { return [{ bid, score: scoreBid(tender, bid) }]; } catch { return []; } });
  valid.sort((a, b) => {
    const scoreDifference = (b.score.pricePoints + b.score.qualityPoints) - (a.score.pricePoints + a.score.qualityPoints);
    if (scoreDifference !== 0) return scoreDifference;
    if (a.bid.orderingFeeCentsPerTrainKm !== b.bid.orderingFeeCentsPerTrainKm) return a.bid.orderingFeeCentsPerTrainKm < b.bid.orderingFeeCentsPerTrainKm ? -1 : 1;
    return compareUtf8(a.bid.id, b.bid.id);
  });
  return Object.freeze({ winner: valid[0]?.bid, scores: new Map(valid.map((entry) => [entry.bid.id, entry.score])), status: valid.length === 0 ? "failed" : "awarded" });
}
