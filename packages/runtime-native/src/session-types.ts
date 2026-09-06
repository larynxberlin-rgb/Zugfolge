import type { BuildInteriorLayoutInputV1, InteriorLayoutV1, InteriorPointV1, PassengerProjectionV2, ProjectConductorPassengersInputV2 } from "./interior-types.js";
export interface ConductorSessionPolicyV1 {
  readonly schemaVersion: "conductor-session-policy/v1"; readonly policyId: string; readonly revision: number;
  readonly worldId: string; readonly periodId: string; readonly contentHash: string;
  readonly leaseDurationMs: number; readonly commandWindowMs: number; readonly maxCommandsPerWindow: number;
  readonly minCommandIntervalMs: number; readonly walkSpeedMmPerSecond: number; readonly maxMovementBurstMm: number;
  readonly inspectionRangeMm: number; readonly maxReceipts: number;
}
export interface ConductorSessionAccessV1 {
  readonly worldId: string; readonly operatorId: string; readonly ownerRef: string;
  readonly worldAccessActive: boolean; readonly operatorActive: boolean; readonly trainUseAuthorized: boolean;
  readonly otherActiveSessionId: string | null;
}
export interface DialogueEvidenceV1 {
  readonly documentStatus: "unchecked" | "verified_valid" | "not_presentable" | "verified_invalid";
  readonly acquisitionException: "unknown" | "proven" | "excluded";
  readonly identityStatus: "unknown" | "confirmed" | "refused"; readonly concreteDanger: boolean;
}
export interface PassengerEncounterV1 {
  readonly schemaVersion: string; readonly encounterId: string; readonly revision: number; readonly status: "active" | "closed";
  readonly passengerText: string; readonly options: readonly { readonly optionId: string; readonly text: string; readonly timeCostMs: number }[];
  readonly hints: DialogueEvidenceV1; readonly availableAtMs: number;
}
export interface ConductorSessionControlReceiptV1 {
  readonly worldId: string; readonly trainRunId: string; readonly effectId: string; readonly encounterId: string;
  readonly kind: "claim" | "hold"; readonly domainReceiptId: string; readonly domainStateHash: string;
}
export interface ConductorSessionSourceV1 {
  readonly operationalWorld: Readonly<Record<string, unknown>>; readonly expectedOperationalWorldHash: string;
  readonly interior: BuildInteriorLayoutInputV1 | null; readonly projection: ProjectConductorPassengersInputV2 | null;
  readonly sessionPolicy: ConductorSessionPolicyV1; readonly currentDialogueReleaseHash: string;
  readonly dialogueReleases: readonly Readonly<Record<string, unknown>>[];
  readonly encounterEvidence: readonly { readonly encounterId: string; readonly evidence: DialogueEvidenceV1 }[];
  readonly controlReceipts: readonly ConductorSessionControlReceiptV1[];
}
export interface ConductorSessionPinsV1 {
  readonly periodId: string; readonly operationalWorldHash: string; readonly operationalFormationId: string; readonly formationId: string;
  readonly vehicleIds: readonly string[]; readonly interiorLayoutHash: string; readonly demandStateHash: string;
  readonly manifestRevision: number; readonly projectionHash: string; readonly dialogueReleaseHash: string; readonly policyHash: string;
}
export type ConductorSessionStatusV1 = "active" | "detached" | "ended";
export type ConductorSessionEndReasonV1 = "requested" | "lease_expired" | "access_revoked" | "train_completed" | "train_unavailable" | "formation_changed" | "historical_external_leg";
export interface ConductorSessionSnapshotV1 {
  readonly schemaVersion: "conductor-session-snapshot/v1"; readonly worldId: string; readonly trainRunId: string;
  readonly sessionId: string; readonly operatorId: string; readonly status: ConductorSessionStatusV1;
  readonly revision: number; readonly sequence: number; readonly nowMs: number; readonly leaseUntilMs: number;
  readonly endReason: ConductorSessionEndReasonV1 | null; readonly position: InteriorPointV1; readonly pins: ConductorSessionPinsV1;
  readonly passengers: PassengerProjectionV2; readonly activeEncounter: PassengerEncounterV1 | null; readonly snapshotHash: string;
}
export type ConductorCommandActionV1 = { readonly type: "start_session" | "detach_session" | "resume_session" | "end_session" }
  | { readonly type: "move"; readonly to: InteriorPointV1; readonly transitionEdgeId: string | null }
  | { readonly type: "start_inspection"; readonly passengerKey: string }
  | { readonly type: "choose_dialogue_option" | "request_police"; readonly optionId: string };
export interface ConductorCommandV1 {
  readonly schemaVersion: "conductor-command/v1"; readonly worldId: string; readonly trainRunId: string; readonly sessionId: string;
  readonly expectedRevision: number; readonly expectedManifestRevision: number | null; readonly idempotencyKey: string;
  readonly action: ConductorCommandActionV1;
}
export interface ConductorCommandReceiptV1 {
  readonly schemaVersion: string; readonly worldId: string; readonly trainRunId: string; readonly sessionId: string;
  readonly idempotencyKey: string; readonly commandHash: string; readonly revision: number; readonly sequence: number; readonly eventKind: string;
}
/** Opaquer privater Kernzustand; niemals als HTTP-Antwort verwenden. */
export interface ConductorTrainStateV1 extends Readonly<Record<string, unknown>> {
  readonly schemaVersion: "conductor-train-state/v1"; readonly worldId: string; readonly trainRunId: string;
  readonly revision: number; readonly sequence: number; readonly nowMs: number; readonly stateHash: string;
  readonly session: (Readonly<Record<string, unknown>> & { readonly sessionId: string; readonly ownerRef: string;
    readonly status: ConductorSessionStatusV1; readonly revision: number; readonly leaseUntilMs: number; readonly operatorId: string }) | null;
  readonly layout: InteriorLayoutV1 | null; readonly passengers: PassengerProjectionV2 | null;
  readonly encounters: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly controlReceipts: Readonly<Record<string, ConductorSessionControlReceiptV1>>;
  readonly commandReceipts: Readonly<Record<string, ConductorCommandReceiptV1>>;
}
export interface ConductorSessionEffectV1 {
  readonly worldId: string; readonly trainRunId: string; readonly effectId: string; readonly encounterId: string;
  readonly passengerKey: string; readonly kind: "close_without_action" | "request_document_check" | "request_regular_claim" | "request_provisional_claim" | "request_police";
  readonly atMs: number;
}
export interface ConductorSessionTransitionV1 {
  readonly schemaVersion: string; readonly state: ConductorTrainStateV1; readonly stateHash: string;
  readonly receipt: ConductorCommandReceiptV1 | null; readonly snapshot: ConductorSessionSnapshotV1 | null;
  readonly events: readonly Readonly<Record<string, unknown>>[]; readonly effects: readonly ConductorSessionEffectV1[];
}
export interface ApplyConductorSessionCommandInputV1 {
  readonly schemaVersion: "conductor-session-apply-input/v1"; readonly state: ConductorTrainStateV1; readonly expectedStateHash: string;
  readonly command: ConductorCommandV1; readonly access: ConductorSessionAccessV1; readonly source: ConductorSessionSourceV1;
}
export interface SynchronizeConductorSessionInputV1 {
  readonly schemaVersion: "conductor-session-synchronize-input/v1"; readonly state: ConductorTrainStateV1; readonly expectedStateHash: string;
  readonly access: ConductorSessionAccessV1; readonly source: ConductorSessionSourceV1; readonly causalityId: string;
}
