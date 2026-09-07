import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const reports = [
  ["browser-report.json", "conductor-session-browser-proof/v1"],
  ["scene-browser-report.json", "conductor-session-scene-browser-proof/v1"],
  ["control-browser-report.json", "conductor-control-browser-proof/v1"],
  ["capacity-browser-report.json", "conductor-session-capacity-browser-proof/v1"],
  ["manifest-browser-report.json", "conductor-manifest-browser-proof/v1"],
  ["acceptance-browser-report.json", "conductor-acceptance-browser-proof/v1"],
  ["entry-browser-report.json", "conductor-entry-browser-proof/v1"],
];
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function require(value, message) { if (!value) throw new Error(message); }

/** Binds actual artifacts; a local test bundle is never a productive release signature. */
export async function packageConductorEvidence({ root, revision, ciRunUrl = null }) {
  require(/^[a-f0-9]{40}$/u.test(revision), "An exact Git revision is required.");
  require(ciRunUrl === null || /^https:\/\/github\.com\/larynxberlin-rgb\/Zugfolge\/actions\/runs\/[1-9][0-9]*$/u.test(ciRunUrl), "Invalid CI run URL.");
  const directory = await realpath(root), files = [], proofs = [], seen = new Set();
  const read = async (name, limit) => {
    const path = resolve(directory, name), scope = relative(directory, path);
    require(scope !== ".." && !scope.startsWith(`..${sep}`), "Artifact escapes evidence directory.");
    const info = await lstat(path);
    require(info.isFile() && !info.isSymbolicLink() && info.size <= limit, `Invalid or oversized artifact: ${name}`);
    require(await realpath(path) === path, `Artifact traverses an untrusted link: ${name}`);
    return readFile(path);
  };
  for (const [file, schema] of reports) {
    const bytes = await read(file, 16 * 1024 * 1024), report = JSON.parse(bytes.toString("utf8"));
    require(report.schemaVersion === schema && Array.isArray(report.pageErrors) && report.pageErrors.length === 0, `Unsuccessful browser report: ${file}`);
    require(typeof report.evidence?.worldId === "string" && typeof report.evidence?.trainRunId === "string", `Missing world/train binding: ${file}`);
    require(Array.isArray(report.screenshots) && report.screenshots.length > 0, `Missing browser images: ${file}`);
    const images = [];
    for (const image of report.screenshots) {
      require(typeof image.file === "string" && /^[a-z0-9-]+\.png$/u.test(image.file) && /^[a-f0-9]{64}$/u.test(image.sha256), "Invalid image reference.");
      const name = `screenshots/${image.file}`, data = await read(name, 64 * 1024 * 1024);
      require(data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && sha(data) === image.sha256, `Image hash mismatch: ${name}`);
      if (!seen.has(name)) { seen.add(name); files.push({ file: name, bytes: data.length, sha256: image.sha256 }); }
      images.push(name);
    }
    files.push({ file, bytes: bytes.length, sha256: sha(bytes) });
    proofs.push({ report: file, worldId: report.evidence.worldId, trainRunId: report.evidence.trainRunId, images });
  }
  const dialogueFile = "dialogue-http-report.json", dialogueBytes = await read(dialogueFile, 16 * 1024 * 1024);
  const dialogue = JSON.parse(dialogueBytes.toString("utf8"));
  require(dialogue.schemaVersion === "conductor-dialogue-http-proof/v1" && dialogue.testOnly === true
    && dialogue.nativeM10Producer === true && dialogue.httpCommands === true
    && dialogue.reloadAndCommandReplay === true && dialogue.originalFareFactsUnchanged === true,
  "Unsuccessful original dialogue HTTP report.");
  require(typeof dialogue.worldId === "string" && typeof dialogue.trainRunId === "string"
    && /^[a-f0-9]{64}$/u.test(dialogue.dialogueReleaseHash) && /^[a-f0-9]{64}$/u.test(dialogue.initialDemandStateHash)
    && Array.isArray(dialogue.cases) && dialogue.cases.length === 6
    && new Set(dialogue.cases.map((item) => item.scenario)).size === 6
    && dialogue.cases.every((item) => typeof item.scenario === "string" && /^[a-f0-9]{64}$/u.test(item.restoredStateHash)),
  "Incomplete original dialogue HTTP evidence.");
  files.push({ file: dialogueFile, bytes: dialogueBytes.length, sha256: sha(dialogueBytes) });
  proofs.push({ report: dialogueFile, worldId: dialogue.worldId, trainRunId: dialogue.trainRunId, images: [] });
  files.sort((a, b) => a.file.localeCompare(b.file, "en"));
  return { schemaVersion: "conductor-browser-evidence/v1", testOnly: true, revision, ciRunUrl, proofs, files,
    filesHash: sha(JSON.stringify(files)), limitations: ["Fictional source infrastructure and game configurations", "Temporary test signatures; no productive release activation",
      "This manifest verifies artifact integrity, not a successful CI conclusion or the complete M15 acceptance"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, revision, ciRunUrl] = process.argv.slice(2);
  require(root && revision, "Usage: node tools/conductor-session/package-evidence.mjs <evidence-directory> <git-revision> [ci-run-url]");
  const manifest = await packageConductorEvidence({ root, revision, ciRunUrl });
  const output = resolve(root, "evidence-manifest.json");
  require(await realpath(dirname(output)) === await realpath(root), "Invalid output directory.");
  const prior = await lstat(output).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  require(prior === undefined || prior.isFile() && !prior.isSymbolicLink(), "Invalid existing output file.");
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "w" });
  process.stdout.write(`${output}\n`);
}
