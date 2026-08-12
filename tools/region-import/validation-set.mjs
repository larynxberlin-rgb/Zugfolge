import { createHash } from "node:crypto";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isHoldout(id, divisor = 17) {
  return Number.parseInt(sha256(id).slice(0, 8), 16) % divisor === 0;
}

function check(results, group, id, condition, message) {
  results.push({ group, id, passed: condition, message: condition ? null : message });
}

/**
 * Technischer Holdout fuer den produktiven InfraRelease. Er verwendet weder
 * den M1-Kalibrierungsbestand noch dessen Toleranzen und zieht seine Stichprobe
 * allein aus stabilen SHA-256-Partitionen der produktiven Artefaktkennungen.
 */
export function buildIndependentValidationSet({ operationalNetwork, pbfReport, gtfsSnapshot }) {
  const network = operationalNetwork.network;
  const results = [];
  const resourceById = new Map(network.resources.map((resource) => [resource.resourceId, resource]));
  const stationIds = new Set(network.stations.map((station) => station.stationId));
  const gtfsSegmentById = new Map(gtfsSnapshot.snapshot.segments.map((segment) => [segment.segmentId, segment]));

  for (const resource of network.resources.filter((entry) => isHoldout(entry.resourceId))) {
    check(results, "annual-master-resource", resource.resourceId,
      stationIds.has(resource.originStationId) && stationIds.has(resource.destinationStationId),
      "Mindestens ein Endpunkt fehlt im freigegebenen Jahresgraphen.");
    check(results, "annual-master-resource", resource.resourceId,
      Number.isSafeInteger(resource.lengthMm) && resource.lengthMm > 0,
      "Die Ressource hat keine positive ganzzahlige Laenge in Millimetern.");
    check(results, "annual-master-resource", resource.resourceId,
      resource.qualityClass === "B" && resource.orderable === true,
      "Eine freigegebene Jahresressource ist nicht als bestellbare Klasse B markiert.");
  }

  for (const mapping of network.gtfsStationMappings.filter((entry) => isHoldout(entry.stopId))) {
    const mapped = mapping.stationId !== null;
    check(results, "gtfs-station-mapping", mapping.stopId,
      mapped ? stationIds.has(mapping.stationId) : mapping.qualityClass === "C",
      "Die Haltestellenabbildung verweist auf keine Jahres-Betriebsstelle oder verschleiert Klasse C.");
    check(results, "gtfs-station-mapping", mapping.stopId,
      mapped
        ? Number.isSafeInteger(mapping.distanceMm) && mapping.distanceMm >= 0 && mapping.distanceMm <= network.matchingRadiusMm
        : mapping.distanceMm === null,
      "Der Abbildungsabstand liegt ausserhalb des freigegebenen Radius.");
  }

  for (const qualification of network.segmentQualifications.filter((entry) => isHoldout(entry.segmentId))) {
    const sourceSegment = gtfsSegmentById.get(qualification.segmentId);
    const resourcesExist = qualification.resourceIds.every((resourceId) => resourceById.has(resourceId));
    check(results, "playable-segment", qualification.segmentId, resourcesExist,
      "Das spielbare Segment referenziert eine unbekannte Konfliktressource.");
    check(results, "playable-segment", qualification.segmentId,
      qualification.orderable
        ? qualification.qualityClass === "B" && qualification.missingEvidence.length === 0 && qualification.resourceIds.length > 0
        : qualification.qualityClass === "C" || qualification.missingEvidence.length > 0 || sourceSegment?.orderable === false,
      "Bestellbarkeit, Qualitaetsklasse und Evidenzlage widersprechen einander.");
  }

  for (const block of pbfReport.derivations.blocks.filter((entry) => isHoldout(entry.blockId))) {
    check(results, "osm-block", block.blockId,
      Number.isSafeInteger(block.lengthMm) && block.lengthMm > 0,
      "Der abgeleitete OSM-Block hat keine positive ganzzahlige Laenge.");
    check(results, "osm-block", block.blockId,
      block.qualityClass !== "C" || block.orderable === false,
      "Ein OSM-Block der Klasse C ist bestellbar.");
  }

  for (const route of pbfReport.derivations.interlockingRoutes.filter((entry) => isHoldout(entry.routeId))) {
    const conflicts = new Set(route.conflictEdgeIds);
    check(results, "osm-interlocking-route", route.routeId,
      route.originEdgeId !== route.destinationEdgeId
        && conflicts.has(route.originEdgeId)
        && conflicts.has(route.destinationEdgeId),
      "Die konservative Fahrstrasse deckt Ursprungs- oder Zielkante nicht ab.");
    check(results, "osm-interlocking-route", route.routeId,
      route.qualityClass !== "C" || route.orderable === false,
      "Eine OSM-Fahrstrasse der Klasse C ist bestellbar.");
  }

  const failures = results.filter((result) => !result.passed);
  const artifact = {
    schema: "zugfolge-independent-infra-validation/v1",
    releaseRegionId: network.regionId,
    timetableYear: network.timetableYear,
    selection: {
      algorithm: "sha256(identifier)[0..8] modulo 17 equals 0",
      calibrationDataUsed: false,
      sourceNetworkHash: operationalNetwork.networkHash,
      sourcePbfChecksum: pbfReport.eboFilter.checksum,
      sourceGtfsSnapshotHash: gtfsSnapshot.snapshotHash,
    },
    metrics: {
      checkCount: results.length,
      passedCount: results.length - failures.length,
      failedCount: failures.length,
      sampledObjectCount: new Set(results.map((result) => `${result.group}:${result.id}`)).size,
    },
    result: failures.length === 0 ? "passed" : "failed",
    failures,
    results,
  };
  const validationHash = sha256(canonical(artifact));
  return { artifact, validationHash };
}
