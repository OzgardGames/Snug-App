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
const fs = require("node:fs");
const path = require("node:path");

const projectDir = path.join(__dirname, "..");
const repoRoot = path.join(projectDir, "..");
const { version } = require(path.join(projectDir, "package.json"));
const tag = `v${version}`;

// electron-builder only discovers a missing GH_TOKEN when it reaches the
// publish step, which is after a four-minute, 160MB build. This is the same
// check, one second in. It reads electron-builder.env directly because
// that file is loaded by electron-builder later in the run, so the token
// isn't in process.env yet.
const TOKEN_FILE = path.join(projectDir, "electron-builder.env");

function releaseToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    const line = fs
      .readFileSync(TOKEN_FILE, "utf8")
      .split(/\r?\n/)
      .find((l) => l.trim().startsWith("GH_TOKEN="));
    return line ? line.trim().slice("GH_TOKEN=".length).trim() : "";
  } catch {
    return "";
  }
}

if (!releaseToken()) {
  console.error(
    `[ensure-tag] No GitHub token, so publishing would fail at the very end.\n` +
      `Open this file and put the token after GH_TOKEN= :\n\n  ${TOKEN_FILE}\n\n` +
      `It needs write access to the repo (a fine-grained token with\n` +
      `"Contents: Read and write", or a classic token with the "repo" scope).\n` +
      `The file is gitignored. Nothing else needs changing — re-run the same\n` +
      `release command afterwards.`,
  );
  process.exit(1);
}

function git(args, opts = {}) {
  // execFileSync returns null when stdout isn't captured, which is exactly
  // what stdio: "inherit" does — the tag push below passes that so its
  // progress is visible, and trimming the result blew up on null AFTER the
  // push had already succeeded. The release then stopped before building,
  // leaving a pushed tag and no release for it.
  return (execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts }) ?? "").trim();
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

// Ask the remote before pushing. Pushing a tag origin already has is NOT
// a no-op — git rejects it outright ("already exists"), which would fail
// the whole release on exactly the re-run-after-a-failed-publish this
// script is meant to survive.
const onRemote = git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]) !== "";
if (onRemote) {
  console.log(`[ensure-tag] ${tag} is already on origin`);
} else {
  git(["push", "origin", tag], { stdio: "inherit" });
  console.log(`[ensure-tag] pushed ${tag} to origin`);
}
console.log(`[ensure-tag] ${tag} is on origin — safe to publish a release for it`);

// Create the release NOW, before electron-builder gets a chance to.
//
// electron-builder runs its GitHub publisher once per artifact (the
// installer and its blockmap), and each pass independently checks whether a
// release exists for the tag. When it doesn't, both create one, and GitHub
// happily ends up with TWO releases sharing a tag. Whichever one the
// download path resolves to is then a coin flip: for 1.0.3 it picked the
// one holding only the blockmap, so latest.yml 404'd and nobody could
// update; for 1.0.4 it picked the right one and the duplicate was merely
// untidy. Creating it up front means both passes find an existing release
// and just upload to it.
//
// Not fatal if it fails: the release still publishes the way it always did,
// duplicate risk and all, which beats refusing to build over a tidy-up.
const { owner, repo } = require(path.join(projectDir, "package.json")).build.publish[0];
const api = `https://api.github.com/repos/${owner}/${repo}`;
const headers = {
  Authorization: `Bearer ${releaseToken()}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

(async () => {
  const existing = await fetch(`${api}/releases/tags/${tag}`, { headers });
  if (existing.ok) {
    console.log(`[ensure-tag] a release for ${tag} already exists`);
    return;
  }
  if (existing.status === 401 || existing.status === 403) {
    console.error(
      `[ensure-tag] GitHub rejected the token (HTTP ${existing.status}).
` +
        `Publishing would fail at the end of the build, so stopping here.
` +
        `Check the token in electron-builder.env has write access to ${owner}/${repo}.`,
    );
    process.exit(1);
  }

  const created = await fetch(`${api}/releases`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }),
  });
  if (created.ok) {
    console.log(`[ensure-tag] created the GitHub release for ${tag}`);
  } else {
    console.warn(
      `[ensure-tag] couldn't pre-create the release (HTTP ${created.status}); ` +
        `electron-builder will make one, which may duplicate.`,
    );
  }
})();
