// electron-builder's extraResources/files silently strip node_modules no
// matter what filter is passed — a known limitation, not something
// configurable away. This hook runs after packaging and copies the
// standalone server's node_modules in directly with raw fs access,
// bypassing that filtering entirely.
const { cpSync, existsSync } = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  const src = path.join(
    __dirname,
    "..",
    "..",
    "snug",
    ".next",
    "standalone",
    "node_modules",
  );
  const dest = path.join(
    context.appOutDir,
    "resources",
    "standalone",
    "node_modules",
  );

  if (!existsSync(src)) {
    throw new Error(
      `[afterPack] standalone node_modules not found at ${src} — run build:frontend first`,
    );
  }

  cpSync(src, dest, { recursive: true });
  console.log(`[afterPack] copied standalone node_modules -> ${dest}`);

  // Same node_modules-stripping limitation applies to ffmpeg-static's
  // binary (main.js spawns it to stitch instant-replay segments together
  // on save) — copy just the executable directly rather than fighting
  // electron-builder's file filtering for it too.
  const ffmpegSrc = path.join(__dirname, "..", "node_modules", "ffmpeg-static", "ffmpeg.exe");
  const ffmpegDest = path.join(context.appOutDir, "resources", "ffmpeg", "ffmpeg.exe");

  if (!existsSync(ffmpegSrc)) {
    throw new Error(`[afterPack] ffmpeg-static binary not found at ${ffmpegSrc} — run npm install first`);
  }

  cpSync(ffmpegSrc, ffmpegDest);
  console.log(`[afterPack] copied ffmpeg binary -> ${ffmpegDest}`);
};
