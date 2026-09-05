import { createHash } from "node:crypto";
import { canonicalJson, validateAdminCommand, type GameAdminCommandHandler } from "@zugfolge/commerce";
import { accounts, accountRoles, disruptionPolicies, disruptionProviderStates, domainEvents, worldAccesses, worlds, type Database } from "@zugfolge/db";
import type { OperationalDailyRestrictionPolicy, OperationalDailyRestrictionsGenerated } from "@zugfolge/runtime-native";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

export const DISRUPTION_POLICY_ADMIN_CAPABILITY = Object.freeze({
  actionType: "disruption_policy_schedule" as const,
  availability: "available" as const,
  detail: "Explizite Stoerungsrichtlinie ab Fahrplanstichtag; native La-Pruefung, unsupportedScopes bleiben sichtbar und wirkungslos.",
});

/** Odoo autorisiert; Game bindet Konto, Welt, Termin und Generator atomar. */
export function createDisruptionPolicyAdminHandler(deps: {
  readonly db: Database;
  readonly validatePolicy: (worldId: string, policy: OperationalDailyRestrictionPolicy) => readonly OperationalDailyRestrictionsGenerated[];
}): GameAdminCommandHandler {
  return async (context) => {
    validateAdminCommand(context.payload);
    if (context.payload.actionType !== "disruption_policy_schedule" || context.payload.disruptionPolicy === undefined) {
      throw new Error("Kein versionierter Stoerungsrichtlinienantrag.");
    }
    const policy = context.payload.disruptionPolicy;
    const worldId = context.payload.worldId;
    const commandHash = createHash("sha256").update(canonicalJson(context.payload)).digest("hex");
    const result = await deps.db.transaction(async (tx) => {
      const [world] = await tx.select().from(worlds).where(eq(worlds.id, worldId)).limit(1).for("update");
      if (world === undefined || world.worldKind !== "public" || world.lifecycleStatus !== "active") throw new Error("Stoerungsrichtlinie braucht eine aktive oeffentliche Hauptwelt.");
      const [previous] = await tx.select().from(domainEvents).where(and(
        eq(domainEvents.worldId, worldId), eq(domainEvents.eventType, "disruption.policy-scheduled"),
        sql`${domainEvents.payload}->>'effectIdempotencyKey' = ${context.effectIdempotencyKey}`,
      )).limit(1);
      if (previous !== undefined) {
        const saved = previous.payload as { commandHash: string; result: Readonly<Record<string, unknown>> };
        if (saved.commandHash !== commandHash) throw new Error("Policy-Wirkungsschluessel besitzt andere Antragsbytes.");
        return { state: "completed" as const, gameAuditEventId: previous.id, result: saved.result };
      }
      const [account] = await tx.select({ id: accounts.id }).from(accounts)
        .innerJoin(accountRoles, and(eq(accountRoles.worldId, worldId), eq(accountRoles.accountId, accounts.id), eq(accountRoles.role, "world_admin")))
        .innerJoin(worldAccesses, and(eq(worldAccesses.worldId, worldId), eq(worldAccesses.keycloakSubject, accounts.keycloakSubject), eq(worldAccesses.status, "active")))
        .where(and(eq(accounts.worldId, worldId), eq(accounts.keycloakSubject, policy.requesterSubject), isNull(accounts.erasedAt))).limit(1);
      if (account === undefined) throw new Error("Policy-Antragsteller besitzt keinen aktiven weltgebundenen Administratorzugang.");
      const effectiveMs = Date.parse(policy.effectiveAt) - world.epoch.getTime();
      const nowMs = context.now.getTime() - world.epoch.getTime();
      const periodMs = world.schedulePeriodWeeks * 7 * 86_400_000;
      const [latest] = await tx.select().from(disruptionPolicies).where(eq(disruptionPolicies.worldId, worldId))
        .orderBy(desc(disruptionPolicies.version)).limit(1);
      const initialAtFutureEpoch = latest === undefined && effectiveMs === 0 && nowMs < 0;
      if (!Number.isSafeInteger(effectiveMs) || effectiveMs < 0 || effectiveMs <= nowMs || effectiveMs % periodMs !== 0
        || (effectiveMs === 0 && !initialAtFutureEpoch)) {
        throw new Error("Policywechsel muss an einem kuenftigen veroeffentlichten Fahrplanstichtag liegen.");
      }
      if (policy.plannedWorksMode === "REALISTIC" || policy.operationalIncidentMode === "REALISTIC") {
        const [provider] = await tx.select().from(disruptionProviderStates).where(and(
          eq(disruptionProviderStates.worldId, worldId), eq(disruptionProviderStates.providerSetId, policy.providerSetId!),
        )).limit(1);
        if (provider?.rightsStatus !== "approved" || provider.enabled !== "enabled" || !provider.rightsReference?.trim()) {
          throw new Error("REALISTIC braucht ein fuer diese Welt rechtegeprueftes aktiviertes Provider-Set.");
        }
      }
      if (latest !== undefined && latest.validFromS * 1_000 >= effectiveMs) throw new Error("Neue Policy muss nach der zuletzt veroeffentlichten Version beginnen.");
      const version = (latest?.version ?? 0) + 1;
      const generated = deps.validatePolicy(worldId, {
        version, plannedWorksMode: policy.plannedWorksMode, operationalIncidentMode: policy.operationalIncidentMode,
        providerSetId: policy.providerSetId ?? null, simulationProfile: policy.simulationProfile,
        rulesetVersion: policy.rulesetVersion, validFromMs: effectiveMs, validUntilMs: null,
      });
      const effectResult = {
        policyVersion: version, policyStatus: "scheduled", effectiveAt: policy.effectiveAt,
        dailyRestrictions: generated.map((entry) => ({
          regionId: entry.regionId, dayStartMs: entry.dayStartMs,
          supportedCount: entry.restrictions.length, unsupportedCount: entry.unsupportedRestrictions.length,
          status: policy.plannedWorksMode === "MANUAL" && policy.operationalIncidentMode === "MANUAL" ? "manual"
            : entry.unsupportedRestrictions.length > 0 ? "partially-supported" : "ready",
          supportedEffectContract: "numeric-speed/both-directions/all-traffic/v1",
          // Ein Nullergebnis bleibt ausdruecklich sichtbar; kein stilles Auffuellen.
          note: "Nicht darstellbare Originalwirkungen/Scopes bleiben diagnostiziert und werden nicht aktiviert.",
        })),
      };
      await tx.insert(disruptionPolicies).values({
        worldId, version, status: "scheduled", plannedWorksMode: policy.plannedWorksMode,
        operationalIncidentMode: policy.operationalIncidentMode, providerSetId: policy.providerSetId ?? null,
        simulationProfile: policy.simulationProfile, rulesetVersion: policy.rulesetVersion,
        validFromS: effectiveMs / 1_000, requestedByAccountId: account.id,
        changeReason: context.payload.reason, publishedAt: context.now,
      });
      const [head] = await tx.select({ sequence: domainEvents.sequence }).from(domainEvents)
        .where(eq(domainEvents.worldId, worldId)).orderBy(desc(domainEvents.sequence)).limit(1);
      const [audit] = await tx.insert(domainEvents).values({
        worldId, sequence: (head?.sequence ?? 0) + 1, eventType: "disruption.policy-scheduled",
        payload: { schemaVersion: "zugfolge-disruption-policy-scheduled/v1", effectIdempotencyKey: context.effectIdempotencyKey,
          commandHash, commandId: context.commandId, requesterReference: context.payload.requesterReference,
          approverReference: context.payload.approverReference, result: effectResult }, occurredAt: context.now,
      }).returning({ id: domainEvents.id });
      if (audit === undefined) throw new Error("Policy-Veröffentlichung besitzt keinen Auditbeleg.");
      return { state: "completed" as const, gameAuditEventId: audit.id, result: effectResult };
    });
    context.markEffectApplied?.();
    return result;
  };
}
