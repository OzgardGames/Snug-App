// Builds the Next.js app (snug/) in standalone mode and copies the static
// assets Next's standalone output deliberately omits (.next/static and
// public/) into it — without this the bundled app loads with no CSS/JS/
// fonts. Run before packaging, and whenever snug/ changes.
const { spawnSync } = require("node:child_process");
const { cpSync, existsSync, rmSync } = require("node:fs");
const path = require("node:path");

const frontendDir = path.join(__dirname, "..", "..", "snug");
const standaloneDir = path.join(frontendDir, ".next", "standalone");

console.log("[build-frontend] running `npm run build` in", frontendDir);
const build = spawnSync("npm", ["run", "build"], {
  cwd: frontendDir,
  stdio: "inherit",
  shell: true,
});
if (build.status !== 0) {
  console.error("[build-frontend] frontend build failed");
  process.exit(build.status ?? 1);
}

if (!existsSync(standaloneDir)) {
  console.error(
    "[build-frontend] no .next/standalone output — is `output: \"standalone\"` set in next.config.ts?",
  );
  process.exit(1);
}

const staticSrc = path.join(frontendDir, ".next", "static");
const staticDest = path.join(standaloneDir, ".next", "static");
const publicSrc = path.join(frontendDir, "public");
const publicDest = path.join(standaloneDir, "public");

rmSync(staticDest, { recursive: true, force: true });
cpSync(staticSrc, staticDest, { recursive: true });
console.log("[build-frontend] copied .next/static ->", staticDest);

rmSync(publicDest, { recursive: true, force: true });
cpSync(publicSrc, publicDest, { recursive: true });
console.log("[build-frontend] copied public/ ->", publicDest);

console.log("[build-frontend] done");
