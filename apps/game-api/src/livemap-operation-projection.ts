import {
  LivemapRegistry,
  PUBLIC_OPERATION_MARKER,
} from "@zugfolge/livemap-stream";
import type { OperatingRuntimeEvent } from "@zugfolge/runtime-native";

export type LivemapOperationEvent = Pick<
  OperatingRuntimeEvent,
  "worldId" | "eventType" | "atS" | "payload"
>;

/** Projects only the two versioned Rust marker events; all other events pass by. */
export function projectLivemapOperationEvent(
  livemap: LivemapRegistry,
  event: LivemapOperationEvent,
): void {
  if (event.eventType !== "livemap-operation-marked" && event.eventType !== "livemap-operation-cleared") return;
  if (!Number.isSafeInteger(event.atS) || event.atS < 0) {
    throw new Error("Livemap-Betriebsereignis besitzt keine gueltige Simulationszeit.");
  }
  const payload = event.payload;
  if (payload["worldId"] !== event.worldId) {
    throw new Error("Livemap-Betriebsereignis verletzt Weltisolation.");
  }
  const trainRunIds = payload["trainRunIds"];
  if (
    !Array.isArray(trainRunIds)
    || trainRunIds.length === 0
    || trainRunIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(trainRunIds).size !== trainRunIds.length
  ) {
    throw new Error("Livemap-Betriebsereignis besitzt keine eindeutigen Zuglaufkennungen.");
  }
  const marker = event.eventType === "livemap-operation-marked" ? PUBLIC_OPERATION_MARKER : null;
  if (payload["marker"] !== (marker === null ? null : "public-operator")) {
    throw new Error("Livemap-Betriebsereignis widerspricht seinem Markertyp.");
  }
  livemap.setOperationMarker(event.worldId, trainRunIds, marker, event.atS);
}
