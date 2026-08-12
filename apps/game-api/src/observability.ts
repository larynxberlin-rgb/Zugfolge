import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HealthReport } from "@zugfolge/health";

const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TRACEPARENT = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/;
const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000] as const;

interface RequestTrace {
  readonly startedAt: bigint;
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;
}

interface MetricEntry {
  count: number;
  durationMs: number;
  buckets: number[];
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function routeLabel(request: FastifyRequest): string {
  return request.routeOptions.url ?? "unmatched";
}

export function requestCorrelationId(request: { readonly headers: Record<string, string | readonly string[] | undefined> }): string {
  const supplied = firstHeader(request.headers["x-correlation-id"]);
  return supplied !== undefined && CORRELATION_ID.test(supplied) ? supplied : randomUUID();
}

export class ApiObservability {
  readonly #requests = new WeakMap<FastifyRequest, RequestTrace>();
  readonly #metrics = new Map<string, MetricEntry>();
  #active = 0;
  readonly #health = new Map<string, { readonly status: "ok" | "degraded" | "down"; readonly durationMs: number }>();

  observeHealth(report: HealthReport): void {
    for (const check of report.checks) this.#health.set(check.name, { status: check.status, durationMs: check.durationMs });
  }

  register(app: FastifyInstance): void {
    app.addHook("onRequest", async (request, reply) => {
      const supplied = firstHeader(request.headers.traceparent);
      const match = supplied?.match(TRACEPARENT);
      const traceId = match?.[1] ?? randomBytes(16).toString("hex");
      const traceFlags = match?.[3] ?? "01";
      const spanId = randomBytes(8).toString("hex");
      this.#requests.set(request, { startedAt: process.hrtime.bigint(), traceId, spanId, traceFlags });
      this.#active += 1;
      reply.header("x-correlation-id", request.id);
      reply.header("traceparent", `00-${traceId}-${spanId}-${traceFlags}`);
    });

    app.addHook("onResponse", async (request, reply) => {
      const trace = this.#requests.get(request);
      if (trace === undefined) return;
      this.#active = Math.max(0, this.#active - 1);
      const durationMs = Number(process.hrtime.bigint() - trace.startedAt) / 1_000_000;
      const route = routeLabel(request);
      const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
      const key = JSON.stringify([request.method, route, statusClass]);
      const metric = this.#metrics.get(key) ?? { count: 0, durationMs: 0, buckets: BUCKETS_MS.map(() => 0) };
      metric.count += 1;
      metric.durationMs += durationMs;
      for (let index = 0; index < BUCKETS_MS.length; index += 1) {
        if (durationMs <= BUCKETS_MS[index]!) metric.buckets[index]! += 1;
      }
      this.#metrics.set(key, metric);
      request.log.info({
        correlationId: request.id,
        traceId: trace.traceId,
        spanId: trace.spanId,
        method: request.method,
        route,
        statusCode: reply.statusCode,
        durationMs: Math.round(durationMs * 1_000) / 1_000,
      }, "http.request.completed");
      this.#requests.delete(request);
    });

    app.get("/metrics", async (_request, reply) => reply
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(this.renderPrometheus()));
  }

  renderPrometheus(): string {
    const lines = [
      "# HELP zugfolge_http_requests_total Completed Game API requests.",
      "# TYPE zugfolge_http_requests_total counter",
      "# HELP zugfolge_http_request_duration_milliseconds Game API request duration.",
      "# TYPE zugfolge_http_request_duration_milliseconds histogram",
      "# HELP zugfolge_http_requests_active Requests currently being processed.",
      "# TYPE zugfolge_http_requests_active gauge",
      `zugfolge_http_requests_active ${this.#active}`,
      "# HELP zugfolge_health_check_state Last readiness state as a one-hot gauge.",
      "# TYPE zugfolge_health_check_state gauge",
      "# HELP zugfolge_health_check_duration_milliseconds Last readiness check duration.",
      "# TYPE zugfolge_health_check_duration_milliseconds gauge",
    ];
    const entries = [...this.#metrics.entries()].sort(([left], [right]) => left.localeCompare(right));
    for (const [key, metric] of entries) {
      const [method, route, statusClass] = JSON.parse(key) as [string, string, string];
      const labels = `method="${escapeLabel(method)}",route="${escapeLabel(route)}",status_class="${escapeLabel(statusClass)}"`;
      lines.push(`zugfolge_http_requests_total{${labels}} ${metric.count}`);
      for (let index = 0; index < BUCKETS_MS.length; index += 1) {
        lines.push(`zugfolge_http_request_duration_milliseconds_bucket{${labels},le="${BUCKETS_MS[index]}"} ${metric.buckets[index]}`);
      }
      lines.push(`zugfolge_http_request_duration_milliseconds_bucket{${labels},le="+Inf"} ${metric.count}`);
      lines.push(`zugfolge_http_request_duration_milliseconds_sum{${labels}} ${metric.durationMs}`);
      lines.push(`zugfolge_http_request_duration_milliseconds_count{${labels}} ${metric.count}`);
    }
    for (const [check, outcome] of [...this.#health].sort(([left], [right]) => left.localeCompare(right))) {
      for (const state of ["ok", "degraded", "down"] as const) {
        lines.push(`zugfolge_health_check_state{check="${escapeLabel(check)}",state="${state}"} ${outcome.status === state ? 1 : 0}`);
      }
      lines.push(`zugfolge_health_check_duration_milliseconds{check="${escapeLabel(check)}"} ${outcome.durationMs}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
