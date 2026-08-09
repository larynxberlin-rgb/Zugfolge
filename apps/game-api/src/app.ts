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

import { timingSafeEqual } from "node:crypto";

import { accounts, createDatabaseHealthCheck, EventSequenceError, simulationCommands, worldEventLog, worlds } from "@zugfolge/db";
import {
  DuplicateLedgerAccountNameError,
  ForeignLedgerAccountError,
  encodeEconomyValue,
  IncompleteTransactionError,
  ledgerAccountBalance,
  listLedgerAccounts,
  listLedgerTransactions,
  loadEconomyWorldState,
  openLedgerAccount,
  postLedgerTransaction,
  UnbalancedTransactionError,
} from "@zugfolge/economy";
import { runHealthChecks, type HealthCheck } from "@zugfolge/health";
import { LivemapCapacityError, type LiveDelta, type LivemapRegistry } from "@zugfolge/livemap-stream";
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
import { and, asc, eq } from "drizzle-orm";
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
  /** Öffentlicher, weltisolierter Livemap-Fanout (M4.6). */
  readonly livemap?: LivemapRegistry;
  /** Geteiltes Geheimnis des internen Simulations-zu-Livemap-Adapters. */
  readonly livemapIngestToken?: string;
  /** Geteiltes Geheimnis des Simulations-Eventlog-Adapters. */
  readonly simulationIngestToken?: string;
  /** Hartes Zeitbudget jedes Readiness-Checks. */
  readonly healthCheckTimeoutMs?: number;
  /** Produktion protokolliert strukturiert; Tests dürfen den Logger abschalten. */
  readonly logger?: boolean;
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
  if (error instanceof DuplicateOperatorNameError || error instanceof DuplicateLedgerAccountNameError || error instanceof EventSequenceError) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof IncompleteTransactionError || error instanceof UnbalancedTransactionError) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function worldExists(db: IdentityDatabase, worldId: string): Promise<boolean> {
  const [world] = await db
    .select({ id: worlds.id })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  return world !== undefined;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? process.env["NODE_ENV"] !== "test" });
  const authenticate = createAuthenticator(deps.verifyToken);

  // `/health` ist Liveness: läuft der Prozess, ohne jede Abhängigkeit zu
  // prüfen. `/health/ready` ist Readiness für Status- und Monitoringdienste:
  // sie fragt die Registry, die sich aus der Datenbankprüfung und den
  // Erweiterungen jedes weiteren Milestones zusammensetzt (M9.5 baut darauf
  // auf, nicht darauf um).
  const healthChecks: readonly HealthCheck[] = [createDatabaseHealthCheck(deps.db), ...(deps.extraHealthChecks ?? [])];

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const report = await runHealthChecks(healthChecks, {
      timeoutMs: deps.healthCheckTimeoutMs ?? 2_000,
      onError: (healthCheck, error) => {
        app.log.error({ err: error, healthCheck }, "Readiness-Prüfung fehlgeschlagen");
      },
    });
    return reply.code(report.status === "down" ? 503 : 200).send(report);
  });

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/economy/state",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const account = await getAccount(deps.db, {
          worldId: request.params.worldId,
          keycloakSubject: identity.keycloakSubject,
        });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const state = await loadEconomyWorldState(deps.db, request.params.worldId);
        if (state === undefined) return reply.code(404).send({ error: "Wirtschaftswelt ist noch nicht gestartet." });
        return reply.send(encodeEconomyValue(state));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  if (deps.livemap !== undefined && deps.livemapIngestToken !== undefined) {
    app.post<{
      Params: { worldId: string };
      Body: Omit<LiveDelta, "worldId" | "sequence">;
    }>(
      "/internal/worlds/:worldId/livemap/deltas",
      {
        schema: {
          params: worldIdParam,
          body: {
            type: "object",
            required: ["at", "changed", "removed"],
            additionalProperties: false,
            properties: {
              at: { type: "integer", minimum: 0 },
              removed: { type: "array", items: { type: "string", minLength: 1 } },
              changed: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "operator", "trainNumber", "category", "positionMm", "speedMmPerSecond", "delaySeconds", "nextOperatingPoint", "status"],
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", minLength: 1 },
                    operator: { type: "string" },
                    trainNumber: { type: "string" },
                    category: { type: "string" },
                    positionMm: { type: "integer" },
                    speedMmPerSecond: { type: "integer" },
                    delaySeconds: { type: "integer" },
                    nextOperatingPoint: { type: "string" },
                    status: { type: "string", minLength: 1 },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.livemapIngestToken!)) {
          return reply.code(401).send({ error: "Ungültige Livemap-Ingest-Autorisierung." });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) {
          return reply.code(404).send({ error: "Welt existiert nicht." });
        }
        try {
          return reply.code(202).send(deps.livemap!.forWorld(request.params.worldId).publish(request.body));
        } catch (error) {
          if (error instanceof LivemapCapacityError) return reply.code(503).send({ error: "Livemap-Kapazität erschöpft." });
          throw error;
        }
      },
    );
  }

  if (deps.simulationIngestToken !== undefined) {
    app.post<{
      Params: { worldId: string };
      Body: { readonly events: readonly { readonly sequence: number; readonly eventType: string; readonly payload: unknown; readonly occurredAt: string }[] };
    }>(
      "/internal/worlds/:worldId/simulation/events",
      {
        schema: {
          params: worldIdParam,
          body: {
            type: "object",
            required: ["events"],
            additionalProperties: false,
            properties: {
              events: {
                type: "array",
                minItems: 1,
                maxItems: 1_000,
                items: {
                  type: "object",
                  required: ["sequence", "eventType", "payload", "occurredAt"],
                  additionalProperties: false,
                  properties: {
                    sequence: { type: "integer", minimum: 1 },
                    eventType: { type: "string", minLength: 1, maxLength: 128 },
                    payload: {},
                    occurredAt: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.simulationIngestToken!)) {
          return reply.code(401).send({ error: "Ungültige Simulations-Ingest-Autorisierung." });
        }
        if (!(await worldExists(deps.db, request.params.worldId))) return reply.code(404).send({ error: "Welt existiert nicht." });
        try {
          const appended = await worldEventLog(deps.db, request.params.worldId).appendBatch(
            request.body.events.map((event) => ({ ...event, occurredAt: new Date(event.occurredAt) })),
          );
          return reply.code(202).send({ appended: appended.length, lastSequence: appended.at(-1)?.sequence });
        } catch (error) {
          return sendError(reply, error);
        }
      },
    );
  }

  app.get<{ Params: { worldId: string }; Querystring: { after?: number; limit?: number } }>(
    "/worlds/:worldId/simulation/events",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        querystring: {
          type: "object",
          properties: {
            after: { type: "integer", minimum: 0, default: 0 },
            limit: { type: "integer", minimum: 1, maximum: 5_000, default: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        return reply.send(
          await worldEventLog(deps.db, request.params.worldId).listAfter(
            request.query.after ?? 0,
            request.query.limit ?? 500,
          ),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/planning/diagram",
    { preHandler: authenticate, schema: { params: worldIdParam } },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const event = await worldEventLog(deps.db, request.params.worldId).latestOfType("planning.diagram");
        if (event === undefined) return reply.code(404).send({ error: "Noch kein Planner-Ergebnis veröffentlicht." });
        return reply.send({ sequence: event.sequence, data: event.payload });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{
    Params: { worldId: string };
    Body: { readonly idempotencyKey: string; readonly trainId: string; readonly conflictId: string; readonly shiftMinutes: number };
  }>(
    "/worlds/:worldId/planning/alternatives",
    {
      preHandler: authenticate,
      schema: {
        params: worldIdParam,
        body: {
          type: "object",
          required: ["idempotencyKey", "trainId", "conflictId", "shiftMinutes"],
          additionalProperties: false,
          properties: {
            idempotencyKey: { type: "string", minLength: 1, maxLength: 128 },
            trainId: { type: "string", minLength: 1, maxLength: 128 },
            conflictId: { type: "string", minLength: 1, maxLength: 128 },
            shiftMinutes: { type: "integer", minimum: -1_440, maximum: 1_440 },
          },
        },
      },
    },
    async (request, reply) => {
      const identity = request.identity;
      if (identity === undefined) return reply.code(401).send({ error: "Keine Identität." });
      try {
        if (request.body.shiftMinutes === 0) return reply.code(400).send({ error: "Alternative muss die Zeitlage verändern." });
        const account = await getAccount(deps.db, { worldId: request.params.worldId, keycloakSubject: identity.keycloakSubject });
        if (account === undefined) throw new AuthorizationError("Kein aktiver Zugang zu dieser Welt.");
        const values = {
          worldId: request.params.worldId,
          requestingAccountId: account.id,
          idempotencyKey: request.body.idempotencyKey,
          commandType: "planning.apply-alternative",
          payload: { trainId: request.body.trainId, conflictId: request.body.conflictId, shiftMinutes: request.body.shiftMinutes },
          submittedAt: new Date(),
        };
        let [command] = await deps.db
          .insert(simulationCommands)
          .values(values)
          .onConflictDoNothing({ target: [simulationCommands.worldId, simulationCommands.requestingAccountId, simulationCommands.idempotencyKey] })
          .returning();
        if (command === undefined) {
          [command] = await deps.db
            .select()
            .from(simulationCommands)
            .where(and(eq(simulationCommands.worldId, request.params.worldId), eq(simulationCommands.requestingAccountId, account.id), eq(simulationCommands.idempotencyKey, request.body.idempotencyKey)))
            .limit(1);
        }
        return reply.code(202).send(command);
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  if (deps.simulationIngestToken !== undefined) {
    app.get<{ Params: { worldId: string }; Querystring: { limit?: number } }>(
      "/internal/worlds/:worldId/simulation/commands",
      {
        schema: {
          params: worldIdParam,
          querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1_000, default: 100 } } },
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.simulationIngestToken!)) return reply.code(401).send({ error: "Ungültige Simulations-Ingest-Autorisierung." });
        return reply.send(
          await deps.db
            .select()
            .from(simulationCommands)
            .where(and(eq(simulationCommands.worldId, request.params.worldId), eq(simulationCommands.status, "pending")))
            .orderBy(asc(simulationCommands.submittedAt), asc(simulationCommands.id))
            .limit(request.query.limit ?? 100),
        );
      },
    );

    app.post<{
      Params: { worldId: string; commandId: string };
      Body: { readonly status: "processed" | "failed"; readonly resultEventSequence?: number; readonly failureCode?: string; readonly processedAt: string };
    }>(
      "/internal/worlds/:worldId/simulation/commands/:commandId/result",
      {
        schema: {
          params: { type: "object", required: ["worldId", "commandId"], properties: { worldId: { type: "string", format: "uuid" }, commandId: { type: "string", format: "uuid" } } },
          body: {
            type: "object",
            required: ["status", "processedAt"],
            additionalProperties: false,
            properties: {
              status: { type: "string", enum: ["processed", "failed"] },
              resultEventSequence: { type: "integer", minimum: 1 },
              failureCode: { type: "string", minLength: 1, maxLength: 128 },
              processedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      async (request, reply) => {
        if (!bearerMatches(request.headers.authorization, deps.simulationIngestToken!)) return reply.code(401).send({ error: "Ungültige Simulations-Ingest-Autorisierung." });
        if (request.body.status === "processed" && request.body.resultEventSequence === undefined) return reply.code(400).send({ error: "Erfolgreiches Kommando braucht eine Ergebnis-Sequenz." });
        if (request.body.status === "failed" && request.body.failureCode === undefined) return reply.code(400).send({ error: "Fehlgeschlagenes Kommando braucht einen stabilen Fehlercode." });
        const [updated] = await deps.db
          .update(simulationCommands)
          .set({ status: request.body.status, processedAt: new Date(request.body.processedAt), resultEventSequence: request.body.resultEventSequence, failureCode: request.body.failureCode })
          .where(and(eq(simulationCommands.worldId, request.params.worldId), eq(simulationCommands.id, request.params.commandId), eq(simulationCommands.status, "pending")))
          .returning();
        return updated === undefined ? reply.code(404).send({ error: "Ausstehendes Kommando nicht gefunden." }) : reply.send(updated);
      },
    );
  }

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/livemap/snapshot",
    { schema: { params: worldIdParam } },
    async (request, reply) => {
      if (!(await worldExists(deps.db, request.params.worldId))) {
        return reply.code(404).send({ error: "Welt existiert nicht." });
      }
      try {
        return reply.send(
          deps.livemap?.forWorld(request.params.worldId).snapshot() ?? {
            worldId: request.params.worldId,
            sequence: 0,
            at: 0,
            trains: [],
          },
        );
      } catch (error) {
        if (error instanceof LivemapCapacityError) {
          return reply.code(503).send({ error: "Livemap vorübergehend ausgelastet." });
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { worldId: string } }>(
    "/worlds/:worldId/livemap/events",
    { schema: { params: worldIdParam } },
    async (request, reply) => {
      if (!(await worldExists(deps.db, request.params.worldId))) {
        return reply.code(404).send({ error: "Welt existiert nicht." });
      }
      let feed;
      try {
        feed = deps.livemap?.forWorld(request.params.worldId);
      } catch (error) {
        if (error instanceof LivemapCapacityError) {
          return reply.code(503).send({ error: "Livemap vorübergehend ausgelastet." });
        }
        throw error;
      }
      if (feed === undefined) {
        return reply.code(503).send({ error: "Livemap-Publisher nicht verfügbar." });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const queue: string[] = [];
      const maximumQueueLength = 128;
      let waitingForDrain = false;
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: () => void = () => undefined;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
      };
      const flush = () => {
        if (closed || waitingForDrain) return;
        while (queue.length > 0) {
          const payload = queue.shift()!;
          if (!reply.raw.write(payload)) {
            waitingForDrain = true;
            reply.raw.once("drain", () => {
              waitingForDrain = false;
              flush();
            });
            return;
          }
        }
      };
      const enqueue = (payload: string) => {
        if (closed) return;
        if (queue.length >= maximumQueueLength) {
          cleanup();
          reply.raw.end();
          return;
        }
        queue.push(payload);
        flush();
      };

      const lastEventHeader = request.headers["last-event-id"];
      const lastEventId = Number(Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader);
      if (Number.isSafeInteger(lastEventId) && lastEventId >= 0) {
        const replay = feed.deltasAfter(lastEventId);
        if (replay === undefined) {
          enqueue("event: reset\ndata: {}\n\n");
        } else {
          replay.forEach((delta) => {
            enqueue(`id: ${delta.sequence}\ndata: ${JSON.stringify(delta)}\n\n`);
          });
        }
      }
      unsubscribe = feed.subscribe((delta) => {
        enqueue(`id: ${delta.sequence}\ndata: ${JSON.stringify(delta)}\n\n`);
      });
      heartbeat = setInterval(() => enqueue(": heartbeat\n\n"), 15_000);
      heartbeat.unref();
      request.raw.once("close", cleanup);
      reply.raw.once("error", cleanup);
      enqueue("retry: 3000\n: verbunden\n\n");
      return undefined;
    },
  );

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
