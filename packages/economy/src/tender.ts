import type { EconomyRelease, TenderProfile } from "./release.js";

export interface VehicleRequirements { readonly minimumSeats: number; readonly firstClassBasisPoints: number; readonly accessible: boolean; readonly bicyclePlaces: number; readonly wheelchairPlaces: number; readonly requiredEquipment: readonly string[] }
export interface VehicleConcept extends VehicleRequirements { readonly formationId: string; readonly vehicleAgeYears: number; readonly traction: "electric" | "diesel" | "battery" | "hydrogen" }
export interface ServiceSpecification { readonly lines: readonly string[]; readonly trainKmPerPeriod: bigint; readonly stopsPerPeriod: bigint; readonly serviceHoursPerPeriod: bigint; readonly vehicleCount: bigint; readonly overnightUnits: bigint; readonly protectionUnits: bigint; readonly requirements: VehicleRequirements }
export interface Tender { readonly id: string; readonly worldId: string; readonly lotId: string; readonly incumbentOperatorId: string | "public"; readonly profile: TenderProfile; readonly specification: ServiceSpecification; readonly announcedAt: number; readonly opensAt: number; readonly closesAt: number; readonly operatingFrom: number; readonly contractPeriods: number; readonly viabilityThresholdCentsPerTrainKm: bigint; readonly status: "announced" | "open" | "awarded" | "failed" }

export function calculateViabilityThreshold(release: EconomyRelease, specification: ServiceSpecification, profile: TenderProfile): bigint {
  const r = release.rates;
  const total = specification.trainKmPerPeriod * r.trackPerTrainKmCents + specification.stopsPerPeriod * r.stationPerStopCents + specification.serviceHoursPerPeriod * r.personnelPerHourCents + specification.vehicleCount * r.vehiclePerPeriodCents + specification.overnightUnits * r.overnightStablingPerPeriodCents + specification.protectionUnits * r.protectionEquipmentPerPeriodCents + r.administrationPerPeriodCents;
  const profiled = total + total * BigInt(profile.viabilitySurchargeBasisPoints) / 10_000n;
  return (profiled + specification.trainKmPerPeriod - 1n) / specification.trainKmPerPeriod;
}

export function createTender(input: Omit<Tender, "viabilityThresholdCentsPerTrainKm" | "status"> & { readonly release: EconomyRelease; readonly smallLot: boolean }): Tender {
  const duration = input.closesAt - input.opensAt;
  const min = input.smallLot ? 86_400 : 3 * 86_400;
  const max = input.smallLot ? 2 * 86_400 : 7 * 86_400;
  if (duration < min || duration > max || input.announcedAt > input.opensAt || input.operatingFrom <= input.closesAt) throw new Error("Ungültige Fristen im Vergabeverfahren.");
  const { release, smallLot: _smallLot, ...tender } = input;
  return Object.freeze({ ...tender, viabilityThresholdCentsPerTrainKm: calculateViabilityThreshold(release, input.specification, input.profile), status: "announced" });
}

export interface QualityPromises { readonly extraSeats: number; readonly punctualityBasisPoints: number; readonly additionalStops: number }
export interface Bid { readonly id: string; readonly operatorId: string; readonly orderingFeeCentsPerTrainKm: bigint; readonly vehicle: VehicleConcept; readonly promises: QualityPromises; readonly submittedAt: number }
export interface ScoreBreakdown { readonly pricePoints: number; readonly qualityPoints: number; readonly dimensions: Readonly<Record<string, number>> }

export function validateVehicle(requirements: VehicleRequirements, vehicle: VehicleConcept): readonly string[] {
  const failures: string[] = [];
  if (vehicle.minimumSeats < requirements.minimumSeats) failures.push("minimumSeats");
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
  const threshold = tender.viabilityThresholdCentsPerTrainKm;
  const priceRatio = threshold === 0n ? 10_000 : Number((threshold - bid.orderingFeeCentsPerTrainKm) * 10_000n / threshold);
  const dimensions = { extraSeats: Math.min(3_000, bid.promises.extraSeats * 50), punctuality: Math.min(5_000, Math.max(0, bid.promises.punctualityBasisPoints - 8_500)), additionalStops: Math.min(2_000, bid.promises.additionalStops * 400) };
  const qualityRatio = dimensions.extraSeats + dimensions.punctuality + dimensions.additionalStops;
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
    return a.bid.id.localeCompare(b.bid.id);
  });
  return Object.freeze({ winner: valid[0]?.bid, scores: new Map(valid.map((entry) => [entry.bid.id, entry.score])), status: valid.length === 0 ? "failed" : "awarded" });
}
