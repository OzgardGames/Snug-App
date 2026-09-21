import { spawn } from "node:child_process";
import { stat, unlink } from "node:fs/promises";

// Below this, re-encoding wastes CPU for no real benefit — a short/small
// clip is already small enough to share as-is.
const SKIP_COMPRESSION_UNDER_BYTES = 8 * 1024 * 1024;
const MAX_WIDTH = 1280;

function run(cmd, args, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args);
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    proc.stderr?.on("data", (d) => {
      stderr += d;
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function runCapture(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args);
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${cmd} timed out`));
    }, opts?.timeoutMs ?? 15000);
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// Quick metadata read — safe to do synchronously in the upload response,
// unlike the actual transcode which can take a long time.
export async function probeVideo(filePath) {
  try {
    const out = await runCapture("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      filePath,
    ]);
    const data = JSON.parse(out);
    const stream = data.streams?.[0];
    const duration = Number.parseFloat(data.format?.duration);
    return {
      width: stream?.width,
      height: stream?.height,
      duration: Number.isFinite(duration) ? duration : undefined,
    };
  } catch {
    return { width: undefined, height: undefined, duration: undefined };
  }
}

async function transcode(inputPath, outputPath, width) {
  const needsScale = typeof width === "number" && width > MAX_WIDTH;
  const args = [
    "-y",
    "-i",
    inputPath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    ...(needsScale ? ["-vf", `scale=${MAX_WIDTH}:-2`] : []),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    // Moves the moov atom to the front so the browser can start playing
    // (and seeking) before the whole file has downloaded.
    "-movflags",
    "+faststart",
    outputPath,
  ];
  await run("ffmpeg", args, { timeoutMs: 10 * 60 * 1000 });
}

async function extractThumbnail(inputPath, outputPath, atSeconds) {
  await run("ffmpeg", [
    "-y",
    "-ss",
    String(atSeconds),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=480:-2",
    outputPath,
  ]);
}

// Fire-and-forget from the caller: compresses the video and grabs a poster
// frame, in the background, then reports what it produced. Never throws —
// any ffmpeg failure (including a missing binary) degrades to "just use
// the original file, no thumbnail" rather than losing the upload.
export async function processVideoAttachment({
  originalPath,
  uploadsDir,
  duration,
  makeId,
}) {
  let compressedPath = null;
  let thumbPath = null;
  let compressedSize = null;

  try {
    const originalStat = await stat(originalPath);
    if (originalStat.size > SKIP_COMPRESSION_UNDER_BYTES) {
      const outName = `${makeId()}.mp4`;
      compressedPath = `${uploadsDir}/${outName}`;
      const probe = await probeVideo(originalPath);
      await transcode(originalPath, compressedPath, probe.width);
      const compressedStat = await stat(compressedPath);
      // Only keep the re-encode if it actually helped — a couple of codecs
      // (already-efficient AV1/HEVC sources) can end up larger under a
      // generic H.264 CRF pass.
      if (compressedStat.size < originalStat.size) {
        compressedSize = compressedStat.size;
      } else {
        await unlink(compressedPath).catch(() => {});
        compressedPath = null;
      }
    }
  } catch {
    compressedPath = null;
  }

  try {
    const thumbName = `${makeId()}.jpg`;
    thumbPath = `${uploadsDir}/${thumbName}`;
    const at = duration ? Math.min(1, duration * 0.25) : 0.5;
    await extractThumbnail(originalPath, thumbPath, at);
  } catch {
    thumbPath = null;
  }

  return { compressedPath, compressedSize, thumbPath };
}
