import {
  accounts,
  alphaWorldProfiles,
  ledgerAccounts,
  ledgerEntries,
  ledgerTransactions,
  operators,
  operatorStartingCapital,
  worldAccesses,
  worlds,
  type AlphaWorldProfile,
  type Operator,
} from "@zugfolge/db";
import {
  decodeEconomyValue,
  STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN,
} from "@zugfolge/economy";
import { and, eq, sql } from "drizzle-orm";

import { AlphaAuthorizationError, AlphaConflictError } from "./errors.js";
import {
  validateWorldBlueprint,
  type AlphaDatabase,
  type AlphaWorldBlueprint,
} from "./world.js";

export type StartingCapitalPolicy = AlphaWorldBlueprint["startingCapitalPolicy"];

export const STARTING_CAPITAL_EQUITY_ACCOUNT_NAME = "Economy:Eigenkapital";
export const STARTING_CAPITAL_TRANSACTION_KEY_PREFIX = "starting-capital";

export interface ValidatedPublicWorldContract {
  readonly blueprint: AlphaWorldBlueprint;
  readonly blueprintHash: string;
  readonly startingCapitalPolicy: StartingCapitalPolicy;
}

function samePolicy(left: unknown, right: StartingCapitalPolicy): boolean {
  if (typeof left !== "object" || left === null || Array.isArray(left)) return false;
  const record = left as Readonly<Record<string, unknown>>;
  return right.kind === "unlimited"
    ? record["kind"] === "unlimited" && Object.keys(record).length === 1
    : record["kind"] === "finite" && record["amountCents"] === right.amountCents && Object.keys(record).length === 2;
}

/**
 * Rekonstruiert den signiert gestarteten Weltentwurf aus JSONB und bindet alle
 * duplizierten Profilfelder wieder an dessen kanonischen Hash. Ein bloss
 * syntaktisch gueltiger Hash oder eine nachtraeglich geaenderte Policy reicht
 * damit weder fuer Zugang noch fuer EVU-Gruendung.
 */
export function validateStoredPublicWorldContract(
  profile: Pick<AlphaWorldProfile,
    | "profileKind"
    | "regionId"
    | "regionVariant"
    | "worldSeed"
    | "accelerationFactor"
    | "infraReleaseHash"
    | "timetableReleaseHash"
    | "fleetReleaseHash"
    | "economyReleaseHash"
    | "blueprint"
    | "blueprintHash"
    | "periodCount"
  >,
): ValidatedPublicWorldContract {
  let blueprint: AlphaWorldBlueprint;
  try {
    blueprint = decodeEconomyValue(profile.blueprint) as AlphaWorldBlueprint;
    const computedHash = validateWorldBlueprint(blueprint);
    if (computedHash !== profile.blueprintHash) throw new Error("Hashabweichung");
  } catch {
    throw new AlphaConflictError(
      "Der gespeicherte Weltentwurf stimmt nicht mit seinem autoritativen Hash ueberein.",
      "world_contract_invalid",
    );
  }
  if (profile.profileKind !== "public" || blueprint.profileKind !== "public"
    || profile.regionId !== blueprint.regionId
    || profile.regionVariant !== blueprint.regionVariant
    || profile.worldSeed !== blueprint.seed
    || profile.accelerationFactor !== blueprint.accelerationFactor
    || profile.periodCount !== blueprint.periodCount
    || profile.infraReleaseHash !== blueprint.releases.infra
    || profile.timetableReleaseHash !== blueprint.releases.timetable
    || profile.fleetReleaseHash !== blueprint.releases.fleet
    || profile.economyReleaseHash !== blueprint.releases.economy) {
    throw new AlphaConflictError(
      "Weltprofil und autoritativer Weltentwurf besitzen verschiedene Vertragsdaten.",
      "world_contract_invalid",
    );
  }
  return Object.freeze({
    blueprint,
    blueprintHash: profile.blueprintHash,
    startingCapitalPolicy: blueprint.startingCapitalPolicy.kind === "unlimited"
      ? Object.freeze({ kind: "unlimited" as const })
      : Object.freeze({ kind: "finite" as const, amountCents: blueprint.startingCapitalPolicy.amountCents }),
  });
}

async function ensureLedgerAccount(
  db: AlphaDatabase,
  worldId: string,
  operatorId: string,
  name: string,
): Promise<string> {
  const [created] = await db.insert(ledgerAccounts).values({ worldId, operatorId, name })
    .onConflictDoNothing({ target: [ledgerAccounts.worldId, ledgerAccounts.operatorId, ledgerAccounts.name] })
    .returning({ id: ledgerAccounts.id });
  if (created !== undefined) return created.id;
  const [existing] = await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(
    eq(ledgerAccounts.worldId, worldId),
    eq(ledgerAccounts.operatorId, operatorId),
    eq(ledgerAccounts.name, name),
  )).limit(1);
  if (existing === undefined) throw new Error("Startkapitalkonto konnte nicht gelesen werden.");
  return existing.id;
}

async function readLedgerAccountId(
  db: AlphaDatabase,
  worldId: string,
  operatorId: string,
  name: string,
): Promise<string | undefined> {
  const [account] = await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(
    eq(ledgerAccounts.worldId, worldId),
    eq(ledgerAccounts.operatorId, operatorId),
    eq(ledgerAccounts.name, name),
  )).limit(1);
  return account?.id;
}

async function verifyFiniteCapitalTransaction(
  db: AlphaDatabase,
  input: {
    readonly worldId: string;
    readonly operatorId: string;
    readonly transactionId: string;
    readonly cashAccountId: string;
    readonly equityAccountId: string;
    readonly amountCents: bigint;
  },
): Promise<void> {
  const entries = await db.select({
    ledgerAccountId: ledgerEntries.ledgerAccountId,
    amountCents: ledgerEntries.amountCents,
    costType: ledgerEntries.costType,
    costCentreId: ledgerEntries.costCentreId,
  }).from(ledgerEntries).where(and(
    eq(ledgerEntries.worldId, input.worldId),
    eq(ledgerEntries.transactionId, input.transactionId),
  ));
  const expected = new Map([
    [input.cashAccountId, input.amountCents],
    [input.equityAccountId, -input.amountCents],
  ]);
  if (entries.length !== 2 || entries.some((entry) => expected.get(entry.ledgerAccountId) !== entry.amountCents
    || entry.costType !== null || entry.costCentreId !== null)) {
    throw new AlphaConflictError(
      "Bestehende Startkapitalbuchung stimmt nicht mit dem bestaetigten Weltvertrag ueberein.",
      "starting_capital_ledger_conflict",
    );
  }
}

async function completedReplay(
  db: AlphaDatabase,
  input: {
    readonly worldId: string;
    readonly name: string;
    readonly blueprintHash: string;
    readonly policy: StartingCapitalPolicy;
    readonly accountId: string;
  },
): Promise<Operator | undefined> {
  const [start] = await db.select().from(operatorStartingCapital).where(and(
    eq(operatorStartingCapital.worldId, input.worldId),
    eq(operatorStartingCapital.accountId, input.accountId),
  )).limit(1);
  if (start === undefined) return undefined;
  const expectedAmount = input.policy.kind === "finite" ? BigInt(input.policy.amountCents) : null;
  if (start.blueprintHash !== input.blueprintHash || start.policyKind !== input.policy.kind
    || start.finiteAmountCents !== expectedAmount || start.operatorId === null || start.appliedAt === null
    || (input.policy.kind === "finite" ? start.ledgerTransactionId === null : start.ledgerTransactionId !== null)) {
    throw new AlphaConflictError(
      "EVU-Start ist bereits an einen anderen Weltvertrag gebunden.",
      "starting_capital_contract_conflict",
    );
  }
  const [operator] = await db.select().from(operators).where(and(
    eq(operators.worldId, input.worldId),
    eq(operators.id, start.operatorId),
    eq(operators.foundingAccountId, input.accountId),
  )).limit(1);
  if (operator === undefined) throw new AlphaConflictError("Gebundener EVU-Start ist unvollstaendig.", "starting_capital_incomplete");
  if (operator.name !== input.name) throw new AlphaConflictError("In dieser oeffentlichen Welt besteht bereits ein eigenes EVU.", "public_operator_limit");

  const cashAccountId = await readLedgerAccountId(
    db,
    input.worldId,
    operator.id,
    STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName,
  );
  const equityAccountId = await readLedgerAccountId(
    db,
    input.worldId,
    operator.id,
    STARTING_CAPITAL_EQUITY_ACCOUNT_NAME,
  );
  if (cashAccountId === undefined || equityAccountId === undefined) {
    throw new AlphaConflictError("Gebundene Startkapitalkonten fehlen.", "starting_capital_incomplete");
  }
  const idempotencyKey = `${STARTING_CAPITAL_TRANSACTION_KEY_PREFIX}:${input.blueprintHash}`;
  const [transaction] = await db.select().from(ledgerTransactions).where(and(
    eq(ledgerTransactions.worldId, input.worldId),
    eq(ledgerTransactions.operatorId, operator.id),
    eq(ledgerTransactions.idempotencyKey, idempotencyKey),
  )).limit(1);
  if (input.policy.kind === "unlimited") {
    if (transaction !== undefined) {
      throw new AlphaConflictError("Unlimited darf keine numerische Startbuchung besitzen.", "starting_capital_ledger_conflict");
    }
    return operator;
  }
  if (transaction === undefined || transaction.id !== start.ledgerTransactionId
    || transaction.description !== `Startkapital aus Weltvertrag ${input.blueprintHash}`
    || transaction.postedAt.getTime() !== operator.foundedAt.getTime()) {
    throw new AlphaConflictError(
      "Bestehende Startkapitalbuchung stimmt nicht mit dem bestaetigten Weltvertrag ueberein.",
      "starting_capital_ledger_conflict",
    );
  }
  await verifyFiniteCapitalTransaction(db, {
    worldId: input.worldId,
    operatorId: operator.id,
    transactionId: transaction.id,
    cashAccountId,
    equityAccountId,
    amountCents: expectedAmount!,
  });
  return operator;
}

/**
 * Gruendet das erste Spieler-EVU einer oeffentlichen Welt und materialisiert
 * dessen StartingCapitalPolicy in derselben Datenbanktransaktion. Der
 * Claimschluessel Welt x Konto macht Retry und Parallelaufruf idempotent.
 */
export async function foundPublicOperatorWithStartingCapital(
  db: AlphaDatabase,
  input: {
    readonly worldId: string;
    readonly foundingKeycloakSubject: string;
    readonly name: string;
  },
): Promise<Operator> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select ${alphaWorldProfiles.worldId} from ${alphaWorldProfiles} where ${alphaWorldProfiles.worldId} = ${input.worldId} for update`);
    const [world] = await tx.select().from(worlds).where(eq(worlds.id, input.worldId)).limit(1);
    const [profile] = await tx.select().from(alphaWorldProfiles).where(eq(alphaWorldProfiles.worldId, input.worldId)).limit(1);
    if (world?.worldKind !== "public" || world.rankingStatus !== "ranked"
      || world.lifecycleStatus !== "active" || profile?.state !== "running") {
      throw new AlphaConflictError("StartingCapitalPolicy gilt nur fuer eine gestartete oeffentliche Wettbewerbswelt.", "public_world_required");
    }
    const contract = validateStoredPublicWorldContract(profile);
    const [member] = await tx.select({ account: accounts, access: worldAccesses }).from(accounts).innerJoin(
      worldAccesses,
      and(eq(accounts.worldId, worldAccesses.worldId), eq(accounts.keycloakSubject, worldAccesses.keycloakSubject)),
    ).where(and(
      eq(accounts.worldId, input.worldId),
      eq(accounts.keycloakSubject, input.foundingKeycloakSubject),
      eq(worldAccesses.status, "active"),
    )).limit(1);
    if (member === undefined) throw new AlphaAuthorizationError("Kein bestaetigter Zugang zur oeffentlichen Welt.");
    if (member.access.acceptedWorldContractHash !== contract.blueprintHash
      || !samePolicy(member.access.acceptedStartingCapitalPolicy, contract.startingCapitalPolicy)) {
      throw new AlphaConflictError(
        "EVU-Gruendung verlangt den unveraenderten, bestaetigten Weltvertrag.",
        "world_contract_confirmation_required",
      );
    }

    const replay = await completedReplay(tx, {
      worldId: input.worldId,
      name: input.name,
      blueprintHash: contract.blueprintHash,
      policy: contract.startingCapitalPolicy,
      accountId: member.account.id,
    });
    if (replay !== undefined) return replay;

    const policy = contract.startingCapitalPolicy;
    const [claim] = await tx.insert(operatorStartingCapital).values({
      worldId: input.worldId,
      accountId: member.account.id,
      blueprintHash: contract.blueprintHash,
      policyKind: policy.kind,
      finiteAmountCents: policy.kind === "finite" ? BigInt(policy.amountCents) : null,
    }).onConflictDoNothing().returning();
    if (claim === undefined) {
      const wonByOtherRequest = await completedReplay(tx, {
        worldId: input.worldId,
        name: input.name,
        blueprintHash: contract.blueprintHash,
        policy,
        accountId: member.account.id,
      });
      if (wonByOtherRequest === undefined) throw new AlphaConflictError("Paralleler EVU-Start ist noch nicht vollstaendig.", "starting_capital_race");
      return wonByOtherRequest;
    }

    const owned = await tx.select().from(operators).where(and(
      eq(operators.worldId, input.worldId),
      eq(operators.foundingAccountId, member.account.id),
    ));
    if (owned.length > 1 || (owned[0] !== undefined && owned[0].name !== input.name)) {
      throw new AlphaConflictError("In dieser oeffentlichen Welt besteht bereits ein eigenes EVU.", "public_operator_limit");
    }
    let operator = owned[0];
    if (operator === undefined) {
      [operator] = await tx.insert(operators).values({
        worldId: input.worldId,
        foundingAccountId: member.account.id,
        name: input.name,
      }).returning();
    }
    if (operator === undefined) throw new Error("Oeffentliches EVU konnte nicht angelegt werden.");

    const cashAccountId = await ensureLedgerAccount(tx, input.worldId, operator.id, STANDARD_ECONOMY_LEDGER_ACCOUNT_PLAN.cashAccountName);
    const equityAccountId = await ensureLedgerAccount(tx, input.worldId, operator.id, STARTING_CAPITAL_EQUITY_ACCOUNT_NAME);
    let transactionId: string | null = null;
    if (policy.kind === "finite") {
      const amountCents = BigInt(policy.amountCents);
      const idempotencyKey = `${STARTING_CAPITAL_TRANSACTION_KEY_PREFIX}:${contract.blueprintHash}`;
      let [transaction] = await tx.insert(ledgerTransactions).values({
        worldId: input.worldId,
        operatorId: operator.id,
        idempotencyKey,
        description: `Startkapital aus Weltvertrag ${contract.blueprintHash}`,
        postedAt: operator.foundedAt,
      }).onConflictDoNothing({
        target: [ledgerTransactions.worldId, ledgerTransactions.operatorId, ledgerTransactions.idempotencyKey],
      }).returning();
      if (transaction === undefined) {
        [transaction] = await tx.select().from(ledgerTransactions).where(and(
          eq(ledgerTransactions.worldId, input.worldId),
          eq(ledgerTransactions.operatorId, operator.id),
          eq(ledgerTransactions.idempotencyKey, idempotencyKey),
        )).limit(1);
      } else {
        await tx.insert(ledgerEntries).values([
          { worldId: input.worldId, transactionId: transaction.id, ledgerAccountId: cashAccountId, amountCents },
          { worldId: input.worldId, transactionId: transaction.id, ledgerAccountId: equityAccountId, amountCents: -amountCents },
        ]);
      }
      if (transaction === undefined) throw new Error("Startkapitalbuchung konnte nicht gelesen werden.");
      await verifyFiniteCapitalTransaction(tx, {
        worldId: input.worldId,
        operatorId: operator.id,
        transactionId: transaction.id,
        cashAccountId,
        equityAccountId,
        amountCents,
      });
      transactionId = transaction.id;
    }

    const [completed] = await tx.update(operatorStartingCapital).set({
      operatorId: operator.id,
      ledgerTransactionId: transactionId,
      appliedAt: operator.foundedAt,
    }).where(and(
      eq(operatorStartingCapital.worldId, input.worldId),
      eq(operatorStartingCapital.accountId, member.account.id),
    )).returning();
    if (completed === undefined) throw new Error("EVU-Start konnte nicht abgeschlossen werden.");
    return operator;
  });
}
