import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DatabaseSync } from "node:sqlite";

const SOURCE_ID = "openstation-enrichment";
const SOURCE_LICENSE = "CC0-1.0";
const STOP_PLACE_START = "<StopPlace";
const STOP_PLACE_END = "</StopPlace>";
const SHA256 = /^[a-f0-9]{64}$/u;
const XML_TEXT_ELEMENTS = new Set([
  "AlightingUse",
  "BoardingUse",
  "Covered",
  "Gated",
  "Key",
  "Latitude",
  "Length",
  "Lighting",
  "MobilityImpairedAccess",
  "Name",
  "PlatformHeight",
  "PlateCode",
  "PostCode",
  "PrivateCode",
  "Province",
  "PublicUse",
  "QuayType",
  "StopPlaceType",
  "Street",
  "Text",
  "Town",
  "TransportMode",
  "Value",
  "Width",
  "Longitude",
]);

function findStopPlaceStart(buffer) {
  let cursor = 0;
  while (true) {
    const start = buffer.indexOf(STOP_PLACE_START, cursor);
    if (start === -1) return -1;
    if (/[\s>]/u.test(buffer[start + STOP_PLACE_START.length] ?? "")) return start;
    cursor = start + STOP_PLACE_START.length;
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function localName(name) {
  return name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
}

function decodeXml(value) {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|apos|gt|lt|quot);/giu, (entity, token) => {
    if (token === "amp") return "&";
    if (token === "apos") return "'";
    if (token === "gt") return ">";
    if (token === "lt") return "<";
    if (token === "quot") return '"';
    const codePoint = token.toLowerCase().startsWith("#x")
      ? Number.parseInt(token.slice(2), 16)
      : Number.parseInt(token.slice(1), 10);
    invariant(Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff, `Ungültige XML-Zeichenreferenz &${token};.`);
    return String.fromCodePoint(codePoint);
  }).replace(/&[^;\s]{1,40};/gu, (entity) => {
    throw new Error(`Unbekannte XML-Entität ${entity}.`);
  });
}

function normalizeText(value) {
  return decodeXml(value).normalize("NFC").trim().replace(/\s+/gu, " ");
}

function requiredText(value, field) {
  const normalized = normalizeText(value ?? "");
  invariant(normalized !== "", `${field} fehlt oder ist leer.`);
  return normalized;
}

function optionalText(value) {
  const normalized = normalizeText(value ?? "");
  return normalized === "" ? null : normalized;
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value !== null && value !== ""))].sort(compareText);
}

function parseAttributes(content) {
  const nameMatch = /^([^\s/>]+)/u.exec(content);
  invariant(nameMatch !== null, `XML-Starttag ohne Namen: <${content}>.`);
  const name = localName(nameMatch[1]);
  let remainder = content.slice(nameMatch[0].length);
  const selfClosing = /\/\s*$/u.test(remainder);
  if (selfClosing) remainder = remainder.replace(/\/\s*$/u, "");
  const attributes = {};
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(remainder)) !== null) {
    invariant(remainder.slice(cursor, match.index).trim() === "", `Unbekannte XML-Attributsyntax in <${content}>.`);
    const attributeName = localName(match[1]);
    invariant(attributes[attributeName] === undefined, `Doppeltes XML-Attribut ${attributeName} in <${name}>.`);
    attributes[attributeName] = decodeXml(match[2] ?? match[3]);
    cursor = pattern.lastIndex;
  }
  invariant(remainder.slice(cursor).trim() === "", `Unbekannte XML-Attributsyntax in <${content}>.`);
  return { name, attributes, selfClosing };
}

function findTagEnd(xml, start) {
  let quote = null;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function pathIs(path, ...expected) {
  return path.length === expected.length && path.every((name, index) => name === expected[index]);
}

function addMapValue(map, key, value) {
  const normalizedKey = requiredText(key, "NeTEx-Key");
  const normalizedValue = requiredText(value, `NeTEx-Key ${normalizedKey}`);
  const values = map.get(normalizedKey) ?? [];
  values.push(normalizedValue);
  map.set(normalizedKey, values);
}

function setConsistent(target, field, value, context) {
  if (target[field] === null || target[field] === undefined) target[field] = value;
  else invariant(target[field] === value, `${context} enthält widersprüchliche ${field}-Werte.`);
}

function tokenizeStopPlace(xml) {
  const stack = [];
  const station = {
    attrs: null,
    keys: new Map(),
    typedPrivateCodes: [],
    nameDirect: null,
    nameTexts: [],
    transportMode: null,
    stopPlaceType: null,
    parentSiteRef: null,
    topographicPlaceRef: null,
    address: { street: null, town: null, postCode: null, province: null },
    publicUse: null,
    gated: null,
    lighting: null,
    mobilityImpairedAccess: null,
    centroidCandidates: [],
    descendantCentroidCandidates: [],
    quays: [],
  };

  function activeQuay() {
    const frame = stack.find((candidate) => candidate.name === "Quay" && candidate.quay !== undefined);
    invariant(frame !== undefined, "NeTEx-Quay-Kontext fehlt.");
    return frame.quay;
  }

  function closeFrame() {
    const frame = stack.at(-1);
    invariant(frame !== undefined, "XML-Endtag ohne Starttag.");
    const path = stack.map(({ name }) => name);
    const text = optionalText(frame.directText);
    const parent = stack.at(-2);

    if (frame.name === "Key" && parent?.name === "KeyValue") parent.key = text;
    if (frame.name === "Value" && parent?.name === "KeyValue") parent.value = text;
    if (frame.name === "KeyValue") {
      invariant(frame.key !== null && frame.key !== undefined && frame.value !== null && frame.value !== undefined, "NeTEx-KeyValue ohne Key oder Value.");
      if (pathIs(path, "StopPlace", "keyList", "KeyValue")) addMapValue(station.keys, frame.key, frame.value);
      if (pathIs(path, "StopPlace", "quays", "Quay", "keyList", "KeyValue")) addMapValue(activeQuay().keys, frame.key, frame.value);
    }

    if (pathIs(path, "StopPlace", "Name")) station.nameDirect = text;
    if (pathIs(path, "StopPlace", "Name", "Text") && text !== null) station.nameTexts.push(text);
    if (pathIs(path, "StopPlace", "TransportMode")) station.transportMode = text;
    if (pathIs(path, "StopPlace", "StopPlaceType")) station.stopPlaceType = text;
    if (pathIs(path, "StopPlace", "PostalAddress", "Street")) station.address.street = text;
    if (pathIs(path, "StopPlace", "PostalAddress", "Town")) station.address.town = text;
    if (pathIs(path, "StopPlace", "PostalAddress", "PostCode")) station.address.postCode = text;
    if (pathIs(path, "StopPlace", "PostalAddress", "Province")) station.address.province = text;
    if (pathIs(path, "StopPlace", "PublicUse")) station.publicUse = text;
    if (pathIs(path, "StopPlace", "Gated")) station.gated = text;
    if (pathIs(path, "StopPlace", "Lighting")) station.lighting = text;
    if (pathIs(path, "StopPlace", "AccessibilityAssessment", "MobilityImpairedAccess")) station.mobilityImpairedAccess = text;
    if (pathIs(path, "StopPlace", "privateCodes", "PrivateCode") && text !== null) {
      station.typedPrivateCodes.push({ type: frame.attrs.type ?? null, value: text });
    }

    if (pathIs(path, "StopPlace", "quays", "Quay", "Name")) activeQuay().nameDirect = text;
    if (pathIs(path, "StopPlace", "quays", "Quay", "Name", "Text") && text !== null) activeQuay().nameTexts.push(text);
    if (pathIs(path, "StopPlace", "quays", "Quay", "PlateCode")) activeQuay().plateCode = text;
    if (pathIs(path, "StopPlace", "quays", "Quay", "Length")) activeQuay().length = text;
    if (pathIs(path, "StopPlace", "quays", "Quay", "Width")) activeQuay().width = text;
    if (pathIs(path, "StopPlace", "quays", "Quay", "PlatformHeight")) activeQuay().platformHeight = text;
    if (pathIs(path, "StopPlace", "quays", "Quay", "QuayType")) activeQuay().quayType = text;
    if (pathIs(path, "StopPlace", "quays", "Quay", "BoardingUse")) activeQuay().boardingUse = text;
    if (pathIs(path, "StopPlace", "quays", "Quay", "AlightingUse")) activeQuay().alightingUse = text;
    if (pathIs(path, "StopPlace", "quays", "Quay", "Covered")) activeQuay().covered = text;
    if (pathIs(path, "StopPlace", "quays", "Quay", "AccessibilityAssessment", "MobilityImpairedAccess")) {
      activeQuay().mobilityImpairedAccess = text;
    }
    if (pathIs(path, "StopPlace", "quays", "Quay", "privateCodes", "PrivateCode") && text !== null) {
      activeQuay().typedPrivateCodes.push({ type: frame.attrs.type ?? null, value: text });
    }

    if (frame.name === "Longitude" || frame.name === "Latitude") {
      const centroid = [...stack].reverse().find((candidate) => candidate.name === "Centroid" && candidate.centroid !== undefined);
      if (centroid !== undefined && text !== null) setConsistent(centroid.centroid, frame.name.toLowerCase(), text, "NeTEx-Centroid");
    }
    if (frame.name === "Centroid" && frame.centroid !== undefined) {
      const { longitude, latitude } = frame.centroid;
      invariant((longitude === null) === (latitude === null), "NeTEx-Centroid ist nur teilweise koordiniert.");
      if (longitude !== null) {
        const sourceFrame = [...stack.slice(0, -1)].reverse().find((candidate) => candidate.attrs?.id !== undefined);
        const candidate = {
          longitude,
          latitude,
          sourceObjectRef: sourceFrame?.attrs.id ?? null,
          sourceObjectType: sourceFrame?.name ?? null,
        };
        if (pathIs(path, "StopPlace", "Centroid")) station.centroidCandidates.push(candidate);
        else if (pathIs(path, "StopPlace", "quays", "Quay", "Centroid")) activeQuay().centroidCandidates.push(candidate);
        else if (path.includes("Quay")) activeQuay().descendantCentroidCandidates.push(candidate);
        else station.descendantCentroidCandidates.push(candidate);
      }
    }

    if (frame.name === "Quay" && frame.quay !== undefined) station.quays.push(frame.quay);
    stack.pop();
  }

  let cursor = 0;
  while (cursor < xml.length) {
    const next = xml.indexOf("<", cursor);
    if (next === -1) {
      if (stack.at(-1)?.captureText) stack.at(-1).directText += xml.slice(cursor);
      cursor = xml.length;
      break;
    }
    if (next > cursor && stack.at(-1)?.captureText) stack.at(-1).directText += xml.slice(cursor, next);
    if (xml.startsWith("<!--", next)) {
      const end = xml.indexOf("-->", next + 4);
      invariant(end !== -1, "Nicht abgeschlossener XML-Kommentar.");
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", next)) {
      const end = xml.indexOf("]]>", next + 9);
      invariant(end !== -1, "Nicht abgeschlossener XML-CDATA-Abschnitt.");
      if (stack.at(-1)?.captureText) stack.at(-1).directText += xml.slice(next + 9, end);
      cursor = end + 3;
      continue;
    }
    if (xml.startsWith("<?", next)) {
      const end = xml.indexOf("?>", next + 2);
      invariant(end !== -1, "Nicht abgeschlossene XML-Verarbeitungsanweisung.");
      cursor = end + 2;
      continue;
    }
    invariant(!xml.startsWith("<!", next), "Deklarationen sind in einem StopPlace-Block nicht zulässig.");
    const end = findTagEnd(xml, next + 1);
    invariant(end !== -1, "Nicht abgeschlossenes XML-Tag.");
    const content = xml.slice(next + 1, end).trim();
    if (content.startsWith("/")) {
      const closingName = localName(content.slice(1).trim());
      invariant(stack.at(-1)?.name === closingName, `XML-Endtag </${closingName}> passt nicht zu <${stack.at(-1)?.name ?? "nichts"}>.`);
      closeFrame();
    } else {
      const parsed = parseAttributes(content);
      const frame = {
        name: parsed.name,
        attrs: parsed.attributes,
        captureText: XML_TEXT_ELEMENTS.has(parsed.name),
        directText: "",
      };
      stack.push(frame);
      const path = stack.map(({ name }) => name);
      if (pathIs(path, "StopPlace")) {
        invariant(station.attrs === null, "Verschachtelte StopPlace-Elemente werden nicht unterstützt.");
        station.attrs = parsed.attributes;
      }
      if (pathIs(path, "StopPlace", "ParentSiteRef")) station.parentSiteRef = parsed.attributes.ref ?? null;
      if (pathIs(path, "StopPlace", "TopographicPlaceRef")) station.topographicPlaceRef = parsed.attributes.ref ?? null;
      if (parsed.name === "Centroid" && path[0] === "StopPlace") {
        frame.centroid = { longitude: null, latitude: null };
      }
      if (pathIs(path, "StopPlace", "quays", "Quay")) {
        frame.quay = {
          attrs: parsed.attributes,
          keys: new Map(),
          typedPrivateCodes: [],
          nameDirect: null,
          nameTexts: [],
          plateCode: null,
          parentQuayRef: null,
          siteRef: null,
          length: null,
          width: null,
          platformHeight: null,
          quayType: null,
          boardingUse: null,
          alightingUse: null,
          covered: null,
          mobilityImpairedAccess: null,
          centroidCandidates: [],
          descendantCentroidCandidates: [],
        };
      }
      if (pathIs(path, "StopPlace", "quays", "Quay", "ParentQuayRef")) activeQuay().parentQuayRef = parsed.attributes.ref ?? null;
      if (pathIs(path, "StopPlace", "quays", "Quay", "SiteRef")) activeQuay().siteRef = parsed.attributes.ref ?? null;
      if (parsed.selfClosing) closeFrame();
    }
    cursor = end + 1;
  }
  invariant(stack.length === 0, `StopPlace-XML endet mit ${stack.length} offenen Elementen.`);
  invariant(station.attrs !== null, "StopPlace-Starttag fehlt.");
  return station;
}

function decimalToScaledInteger(value, digits, field, minimum, maximum, allowRounding = false) {
  if (value === null) return null;
  const normalized = requiredText(value, field);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(normalized);
  invariant(match !== null, `${field} ist keine Dezimalzahl: ${normalized}.`);
  let fraction = match[3] ?? "";
  let roundUp = false;
  if (fraction.length > digits) {
    const excess = fraction.slice(digits);
    invariant(allowRounding || /^0*$/u.test(excess), `${field} hat mehr als ${digits} verlustfrei darstellbare Nachkommastellen: ${normalized}.`);
    roundUp = allowRounding && Number.parseInt(excess[0], 10) >= 5;
    fraction = fraction.slice(0, digits);
  }
  const factor = 10n ** BigInt(digits);
  let scaled = BigInt(match[2]) * factor + BigInt(fraction.padEnd(digits, "0") || "0");
  if (roundUp) scaled += 1n;
  if (match[1] === "-") scaled = -scaled;
  invariant(scaled >= BigInt(minimum) && scaled <= BigInt(maximum), `${field} liegt außerhalb des zulässigen Bereichs: ${normalized}.`);
  const result = Number(scaled);
  invariant(Number.isSafeInteger(result), `${field} ist keine sichere Ganzzahl.`);
  return result;
}

function coordinate(raw, field) {
  const sourceLongitude = requiredText(raw.longitude, `${field}.longitude`);
  const sourceLatitude = requiredText(raw.latitude, `${field}.latitude`);
  const longitude = decimalToScaledInteger(sourceLongitude, 7, `${field}.longitude`, -1_800_000_000, 1_800_000_000, true);
  const latitude = decimalToScaledInteger(sourceLatitude, 7, `${field}.latitude`, -900_000_000, 900_000_000, true);
  invariant(longitude !== null && latitude !== null, `${field} ist unvollständig.`);
  const hasExcess = (value) => {
    const fraction = /^-?\d+(?:\.(\d+))?$/u.exec(value)?.[1] ?? "";
    return fraction.length > 7 && /[1-9]/u.test(fraction.slice(7));
  };
  return {
    longitude,
    latitude,
    quantizedFromSource: hasExcess(sourceLongitude) || hasExcess(sourceLatitude),
    sourceCoordinate: { longitude: sourceLongitude, latitude: sourceLatitude },
  };
}

function metricEvidence(value, field) {
  if (value === null) return { status: "missing", millimetres: null, sourceValue: null };
  const millimetres = decimalToScaledInteger(value, 3, field, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (millimetres < 0) return { status: "invalid-negative-source-value", millimetres: null, sourceValue: value };
  return { status: "known", millimetres, sourceValue: value };
}

function sourceBoolean(value, field) {
  if (value === null) return null;
  invariant(["true", "false", "unknown"].includes(value), `${field} hat unbekannten Wert ${value}.`);
  return value === "unknown" ? "unknown" : value === "true";
}

function mobilityAccess(value, field) {
  if (value === null) return null;
  invariant(["true", "false", "partial", "unknown"].includes(value), `${field} hat unbekannten Wert ${value}.`);
  return value;
}

function keyValues(keys, name) {
  return uniqueSorted((keys.get(name) ?? []).map((value) => requiredText(value, `Key ${name}`)));
}

function oneIntegerKey(keys, name, minimum, maximum) {
  const values = keyValues(keys, name);
  if (values.length === 0) return null;
  invariant(values.length === 1 && /^\d+$/u.test(values[0]), `Key ${name} ist nicht eindeutig ganzzahlig.`);
  const value = Number.parseInt(values[0], 10);
  invariant(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `Key ${name} liegt außerhalb des zulässigen Bereichs.`);
  return value;
}

function stableFeatureId(featureType, sourceRef) {
  return `${featureType}:openstation:${encodeURIComponent(sourceRef)}`;
}

function idStability(sourceRef) {
  return sourceRef.startsWith("dbinfrago-temporary:") ? "source-temporary" : "source-stable";
}

function stationFeatureIdentity(sourceStopPlaceRef, rl100Codes, evaNumbers) {
  const sourceIdStability = idStability(sourceStopPlaceRef);
  if (sourceIdStability === "source-stable") {
    return {
      stationId: stableFeatureId("station", sourceStopPlaceRef),
      idStability: "source-stable",
      sourceIdStability,
    };
  }
  if (rl100Codes.length === 1 && evaNumbers.length === 1) {
    return {
      stationId: `station:openstation:rl100:${encodeURIComponent(rl100Codes[0])}:eva:${evaNumbers[0]}`,
      idStability: "derived-from-rl100-eva",
      sourceIdStability,
    };
  }
  return {
    stationId: stableFeatureId("station", sourceStopPlaceRef),
    idStability: "source-temporary",
    sourceIdStability,
  };
}

function chooseName(direct, nested, field) {
  const candidates = uniqueSorted([optionalText(direct), ...nested.map(optionalText)]);
  invariant(candidates.length > 0, `${field} fehlt.`);
  const primary = optionalText(direct) ?? candidates[0];
  return { primary, candidates };
}

function coordinateCandidates(rawCandidates, field) {
  const byKey = new Map();
  for (const raw of rawCandidates) {
    const candidate = coordinate(raw, field);
    const key = `${candidate.longitude}|${candidate.latitude}`;
    const existing = byKey.get(key) ?? {
      longitude: candidate.longitude,
      latitude: candidate.latitude,
      quantizedFromSource: false,
      sourceCoordinates: [],
      sourceObjectRefs: [],
      sourceObjectTypes: [],
    };
    existing.quantizedFromSource ||= candidate.quantizedFromSource;
    existing.sourceCoordinates.push(candidate.sourceCoordinate);
    if (raw.sourceObjectRef !== null && raw.sourceObjectRef !== undefined) existing.sourceObjectRefs.push(raw.sourceObjectRef);
    if (raw.sourceObjectType !== null && raw.sourceObjectType !== undefined) existing.sourceObjectTypes.push(raw.sourceObjectType);
    byKey.set(key, existing);
  }
  return [...byKey.values()].map((candidate) => ({
    ...candidate,
    sourceCoordinates: [...new Map(candidate.sourceCoordinates.map((source) => [`${source.longitude}|${source.latitude}`, source])).values()]
      .sort((left, right) => compareText(left.longitude, right.longitude) || compareText(left.latitude, right.latitude)),
    sourceObjectRefs: uniqueSorted(candidate.sourceObjectRefs),
    sourceObjectTypes: uniqueSorted(candidate.sourceObjectTypes),
  })).sort((left, right) => left.longitude - right.longitude || left.latitude - right.latitude);
}

function chooseMedoid(candidates) {
  invariant(candidates.length > 0, "Medoid ohne Kandidaten.");
  let best = null;
  let bestScore = null;
  for (const candidate of candidates) {
    let score = 0n;
    for (const other of candidates) {
      score += BigInt(Math.abs(candidate.longitude - other.longitude));
      score += BigInt(Math.abs(candidate.latitude - other.latitude));
    }
    if (bestScore === null || score < bestScore || (score === bestScore && (candidate.longitude < best.longitude || (candidate.longitude === best.longitude && candidate.latitude < best.latitude)))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function typedCodes(entries, typeSuffix) {
  return uniqueSorted(entries
    .filter(({ type }) => typeof type === "string" && type.toLowerCase().includes(typeSuffix))
    .map(({ value }) => requiredText(value, `PrivateCode ${typeSuffix}`)));
}

function normalizeQuay(raw, stationSourceRef, stationId, uniquePlateCodes) {
  const sourceQuayRef = requiredText(raw.attrs.id, `Quay-ID in ${stationSourceRef}`);
  const names = uniqueSorted([optionalText(raw.nameDirect), ...raw.nameTexts.map(optionalText)]);
  const directCoordinates = coordinateCandidates(raw.centroidCandidates, `Quay ${sourceQuayRef}`);
  const descendantCoordinates = coordinateCandidates(raw.descendantCentroidCandidates, `Quay ${sourceQuayRef}.descendant`);
  const coordinates = directCoordinates.length > 0 ? directCoordinates : descendantCoordinates;
  const selected = coordinates.length === 0 ? null : chooseMedoid(coordinates);
  const length = metricEvidence(raw.length, `Quay ${sourceQuayRef}.Length`);
  const width = metricEvidence(raw.width, `Quay ${sourceQuayRef}.Width`);
  const platformHeight = metricEvidence(raw.platformHeight, `Quay ${sourceQuayRef}.PlatformHeight`);
  const eqIds = keyValues(raw.keys, "EQ-ID");
  const tpIds = uniqueSorted([...keyValues(raw.keys, "TP-ID"), ...typedCodes(raw.typedPrivateCodes, "/tp/")]);
  const sourceIdStability = idStability(sourceQuayRef);
  let platformId = stableFeatureId("platform", sourceQuayRef);
  let platformIdStability = sourceIdStability;
  if (sourceIdStability === "source-temporary" && tpIds.length === 1) {
    platformId = `platform:openstation:${encodeURIComponent(stationId)}:tp:${encodeURIComponent(tpIds[0])}`;
    platformIdStability = "derived-from-station-and-tp-id";
  } else if (sourceIdStability === "source-temporary" && eqIds.length === 1) {
    platformId = `platform:openstation:${encodeURIComponent(stationId)}:eq:${encodeURIComponent(eqIds[0])}`;
    platformIdStability = "derived-from-station-and-eq-id";
  } else if (sourceIdStability === "source-temporary" && optionalText(raw.plateCode) !== null && uniquePlateCodes.has(optionalText(raw.plateCode))) {
    platformId = `platform:openstation:${encodeURIComponent(stationId)}:plate:${encodeURIComponent(optionalText(raw.plateCode))}`;
    platformIdStability = "derived-from-station-and-plate-code";
  }
  return {
    schema: "zugfolge-openstation-platform-evidence/v1",
    platformId,
    sourceQuayRef,
    idStability: platformIdStability,
    sourceIdStability,
    name: optionalText(raw.nameDirect) ?? names[0] ?? null,
    names,
    plateCode: optionalText(raw.plateCode),
    parentQuayRef: optionalText(raw.parentQuayRef),
    siteRef: optionalText(raw.siteRef),
    type: optionalText(raw.quayType),
    use: {
      boarding: sourceBoolean(raw.boardingUse, `Quay ${sourceQuayRef}.BoardingUse`),
      alighting: sourceBoolean(raw.alightingUse, `Quay ${sourceQuayRef}.AlightingUse`),
    },
    covered: optionalText(raw.covered),
    accessibility: {
      mobilityImpairedAccess: mobilityAccess(raw.mobilityImpairedAccess, `Quay ${sourceQuayRef}.MobilityImpairedAccess`),
    },
    dimensionsMm: {
      length: length.millimetres,
      width: width.millimetres,
      platformHeight: platformHeight.millimetres,
    },
    dimensionEvidence: {
      length,
      width,
      platformHeight,
    },
    coordinateE7: selected === null
      ? { status: "unknown", reason: "missing-in-source" }
      : {
          status: "known",
          longitude: selected.longitude,
          latitude: selected.latitude,
          method: directCoordinates.length > 0
            ? (coordinates.length === 1 ? "source-centroid" : "source-centroid-medoid")
            : "representative-source-quay-child-centroid",
          candidateCount: coordinates.length,
          sourceObjectRefs: selected.sourceObjectRefs,
          sourceObjectTypes: selected.sourceObjectTypes,
          quantizedFromSource: selected.quantizedFromSource,
          sourceCoordinates: selected.sourceCoordinates,
        },
    references: {
      eqIds,
      tpIds,
    },
  };
}

function stationCoordinate(raw, quays) {
  const direct = coordinateCandidates(raw.centroidCandidates, "StopPlace.Centroid");
  if (direct.length > 0) {
    const selected = chooseMedoid(direct);
    return {
      status: "known",
      longitude: selected.longitude,
      latitude: selected.latitude,
      method: direct.length === 1 ? "source-centroid" : "source-centroid-medoid",
      candidateCount: direct.length,
      sourcePlatformIds: [],
      sourceObjectRefs: selected.sourceObjectRefs,
      sourceObjectTypes: selected.sourceObjectTypes,
      quantizedFromSource: selected.quantizedFromSource,
      sourceCoordinates: selected.sourceCoordinates,
    };
  }
  const coordinateGroups = new Map();
  for (const quay of quays) {
    if (quay.coordinateE7.status !== "known") continue;
    const key = `${quay.coordinateE7.longitude}|${quay.coordinateE7.latitude}`;
    const group = coordinateGroups.get(key) ?? {
      longitude: quay.coordinateE7.longitude,
      latitude: quay.coordinateE7.latitude,
      sourcePlatformIds: [],
      quantizedFromSource: false,
      sourceCoordinates: [],
    };
    group.sourcePlatformIds.push(quay.platformId);
    group.quantizedFromSource ||= quay.coordinateE7.quantizedFromSource;
    group.sourceCoordinates.push(...quay.coordinateE7.sourceCoordinates);
    coordinateGroups.set(key, group);
  }
  if (coordinateGroups.size > 0) {
    const candidates = [...coordinateGroups.values()].sort((left, right) => left.longitude - right.longitude || left.latitude - right.latitude);
    const selected = chooseMedoid(candidates);
    return {
      status: "known",
      longitude: selected.longitude,
      latitude: selected.latitude,
      method: "representative-source-quay-centroid",
      candidateCount: candidates.length,
      sourcePlatformIds: selected.sourcePlatformIds.sort(compareText),
      sourceObjectRefs: [],
      sourceObjectTypes: [],
      quantizedFromSource: selected.quantizedFromSource,
      sourceCoordinates: [...new Map(selected.sourceCoordinates.map((source) => [`${source.longitude}|${source.latitude}`, source])).values()]
        .sort((left, right) => compareText(left.longitude, right.longitude) || compareText(left.latitude, right.latitude)),
    };
  }
  const descendant = coordinateCandidates(raw.descendantCentroidCandidates, "StopPlace.descendantCentroid");
  if (descendant.length > 0) {
    const selectedDescendant = chooseMedoid(descendant);
    return {
      status: "known",
      longitude: selectedDescendant.longitude,
      latitude: selectedDescendant.latitude,
      method: "representative-source-site-child-centroid",
      candidateCount: descendant.length,
      sourcePlatformIds: [],
      sourceObjectRefs: selectedDescendant.sourceObjectRefs,
      sourceObjectTypes: selectedDescendant.sourceObjectTypes,
      quantizedFromSource: selectedDescendant.quantizedFromSource,
      sourceCoordinates: selectedDescendant.sourceCoordinates,
    };
  }
  return { status: "unknown", reason: "no-stop-place-or-child-centroid" };
}

export function normalizeStopPlace(xml, publication) {
  const raw = tokenizeStopPlace(xml);
  const sourceStopPlaceRef = requiredText(raw.attrs.id, "StopPlace-ID");
  const name = chooseName(raw.nameDirect, raw.nameTexts, `StopPlace ${sourceStopPlaceRef}.Name`);
  invariant(raw.transportMode === "rail", `StopPlace ${sourceStopPlaceRef} hat TransportMode ${raw.transportMode ?? "fehlend"} statt rail.`);
  invariant(raw.stopPlaceType === "railStation", `StopPlace ${sourceStopPlaceRef} hat StopPlaceType ${raw.stopPlaceType ?? "fehlend"} statt railStation.`);
  const rl100Codes = keyValues(raw.keys, "RIL");
  for (const code of rl100Codes) invariant(/^[A-Z0-9][A-Z0-9 ]{1,14}$/u.test(code), `StopPlace ${sourceStopPlaceRef} enthält ungültige RIL-Kennung ${code}.`);
  const evaNumbers = keyValues(raw.keys, "EVA");
  for (const eva of evaNumbers) invariant(/^\d{7}$/u.test(eva), `StopPlace ${sourceStopPlaceRef} enthält ungültige EVA-Kennung ${eva}.`);
  const featureIdentity = stationFeatureIdentity(sourceStopPlaceRef, rl100Codes, evaNumbers);
  const plateCounts = new Map();
  for (const quay of raw.quays) {
    const plateCode = optionalText(quay.plateCode);
    if (plateCode !== null) plateCounts.set(plateCode, (plateCounts.get(plateCode) ?? 0) + 1);
  }
  const uniquePlateCodes = new Set([...plateCounts].filter(([, count]) => count === 1).map(([plateCode]) => plateCode));
  const quaysBySourceRef = new Map();
  const normalizedQuays = raw.quays.map((quay) => normalizeQuay(quay, sourceStopPlaceRef, featureIdentity.stationId, uniquePlateCodes));
  for (const quay of normalizedQuays) quaysBySourceRef.set(quay.sourceQuayRef, quay);
  const quays = normalizedQuays.map((quay) => {
    if (quay.idStability !== "source-temporary" || quay.plateCode === null || quay.parentQuayRef === null) return quay;
    const parent = quaysBySourceRef.get(quay.parentQuayRef);
    if (parent === undefined || parent.idStability === "source-temporary") return quay;
    return {
      ...quay,
      platformId: `platform:openstation:${encodeURIComponent(featureIdentity.stationId)}:parent:${encodeURIComponent(parent.platformId)}:plate:${encodeURIComponent(quay.plateCode)}`,
      idStability: "derived-from-parent-platform-and-plate-code",
    };
  }).sort((left, right) => compareText(left.platformId, right.platformId));
  invariant(new Set(quays.map(({ platformId }) => platformId)).size === quays.length, `StopPlace ${sourceStopPlaceRef} enthält doppelte Quay-IDs.`);
  const normalizedAddress = Object.fromEntries(Object.entries(raw.address).map(([key, value]) => [key, optionalText(value)]));
  const address = Object.values(normalizedAddress).every((value) => value === null) ? null : normalizedAddress;
  return {
    schema: "zugfolge-openstation-station-evidence/v1",
    stationId: featureIdentity.stationId,
    source: {
      sourceId: SOURCE_ID,
      sourceLicense: SOURCE_LICENSE,
      sourceStopPlaceRef,
      sourceVersion: requiredText(raw.attrs.version, `StopPlace ${sourceStopPlaceRef}.version`),
      publicationVersion: publication.version,
      publicationTimestamp: publication.timestamp,
    },
    identity: {
      idStability: featureIdentity.idStability,
      sourceIdStability: featureIdentity.sourceIdStability,
      dhid: sourceStopPlaceRef.startsWith("dhid:") ? sourceStopPlaceRef : null,
      rl100Codes,
      evaNumbers,
      stadaCodes: typedCodes(raw.typedPrivateCodes, "/stada/"),
      parentSiteRef: optionalText(raw.parentSiteRef),
      topographicPlaceRef: optionalText(raw.topographicPlaceRef),
    },
    name: name.primary,
    names: name.candidates,
    transportMode: raw.transportMode,
    stopPlaceType: raw.stopPlaceType,
    categories: {
      station: oneIntegerKey(raw.keys, "DBINFRAGO_STATION_CATEGORY", 1, 99),
      price: oneIntegerKey(raw.keys, "DBINFRAGO_PRICE_CATEGORY", 1, 99),
    },
    address,
    publicUse: optionalText(raw.publicUse),
    gated: optionalText(raw.gated),
    lighting: optionalText(raw.lighting),
    accessibility: {
      mobilityImpairedAccess: mobilityAccess(raw.mobilityImpairedAccess, `StopPlace ${sourceStopPlaceRef}.MobilityImpairedAccess`),
    },
    coordinateE7: stationCoordinate(raw, quays),
    quays,
  };
}

function parsePublicationHeader(header) {
  const root = /<PublicationDelivery\b([^>]*)>/u.exec(header);
  invariant(root !== null, "NeTEx-Wurzel PublicationDelivery fehlt vor dem ersten StopPlace.");
  const rootAttrs = parseAttributes(`PublicationDelivery${root[1]}`).attributes;
  const timestamp = /<PublicationTimestamp>([^<]+)<\/PublicationTimestamp>/u.exec(header)?.[1];
  const participant = /<ParticipantRef>([^<]+)<\/ParticipantRef>/u.exec(header)?.[1];
  const publication = {
    version: requiredText(rootAttrs.version, "PublicationDelivery.version"),
    timestamp: requiredText(timestamp, "PublicationTimestamp"),
    participant: requiredText(participant, "ParticipantRef"),
  };
  invariant(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(publication.timestamp), "PublicationTimestamp ist kein UTC-Zeitpunkt.");
  invariant(publication.participant === "DB", `Unerwarteter NeTEx-ParticipantRef ${publication.participant}.`);
  return publication;
}

async function streamStopPlaces(inputPath, onStopPlace) {
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let header = "";
  let trailer = "";
  let inside = false;
  let publication = null;
  let count = 0;
  let maxStopPlaceBytes = 0;

  async function consume(text, final = false) {
    buffer += text;
    while (true) {
      if (!inside) {
        const start = findStopPlaceStart(buffer);
        if (start === -1) {
          const retainedLength = final ? 0 : Math.min(STOP_PLACE_START.length, buffer.length);
          const consumed = retainedLength === 0 ? buffer : buffer.slice(0, -retainedLength);
          if (publication === null) {
            invariant(Buffer.byteLength(header) + Buffer.byteLength(consumed) <= 2_000_000, "NeTEx-Kopf vor dem ersten StopPlace ist unerwartet groß.");
            header += consumed;
          } else {
            trailer = `${trailer}${consumed}`.slice(-4096);
          }
          buffer = retainedLength === 0 ? "" : buffer.slice(-retainedLength);
          return;
        }
        if (publication === null) {
          header += buffer.slice(0, start);
          publication = parsePublicationHeader(header);
        }
        buffer = buffer.slice(start);
        inside = true;
      }
      const end = buffer.indexOf(STOP_PLACE_END);
      if (end === -1) return;
      const stopPlaceXml = buffer.slice(0, end + STOP_PLACE_END.length);
      maxStopPlaceBytes = Math.max(maxStopPlaceBytes, Buffer.byteLength(stopPlaceXml));
      await onStopPlace(stopPlaceXml, publication);
      count += 1;
      buffer = buffer.slice(end + STOP_PLACE_END.length);
      inside = false;
    }
  }

  for await (const chunk of createReadStream(inputPath)) {
    hash.update(chunk);
    await consume(decoder.write(chunk));
  }
  await consume(decoder.end(), true);
  invariant(!inside, "NeTEx-Datei endet innerhalb eines StopPlace-Elements.");
  trailer = `${trailer}${buffer}`.slice(-4096);
  invariant(publication !== null && count > 0, "NeTEx-Datei enthält keine StopPlaces.");
  invariant(trailer.includes("</PublicationDelivery>"), "NeTEx-Wurzel ist nicht abgeschlossen.");
  return { publication, sourceSha256: hash.digest("hex"), stopPlaceCount: count, maxStopPlaceBytes };
}

function stationFeature(station) {
  if (station.coordinateE7.status !== "known") return null;
  const coordinateUnambiguous = station.coordinateE7.candidateCount === 1;
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [station.coordinateE7.longitude / 10_000_000, station.coordinateE7.latitude / 10_000_000],
    },
    properties: {
      feature_id: station.stationId,
      feature_type: "station",
      quality_class: coordinateUnambiguous ? "B" : "C",
      model_state: coordinateUnambiguous ? "observed-non-operational" : "ambiguous-evidence",
      orderable: false,
      source_id: SOURCE_ID,
      station_id: station.stationId,
      name: station.name,
      rl100: station.identity.rl100Codes.length === 1 ? station.identity.rl100Codes[0] : "",
      rl100_refs: station.identity.rl100Codes.join(","),
      rl100_ref_count: station.identity.rl100Codes.length,
      uic: station.identity.evaNumbers.length === 1 ? station.identity.evaNumbers[0] : "",
      eva_refs: station.identity.evaNumbers.join(","),
      eva_ref_count: station.identity.evaNumbers.length,
      coordinate_evidence: station.coordinateE7.method,
      coordinate_quantized: station.coordinateE7.quantizedFromSource,
    },
  };
}

function platformFeature(station, platform) {
  if (platform.coordinateE7.status !== "known") return null;
  return {
    type: "Feature",
    geometry: {
      type: "Point",
      coordinates: [platform.coordinateE7.longitude / 10_000_000, platform.coordinateE7.latitude / 10_000_000],
    },
    properties: {
      feature_id: platform.platformId,
      feature_type: "platform",
      quality_class: "C",
      model_state: "evidence-only",
      source_id: SOURCE_ID,
      station_feature_id: station.stationId,
      name: platform.name ?? "",
      plate_code: platform.plateCode ?? "",
      platform_type: platform.type ?? "",
      coordinate_evidence: platform.coordinateE7.method,
      coordinate_quantized: platform.coordinateE7.quantizedFromSource,
    },
  };
}

function addIdentifiers(database, station) {
  const insert = database.prepare("INSERT INTO identifiers(kind, value, station_id) VALUES (?, ?, ?)");
  for (const value of station.identity.rl100Codes) insert.run("rl100", value, station.stationId);
  for (const value of station.identity.evaNumbers) insert.run("eva", value, station.stationId);
  if (station.coordinateE7.status === "known") insert.run("name-coordinate", `${station.name}|${station.coordinateE7.longitude}|${station.coordinateE7.latitude}`, station.stationId);
}

function duplicateReport(database) {
  const rows = database.prepare("SELECT kind, value, station_id FROM identifiers ORDER BY kind COLLATE BINARY, value COLLATE BINARY, station_id COLLATE BINARY").all();
  const result = { eva: [], rl100: [], nameCoordinate: [] };
  let current = null;
  function flush() {
    if (current === null || current.stationIds.length < 2) return;
    const target = current.kind === "name-coordinate" ? result.nameCoordinate : result[current.kind];
    target.push({ value: current.value, stationIds: current.stationIds });
  }
  for (const row of rows) {
    if (current === null || current.kind !== row.kind || current.value !== row.value) {
      flush();
      current = { kind: row.kind, value: row.value, stationIds: [] };
    }
    current.stationIds.push(row.station_id);
  }
  flush();
  return result;
}

async function fileWriter(path) {
  const handle = await open(path, "wx");
  const hash = createHash("sha256");
  let bytes = 0;
  let count = 0;
  return {
    async write(value) {
      const line = `\x1e${JSON.stringify(value)}\n`;
      await handle.write(line, null, "utf8");
      hash.update(line, "utf8");
      bytes += Buffer.byteLength(line);
      count += 1;
    },
    async close() {
      await handle.sync();
      await handle.close();
      return { bytes, count, sha256: hash.digest("hex") };
    },
  };
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function writeOpenStationOutputs(inputPath, outputRoot, expectedSourceSha256 = undefined) {
  const absoluteInput = resolve(inputPath);
  const absoluteOutput = resolve(outputRoot);
  const building = `${absoluteOutput}.building`;
  invariant(!await pathExists(absoluteOutput), `OpenStation-Ausgabeziel existiert bereits: ${absoluteOutput}.`);
  invariant(!await pathExists(building), `OpenStation-Bauverzeichnis existiert bereits: ${building}.`);
  if (expectedSourceSha256 !== undefined) invariant(SHA256.test(expectedSourceSha256), "Erwarteter OpenStation-SHA-256 ist ungültig.");
  await mkdir(building, { recursive: true });
  const files = {
    stations: "openstation-stations.jsonseq",
    operatingPoints: "stations.geojsonseq",
    platforms: "openstation-platform-points.geojsonseq",
    report: "openstation-adapter-report.json",
  };
  const databasePath = resolve(building, ".sort.sqlite");
  const database = new DatabaseSync(databasePath);
  const counts = {
    sourceQuays: 0,
    stationsWithRl100: 0,
    stationsWithEva: 0,
    stationsWithDirectCoordinate: 0,
    stationsWithRepresentativeQuayCoordinate: 0,
    stationsWithRepresentativeSiteChildCoordinate: 0,
    stationsWithoutCoordinate: 0,
    sourceTemporaryStationIds: 0,
    projectTemporaryStationIds: 0,
    stationIdsDerivedFromRl100Eva: 0,
    sourceTemporaryPlatformIds: 0,
    projectTemporaryPlatformIds: 0,
    platformIdsDerivedFromTp: 0,
    platformIdsDerivedFromEq: 0,
    platformIdsDerivedFromPlate: 0,
    platformIdsDerivedFromParentAndPlate: 0,
    platformsWithCoordinate: 0,
    platformsWithoutCoordinate: 0,
    platformsWithLength: 0,
    platformsWithHeight: 0,
    invalidPlatformLengths: 0,
    invalidPlatformWidths: 0,
    invalidPlatformHeights: 0,
  };
  const findings = {
    stationsMissingEva: [],
    sourceTemporaryStationIds: [],
    invalidPlatformDimensions: [],
  };
  try {
    database.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      CREATE TABLE stations (station_id TEXT PRIMARY KEY, json TEXT NOT NULL, feature_json TEXT);
      CREATE TABLE platforms (platform_id TEXT PRIMARY KEY, station_id TEXT NOT NULL, feature_json TEXT NOT NULL);
      CREATE TABLE identifiers (kind TEXT NOT NULL, value TEXT NOT NULL, station_id TEXT NOT NULL, PRIMARY KEY(kind, value, station_id));
    `);
    const insertStation = database.prepare("INSERT INTO stations(station_id, json, feature_json) VALUES (?, ?, ?)");
    const insertPlatform = database.prepare("INSERT INTO platforms(platform_id, station_id, feature_json) VALUES (?, ?, ?)");
    const scan = await streamStopPlaces(absoluteInput, async (xml, publication) => {
      const station = normalizeStopPlace(xml, publication);
      counts.sourceQuays += station.quays.length;
      counts.stationsWithRl100 += station.identity.rl100Codes.length > 0 ? 1 : 0;
      counts.stationsWithEva += station.identity.evaNumbers.length > 0 ? 1 : 0;
      counts.sourceTemporaryStationIds += station.identity.sourceIdStability === "source-temporary" ? 1 : 0;
      counts.projectTemporaryStationIds += station.identity.idStability === "source-temporary" ? 1 : 0;
      counts.stationIdsDerivedFromRl100Eva += station.identity.idStability === "derived-from-rl100-eva" ? 1 : 0;
      if (station.identity.evaNumbers.length === 0) findings.stationsMissingEva.push(station.stationId);
      if (station.identity.sourceIdStability === "source-temporary") {
        findings.sourceTemporaryStationIds.push({
          stationId: station.stationId,
          sourceStopPlaceRef: station.source.sourceStopPlaceRef,
          idStability: station.identity.idStability,
        });
      }
      if (station.coordinateE7.status === "unknown") counts.stationsWithoutCoordinate += 1;
      else if (station.coordinateE7.method.startsWith("source-centroid")) counts.stationsWithDirectCoordinate += 1;
      else if (station.coordinateE7.method === "representative-source-quay-centroid") counts.stationsWithRepresentativeQuayCoordinate += 1;
      else counts.stationsWithRepresentativeSiteChildCoordinate += 1;
      const feature = stationFeature(station);
      try {
        insertStation.run(station.stationId, JSON.stringify(station), feature === null ? null : JSON.stringify(feature));
      } catch (error) {
        throw new Error(`Doppelte oder ungültige StopPlace-ID ${station.stationId}: ${error.message}`, { cause: error });
      }
      addIdentifiers(database, station);
      for (const platform of station.quays) {
        counts.sourceTemporaryPlatformIds += platform.sourceIdStability === "source-temporary" ? 1 : 0;
        counts.projectTemporaryPlatformIds += platform.idStability === "source-temporary" ? 1 : 0;
        counts.platformIdsDerivedFromTp += platform.idStability === "derived-from-station-and-tp-id" ? 1 : 0;
        counts.platformIdsDerivedFromEq += platform.idStability === "derived-from-station-and-eq-id" ? 1 : 0;
        counts.platformIdsDerivedFromPlate += platform.idStability === "derived-from-station-and-plate-code" ? 1 : 0;
        counts.platformIdsDerivedFromParentAndPlate += platform.idStability === "derived-from-parent-platform-and-plate-code" ? 1 : 0;
        counts.platformsWithLength += platform.dimensionsMm.length === null ? 0 : 1;
        counts.platformsWithHeight += platform.dimensionsMm.platformHeight === null ? 0 : 1;
        counts.invalidPlatformLengths += platform.dimensionEvidence.length.status.startsWith("invalid-") ? 1 : 0;
        counts.invalidPlatformWidths += platform.dimensionEvidence.width.status.startsWith("invalid-") ? 1 : 0;
        counts.invalidPlatformHeights += platform.dimensionEvidence.platformHeight.status.startsWith("invalid-") ? 1 : 0;
        for (const dimension of ["length", "width", "platformHeight"]) {
          const evidence = platform.dimensionEvidence[dimension];
          if (evidence.status.startsWith("invalid-")) {
            findings.invalidPlatformDimensions.push({
              platformId: platform.platformId,
              dimension,
              status: evidence.status,
              sourceValue: evidence.sourceValue,
            });
          }
        }
        const platformGeoJson = platformFeature(station, platform);
        if (platformGeoJson === null) {
          counts.platformsWithoutCoordinate += 1;
          continue;
        }
        counts.platformsWithCoordinate += 1;
        try {
          insertPlatform.run(platform.platformId, station.stationId, JSON.stringify(platformGeoJson));
        } catch (error) {
          throw new Error(`Doppelte oder ungültige Quay-ID ${platform.platformId}: ${error.message}`, { cause: error });
        }
      }
    });
    invariant(expectedSourceSha256 === undefined || scan.sourceSha256 === expectedSourceSha256, `OpenStation verletzt den gepinnten SHA-256: ${scan.sourceSha256}.`);

    const stationWriter = await fileWriter(resolve(building, files.stations));
    const operatingPointWriter = await fileWriter(resolve(building, files.operatingPoints));
    const platformWriter = await fileWriter(resolve(building, files.platforms));
    for (const row of database.prepare("SELECT json, feature_json FROM stations ORDER BY station_id COLLATE BINARY").iterate()) {
      await stationWriter.write(JSON.parse(row.json));
      if (row.feature_json !== null) await operatingPointWriter.write(JSON.parse(row.feature_json));
    }
    for (const row of database.prepare("SELECT feature_json FROM platforms ORDER BY platform_id COLLATE BINARY").iterate()) {
      await platformWriter.write(JSON.parse(row.feature_json));
    }
    const stationOutput = await stationWriter.close();
    const operatingPointOutput = await operatingPointWriter.close();
    const platformOutput = await platformWriter.close();
    invariant(stationOutput.count === scan.stopPlaceCount, "OpenStation-Stationsausgabe ist unvollständig.");
    invariant(operatingPointOutput.count > 0, "OpenStation enthält keinen belegten Stationspunkt.");
    invariant(platformOutput.count > 0, "OpenStation enthält keinen belegten Bahnsteigpunkt.");
    const duplicates = duplicateReport(database);
    database.close();
    await rm(databasePath, { force: true });
    const sourceMetadata = await stat(absoluteInput);
    const report = {
      schema: "zugfolge-openstation-netex-adapter-report/v1",
      source: {
        sourceId: SOURCE_ID,
        sourceLicense: SOURCE_LICENSE,
        sha256: scan.sourceSha256,
        bytes: sourceMetadata.size,
        publication: scan.publication,
        parsedAs: "streamed-stop-place-fragments",
        maximumBufferedStopPlaceBytes: scan.maxStopPlaceBytes,
      },
      counts: {
        sourceStopPlaces: scan.stopPlaceCount,
        normalizedStations: stationOutput.count,
        stationFeatures: operatingPointOutput.count,
        platformPointFeatures: platformOutput.count,
        ...counts,
      },
      quality: {
        coordinatePolicy: "direct-stop-centroid-else-exact-representative-source-quay-or-site-child-centroid-else-unknown",
        temporaryIdentifiersAreStable: false,
        gameQualityPromotedByAdapter: false,
        duplicateReferences: duplicates,
        findings: {
          stationsMissingEva: findings.stationsMissingEva.sort(compareText),
          sourceTemporaryStationIds: findings.sourceTemporaryStationIds.sort((left, right) => compareText(left.stationId, right.stationId)),
          invalidPlatformDimensions: findings.invalidPlatformDimensions.sort((left, right) => compareText(left.platformId, right.platformId) || compareText(left.dimension, right.dimension)),
        },
      },
      outputs: [
        { kind: "stations-geojsonseq", file: files.operatingPoints, ...operatingPointOutput },
        { kind: "platform-points-geojsonseq", file: files.platforms, ...platformOutput },
        { kind: "station-evidence-jsonseq", file: files.stations, ...stationOutput },
      ],
    };
    await writeFile(resolve(building, files.report), `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(building, absoluteOutput);
    return { report, files };
  } catch (error) {
    try { database.close(); } catch {}
    await rm(building, { recursive: true, force: true });
    throw error;
  }
}
