import {
  AbuseGuard,
  AlphaAuthorizationError,
  AlphaConflictError,
  AlphaFeedbackService,
  AlphaMonitoringService,
  AlphaValidationError,
  OnboardingService,
  TutorialService,
  WorldEndService,
  alphaHash,
  pseudonym,
  type StartPackageSpec,
} from "@zugfolge/alpha";
import { alphaWorldProfiles, worlds } from "@zugfolge/db";
import { AuthorizationError, getAccount, type IdentityDatabase } from "@zugfolge/identity";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { createAuthenticator } from "./auth.js";

export interface AlphaRouteServices {
  readonly tutorial?: TutorialService;
  readonly onboarding?: OnboardingService;
  readonly feedback?: AlphaFeedbackService;
  readonly monitoring?: AlphaMonitoringService;
  readonly worldEnd?: WorldEndService;
  readonly abuse: AbuseGuard;
  readonly startPackageSpec?: StartPackageSpec;
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
  const { tutorial, onboarding, startPackageSpec, feedback, monitoring, authorizeMonitoring, worldEnd } = deps.services;
  if (tutorial !== undefined) {
  app.get<{ Params: { worldId: string } }>("/worlds/:worldId/tutorial", { preHandler: deps.authenticate, schema: { params: worldParams } }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      const current = await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
      const atS = await simulationTime(deps.db, request.params.worldId, deps.services.clock?.() ?? new Date());
      return reply.send(payload(await tutorial.resume(request.params.worldId, current.id, atS)));
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { worldId: string } }>("/worlds/:worldId/tutorial/reset", { preHandler: deps.authenticate, schema: { params: worldParams } }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      const current = await account(deps.db, request.params.worldId, request.identity.keycloakSubject);
      const { atS } = await guardAlphaAction(deps, request, request.params.worldId, request.identity.keycloakSubject, "tutorial-reset", current.id, request.id);
      return reply.send(payload(await tutorial.reset(request.params.worldId, current.id, atS)));
    } catch (error) { return sendError(reply, error); }
  });
  }

  if (onboarding !== undefined && startPackageSpec !== undefined) {
  app.post<{ Params: { worldId: string } }>("/worlds/:worldId/onboarding/start-package", { preHandler: deps.authenticate, schema: { params: worldParams } }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try {
      const { atS } = await guardAlphaAction(deps, request, request.params.worldId, request.identity.keycloakSubject, "start-package", request.params.worldId, request.id);
      return reply.code(201).send(payload(await onboarding.claim(request.params.worldId, request.identity.keycloakSubject, atS, startPackageSpec)));
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { worldId: string }; Querystring: { fromS: number; untilS: number } }>("/worlds/:worldId/capacity-heatmap", {
    preHandler: deps.authenticate,
    schema: { params: worldParams, querystring: { type: "object", required: ["fromS", "untilS"], additionalProperties: false, properties: { fromS: { type: "integer", minimum: 0 }, untilS: { type: "integer", minimum: 1 } } } },
  }, async (request, reply) => {
    if (request.identity === undefined) return reply.code(401).send({ error: "Keine Identitaet." });
    try { await account(deps.db, request.params.worldId, request.identity.keycloakSubject); return reply.send(payload(await onboarding.capacityHeatmap(request.params.worldId, request.query.fromS, request.query.untilS))); }
    catch (error) { return sendError(reply, error); }
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
