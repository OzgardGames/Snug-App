// Is this path one of our own saved clips?
//
// The room hands these back to us to play, share and DELETE, so a path
// arriving over IPC is untrusted input even though the page that sent it is
// ours: a bug (or anything that ever manages to run in that renderer) must
// not be able to turn "delete this clip" into "delete that file".
//
// Three things have to hold, and the middle one is the load-bearing part:
// the resolved path has to sit directly in the recordings folder, not
// merely start with its name (".../Snug/recordings-elsewhere" does) and not
// in a subfolder of it.
const path = require("node:path");

// Two shapes: what clips are named now (9-26-2026_clip_01.mp4) and what
// they were named before that (snug-replay-<ISO timestamp>.mp4). The old
// one stays recognised so clips saved by earlier versions can still be
// listed, played and deleted.
const CLIP_NAME = /^(\d{1,2}-\d{1,2}-\d{4}_clip_\d+|snug-replay-[\w.-]*)\.(mp4|webm)$/i;

/** MM-DD-YYYY, zero-padded so a folder sorted by name sorts by date. */
function clipDateStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${date.getFullYear()}`;
}

/**
 * The next free "<date>_clip_NN" name for today, given whatever is already
 * in the folder. Counts from the FILES rather than from a counter in
 * memory, so restarting the app mid-session carries on from where the day
 * left off instead of starting again at 01 and colliding.
 */
function nextClipName(existingNames, date, ext) {
  const stamp = clipDateStamp(date);
  // Matches today's clips whether or not the month and day are padded: an
  // earlier build wrote them unpadded (9-26-2026), and those still have to
  // count, or today's numbering restarts at 01 alongside them.
  // Double backslashes: this is a STRING being compiled to a regex, and in
  // a template literal a lone \d is just "d".
  const pattern = new RegExp(
    `^0?${date.getMonth() + 1}-0?${date.getDate()}-${date.getFullYear()}_clip_(\\d+)\\.`,
    "i",
  );
  const used = existingNames
    .map((name) => pattern.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const next = (used.length > 0 ? Math.max(...used) : 0) + 1;
  // Padded to two digits so a day's clips sort the way they were made.
  // Past 99 the number just gets longer; nobody saving 100 clips in a day
  // cares that they no longer line up.
  return `${stamp}_clip_${String(next).padStart(2, "0")}${ext}`;
}

function isOurClip(file, recordingsDir) {
  if (typeof file !== "string" || !file) return false;
  const resolved = path.resolve(file);
  const dir = path.resolve(recordingsDir);
  const name = path.basename(resolved);
  return path.dirname(resolved) === dir && CLIP_NAME.test(name);
}

module.exports = { isOurClip, nextClipName, clipDateStamp };

// node clipPath.js — the smallest thing that fails if the guard stops
// guarding.
if (require.main === module) {
  const assert = require("node:assert");
  const dir = path.join("C:", "Users", "x", "Videos", "Snug", "recordings");
  const ok = (f) => assert.equal(isOurClip(f, dir), true, `should accept ${f}`);
  const no = (f) => assert.equal(isOurClip(f, dir), false, `should reject ${f}`);

  ok(path.join(dir, "snug-replay-2026-09-26-01-02-03.mp4"));
  ok(path.join(dir, "snug-replay-1.webm"));
  // The shape instant replay actually writes (an ISO timestamp, colons
  // and dots swapped for dashes).
  ok(path.join(dir, "snug-replay-2026-09-25T18-07-27-996Z.mp4"));

  no(path.join(dir, "..", "..", "..", "Windows", "System32", "drivers", "etc", "hosts"));
  no(path.join(dir, "subfolder", "snug-replay-1.mp4"));
  no(path.join(dir, "notes.txt"));
  no(path.join(dir, "snug-replay-1.exe"));
  no(path.join(dir, "snug-replay-1.mp4.exe"));
  no(path.join(dir, "..", "recordings-elsewhere", "snug-replay-1.mp4"));
  no(path.join(dir, "snug-replay-1.mp4", "..", "..", "secrets.mp4"));
  no("");
  no(null);
  no(undefined);
  no(42);
  // A traversal that lands back inside the folder is fine — it IS the folder.
  ok(path.join(dir, "sub", "..", "snug-replay-1.mp4"));

  // --- names for new clips ---
  const sep = new Date(2026, 8, 26); // 26 Sep 2026 (month is 0-based)
  assert.equal(nextClipName([], sep, ".mp4"), "09-26-2026_clip_01.mp4");
  assert.equal(nextClipName(["09-26-2026_clip_01.mp4"], sep, ".mp4"), "09-26-2026_clip_02.mp4");
  // Gaps don't get reused — a deleted clip_02 doesn't make the next one 02.
  assert.equal(
    nextClipName(["09-26-2026_clip_01.mp4", "09-26-2026_clip_03.mp4"], sep, ".mp4"),
    "09-26-2026_clip_04.mp4",
  );
  // Yesterday's clips, and the old naming, don't affect today's count.
  assert.equal(
    nextClipName(["09-25-2026_clip_07.mp4", "snug-replay-2026-09-25T18-07-27-996Z.mp4"], sep, ".mp4"),
    "09-26-2026_clip_01.mp4",
  );
  assert.equal(nextClipName([], sep, ".webm"), "09-26-2026_clip_01.webm");
  assert.equal(nextClipName(["09-26-2026_clip_99.mp4"], sep, ".mp4"), "09-26-2026_clip_100.mp4");
  // Single-digit day and month are padded — 09-06-2026, not 9-6-2026, so
  // the folder sorted by name is also sorted by date.
  assert.equal(nextClipName([], new Date(2026, 8, 6), ".mp4"), "09-06-2026_clip_01.mp4");
  // A clip saved before the padding change still counts toward today's
  // numbering — same day, written the old way.
  assert.equal(nextClipName(["9-26-2026_clip_01.mp4"], sep, ".mp4"), "09-26-2026_clip_02.mp4");

  // ...and every name it generates has to pass the guard above.
  ok(path.join(dir, nextClipName([], sep, ".mp4")));
  ok(path.join(dir, nextClipName(["09-26-2026_clip_99.mp4"], sep, ".mp4")));

  console.log("clipPath: all checks passed");
}
