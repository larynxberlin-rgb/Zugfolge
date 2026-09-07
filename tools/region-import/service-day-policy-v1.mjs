/** Tagesvorlagen und Fahrzeugkosten ausschließlich aus dem originalen Alpha-/M5-Korpus. */
export function serviceDayPolicy({ trains, movementContinuations, vehicles, authorityAssets, authorityReleaseHash, economyReleaseHash, epochServiceDay, repeatEveryMs }) {
  const fail = () => { throw new Error("Tagesplan besitzt keine vollständige native Betriebs-/M5-Quellenbindung."); };
  if (repeatEveryMs !== 86_400_000 || !/^[a-f0-9]{64}$/u.test(authorityReleaseHash) || !/^[a-f0-9]{64}$/u.test(economyReleaseHash)) fail();
  const outgoing = new Map(movementContinuations.map((edge) => [edge.predecessorTrainId, edge]));
  const offsets = new Map();
  for (const edge of movementContinuations.filter((candidate) => candidate.dailyBoundary)) {
    let current = edge.successorTrainId;
    let offset = 0;
    while (true) {
      if (offsets.has(current)) fail();
      offsets.set(current, offset);
      const next = outgoing.get(current);
      if (!next) fail();
      if (next.dailyBoundary) break;
      offset += next.successorDayOffset;
      if (offset !== 0 && offset !== 1) fail();
      current = next.successorTrainId;
    }
  }
  if (offsets.size !== trains.length || outgoing.size !== trains.length) fail();
  const services = trains.filter((train) => train.publicPassengerStop).map((train) => {
    if (train.serviceOutcome?.serviceDay !== epochServiceDay || !offsets.has(train.id)) fail();
    return { trainRunId: train.id, operatorId: train.operatorId, firstDayIndex: offsets.get(train.id),
      scheduledDepartureMs: train.scheduledDepartureMs, binding: structuredClone(train.serviceOutcome) };
  }).sort((a, b) => a.binding.serviceId < b.binding.serviceId ? -1 : a.binding.serviceId > b.binding.serviceId ? 1 : 0);
  const assets = new Map(authorityAssets.map((asset) => [asset.id, asset]));
  if (assets.size !== authorityAssets.length || new Set(vehicles.map((vehicle) => vehicle.id)).size !== vehicles.length) fail();
  const vehicleCosts = vehicles.map((vehicle) => {
    const rate = assets.get(vehicle.id)?.passenger?.operatingCostCentsPerTrainKm;
    if (!Number.isSafeInteger(rate) || rate < 0 || rate > 0xffffffff) fail();
    return { vehicleId: vehicle.id, centsPerTrainKm: rate, sourceReference: `fleet-authority:${authorityReleaseHash}:vehicle:${vehicle.id}` };
  }).sort((a, b) => a.vehicleId < b.vehicleId ? -1 : a.vehicleId > b.vehicleId ? 1 : 0);
  return Object.freeze({ schemaVersion: "zugfolge-operational-service-day-policy/v1", epochServiceDay, dayLengthMs: repeatEveryMs,
    services, vehicleCostPolicy: { economyReleaseHash, fleetAuthorityReleaseHash: authorityReleaseHash, vehicleCosts } });
}
