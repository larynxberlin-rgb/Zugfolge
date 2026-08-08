/**
 * Game-API (M2) — Keycloak-Authentifizierung, Konten, Rollen, Weltzugänge
 * (M2.1), EVU (M2.3), Ledger-Kern (M2.4), Postfach (M2.5), Datenschutz
 * (M2.6).
 *
 * `buildApp` nimmt seine Abhängigkeiten entgegen, statt sie selbst
 * aufzubauen: Produktion verdrahtet eine echte Postgres-Verbindung und den
 * echten Keycloak-Realm (`server.ts`), Tests verdrahten PGlite und ein
 * lokales Schlüsselpaar (`app.test.ts`). Beide laufen über denselben Code.
 */

import { accounts, createDatabaseHealthCheck } from "@zugfolge/db";
import {
  DuplicateLedgerAccountNameError,
  ForeignLedgerAccountError,
  IncompleteTransactionError,
  ledgerAccountBalance,
  listLedgerAccounts,
  listLedgerTransactions,
  openLedgerAccount,
  postLedgerTransaction,
  UnbalancedTransactionError,
} from "@zugfolge/economy";
import { runHealthChecks, type HealthCheck } from "@zugfolge/health";
import {
  AccessRevokedError,
  AccountNotFoundError,
  AuthorizationError,
  getAccount,
  grantRole,
  isRole,
  listAccountsForSubject,
  listAccountsInWorld,
  requestWorldAccess,
  type IdentityDatabase,
} from "@zugfolge/identity";
import { acknowledgeMessage, listInbox, MessageNotFoundError, RecipientNotFoundError, sendMessage } from "@zugfolge/mailbox";
import {
  DuplicateOperatorNameError,
  foundOperator,
  getOperator,
  listOperatorsForAccount,
  listOperatorsInWorld,
  NoAccountInWorldError,
  OperatorNotFoundError,
} from "@zugfolge/operators";
import { eraseAccountData, exportAccountData, PersonalDataNotFoundError } from "@zugfolge/privacy";
import { and, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

import { createAuthenticator, type TokenVerifier } from "./auth.js";

export interface AppDependencies {
  readonly db: IdentityDatabase;
  readonly verifyToken: TokenVerifier;
  /**
   * Zusätzliche Prüfungen für `/health/ready`, über die Datenbankverbindung
   * hinaus — der Erweiterungspunkt, an dem künftige Milestones ihre eigenen
   * Health Checks anmelden, statt sie später nachzuziehen.
   */
  readonly extraHealthChecks?: readonly HealthCheck[];
}

const worldIdParam = {
  type: "object",
  required: ["worldId"],
  properties: { worldId: { type: "string", format: "uuid" } },
} as const;

const cents = { type: "string", pattern: "^-?[0-9]+$" } as const;

async function requireOperatorOwner(
  db: IdentityDatabase,
  worldId: string,
  operatorId: string,
  keycloakSubject: string,
): Promise<void> {
  const operator = await getOperator(db, { worldId, operatorId });
  const account = await getAccount(db, { worldId, keycloakSubject });
  if (account === undefined || account.id !== operator.foundingAccountId) {
    throw new AuthorizationError(`Nur das gründende Konto führt die Bücher von EVU '${operatorId}'.`);
  }
}

async function requireWorldAdminAccount(db: IdentityDatabase, worldId: string, keycloakSubject: string): Promise<void> {
  const account = await getAccount(db, { worldId, keycloakSubject });
  if (account === undefined || !account.roles.includes("world_admin")) {
    throw new AuthorizationError(`Konto ist kein Weltverwalter von '${worldId}'.`);
  }
}

async function resolveKeycloakSubject(db: IdentityDatabase, worldId: string, accountId: string): Promise<string> {
  const [row] = await db
    .select({ keycloakSubject: accounts.keycloakSubject })
    .from(accounts)
    .where(and(eq(accounts.worldId, worldId), eq(accounts.id, accountId)))
    .limit(1);
  if (row === undefined) {
    throw new AccountNotFoundError(accountId, worldId);
  }
  return row.keycloakSubject;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof AccessRevokedError ||
    error instanceof AuthorizationError ||
    error instanceof NoAccountInWorldError ||
    error instanceof ForeignLedgerAccountError
  ) {
    return reply.code(403).send({ error: error.message });
  }
  if (
    error instanceof AccountNotFoundError ||
    error instanceof OperatorNotFoundError ||
    error instanceof RecipientNotFoundError ||
    error instanceof MessageNotFoundError ||
    error instanceof PersonalDataNotFoundError
  ) {
    return reply.code(404).send({ error: error.message });
  }
  if (error instanceof DuplicateOperatorNameError || error instanceof DuplicateLedgerAccountNameError) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof IncompleteTransactionError || error instanceof UnbalancedTransactionError) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const authenticate = createAuthenticator(deps.verifyToken);

  // `/health` ist Liveness: läuft der Prozess, ohne jede Abhängigkeit zu
  // prüfen. `/health/ready` ist Readiness für Status- und Monitoringdienste:
  // sie fragt die Registry, die sich aus der Datenbankprüfung und den
  // Erweiterungen jedes weiteren Milestones zusammensetzt (M9.5 baut darauf
  // auf, nicht darauf um).
  const healthChecks: readonly HealthCheck[] = [createDatabaseHealthCheck(deps.db), ...(deps.extraHealthChecks ?? [])];

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const report = await runHealthChecks(healthChecks);
    return reply.code(report.status === "down" ? 503 : 200).send(report);
  });

  // ---------------------------------------------------------------------
  // M2.1 — Weltzugang, Konto, Rolle
  // ---------------------------------------------------------------------

  app.post<{ Params: { worldId: string }; Body: { displayName: string } }>(
    "/worlds/:worldId/access",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["displayName"],
          properties: { displayName: { type: "string", minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const account = await requestWorldAccess(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
          displayName: request.body.displayName,
        });
        return reply.code(201).send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/accounts",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const roster = await listAccountsInWorld(deps.db, {
          worldId: request.params.worldId,
          requestingKeycloakSubject: identity.keycloakSubject,
        });
        return reply.send(roster);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string; accountId: string }; Body: { role: string } }>(
    "/worlds/:worldId/accounts/:accountId/roles",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "accountId"],
          properties: {
            worldId: { type: "string", format: "uuid" },
            accountId: { type: "string", format: "uuid" },
          },
        },
        body: { type: "object", required: ["role"], properties: { role: { type: "string" } } },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      if (!isRole(request.body.role)) {
        return reply.code(400).send({ error: `Unbekannte Rolle '${request.body.role}'.` });
      }
      try {
        const account = await grantRole(deps.db, {
          worldId: request.params.worldId,
          targetAccountId: request.params.accountId,
          role: request.body.role,
          actingKeycloakSubject: identity.keycloakSubject,
        });
        return reply.send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get("/me/worlds", { preHandler: authenticate }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) {
      return reply.code(401).send({ error: "Keine Identität." });
    }
    const memberships = await listAccountsForSubject(deps.db, identity.keycloakSubject);
    return reply.send(memberships);
  });

  // ---------------------------------------------------------------------
  // M2.3 — EVU: Gründung, Liste
  // ---------------------------------------------------------------------

  app.post<{ Params: { worldId: string }; Body: { name: string } }>(
    "/worlds/:worldId/operators",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const operator = await foundOperator(deps.db, {
          worldId: request.params.worldId,
          foundingKeycloakSubject: identity.keycloakSubject,
          name: request.body.name,
        });
        return reply.code(201).send(operator);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/operators",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const roster = await listOperatorsInWorld(deps.db, {
          worldId: request.params.worldId,
          requestingKeycloakSubject: identity.keycloakSubject,
        });
        return reply.send(roster);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get("/me/operators", { preHandler: authenticate }, async (request, reply) => {
    const identity = request.identity;
    if (identity === undefined) {
      return reply.code(401).send({ error: "Keine Identität." });
    }
    const eigene = await listOperatorsForAccount(deps.db, identity.keycloakSubject);
    return reply.send(eigene);
  });

  // ---------------------------------------------------------------------
  // M2.4 — Ledger-Kern: Konten, Transaktionen, Salden
  // ---------------------------------------------------------------------

  const operatorIdParam = {
    type: "object",
    required: ["worldId", "operatorId"],
    properties: {
      worldId: { type: "string", format: "uuid" },
      operatorId: { type: "string", format: "uuid" },
    },
  } as const;

  app.post<{ Params: { worldId: string; operatorId: string }; Body: { name: string } }>(
    "/worlds/:worldId/operators/:operatorId/ledger/accounts",
    {
      preHandler: authenticate,
      schema: {
        params: operatorIdParam,
        body: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 } } },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const account = await openLedgerAccount(deps.db, {
          worldId: request.params.worldId,
          operatorId: request.params.operatorId,
          name: request.body.name,
        });
        return reply.code(201).send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/ledger/accounts",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const ledgerAccounts = await listLedgerAccounts(deps.db, {
          worldId: request.params.worldId,
          operatorId: request.params.operatorId,
        });
        const withBalances = await Promise.all(
          ledgerAccounts.map(async (account) => {
            const balanceCents = await ledgerAccountBalance(deps.db, {
              worldId: request.params.worldId,
              ledgerAccountId: account.id,
            });
            return { ...account, balanceCents: balanceCents.toString() };
          }),
        );
        return reply.send(withBalances);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; operatorId: string };
    Body: { description: string; entries: readonly { ledgerAccountId: string; amountCents: string }[] };
  }>(
    "/worlds/:worldId/operators/:operatorId/ledger/transactions",
    {
      preHandler: authenticate,
      schema: {
        params: operatorIdParam,
        body: {
          type: "object",
          required: ["description", "entries"],
          properties: {
            description: { type: "string", minLength: 1 },
            entries: {
              type: "array",
              minItems: 2,
              items: {
                type: "object",
                required: ["ledgerAccountId", "amountCents"],
                properties: { ledgerAccountId: { type: "string", format: "uuid" }, amountCents: cents },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const transaction = await postLedgerTransaction(deps.db, {
          worldId: request.params.worldId,
          operatorId: request.params.operatorId,
          description: request.body.description,
          postedAt: new Date(),
          entries: request.body.entries.map((entry) => ({
            ledgerAccountId: entry.ledgerAccountId,
            amountCents: BigInt(entry.amountCents),
          })),
        });
        return reply.code(201).send(transaction);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string; operatorId: string } }>(
    "/worlds/:worldId/operators/:operatorId/ledger/transactions",
    { preHandler: authenticate, schema: { params: operatorIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireOperatorOwner(deps.db, request.params.worldId, request.params.operatorId, identity.keycloakSubject);
        const list = await listLedgerTransactions(deps.db, {
          worldId: request.params.worldId,
          operatorId: request.params.operatorId,
        });
        return reply.send(list);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  // ---------------------------------------------------------------------
  // M2.5 — Postfach: Liste, Quittierung, Versand (Weltverwalter)
  // ---------------------------------------------------------------------

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/mailbox",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const inbox = await listInbox(deps.db, {
          worldId: request.params.worldId,
          requestingKeycloakSubject: identity.keycloakSubject,
        });
        return reply.send(inbox);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string; messageId: string } }>(
    "/worlds/:worldId/mailbox/:messageId/ack",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "messageId"],
          properties: { worldId: { type: "string", format: "uuid" }, messageId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const message = await acknowledgeMessage(deps.db, {
          worldId: request.params.worldId,
          messageId: request.params.messageId,
          actingKeycloakSubject: identity.keycloakSubject,
          acknowledgedAt: new Date(),
        });
        return reply.send(message);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string; accountId: string };
    Body: { messageType: string; payload: unknown; deadlineAt?: string };
  }>(
    "/worlds/:worldId/accounts/:accountId/mailbox",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "accountId"],
          properties: { worldId: { type: "string", format: "uuid" }, accountId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["messageType", "payload"],
          properties: {
            messageType: { type: "string", minLength: 1 },
            payload: {},
            deadlineAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        await requireWorldAdminAccount(deps.db, request.params.worldId, identity.keycloakSubject);
        const message = await sendMessage(deps.db, {
          worldId: request.params.worldId,
          recipientAccountId: request.params.accountId,
          messageType: request.body.messageType,
          payload: request.body.payload,
          deadlineAt: request.body.deadlineAt === undefined ? undefined : new Date(request.body.deadlineAt),
        });
        return reply.code(201).send(message);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  // ---------------------------------------------------------------------
  // M2.6 — Datenschutz: Auskunft, Löschung
  // ---------------------------------------------------------------------

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/me/export",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const auskunft = await exportAccountData(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
          exportedAt: new Date(),
        });
        return reply.send(auskunft);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string } }>(
    "/worlds/:worldId/me/erase",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const account = await eraseAccountData(deps.db, {
          worldId: request.params.worldId,
          targetKeycloakSubject: identity.keycloakSubject,
          actingKeycloakSubject: identity.keycloakSubject,
          erasedAt: new Date(),
        });
        return reply.send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { worldId: string; accountId: string } }>(
    "/worlds/:worldId/accounts/:accountId/erase",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          required: ["worldId", "accountId"],
          properties: { worldId: { type: "string", format: "uuid" }, accountId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) {
        return reply.code(401).send({ error: "Keine Identität." });
      }
      try {
        const targetKeycloakSubject = await resolveKeycloakSubject(
          deps.db,
          request.params.worldId,
          request.params.accountId,
        );
        const account = await eraseAccountData(deps.db, {
          worldId: request.params.worldId,
          targetKeycloakSubject,
          actingKeycloakSubject: identity.keycloakSubject,
          erasedAt: new Date(),
        });
        return reply.send(account);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  return app;
}
