import { describe, expect, it, vi } from "vitest";

import {
  applyDelta,
  initialState,
  interpolatedPosition,
  LivemapConnection,
  type Snapshot,
} from "./protocol.js";

const snapshot: Snapshot = {
  worldId: "welt-1",
  sequence: 4,
  at: 100,
  trains: [
    {
      id: "1",
      operator: "Elbtalbahn",
      trainNumber: "RE 1",
      category: "Regional",
      positionMm: 1_000,
      speedMmPerSecond: 20,
      delaySeconds: 0,
      nextOperatingPoint: "Halle Hbf",
      status: "running",
    },
  ],
};

class FakeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  reset: (() => void) | undefined;
  closed = false;

  addEventListener(_type: "reset", listener: () => void): void {
    this.reset = listener;
  }

  close(): void {
    this.closed = true;
  }

  emit(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }
}

describe("Livemap-Protokoll", () => {
  it("fordert bei Sequenzlücken einen Snapshot", () => {
    expect(
      applyDelta(initialState(snapshot), {
        worldId: "welt-1",
        sequence: 6,
        at: 101,
        changed: [],
        removed: [],
      }),
    ).toBeUndefined();
  });

  it("interpoliert höchstens zehn Sekunden", () => {
    expect(interpolatedPosition(snapshot.trains[0]!, 100, 120)).toBe(1_200);
  });

  it("führt bei mehreren Deltas während einer Lücke nur einen Snapshot-Reload aus", async () => {
    const eventSource = new FakeEventSource();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...snapshot, sequence: 7, at: 103 }), { status: 200 }),
      );
    const changes = vi.fn();
    const connection = new LivemapConnection("", "welt-1", changes, {
      fetch: fetchMock,
      eventSource: () => eventSource,
      retryDelayMs: 0,
    });
    await connection.connect();

    eventSource.emit({ worldId: "welt-1", sequence: 6, at: 102, changed: [], removed: [] });
    eventSource.emit({ worldId: "welt-1", sequence: 7, at: 103, changed: [], removed: [] });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(changes.mock.calls.at(-1)?.[0]).toMatchObject({ sequence: 7 });
    connection.close();
    expect(eventSource.closed).toBe(true);
  });
});
