// The RNNoise worklet processor and its .wasm binaries have to be fetchable
// by URL at runtime (AudioWorklet.addModule + loadRnnoise both take a URL,
// not a bundler import) — Next.js's own module graph can't serve them, so
// they're copied out of node_modules into public/ instead, where both the
// hosted web app and the desktop app's bundled standalone server (see
// build-frontend.js, which copies public/ verbatim) can reach them as
// plain static files. Re-run whenever the package is upgraded.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDist = path.join(here, "..", "node_modules", "@sapphi-red", "web-noise-suppressor", "dist");
const outDir = path.join(here, "..", "public", "rnnoise");

const files = [
  ["rnnoise/workletProcessor.js", "workletProcessor.js"],
  ["rnnoise.wasm", "rnnoise.wasm"],
  ["rnnoise_simd.wasm", "rnnoise_simd.wasm"],
];

await mkdir(outDir, { recursive: true });
for (const [from, to] of files) {
  await copyFile(path.join(pkgDist, from), path.join(outDir, to));
}
console.log(`[copy-rnnoise-assets] copied ${files.length} files -> public/rnnoise/`);
