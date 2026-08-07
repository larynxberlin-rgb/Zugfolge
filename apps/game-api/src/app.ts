/**
 * Game-API (M2.1) — Keycloak-Authentifizierung, Konten, Rollen, Weltzugänge.
 *
 * `buildApp` nimmt seine Abhängigkeiten entgegen, statt sie selbst
 * aufzubauen: Produktion verdrahtet eine echte Postgres-Verbindung und den
 * echten Keycloak-Realm (`server.ts`), Tests verdrahten PGlite und ein
 * lokales Schlüsselpaar (`app.test.ts`). Beide laufen über denselben Code.
 */

import {
  AccessRevokedError,
  AccountNotFoundError,
  AuthorizationError,
  grantRole,
  isRole,
  listAccountsForSubject,
  listAccountsInWorld,
  requestWorldAccess,
  type IdentityDatabase,
} from "@zugfolge/identity";
import Fastify, { type FastifyInstance } from "fastify";

import { createAuthenticator, type TokenVerifier } from "./auth.js";

export interface AppDependencies {
  readonly db: IdentityDatabase;
  readonly verifyToken: TokenVerifier;
}

const worldIdParam = {
  type: "object",
  required: ["worldId"],
  properties: { worldId: { type: "string", format: "uuid" } },
} as const;

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const authenticate = createAuthenticator(deps.verifyToken);

  app.get("/health", async () => ({ status: "ok" }));

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
        if (error instanceof AccessRevokedError) {
          return reply.code(403).send({ error: error.message });
        }
        throw error;
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
        if (error instanceof AuthorizationError) {
          return reply.code(403).send({ error: error.message });
        }
        throw error;
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
        if (error instanceof AuthorizationError) {
          return reply.code(403).send({ error: error.message });
        }
        if (error instanceof AccountNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
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

  return app;
}
