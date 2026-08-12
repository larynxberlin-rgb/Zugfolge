import { isAdminActionType, type AdminCommandPayload } from "./contracts.js";

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
  if (["abuse_sanction_activate", "world_close"].includes(command.actionType) && command.riskClass !== "high") {
    throw new AdminWorkflowError("Schwere Sanktionen und Weltende sind immer hochriskant.");
  }
  if (["world_access_revoke", "abuse_sanction_activate", "tutorial_account_reset"].includes(command.actionType)) {
    if (command.targetReference === undefined || command.targetReference.trim().length === 0) {
      throw new AdminWorkflowError("Verwaltungsaktion braucht eine stabile Zielreferenz.");
    }
  }
  if (["world_close", "tutorial_account_reset"].includes(command.actionType)) {
    if (command.requestedAtS === undefined || !Number.isSafeInteger(command.requestedAtS) || command.requestedAtS < 0) {
      throw new AdminWorkflowError("Verwaltungsaktion braucht eine gueltige Simulationszeit.");
    }
  }
  if (command.actionType.startsWith("alpha_invitation_")) {
    const invitation = command.invitation;
    if (invitation === undefined || invitation.requestReference.trim() === "" || !/^\S+@\S+\.\S+$/.test(invitation.email)) {
      throw new AdminWorkflowError("Alpha-Einladung braucht Referenz und gueltige E-Mail-Adresse.");
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
