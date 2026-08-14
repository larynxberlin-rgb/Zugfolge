import {
  LivemapRegistry,
  PUBLIC_OPERATION_MARKER,
} from "@zugfolge/livemap-stream";
import type { OperatingRuntimeEvent } from "@zugfolge/runtime-native";

export type LivemapOperationEvent = Pick<
  OperatingRuntimeEvent,
  "worldId" | "eventType" | "atS" | "payload"
>;

/** Projects durable public-operation decisions; all other events pass by. */
export function projectLivemapOperationEvent(
  livemap: LivemapRegistry,
  event: LivemapOperationEvent,
): void {
  const isInitialPublicOperation = event.eventType === "alpha.public-operation-visible";
  if (
    !isInitialPublicOperation
    && event.eventType !== "livemap-operation-marked"
    && event.eventType !== "livemap-operation-cleared"
  ) return;
  if (!Number.isSafeInteger(event.atS) || event.atS < 0) {
    throw new Error("Livemap-Betriebsereignis besitzt keine gueltige Simulationszeit.");
  }
  const payload = event.payload;
  if (!isInitialPublicOperation && payload["worldId"] !== event.worldId) {
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
  if (isInitialPublicOperation) {
    const operatorIds = payload["operatorIds"];
    const lotIds = payload["lotIds"];
    if (
      event.atS !== 0
      || payload["schemaVersion"] !== "zugfolge-public-operation-visible/v1"
      || !Array.isArray(operatorIds)
      || operatorIds.length !== 1
      || operatorIds[0] !== "public"
      || !Array.isArray(lotIds)
      || lotIds.length === 0
      || lotIds.some((id) => typeof id !== "string" || id.length === 0)
      || new Set(lotIds).size !== lotIds.length
      || typeof payload["deploymentHash"] !== "string"
      || payload["deploymentHash"].length === 0
    ) {
      throw new Error("Initiales Livemap-Betriebsereignis verletzt den signierten Startvertrag.");
    }
    livemap.setOperationMarker(event.worldId, trainRunIds, PUBLIC_OPERATION_MARKER, 0);
    return;
  }
  const marker = event.eventType === "livemap-operation-marked" ? PUBLIC_OPERATION_MARKER : null;
  if (payload["marker"] !== (marker === null ? null : "public-operator")) {
    throw new Error("Livemap-Betriebsereignis widerspricht seinem Markertyp.");
  }
  livemap.setOperationMarker(event.worldId, trainRunIds, marker, event.atS);
}
