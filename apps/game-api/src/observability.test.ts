import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { ApiObservability, requestCorrelationId } from "./observability.js";

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
    new ApiObservability().register(app);
    app.get("/worlds/:worldId/probe", async () => ({ ok: true }));

    const response = await app.inject({
      method: "GET",
      url: "/worlds/00000000-0000-4000-8000-000000000001/probe",
      headers: { "x-correlation-id": "invalid correlation header\n" },
    });
    expect(response.headers["x-correlation-id"]).toMatch(/^[a-f0-9-]{36}$/);

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('route="/worlds/:worldId/probe"');
    expect(metrics.body).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(metrics.body).toContain("zugfolge_http_request_duration_milliseconds_bucket");
    await app.close();
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
});
