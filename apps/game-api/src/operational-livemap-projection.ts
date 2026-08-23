import type {
  OperationalProjectedTrain,
  OperationalProjection,
  OperationalRouteGeometryPoint,
} from "@zugfolge/runtime-native";
import type {
  OperationalLivemapRegionSnapshot,
  PublicMapPosition,
  PublicOperationalRegionFrame,
  PublicRouteGeometryPoint,
  PublicTrain,
} from "@zugfolge/livemap-stream";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}

function publicGeometryPoint(point: OperationalRouteGeometryPoint): PublicRouteGeometryPoint {
  return Object.freeze({
    routeMm: point.routeMm,
    trackId: point.edgeId,
    offsetMm: point.edgeOffsetMm,
    latitudeE7: point.latitudeE7,
    longitudeE7: point.longitudeE7,
    ...(point.bearingMilliDegrees === null
      ? {}
      : { bearingMilliDegrees: point.bearingMilliDegrees }),
  });
}

function headMapPosition(
  infrastructureReleaseId: string,
  train: OperationalProjectedTrain,
): PublicMapPosition {
  const point = train.headGeometry;
  return Object.freeze({
    infrastructureReleaseId,
    resourceId: train.occupiedBlocks[0] ?? point.edgeId,
    trackId: point.edgeId,
    offsetMm: point.edgeOffsetMm,
    latitudeE7: point.latitudeE7,
    longitudeE7: point.longitudeE7,
    ...(point.bearingMilliDegrees === null
      ? {}
      : { bearingMilliDegrees: point.bearingMilliDegrees }),
  });
}

function publicTrain(
  projection: OperationalProjection,
  train: OperationalProjectedTrain,
): PublicTrain {
  const motionSegment = train.motionSegment;
  const motionGeometry = train.motionGeometry.map(publicGeometryPoint);
  invariant(
    (train.motionState === "moving") === (motionSegment != null),
    `Zug '${train.trainId}' besitzt keinen konsistenten Bewegungszustand.`,
  );
  if (motionSegment != null) {
    invariant(motionGeometry.length >= 2, `Zug '${train.trainId}' besitzt keinen exakten Bewegungsverlauf.`);
    invariant(
      motionSegment.routeVersionId === train.routeVersionId,
      `Zug '${train.trainId}' bewegt sich auf einer fremden Laufwegversion.`,
    );
  }
  const authorizedSegment = motionSegment == null
    ? undefined
    : publicMotionSegment(motionSegment, motionGeometry, projection.staleAfterMs);
  const operational = Object.freeze({
    regionId: projection.regionId,
    commitSequence: projection.commitSequence,
    simulationTimeMs: projection.atMs,
    routeVersionId: train.routeVersionId,
    formationVersionId: train.formationVersionId,
    movementKind: train.movementKind,
    headRouteMm: train.headRouteMm,
    tailRouteMm: train.tailRouteMm,
    direction: train.direction,
    occupiedIntervals: Object.freeze(train.occupiedIntervals.map((interval) => Object.freeze({
      trackId: interval.edgeId,
      fromMm: interval.fromMm,
      toMm: interval.toMm,
      direction: interval.direction,
    }))),
    occupiedBlocks: Object.freeze([...train.occupiedBlocks]),
    ...(train.authorityEndRouteMm == null
      ? {}
      : { authorityEndRouteMm: train.authorityEndRouteMm }),
    ...(authorizedSegment === undefined ? {} : { motionSegment: authorizedSegment }),
    ...(train.waitingReason == null ? {} : { waitingReason: train.waitingReason }),
  });
  return Object.freeze({
    id: train.trainId,
    operatorId: train.operatorId,
    // Bis ein oeffentlicher EVU-Anzeigename im committed Zustand liegt, wird
    // nur die wahre Betreiberkennung gezeigt.
    operator: train.operatorId,
    trainNumber: train.trainNumber,
    category: train.movementKind,
    positionMm: train.headRouteMm,
    speedMmPerSecond: train.speedMmps,
    status: train.motionState === "moving" ? "running" : "waiting",
    operational,
    mapPosition: headMapPosition(projection.infraReleaseId, train),
  });
}

function publicMotionSegment(
  motionSegment: NonNullable<OperationalProjectedTrain["motionSegment"]>,
  motionGeometry: readonly PublicRouteGeometryPoint[],
  staleAfterMs: number,
) {
  return Object.freeze({
    startedAtMs: motionSegment.startedAtMs,
    // Keine Darstellung darf ueber die Regions-Stale-Grenze hinauslaufen.
    validUntilMs: Math.min(motionSegment.validUntilMs, staleAfterMs),
    startRouteMm: motionSegment.startRouteMm,
    startSpeedMmPerSecond: motionSegment.startSpeedMmps,
    accelerationMmPerSecondSquared: motionSegment.accelerationMmps2,
    authorityEndRouteMm: motionSegment.authorityEndRouteMm,
    segmentEndRouteMm: motionSegment.segmentEndRouteMm,
    geometry: Object.freeze(motionGeometry),
  });
}

/**
 * Oeffentliche Allowlist der nativen Betriebsprojektion. Weder Fahrzeuge noch
 * interne Dispositionsdaten verlassen diese Grenze. LiveMap und RZUE lesen
 * spaeter denselben Regionsframe und dieselben Zugobjekte aus dem Feed.
 */
export function projectOperationalLivemap(
  projection: OperationalProjection,
): OperationalLivemapRegionSnapshot {
  invariant(projection.kind === "live-map", "Nur die gemeinsame LiveMap-Projektion darf publiziert werden.");
  invariant(projection.worldId.length > 0 && projection.regionId.length > 0, "Betriebsprojektion verletzt Welt- oder Regionsbindung.");
  invariant(projection.infraReleaseId.length > 0, "Betriebsprojektion besitzt kein InfraRelease.");
  invariant(Number.isSafeInteger(projection.atMs) && projection.atMs >= 0, "Betriebsprojektion besitzt keine gueltige Simulationszeit.");
  invariant(
    Number.isSafeInteger(projection.staleAfterMs)
      && projection.staleAfterMs >= projection.atMs,
    "Betriebsprojektion besitzt keine gueltige Stale-Grenze.",
  );
  const frame: PublicOperationalRegionFrame = Object.freeze({
    regionId: projection.regionId,
    infrastructureReleaseId: projection.infraReleaseId,
    commitSequence: projection.commitSequence,
    simulationTimeMs: projection.atMs,
    staleAfterMs: projection.staleAfterMs,
    routeLocks: Object.freeze(projection.routeLocks.map((lock) => Object.freeze({
      id: lock.id,
      templateId: lock.templateId,
      trainId: lock.trainId,
      resources: Object.freeze([...lock.resources]),
      releaseAfterTailRouteMm: lock.releaseAfterTailRouteMm,
      lockedAtMs: lock.lockedAtMs,
    }))),
    signals: Object.freeze({ ...projection.signals }),
    activeDisruptions: Object.freeze(projection.activeDisruptions.map((disruption) => Object.freeze({
      disruptionId: disruption.disruptionId,
      effect: structuredClone(disruption.effect),
    }))),
  });
  return Object.freeze({
    at: Math.floor(projection.atMs / 1_000),
    trains: Object.freeze(projection.trains.map((train) => publicTrain(projection, train))),
    operationalRegions: Object.freeze([frame]),
  });
}
