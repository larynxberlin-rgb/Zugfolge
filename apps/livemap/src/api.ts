import type {
  LivemapConfigV1,
  LivemapObjectDetailV1,
  LivemapObjectKind,
  OwnerTrainDetailV1,
  PublicTrainDetailV1,
  StationBoardV1,
} from "@zugfolge/livemap-stream";

export class LivemapApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LivemapApiError";
  }
}

export class LivemapApiClient {
  readonly #baseUrl: string;
  readonly #authorization: string;

  constructor(baseUrl: string, accessToken: string, private readonly fetchImplementation: typeof fetch = fetch) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#authorization = `Bearer ${accessToken}`;
  }

  async #json<T>(path: string): Promise<T> {
    const response = await this.fetchImplementation.call(globalThis, `${this.#baseUrl}${path}`, {
      cache: "no-store",
      headers: { accept: "application/json", authorization: this.#authorization },
    });
    if (!response.ok) {
      let detail = "";
      try {
        const problem = await response.json() as { readonly error?: unknown; readonly detail?: unknown };
        const value = problem.detail ?? problem.error;
        if (typeof value === "string") detail = ` · ${value}`;
      } catch { /* HTTP-Status bleibt die stabile Erklärung. */ }
      throw new LivemapApiError(`Livemap-Detail ist nicht verfügbar (HTTP ${response.status})${detail}.`, response.status);
    }
    return response.json() as Promise<T>;
  }

  config(worldId: string): Promise<LivemapConfigV1> {
    return this.#json(`/worlds/${encodeURIComponent(worldId)}/livemap/config`);
  }

  object(worldId: string, kind: LivemapObjectKind, objectId: string): Promise<LivemapObjectDetailV1> {
    return this.#json(`/worlds/${encodeURIComponent(worldId)}/livemap/objects/${encodeURIComponent(kind)}/${encodeURIComponent(objectId)}`);
  }

  stationBoard(worldId: string, stationId: string): Promise<StationBoardV1> {
    return this.#json(`/worlds/${encodeURIComponent(worldId)}/livemap/stations/${encodeURIComponent(stationId)}/board`);
  }

  publicTrain(worldId: string, trainId: string): Promise<PublicTrainDetailV1> {
    return this.#json(`/worlds/${encodeURIComponent(worldId)}/livemap/trains/${encodeURIComponent(trainId)}`);
  }

  ownerTrain(worldId: string, operatorId: string, trainId: string): Promise<OwnerTrainDetailV1 | undefined> {
    return this.#json<OwnerTrainDetailV1>(
      `/worlds/${encodeURIComponent(worldId)}/operators/${encodeURIComponent(operatorId)}/livemap/trains/${encodeURIComponent(trainId)}`,
    ).catch((error: unknown) => {
      if (error instanceof LivemapApiError && (error.status === 403 || error.status === 404)) return undefined;
      throw error;
    });
  }
}
