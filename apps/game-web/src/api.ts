import type { DiagramData } from "./diagram.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Strikte Projektionsgrenze: Ein fehlerhaftes Planner-Event erreicht nie den Renderer. */
export function isDiagramData(value: unknown): value is DiagramData {
  if (!isRecord(value) || typeof value["corridor"] !== "string") return false;
  const stations = value["stations"];
  const trains = value["trains"];
  const occupations = value["occupations"];
  const conflicts = value["conflicts"];
  return Array.isArray(stations)
    && stations.every((station) => isRecord(station) && typeof station["id"] === "string" && typeof station["name"] === "string" && typeof station["km"] === "number")
    && Array.isArray(trains)
    && trains.every((train) => isRecord(train) && typeof train["id"] === "string" && typeof train["number"] === "string" && Array.isArray(train["calls"]))
    && Array.isArray(occupations)
    && occupations.every((occupation) => isRecord(occupation) && typeof occupation["trainId"] === "string")
    && Array.isArray(conflicts)
    && conflicts.every((conflict) => isRecord(conflict) && typeof conflict["id"] === "string" && Array.isArray(conflict["trainIds"]));
}

export class GameApiClient {
  readonly #baseUrl: string;
  readonly #accessToken: string;
  readonly #fetch: typeof fetch;

  constructor(baseUrl: string, accessToken: string, fetchImplementation: typeof fetch = fetch) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#accessToken = accessToken;
    this.#fetch = fetchImplementation;
  }

  async loadDiagram(worldId: string): Promise<DiagramData> {
    const response = await this.#fetch(`${this.#baseUrl}/worlds/${encodeURIComponent(worldId)}/planning/diagram`, {
      headers: { authorization: `Bearer ${this.#accessToken}` },
    });
    if (!response.ok) throw new Error(`Planner-Projektion nicht verfügbar (HTTP ${response.status}).`);
    const envelope = (await response.json()) as { readonly data?: unknown };
    if (!isDiagramData(envelope.data)) throw new Error("Planner-Projektion hat ein ungültiges Format.");
    return envelope.data;
  }

  async queueAlternative(worldId: string, trainId: string, conflictId: string, shiftMinutes: number): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/worlds/${encodeURIComponent(worldId)}/planning/alternatives`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), trainId, conflictId, shiftMinutes }),
    });
    if (!response.ok) throw new Error(`Alternative wurde nicht angenommen (HTTP ${response.status}).`);
  }
}
