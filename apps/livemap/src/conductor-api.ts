import type { ConductorCommandV1, ConductorSessionSnapshotV1, InteriorLayoutV1, InteriorPointV1 } from "@zugfolge/runtime-native";
import type { ConductorArtViewV1, ConductorSceneViewV1 } from "./conductor-renderer.js";

export interface ConductorResponse {
  readonly schemaVersion: "conductor-session-response/v1";
  readonly snapshot: ConductorSessionSnapshotV1;
  readonly layout: InteriorLayoutV1;
  readonly scene?: ConductorSceneViewV1 | null;
  readonly control?: ConductorControlStatus | null;
}
export interface ConductorControlStatus {
  readonly schemaVersion: "conductor-control-status/v1";
  readonly days: readonly { readonly dayStartMs: number; readonly contractRevenueCents: string; readonly netCents: string;
    readonly premiumCents: string; readonly capAdjustmentCents: string; readonly contributionCents: string; readonly settlementRevision: number }[];
  readonly cases: readonly { readonly caseId: string; readonly encounterId: string; readonly trainRunId: string;
    readonly status: "open" | "closed_without_claim" | "claim_open" | "settled"; readonly claimKind: "regular" | "provisional" | null;
    readonly claimCents: string; readonly paidCents: string; readonly costsCents: string; readonly writtenOffCents: string; readonly proofDeadlineMs: number }[];
  readonly hold: { readonly holdId: string; readonly targetStopId: string; readonly status: "requested" | "active" | "released";
    readonly deadlineMs: number | null; readonly outcome: "identity_confirmed" | "identity_not_confirmed" | "unavailable" | "timeout" | "target_unavailable" | null } | null;
}
export interface ConductorControlUpdate {
  readonly schemaVersion: "conductor-control-update/v1"; readonly worldId: string; readonly trainRunId: string;
  readonly sessionId: string; readonly sequence: number; readonly control: ConductorControlStatus;
}
export interface ConductorAvailability { available: true; revision: number; manifestRevision: number; sessionId: string | null }
export interface ConductorSceneUpdate {
  readonly schemaVersion: "conductor-scene-update/v1"; readonly worldId: string; readonly trainRunId: string;
  readonly sessionId: string; readonly sequence: number; readonly scene: ConductorSceneViewV1;
}
export interface ConductorWalkingPath { readonly layoutHash: string; readonly from: InteriorPointV1;
  readonly points: readonly { readonly to: InteriorPointV1; readonly transitionEdgeId: string | null }[] }
export class ConductorApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export class ConductorApi {
  readonly #base: string;
  constructor(base: string, readonly worldId: string, readonly operatorId: string, readonly trainRunId: string,
    private readonly token: (refresh?: boolean) => Promise<string>) {
    this.#base = `${base.replace(/\/$/u, "")}/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/trains/${encodeURIComponent(trainRunId)}/conductor-sessions`;
  }
  private async request(path: string, init: RequestInit = {}, refreshed = false): Promise<Response> {
    const accessToken = await this.token(refreshed);
    const response = await fetch(`${this.#base}${path}`, { ...init, cache: "no-store", credentials: "omit",
      headers: { ...init.headers, authorization: `Bearer ${accessToken}` } });
    if (response.status === 401 && !refreshed) return this.request(path, init, true);
    if (!response.ok) {
      const problem = await response.json().catch(() => ({})) as { code?: unknown; error?: unknown };
      throw new ConductorApiError(response.status, typeof problem.code === "string" ? problem.code : "conductor_unavailable",
        typeof problem.error === "string" ? problem.error : "Die Verbindung zur Fahrt ist momentan nicht verfügbar.");
    }
    return response;
  }
  private response(value: ConductorResponse): ConductorResponse {
    if (value.schemaVersion !== "conductor-session-response/v1" || value.snapshot.worldId !== this.worldId
      || value.snapshot.operatorId !== this.operatorId || value.snapshot.trainRunId !== this.trainRunId
      || value.layout.layoutHash !== value.snapshot.pins.interiorLayoutHash) throw new Error("Die Antwort gehört nicht zum bestätigten Fahrtstand.");
    return value;
  }
  async availability(): Promise<ConductorAvailability> { return (await this.request("")).json() as Promise<ConductorAvailability>; }
  async snapshot(): Promise<ConductorResponse> { return this.response(await (await this.request("/snapshot")).json() as ConductorResponse); }
  async report(): Promise<ConductorControlStatus> {
    const value = await (await this.request("/report")).json() as { schemaVersion: string; worldId: string; operatorId: string; trainRunId: string; control: ConductorControlStatus };
    if (value.schemaVersion !== "conductor-report/v1" || value.worldId !== this.worldId || value.operatorId !== this.operatorId
      || value.trainRunId !== this.trainRunId || value.control.schemaVersion !== "conductor-control-status/v1"
      || value.control.cases.some((row) => row.trainRunId !== this.trainRunId)) throw new Error("Der Kontrollbericht gehört nicht zu deinem Unternehmen und dieser Fahrt.");
    return value.control;
  }
  async command(command: ConductorCommandV1): Promise<ConductorResponse> {
    return this.response(await (await this.request("", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) })).json() as ConductorResponse);
  }
  async art(): Promise<ConductorArtViewV1> { return (await this.request("/art")).json() as Promise<ConductorArtViewV1>; }
  async atlas(fileId: string): Promise<Uint8Array> { return new Uint8Array(await (await this.request(`/atlas/${encodeURIComponent(fileId)}`)).arrayBuffer()); }
  async path(nodeId: string): Promise<ConductorWalkingPath> { return (await this.request(`/path?targetNodeId=${encodeURIComponent(nodeId)}`)).json() as Promise<ConductorWalkingPath>; }

  /** One authenticated stream; the caller obtains a fresh snapshot before reconnecting. */
  async stream(sequence: number, signal: AbortSignal, receive: (value: ConductorResponse | ConductorSessionSnapshotV1 | ConductorSceneUpdate | ConductorControlUpdate) => void): Promise<void> {
    const response = await this.request(`/events?afterSequence=${sequence}`, { signal, headers: { accept: "text/event-stream" } });
    if (response.body === null || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("Der Sitzungsstrom fehlt.");
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Die Verbindung wurde unterbrochen.");
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 16 * 1024 * 1024) throw new Error("Der Sitzungsstrom ist zu groß.");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const lines = event.split("\n"), kind = lines.find((line) => line.startsWith("event: "))?.slice(7);
          const json = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (!json) continue;
          const value = JSON.parse(json) as ConductorResponse | ConductorSessionSnapshotV1 | { error: string };
          if (kind === "unavailable") throw new Error((value as { error: string }).error);
          if (kind === "snapshot") receive(this.response(value as ConductorResponse));
          if (kind === "state") {
            const state = value as ConductorSessionSnapshotV1;
            if (state.worldId !== this.worldId || state.operatorId !== this.operatorId || state.trainRunId !== this.trainRunId) throw new Error("Der Sitzungsstrom gehört zu einer anderen Fahrt.");
            receive(state);
          }
          if (kind === "scene") {
            const update = value as unknown as ConductorSceneUpdate;
            if (update.schemaVersion !== "conductor-scene-update/v1" || update.worldId !== this.worldId || update.trainRunId !== this.trainRunId
              || update.scene.binding.worldId !== this.worldId || update.scene.binding.trainRunId !== this.trainRunId) throw new Error("Die Umgebung gehört zu einer anderen Fahrt.");
            receive(update);
          }
          if (kind === "control") {
            const update = value as unknown as ConductorControlUpdate;
            if (update.schemaVersion !== "conductor-control-update/v1" || update.worldId !== this.worldId || update.trainRunId !== this.trainRunId
              || update.control.schemaVersion !== "conductor-control-status/v1" || update.control.cases.some((row) => row.trainRunId !== this.trainRunId))
              throw new Error("Die Kontrollbelege gehören zu einer anderen Fahrt.");
            receive(update);
          }
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
