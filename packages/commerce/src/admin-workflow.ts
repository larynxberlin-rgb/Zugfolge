import { isAdminActionType, type AdminCommandPayload, type SerializedStartingCapitalPolicy, type SignedWorldDeployment, type WorldDefinition } from "./contracts.js";

export const ADMIN_REQUEST_STATES = [
  "draft", "submitted", "approved", "rejected", "dispatched", "accepted", "completed", "failed",
] as const;
export type AdminRequestState = (typeof ADMIN_REQUEST_STATES)[number];

export class AdminWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminWorkflowError";
  }
}

const MAX_MONEY_CENTS = 9_223_372_036_854_775_807n;
const CANONICAL_CENTS = /^(0|[1-9][0-9]*)$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WORLD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return false;
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (leftRecord === undefined || rightRecord === undefined) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJson(leftRecord[key], rightRecord[key]));
}

function sameWorldDefinition(value: unknown, expected: WorldDefinition): boolean {
  const definition = record(value);
  return definition !== undefined
    && Object.keys(definition).length === 5
    && definition["name"] === expected.name
    && definition["kind"] === expected.kind
    && definition["rankingStatus"] === expected.rankingStatus
    && definition["schedulePeriodWeeks"] === expected.schedulePeriodWeeks
    && typeof definition["epoch"] === "string"
    && new Date(definition["epoch"]).getTime() === new Date(expected.epoch).getTime();
}

export function validateStartingCapitalPolicy(value: unknown): asserts value is SerializedStartingCapitalPolicy {
  const policy = record(value);
  if (policy === undefined || (policy["mode"] !== "finite" && policy["mode"] !== "unlimited")) {
    throw new AdminWorkflowError("Startkapital braucht den Modus 'finite' oder 'unlimited'.");
  }
  if (policy["mode"] === "unlimited") {
    if (Object.keys(policy).length !== 1 || !Object.hasOwn(policy, "mode")) {
      throw new AdminWorkflowError("Unbegrenztes Startkapital ist ein Modus und besitzt keinen Geldbetrag.");
    }
    return;
  }
  const amount = policy["amountCents"];
  if (Object.keys(policy).length !== 2 || !Object.hasOwn(policy, "mode") || !Object.hasOwn(policy, "amountCents")
    || typeof amount !== "string" || !CANONICAL_CENTS.test(amount)) {
    throw new AdminWorkflowError("Begrenztes Startkapital braucht nichtnegative Integer-Cent als kanonischen Dezimalstring.");
  }
  if (BigInt(amount) > MAX_MONEY_CENTS) {
    throw new AdminWorkflowError("Startkapital liegt ausserhalb des vorzeichenbehafteten 64-Bit-Centbereichs.");
  }
}

function validateWorldDefinition(value: unknown): asserts value is WorldDefinition {
  const definition = record(value);
  const epoch = typeof definition?.["epoch"] === "string"
    ? new Date(definition["epoch"])
    : undefined;
  if (definition === undefined
    || Object.keys(definition).length !== 5
    || !["name", "kind", "rankingStatus", "schedulePeriodWeeks", "epoch"].every((key) => Object.hasOwn(definition, key))
    || typeof definition["name"] !== "string"
    || definition["name"].trim() === ""
    || !(["public", "private", "test"] as const).includes(definition["kind"] as never)
    || !(["ranked", "unranked"] as const).includes(definition["rankingStatus"] as never)
    || !Number.isSafeInteger(definition["schedulePeriodWeeks"])
    || (definition["schedulePeriodWeeks"] as number) < 3
    || (definition["schedulePeriodWeeks"] as number) > 8
    || epoch === undefined
    || Number.isNaN(epoch.getTime())
    || epoch.getUTCDay() !== 1
    || epoch.getUTCHours() !== 0
    || epoch.getUTCMinutes() !== 0
    || epoch.getUTCSeconds() !== 0
    || epoch.getUTCMilliseconds() !== 0) {
    throw new AdminWorkflowError("Welt-Deployment braucht Name, Profil, Wertung, Periodenlaenge und Epoche.");
  }
  if ((definition["kind"] === "public") !== (definition["rankingStatus"] === "ranked")) {
    throw new AdminWorkflowError("Nur oeffentliche Welten sind gewertet; alle anderen Weltprofile sind ungewertet.");
  }
}

function validateSignedDeployment(
  value: unknown,
  worldId: string,
  deploymentHash: unknown,
  deploymentRevision: unknown,
  policy: SerializedStartingCapitalPolicy,
  definition: WorldDefinition,
): asserts value is SignedWorldDeployment {
  const signed = record(value);
  const signature = record(signed?.["signature"]);
  const deployment = record(signed?.["deployment"]);
  const blueprint = record(deployment?.["blueprint"]);
  if (signed === undefined || deployment === undefined || signature === undefined
    || Object.keys(signed).length !== 3
    || !["deployment", "deploymentHash", "signature"].every((key) => Object.hasOwn(signed, key))
    || Object.keys(signature).length !== 3
    || !["algorithm", "keyId", "valueBase64"].every((key) => Object.hasOwn(signature, key))
    || typeof deploymentHash !== "string" || !SHA256.test(deploymentHash)
    || !Number.isSafeInteger(deploymentRevision) || (deploymentRevision as number) < 1
    || signed["deploymentHash"] !== deploymentHash
    || signature["algorithm"] !== "Ed25519"
    || typeof signature["keyId"] !== "string" || signature["keyId"].trim() === ""
    || typeof signature["valueBase64"] !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature["valueBase64"])
    || deployment["worldId"] !== worldId
    || deployment["deploymentRevision"] !== deploymentRevision
    || blueprint === undefined
    || blueprint["profileKind"] !== definition.kind
    || !sameWorldDefinition(deployment["worldDefinition"], definition)) {
    throw new AdminWorkflowError("Welt-Deployment braucht passenden SHA-256, Weltbindung, Profilbindung und vollstaendige Ed25519-Signatur.");
  }
  validateStartingCapitalPolicy(blueprint["startingCapitalPolicy"]);
  if (!sameJson(blueprint["startingCapitalPolicy"], policy)) {
    throw new AdminWorkflowError("Odoo-Startkapital und signierter Weltentwurf weichen voneinander ab.");
  }
}

/**
 * Serverseitige zweite Verteidigungslinie. Odoo liefert lediglich die
 * behauptete Freigabe; das Game akzeptiert weder Selbstfreigabe noch leere
 * Begruendung und kennt keinen Zustand, der Simulation pruefungen umgeht.
 */
export function validateAdminCommand(command: AdminCommandPayload): void {
  if (!isAdminActionType(command.actionType) || command.kind !== `admin.${command.actionType}`) {
    throw new AdminWorkflowError("Administrationsaktion und Kommando-Typ passen nicht zusammen.");
  }
  if (command.reason.trim().length === 0) throw new AdminWorkflowError("Eine Begruendung ist Pflicht.");
  if (command.riskClass === "high") {
    if (command.approverReference === undefined || command.approverReference.length === 0) {
      throw new AdminWorkflowError("Hochrisikoaktion braucht eine zweite Freigabe.");
    }
    if (command.approverReference === command.requesterReference) {
      throw new AdminWorkflowError("Antragsteller und Freigeber duerfen nicht dieselbe Person sein.");
    }
  }
  if (command.actionType === "infra_release_adoption") {
    if (command.riskClass !== "high") throw new AdminWorkflowError("InfraRelease-Uebernahme ist immer hochriskant.");
    if (command.releaseHash === undefined || !/^[a-f0-9]{64}$/.test(command.releaseHash)) {
      throw new AdminWorkflowError("InfraRelease-Uebernahme braucht einen SHA-256-Release-Hash.");
    }
    if (command.requestedPeriodStart === undefined) {
      throw new AdminWorkflowError("InfraRelease-Uebernahme braucht einen beantragten Periodenwechsel.");
    }
  }
  if (command.actionType === "manual_disruption_create") {
    const disruption = command.manualDisruption;
    if (command.riskClass !== "high") {
      throw new AdminWorkflowError("Eine manuelle Stoerung ist immer hochriskant.");
    }
    if (disruption === undefined || disruption.cause.trim().length === 0 || disruption.affectedResourceIds.length === 0) {
      throw new AdminWorkflowError("Manuelle Stoerungen brauchen Ursache und betroffene Ressourcen.");
    }
    if (!disruption.affectedResourceIds.every((resourceId) => typeof resourceId === "string" && resourceId.trim().length > 0)) {
      throw new AdminWorkflowError("Betroffene Ressourcen muessen stabile Bezeichner besitzen.");
    }
    const startsAt = new Date(disruption.startsAt);
    const endsAt = new Date(disruption.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw new AdminWorkflowError("Manuelle Stoerungen brauchen einen gueltigen Beginn vor dem Ende.");
    }
    if (typeof disruption.declaredEffect !== "object" || disruption.declaredEffect === null || Array.isArray(disruption.declaredEffect) || Object.keys(disruption.declaredEffect).length === 0) {
      throw new AdminWorkflowError("Manuelle Stoerungen brauchen eine deklarierte Wirkung.");
    }
  }
  if (command.actionType === "disruption_policy_schedule") {
    const policy = command.disruptionPolicy;
    const modes = ["REALISTIC", "SIMULATED", "MANUAL"];
    if (command.riskClass !== "high" || command.reason.trim().length < 8
      || policy?.schemaVersion !== "zugfolge-disruption-policy-schedule/v1"
      || typeof policy.requesterSubject !== "string" || policy.requesterSubject.trim() === ""
      || typeof policy.effectiveAt !== "string" || !/Z$/.test(policy.effectiveAt) || Number.isNaN(Date.parse(policy.effectiveAt))
      || !modes.includes(policy.plannedWorksMode) || !modes.includes(policy.operationalIncidentMode)
      || typeof policy.rulesetVersion !== "string" || policy.rulesetVersion.trim() === ""
      || record(policy.simulationProfile) === undefined
      || Object.keys(policy).some((key) => !["schemaVersion", "requesterSubject", "effectiveAt", "plannedWorksMode", "operationalIncidentMode", "providerSetId", "simulationProfile", "rulesetVersion"].includes(key))
      || ((policy.plannedWorksMode === "REALISTIC" || policy.operationalIncidentMode === "REALISTIC")
        && (typeof policy.providerSetId !== "string" || policy.providerSetId.trim() === ""))) {
      throw new AdminWorkflowError("Stoerungsrichtlinie braucht Vier-Augen-Freigabe, Kontobindung, Stichtag und einen expliziten Generatorvertrag.");
    }
  }
  if (["world_access_revoke", "abuse_sanction_activate", "world_close"].includes(command.actionType) && command.riskClass !== "high") {
    throw new AdminWorkflowError("Kontoentzug, schwere Sanktionen und Weltende sind immer hochriskant.");
  }
  if (command.actionType === "world_deploy") {
    if (command.riskClass !== "high") throw new AdminWorkflowError("Ein Welt-Deployment ist immer hochriskant.");
    if (!WORLD_ID.test(command.worldId)) throw new AdminWorkflowError("Welt-Deployment braucht eine gueltige Welt-ID.");
    validateStartingCapitalPolicy(command.startingCapitalPolicy);
    validateWorldDefinition(command.worldDefinition);
    validateSignedDeployment(command.signedDeployment, command.worldId, command.deploymentHash, command.deploymentRevision, command.startingCapitalPolicy, command.worldDefinition);
  }
  if (["world_access_revoke", "abuse_sanction_activate"].includes(command.actionType)) {
    if (command.targetReference === undefined || command.targetReference.trim().length === 0) {
      throw new AdminWorkflowError("Verwaltungsaktion braucht eine stabile Zielreferenz.");
    }
  }
  if (command.actionType === "world_close") {
    if (command.requestedAtS === undefined || !Number.isSafeInteger(command.requestedAtS) || command.requestedAtS < 0) {
      throw new AdminWorkflowError("Verwaltungsaktion braucht eine gueltige Simulationszeit.");
    }
  }
  if (command.actionType.startsWith("alpha_invitation_")) {
    const invitation = command.invitation;
    if (invitation === undefined || invitation.requestReference.trim() === "" || !/^\S+@\S+\.\S+$/.test(invitation.email)) {
      throw new AdminWorkflowError("Alpha-Einladung braucht Referenz und gueltige E-Mail-Adresse.");
    }
    const allowedInvitationKeys = new Set(["requestReference", "email", "displayName", "role", "keycloakSubject"]);
    if (Object.keys(invitation).some((key) => !allowedInvitationKeys.has(key))) {
      throw new AdminWorkflowError("Alpha-Einladung enthaelt unbekannte oder fachfremde Felder.");
    }
    if (!(["player", "world_admin"] as const).includes(invitation.role)) {
      throw new AdminWorkflowError("Alpha-Einladung enthaelt eine unbekannte Kontorolle.");
    }
    if (command.actionType !== "alpha_invitation_create" && !invitation.keycloakSubject) {
      throw new AdminWorkflowError("Erneutes Senden und Entzug brauchen das gebundene Keycloak-Subject.");
    }
  }
}

export function nextAdminRequestState(current: AdminRequestState, event: "submit" | "approve" | "reject" | "dispatch" | "accept" | "complete" | "fail"): AdminRequestState {
  const transitions: Readonly<Record<AdminRequestState, Readonly<Record<string, AdminRequestState>>>> = {
    draft: { submit: "submitted" },
    submitted: { approve: "approved", reject: "rejected" },
    approved: { dispatch: "dispatched" },
    rejected: {},
    dispatched: { accept: "accepted", reject: "rejected", fail: "failed" },
    accepted: { complete: "completed", fail: "failed" },
    completed: {},
    failed: {},
  };
  const next = transitions[current][event];
  if (next === undefined) throw new AdminWorkflowError(`Ungueltiger Zustandswechsel ${current} -> ${event}.`);
  return next;
}
