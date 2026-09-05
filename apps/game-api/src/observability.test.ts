import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { AlphaOperationsMetrics, ApiObservability, requestCorrelationId } from "./observability.js";

describe("Game API observability", () => {
  it("propagates safe correlation ids and creates a child W3C trace span", async () => {
    const app = Fastify({ logger: false, genReqId: requestCorrelationId });
    new ApiObservability().register(app);
    app.get("/probe", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/probe",
      headers: {
        "x-correlation-id": "alpha-e2e:step-7",
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      },
    });

    expect(response.headers["x-correlation-id"]).toBe("alpha-e2e:step-7");
    expect(response.headers.traceparent).toMatch(/^00-11111111111111111111111111111111-[a-f0-9]{16}-01$/);
    await app.close();
  });

  it("does not reflect malformed correlation ids and exposes bounded-cardinality metrics", async () => {
    const app = Fastify({ logger: false, genReqId: requestCorrelationId });
    const internal = Fastify({ logger: false });
    const observability = new ApiObservability();
    observability.register(app);
    observability.registerMetrics(internal);
    app.get("/worlds/:worldId/probe", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/worlds/00000000-0000-4000-8000-000000000001/probe",
      headers: { "x-correlation-id": "invalid correlation header\n" },
    });
    expect(response.headers["x-correlation-id"]).toMatch(/^[a-f0-9-]{36}$/);

    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    const metrics = await internal.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('route="/worlds/:worldId/probe"');
    expect(metrics.body).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(metrics.body).toContain("zugfolge_http_request_duration_milliseconds_bucket");
    await app.close();
    await internal.close();
  });

  it("exports healthy, degraded and down as explicit non-colour-only states", () => {
    const observability = new ApiObservability();
    observability.observeHealth({ status: "degraded", checks: [
      { name: "odoo-bridge", status: "degraded", durationMs: 17, code: "queue_delayed" },
      { name: "postgres", status: "ok", durationMs: 2, code: "schema_current" },
    ] });
    const metrics = observability.renderPrometheus();
    expect(metrics).toContain('zugfolge_health_check_state{check="odoo-bridge",state="degraded"} 1');
    expect(metrics).toContain('zugfolge_health_check_state{check="postgres",state="ok"} 1');
    expect(metrics).toContain('zugfolge_health_check_duration_milliseconds{check="odoo-bridge"} 17');
  });

  it("exports the live queue, bridge, freshness and market projection with bounded labels", () => {
    const alpha = new AlphaOperationsMetrics();
    alpha.observe({
      world: { worldId: "world-alpha" },
      freshness: { eventAgeSeconds: 4, projectionAgeSeconds: 7 },
      workers: { planningQueueDepth: 2, economyOutboxDepth: 3, odooCommandQueue: { pending: 1 } },
      bridges: { odooProjection: { pending: 5, failed: 1 } },
      market: { projectionClass: "derived-metric", listings: { open: 8 }, transfers: { sale: 2 }, contracts: { "traction:active": 3 } },
    } as never);
    const metrics = alpha.renderPrometheus().join("\n");
    expect(metrics).toContain('zugfolge_alpha_queue_depth{world_id="world-alpha",queue="odoo_command_pending"} 1');
    expect(metrics).toContain('zugfolge_alpha_odoo_projection_pending{world_id="world-alpha"} 5');
    expect(metrics).toContain('zugfolge_alpha_market_items{world_id="world-alpha",kind="listings",state="open"} 8');
    expect(metrics).not.toContain("participant");
    expect(metrics).not.toContain('kind="projectionClass"');
    for (const line of metrics.split("\n").filter((line) => !line.startsWith("#"))) expect(line).toMatch(/\s\d+(?:\.\d+)?$/);
  });

  it("distinguishes an empty market from missing telemetry", () => {
    const alpha = new AlphaOperationsMetrics();
    alpha.observe({
      world: { worldId: "world-empty" },
      freshness: { eventAgeSeconds: null, projectionAgeSeconds: null },
      workers: { planningQueueDepth: 0, economyOutboxDepth: 0, odooCommandQueue: {} },
      bridges: { odooProjection: { pending: 0, failed: 0 } },
      market: { listings: {}, transfers: {}, contracts: {} },
    } as never);
    const metrics = alpha.renderPrometheus().join("\n");
    expect(metrics).toContain('zugfolge_alpha_market_items{world_id="world-empty",kind="listings",state="none"} 0');
  });
});
