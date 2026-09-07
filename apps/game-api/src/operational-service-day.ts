/** Strikter Transport nativer Tages- und Fahrzeugkostenquittungen. */
export function decodeOperationalServiceDayEvent(kind: string, detail: string, subjectId: string, atMs: number, worldId: string, regionId: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse(detail); } catch { throw new TypeError("Nativer Tagesbeleg besitzt kein gültiges JSON."); }
  const fail = (): never => { throw new TypeError("Nativer Tagesbeleg verletzt seine Welt-, Zeit- oder Mengenbindung."); };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const decimal = (v: unknown): v is string => typeof v === "string" && /^(?:0|[1-9]\d*)$/u.test(v);
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
  const exact = (object: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(object).length === fields.length && fields.every((field) => Object.hasOwn(object, field));
  if (record.worldId !== worldId || record.regionId !== regionId || !text(record.operatorId) || !text(record.lotId)
    || typeof record.serviceDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(record.serviceDay)) return fail();
  if (kind === "service-vehicle-cost") {
    if (!exact(record, ["schemaVersion", "worldId", "regionId", "operatorId", "lotId", "trainRunId", "serviceRunId", "serviceDay", "basis", "evidenceComplete", "millimetreCents", "vehicleUses", "economyReleaseHash", "fleetAuthorityReleaseHash"])
      || record.schemaVersion !== "zugfolge-operational-service-vehicle-cost/v1" || record.trainRunId !== subjectId
      || !text(record.serviceRunId) || record.basis !== "formation-operating-cost" || typeof record.evidenceComplete !== "boolean"
      || !Array.isArray(record.vehicleUses) || (record.economyReleaseHash !== null && !hash(record.economyReleaseHash))
      || (record.fleetAuthorityReleaseHash !== null && !hash(record.fleetAuthorityReleaseHash))) return fail();
    let numerator = 0n;
    let complete = record.economyReleaseHash !== null && record.fleetAuthorityReleaseHash !== null;
    const ids = new Set<string>();
    for (const entry of record.vehicleUses) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return fail();
      const line = entry as Record<string, unknown>;
      if (!exact(line, ["vehicleId", "distanceMm", "centsPerTrainKm", "sourceReference"]) || !text(line.vehicleId) || ids.has(line.vehicleId) || !decimal(line.distanceMm)) return fail();
      ids.add(line.vehicleId);
      if (line.centsPerTrainKm === null && line.sourceReference === null) complete = false;
      else if (!integer(line.centsPerTrainKm) || line.centsPerTrainKm > 0xffffffff || !text(line.sourceReference)) return fail();
      else numerator += BigInt(line.distanceMm) * BigInt(line.centsPerTrainKm);
    }
    if (record.evidenceComplete !== complete || (complete ? record.millimetreCents !== numerator.toString() : record.millimetreCents !== null)) return fail();
  } else {
    const closed = kind === "service-day-closed";
    if (!exact(record, ["schemaVersion", "worldId", "regionId", "operatorId", "lotId", "serviceDayId", "serviceDay", "dayIndex", "dayEndMs", "serviceRunIds",
      ...(closed ? ["closedAtMs", "dayPlanComplete", "vehicleCostEvidenceComplete", "formationOperatingCostCents"] : [])])
      || (!closed && kind !== "service-day-planned") || record.schemaVersion !== `zugfolge-operational-service-day-${closed ? "closed" : "planned"}/v1`
      || record.serviceDayId !== subjectId || !integer(record.dayIndex) || !integer(record.dayEndMs)
      || record.dayEndMs !== (record.dayIndex + 1) * 86_400_000
      || !Array.isArray(record.serviceRunIds) || record.serviceRunIds.length === 0
      || !record.serviceRunIds.every(text) || new Set(record.serviceRunIds).size !== record.serviceRunIds.length
      || record.serviceRunIds.some((id, index, all) => index > 0 && all[index - 1]! >= id)) return fail();
    if (closed && (record.closedAtMs !== atMs || atMs < record.dayEndMs || record.dayPlanComplete !== true
      || typeof record.vehicleCostEvidenceComplete !== "boolean"
      || (record.vehicleCostEvidenceComplete ? !decimal(record.formationOperatingCostCents) : record.formationOperatingCostCents !== null))) return fail();
  }
  return Object.freeze(record);
}
