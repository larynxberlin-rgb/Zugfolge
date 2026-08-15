import { createHash } from "node:crypto";

import { operators, planningTrainNumbers, simulationCommands, worlds } from "@zugfolge/db";
import {
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
  FleetAuthorityPathReceipt,
  FleetAuthorityVehicleAsset,
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
): readonly FleetAuthorityVehicleAsset[] {
  const ordered = formation.vehicleIds.map((vehicleId) => assetsById.get(vehicleId)!);
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

function canUseElectrification(
  asset: FleetAuthorityVehicleAsset,
  electrification: FleetAuthorityPathReceipt["electrifications"][number],
): boolean {
  switch (asset.technical.traction) {
    case "unpowered":
      return false;
    case "diesel":
    case "battery":
      return true;
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
  const driving = drivingAssets(formation, assetsById);
  compatible(
    receipt.requiredProtection.every((system) => driving.every((asset) => asset.installedProtection.includes(system))),
    "Formation besitzt nicht die erforderliche Zugsicherung.",
  );

  const powered = assets.filter((asset) => asset.technical.traction !== "unpowered");
  compatible(powered.length > 0, "Formation besitzt kein Traktionsfahrzeug.");
  compatible(receipt.electrifications.length > 0, "Trassenbeleg besitzt keine Elektrifizierungsfakten.");
  compatible(
    receipt.electrifications.every((electrification) =>
      powered.every((asset) => canUseElectrification(asset, electrification))),
    "Formation ist mit der Elektrifizierung der Trasse nicht kompatibel.",
  );
}

function trainFacts(
  formation: NativeFleetFormationIntent,
  assets: readonly FleetAuthorityVehicleAsset[],
): PlanningPathRequestBody["train"] {
  const powered = assets.filter((asset) => asset.technical.traction !== "unpowered");
  compatible(powered.length > 0, "Formation besitzt kein Traktionsfahrzeug.");
  const accelerationMmPerS2 = formation.dynamics?.accelerationMmPerS2
    ?? Math.min(...powered.map((asset) => asset.technical.accelerationMmPerS2 ?? 0));
  const decelerationMmPerS2 = formation.dynamics?.decelerationMmPerS2
    ?? Math.min(...powered.map((asset) => asset.technical.decelerationMmPerS2 ?? 0));
  positiveInteger(accelerationMmPerS2, "Formationsbeschleunigung");
  positiveInteger(decelerationMmPerS2, "Formationsbremsvermoegen");
  const maximumSpeedsKph = assets.map((asset) => asset.technical.maximumSpeedKph);
  maximumSpeedsKph.forEach((speed) => positiveInteger(speed, "Fahrzeughoechstgeschwindigkeit"));
  return {
    numericId: stableNumericId(formation.id),
    name: formation.id,
    massKg: addExact(assets.map((asset) => asset.technical.massKg), "Formationsmasse"),
    lengthMm: addExact(assets.map((asset) => asset.technical.lengthMm), "Formationslaenge"),
    maximumSpeedKph: Math.min(...maximumSpeedsKph),
    accelerationMmPerS2,
    decelerationMmPerS2,
  };
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
  checkRouteCompatibility(formation, assets, receipt, earliestDepartureS, latestDepartureS);

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
    train: trainFacts(formation, assets),
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
  },
): Promise<PlanningPathRequestBody> {
  const body = bindPlanningPlayerPathRequest(input.body);
  const checkpoint = await loadFleetProducerCheckpoint(db, input.worldId);
  if (checkpoint === undefined) {
    throw new PlanningAuthorityError(
      "planning_fleet_unavailable",
      503,
      "Autoritativer Flottenzustand ist fuer diese Welt nicht verfuegbar.",
    );
  }
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
