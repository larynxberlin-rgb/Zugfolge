import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { operators, planningTrainNumbers, simulationCommands, worlds } from "@zugfolge/db";
import {
  FleetProducerUnavailableError,
  FleetSnapshotValidationError,
  loadFleetProducerCheckpoint,
  type EconomyDatabase,
  type FleetProducerCheckpoint,
} from "@zugfolge/economy";
import {
  bindPlanningPlayerPathRequest,
  PLANNING_PATH_REQUEST_SCHEMA,
  type PlanningPathRequestBody,
  type PlanningPlayerPathRequestBody,
} from "@zugfolge/planning-worker";
import type {
  FleetAuthorityRelease,
  FleetAuthorityPathReceipt,
  FleetAuthorityVehicleAsset,
  FleetAuthorityVehicleAssetV2,
  FleetRuntime,
  NativeFleetFormationIntent,
} from "@zugfolge/runtime-native";
import { and, desc, eq, sql } from "drizzle-orm";

export class PlanningAuthorityError extends Error {
  override readonly name = "PlanningAuthorityError";

  constructor(
    readonly code: string,
    readonly statusCode: 403 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

function authorityInvariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new PlanningAuthorityError("planning_fleet_state_invalid", 503, message);
  }
}

function compatible(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new PlanningAuthorityError("planning_formation_incompatible", 409, message);
  }
}

function positiveInteger(value: unknown, name: string): asserts value is number {
  authorityInvariant(Number.isSafeInteger(value) && (value as number) > 0, `${name} ist keine positive sichere Ganzzahl.`);
}

function addExact(values: readonly number[], name: string): number {
  let result = 0;
  for (const value of values) {
    positiveInteger(value, name);
    result += value;
    authorityInvariant(Number.isSafeInteger(result), `${name} ist uebergelaufen.`);
  }
  return result;
}

function stableNumericId(value: string): number {
  const numeric = createHash("sha256").update(value, "utf8").digest().readUInt32BE(0);
  return Math.max(1, numeric);
}

type TrainCategory = PlanningPlayerPathRequestBody["trainCategory"];

const TRAIN_NUMBER_RANGES: Readonly<Record<TrainCategory, readonly [number, number]>> = {
  "long-distance": [1, 9_999],
  suburban: [10_000, 19_999],
    // 35.000 bis 39.999 sind fuer importierte oeffentliche Regionalfahrten
  // reserviert und koennen deshalb nie mit einer Spielerfahrt kollidieren.
    regional: [20_000, 34_999],
  freight: [40_000, 79_999],
  supplementary: [80_000, 99_999],
};

interface PlanningTrainIdentity {
  readonly trainId: string;
  readonly trainNumber: number;
}

async function reservePlanningTrainIdentity(
  db: EconomyDatabase,
  input: {
    readonly worldId: string;
    readonly accountId: string;
    readonly requestId: string;
    readonly trainCategory: TrainCategory;
  },
): Promise<PlanningTrainIdentity> {
  return db.transaction(async (tx) => {
    // Eine Weltzeile ist der schmale Serialisierungspunkt. Dadurch können zwei
    // parallele Browser niemals dieselbe nächste Nummer beobachten.
    await tx.execute(sql`select ${worlds.id} from ${worlds} where ${worlds.id} = ${input.worldId} for update`);
    const [existing] = await tx
      .select()
      .from(planningTrainNumbers)
      .where(and(
        eq(planningTrainNumbers.worldId, input.worldId),
        eq(planningTrainNumbers.accountId, input.accountId),
        eq(planningTrainNumbers.requestId, input.requestId),
      ))
      .limit(1);
    if (existing !== undefined) {
      if (existing.trainCategory !== input.trainCategory) {
        throw new PlanningAuthorityError(
          "planning_train_identity_conflict",
          409,
          "Planungsantrag ist bereits mit einer anderen Zuggattung verbunden.",
        );
      }
      return { trainId: existing.trainId, trainNumber: existing.trainNumber };
    }

    const [minimum, maximum] = TRAIN_NUMBER_RANGES[input.trainCategory];
    const [latest] = await tx
      .select({ trainNumber: planningTrainNumbers.trainNumber })
      .from(planningTrainNumbers)
      .where(and(
        eq(planningTrainNumbers.worldId, input.worldId),
        eq(planningTrainNumbers.trainCategory, input.trainCategory),
      ))
      .orderBy(desc(planningTrainNumbers.trainNumber))
      .limit(1);
    // Vor dem v2-Spielervertrag konnten Nummern bereits in unveränderlichen
    // v3-Kommandos stehen. Sie bleiben gültig und werden beim nächsten Wert
    // mitberücksichtigt, ohne historische Payloads umzuschreiben.
    const legacyNumber = sql<number>`cast(${simulationCommands.payload}->>'trainNumber' as integer)`;
    const [latestLegacy] = await tx
      .select({ trainNumber: legacyNumber })
      .from(simulationCommands)
      .where(and(
        eq(simulationCommands.worldId, input.worldId),
        eq(simulationCommands.commandType, "planning.path-request"),
        sql`${simulationCommands.payload}->>'trainNumber' ~ '^[0-9]+$'`,
        sql`${legacyNumber} between ${minimum} and ${maximum}`,
      ))
      .orderBy(desc(legacyNumber))
      .limit(1);
    const latestTrainNumber = Math.max(minimum - 1, latest?.trainNumber ?? 0, latestLegacy?.trainNumber ?? 0);
    const trainNumber = latestTrainNumber + 1;
    if (trainNumber > maximum) {
      throw new PlanningAuthorityError(
        "planning_train_number_range_exhausted",
        409,
        "Der Zugnummernbereich dieser Zuggattung ist ausgeschöpft.",
      );
    }
    const trainId = `player-${createHash("sha256").update(`${input.worldId}:${input.accountId}:${input.requestId}`, "utf8").digest("hex").slice(0, 24)}`;
    await tx.insert(planningTrainNumbers).values({
      worldId: input.worldId,
      accountId: input.accountId,
      requestId: input.requestId,
      trainCategory: input.trainCategory,
      trainNumber,
      trainId,
    });
    return { trainId, trainNumber };
  });
}

function drivingAssets(
  formation: NativeFleetFormationIntent,
  assetsById: ReadonlyMap<string, FleetAuthorityVehicleAsset>,
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): readonly FleetAuthorityVehicleAsset[] {
  const ordered = formation.vehicleIds.map((vehicleId) => assetsById.get(vehicleId)!);
  if (authoritySchemaVersion === "zugfolge-fleet-authority-release/v2") {
    const first = ordered[0]!;
    const source = authorityV2Asset(first, authoritySchemaVersion);
    const hasOutwardControlStand = source.orientation === "along"
      ? source.technical.controlStands.front
      : source.technical.controlStands.rear;
    authorityInvariant(
      hasOutwardControlStand,
      "Authority-v2-Formation besitzt an der aktiven Zugspitze keinen nutzbaren Fuehrerstand.",
    );
    return [first];
  }
  const driving: FleetAuthorityVehicleAsset[] = [];
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  if (first.technical.controlStands?.front === true) driving.push(first);
  if (last.id !== first.id && last.technical.controlStands?.rear === true) driving.push(last);
  if (driving.length === 0) {
    const firstPowered = ordered.find((asset) => asset.technical.traction !== "unpowered");
    authorityInvariant(firstPowered !== undefined, "Formation besitzt kein Traktionsfahrzeug.");
    driving.push(firstPowered);
  }
  return driving;
}

const ELECTRIC_SYSTEM_BY_ROUTE = {
  "overhead-ac15kv": "ac15kv",
  "overhead-ac25kv": "ac25kv",
  "overhead-dc1500v": "dc1500v",
  "overhead-dc3000v": "dc3000v",
} as const;

function authorityV2Asset(
  asset: FleetAuthorityVehicleAsset,
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): FleetAuthorityVehicleAssetV2 {
  authorityInvariant(
    authoritySchemaVersion === "zugfolge-fleet-authority-release/v2"
      && "restrictions" in asset
      && "condition" in asset
      && "history" in asset,
    `Authority-v2-Asset '${asset.id}' besitzt keine vollstaendigen v2-Fakten.`,
  );
  return asset;
}

function orderedRestrictions(asset: FleetAuthorityVehicleAssetV2) {
  return Object.keys(asset.restrictions)
    // Rust-BTreeMap und die kanonische Authority-Serialisierung ordnen nach
    // UTF-8-Bytes. UTF-16-Standardsortierung kann bei nicht-ASCII-Schluesseln
    // die sequenziellen Ganzzahlrundungen von PowerBasisPoints vertauschen.
    .sort((left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
    .map((restrictionId) => asset.restrictions[restrictionId]!);
}

function effectivePowerKw(
  asset: FleetAuthorityVehicleAsset,
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): number {
  if (asset.technical.traction === "unpowered") return 0;
  if (authoritySchemaVersion !== "zugfolge-fleet-authority-release/v2") {
    // Authority-v1 durfte die Rohleistung auslassen und galt historisch
    // trotzdem als angetrieben.
    return 1;
  }
  const source = authorityV2Asset(asset, authoritySchemaVersion);
  let powerKw = source.technical.continuousPowerKw;
  for (const restriction of orderedRestrictions(source)) {
    if (restriction === "immobilized") return 0;
    if (typeof restriction === "object" && "power-basis-points" in restriction) {
      const scaled = BigInt(powerKw) * BigInt(restriction["power-basis-points"]) / 10_000n;
      authorityInvariant(
        scaled <= BigInt(Number.MAX_SAFE_INTEGER),
        `Leistungsrestriktionen von Asset '${asset.id}' sind uebergelaufen.`,
      );
      powerKw = Number(scaled);
    }
  }
  return powerKw;
}

function hasUsableDrive(
  asset: FleetAuthorityVehicleAsset,
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): boolean {
  return asset.technical.traction !== "unpowered"
    && effectivePowerKw(asset, authoritySchemaVersion) > 0;
}

function effectiveProtection(
  asset: FleetAuthorityVehicleAsset,
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): ReadonlySet<FleetAuthorityPathReceipt["requiredProtection"][number]> {
  const available = new Set(asset.installedProtection);
  if (authoritySchemaVersion !== "zugfolge-fleet-authority-release/v2") return available;
  const source = authorityV2Asset(asset, authoritySchemaVersion);
  for (const restriction of orderedRestrictions(source)) {
    if (typeof restriction === "object" && "protection-unavailable" in restriction) {
      available.delete(restriction["protection-unavailable"]);
    }
  }
  if (asset.technical.traction !== "unpowered" && effectivePowerKw(asset, authoritySchemaVersion) === 0) {
    available.clear();
  }
  return available;
}

function effectiveMaximumSpeedMmps(
  asset: FleetAuthorityVehicleAsset,
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): number {
  if (authoritySchemaVersion !== "zugfolge-fleet-authority-release/v2") {
    positiveInteger(asset.technical.maximumSpeedKph, "Legacy-Fahrzeughoechstgeschwindigkeit");
    return Math.ceil(asset.technical.maximumSpeedKph * 1_000_000 / 3_600);
  }
  const source = authorityV2Asset(asset, authoritySchemaVersion);
  positiveInteger(source.technical.maximumSpeedMmps, "Fahrzeughoechstgeschwindigkeit");
  let maximumSpeedMmps = source.technical.maximumSpeedMmps;
  for (const restriction of orderedRestrictions(source)) {
    if (typeof restriction === "object" && "maximum-speed" in restriction) {
      maximumSpeedMmps = Math.min(maximumSpeedMmps, restriction["maximum-speed"]);
    }
  }
  return maximumSpeedMmps;
}

function effectiveServiceBrakeMmps2(
  asset: FleetAuthorityVehicleAsset,
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): readonly number[] {
  if (authoritySchemaVersion !== "zugfolge-fleet-authority-release/v2") return [];
  return orderedRestrictions(authorityV2Asset(asset, authoritySchemaVersion))
    .flatMap((restriction) => typeof restriction === "object" && "service-brake" in restriction
      ? [restriction["service-brake"]]
      : []);
}

function canUseElectrification(
  asset: FleetAuthorityVehicleAsset,
  electrification: FleetAuthorityPathReceipt["electrifications"][number],
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): boolean {
  switch (asset.technical.traction) {
    case "unpowered":
      return false;
    case "diesel":
      return true;
    case "battery":
      if (authoritySchemaVersion !== "zugfolge-fleet-authority-release/v2") return true;
      if (electrification === "unelectrified") return true;
      return asset.technical.electricSystems.includes(ELECTRIC_SYSTEM_BY_ROUTE[electrification]);
    case "electric": {
      if (electrification === "unelectrified") return false;
      return asset.technical.electricSystems.includes(ELECTRIC_SYSTEM_BY_ROUTE[electrification]);
    }
  }
}

function checkRouteCompatibility(
  formation: NativeFleetFormationIntent,
  assets: readonly FleetAuthorityVehicleAsset[],
  receipt: FleetAuthorityPathReceipt,
  earliestDepartureS: number,
  latestDepartureS: number,
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): void {
  compatible(receipt.decision === "confirmed", "Trassenbeleg der Formation ist nicht bestaetigt.");
  compatible(
    receipt.validFrom <= earliestDepartureS && receipt.validUntil > latestDepartureS,
    "Trassenbeleg deckt das beantragte Zeitfenster nicht ab.",
  );

  const lengthMm = addExact(assets.map((asset) => asset.technical.lengthMm), "Formationslaenge");
  compatible(receipt.platformLengthsMm.length > 0, "Trassenbeleg besitzt keine Bahnsteiglaengen.");
  compatible(lengthMm <= Math.min(...receipt.platformLengthsMm), "Formation ist fuer mindestens einen Bahnsteig zu lang.");

  const approvedClasses = new Set(receipt.approvedClasses);
  compatible(
    assets.every((asset) => approvedClasses.has(asset.classDesignation)),
    "Formation verletzt die autoritative Baureihen- oder Lichtraumfreigabe.",
  );
  compatible(
    assets.every((asset) => receipt.serviceLineIds.every((lineId) => asset.approvedLineIds.includes(lineId))),
    "Formation besitzt nicht alle streckenbezogenen Zulassungen des Trassenbelegs.",
  );

  const assetsById = new Map(assets.map((asset) => [asset.id, asset] as const));
  const driving = drivingAssets(formation, assetsById, authoritySchemaVersion);
  compatible(
    receipt.requiredProtection.every((system) =>
      driving.every((asset) => effectiveProtection(asset, authoritySchemaVersion).has(system))),
    "Formation besitzt nicht die erforderliche Zugsicherung.",
  );

  const powered = assets.filter((asset) => hasUsableDrive(asset, authoritySchemaVersion));
  compatible(powered.length > 0, "Formation besitzt kein Traktionsfahrzeug.");
  compatible(receipt.electrifications.length > 0, "Trassenbeleg besitzt keine Elektrifizierungsfakten.");
  compatible(
    receipt.electrifications.every((electrification) =>
      powered.every((asset) => canUseElectrification(asset, electrification, authoritySchemaVersion))),
    "Formation ist mit der Elektrifizierung der Trasse nicht kompatibel.",
  );
}

function trainFacts(
  formation: NativeFleetFormationIntent,
  assets: readonly FleetAuthorityVehicleAsset[],
  authoritySchemaVersion: FleetAuthorityRelease["schemaVersion"],
): PlanningPathRequestBody["train"] {
  const powered = assets.filter((asset) => hasUsableDrive(asset, authoritySchemaVersion));
  compatible(powered.length > 0, "Formation besitzt kein Traktionsfahrzeug.");
  let accelerationMmPerS2: number;
  let decelerationMmPerS2: number;
  if (authoritySchemaVersion === "zugfolge-fleet-authority-release/v2") {
    authorityInvariant(
      formation.dynamics !== undefined,
      `Authority-v2-Formation '${formation.id}' besitzt kein autoritatives Fahrprofil.`,
    );
    positiveInteger(formation.dynamics.accelerationMmPerS2, "Formationsbeschleunigung");
    positiveInteger(formation.dynamics.decelerationMmPerS2, "Formationsbremsvermoegen");
    const expected = authoritativeV2FormationDynamics(assets);
    authorityInvariant(
      formation.dynamics.accelerationMmPerS2 === expected.accelerationMmPerS2
        && formation.dynamics.decelerationMmPerS2 === expected.decelerationMmPerS2,
      `Authority-v2-Formation '${formation.id}' besitzt ein manipuliertes Fahrprofil.`,
    );
    accelerationMmPerS2 = expected.accelerationMmPerS2;
    decelerationMmPerS2 = expected.decelerationMmPerS2;
  } else {
    // Authority-v1 kennt sowohl explizite Formationsprofile als auch die alte
    // per-Asset-Projektion. Dieser Fallback darf nicht in den v2-Pfad lecken.
    accelerationMmPerS2 = formation.dynamics?.accelerationMmPerS2
      ?? Math.min(...powered.map((asset) => asset.technical.accelerationMmPerS2 ?? 0));
    decelerationMmPerS2 = formation.dynamics?.decelerationMmPerS2
      ?? Math.min(...powered.map((asset) => asset.technical.decelerationMmPerS2 ?? 0));
  }
  const serviceBrakeCaps = assets.flatMap((asset) =>
    effectiveServiceBrakeMmps2(asset, authoritySchemaVersion));
  if (serviceBrakeCaps.length > 0) {
    decelerationMmPerS2 = Math.min(decelerationMmPerS2, ...serviceBrakeCaps);
  }
  positiveInteger(accelerationMmPerS2, "Formationsbeschleunigung");
  positiveInteger(decelerationMmPerS2, "Formationsbremsvermoegen");
  const maximumSpeedsMmps = assets.map((asset) =>
    effectiveMaximumSpeedMmps(asset, authoritySchemaVersion));
  return {
    numericId: stableNumericId(formation.id),
    name: formation.id,
    massKg: addExact(assets.map((asset) => asset.technical.massKg), "Formationsmasse"),
    lengthMm: addExact(assets.map((asset) => asset.technical.lengthMm), "Formationslaenge"),
    maximumSpeedMmps: Math.min(...maximumSpeedsMmps),
    accelerationMmPerS2,
    decelerationMmPerS2,
  };
}

function authoritativeV2FormationDynamics(
  assets: readonly FleetAuthorityVehicleAsset[],
): { readonly accelerationMmPerS2: number; readonly decelerationMmPerS2: number } {
  authorityInvariant(assets.length > 0, "Authority-v2-Formation ist leer.");
  const sources = assets.map((asset) =>
    authorityV2Asset(asset, "zugfolge-fleet-authority-release/v2"));
  const totalMassKg = addExact(
    sources.map((asset) => asset.technical.massKg),
    "Authority-v2-Formationsmasse",
  );
  const totalBrakeWeightKg = addExact(
    sources.map((asset) => asset.technical.brakeWeightKg),
    "Authority-v2-Formationsbremsgewicht",
  );
  const driving = sources.filter((asset) =>
    hasUsableDrive(asset, "zugfolge-fleet-authority-release/v2"));
  authorityInvariant(driving.length > 0, "Authority-v2-Formation besitzt keinen nutzbaren Antrieb.");

  const totalStartingTractiveEffortKn = addExact(
    driving.map((asset) => asset.technical.startingTractiveEffortKn),
    "Authority-v2-Formationsanfahrzugkraft",
  );
  const accelerationCapMmps2 = Math.min(...driving.map((asset) => {
    positiveInteger(
      asset.technical.maximumAccelerationCapMmps2,
      "Authority-v2-Beschleunigungs-Cap",
    );
    return asset.technical.maximumAccelerationCapMmps2;
  }));
  const serviceBrakeCapMmps2 = Math.min(...sources.map((asset) => {
    positiveInteger(asset.technical.serviceBrakeCapMmps2, "Authority-v2-Betriebsbrems-Cap");
    return asset.technical.serviceBrakeCapMmps2;
  }));
  const emergencyBrakeMultiplierBasisPoints = Math.min(...sources.map((asset) => {
    positiveInteger(
      asset.technical.emergencyBrakeMultiplierBasisPoints,
      "Authority-v2-Schnellbremsmultiplikator",
    );
    authorityInvariant(
      asset.technical.emergencyBrakeMultiplierBasisPoints > 10_000
        && asset.technical.emergencyBrakeMultiplierBasisPoints <= 30_000,
      "Authority-v2-Schnellbremsmultiplikator liegt ausserhalb des Vertrags.",
    );
    return asset.technical.emergencyBrakeMultiplierBasisPoints;
  }));

  const accelerationMmPerS2 = Math.min(
    accelerationCapMmps2,
    Number(
      BigInt(totalStartingTractiveEffortKn) * 1_000_000n / BigInt(totalMassKg),
    ),
  );
  const unrestrictedServiceBrakeMmps2 = Math.min(
    serviceBrakeCapMmps2,
    Number(BigInt(totalBrakeWeightKg) * 9_806n / BigInt(totalMassKg)),
  );
  let decelerationMmPerS2 = unrestrictedServiceBrakeMmps2;
  const serviceRestrictions = sources.flatMap((asset) =>
    effectiveServiceBrakeMmps2(asset, "zugfolge-fleet-authority-release/v2"));
  if (serviceRestrictions.length > 0) {
    decelerationMmPerS2 = Math.min(decelerationMmPerS2, ...serviceRestrictions);
  }
  const emergencyRestrictions = sources.flatMap((asset) =>
    orderedRestrictions(asset).flatMap((restriction) =>
      typeof restriction === "object" && "emergency-brake" in restriction
        ? [restriction["emergency-brake"]]
        : []));
  let emergencyBrakeMmps2 = Number(
    BigInt(unrestrictedServiceBrakeMmps2)
      * BigInt(emergencyBrakeMultiplierBasisPoints)
      / 10_000n,
  );
  if (emergencyRestrictions.length > 0) {
    emergencyBrakeMmps2 = Math.min(emergencyBrakeMmps2, ...emergencyRestrictions);
  }
  authorityInvariant(
    Number.isSafeInteger(accelerationMmPerS2)
      && accelerationMmPerS2 > 0
      && accelerationMmPerS2 <= 10_000
      && Number.isSafeInteger(decelerationMmPerS2)
      && decelerationMmPerS2 > 0
      && decelerationMmPerS2 <= 20_000
      && Number.isSafeInteger(emergencyBrakeMmps2)
      && emergencyBrakeMmps2 > decelerationMmPerS2
      && emergencyBrakeMmps2 <= 20_000,
    "Authority-v2-Rohdynamik ergibt kein sicheres Formationsfahrprofil.",
  );
  return { accelerationMmPerS2, decelerationMmPerS2 };
}

function sameOrderedValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCheckpointBinding(
  checkpoint: FleetProducerCheckpoint,
  expectedWorldId: string,
): void {
  authorityInvariant(
    checkpoint.state.worldId === expectedWorldId
      && checkpoint.snapshot.worldId === expectedWorldId,
    "Fleet-Zustand und Mobilisierungssnapshot verletzen die Weltisolation.",
  );
  authorityInvariant(
    checkpoint.snapshot.revision === checkpoint.state.revision,
    "Fleet-Zustand und Mobilisierungssnapshot besitzen verschiedene Revisionen.",
  );
  authorityInvariant(
    checkpoint.snapshot.producedAt === checkpoint.state.producedAt,
    "Fleet-Zustand und Mobilisierungssnapshot besitzen verschiedene Zustandszeiten.",
  );
}

function checkSnapshotAvailability(
  checkpoint: FleetProducerCheckpoint,
  formation: NativeFleetFormationIntent,
  assets: readonly FleetAuthorityVehicleAsset[],
  receipt: FleetAuthorityPathReceipt,
  earliestDepartureS: number,
  latestDepartureS: number,
): void {
  const snapshotFormation = checkpoint.snapshot.formations.find(
    (candidate) => candidate.id === formation.id,
  );
  authorityInvariant(
    snapshotFormation !== undefined,
    `Formation '${formation.id}' fehlt im gebundenen Mobilisierungssnapshot.`,
  );
  authorityInvariant(
    snapshotFormation.operatorId === receipt.operatorId
      && snapshotFormation.pathReceiptId === formation.pathReceiptId
      && sameOrderedValues(snapshotFormation.vehicleIds, formation.vehicleIds)
      && sameOrderedValues(snapshotFormation.serviceLineIds, receipt.serviceLineIds),
    `Formation '${formation.id}' widerspricht ihrem gebundenen Mobilisierungssnapshot.`,
  );
  compatible(
    snapshotFormation.procurement === "delivered",
    "Formation ist aus der Beschaffung noch nicht geliefert.",
  );
  // Der Fleet-Single-Writer projiziert hier ausschließlich den spätesten
  // Lieferzeitpunkt. Die Trassen-Gültigkeit wird separat gegen das beantragte
  // Fenster geprüft und darf diese Snapshot-Ableitung nicht umdeuten.
  const expectedAvailableFrom = Math.max(...assets.map((asset) => asset.deliveredAt));
  const expectedAvailableUntil = Math.min(
    receipt.validUntil,
    ...assets.flatMap((asset) => [
      asset.retiredAt,
      ...asset.maintenanceDeadlines.map((deadline) => deadline.dueAt),
    ]),
  );
  authorityInvariant(
    snapshotFormation.availableFrom === expectedAvailableFrom
      && snapshotFormation.availableUntil === expectedAvailableUntil,
    `Formation '${formation.id}' besitzt ein manipuliertes Verfuegbarkeitsfenster.`,
  );
  compatible(
    snapshotFormation.availableFrom <= earliestDepartureS
      && snapshotFormation.availableUntil > latestDepartureS,
    "Mobilisierungssnapshot deckt das beantragte Zeitfenster nicht ab.",
  );

  const maintenanceAssignments = Object.entries(
    checkpoint.state.maintenanceAssignments ?? {},
  ).flatMap(([assignmentId, assignment]) => {
    if (assignment.formationId !== formation.id) return [];
    authorityInvariant(
      assignmentId === assignment.formationId,
      `Formation '${formation.id}' besitzt einen fremd verschluesselten Instandhaltungsauftrag.`,
    );
    authorityInvariant(
      Number.isSafeInteger(assignment.startsAtS)
        && Number.isSafeInteger(assignment.endsAtS)
        && assignment.startsAtS >= 0
        && assignment.endsAtS > assignment.startsAtS,
      `Formation '${formation.id}' besitzt einen ungueltigen Instandhaltungsauftrag.`,
    );
    return [assignment];
  });
  authorityInvariant(
    maintenanceAssignments.length <= 1,
    `Formation '${formation.id}' besitzt mehrdeutige Instandhaltungsauftraege.`,
  );
  const activeAtSnapshot = maintenanceAssignments.some(
    (assignment) => assignment.startsAtS <= checkpoint.state.producedAt
      && checkpoint.state.producedAt < assignment.endsAtS,
  );
  const hasPhysicalDrive = assets.some((asset) => asset.technical.traction !== "unpowered");
  const hasUsableFormationDrive = assets.some((asset) =>
    hasUsableDrive(asset, checkpoint.state.authorityRelease.schemaVersion));
  const technicallyImmobilized = hasPhysicalDrive && !hasUsableFormationDrive;
  authorityInvariant(
    activeAtSnapshot || technicallyImmobilized
      ? snapshotFormation.availability === "maintenance"
      : snapshotFormation.availability === "available"
        || snapshotFormation.availability === "committed",
    `Formation '${formation.id}' besitzt einen zum Zustandszeitpunkt widerspruechlichen Verfuegbarkeitsstatus.`,
  );
  compatible(
    maintenanceAssignments.every(
      (assignment) => assignment.endsAtS <= earliestDepartureS
        || assignment.startsAtS > latestDepartureS,
    ),
    "Formation befindet sich im beantragten Zeitfenster in Instandhaltung.",
  );
}

function resolveFromCheckpoint(
  checkpoint: FleetProducerCheckpoint,
  body: PlanningPlayerPathRequestBody,
  ownedOperatorId: string,
  trainIdentity: PlanningTrainIdentity,
): PlanningPathRequestBody {
  const formation = checkpoint.state.formations[body.formationId];
  if (formation === undefined) {
    throw new PlanningAuthorityError(
      "planning_formation_forbidden",
      403,
      "Formation ist fuer dieses Konto nicht verfuegbar.",
    );
  }
  const receipt = checkpoint.state.authorityRelease.pathReceipts.find(
    (candidate) => candidate.id === formation.pathReceiptId,
  );
  authorityInvariant(receipt !== undefined, "Formation verweist auf einen unbekannten Trassenbeleg.");
  if (receipt.operatorId !== ownedOperatorId) {
    throw new PlanningAuthorityError(
      "planning_formation_forbidden",
      403,
      "Formation ist fuer dieses Konto nicht verfuegbar.",
    );
  }

  const earliestDepartureS = body.desiredDepartureS - body.earlierS;
  const latestDepartureS = body.desiredDepartureS + body.laterS;
  compatible(Number.isSafeInteger(earliestDepartureS) && earliestDepartureS >= 0, "Frueheste Abfahrt liegt vor der Weltepoche.");
  compatible(Number.isSafeInteger(latestDepartureS), "Spaeteste Abfahrt ist uebergelaufen.");

  const assetsById = new Map(checkpoint.state.authorityRelease.assets.map((asset) => [asset.id, asset] as const));
  const holdings = checkpoint.state.assetHoldings;
  authorityInvariant(holdings !== undefined, "Flottenzustand besitzt keine autoritativen Halterdaten.");
  const assets = formation.vehicleIds.map((vehicleId) => {
    const asset = assetsById.get(vehicleId);
    authorityInvariant(asset !== undefined, `Formation verweist auf unbekanntes Asset '${vehicleId}'.`);
    const holding = holdings[vehicleId];
    authorityInvariant(holding !== undefined, `Asset '${vehicleId}' besitzt keinen Halterzustand.`);
    if (holding.holderOperatorId !== ownedOperatorId) {
      throw new PlanningAuthorityError(
        "planning_formation_forbidden",
        403,
        "Formation ist fuer dieses Konto nicht verfuegbar.",
      );
    }
    compatible(
      holding.validUntilS === null || holding.validUntilS > latestDepartureS,
      `Halterbindung von Asset '${vehicleId}' deckt das Zeitfenster nicht ab.`,
    );
    compatible(
      asset.deliveredAt <= earliestDepartureS && asset.retiredAt > latestDepartureS,
      `Asset '${vehicleId}' ist im Zeitfenster nicht verfuegbar.`,
    );
    compatible(
      asset.maintenanceDeadlines.every((deadline) => deadline.dueAt > latestDepartureS),
      `Instandhaltungsfreigabe von Asset '${vehicleId}' deckt das Zeitfenster nicht ab.`,
    );
    return asset;
  });
  authorityInvariant(assets.length > 0, "Formation ist leer.");
  checkSnapshotAvailability(
    checkpoint,
    formation,
    assets,
    receipt,
    earliestDepartureS,
    latestDepartureS,
  );
  checkRouteCompatibility(
    formation,
    assets,
    receipt,
    earliestDepartureS,
    latestDepartureS,
    checkpoint.state.authorityRelease.schemaVersion,
  );

  const {
    schemaVersion: _playerSchema,
    ...playerFacts
  } = body;
  return {
    schemaVersion: PLANNING_PATH_REQUEST_SCHEMA,
    ...playerFacts,
    ...trainIdentity,
    operatorId: ownedOperatorId,
    fleetRevision: checkpoint.state.revision,
    fleetStateHash: checkpoint.stateHash,
    fleetAuthorityReleaseId: checkpoint.state.authorityRelease.releaseId,
    train: trainFacts(formation, assets, checkpoint.state.authorityRelease.schemaVersion),
  };
}

/**
 * Loest einen Spielerrequest gegen den letzten atomar persistierten
 * M5-Single-Writer-Zustand auf. Ohne Zustand, Eigentum oder vollstaendige
 * Kompatibilitaetsfakten wird kein Planning-Kommando erzeugt.
 */
export async function resolveAuthoritativePlanningPathRequest(
  db: EconomyDatabase,
  input: {
    readonly worldId: string;
    readonly accountId: string;
    readonly body: PlanningPlayerPathRequestBody | unknown;
    readonly fleetRuntime?: Pick<FleetRuntime, "verifyFleetWorldState">;
  },
): Promise<PlanningPathRequestBody> {
  const body = bindPlanningPlayerPathRequest(input.body);
  let checkpoint: FleetProducerCheckpoint | undefined;
  try {
    checkpoint = await loadFleetProducerCheckpoint(db, input.worldId);
  } catch (error) {
    if (
      error instanceof FleetProducerUnavailableError
      || error instanceof FleetSnapshotValidationError
    ) {
      throw new PlanningAuthorityError(
        "planning_fleet_unavailable",
        503,
        "Autoritativer Flottenzustand ist fuer diese Welt nicht verfuegbar.",
      );
    }
    throw error;
  }
  if (checkpoint === undefined) {
    throw new PlanningAuthorityError(
      "planning_fleet_unavailable",
      503,
      "Autoritativer Flottenzustand ist fuer diese Welt nicht verfuegbar.",
    );
  }
  if (checkpoint.state.authorityRelease.schemaVersion === "zugfolge-fleet-authority-release/v2") {
    authorityInvariant(
      input.fleetRuntime !== undefined,
      "Authority-v2-Flottenzustand kann ohne native Revalidierung nicht fuer Planning verwendet werden.",
    );
    let verification: ReturnType<FleetRuntime["verifyFleetWorldState"]>;
    try {
      verification = input.fleetRuntime.verifyFleetWorldState(checkpoint.state, checkpoint.stateHash);
    } catch {
      throw new PlanningAuthorityError(
        "planning_fleet_state_invalid",
        503,
        "Persistierter Authority-v2-Flottenzustand hat die native Revalidierung nicht bestanden.",
      );
    }
    authorityInvariant(
      verification.worldId === input.worldId
        && verification.revision === checkpoint.state.revision
        && verification.producedAt === checkpoint.state.producedAt
        && verification.authorityReleaseHash === checkpoint.state.authorityReleaseHash
        && verification.stateHash === checkpoint.stateHash
        && verification.snapshotHash === checkpoint.snapshotHash,
      "Native Fleet-Revalidierung bindet nicht den vollstaendigen persistierten Checkpoint.",
    );
  }
  validateCheckpointBinding(checkpoint, input.worldId);
  const formation = checkpoint.state.formations[body.formationId];
  const receipt = formation === undefined
    ? undefined
    : checkpoint.state.authorityRelease.pathReceipts.find((candidate) => candidate.id === formation.pathReceiptId);
  const [ownedOperator] = receipt === undefined
    ? []
    : await db
        .select({ id: operators.id })
        .from(operators)
        .where(and(
          eq(operators.worldId, input.worldId),
          eq(operators.id, receipt.operatorId),
          eq(operators.foundingAccountId, input.accountId),
        ))
        .limit(1);
  if (ownedOperator === undefined) {
    throw new PlanningAuthorityError(
      "planning_formation_forbidden",
      403,
      "Formation ist fuer dieses Konto nicht verfuegbar.",
    );
  }
  // Erst nach sämtlichen Eigentums- und Kompatibilitätsprüfungen wird eine
  // Nummer verbraucht. Ein Retry desselben Antrags erhält dieselbe Reservierung.
  const validationIdentity: PlanningTrainIdentity = {
    trainId: `validation-${body.requestId}`,
    trainNumber: TRAIN_NUMBER_RANGES[body.trainCategory][0],
  };
  resolveFromCheckpoint(checkpoint, body, ownedOperator.id, validationIdentity);
  const trainIdentity = await reservePlanningTrainIdentity(db, {
    worldId: input.worldId,
    accountId: input.accountId,
    requestId: body.requestId,
    trainCategory: body.trainCategory,
  });
  return resolveFromCheckpoint(checkpoint, body, ownedOperator.id, trainIdentity);
}
