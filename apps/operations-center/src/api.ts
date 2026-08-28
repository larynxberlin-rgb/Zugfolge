import type { OperatingProgram } from "@zugfolge/dispatch";
import {
  parsePlayerOperatorContext,
  type PlayerOperatorContextV1,
} from "@zugfolge/player-context";

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

type ReconnectWait = (durationMs: number, signal: AbortSignal) => Promise<void>;

const MAX_STREAM_RECONNECT_ATTEMPTS = 8;
const MAX_STREAM_RECONNECT_DELAY_MS = 30_000;

class OperationsStreamProtocolError extends Error {}

function reconnectDelayMs(attempt: number): number {
  return Math.min(MAX_STREAM_RECONNECT_DELAY_MS, 1_000 * (2 ** Math.min(attempt, 5)));
}

function waitForReconnect(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const complete = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", complete);
      resolve();
    };
    const timer = setTimeout(complete, durationMs);
    signal.addEventListener("abort", complete, { once: true });
  });
}

function decisionFromFrame(data: string): OperationsDecision {
  const parsed: unknown = JSON.parse(data);
  if (typeof parsed !== "object" || parsed === null || !("decision" in parsed)) {
    throw new OperationsStreamProtocolError("Live-Betrieb lieferte kein Entscheidungsereignis.");
  }
  const decision = (parsed as { decision?: unknown }).decision;
  if (typeof decision !== "object" || decision === null) {
    throw new OperationsStreamProtocolError("Live-Betrieb lieferte kein Entscheidungsereignis.");
  }
  const sequence = (decision as { sequence?: unknown }).sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    throw new OperationsStreamProtocolError("Live-Betrieb lieferte keine gueltige Ereignissequenz.");
  }
  return decision as OperationsDecision;
}

export class OperationsApi {
  readonly #base: string;
  readonly #token: string | ((forceRefresh?: boolean) => Promise<string>);
  readonly #worldId: string;
  readonly #operatorId: string;
  readonly #fetch: typeof fetch;
  readonly #reconnectWait: ReconnectWait;

  constructor(
    base: string,
    token: string | ((forceRefresh?: boolean) => Promise<string>),
    worldId: string,
    operatorId: string,
    fetchImplementation: typeof fetch = fetch,
    reconnectWait: ReconnectWait = waitForReconnect,
  ) {
    this.#base = base.replace(/\/$/, "");
    this.#token = token;
    this.#worldId = worldId;
    this.#operatorId = operatorId;
    this.#fetch = fetchImplementation;
    this.#reconnectWait = reconnectWait;
  }

  get path(): string { return `${this.#base}/worlds/${encodeURIComponent(this.#worldId)}/operators/${encodeURIComponent(this.#operatorId)}`; }

  #accessToken(forceRefresh = false): Promise<string> {
    return typeof this.#token === "string" ? Promise.resolve(this.#token) : this.#token(forceRefresh);
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const request = async (forceRefresh = false): Promise<Response> => this.#fetch(`${this.path}${path}`, { ...init, headers: { authorization: `Bearer ${await this.#accessToken(forceRefresh)}`, "content-type": "application/json", ...init?.headers } });
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
  context(): Promise<PlayerOperatorContextV1> {
    const path = `${this.#base}/worlds/${encodeURIComponent(this.#worldId)}/me/operator-context`;
    const request = async (forceRefresh = false): Promise<Response> => this.#fetch(path, { headers: { authorization: `Bearer ${await this.#accessToken(forceRefresh)}` } });
    return request().then(async (initial) => {
      const response = (initial.status === 401 || initial.status === 403) && typeof this.#token !== "string" ? await request(true) : initial;
      if (!response.ok) throw new Error(`EVU-Kontext nicht verfügbar (HTTP ${response.status}).`);
      return parsePlayerOperatorContext(await response.json(), this.#worldId);
    });
  }

  async stream(
    signal: AbortSignal,
    after: number,
    onDecision: (decision: OperationsDecision) => void,
    onReset: (projection: OperationsProjection) => void = () => undefined,
  ): Promise<void> {
    if (!Number.isSafeInteger(after) || after < 0) throw new RangeError("Live-Betrieb besitzt keine gueltige Startsequenz.");
    let cursor = after;
    let reconnectAttempts = 0;
    while (!signal.aborted) {
      try {
        const request = async (forceRefresh = false): Promise<Response> => this.#fetch(`${this.path}/operations/events`, {
          headers: {
            authorization: `Bearer ${await this.#accessToken(forceRefresh)}`,
            accept: "text/event-stream",
            "last-event-id": String(cursor),
          },
          signal,
        });
        let response = await request();
        if ((response.status === 401 || response.status === 403) && typeof this.#token !== "string") {
          response = await request(true);
        }
        if (response.status === 401 || response.status === 403) {
          throw new OperationsStreamProtocolError(`Live-Betrieb benötigt eine neue Anmeldung (HTTP ${response.status}).`);
        }
        if (!response.ok) {
          if (response.status < 500 && response.status !== 408 && response.status !== 425 && response.status !== 429) {
            throw new OperationsStreamProtocolError(`Live-Betrieb nicht verfügbar (HTTP ${response.status}).`);
          }
          throw new Error(`Live-Betrieb vorübergehend nicht verfügbar (HTTP ${response.status}).`);
        }
        if (response.body === null) throw new Error("Live-Betrieb lieferte keinen Ereignisstrom.");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let receivedEvent = false;
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer = `${buffer}${value}`.replace(/\r\n/gu, "\n");
            let boundary = buffer.indexOf("\n\n");
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const lines = frame.split("\n");
              const event = lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "message";
              const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
              if (event === "reset") {
                if (data !== "{}") throw new OperationsStreamProtocolError("Live-Betrieb lieferte einen ungueltigen Reset.");
                const projection = await this.operations();
                if (!Number.isSafeInteger(projection.throughSequence) || projection.throughSequence < 0) {
                  throw new OperationsStreamProtocolError("Live-Betrieb lieferte keine gueltige Snapshot-Sequenz.");
                }
                cursor = projection.throughSequence;
                receivedEvent = true;
                onReset(projection);
              } else if (data !== undefined && data !== "{}") {
                const decision = decisionFromFrame(data);
                if (decision.sequence > cursor) {
                  cursor = decision.sequence;
                  receivedEvent = true;
                  onDecision(decision);
                }
              }
              boundary = buffer.indexOf("\n\n");
            }
          }
        } finally {
          reader.releaseLock();
        }
        reconnectAttempts = receivedEvent ? 1 : reconnectAttempts + 1;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof OperationsStreamProtocolError) throw error;
        reconnectAttempts += 1;
      }
      if (signal.aborted) return;
      if (reconnectAttempts > MAX_STREAM_RECONNECT_ATTEMPTS) {
        throw new Error("Live-Verbindung konnte nach mehreren Versuchen nicht wiederhergestellt werden.");
      }
      await this.#reconnectWait(reconnectDelayMs(reconnectAttempts - 1), signal);
    }
  }
}
