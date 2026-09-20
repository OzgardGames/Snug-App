import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import Busboy from "busboy";
import { S3Client, PutObjectCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { probeVideo, processVideoAttachment } from "./videoProcessing.mjs";

// Same persistent-volume convention as db.mjs's DATA_DIR — both must point
// at the same mounted directory in production so a redeploy doesn't wipe
// either one. Only still used as a fallback when R2 isn't configured (see
// below) — otherwise nothing durable is written here anymore, which is the
// whole point of the R2 move: the 500MB Railway volume isn't where
// attachments live now.
const DATA_DIR = process.env.DATA_DIR || path.dirname(fileURLToPath(import.meta.url));
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
// Genuinely ephemeral scratch space (the container's own local disk, not
// the mounted volume) — a file only ever lives here for as long as it
// takes to upload it to R2 (or, for video, to also compress it first).
const TMP_DIR = path.join(tmpdir(), "snug-uploads");
// No auth on this server, so some ceiling stays — 1GB comfortably covers a
// real phone video (compression then shrinks it further after upload).
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_PREVIEW_FETCH_BYTES = 200 * 1024;

await mkdir(UPLOADS_DIR, { recursive: true });
await mkdir(TMP_DIR, { recursive: true });

// Attachments live in Cloudflare R2 (S3-compatible) instead of the Railway
// volume — that volume is only 500MB, has no free-egress story, and every
// photo/video shared in a persistent room stays forever until the room is
// deleted, so it fills up in a way local disk never could keep up with.
// Falls back to writing straight to the local volume (the original
// behavior) when R2 isn't configured, so local dev works without needing
// real R2 credentials.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");

export const r2Enabled = !!(
  R2_ACCOUNT_ID &&
  R2_ACCESS_KEY_ID &&
  R2_SECRET_ACCESS_KEY &&
  R2_BUCKET &&
  R2_PUBLIC_URL
);

const s3 = r2Enabled
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

if (!r2Enabled) {
  console.warn(
    "[uploads] R2 env vars not set — falling back to local-disk storage on the Railway volume.",
  );
}

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".zip": "application/zip",
};

function extFor(name, mime) {
  const fromName = path.extname(name || "").toLowerCase();
  if (fromName && /^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  const fromMime = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)?.[0];
  return fromMime || "";
}

export function classify(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

async function uploadToR2(localPath, key, mime) {
  const info = await stat(localPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: createReadStream(localPath),
      ContentLength: info.size,
      ContentType: mime || "application/octet-stream",
    }),
  );
  return `${R2_PUBLIC_URL}/${key}`;
}

async function deleteFromR2(keys) {
  if (!keys.length) return;
  // DeleteObjects tops out at 1000 keys per call — a single room's
  // lifetime attachments are never going to get remotely close to that.
  await s3
    .send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }))
    .catch(() => {});
}

// Sweeps every file a room's messages ever referenced — originals,
// compressed re-encodes, thumbnails. Called only when a room is actually
// destroyed (explicit delete/end), never just because it emptied out, so a
// persistent room's attachments survive between sessions like the rest of
// its history. Handles both R2 (full URL) and, for anything uploaded
// before the R2 migration, local-disk (relative "/uploads/..." URL)
// attachments in the same sweep.
export async function deleteAttachmentFiles(messages) {
  const r2Keys = new Set();
  const localNames = new Set();
  for (const message of messages) {
    const attachment = message.attachment;
    if (!attachment) continue;
    for (const url of [attachment.url, attachment.thumbnailUrl]) {
      if (!url) continue;
      if (/^https?:\/\//i.test(url)) r2Keys.add(path.basename(url));
      else localNames.add(path.basename(url));
    }
  }
  await Promise.all([
    r2Enabled && r2Keys.size ? deleteFromR2([...r2Keys]) : Promise.resolve(),
    ...[...localNames].map((name) => unlink(path.join(UPLOADS_DIR, name)).catch(() => {})),
  ]);
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// `allowedOrigins` may be several real clients (the hosted web app, the
// desktop app's local bundled frontend) — reflect back whichever one this
// request actually came from rather than picking a single fixed value, the
// standard way to support more than one legitimate origin.
function setCors(req, res, allowedOrigins) {
  const requestOrigin = req.headers.origin;
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readBody(req, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const err = new Error("Payload too large");
      err.code = "PAYLOAD_TOO_LARGE";
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Streams the upload straight to disk instead of buffering it in memory —
// large files (video especially) would otherwise risk exhausting heap, and
// aborting mid-body without draining the request left the client seeing a
// bare connection reset ("Failed to fetch") instead of a real error. That
// disk landing spot is always local first (TMP_DIR when R2 is enabled,
// UPLOADS_DIR when it isn't) — R2 has no equivalent of a raw writable
// stream to pipe into directly from a multipart parse.
// `isRoomMember(roomCode, deviceToken)` — passed in from index.mjs, which is
// the only place that actually holds the rooms Map — lets this reject an
// upload from anyone who isn't a currently-connected member of a real room,
// instead of accepting a file from literally anyone who finds this URL.
function handleUpload(req, res, allowedOrigins, isRoomMember) {
  setCors(req, res, allowedOrigins);

  let responded = false;
  function respond(status, body) {
    if (responded) return;
    responded = true;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    });
  } catch {
    respond(400, { error: "Invalid upload." });
    return;
  }

  let savedPath = null;
  let fileInfo = null;
  let sizeExceeded = false;
  let sawFile = false;
  let unauthorized = false;
  // Sent as regular form fields ahead of the file itself (see uploadFile in
  // src/lib/upload.ts) — read here as they arrive, so they're already known
  // by the time the "file" event fires just after.
  let roomCode = "";
  let deviceToken = "";
  // busboy's own "finish" only means it's done parsing the multipart body —
  // the destination file can still be mid-flush at that point. Track the
  // write stream's own completion separately and wait on it too, or a
  // fast-finishing request can stat() a file that isn't fully on disk yet.
  let writeFinished = Promise.resolve();

  busboy.on("field", (name, value) => {
    if (name === "roomCode") roomCode = value;
    else if (name === "deviceToken") deviceToken = value;
  });

  busboy.on("file", (_fieldname, fileStream, info) => {
    sawFile = true;

    if (!isRoomMember(roomCode, deviceToken)) {
      unauthorized = true;
      // Still has to be drained (not written anywhere) or busboy stalls
      // waiting for this stream to be consumed.
      fileStream.resume();
      return;
    }

    const { filename, mimeType } = info;
    const mime = mimeType || "application/octet-stream";
    const ext = extFor(filename, mime);
    const diskFilename = `${crypto.randomUUID()}${ext}`;
    savedPath = path.join(r2Enabled ? TMP_DIR : UPLOADS_DIR, diskFilename);
    fileInfo = { filename, mime, diskFilename };

    const writeStream = createWriteStream(savedPath);
    writeFinished = new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });
    fileStream.on("limit", () => {
      sizeExceeded = true;
      fileStream.unpipe(writeStream);
      writeStream.destroy();
    });
    fileStream.pipe(writeStream);
  });

  busboy.on("finish", async () => {
    if (unauthorized) {
      respond(403, { error: "You need to be in this room to upload files." });
      return;
    }
    if (sizeExceeded) {
      if (savedPath) await unlink(savedPath).catch(() => {});
      respond(413, { error: "File is too large." });
      return;
    }
    if (!sawFile || !savedPath || !fileInfo) {
      respond(400, { error: "No file provided." });
      return;
    }
    try {
      await writeFinished;
      const info = await stat(savedPath);
      const kind = classify(fileInfo.mime);
      const meta = kind === "video" ? await probeVideo(savedPath) : {};

      let url = `/uploads/${fileInfo.diskFilename}`;
      if (r2Enabled) {
        url = await uploadToR2(savedPath, fileInfo.diskFilename, fileInfo.mime);
        // Videos keep their local temp copy around — finalizeVideoUpload
        // (called from index.mjs once the message is actually sent) needs
        // it to run ffmpeg compression without re-downloading from R2.
        // Everything else is done with it.
        if (kind !== "video") await unlink(savedPath).catch(() => {});
      }

      respond(200, {
        url,
        name: fileInfo.filename || fileInfo.diskFilename,
        size: info.size,
        sizeLabel: formatSize(info.size),
        mime: fileInfo.mime,
        kind,
        status: kind === "video" ? "processing" : "ready",
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
      });
    } catch {
      respond(500, { error: "Upload failed." });
    }
  });

  busboy.on("error", async () => {
    if (savedPath) await unlink(savedPath).catch(() => {});
    respond(400, { error: "Upload failed." });
  });

  req.pipe(busboy);
}

// Runs a just-uploaded video through compression/thumbnail generation and
// lands the result in R2 — called from index.mjs's processVideoMessage
// once the video's message has actually been sent (see handleUpload above:
// the original's local temp copy is deliberately kept around for this).
// Mirrors handleUpload's own R2-vs-local branch: with R2 enabled, the
// source lives in TMP_DIR and every local file this touches is scratch
// space cleaned up unconditionally; with R2 disabled, this is the original
// local-disk behavior — the source lives in (and any compressed
// replacement is written to) UPLOADS_DIR, the original is only removed
// once a smaller replacement actually exists, and returned URLs stay
// relative "/uploads/..." paths.
export async function finalizeVideoUpload(diskFilename, duration) {
  const sourceDir = r2Enabled ? TMP_DIR : UPLOADS_DIR;
  const originalPath = path.join(sourceDir, diskFilename);
  const { compressedPath, compressedSize, thumbPath } = await processVideoAttachment({
    originalPath,
    uploadsDir: sourceDir,
    duration,
    makeId: () => crypto.randomUUID(),
  });

  try {
    const result = {};
    if (compressedPath) {
      result.url = r2Enabled
        ? await uploadToR2(compressedPath, path.basename(compressedPath), "video/mp4")
        : `/uploads/${path.basename(compressedPath)}`;
      result.size = compressedSize;
      result.sizeLabel = formatSize(compressedSize);
    }
    if (thumbPath) {
      result.thumbnailUrl = r2Enabled
        ? await uploadToR2(thumbPath, path.basename(thumbPath), "image/jpeg")
        : `/uploads/${path.basename(thumbPath)}`;
    }
    if (result.url) {
      // The original was already uploaded to R2 (as the "processing"-status
      // placeholder) — once a compressed replacement exists, it's just dead
      // weight, deleted the same way any other retired attachment is. In
      // local-fallback mode the equivalent is just unlinking it from disk.
      if (r2Enabled) await deleteFromR2([diskFilename]);
      else await unlink(originalPath).catch(() => {});
    }
    return result;
  } finally {
    if (r2Enabled) {
      await unlink(originalPath).catch(() => {});
      if (compressedPath) await unlink(compressedPath).catch(() => {});
      if (thumbPath) await unlink(thumbPath).catch(() => {});
    }
  }
}

// Range support is what lets the browser's native <video> player seek/scrub
// and start playback without pulling the whole file first — without this,
// every play is an all-or-nothing download. Only still reached for
// attachments uploaded before the R2 migration (relative "/uploads/..."
// URLs) — anything uploaded since is served directly from R2/Cloudflare,
// never through this server at all.
async function handleServeUpload(req, res, requestPath) {
  const filename = requestPath.replace(/^\/uploads\//, "");
  if (!/^[A-Za-z0-9-]+\.[A-Za-z0-9]{1,8}$/.test(filename)) {
    res.writeHead(400);
    res.end();
    return;
  }
  const filePath = path.join(UPLOADS_DIR, filename);
  try {
    const info = await stat(filePath);
    const ext = path.extname(filename).toLowerCase();
    const contentType = MIME_BY_EXT[ext] || "application/octet-stream";
    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match?.[2] ? Number.parseInt(match[2], 10) : info.size - 1;
      if (!match || Number.isNaN(start) || Number.isNaN(end) || start > end || end >= info.size) {
        res.writeHead(416, { "content-range": `bytes */${info.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        "content-type": contentType,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${info.size}`,
        "accept-ranges": "bytes",
        "cache-control": "public, max-age=31536000, immutable",
      });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      "content-type": contentType,
      "content-length": info.size,
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
}

function extractMeta(html, prop) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${prop}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return undefined;
}

export async function fetchLinkPreview(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("bad protocol");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const response = await fetch(parsed, {
    signal: controller.signal,
    headers: { "user-agent": "Mozilla/5.0 (compatible; SnugLinkPreview/1.0)" },
  }).finally(() => clearTimeout(timeout));

  const reader = response.body?.getReader();
  let html = "";
  if (reader) {
    let total = 0;
    const decoder = new TextDecoder();
    while (total < MAX_PREVIEW_FETCH_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
  }

  const title =
    extractMeta(html, "og:title") || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || parsed.hostname;
  const image = extractMeta(html, "og:image");

  return {
    title: title.trim().slice(0, 200),
    domain: parsed.hostname.replace(/^www\./, ""),
    image: image || undefined,
    url: parsed.toString(),
  };
}

async function handleLinkPreview(req, res, allowedOrigins) {
  setCors(req, res, allowedOrigins);
  try {
    const bodyBuffer = await readBody(req, 1024 * 10);
    const { url } = JSON.parse(bodyBuffer.toString("utf8") || "{}");
    const preview = await fetchLinkPreview(url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(preview));
  } catch {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(null));
  }
}

export function createUploadsRequestHandler(allowedOrigins, isRoomMember) {
  return function onRequest(req, res) {
    const url = req.url ?? "/";
    if (req.method === "OPTIONS" && (url === "/upload" || url === "/link-preview")) {
      setCors(req, res, allowedOrigins);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && url === "/upload") {
      handleUpload(req, res, allowedOrigins, isRoomMember);
      return;
    }
    if (req.method === "POST" && url === "/link-preview") {
      handleLinkPreview(req, res, allowedOrigins);
      return;
    }
    if (req.method === "GET" && url.startsWith("/uploads/")) {
      handleServeUpload(req, res, url);
      return;
    }
    // Not one of ours — leave it for Socket.IO's own request listener.
  };
}
