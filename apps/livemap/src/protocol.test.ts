import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  appendRenderSample,
  applyDelta,
  initialState,
  LivemapConnection,
  operatorLabel,
  parseSnapshot,
  PUBLIC_OPERATION_MARKER_SCHEMA,
  PUBLIC_OPERATOR_LABEL,
  renderTrains,
  type Delta,
  type PublicTrain,
  type Snapshot,
} from "./protocol.js";

const WORLD_ID = "welt-1";
const TOKEN = "zugriff-token";

const baseTrain: PublicTrain = {
  id: "1",
  operator: "Elbtalbahn",
  trainNumber: "RE 1",
  category: "Regional",
  positionMm: 1_000,
  speedMmPerSecond: 20,
  delaySeconds: 0,
  nextOperatingPoint: "Halle Hbf",
  status: "running",
};

function snapshot(
  sequence: number,
  at = sequence * 10,
  train: PublicTrain = { ...baseTrain, positionMm: sequence * 1_000 },
  worldId = WORLD_ID,
): Snapshot {
  return { worldId, sequence, at, trains: [train] };
}

function delta(sequence: number, train: PublicTrain = { ...baseTrain, positionMm: sequence * 1_000 }): Delta {
  return {
    worldId: WORLD_ID,
    sequence,
    at: sequence * 10,
    changed: [train],
    removed: [],
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class SseChannel {
  readonly response: Response;
  cancelled = false;
  #controller!: ReadableStreamDefaultController<Uint8Array>;
  readonly #encoder = new TextEncoder();

  constructor() {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
      },
    });
    this.response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  }

  sendDelta(value: Delta, pieces = 1): void {
    const payload = `id: ${value.sequence}\ndata: ${JSON.stringify(value)}\n\n`;
    if (pieces === 1) {
      this.send(payload);
      return;
    }
    const width = Math.ceil(payload.length / pieces);
    for (let offset = 0; offset < payload.length; offset += width) {
      this.send(payload.slice(offset, offset + width));
    }
  }

  sendReset(): void {
    this.send("event: reset\ndata: {}\n\n");
  }

  send(payload: string): void {
    this.#controller.enqueue(this.#encoder.encode(payload));
  }

  close(): void {
    this.#controller.close();
  }

  fail(error = new Error("Stream abgebrochen")): void {
    this.#controller.error(error);
  }
}

type FetchReply = Response | Promise<Response> | Error;

function fetchHarness(snapshotReplies: FetchReply[], streamReplies: FetchReply[]) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const replies = url.endsWith("/livemap/snapshot") ? snapshotReplies : streamReplies;
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`Unerwarteter Fetch: ${url}`);
    if (reply instanceof Error) throw reply;
    return await reply;
  });
  return fetchMock;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshotCalls(fetchMock: ReturnType<typeof fetchHarness>): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/livemap/snapshot")).length;
}

function streamCalls(fetchMock: ReturnType<typeof fetchHarness>): number {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/livemap/events")).length;
}

async function settle(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

describe("Livemap-Projektion", () => {
  it("akzeptiert nur den versionierten Eigenbetriebsmarker und beschriftet ihn eindeutig", () => {
    const marked = parseSnapshot(
      snapshot(4, 100, {
        ...baseTrain,
        operationMarker: {
          schemaVersion: PUBLIC_OPERATION_MARKER_SCHEMA,
          kind: "public-operator",
        },
      }),
    ).trains[0]!;

    expect(marked.operationMarker).toEqual({
      schemaVersion: PUBLIC_OPERATION_MARKER_SCHEMA,
      kind: "public-operator",
    });
    expect(Object.isFrozen(marked.operationMarker)).toBe(true);
    expect(operatorLabel(marked)).toBe(PUBLIC_OPERATOR_LABEL);
    expect(operatorLabel(baseTrain)).toBe(baseTrain.operator);

    expect(() =>
      parseSnapshot({
        ...snapshot(4),
        trains: [
          {
            ...baseTrain,
            operationMarker: {
              schemaVersion: "zugfolge-livemap-operation-marker/v2",
              kind: "public-operator",
            },
          },
        ],
      }),
    ).toThrow(/unbekanntes Schema/);
  });

  it("verwirft Sequenz- und Zeitlücken", () => {
    const state = initialState(snapshot(4, 100, baseTrain));
    expect(applyDelta(state, { ...delta(6), at: 101 })).toBeUndefined();
    expect(applyDelta(state, { ...delta(5), at: 99 })).toBeUndefined();
  });

  it("interpoliert nur zwischen zwei autoritativen Samples und mutiert sie nicht", () => {
    const first = initialState(snapshot(4, 100, { ...baseTrain, positionMm: 1_000 }));
    const second = initialState(snapshot(5, 110, { ...baseTrain, positionMm: 1_200 }));
    const samples = appendRenderSample(appendRenderSample(undefined, first), second);

    expect(renderTrains(samples, 105)[0]?.positionMm).toBe(1_100);
    expect(renderTrains(samples, 90)[0]?.positionMm).toBe(1_000);
    expect(renderTrains(samples, 120)[0]?.positionMm).toBe(1_200);
    expect(first.trains.get("1")?.positionMm).toBe(1_000);
    expect(second.trains.get("1")?.positionMm).toBe(1_200);
  });
});

describe("LivemapConnection", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("authentifiziert Snapshot und Fetch-SSE und schließt die Snapshot-Race per Last-Event-ID", async () => {
    const channel = new SseChannel();
    const fetchMock = fetchHarness([jsonResponse(snapshot(4))], [channel.response]);
    const changes = vi.fn();
    const connection = new LivemapConnection("https://api.test", WORLD_ID, TOKEN, changes, {
      fetch: fetchMock,
      retryDelayMs: 10,
    });

    await connection.connect();
    const snapshotHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const streamHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(snapshotHeaders.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(streamHeaders.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(streamHeaders.get("last-event-id")).toBe("4");

    channel.sendDelta(delta(5), 5);
    await settle();
    expect(changes.mock.calls.at(-1)?.[0]).toMatchObject({ worldId: WORLD_ID, sequence: 5 });

    connection.close();
    await settle();
    expect(channel.cancelled).toBe(true);
  });

  it("setzt nach Verbindungsabbruch ohne zusätzlichen Snapshot an der letzten Sequenz fort", async () => {
    const first = new SseChannel();
    const resumed = new SseChannel();
    const fetchMock = fetchHarness([jsonResponse(snapshot(1))], [first.response, resumed.response]);
    const changes = vi.fn();
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, changes, {
      fetch: fetchMock,
      retryDelayMs: 25,
    });
    await connection.connect();

    first.close();
    await settle();
    await vi.advanceTimersByTimeAsync(25);
    await settle();

    expect(snapshotCalls(fetchMock)).toBe(1);
    expect(streamCalls(fetchMock)).toBe(2);
    const resumeHeaders = new Headers(fetchMock.mock.calls.at(-1)?.[1]?.headers);
    expect(resumeHeaders.get("last-event-id")).toBe("1");
    resumed.sendDelta(delta(2));
    await settle();
    expect(changes.mock.calls.at(-1)?.[0]).toMatchObject({ sequence: 2 });
    connection.close();
  });

  it("verliert auch einen unmittelbar beim Synchronisieren geschlossenen Stream nicht", async () => {
    const closedImmediately = new SseChannel();
    closedImmediately.close();
    const resumed = new SseChannel();
    const fetchMock = fetchHarness(
      [jsonResponse(snapshot(1))],
      [closedImmediately.response, resumed.response],
    );
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, vi.fn(), {
      fetch: fetchMock,
      retryDelayMs: 25,
    });

    await connection.connect();
    await settle();
    await vi.advanceTimersByTimeAsync(25);
    await settle();

    expect(snapshotCalls(fetchMock)).toBe(1);
    expect(streamCalls(fetchMock)).toBe(2);
    connection.close();
  });

  it("bündelt mehrere Deltas einer Lücke in genau einen Re-Snapshot", async () => {
    const first = new SseChannel();
    const replacement = new SseChannel();
    const delayedSnapshot = deferred<Response>();
    const fetchMock = fetchHarness(
      [jsonResponse(snapshot(1)), delayedSnapshot.promise],
      [first.response, replacement.response],
    );
    const changes = vi.fn();
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, changes, {
      fetch: fetchMock,
      retryDelayMs: 10,
    });
    await connection.connect();

    first.sendDelta(delta(3));
    await settle();
    first.sendDelta(delta(4));
    await settle();
    expect(snapshotCalls(fetchMock)).toBe(2);

    delayedSnapshot.resolve(jsonResponse(snapshot(4, 40, { ...baseTrain, positionMm: 4_444 })));
    await settle(16);
    expect(snapshotCalls(fetchMock)).toBe(2);
    expect(changes.mock.calls.at(-1)?.[0].trains.get("1")?.positionMm).toBe(4_444);
    connection.close();
  });

  it("erzwingt bei einer zweiten Lücke während des Re-Snapshots einen weiteren Snapshot", async () => {
    const first = new SseChannel();
    const replacement = new SseChannel();
    const delayedSnapshot = deferred<Response>();
    const finalSnapshot = snapshot(5, 50, { ...baseTrain, positionMm: 5_555 });
    const fetchMock = fetchHarness(
      [jsonResponse(snapshot(1)), delayedSnapshot.promise, jsonResponse(finalSnapshot)],
      [first.response, replacement.response],
    );
    const changes = vi.fn();
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, changes, {
      fetch: fetchMock,
      retryDelayMs: 10,
    });
    await connection.connect();

    first.sendDelta(delta(3));
    await settle();
    first.sendDelta(delta(5));
    await settle();
    delayedSnapshot.resolve(jsonResponse(snapshot(3)));
    await settle(24);

    expect(snapshotCalls(fetchMock)).toBe(3);
    expect(changes.mock.calls.at(-1)?.[0]).toMatchObject({ sequence: 5 });
    expect(changes.mock.calls.at(-1)?.[0].trains.get("1")?.positionMm).toBe(5_555);
    connection.close();
  });

  it("behandelt reset als gezielten Re-Snapshot", async () => {
    const first = new SseChannel();
    const replacement = new SseChannel();
    const fetchMock = fetchHarness(
      [jsonResponse(snapshot(1)), jsonResponse(snapshot(7, 70, { ...baseTrain, positionMm: 7_777 }))],
      [first.response, replacement.response],
    );
    const changes = vi.fn();
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, changes, { fetch: fetchMock });
    await connection.connect();

    first.sendReset();
    await settle(20);
    expect(snapshotCalls(fetchMock)).toBe(2);
    expect(changes.mock.calls.at(-1)?.[0]).toMatchObject({ sequence: 7 });
    expect(changes.mock.calls.at(-1)?.[0].trains.get("1")?.positionMm).toBe(7_777);
    connection.close();
  });

  it("lässt einen überlaufenen Pending-Puffer niemals zum Fachzustand werden", async () => {
    const first = new SseChannel();
    const replacement = new SseChannel();
    const delayedSnapshot = deferred<Response>();
    const finalSnapshot = snapshot(4, 40, { ...baseTrain, positionMm: 9_999 });
    const fetchMock = fetchHarness(
      [jsonResponse(snapshot(1)), delayedSnapshot.promise, jsonResponse(finalSnapshot)],
      [first.response, replacement.response],
    );
    const changes = vi.fn();
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, changes, {
      fetch: fetchMock,
      maximumPendingDeltas: 1,
    });
    await connection.connect();

    first.sendDelta(delta(3));
    await settle();
    first.sendDelta(delta(4, { ...baseTrain, positionMm: 4_444 }));
    await settle();
    delayedSnapshot.resolve(jsonResponse(snapshot(3)));
    await settle(24);

    expect(snapshotCalls(fetchMock)).toBe(3);
    expect(changes.mock.calls.at(-1)?.[0].trains.get("1")?.positionMm).toBe(9_999);
    connection.close();
  });

  it("eskaliert einen fehlgeschlagenen Resume-Versuch garantiert zum Re-Snapshot", async () => {
    const first = new SseChannel();
    const recovered = new SseChannel();
    const authoritative = snapshot(9, 90, { ...baseTrain, positionMm: 9_999 });
    const fetchMock = fetchHarness(
      [jsonResponse(snapshot(1)), jsonResponse(authoritative)],
      [first.response, new Error("Resume fehlgeschlagen"), recovered.response],
    );
    const changes = vi.fn();
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, changes, {
      fetch: fetchMock,
      retryDelayMs: 20,
    });
    await connection.connect();

    first.fail();
    await settle();
    await vi.advanceTimersByTimeAsync(20);
    await settle();
    expect(snapshotCalls(fetchMock)).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    await settle(20);

    expect(snapshotCalls(fetchMock)).toBe(2);
    expect(changes.mock.calls.at(-1)?.[0]).toMatchObject({ sequence: 9 });
    expect(changes.mock.calls.at(-1)?.[0].trains.get("1")?.positionMm).toBe(9_999);
    connection.close();
  });

  it("wiederholt auch einen fehlgeschlagenen Re-Snapshot", async () => {
    const first = new SseChannel();
    const recovered = new SseChannel();
    const fetchMock = fetchHarness(
      [jsonResponse(snapshot(1)), new Error("Snapshot fehlgeschlagen"), jsonResponse(snapshot(3))],
      [first.response, recovered.response],
    );
    const changes = vi.fn();
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, changes, {
      fetch: fetchMock,
      retryDelayMs: 20,
    });
    await connection.connect();

    first.sendDelta(delta(3));
    await settle(16);
    expect(snapshotCalls(fetchMock)).toBe(2);
    await vi.advanceTimersByTimeAsync(20);
    await settle(20);

    expect(snapshotCalls(fetchMock)).toBe(3);
    expect(changes.mock.calls.at(-1)?.[0]).toMatchObject({ sequence: 3 });
    connection.close();
  });

  it("weist einen Snapshot der falschen Welt zurück und öffnet keinen Stream", async () => {
    const fetchMock = fetchHarness([jsonResponse(snapshot(1, 10, baseTrain, "fremde-welt"))], []);
    const changes = vi.fn();
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, changes, {
      fetch: fetchMock,
      retryDelayMs: 10,
    });

    await expect(connection.connect()).rejects.toThrow("falschen Welt");
    expect(changes).not.toHaveBeenCalled();
    expect(streamCalls(fetchMock)).toBe(0);
    connection.close();
  });

  it("bricht einen laufenden Snapshot sauber ab und plant danach keinen Retry", async () => {
    const fetchMock = vi.fn<typeof fetch>((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Abgebrochen", "AbortError")),
          { once: true },
        );
      });
    });
    const connection = new LivemapConnection("", WORLD_ID, TOKEN, vi.fn(), {
      fetch: fetchMock,
      retryDelayMs: 10,
    });

    const connecting = connection.connect();
    connection.close();
    await expect(connecting).rejects.toMatchObject({ name: "AbortError" });
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
