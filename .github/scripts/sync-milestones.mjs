#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = path.join(ROOT, ".github/milestones.json");
const API_VERSION = "2022-11-28";
const STATUS_LABELS = {
  blocked: "blockiert",
  in_progress: "in Arbeit",
  not_applicable: "nicht relevant",
  not_started: "offen",
  verified: "nachgewiesen",
};

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function stripMarkdown(value) {
  return value.replaceAll("**", "").replaceAll("`", "").trim();
}

export function parseRoadmap(markdown) {
  const headingPattern = /^## (M\d+) — (.+)$/gm;
  const matches = [...markdown.matchAll(headingPattern)];
  const milestones = new Map();

  for (const [index, match] of matches.entries()) {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? markdown.length;
    const rows = markdown
      .slice(start, end)
      .split("\n")
      .filter((line) => /^\|\s*\d+\.\d+[a-z]?\s*\|/.test(line))
      .map((line) => {
        const cells = line
          .split("|")
          .slice(1, -1)
          .map(stripMarkdown);
        return { key: cells[0], status: cells.at(-1) };
      });

    milestones.set(match[1], {
      key: match[1],
      title: `${match[1]} — ${match[2].trim()}`,
      rows,
    });
  }

  return milestones;
}

function effectiveLabels(milestone, item) {
  return item.labels ?? [milestone.area, "type:delivery"];
}

export function validateManifest(manifest, roadmap) {
  invariant(manifest.version === 1, "milestones.json: version muss 1 sein");
  invariant(
    typeof manifest.repository === "string" && manifest.repository.includes("/"),
    "milestones.json: repository muss owner/name sein",
  );

  const expectedKeys = Array.from({ length: 16 }, (_, index) => `M${index}`);
  const actualKeys = manifest.milestones.map((milestone) => milestone.key);
  invariant(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `Milestones muessen exakt M0-M15 und sortiert sein; gefunden: ${actualKeys.join(", ")}`,
  );

  const labelNames = new Set();
  for (const label of manifest.labels) {
    invariant(!labelNames.has(label.name), `Doppeltes Label ${label.name}`);
    invariant(/^[0-9a-f]{6}$/i.test(label.color), `Ungueltige Farbe fuer ${label.name}`);
    labelNames.add(label.name);
  }

  const knownKeys = new Set(actualKeys);
  const assignedItems = new Map();
  for (const milestone of manifest.milestones) {
    const roadmapMilestone = roadmap.get(milestone.key);
    invariant(roadmapMilestone, `${milestone.key} fehlt in ${manifest.roadmap}`);
    invariant(
      roadmapMilestone.title === milestone.title,
      `${milestone.key}: Titel weicht ab: "${milestone.title}" != "${roadmapMilestone.title}"`,
    );
    invariant(labelNames.has(milestone.area), `${milestone.key}: unbekanntes Area-Label ${milestone.area}`);

    for (const dependency of milestone.dependsOn) {
      invariant(knownKeys.has(dependency), `${milestone.key}: unbekannte Abhaengigkeit ${dependency}`);
      invariant(dependency !== milestone.key, `${milestone.key}: darf nicht von sich selbst abhaengen`);
    }

    for (const dimension of ["core", "integration", "operations", "acceptance"]) {
      invariant(
        STATUS_LABELS[milestone.status[dimension]],
        `${milestone.key}: ungueltiger Status fuer ${dimension}`,
      );
    }

    for (const item of milestone.items) {
      invariant(Number.isInteger(item.number) && item.number > 0, `${milestone.key}: ungueltige Item-Nummer`);
      invariant(
        item.kind === "issue" || item.kind === "pull_request",
        `${milestone.key}/#${item.number}: kind muss issue oder pull_request sein`,
      );
      invariant(!assignedItems.has(item.number), `#${item.number} ist ${assignedItems.get(item.number)} und ${milestone.key} zugeordnet`);
      assignedItems.set(item.number, milestone.key);

      const labels = effectiveLabels(milestone, item);
      for (const label of labels) {
        invariant(labelNames.has(label), `${milestone.key}/#${item.number}: unbekanntes Label ${label}`);
      }
      invariant(labels.some((label) => label.startsWith("area:")), `${milestone.key}/#${item.number}: Area-Label fehlt`);
      invariant(labels.some((label) => label.startsWith("type:")), `${milestone.key}/#${item.number}: Type-Label fehlt`);
      if (item.kind === "issue") {
        invariant(
          labels.some((label) => label.startsWith("priority:")),
          `${milestone.key}/#${item.number}: Priority-Label fehlt`,
        );
      }
    }
  }

  return assignedItems;
}

function repositoryUrl(repository, relativePath) {
  return `https://github.com/${repository}/blob/main/${relativePath}`;
}

export function renderMilestoneDescription(manifest, milestone) {
  const dependencies = milestone.dependsOn.length ? milestone.dependsOn.join(", ") : "keine";
  const evidence = milestone.evidence.length
    ? milestone.evidence
        .map((entry) => `- [${entry.label}](${repositoryUrl(manifest.repository, entry.url)})`)
        .join("\n")
    : "- Noch kein Abnahmebeleg hinterlegt.";

  return [
    `**Ziel:** ${milestone.goal}`,
    "",
    "**Reifegrad**",
    `- Kern implementiert: ${STATUS_LABELS[milestone.status.core]}`,
    `- Integriert: ${STATUS_LABELS[milestone.status.integration]}`,
    `- Produktionsreif: ${STATUS_LABELS[milestone.status.operations]}`,
    `- Abgenommen: ${STATUS_LABELS[milestone.status.acceptance]}`,
    "",
    `**Abhaengigkeiten:** ${dependencies}`,
    "",
    "**Nachweise**",
    evidence,
    "",
    `[Kanonische Roadmap](${repositoryUrl(manifest.repository, manifest.roadmap)})`,
    "",
    "Der Synchronisierer schliesst diesen Milestone nur, wenn alle Roadmap-Teilpunkte erledigt, alle zugeordneten Issues/PRs geschlossen und Nachweise hinterlegt sind.",
  ].join("\n");
}

export function renderStatusDocument(manifest) {
  const rows = manifest.milestones.map((milestone) => {
    const issueCount = milestone.items.filter((item) => item.kind === "issue").length;
    const prCount = milestone.items.filter((item) => item.kind === "pull_request").length;
    const dependencies = milestone.dependsOn.length ? milestone.dependsOn.join(", ") : "—";
    return `| ${milestone.key} | ${STATUS_LABELS[milestone.status.core]} | ${STATUS_LABELS[milestone.status.integration]} | ${STATUS_LABELS[milestone.status.operations]} | ${STATUS_LABELS[milestone.status.acceptance]} | ${issueCount} / ${prCount} | ${dependencies} |`;
  });

  return [
    "# Roadmap-Status",
    "",
    "<!-- Automatisch aus .github/milestones.json erzeugt. Nicht von Hand bearbeiten. -->",
    "",
    "Diese Matrix trennt vorhandenen Kerncode, Integration, Produktionsreife und formale Abnahme.",
    "Die GitHub-Milestones und ihre Issue-/PR-Zuordnung werden durch",
    "`.github/workflows/milestones.yml` idempotent aus derselben Quelle synchronisiert.",
    "Die Roadmap ist absichtlich abhaengigkeitsbasiert; deshalb werden keine kuenstlichen",
    "Kalendertermine gesetzt.",
    "",
    "| Milestone | Kern | Integration | Betrieb | Abnahme | Issues / PRs | Abhaengigkeiten |",
    "|---|---|---|---|---|---:|---|",
    ...rows,
    "",
    "Ein GitHub-Milestone wird nur geschlossen, wenn alle drei maschinell pruefbaren",
    "Bedingungen gelten: Jeder Roadmap-Teilpunkt steht auf `erledigt`, jedes zugeordnete",
    "Issue beziehungsweise jeder PR ist geschlossen, und mindestens ein reproduzierbarer",
    "Nachweis ist in `.github/milestones.json` hinterlegt. Leere Zukunfts-Milestones",
    "bleiben offen.",
    "",
    `GitHub-Ansicht: https://github.com/${manifest.repository}/milestones`,
    "",
  ].join("\n");
}

function roadmapIsComplete(roadmapMilestone) {
  return (
    roadmapMilestone.rows.length > 0 &&
    roadmapMilestone.rows.every((row) => row.status === "erledigt")
  );
}

export function desiredMilestoneState(milestone, roadmapMilestone, items) {
  const itemsComplete =
    milestone.items.length > 0 && milestone.items.every((item) => {
      const remote = items.get(item.number);
      if (remote?.state !== "closed") return false;
      if (item.kind !== "pull_request") return true;
      return Boolean(remote.merged_at ?? remote.pull_request?.merged_at);
    });
  const hasEvidence = milestone.evidence.length > 0;
  return roadmapIsComplete(roadmapMilestone) && itemsComplete && hasEvidence ? "closed" : "open";
}

class GitHubClient {
  constructor(repository, token) {
    this.repository = repository;
    this.token = token;
    this.basePath = `/repos/${repository}`;
  }

  async request(apiPath, options = {}) {
    const response = await fetch(`https://api.github.com${apiPath}`, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "zugfolge-milestone-sync",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1000);
      throw new Error(`${options.method ?? "GET"} ${apiPath}: ${response.status} ${detail}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async list(apiPath) {
    const result = [];
    for (let page = 1; ; page += 1) {
      const separator = apiPath.includes("?") ? "&" : "?";
      const values = await this.request(`${apiPath}${separator}per_page=100&page=${page}`);
      result.push(...values);
      if (values.length < 100) return result;
    }
  }
}

async function mapLimit(values, limit, callback) {
  const result = new Array(values.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      result[index] = await callback(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return result;
}

function milestoneForKey(remoteMilestones, key) {
  const matches = remoteMilestones.filter(
    (milestone) => milestone.title === key || milestone.title.startsWith(`${key} —`),
  );
  invariant(matches.length <= 1, `GitHub enthaelt mehrere Milestones fuer ${key}`);
  return matches[0];
}

async function loadRemoteItems(client, manifest) {
  const definitions = manifest.milestones.flatMap((milestone) => milestone.items);
  const records = await mapLimit(definitions, 8, async (definition) => {
    const item = await client.request(`${client.basePath}/issues/${definition.number}`);
    const actualKind = item.pull_request ? "pull_request" : "issue";
    invariant(
      actualKind === definition.kind,
      `#${definition.number}: Manifest erwartet ${definition.kind}, GitHub liefert ${actualKind}`,
    );
    return item;
  });
  return new Map(records.map((item) => [item.number, item]));
}

export function roadmapIssueKey(title) {
  const match = /^\[Roadmap M?(\d+\.\d+[a-z]?)\]/.exec(title ?? "");
  return match ? `M${match[1]}` : null;
}

export function recordRoadmapIssueUpdate(discovered, remote) {
  discovered.remote = remote;
}

export function shouldDiscoverRoadmapIssue(item, roadmap, explicitlyAssignedNumbers = new Set()) {
  if (explicitlyAssignedNumbers.has(item.number)) return false;
  const key = roadmapIssueKey(item.title);
  return Boolean(key && roadmap.get(key.split(".")[0])?.rows.some((row) => row.key === key.slice(1)));
}

async function loadRoadmapIssues(client, roadmap, explicitlyAssignedNumbers) {
  const remote = await client.list(`${client.basePath}/issues?state=all`);
  const result = [];
  for (const item of remote) {
    if (!shouldDiscoverRoadmapIssue(item, roadmap, explicitlyAssignedNumbers)) continue;
    const key = roadmapIssueKey(item.title);
    result.push({ number: item.number, kind: item.pull_request ? "pull_request" : "issue", key, remote: item });
  }
  return result;
}

async function ensureLabels(client, manifest, apply) {
  const remote = await client.list(`${client.basePath}/labels`);
  const byName = new Map(remote.map((label) => [label.name, label]));
  const errors = [];

  for (const label of manifest.labels) {
    const current = byName.get(label.name);
    if (!current) {
      if (!apply) {
        errors.push(`Label ${label.name} fehlt`);
        continue;
      }
      const created = await client.request(`${client.basePath}/labels`, {
        method: "POST",
        body: label,
      });
      byName.set(label.name, created);
      continue;
    }
    if (current.color.toLowerCase() !== label.color.toLowerCase() || current.description !== label.description) {
      if (!apply) {
        errors.push(`Label ${label.name} weicht von der Manifest-Definition ab`);
        continue;
      }
      await client.request(`${client.basePath}/labels/${encodeURIComponent(label.name)}`, {
        method: "PATCH",
        body: { color: label.color, description: label.description },
      });
    }
  }
  return errors;
}

async function ensureMilestones(client, manifest, apply) {
  const remote = await client.list(`${client.basePath}/milestones?state=all`);
  const byKey = new Map();
  const errors = [];

  for (const milestone of manifest.milestones) {
    const description = renderMilestoneDescription(manifest, milestone);
    let current = milestoneForKey(remote, milestone.key);
    if (!current) {
      if (!apply) {
        errors.push(`Milestone ${milestone.key} fehlt`);
        continue;
      }
      current = await client.request(`${client.basePath}/milestones`, {
        method: "POST",
        body: { title: milestone.title, description, state: "open" },
      });
      remote.push(current);
    } else if (current.title !== milestone.title || current.description !== description) {
      if (!apply) {
        errors.push(`Milestone ${milestone.key}: Titel, Beschreibung oder Termin weicht ab`);
      } else {
        current = await client.request(`${client.basePath}/milestones/${current.number}`, {
          method: "PATCH",
          body: { title: milestone.title, description },
        });
      }
    }
    byKey.set(milestone.key, current);
  }
  return { byKey, errors };
}

async function synchronizeRemote(manifest, roadmap, apply) {
  const token = process.env.GITHUB_TOKEN;
  invariant(token, "GITHUB_TOKEN fehlt");
  invariant(
    !process.env.GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY === manifest.repository,
    `Workflow laeuft fuer ${process.env.GITHUB_REPOSITORY}, Manifest gilt fuer ${manifest.repository}`,
  );
  const client = new GitHubClient(manifest.repository, token);
  const errors = await ensureLabels(client, manifest, apply);
  const milestoneResult = await ensureMilestones(client, manifest, apply);
  errors.push(...milestoneResult.errors);

  if (milestoneResult.byKey.size !== manifest.milestones.length) {
    if (!apply) throw new Error(errors.join("\n"));
    throw new Error("Nicht alle Milestones konnten angelegt werden");
  }

  const items = await loadRemoteItems(client, manifest);
  const explicitlyAssignedNumbers = new Set(
    manifest.milestones.flatMap((milestone) => milestone.items.map((item) => item.number)),
  );
  const roadmapIssues = await loadRoadmapIssues(client, roadmap, explicitlyAssignedNumbers);
  for (const discovered of roadmapIssues) {
    const row = roadmap.get(discovered.key.split(".")[0]).rows.find((candidate) => candidate.key === discovered.key.slice(1));
    const remoteMilestone = milestoneResult.byKey.get(discovered.key.split(".")[0]);
    const item = discovered.remote;
    if (item.milestone?.number !== remoteMilestone.number) {
      if (!apply) errors.push(`#${item.number}: Roadmap-Teilpunkt ${discovered.key} ist nicht dem passenden Milestone zugeordnet`);
      else await client.request(`${client.basePath}/issues/${item.number}`, { method: "PATCH", body: { milestone: remoteMilestone.number } });
    }
    if (row.status === "erledigt" && item.state !== "closed") {
      if (!apply) errors.push(`#${item.number}: Roadmap-Teilpunkt ${discovered.key} muss geschlossen werden`);
      else {
        recordRoadmapIssueUpdate(
          discovered,
          await client.request(`${client.basePath}/issues/${item.number}`, {
            method: "PATCH",
            body: { state: "closed", state_reason: "completed" },
          }),
        );
      }
    }
  }
  for (const milestone of manifest.milestones) {
    const remoteMilestone = milestoneResult.byKey.get(milestone.key);
    for (const definition of milestone.items) {
      const item = items.get(definition.number);
      const expectedLabels = effectiveLabels(milestone, definition);
      const currentLabels = new Set(item.labels.map((label) => label.name));
      const missingLabels = expectedLabels.filter((label) => !currentLabels.has(label));
      if (item.milestone?.number !== remoteMilestone.number) {
        if (!apply) errors.push(`#${item.number}: Milestone ist nicht ${milestone.key}`);
        else {
          await client.request(`${client.basePath}/issues/${item.number}`, {
            method: "PATCH",
            body: { milestone: remoteMilestone.number },
          });
        }
      }
      if (missingLabels.length) {
        if (!apply) errors.push(`#${item.number}: Labels fehlen: ${missingLabels.join(", ")}`);
        else {
          await client.request(`${client.basePath}/issues/${item.number}/labels`, {
            method: "POST",
            body: { labels: missingLabels },
          });
        }
      }
    }

    const discoveredForMilestone = roadmapIssues.filter((item) => item.key.startsWith(`${milestone.key}.`));
    const stateItems = new Map(items);
    for (const discovered of discoveredForMilestone) stateItems.set(discovered.number, discovered.remote);
    const desiredState = desiredMilestoneState({ ...milestone, items: [...milestone.items, ...discoveredForMilestone] }, roadmap.get(milestone.key), stateItems);
    if (remoteMilestone.state !== desiredState) {
      if (!apply) errors.push(`${milestone.key}: GitHub-Status ${remoteMilestone.state}, erwartet ${desiredState}`);
      else {
        await client.request(`${client.basePath}/milestones/${remoteMilestone.number}`, {
          method: "PATCH",
          body: { state: desiredState },
        });
      }
    }
  }

  if (errors.length) throw new Error(errors.join("\n"));
}

async function loadLocal() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const roadmapPath = path.join(ROOT, manifest.roadmap);
  const roadmapText = await readFile(roadmapPath, "utf8");
  const roadmap = parseRoadmap(roadmapText);
  validateManifest(manifest, roadmap);
  return { manifest, roadmap };
}

async function main() {
  const mode = process.argv[2] ?? "check";
  const { manifest, roadmap } = await loadLocal();
  const statusPath = path.join(ROOT, manifest.generatedStatus);
  const generated = renderStatusDocument(manifest);

  if (mode === "render" || mode === "update") {
    await writeFile(statusPath, generated, "utf8");
    console.log(`Aktualisiert: ${manifest.generatedStatus}`);
    return;
  }
  if (mode === "check") {
    const current = await readFile(statusPath, "utf8");
    invariant(current === generated, `${manifest.generatedStatus} ist nicht aus .github/milestones.json aktualisiert`);
    console.log(`M0-M15, ${manifest.milestones.flatMap((entry) => entry.items).length} Arbeitspakete und Statusmatrix sind konsistent.`);
    return;
  }
  if (mode === "apply") {
    await synchronizeRemote(manifest, roadmap, true);
    console.log("GitHub-Milestones, Labels und Zuordnungen wurden synchronisiert.");
    return;
  }
  if (mode === "check-remote") {
    await synchronizeRemote(manifest, roadmap, false);
    console.log("GitHub-Milestones, Labels und Zuordnungen entsprechen dem Manifest.");
    return;
  }
  throw new Error(`Unbekannter Modus: ${mode}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
