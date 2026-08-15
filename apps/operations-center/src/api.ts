import type { OperatingProgram } from "@zugfolge/dispatch";

export interface ProgramVersion {
  readonly version: number;
  readonly status: "draft" | "active" | "superseded";
  readonly checksum: string;
  readonly canonicalProgram: OperatingProgram;
}

export interface OperationsDecision {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly trainRunId: string;
  readonly decisionId: string;
  readonly action: string;
  readonly cause: string;
  readonly causeCode: number | null;
  readonly causeLabel: string;
  readonly fineCauseId: string;
  readonly fineCauseLabel: string;
  readonly affectedResource: string;
  readonly outcomeReason: string;
  readonly impact: Record<string, unknown>;
  readonly raw: Record<string, unknown>;
}

export interface OperationsProjection {
  readonly throughSequence: number;
  readonly decisions: readonly OperationsDecision[];
  readonly cancellations: readonly OperationsDecision[];
  readonly manualInterventions: readonly OperationsDecision[];
  readonly majorEvents: readonly OperationsDecision[];
}

export interface DailyReportRow {
  readonly serviceDay: string;
  readonly projection: {
    readonly trainRuns: { readonly total: number; readonly punctual: number; readonly delayed: number; readonly cancelled: number; readonly replacementServices: number };
    readonly settlements: { readonly revenueCents: string; readonly costCents: string; readonly contractPenaltyCents: string };
    readonly decisionsByAction: Readonly<Record<string, number>>;
    readonly infrastructureEffects: readonly string[];
    readonly personnelEffects: readonly string[];
    readonly vehicleEffects: readonly string[];
    readonly facts: {
      readonly eventSequences: readonly number[];
      readonly decisions: readonly {
        readonly eventSequence: number;
        readonly occurredAt: string;
        readonly eventType: string;
        readonly decisionId: string;
        readonly trainRunId: string;
        readonly programVersion: number | null;
        readonly ruleId: string;
        readonly action: string;
        readonly conditions: readonly unknown[];
        readonly limits: readonly unknown[];
        readonly rejectedAlternatives: readonly unknown[];
        readonly manualOverride: boolean;
        readonly outcomeReason: string;
        readonly impact: Readonly<Record<string, unknown>>;
      }[];
    };
    readonly assessment: { readonly nextLevers: readonly string[] };
  };
}

interface Template { readonly id: string; readonly name: string; readonly program: OperatingProgram }

export class OperationsApi {
  readonly #base: string;
  readonly #token: string | ((forceRefresh?: boolean) => Promise<string>);
  readonly #worldId: string;
  readonly #operatorId: string;

  constructor(base: string, token: string | ((forceRefresh?: boolean) => Promise<string>), worldId: string, operatorId: string) {
    this.#base = base.replace(/\/$/, "");
    this.#token = token;
    this.#worldId = worldId;
    this.#operatorId = operatorId;
  }

  get path(): string { return `${this.#base}/worlds/${encodeURIComponent(this.#worldId)}/operators/${encodeURIComponent(this.#operatorId)}`; }

  #accessToken(forceRefresh = false): Promise<string> {
    return typeof this.#token === "string" ? Promise.resolve(this.#token) : this.#token(forceRefresh);
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const request = async (forceRefresh = false): Promise<Response> => fetch(`${this.path}${path}`, { ...init, headers: { authorization: `Bearer ${await this.#accessToken(forceRefresh)}`, "content-type": "application/json", ...init?.headers } });
    let response = await request();
    if ((response.status === 401 || response.status === 403) && typeof this.#token !== "string") response = await request(true);
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  templates(): Promise<readonly Template[]> { return this.#request("/operating-programs/templates"); }
  versions(): Promise<readonly ProgramVersion[]> { return this.#request("/operating-programs"); }
  save(program: OperatingProgram): Promise<ProgramVersion> { return this.#request("/operating-programs", { method: "POST", body: JSON.stringify({ program }) }); }
  activate(version: number): Promise<unknown> { return this.#request(`/operating-programs/${version}/activate`, { method: "POST", body: "{}" }); }
  operations(): Promise<OperationsProjection> { return this.#request("/operations"); }
  backtest(programVersion: number, sourceThrough: number): Promise<unknown> { return this.#request("/operating-programs/backtests", { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), programVersion, sourceAfter: 0, sourceThrough: Math.max(1, sourceThrough) }) }); }
  override(decisionId: string, action: string, reason: string): Promise<unknown> { return this.#request(`/operations/decisions/${encodeURIComponent(decisionId)}/override`, { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), action, reason, at: Math.floor(Date.now() / 1_000) }) }); }
  reports(): Promise<readonly DailyReportRow[]> { return this.#request("/operations/reports"); }
  generateReport(serviceDay: string): Promise<DailyReportRow> { return this.#request(`/operations/reports/${serviceDay}/generate`, { method: "POST", body: "{}" }); }

  async stream(signal: AbortSignal, after: number, onDecision: (decision: OperationsDecision) => void): Promise<void> {
    const response = await fetch(`${this.path}/operations/events`, { headers: { authorization: `Bearer ${await this.#accessToken()}`, accept: "text/event-stream", "last-event-id": String(after) }, signal });
    if (!response.ok || response.body === null) throw new Error(`Live-Betrieb nicht verfügbar (HTTP ${response.status}).`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += value;
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (data !== undefined && data !== "{}") {
          const parsed = JSON.parse(data) as { decision: OperationsDecision };
          onDecision(parsed.decision);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  }
}
