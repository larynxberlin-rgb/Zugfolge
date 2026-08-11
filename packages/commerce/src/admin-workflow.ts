import type { AdminCommandPayload } from "./contracts.js";

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
