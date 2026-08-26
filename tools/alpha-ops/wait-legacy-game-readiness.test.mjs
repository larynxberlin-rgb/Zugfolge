import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_REVISION_BASELINE_SCHEMA,
  inspectLegacyRevisionHead,
  validateLegacyRevisionBaseline,
  waitForLegacyGameReadiness,
} from "./wait-legacy-game-readiness.mjs";

const worldId = "00000000-0000-4000-8000-000000000041";
const baseline = Object.freeze({
  schema: LEGACY_REVISION_BASELINE_SCHEMA,
  regionCount: "2",
  regionIds: ["de-sn-leipzig", "de-st-halle"],
  revisionTotal: "41",
  worldId,
});

test("Legacy-Readiness filtert SQL strikt auf die attestierte Welt und bindet deren exakte Regionsmenge", async () => {
  const matching = await inspectLegacyRevisionHead({
    unsafe: async (query, parameters) => {
      assert.match(query, /where world_id = \$1::uuid[\s\S]*order by region_id/u);
      assert.deepEqual(parameters, [worldId]);
      return [
        { region_id: "de-sn-leipzig", revision: "20", publisher_sequence: "20" },
        { region_id: "de-st-halle", revision: "21", publisher_sequence: "21" },
      ];
    },
  }, worldId);
  assert.deepEqual(matching, baseline);

  await assert.rejects(
    inspectLegacyRevisionHead({
      unsafe: async () => [{ region_id: "de-sn-leipzig", revision: "42", publisher_sequence: "41" }],
    }, worldId),
    /Publishersequenz-Luecke/u,
  );
  await assert.rejects(
    inspectLegacyRevisionHead({
      unsafe: async () => [],
    }, worldId),
    /keine Region fuer die attestierte Welt/u,
  );
});

test("Legacy-Start ist erst nach Readiness und einer neuen Revision erfolgreich", async () => {
  let nowMs = 0;
  let readinessCalls = 0;
  const heads = [baseline, baseline, { ...baseline, revisionTotal: "42" }];
  const result = await waitForLegacyGameReadiness({
    baseUrl: "http://game-api:3000",
    baseline,
    maximumWaitMs: 30_000,
    pollIntervalMs: 1_000,
    readinessWait: async ({ baseUrl }) => {
      assert.equal(baseUrl, "http://game-api:3000");
      readinessCalls += 1;
    },
    inspectRevisionHead: async () => heads.shift(),
    worldId,
    now: () => nowMs,
    sleep: async (durationMs) => { nowMs += durationMs; },
  });
  assert.equal(result.revisionTotal, "42");
  assert.equal(readinessCalls, 3);
});

test("Legacy-Start verwirft Regionswechsel, stagnierende Revision und fremde Baseline", async () => {
  await assert.rejects(
    waitForLegacyGameReadiness({
      baseUrl: "http://game-api:3000",
      baseline,
      maximumWaitMs: 10,
      pollIntervalMs: 10,
      readinessWait: async () => undefined,
      inspectRevisionHead: async () => baseline,
      worldId,
      now: (() => {
        let atMs = 0;
        return () => atMs++ === 0 ? 0 : 10;
      })(),
      sleep: async () => undefined,
    }),
    /keine neue autoritative Revision/u,
  );
  await assert.rejects(
    waitForLegacyGameReadiness({
      baseUrl: "http://game-api:3000",
      baseline,
      readinessWait: async () => undefined,
      inspectRevisionHead: async () => ({ ...baseline, regionCount: "3", revisionTotal: "42" }),
      worldId,
    }),
    /Regionszahl und Regionsmenge|exakte Menge autoritativer Regionen/u,
  );
  assert.throws(
    () => validateLegacyRevisionBaseline({ ...baseline, extra: true }),
    /unbekannte oder fehlende Felder/u,
  );
});

test("Fremdwelt-Fortschritt kann den Legacy-Start nicht freigeben; erst die Zielwelt zaehlt", async () => {
  const foreignWorldId = "00000000-0000-4000-8000-000000000099";
  const revisions = new Map([
    [worldId, [20n, 21n]],
    [foreignWorldId, [500n]],
  ]);
  const sql = {
    unsafe: async (_query, [requestedWorldId]) => revisions.get(requestedWorldId).map((revision, index) => ({
      region_id: requestedWorldId === worldId ? baseline.regionIds[index] : "foreign-region",
      revision: revision.toString(),
      publisher_sequence: revision.toString(),
    })),
  };
  let nowMs = 0;
  await assert.rejects(
    waitForLegacyGameReadiness({
      baseUrl: "http://game-api:3000",
      baseline,
      maximumWaitMs: 10,
      pollIntervalMs: 10,
      readinessWait: async () => undefined,
      inspectRevisionHead: (requestedWorldId) => inspectLegacyRevisionHead(sql, requestedWorldId),
      worldId,
      now: () => nowMs,
      sleep: async (durationMs) => {
        revisions.set(foreignWorldId, [revisions.get(foreignWorldId)[0] + 1n]);
        nowMs += durationMs;
      },
    }),
    /keine neue autoritative Revision/u,
  );

  revisions.set(worldId, [21n, 21n]);
  nowMs = 0;
  const ready = await waitForLegacyGameReadiness({
    baseUrl: "http://game-api:3000",
    baseline,
    maximumWaitMs: 10,
    pollIntervalMs: 10,
    readinessWait: async () => undefined,
    inspectRevisionHead: (requestedWorldId) => inspectLegacyRevisionHead(sql, requestedWorldId),
    worldId,
    now: () => nowMs,
    sleep: async (durationMs) => { nowMs += durationMs; },
  });
  assert.equal(ready.revisionTotal, "42");
  assert.equal(ready.worldId, worldId);
});
