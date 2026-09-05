/** Transportvalidierung nativer Abschlussfakten; keine Dispositionsregeln. */
export function decodeOperationalServiceEvent(
  kind: "train-service-planned" | "train-outcome",
  detail: string,
  trainId: string,
  atMs: number,
  worldId?: string,
): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(detail);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Nativer Fahrtbeleg ist kein Objekt.");
  const record = value as Record<string, unknown>;
  const integer = (key: string) => typeof record[key] === "number" && Number.isSafeInteger(record[key]) && record[key] >= 0;
  const nullableInteger = (key: string) => record[key] === null || integer(key);
  const expectedSchema = kind === "train-outcome" ? "zugfolge-operational-train-outcome/v1" : "zugfolge-operational-train-service-planned/v1";
  if (record["schemaVersion"] !== expectedSchema || record["trainRunId"] !== trainId
    || ["worldId", "operatorId", "lotId", "serviceId", "serviceRunId"].some((key) => typeof record[key] !== "string" || record[key].length === 0)
    || (worldId !== undefined && record["worldId"] !== worldId)
    || typeof record["serviceDay"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(record["serviceDay"])
    || record["serviceRunId"] !== `${String(record["serviceId"])}:service-day:${String(record["serviceDay"])}`
    || !integer("scheduledArrivalMs")) throw new TypeError("Nativer Fahrtbeleg besitzt keine konsistente Welt-/Tagesfahrtbindung.");
  if (kind === "train-service-planned") {
    if (!nullableInteger("requiredSeats") || !["none-contracted", "unavailable"].includes(String(record["connectionAssessment"]))) {
      throw new TypeError("Nativer Fahrtplan besitzt keine explizite Vertragsgrundlage.");
    }
  } else if (record["status"] !== "completed" || record["actualArrivalMs"] !== atMs || !integer("delaySeconds")
    || typeof record["distanceMm"] !== "string" || !/^\d+$/u.test(record["distanceMm"])
    || typeof record["trainKm"] !== "string" || !/^\d+$/u.test(record["trainKm"])
    || BigInt(record["distanceMm"]) / 1_000_000n !== BigInt(record["trainKm"])
    || !nullableInteger("minimumSeatsProvided") || !nullableInteger("missingSeats") || !nullableInteger("missedConnections")
    || !Array.isArray(record["capacitySources"]) || record["capacitySources"].some((source) => typeof source !== "string" || source.length === 0)
    || record["evidenceComplete"] !== (record["missingSeats"] !== null && record["missedConnections"] !== null && record["minimumSeatsProvided"] !== null)) {
    throw new TypeError("Nativer Fahrtabschluss besitzt unvollstaendige oder widerspruechliche Messdaten.");
  }
  return Object.freeze(record);
}
