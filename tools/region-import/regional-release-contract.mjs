const REGION_ID = "mitteldeutschland-b";
export const NORMALIZED_SCHEDULE_TIME_ZONE = "Europe/Berlin";
export const NORMALIZED_SCHEDULE_REPEAT_EVERY_S = 86_400;

function fail(message) {
  throw new Error(`Regionaler Alpha-Buildvertrag ist ungueltig: ${message}`);
}

/**
 * Ein gemeinsamer Zeitvertrag fuer Runtime und oeffentliches ReadModel.
 * GTFS-Servicezeiten bleiben weltrelative Sekunden; die Zeitzone beschreibt
 * nur den ausgewaehlten Betriebstag und darf keinen zweiten UTC-Offset
 * erzeugen.
 */
export function assertNormalizedScheduleTimeContract({
  worldEpoch,
  serviceDate,
  timeZone,
  serviceStartOffsetS,
  repeatEveryS,
}) {
  const epoch = new Date(worldEpoch);
  if (Number.isNaN(epoch.getTime()) || epoch.toISOString() !== worldEpoch) {
    fail("Schedule-Weltepoche fehlt oder ist nicht kanonisch.");
  }
  if (!/^20[0-9]{6}$/.test(serviceDate ?? "")) fail("Schedule-serviceDate fehlt.");
  const epochServiceDate = epoch.toISOString().slice(0, 10).replaceAll("-", "");
  if (epochServiceDate !== serviceDate) fail("Schedule-Weltepoche und serviceDate laufen auseinander.");
  if (timeZone !== NORMALIZED_SCHEDULE_TIME_ZONE) fail("Schedule-Zeitzone ist nicht Europe/Berlin.");
  if (serviceStartOffsetS !== 0) fail("Schedule-Servicebeginn muss auf Weltsekunde null normalisiert sein.");
  if (repeatEveryS !== NORMALIZED_SCHEDULE_REPEAT_EVERY_S) fail("Schedule-Wiederholungsperiode muss exakt einen Tag betragen.");
  return Object.freeze({
    worldEpoch,
    serviceDate,
    timeZone,
    serviceStartOffsetS,
    repeatEveryS,
  });
}

export function assertRegionalAlphaReleaseContract({ gtfsEnvelope, gtfsBytesSha256, infraRelease, worldEpoch }) {
  const snapshot = gtfsEnvelope?.snapshot;
  const serviceDate = snapshot?.serviceDate;
  if (!/^20[0-9]{6}$/.test(serviceDate ?? "")) fail("GTFS-serviceDate fehlt.");

  const releaseMatch = /^infra-mitteldeutschland-b-(20[0-9]{2}\.[1-9][0-9]*)$/.exec(infraRelease?.releaseId ?? "");
  if (releaseMatch === null) fail("InfraRelease-ID ist nicht versioniert.");
  const releaseVersion = releaseMatch[1];
  const timetableYear = Number(serviceDate.slice(0, 4));
  if (
    !releaseVersion.startsWith(`${timetableYear}.`)
    || infraRelease.schema !== "zugfolge-infra-release/v1"
    || infraRelease.regionId !== REGION_ID
    || snapshot.regionId !== REGION_ID
    || infraRelease.regionVariant !== "B"
    || snapshot.regionVariant !== "B"
    || infraRelease.timetableYear !== timetableYear
    || !/^[a-f0-9]{64}$/.test(infraRelease.releaseHash ?? "")
    || !/^[a-f0-9]{64}$/.test(gtfsEnvelope.snapshotHash ?? "")
    || !/^[a-f0-9]{64}$/.test(gtfsBytesSha256 ?? "")
  ) fail("Regions-, Jahres- oder Hashbindung ist verletzt.");

  const epoch = new Date(worldEpoch);
  if (Number.isNaN(epoch.getTime())) fail("Weltepoche fehlt.");
  const epochServiceDate = epoch.toISOString().slice(0, 10).replaceAll("-", "");
  if (epochServiceDate !== serviceDate) fail("Weltepoche und GTFS-serviceDate laufen auseinander.");

  const gtfsArtifacts = Array.isArray(infraRelease.artifacts)
    ? infraRelease.artifacts.filter((artifact) => artifact?.kind === "gtfs-planning-snapshot")
    : [];
  const expectedFile = `gtfs-region-${serviceDate}-v2.json`;
  if (
    gtfsArtifacts.length !== 1
    || gtfsArtifacts[0].file !== expectedFile
    || gtfsArtifacts[0].serviceDate !== serviceDate
    || gtfsArtifacts[0].sha256 !== gtfsBytesSha256
    || gtfsArtifacts[0].stateHash !== gtfsEnvelope.snapshotHash
  ) fail("GTFS-Artefakt ist nicht eindeutig und bytegenau im InfraRelease gebunden.");

  return {
    fleetReleaseId: `fleet-alpha-mitteldeutschland-b-${releaseVersion}`,
    releaseVersion,
    serviceDate,
    timetableYear,
  };
}
