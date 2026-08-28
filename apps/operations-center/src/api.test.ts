import { describe, expect, it, vi } from "vitest";

import { OperationsApi, type OperationsDecision } from "./api.js";

function decision(sequence: number): OperationsDecision {
  return {
    sequence,
    occurredAt: "2026-01-01T00:00:00.000Z",
    trainRunId: `train-${sequence}`,
    decisionId: `decision-${sequence}`,
    action: "continue",
    cause: "plan",
    causeCode: null,
    causeLabel: "Plan",
    fineCauseId: "plan",
    fineCauseLabel: "Plan",
    affectedResource: "route-1",
    outcomeReason: "planmaessig",
    impact: {},
    raw: {},
  };
}

function eventStream(...decisions: readonly OperationsDecision[]): Response {
  const bytes = new TextEncoder().encode(decisions.map((item) => `data: ${JSON.stringify({ decision: item })}\n\n`).join(""));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function rawEventStream(value: string): Response {
  const bytes = new TextEncoder().encode(value);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OperationsApi Live-Betrieb", () => {
  it("erneuert den Zugriff nach 401 vor dem SSE-Handshake", async () => {
    const controller = new AbortController();
    const token = vi.fn(async (forceRefresh = false) => forceRefresh ? "neu" : "alt");
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(eventStream(decision(1)));
    const api = new OperationsApi("https://api.example", token, "welt", "evu", request, vi.fn(async () => {}));
    const received: OperationsDecision[] = [];

    await api.stream(controller.signal, 0, (item) => {
      received.push(item);
      controller.abort();
    });

    expect(token.mock.calls.map(([forceRefresh]) => forceRefresh ?? false)).toEqual([false, true]);
    expect(request.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"))).toEqual([
      "Bearer alt",
      "Bearer neu",
    ]);
    expect(received.map(({ sequence }) => sequence)).toEqual([1]);
  });

  it("verbindet nach Stream-Ende neu und setzt bei Last-Event-ID verlustfrei fort", async () => {
    const controller = new AbortController();
    const request = vi.fn()
      .mockResolvedValueOnce(eventStream(decision(7)))
      .mockResolvedValueOnce(eventStream(decision(8)));
    const reconnect = vi.fn(async () => {});
    const api = new OperationsApi("https://api.example", "token", "welt", "evu", request, reconnect);
    const received: number[] = [];

    await api.stream(controller.signal, 6, (item) => {
      received.push(item.sequence);
      if (item.sequence === 8) controller.abort();
    });

    expect(received).toEqual([7, 8]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("last-event-id")).toBe("6");
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("last-event-id")).toBe("7");
    expect(reconnect).toHaveBeenCalledWith(1_000, controller.signal);
  });

  it("verbindet nach einem vorübergehenden Serverfehler mit Backoff neu", async () => {
    const controller = new AbortController();
    const request = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(eventStream(decision(3)));
    const reconnect = vi.fn(async () => {});
    const api = new OperationsApi("https://api.example", "token", "welt", "evu", request, reconnect);

    await api.stream(controller.signal, 2, () => controller.abort());

    expect(request).toHaveBeenCalledTimes(2);
    expect(reconnect).toHaveBeenCalledWith(1_000, controller.signal);
  });

  it("beendet einen Reconnect-Backoff beim Abbruch ohne weiteren Request", async () => {
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    let notifyReconnectEntered!: () => void;
    const reconnectEntered = new Promise<void>((resolve) => { notifyReconnectEntered = resolve; });
    const reconnect = vi.fn((_delayMs: number, signal: AbortSignal) => new Promise<void>((resolve) => {
      notifyReconnectEntered();
      signal.addEventListener("abort", () => resolve(), { once: true });
    }));
    const api = new OperationsApi("https://api.example", "token", "welt", "evu", request, reconnect);
    const onDecision = vi.fn();

    const streaming = api.stream(controller.signal, 0, onDecision);
    await reconnectEntered;
    expect(request).toHaveBeenCalledOnce();

    controller.abort();
    await expect(streaming).resolves.toBeUndefined();

    expect(reconnect).toHaveBeenCalledOnce();
    expect(reconnect).toHaveBeenCalledWith(1_000, controller.signal);
    expect(request).toHaveBeenCalledOnce();
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("laedt bei einem Reset den Snapshot und setzt danach an dessen Sequenz fort", async () => {
    const controller = new AbortController();
    const projection = {
      throughSequence: 10,
      decisions: [],
      cancellations: [],
      manualInterventions: [],
      majorEvents: [],
    };
    const request = vi.fn()
      .mockResolvedValueOnce(rawEventStream(`event: reset\ndata: {}\n\ndata: ${JSON.stringify({ decision: decision(11) })}\n\n`))
      .mockResolvedValueOnce(new Response(JSON.stringify(projection), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    const api = new OperationsApi("https://api.example", "token", "welt", "evu", request, vi.fn(async () => {}));
    const reset = vi.fn();
    const received: number[] = [];

    await api.stream(controller.signal, 2, (item) => {
      received.push(item.sequence);
      controller.abort();
    }, reset);

    expect(reset).toHaveBeenCalledWith(projection);
    expect(received).toEqual([11]);
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get("last-event-id")).toBe("2");
    expect(request.mock.calls[1]?.[0]).toBe("https://api.example/worlds/welt/operators/evu/operations");
  });
});
