import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalRoadmapIssueTitle,
  desiredMilestoneState,
  parseRoadmap,
  recordRoadmapIssueUpdate,
  renderMilestoneDescription,
  renderRoadmapIssueBlock,
  renderStatusDocument,
  roadmapIssueContentPatch,
  roadmapIssueKey,
  shouldDiscoverRoadmapIssue,
  upsertRoadmapIssueBlock,
  validateManifest,
} from "./sync-milestones.mjs";

const roadmap = parseRoadmap(`
## M0 — Fundament

| # | Teilabschnitt | Groesse | Status |
|---|---|---|---|
| 0.1 | Beweis | S | erledigt |

## M1 — Ausbau

| # | Teilabschnitt | Groesse | Status |
|---|---|---|---|
| 1.1 | Offen | M | in Arbeit |
`);

const milestone = {
  key: "M0",
  title: "M0 — Fundament",
  goal: "Nachweisbar tragen.",
  area: "area:ci",
  dependsOn: [],
  status: {
    core: "verified",
    integration: "verified",
    operations: "not_applicable",
    acceptance: "verified",
  },
  evidence: [{ label: "Beleg", url: "docs/milestones.md" }],
  items: [{ number: 1, kind: "pull_request" }],
};

test("Roadmap-Parser liest Titel und Statuszeilen", () => {
  assert.equal(roadmap.get("M0").title, "M0 — Fundament");
  assert.deepEqual(roadmap.get("M1").rows, [
    { key: "1.1", title: "Offen", status: "in Arbeit" },
  ]);
});

test("Roadmap-Issues tragen einen maschinenlesbaren Teilpunkt-Schluessel", () => {
  assert.equal(roadmapIssueKey("[Roadmap M3.10] Bildfahrplan"), "M3.10");
  assert.equal(roadmapIssueKey("[Roadmap 3.10] Bildfahrplan"), "M3.10");
  assert.equal(roadmapIssueKey("[Roadmap 6.3a] Vertragsoption"), "M6.3a");
  assert.equal(roadmapIssueKey("[Roadmap 10.3a] Fahrgastmanifest"), "M10.3a");
  assert.equal(roadmapIssueKey("[Roadmap 15.10] Polizeireaktion"), "M15.10");
  assert.equal(roadmapIssueKey("[Roadmap 15.12] Gesamtannahme"), "M15.12");
  assert.equal(
    roadmapIssueKey(
      "Titel versehentlich geändert",
      "<!-- zugfolge-roadmap-sync:start -->\n- Teilpunkt: `M9.3` — Onboarding",
    ),
    "M9.3",
  );
  assert.equal(roadmapIssueKey("[Livemap] anderer Befund"), null);
});

test("Explizite Manifest-Zuordnung hat Vorrang vor Roadmap-Titelautomatik", () => {
  const item = { number: 192, title: "[Roadmap 14.1] Vorgezogener Alpha-Teil" };
  const titleRoadmap = new Map([
    ["M14", { rows: [{ key: "14.1", status: "erledigt" }] }],
  ]);

  assert.equal(shouldDiscoverRoadmapIssue(item, titleRoadmap), true);
  assert.equal(shouldDiscoverRoadmapIssue(item, titleRoadmap, new Set([192])), false);
});

test("Manifest akzeptiert exakt die sortierte Roadmap M0 bis M15", () => {
  const milestones = Array.from({ length: 16 }, (_, index) => ({
    key: `M${index}`,
    title: `M${index} — Teil ${index}`,
    goal: "Testziel.",
    area: "area:roadmap",
    dependsOn: index === 0 ? [] : [`M${index - 1}`],
    status: {
      core: "not_started",
      integration: "not_started",
      operations: "not_started",
      acceptance: "not_started",
    },
    evidence: [],
    items: [],
  }));
  const manifestRoadmap = new Map(
    milestones.map((entry) => [entry.key, { key: entry.key, title: entry.title, rows: [] }]),
  );
  const manifest = {
    version: 1,
    repository: "owner/repo",
    roadmap: "docs/milestones.md",
    labels: [{ name: "area:roadmap", color: "5319e7", description: "Roadmap" }],
    milestones,
  };

  assert.doesNotThrow(() => validateManifest(manifest, manifestRoadmap));
  assert.throws(
    () => validateManifest({ ...manifest, milestones: milestones.slice(0, 15) }, manifestRoadmap),
    /M0-M15/,
  );
  const cyclic = milestones.map((entry) => ({ ...entry, dependsOn: [...entry.dependsOn] }));
  cyclic[0].dependsOn = ["M15"];
  assert.throws(
    () => validateManifest({ ...manifest, milestones: cyclic }, manifestRoadmap),
    /Abhaengigkeitszyklus: .*M0/,
  );
});

test("E24-Schnitt, Manifest-alphaScope und Roadmap-DAG bleiben identisch und azyklisch", () => {
  const milestones = Array.from({ length: 16 }, (_, index) => ({
    key: `M${index}`,
    title: `M${index} — Teil ${index}`,
    goal: "Testziel.", area: "area:roadmap", dependsOn: [],
    status: { core: "not_started", integration: "not_started", operations: "not_started", acceptance: "not_started" },
    evidence: [], items: [],
  }));
  const scope = {
    decision: "E24", adr: "docs/adr/0024.md", regionVariant: "B",
    pulledForward: [{ item: "M14.1", status: "verified", dependsOn: ["M9.2"] }],
    acceptanceDependsOn: [{ item: "M9.9", dependsOn: ["M14.1"] }],
    excluded: ["M14.2"],
  };
  milestones[9].alphaScope = scope;
  const manifestRoadmap = new Map(milestones.map((entry) => [entry.key, {
    key: entry.key, title: entry.title,
    rows: entry.key === "M9" ? [{ key: "9.2" }, { key: "9.9" }] : entry.key === "M14" ? [{ key: "14.1" }] : [],
  }]));
  const manifest = {
    version: 1, repository: "owner/repo", roadmap: "docs/milestones.md",
    labels: [{ name: "area:roadmap", color: "5319e7", description: "Roadmap" }], milestones,
  };
  const adr = `<!-- zugfolge-alpha-scope:start\n${JSON.stringify({
    decision: "E24", regionVariant: "B",
    pulledForward: [{ item: "M14.1", dependsOn: ["M9.2"] }],
    acceptanceDependsOn: [{ item: "M9.9", dependsOn: ["M14.1"] }], excluded: ["M14.2"],
  })}\nzugfolge-alpha-scope:end -->`;
  const roadmapContract = `<!-- zugfolge-alpha-dag:start\n${JSON.stringify({ "M14.1": ["M9.2"], "M9.9": ["M14.1"] })}\nzugfolge-alpha-dag:end -->`;

  assert.doesNotThrow(() => validateManifest(manifest, manifestRoadmap, adr, roadmapContract));
  assert.throws(
    () => validateManifest(manifest, manifestRoadmap, adr.replace('"M9.2"', '"M9.9"'), roadmapContract),
    /ADR-Schnitt und Manifest-alphaScope/,
  );
});

test("Geschlossene Roadmap-Issues wirken im selben Sync-Lauf auf den Milestone", () => {
  const discovered = { remote: { number: 84, state: "open" } };
  recordRoadmapIssueUpdate(discovered, { number: 84, state: "closed" });
  assert.deepEqual(discovered.remote, { number: 84, state: "closed" });
  assert.equal(
    desiredMilestoneState(
      { ...milestone, items: [{ number: 84, kind: "issue" }] },
      roadmap.get("M0"),
      new Map([[84, discovered.remote]]),
    ),
    "closed",
  );
});

test("Milestone schliesst nur bei erledigter Roadmap, geschlossenen Items und Beleg", () => {
  assert.equal(
    desiredMilestoneState(milestone, roadmap.get("M0"), new Map([[1, { state: "closed", merged_at: "2026-08-11T00:00:00Z" }]])),
    "closed",
  );
  assert.equal(
    desiredMilestoneState(milestone, roadmap.get("M0"), new Map([[1, { state: "open", merged_at: null }]])),
    "open",
  );
  assert.equal(
    desiredMilestoneState(milestone, roadmap.get("M0"), new Map([[1, { state: "closed", merged_at: null }]])),
    "open",
  );
  assert.equal(
    desiredMilestoneState({ ...milestone, evidence: [] }, roadmap.get("M0"), new Map([[1, { state: "closed" }]])),
    "open",
  );
  assert.equal(
    desiredMilestoneState({ ...milestone, key: "M1" }, roadmap.get("M1"), new Map([[1, { state: "closed" }]])),
    "open",
  );
  assert.equal(
    desiredMilestoneState(
      { ...milestone, status: { ...milestone.status, operations: "blocked" } },
      roadmap.get("M0"),
      new Map([[1, { state: "closed", merged_at: "2026-08-11T00:00:00Z" }]]),
    ),
    "open",
  );
});

test("Leere Zukunfts-Milestones werden nicht versehentlich geschlossen", () => {
  assert.equal(
    desiredMilestoneState({ ...milestone, items: [] }, roadmap.get("M0"), new Map()),
    "open",
  );
});

test("GitHub-Beschreibung weist Reifegrad, Beleg und Schliess-Gate aus", () => {
  const manifest = { repository: "owner/repo", roadmap: "docs/milestones.md" };
  const description = renderMilestoneDescription(manifest, milestone);
  assert.match(description, /Kern implementiert: nachgewiesen/);
  assert.match(description, /blob\/main\/docs\/milestones\.md/);
  assert.match(description, /nur, wenn alle vier Reifegrade nachgewiesen/);
});

test("Statusdokument zählt explizite und automatisch erkannte Issues gemeinsam, auch fuer M7/M11", () => {
  const document = renderStatusDocument({ repository: "owner/repo", milestones: [
    { ...milestone, key: "M7", items: [] },
    { ...milestone, key: "M11", items: [{ number: 7, kind: "issue" }] },
  ] }, new Map([
    ["M7", { rows: [{ key: "7.1" }, { key: "7.2" }] }],
    ["M11", { rows: [{ key: "11.1" }, { key: "11.2" }] }],
  ]));
  assert.match(document, /\| Milestone \| Kern \| Integration \| Betrieb \| Abnahme \|/);
  assert.match(document, /\| M7 \| nachgewiesen \| nachgewiesen \| nicht relevant \| nachgewiesen \| 2 \/ 0 \|/);
  assert.match(document, /\| M11 \| nachgewiesen \| nachgewiesen \| nicht relevant \| nachgewiesen \| 3 \/ 0 \|/);
  assert.match(document, /explizite Manifestzuordnungen/);
});

test("Roadmap-Issue-Titel und verwalteter Body-Block folgen deterministisch der Roadmap", () => {
  const row = { key: "1.1", title: "Beweis führen", status: "in Arbeit" };
  const manifest = { repository: "owner/repo", roadmap: "docs/milestones.md" };
  const managed = renderRoadmapIssueBlock(manifest, { key: "M1" }, "M1.1", row);
  const first = upsertRoadmapIssueBlock("Spielernotiz bleibt.", managed);
  const changed = renderRoadmapIssueBlock(
    manifest,
    { key: "M1" },
    "M1.1",
    { ...row, status: "erledigt" },
  );
  const second = upsertRoadmapIssueBlock(first, changed);

  assert.equal(canonicalRoadmapIssueTitle("M1.1", row), "[Roadmap 1.1] Beweis führen");
  assert.match(second, /^Spielernotiz bleibt\./);
  assert.match(second, /Roadmap-Status: `erledigt`/);
  assert.equal(second.match(/zugfolge-roadmap-sync:start/g)?.length, 1);
});

test("#161-artiger Titel- und Body-Drift erzeugt im Check einen kanonischen Patch", () => {
  const row = { key: "9.3", title: "Onboarding", status: "in Arbeit" };
  const patch = roadmapIssueContentPatch(
    { repository: "owner/repo", roadmap: "docs/milestones.md" },
    { key: "M9" },
    "M9.3",
    row,
    { number: 161, title: "Veralteter Titel", body: "Menschliche Notiz." },
  );
  assert.equal(patch.title, "[Roadmap 9.3] Onboarding");
  assert.match(patch.body, /^Menschliche Notiz\./);
  assert.match(patch.body, /Teilpunkt: `M9\.3`/);
});
