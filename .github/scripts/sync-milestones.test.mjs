import assert from "node:assert/strict";
import test from "node:test";

import {
  desiredMilestoneState,
  parseRoadmap,
  recordRoadmapIssueUpdate,
  renderMilestoneDescription,
  renderStatusDocument,
  roadmapIssueKey,
  shouldDiscoverRoadmapIssue,
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
  assert.deepEqual(roadmap.get("M1").rows, [{ key: "1.1", status: "in Arbeit" }]);
});

test("Roadmap-Issues tragen einen maschinenlesbaren Teilpunkt-Schluessel", () => {
  assert.equal(roadmapIssueKey("[Roadmap M3.10] Bildfahrplan"), "M3.10");
  assert.equal(roadmapIssueKey("[Roadmap 3.10] Bildfahrplan"), "M3.10");
  assert.equal(roadmapIssueKey("[Roadmap 6.3a] Vertragsoption"), "M6.3a");
  assert.equal(roadmapIssueKey("[Roadmap 10.3a] Fahrgastmanifest"), "M10.3a");
  assert.equal(roadmapIssueKey("[Roadmap 15.10] Polizeireaktion"), "M15.10");
  assert.equal(roadmapIssueKey("[Roadmap 15.12] Gesamtannahme"), "M15.12");
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
  assert.match(description, /nur, wenn alle Roadmap-Teilpunkte erledigt/);
});

test("Statusdokument trennt Kern, Integration, Betrieb und Abnahme", () => {
  const document = renderStatusDocument({ repository: "owner/repo", milestones: [milestone] });
  assert.match(document, /\| Milestone \| Kern \| Integration \| Betrieb \| Abnahme \|/);
  assert.match(document, /\| M0 \| nachgewiesen \| nachgewiesen \| nicht relevant \| nachgewiesen \| 0 \/ 1 \|/);
});
