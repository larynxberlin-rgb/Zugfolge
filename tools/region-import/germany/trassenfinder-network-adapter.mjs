import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function text(value, label) {
  invariant(typeof value === "string" && value.trim() !== "", `${label} fehlt.`);
  return value.trim().replace(/\s+/gu, " ");
}

function rl100(value, label) {
  const normalized = text(value, label).normalize("NFKC").toUpperCase();
  invariant(/^[A-Z0-9]+(?: [A-Z0-9]+)*$/u.test(normalized) && normalized.length <= 10, `${label} ist kein unterstütztes RL100-Kürzel.`);
  return normalized;
}

function coordinate(value, label, minimum, maximum) {
  invariant(typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum, `${label} ist keine gültige Koordinate.`);
  return Math.round(value * 10_000_000);
}

function routeNumber(value, label) {
  invariant(Number.isSafeInteger(value) && value >= 1000 && value <= 9999, `${label} ist keine vierstellige VzG-Streckennummer.`);
  return value;
}

function kilometreMm(value, label) {
  invariant(typeof value === "number" && Number.isFinite(value), `${label} ist keine endliche Kilometrierung.`);
  const result = Math.round(value * 1_000_000);
  invariant(Number.isSafeInteger(result), `${label} ist nicht sicher skalierbar.`);
  return result;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
}

function operatingPoint(raw, index) {
  const id = rl100(raw.ds100, `Betriebsstelle ${index + 1}.ds100`);
  const latitude = raw.geo_koordinaten?.breite;
  const longitude = raw.geo_koordinaten?.laenge;
  const hasCoordinate = Number.isFinite(latitude) && Number.isFinite(longitude);
  invariant(Array.isArray(raw.betriebsstellentypen), `Betriebsstelle ${id} besitzt keine Typenliste.`);
  return {
    schema: "zugfolge-trassenfinder-operating-point/v1",
    operatingPointId: `tf:operating-point:${encodeURIComponent(id)}`,
    rl100: id,
    name: text(raw.langname, `Betriebsstelle ${id}.langname`),
    primaryLocationCode: raw.primary_location_code === undefined ? null : text(raw.primary_location_code, `Betriebsstelle ${id}.primary_location_code`),
    coordinateE7: hasCoordinate ? {
      longitude: coordinate(longitude, `Betriebsstelle ${id}.longitude`, -180, 180),
      latitude: coordinate(latitude, `Betriebsstelle ${id}.latitude`, -90, 90),
    } : null,
    operatingPointTypes: [...new Set(raw.betriebsstellentypen.map((value) => text(value, `Betriebsstelle ${id}.type`)))].sort(compareText),
    electrified: raw.elektrifiziert === true,
    station: raw.bahnhof === true,
  };
}

function routeSegment(raw, index, knownPoints) {
  const origin = rl100(raw.von, `Streckensegment ${index + 1}.von`);
  const destination = rl100(raw.bis, `Streckensegment ${index + 1}.bis`);
  invariant(origin !== destination, `Streckensegment ${index + 1} besitzt gleiche Endpunkte.`);
  invariant(knownPoints.has(origin) && knownPoints.has(destination), `Streckensegment ${origin}->${destination} verweist auf eine unbekannte Betriebsstelle.`);
  const route = routeNumber(raw.streckennummer, `Streckensegment ${origin}->${destination}.streckennummer`);
  const fromMm = kilometreMm(raw.von_km, `Streckensegment ${origin}->${destination}.von_km`);
  const toMm = kilometreMm(raw.bis_km, `Streckensegment ${origin}->${destination}.bis_km`);
  const lengthMm = Math.abs(toMm - fromMm);
  return {
    schema: "zugfolge-trassenfinder-route-segment/v1",
    routeSegmentId: `tf:route-segment:${route}:${encodeURIComponent(origin)}:${encodeURIComponent(destination)}:${fromMm}:${toMm}`,
    routeNumber: route,
    originOperatingPointId: `tf:operating-point:${encodeURIComponent(origin)}`,
    destinationOperatingPointId: `tf:operating-point:${encodeURIComponent(destination)}`,
    originRl100: origin,
    destinationRl100: destination,
    fromKilometreMm: fromMm,
    toKilometreMm: toMm,
    lengthMm,
    segmentKind: lengthMm === 0 ? "topology-connector" : "kilometrically-measured",
    qualityClass: "B",
    evidenceScope: "route-order-and-kilometre-only",
    orderable: false,
  };
}

function motherPlace(raw, index, knownPoints) {
  const id = rl100(raw.ds100, `Mutterbetriebsstelle ${index + 1}.ds100`);
  invariant(Array.isArray(raw.tochterbetriebsstellen) && raw.tochterbetriebsstellen.length > 0, `Mutterbetriebsstelle ${id} besitzt keine Töchter.`);
  const children = [...new Set(raw.tochterbetriebsstellen.map((value) => rl100(value, `Mutterbetriebsstelle ${id}.tochter`)))].sort(compareText);
  for (const child of children) invariant(knownPoints.has(child), `Mutterbetriebsstelle ${id} verweist auf unbekannte Tochter ${child}.`);
  return {
    schema: "zugfolge-trassenfinder-mother-operating-point/v1",
    motherOperatingPointId: `tf:mother-operating-point:${encodeURIComponent(id)}`,
    rl100: id,
    name: text(raw.langname, `Mutterbetriebsstelle ${id}.langname`),
    childRl100: children,
  };
}

export function adaptTrassenfinderNetwork(raw) {
  invariant(raw?.id === 7, "Unerwartete Trassenfinder-Infrastrukturkennung.");
  invariant(raw.fahrplanjahr === 2026, "Trassenfinder-Infrastruktur gehört nicht zum Fahrplanjahr 2026.");
  invariant(/^\d{4}-\d{2}-\d{2}$/u.test(raw.gueltig_von) && /^\d{4}-\d{2}-\d{2}$/u.test(raw.gueltig_bis), "Trassenfinder-Gültigkeit fehlt.");
  const frame = raw.ordnungsrahmen;
  invariant(Array.isArray(frame?.betriebsstellen) && Array.isArray(frame?.streckensegmente) && Array.isArray(frame?.mutter_betriebsstellen), "Trassenfinder-Ordnungsrahmen ist unvollständig.");
  const operatingPoints = frame.betriebsstellen.map(operatingPoint).sort((left, right) => compareText(left.rl100, right.rl100));
  const knownPoints = new Set(operatingPoints.map(({ rl100 }) => rl100));
  invariant(knownPoints.size === operatingPoints.length, "Trassenfinder enthält doppelte RL100-Betriebsstellen.");
  const routeSegments = frame.streckensegmente.map((value, index) => routeSegment(value, index, knownPoints))
    .sort((left, right) => compareText(left.routeSegmentId, right.routeSegmentId));
  invariant(new Set(routeSegments.map(({ routeSegmentId }) => routeSegmentId)).size === routeSegments.length, "Trassenfinder enthält doppelte Streckensegmente.");
  const motherOperatingPoints = frame.mutter_betriebsstellen.map((value, index) => motherPlace(value, index, knownPoints))
    .sort((left, right) => compareText(left.rl100, right.rl100));
  return {
    schema: "zugfolge-trassenfinder-network/v1",
    infrastructureId: raw.id,
    displayName: text(raw.anzeigename, "anzeigename"),
    timetableYear: raw.fahrplanjahr,
    validFrom: raw.gueltig_von,
    validUntil: raw.gueltig_bis,
    policy: {
      runtimeDependency: false,
      routeSegmentsProveMicroscopicTopology: false,
      routeSegmentsOrderableByThemselves: false,
      classAGranted: false,
    },
    operatingPoints,
    motherOperatingPoints,
    routeSegments,
  };
}

function sequence(values) {
  return values.map((value) => `\x1e${JSON.stringify(value)}\n`).join("");
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function writeTrassenfinderNetwork(inputPath, outputRoot, expectedSha256 = undefined) {
  const sourcePath = resolve(inputPath);
  const sourceSha256 = await sha256File(sourcePath);
  if (expectedSha256 !== undefined) invariant(sourceSha256 === expectedSha256, `Trassenfinder-SHA-256 weicht ab: ${sourceSha256}.`);
  const adapted = adaptTrassenfinderNetwork(JSON.parse(await readFile(sourcePath, "utf8")));
  const files = {
    operatingPoints: "trassenfinder-operating-points.jsonseq",
    motherOperatingPoints: "trassenfinder-mother-operating-points.jsonseq",
    routeSegments: "trassenfinder-route-segments.jsonseq",
  };
  const payloads = {
    operatingPoints: sequence(adapted.operatingPoints),
    motherOperatingPoints: sequence(adapted.motherOperatingPoints),
    routeSegments: sequence(adapted.routeSegments),
  };
  const report = {
    schema: "zugfolge-trassenfinder-network-adapter-report/v1",
    source: { sourceId: "trassenfinder-infrastruktur-api", sha256: sourceSha256, infrastructureId: adapted.infrastructureId, timetableYear: adapted.timetableYear },
    policy: adapted.policy,
    counts: {
      operatingPoints: adapted.operatingPoints.length,
      operatingPointsWithCoordinate: adapted.operatingPoints.filter(({ coordinateE7 }) => coordinateE7 !== null).length,
      motherOperatingPoints: adapted.motherOperatingPoints.length,
      routeSegments: adapted.routeSegments.length,
      topologyConnectors: adapted.routeSegments.filter(({ segmentKind }) => segmentKind === "topology-connector").length,
    },
    outputs: Object.entries(files).map(([kind, file]) => ({ kind, file, bytes: Buffer.byteLength(payloads[kind]), sha256: sha256(payloads[kind]) })),
  };
  await mkdir(resolve(outputRoot), { recursive: true });
  await Promise.all([
    ...Object.entries(files).map(([kind, file]) => writeFile(resolve(outputRoot, file), payloads[kind], "utf8")),
    writeFile(resolve(outputRoot, "trassenfinder-network-adapter-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  ]);
  return report;
}
