import { createHash, createPublicKey, KeyObject, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const CORPUS_SCHEMA = "zugfolge-reference-corpus/v1";
export const REPORT_SCHEMA = "zugfolge-reference-report/v1";
export const BUNDLE_SCHEMA = "zugfolge-pilot-release-bundle/v1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function integer(value, name, minimum = 0) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${name} muss eine ganze Zahl >= ${minimum} sein.`);
}

function nonEmpty(value, name) {
  invariant(typeof value === "string" && value.trim() !== "", `${name} fehlt.`);
}

function quantileNearestRank(sorted, ratio) {
  invariant(sorted.length > 0, "Quantil einer leeren Stichprobe ist nicht definiert.");
  const index = Math.ceil(ratio * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function observationGroupKey(observation) {
  return [
    observation.routeId,
    observation.fromEva,
    observation.toEva,
    observation.direction,
    observation.stopPattern,
    observation.characteristicsId,
  ].join("|");
}

export function validateObservation(observation, index) {
  const prefix = `Beobachtung ${index}`;
  for (const field of [
    "sourceId",
    "tripId",
    "serviceDate",
    "routeId",
    "fromEva",
    "toEva",
    "direction",
    "stopPattern",
    "characteristicsId",
    "trainCategory",
    "trainNumber",
  ]) {
    nonEmpty(observation[field], `${prefix}.${field}`);
  }
  integer(observation.plannedDepartureEpochSeconds, `${prefix}.plannedDepartureEpochSeconds`);
  integer(observation.plannedArrivalEpochSeconds, `${prefix}.plannedArrivalEpochSeconds`);
  invariant(
    observation.plannedArrivalEpochSeconds > observation.plannedDepartureEpochSeconds,
    `${prefix}: Ankunft muss nach Abfahrt liegen.`,
  );
  if (observation.changedDepartureEpochSeconds !== undefined) {
    integer(observation.changedDepartureEpochSeconds, `${prefix}.changedDepartureEpochSeconds`);
  }
  if (observation.changedArrivalEpochSeconds !== undefined) {
    integer(observation.changedArrivalEpochSeconds, `${prefix}.changedArrivalEpochSeconds`);
  }
  return Object.freeze({ ...observation });
}

export function buildReferenceCorpus(input) {
  invariant(Array.isArray(input.observations), "observations muss eine Liste sein.");
  integer(input.minimumSamples ?? 5, "minimumSamples", 2);
  const observations = input.observations.map(validateObservation);
  const byGroup = new Map();
  for (const observation of observations) {
    const key = observationGroupKey(observation);
    const group = byGroup.get(key) ?? [];
    group.push(observation);
    byGroup.set(key, group);
  }

  const groups = [];
  for (const [key, values] of [...byGroup].sort(([a], [b]) => a.localeCompare(b))) {
    invariant(
      values.length >= (input.minimumSamples ?? 5),
      `${key}: nur ${values.length} statt mindestens ${input.minimumSamples ?? 5} vergleichbare Läufe.`,
    );
    const planned = values
      .map((value) => value.plannedArrivalEpochSeconds - value.plannedDepartureEpochSeconds)
      .sort((a, b) => a - b);
    const changed = values
      .filter(
        (value) =>
          value.changedDepartureEpochSeconds !== undefined &&
          value.changedArrivalEpochSeconds !== undefined &&
          value.changedArrivalEpochSeconds > value.changedDepartureEpochSeconds,
      )
      .map((value) => value.changedArrivalEpochSeconds - value.changedDepartureEpochSeconds)
      .sort((a, b) => a - b);
    const first = values[0];
    groups.push(
      Object.freeze({
        id: sha256(key).slice(0, 16),
        routeId: first.routeId,
        fromEva: first.fromEva,
        toEva: first.toEva,
        direction: first.direction,
        stopPattern: first.stopPattern,
        characteristicsId: first.characteristicsId,
        sampleCount: values.length,
        // P20 bildet die weitgehend unbehinderte technische Fahrt ab, ohne
        // einen einzelnen Extremwert zum vermeintlichen Optimum zu erklären.
        technicalReferenceSeconds: quantileNearestRank(planned, 0.2),
        // Median und Mittelwert bleiben getrennt sichtbar: Sie enthalten
        // typische Fahrplanreserven, Kreuzungs- und Überholungsanteile.
        timetableMedianSeconds: median(planned),
        timetableMeanSeconds: Math.round(planned.reduce((sum, value) => sum + value, 0) / planned.length),
        observedMedianSeconds: changed.length >= 3 ? median(changed) : null,
        observedSampleCount: changed.length,
        minimumSeconds: planned[0],
        maximumSeconds: planned.at(-1),
        observationIds: values.map((value) => value.tripId).sort(),
      }),
    );
  }

  return Object.freeze({
    schema: CORPUS_SCHEMA,
    region: input.region,
    schedulePeriod: input.schedulePeriod,
    generatedAt: input.generatedAt,
    source: input.source,
    methodology: Object.freeze({
      technicalReference: "P20 der Sollfahrzeiten bei identischer Strecke, Richtung, Haltefolge und Zugcharakteristik",
      timetableReference: "Median und arithmetisches Mittel derselben Sollfahrzeiten",
      observedReference: "Median vorhandener Istfahrzeiten; nur informativ und erst ab drei Beobachtungen",
    }),
    groups: Object.freeze(groups),
    observationsSha256: sha256(canonicalJson(observations)),
  });
}

export function compareWithModel(corpus, modelResults, tolerance = { absoluteSeconds: 30, relativeBasisPoints: 500 }) {
  invariant(corpus.schema === CORPUS_SCHEMA, "Unbekanntes Korpus-Schema.");
  integer(tolerance.absoluteSeconds, "absoluteSeconds", 0);
  integer(tolerance.relativeBasisPoints, "relativeBasisPoints", 0);
  const byId = new Map(modelResults.map((result) => [result.groupId, result]));
  const comparisons = corpus.groups.map((group) => {
    const result = byId.get(group.id);
    invariant(result, `Modellergebnis für Gruppe ${group.id} fehlt.`);
    invariant(result.characteristicsId === group.characteristicsId, `${group.id}: Zugcharakteristik stimmt nicht überein.`);
    integer(result.calculatedSeconds, `${group.id}.calculatedSeconds`, 1);
    const allowance = Math.max(
      tolerance.absoluteSeconds,
      Math.ceil((group.technicalReferenceSeconds * tolerance.relativeBasisPoints) / 10_000),
    );
    const deviation = result.calculatedSeconds - group.technicalReferenceSeconds;
    return Object.freeze({
      groupId: group.id,
      characteristicsId: group.characteristicsId,
      calculatedSeconds: result.calculatedSeconds,
      technicalReferenceSeconds: group.technicalReferenceSeconds,
      technicalDeviationSeconds: deviation,
      toleranceSeconds: allowance,
      technicalWithinTolerance: Math.abs(deviation) <= allowance,
      timetableMedianSeconds: group.timetableMedianSeconds,
      scheduledReserveSeconds: group.timetableMedianSeconds - result.calculatedSeconds,
      sampleCount: group.sampleCount,
    });
  });
  return Object.freeze({
    schema: REPORT_SCHEMA,
    corpusSha256: sha256(canonicalJson(corpus)),
    releaseChecksum: modelResults.releaseChecksum,
    tolerance,
    passed: comparisons.every((comparison) => comparison.technicalWithinTolerance),
    comparisons: Object.freeze(comparisons),
  });
}

export function verifyRegisteredSource(registry, source) {
  const entry = registry.quellen?.find((candidate) => candidate.id === source.id);
  invariant(entry, `Quelle '${source.id}' fehlt im Quellenregister.`);
  invariant(entry.status === "freigegeben", `Quelle '${source.id}' ist nicht für Import freigegeben.`);
  invariant(entry.lizenz === source.sourceLicense, `Lizenz von '${source.id}' weicht vom Quellenregister ab.`);
  nonEmpty(source.attribution, "source.attribution");
  nonEmpty(source.retrievedAt, "source.retrievedAt");
  nonEmpty(source.apiVersion, "source.apiVersion");
  return entry;
}

export function createUnsignedBundle(input) {
  invariant(input.corpus.schema === CORPUS_SCHEMA, "Korpus-Schema ist nicht signierbar.");
  invariant(input.report.schema === REPORT_SCHEMA && input.report.passed, "Nur ein bestandener Report darf signiert werden.");
  invariant(input.report.corpusSha256 === sha256(canonicalJson(input.corpus)), "Report gehört nicht zu diesem Korpus.");
  nonEmpty(input.releasePath, "releasePath");
  nonEmpty(input.releaseSha256, "releaseSha256");
  return Object.freeze({
    schema: BUNDLE_SCHEMA,
    region: input.corpus.region,
    schedulePeriod: input.corpus.schedulePeriod,
    corpusSha256: sha256(canonicalJson(input.corpus)),
    reportSha256: sha256(canonicalJson(input.report)),
    releasePath: input.releasePath,
    releaseSha256: input.releaseSha256,
    releaseChecksum: input.report.releaseChecksum,
    source: input.corpus.source,
    createdAt: input.createdAt,
  });
}

export function signBundle(bundle, privateKeyPem) {
  invariant(bundle.schema === BUNDLE_SCHEMA, "Unbekanntes Bundle-Schema.");
  const publicKey = createPublicKey(privateKeyPem);
  const payload = Buffer.from(canonicalJson(bundle));
  return Object.freeze({
    bundle,
    signature: Object.freeze({
      algorithm: "Ed25519",
      publicKeySha256: sha256(publicKey.export({ type: "spki", format: "der" })),
      valueBase64: cryptoSign(null, payload, privateKeyPem).toString("base64"),
    }),
  });
}

export function verifySignedBundle(signedBundle, publicKeyPem) {
  invariant(signedBundle.bundle?.schema === BUNDLE_SCHEMA, "Unbekanntes Bundle-Schema.");
  invariant(signedBundle.signature?.algorithm === "Ed25519", "Nur Ed25519-Signaturen sind zulässig.");
  const publicKey = publicKeyPem instanceof KeyObject && publicKeyPem.type === "public"
    ? publicKeyPem
    : createPublicKey(publicKeyPem);
  invariant(
    signedBundle.signature.publicKeySha256 === sha256(publicKey.export({ type: "spki", format: "der" })),
    "Signatur wurde nicht mit dem erwarteten Release-Schlüssel erstellt.",
  );
  invariant(
    cryptoVerify(
      null,
      Buffer.from(canonicalJson(signedBundle.bundle)),
      publicKey,
      Buffer.from(signedBundle.signature.valueBase64, "base64"),
    ),
    "Signatur des Pilot-Releases ist ungültig.",
  );
  return signedBundle.bundle;
}

export async function verifyBundleFiles(signedBundle, publicKeyPem, rootDirectory) {
  const bundle = verifySignedBundle(signedBundle, publicKeyPem);
  const releasePath = path.resolve(rootDirectory, bundle.releasePath);
  invariant(
    releasePath.startsWith(`${path.resolve(rootDirectory)}${path.sep}`),
    "releasePath darf den Artefaktordner nicht verlassen.",
  );
  const release = await readFile(releasePath);
  invariant(sha256(release) === bundle.releaseSha256, "InfraRelease-Artefakt stimmt nicht mit dem signierten Hash überein.");
  return bundle;
}
