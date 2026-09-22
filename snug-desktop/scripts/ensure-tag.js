// Creates and pushes the git tag for this version before electron-builder
// tries to publish.
//
// package.json sets releaseType: "release", so electron-builder asks GitHub
// to create an already-PUBLISHED release. GitHub refuses that for a tag it
// doesn't have yet:
//
//   HttpError: 422 Unprocessable Entity
//   "Published releases must have a valid tag"
//
// (A draft may reference a tag that doesn't exist — GitHub creates it when
// the draft is published — which is why this never came up while releases
// were drafts.) That's what broke the 1.0.1 release: the publish failed
// partway, leaving the installer uploaded but no latest.yml, so the app
// couldn't see the update at all.
//
// Tagging here rather than by hand keeps the tag and the version in
// package.json from drifting apart, since both come from the same field.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const projectDir = path.join(__dirname, "..");
const repoRoot = path.join(projectDir, "..");
const { version } = require(path.join(projectDir, "package.json"));
const tag = `v${version}`;

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts }).trim();
}

// Tagging a tree that doesn't match what's committed would ship a tag
// pointing at code nobody can check out. Only this package's own files
// matter — the rest of the repo isn't in the build.
const dirty = git(["status", "--porcelain", "--", "snug-desktop", "snug"]);
if (dirty) {
  console.error(
    `[ensure-tag] Refusing to tag ${tag}: uncommitted changes in snug-desktop/ or snug/.\n` +
      `Commit them first so ${tag} points at the code actually being released.\n\n${dirty}`,
  );
  process.exit(1);
}

let exists = true;
try {
  git(["rev-parse", "--verify", `refs/tags/${tag}`], { stdio: ["ignore", "pipe", "ignore"] });
} catch {
  exists = false;
}

if (!exists) {
  git(["tag", tag]);
  console.log(`[ensure-tag] created ${tag}`);
} else {
  console.log(`[ensure-tag] ${tag} already exists locally`);
}

// Idempotent: pushing a tag the remote already has is a no-op ("Everything
// up-to-date"), so a re-run after a failed publish doesn't error here.
git(["push", "origin", tag], { stdio: "inherit" });
console.log(`[ensure-tag] ${tag} is on origin — safe to publish a release for it`);
