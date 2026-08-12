import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  APN_ANALYSIS_VERSION,
  INFRAGO_OPERATING_PLACE_SCHEMA,
  NORMALIZED_OPERATING_POINTS_SCHEMA,
  analyzeCapturedApnEvidence,
  analyzePdfBytes,
  assertReleaseSafeValidationMarker,
  captureApnEvidence,
  createReleaseSafeValidationMarker,
  createValidationReceiptDraft,
  normalizeApnPolicy,
  normalizedOperatingPoints,
  parseNormalizedOperatingPointCatalog,
  prepareExternalEvidenceRoot,
  renameWithTransientWindowsRetry,
  sha256,
} from "./apn-evidence.mjs";

const REPOSITORY_ROOT = resolve(".");

function syntheticPdf(label = "Leipzig Hbf") {
  const stream = [
    `BT /F1 12 Tf 72 720 Td (${label}) Tj ET`,
    "10 10 m 100 10 l 100 100 l h S",
    "20 20 30 40 re S",
  ].join("\n");
  return Buffer.from([
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >> endobj",
    `4 0 obj << /Length ${Buffer.byteLength(stream)} >>`,
    "stream",
    stream,
    "endstream",
    "endobj",
    "5 0 obj << /Title (Synthetischer Plan) /Creator (Zugfolge Test) /Producer (Fixture) >> endobj",
    "6 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "trailer << /Root 1 0 R /Info 5 0 R >>",
    "startxref",
    "0",
    "%%EOF",
    "",
  ].join("\n"), "latin1");
}

function catalog(operatingPoints) {
  return { schema: NORMALIZED_OPERATING_POINTS_SCHEMA, operatingPoints };
}

async function localServer(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(String(error));
    });
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/apn/`,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

test("PDF-Strukturanalyse erzeugt nur einen prüfpflichtigen, Klasse-A-gesperrten Entwurf", () => {
  const bytes = syntheticPdf();
  const analysis = analyzePdfBytes(bytes);
  assert.equal(analysis.analysisVersion, APN_ANALYSIS_VERSION);
  assert.equal(analysis.document.documentSha256, sha256(bytes));
  assert.equal(analysis.metadata.pdfVersion, "1.4");
  assert.equal(analysis.metadata.pageObjectCount, 1);
  assert.equal(analysis.metadata.info.title, "Synthetischer Plan");
  assert.equal(analysis.metadata.info.creator, "Zugfolge Test");
  assert.equal(analysis.streams.decodedStreamCount, 1);
  assert.equal(analysis.text.showTextOperatorCount, 1);
  assert.equal(analysis.vector.operatorCounts.m, 1);
  assert.equal(analysis.vector.operatorCounts.l, 2);
  assert.equal(analysis.vector.rectangleOperatorCount, 1);

  const entry = {
    stationKey: "a".repeat(24),
    targetObjectId: "station-leipzig",
    status: "available",
    documentSha256: sha256(bytes),
  };
  const draft = createValidationReceiptDraft({ entry, analysis });
  assert.equal(draft.status, "draft");
  assert.equal(draft.classAEligible, false);
  assert.deepEqual(draft.validatedDimensions, []);
  assert.deepEqual(draft.candidateDimensions, ["topology", "signalling"]);
  assert.equal(draft.sourceBindingRequired, true);
});

test("übernimmt die normalisierte InfraGO-Betriebsstellen-JSON-Sequenz direkt", () => {
  const jsonSequence = [
    { schema: INFRAGO_OPERATING_PLACE_SCHEMA, operatingPlaceId: "db-infrago:rl100:ALD%20A", rl100: "ALD A", name: "Altdorf" },
    { schema: INFRAGO_OPERATING_PLACE_SCHEMA, operatingPlaceId: "db-infrago:rl100:BMOA", rl100: "BMOA", name: "Moa" },
  ].map((value) => `\x1e${JSON.stringify(value)}\n`).join("");
  const parsed = parseNormalizedOperatingPointCatalog(jsonSequence);
  assert.deepEqual(normalizedOperatingPoints(parsed).map(({ targetObjectId, rl100 }) => ({ targetObjectId, rl100 })), [
    { targetObjectId: "db-infrago:rl100:ALD%20A", rl100: "ALD A" },
    { targetObjectId: "db-infrago:rl100:BMOA", rl100: "BMOA" },
  ]);
  assert.throws(
    () => normalizedOperatingPoints([{ schema: "unknown", operatingPlaceId: "x", rl100: "XX" }]),
    /zugfolge-infrago-operating-place/,
  );
});

test("auslieferbarer Marker enthält weder Abruf- noch Rohdateikennung", () => {
  const marker = createReleaseSafeValidationMarker({
    targetObjectId: "station-leipzig",
    status: "accepted-secondary-validation",
    validatedDimensions: ["signalling", "topology", "signalling"],
  });
  assert.equal(marker.classAEligible, false);
  assert.deepEqual(marker.validatedDimensions, ["signalling", "topology"]);
  assert.match(marker.receiptHash, /^[a-f0-9]{64}$/);
  const shipped = JSON.stringify(marker).toLowerCase();
  assert.equal(shipped.includes("trassenfinder"), false);
  assert.equal(shipped.includes("/apn/"), false);
  assert.equal(shipped.includes(".pdf"), false);
  assert.throws(() => assertReleaseSafeValidationMarker({ ...marker, sourceUrl: "https://trassenfinder.de/apn/LL" }), /verboten|Kennung/);
  assert.throws(() => assertReleaseSafeValidationMarker({ ...marker, rawFile: "abc.pdf" }), /verboten|Kennung/);
  assert.throws(() => assertReleaseSafeValidationMarker({ ...marker, documentSha256: "a".repeat(64) }), /verboten/);
});

test("lokaler Capture ist schonend, URL-kodiert, wiederaufnehmbar und klassifiziert Fehler", async (t) => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "zugfolge-apn-evidence-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const pdf = syntheticPdf("Test Bf");
  const requests = new Map();
  let active = 0;
  let maximumActive = 0;
  let userAgent = "";
  const server = await localServer(async (request, response) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const path = request.url ?? "";
    requests.set(path, (requests.get(path) ?? 0) + 1);
    userAgent = String(request.headers["user-agent"] ?? "");
    try {
      if (path === "/apn/MISSING") {
        response.statusCode = 404;
        response.end("missing");
        return;
      }
      if (path === "/apn/RETRY" && requests.get(path) === 1) {
        response.statusCode = 503;
        response.setHeader("Retry-After", "0");
        response.end("later");
        return;
      }
      if (path === "/apn/BADTYPE") {
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html");
        response.end("<html>not a pdf</html>");
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/pdf; charset=binary");
      response.setHeader("Content-Length", String(pdf.length));
      response.end(pdf);
    } finally {
      active -= 1;
    }
  });
  t.after(server.close);

  const sourceCatalog = catalog([
    { objectId: "station-retry", rl100: "RETRY" },
    { objectId: "station-space", rl100: "A B" },
    { objectId: "station-missing", rl100: "MISSING" },
    { objectId: "station-badtype", rl100: "BADTYPE" },
  ]);
  const options = {
    catalog: sourceCatalog,
    evidenceRoot,
    repositoryRoot: REPOSITORY_ROOT,
    baseUrl: server.baseUrl,
    policy: {
      concurrency: 2,
      delayMs: 0,
      maxAttempts: 2,
      initialBackoffMs: 0,
      maximumBackoffMs: 0,
      requestTimeoutMs: 2_000,
      maxBytes: pdf.length + 100,
      userAgent: "Zugfolge APN local-test/1.0",
    },
  };
  const first = await captureApnEvidence(options);
  assert.deepEqual(first.summary, {
    operatingPointCount: 4,
    available: 2,
    unavailable: 2,
    pending: 0,
    downloaded: 2,
    reused: 0,
    skippedUnavailable: 0,
  });
  assert.equal(requests.get("/apn/A%20B"), 1);
  assert.equal(requests.get("/apn/RETRY"), 2);
  assert.equal(requests.get("/apn/MISSING"), 1);
  assert.equal(requests.get("/apn/BADTYPE"), 2);
  assert(maximumActive <= 2);
  assert.equal(userAgent, "Zugfolge APN local-test/1.0");
  const missing = first.index.entries.find((entry) => entry.rl100 === "MISSING");
  const badType = first.index.entries.find((entry) => entry.rl100 === "BADTYPE");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.reason, "not-found");
  assert.equal(missing.retryable, false);
  assert.equal(badType.reason, "invalid-content-type");
  assert.equal(badType.retryable, true);
  for (const entry of first.index.entries.filter((candidate) => candidate.status === "available")) {
    const stored = await readFile(join(evidenceRoot, entry.storedRelativePath));
    assert.equal(stored.length, entry.bytes);
    assert.equal(sha256(stored), entry.documentSha256);
  }

  const countsBeforeResume = new Map(requests);
  const second = await captureApnEvidence(options);
  assert.equal(second.summary.reused, 2);
  assert.equal(second.summary.skippedUnavailable, 1);
  assert.equal(requests.get("/apn/A%20B"), countsBeforeResume.get("/apn/A%20B"));
  assert.equal(requests.get("/apn/RETRY"), countsBeforeResume.get("/apn/RETRY"));
  assert.equal(requests.get("/apn/MISSING"), countsBeforeResume.get("/apn/MISSING"));
  assert.equal(requests.get("/apn/BADTYPE"), countsBeforeResume.get("/apn/BADTYPE") + 2);

  const analysis = await analyzeCapturedApnEvidence({ evidenceRoot, repositoryRoot: REPOSITORY_ROOT });
  assert.equal(analysis.summary.analyzed, 2);
  assert.equal(analysis.summary.unavailable, 2);
  assert(analysis.index.records.every((record) => record.receiptDraft.classAEligible === false));
  const repeated = await analyzeCapturedApnEvidence({ evidenceRoot, repositoryRoot: REPOSITORY_ROOT });
  assert.deepEqual(repeated.index, analysis.index);
});

test("Größenlimit und PDF-Magic werden vor Persistenz erzwungen", async (t) => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "zugfolge-apn-invalid-"));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const server = await localServer((request, response) => {
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/pdf");
    if (request.url === "/apn/LARGE") {
      response.setHeader("Content-Length", "9999");
      response.end("short");
      return;
    }
    if (request.url === "/apn/SLOW") {
      response.write("%PDF-");
      return new Promise((resolveDelay) => setTimeout(() => {
        response.end("1.4\n%%EOF\n");
        resolveDelay();
      }, 250));
    }
    response.end("not-a-pdf");
  });
  t.after(server.close);
  const result = await captureApnEvidence({
    catalog: catalog([
      { objectId: "station-large", rl100: "LARGE" },
      { objectId: "station-magic", rl100: "MAGIC" },
      { objectId: "station-slow", rl100: "SLOW" },
    ]),
    evidenceRoot,
    repositoryRoot: REPOSITORY_ROOT,
    baseUrl: server.baseUrl,
    policy: {
      concurrency: 1,
      delayMs: 0,
      maxAttempts: 1,
      initialBackoffMs: 0,
      maximumBackoffMs: 0,
      requestTimeoutMs: 100,
      maxBytes: 100,
      userAgent: "Zugfolge APN local-test/1.0",
    },
  });
  assert.deepEqual(result.index.entries
    .map((entry) => [entry.rl100, entry.status, entry.reason])
    .sort((left, right) => left[0].localeCompare(right[0], "en")), [
    ["LARGE", "unavailable", "size-limit"],
    ["MAGIC", "unavailable", "invalid-pdf-magic"],
    ["SLOW", "unavailable", "timeout"],
  ]);
});

test("Evidenzwurzel im Repository und mehr als zwei parallele Abrufe sind gesperrt", async () => {
  await assert.rejects(
    () => prepareExternalEvidenceRoot({ evidenceRoot: join(REPOSITORY_ROOT, "var", "forbidden-apn"), repositoryRoot: REPOSITORY_ROOT }),
    /nicht im Repository/,
  );
  assert.throws(() => normalizeApnPolicy({ concurrency: 3 }), /concurrency/);
});

test("atomarer Windows-Rename wiederholt nur enge transiente Sharing-Fehler", async () => {
  const delays = [];
  let attempts = 0;
  await renameWithTransientWindowsRetry("from", "to", {
    renameFile: async () => {
      attempts += 1;
      if (attempts <= 3) throw Object.assign(new Error("shared"), { code: ["EPERM", "EBUSY", "EACCES"][attempts - 1] });
    },
    wait: async (delay) => delays.push(delay),
  });
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [10, 20, 40]);

  let failFastAttempts = 0;
  await assert.rejects(
    () => renameWithTransientWindowsRetry("from", "to", {
      renameFile: async () => {
        failFastAttempts += 1;
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      wait: async () => assert.fail("Nichttransienter Fehler darf nicht warten."),
    }),
    /missing/,
  );
  assert.equal(failFastAttempts, 1);

  let exhaustedAttempts = 0;
  await assert.rejects(
    () => renameWithTransientWindowsRetry("from", "to", {
      maximumAttempts: 3,
      renameFile: async () => {
        exhaustedAttempts += 1;
        throw Object.assign(new Error("still shared"), { code: "EPERM" });
      },
      wait: async () => {},
    }),
    /still shared/,
  );
  assert.equal(exhaustedAttempts, 3);
});
