import { CooperationValidationError } from "./errors.js";

export interface VehicleValuationSpec {
  readonly specId: string;
  readonly annualDepreciationBasisPoints: number;
  readonly mileageStepMetres: bigint;
  readonly mileageDepreciationBasisPoints: number;
  readonly maximumMileageSteps: number;
  readonly damageDeductionsBasisPoints: Readonly<Record<string, number>>;
  readonly minimumResidualBasisPoints: number;
}

function basisPoints(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new CooperationValidationError(`${name} muss zwischen 0 und 10.000 Basispunkten liegen.`);
  }
  return value;
}

export function validateValuationSpec(spec: VehicleValuationSpec): void {
  if (spec.specId.trim().length === 0) throw new CooperationValidationError("Bewertungsspezifikation braucht eine ID.");
  basisPoints(spec.annualDepreciationBasisPoints, "Jahreswertverlust");
  basisPoints(spec.mileageDepreciationBasisPoints, "Laufleistungswertverlust");
  basisPoints(spec.minimumResidualBasisPoints, "Mindestrestwert");
  if (spec.mileageStepMetres <= 0n) throw new CooperationValidationError("Laufleistungsschritt muss positiv sein.");
  if (!Number.isSafeInteger(spec.maximumMileageSteps) || spec.maximumMileageSteps < 0) {
    throw new CooperationValidationError("Maximale Laufleistungsschritte sind ungültig.");
  }
  for (const [damage, deduction] of Object.entries(spec.damageDeductionsBasisPoints)) {
    if (damage.trim().length === 0) throw new CooperationValidationError("Schadenskennung darf nicht leer sein.");
    basisPoints(deduction, `Schadensabzug ${damage}`);
  }
}

export function valueVehicle(input: {
  readonly baseValueCents: bigint;
  readonly ageYears: number;
  readonly odometerMetres: bigint;
  readonly conditionBasisPoints: number;
  readonly damageCodes: readonly string[];
  readonly spec: VehicleValuationSpec;
}): bigint {
  validateValuationSpec(input.spec);
  if (input.baseValueCents < 0n || input.odometerMetres < 0n) {
    throw new CooperationValidationError("Wert und Laufleistung dürfen nicht negativ sein.");
  }
  if (!Number.isSafeInteger(input.ageYears) || input.ageYears < 0) {
    throw new CooperationValidationError("Fahrzeugalter ist ungültig.");
  }
  basisPoints(input.conditionBasisPoints, "Zustand");

  const ageDeduction = Math.min(10_000, input.ageYears * input.spec.annualDepreciationBasisPoints);
  const mileageSteps = input.odometerMetres / input.spec.mileageStepMetres;
  const boundedSteps = mileageSteps > BigInt(input.spec.maximumMileageSteps)
    ? input.spec.maximumMileageSteps
    : Number(mileageSteps);
  const mileageDeduction = Math.min(
    10_000,
    boundedSteps * input.spec.mileageDepreciationBasisPoints,
  );
  const damageDeduction = Math.min(
    10_000,
    [...new Set(input.damageCodes)].reduce(
      (sum, code) => sum + (input.spec.damageDeductionsBasisPoints[code] ?? 0),
      0,
    ),
  );
  const retained = Math.max(
    input.spec.minimumResidualBasisPoints,
    10_000 - ageDeduction - mileageDeduction - damageDeduction,
  );
  const conditionAdjusted = BigInt(retained) * BigInt(input.conditionBasisPoints);
  return (input.baseValueCents * conditionAdjusted) / 100_000_000n;
}
