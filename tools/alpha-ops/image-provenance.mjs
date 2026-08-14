import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_GIT_SHA = /^[0-9a-f]{40}$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

export function resolveImageProvenance({ cwd = process.cwd(), environment = process.env } = {}) {
  const repositoryRoot = git(cwd, "rev-parse", "--show-toplevel");
  const sourceSha = git(repositoryRoot, "rev-parse", "--verify", "HEAD^{commit}");
  invariant(FULL_GIT_SHA.test(sourceSha), "Git-HEAD ist kein vollstaendiger 40-stelliger Commit.");

  const status = git(
    repositoryRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  );
  invariant(status === "", "Alpha-Images duerfen nur aus einem vollstaendig sauberen Git-Checkout gebaut werden.");

  if (environment.ZUGFOLGE_SOURCE_SHA !== undefined) {
    invariant(
      FULL_GIT_SHA.test(environment.ZUGFOLGE_SOURCE_SHA) && environment.ZUGFOLGE_SOURCE_SHA === sourceSha,
      "Vorgegebenes ZUGFOLGE_SOURCE_SHA stimmt nicht exakt mit dem sauberen Git-HEAD ueberein.",
    );
  }
  invariant(
    environment.ZUGFOLGE_DEPLOY_PATCH_SHA === undefined || environment.ZUGFOLGE_DEPLOY_PATCH_SHA === "none",
    "Separate Deploypatches sind verboten; die Aenderung muss in Git-HEAD committed und ZUGFOLGE_DEPLOY_PATCH_SHA=none sein.",
  );

  return { repositoryRoot, sourceSha, deployPatchSha: "none" };
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${resolveImageProvenance().sourceSha}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
