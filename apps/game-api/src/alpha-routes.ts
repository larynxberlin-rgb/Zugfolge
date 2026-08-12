import {
  AbuseGuard,
  AlphaAuthorizationError,
  AlphaConflictError,
  AlphaFeedbackService,
  AlphaMonitoringService,
  AlphaValidationError,
  TutorialSessionService,
  WorldEndService,
  alphaHash,
  pseudonym,
  type TutorialAction,
} from "@zugfolge/alpha";
import { alphaWorldProfiles, worlds } from "@zugfolge/db";
import { AuthorizationError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { createAuthenticator } from "./auth.js";

export interface AlphaRouteServices {
  readonly tutorialSessions?: TutorialSessionService;
  readonly feedback?: AlphaFeedbackService;
  readonly monitoring?: AlphaMonitoringService;
  readonly worldEnd?: WorldEndService;
  readonly abuse: AbuseGuard;
  readonly pseudonymSecret: string;
  readonly clock?: () => Date;
  readonly authorizeMonitoring?: (worldId: string, keycloakSubject: string) => Promise<void>;
}

export type AlphaAbuseServices = Pick<AlphaRouteServices, "abuse" | "pseudonymSecret" | "clock">;

const worldParams = { type: "object", required: ["worldId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" } } } as const;

function payload(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(payload);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, payload(item)]));
  return value;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof AlphaAuthorizationError || error instanceof AuthorizationError) return reply.code(403).send({ code: "alpha_forbidden", error: error.message });
  if (error instanceof AlphaValidationError) return reply.code(400).send({ code: error.code, error: error.message });
  if (error instanceof AlphaConflictError) return reply.code(409).send({ code: error.code, error: error.message });
  throw error;
}

async function account(db: IdentityDatabase, worldId: string, subject: string) {
  const found = await getAccount(db, { worldId, keycloakSubject: subject });
  if (found === undefined) throw new AuthorizationError("Kein aktives Konto in dieser Welt.");
  return found;
}

async function simulationTime(db: IdentityDatabase, worldId: string, now: Date) {
  const [row] = await db.select({ epoch: worlds.epoch, factor: alphaWorldProfiles.accelerationFactor }).from(worlds)
    .leftJoin(alphaWorldProfiles, eq(alphaWorldProfiles.worldId, worlds.id)).where(eq(worlds.id, worldId)).limit(1);
  if (row === undefined) throw new AlphaValidationError("Welt fehlt.");
  const elapsed = Math.max(0, Math.floor((now.getTime() - row.epoch.getTime()) / 1_000));
  const atS = elapsed * (row.factor ?? 1);
  if (!Number.isSafeInteger(atS)) throw new AlphaConflictError("Simulationszeit liegt ausserhalb sicherer Ganzzahlen.");
  return atS;
}

export async function guardAlphaAction(
  deps: { readonly db: IdentityDatabase; readonly services: AlphaAbuseServices },
  request: FastifyRequest,
  worldId: string,
  subject: string,
  actionClass: string,
  target: string,
  replayKey: string,
) {
  const now = deps.services.clock?.() ?? new Date();
  const atS = await simulationTime(deps.db, worldId, now);
  const identityHash = pseudonym(deps.services.pseudonymSecret, subject);
  const observation = await deps.services.abuse.consume({
    worldId, identityHash, identityClass: "authenticated", endpointClass: request.routeOptions.url ?? "unknown",
    actionClass, targetHash: alphaHash("abuse-target/v1", target), replayKeyHash: alphaHash("abuse-replay/v1", replayKey),
    atS, correlationId: String(request.id),
  });
  if (observation.response === "block" || observation.response === "manual-review") throw new AlphaConflictError("Anfrage ist erklaerbar begrenzt und kann angefochten werden.", "abuse_request_blocked");
  if (observation.response === "limit") throw new AlphaConflictError("Fachliches Aktionslimit erreicht; spaeter erneut versuchen.", "abuse_request_limited");
  if (observation.response === "delay") {
    const delayMs = Math.min(2_000, Math.floor(observation.scoreBasisPoints / 5));
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  return { atS, identityHash, observation };
}

export function registerAlphaRoutes(app: FastifyInstance, deps: { readonly db: IdentityDatabase; readonly authenticate: ReturnType<typeof createAuthenticator>; readonly services: AlphaRouteServices }): void {
  const { tutorialSessions, feedback, monitoring, authorizeMonitoring, worldEnd } = deps.services;
  if (tutorialSessions !== undefined) {
  app.post<{ Params: { worldId: string } }>("/worlds/:worldId/tutorial-sessions", { preHandler: deps.authenticate, schema: { params: worldParams } }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      const current = await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
      await guardAlphaAction(deps, request, request.params.worldId, request.identity.keycloakSubject, "tutorial-start", current.id, `tutorial-start:${current.id}`);
      return reply.code(201).send(payload(await tutorialSessions.start({
        publicWorldId: request.params.worldId,
        publicAccountId: current.id,
        keycloakSubject: request.identity.keycloakSubject,
        displayName: current.displayName,
      })));
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { worldId: string } }>("/worlds/:worldId/tutorial-sessions/active", { preHandler: deps.authenticate, schema: { params: worldParams } }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      const current = await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
      const active = await tutorialSessions.activeForPublicAccount(request.params.worldId, current.id);
      return active === undefined ? reply.code(404).send({ code: "tutorial_session_missing", error: "Keine aktive Tutorialsitzung." }) : reply.send(payload(active));
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { worldId: string } }>("/worlds/:worldId/tutorial-session", { preHandler: deps.authenticate, schema: { params: worldParams } }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      const current = await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
      return reply.send(payload(await tutorialSessions.resume(request.params.worldId, current.id)));
    } catch (error) { return sendError(reply, error); }
  });

  const tutorialActionBody = {
    oneOf: [
      { type: "object", required: ["type", "orderingFeeCentsPerTrainKm", "punctualityBasisPoints", "extraSeats"], additionalProperties: false, properties: { type: { const: "submit-bid" }, orderingFeeCentsPerTrainKm: { type: "string", pattern: "^[1-9][0-9]{2,3}$" }, punctualityBasisPoints: { type: "integer", minimum: 0, maximum: 10_000 }, extraSeats: { type: "integer", minimum: 0, maximum: 100 } } },
      { type: "object", required: ["type", "offerId"], additionalProperties: false, properties: { type: { const: "accept-lease" }, offerId: { type: "string", minLength: 1, maxLength: 100 } } },
      { type: "object", required: ["type", "alternativeId"], additionalProperties: false, properties: { type: { const: "confirm-path" }, alternativeId: { type: "string", minLength: 1, maxLength: 100 } } },
      { type: "object", required: ["type", "templateId", "changedRule", "thresholdSeconds"], additionalProperties: false, properties: { type: { const: "activate-program" }, templateId: { type: "string", enum: ["connections", "punctuality"] }, changedRule: { type: "string", enum: ["hold-connections", "prioritize-punctuality", "activate-reserve"] }, thresholdSeconds: { type: "integer", minimum: 60, maximum: 900 } } },
      { type: "object", required: ["type", "action"], additionalProperties: false, properties: { type: { const: "dispatch" }, action: { type: "string", enum: ["short_turn", "request_reroute", "trigger_rail_replacement"] } } },
    ],
  } as const;
  app.post<{ Params: { worldId: string }; Body: TutorialAction }>("/worlds/:worldId/tutorial-session/actions", { preHandler: deps.authenticate, schema: { params: worldParams, body: tutorialActionBody } }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      const current = await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
      await guardAlphaAction(deps, request, request.params.worldId, request.identity.keycloakSubject, `tutorial-${request.body.type}`, current.id, `${request.body.type}:${JSON.stringify(request.body)}`);
      return reply.send(payload(await tutorialSessions.act(request.params.worldId, current.id, request.body)));
    } catch (error) { return sendError(reply, error); }
  });

  for (const [suffix, operation] of [
    ["restart", "restart"],
    ["summary/confirm", "confirm"],
    ["hints", "hint"],
  ] as const) {
    app.post<{ Params: { worldId: string } }>(`/worlds/:worldId/tutorial-session/${suffix}`, { preHandler: deps.authenticate, schema: { params: worldParams } }, async (request, reply) => {
      if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
      try {
        const current = await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
        await guardAlphaAction(deps, request, request.params.worldId, request.identity.keycloakSubject, `tutorial-${operation}`, current.id, `${operation}:${request.id}`);
        const result = operation === "restart" ? await tutorialSessions.restart(request.params.worldId, current.id)
          : operation === "confirm" ? await tutorialSessions.confirmSummary(request.params.worldId, current.id)
            : await tutorialSessions.openHint(request.params.worldId, current.id);
        return reply.send(payload(result));
      } catch (error) { return sendError(reply, error); }
    });
  }

  app.post<{ Params: { worldId: string }; Body: { dialogueId: string } }>("/worlds/:worldId/tutorial-session/dialogues/dismiss", {
    preHandler: deps.authenticate,
    schema: { params: worldParams, body: { type: "object", required: ["dialogueId"], additionalProperties: false, properties: { dialogueId: { type: "string", minLength: 1, maxLength: 120 } } } },
  }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      const current = await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
      return reply.send(payload(await tutorialSessions.dismissDialogue(request.params.worldId, current.id, request.body.dialogueId)));
    } catch (error) { return sendError(reply, error); }
  });
  }

  if (feedback !== undefined) {
  app.post<{ Params: { worldId: string }; Body: { fromS: number; untilS: number; eventReference?: string; reportReference?: string; category: "usability" | "balancing" | "bug" | "incident" | "safety" | "privacy"; message: string; contactAllowed: boolean } }>("/worlds/:worldId/alpha-feedback", {
    preHandler: deps.authenticate,
    schema: { params: worldParams, body: { type: "object", required: ["fromS", "untilS", "category", "message", "contactAllowed"], additionalProperties: false, properties: { fromS: { type: "integer", minimum: 0 }, untilS: { type: "integer", minimum: 0 }, eventReference: { type: "string" }, reportReference: { type: "string" }, category: { type: "string", enum: ["usability", "balancing", "bug", "incident", "safety", "privacy"] }, message: { type: "string", minLength: 10, maxLength: 8000 }, contactAllowed: { type: "boolean" } } } },
  }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
      await guardAlphaAction(deps, request, request.params.worldId, request.identity.keycloakSubject, "alpha-feedback", request.body.category, `${request.body.category}:${request.body.message}`);
      return reply.code(201).send(payload(await feedback.submit({ worldId: request.params.worldId, keycloakSubject: request.identity.keycloakSubject, ...request.body })));
    } catch (error) { return sendError(reply, error); }
  });
  }

  if (monitoring !== undefined && authorizeMonitoring !== undefined) {
  app.get<{ Params: { worldId: string } }>("/worlds/:worldId/alpha-monitoring", { preHandler: deps.authenticate, schema: { params: worldParams } }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try { await authorizeMonitoring(request.params.worldId, request.identity.keycloakSubject); return reply.send(payload(await monitoring.snapshot(request.params.worldId, deps.services.clock?.() ?? new Date()))); }
    catch (error) { return sendError(reply, error); }
  });
  }

  if (worldEnd !== undefined) {
  app.get<{ Params: { worldId: string } }>("/worlds/:worldId/replay-export", {
    preHandler: deps.authenticate,
    schema: { params: worldParams },
  }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      const current = await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
      if (!current.roles.includes("player")) throw new AuthorizationError("Nur Teilnehmende der Welt duerfen deren oeffentliche Betriebshistorie exportieren.");
      return reply.send(payload(await worldEnd.exportReplay(request.params.worldId, "world-participant")));
    }
    catch (error) { return sendError(reply, error); }
  });
  }

  app.post<{ Params: { worldId: string; sanctionId: string }; Body: { appealReference: string } }>("/worlds/:worldId/abuse-sanctions/:sanctionId/appeal", {
    preHandler: deps.authenticate,
    schema: { params: { type: "object", required: ["worldId", "sanctionId"], additionalProperties: false, properties: { worldId: { type: "string", format: "uuid" }, sanctionId: { type: "string", format: "uuid" } } }, body: { type: "object", required: ["appealReference"], additionalProperties: false, properties: { appealReference: { type: "string", minLength: 8, maxLength: 2000 } } } },
  }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try { return reply.send(payload(await deps.services.abuse.appeal(request.params.worldId, pseudonym(deps.services.pseudonymSecret, request.identity.keycloakSubject), request.params.sanctionId, request.body.appealReference))); }
    catch (error) { return sendError(reply, error); }
  });
}
