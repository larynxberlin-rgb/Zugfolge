import type {
  LivemapConfigV2,
  LivemapObjectDetailV1,
  LivemapObjectKind,
  OwnerTrainDetailV1,
  PublicTrainDetailV1,
  StationBoardV1,
} from "@zugfolge/livemap-stream";

import { decodeAttentionMessages, type MailboxAttentionMessage } from "./attention.js";

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

  config(worldId: string): Promise<LivemapConfigV2> {
    return this.#json<unknown>(`/worlds/${encodeURIComponent(worldId)}/livemap/config`).then((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LivemapApiError("Livemap-Konfiguration ist kein Objekt.", 502);
      const config = value as Readonly<Record<string, unknown>>;
      if (config["schemaVersion"] !== "zugfolge-livemap-config/v2") throw new LivemapApiError("Livemap-Konfiguration besitzt kein unterstütztes Schema.", 502);
      if (config["worldId"] !== worldId) throw new LivemapApiError("Livemap-Konfiguration gehört zu einer anderen Welt.", 502);
      if (typeof config["worldName"] !== "string" || config["worldName"].trim() === "") throw new LivemapApiError("Livemap-Konfiguration enthält keinen Weltanzeigenamen.", 502);
      return config as unknown as LivemapConfigV2;
    });
  }

  mailbox(worldId: string): Promise<readonly MailboxAttentionMessage[]> {
    return this.#json<unknown>(`/worlds/${encodeURIComponent(worldId)}/mailbox`)
      .then((value) => decodeAttentionMessages(value, worldId));
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
