const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  session,
  desktopCapturer,
  screen,
  shell,
} = require("electron");
const { spawn, execFile } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");

// Windows identifies an app to the shell by its "Application User Model
// ID" — it drives taskbar grouping and how a pinned/Start Menu shortcut
// maps back to the running process. The installer's shortcut sets one too,
// but only once the app is actually installed; this covers every launch
// path, matches package.json's build.appId, and is a no-op elsewhere.
app.setAppUserModelId("app.snug.desktop");

// electron-builder's files/extraResources filtering silently strips
// node_modules no matter what pattern is given (see afterPack.js's own
// comment on the same limitation for the standalone server) — so the
// packaged ffmpeg binary is copied in directly by afterPack.js instead,
// and resolved from resourcesPath here rather than through require()
// resolution, which wouldn't find it inside the packaged app at all.
const ffmpegPath = app.isPackaged
  ? path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe")
  : require("ffmpeg-static");

// The bundled frontend: a self-contained Next.js standalone server built by
// scripts/build-frontend.js. Running our own local copy (rather than
// pointing at Vercel) means the app opens instantly and doesn't depend on
// that hosting being reachable — see the "what do we need Vercel for"
// discussion this was built from.
//
// In dev, it's read straight from the sibling snug/ checkout. Once
// packaged, electron-builder's extraResources copies it next to the app
// instead (there's no sibling folder inside an installed app), so it's
// read from resourcesPath — see package.json's "build.extraResources".
const STANDALONE_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "standalone")
  : path.join(__dirname, "..", "..", "snug", ".next", "standalone");
// Overridable so a dev instance (electron . during development) can run
// alongside an already-installed copy of the app without either one's
// bundled server silently answering for the other on a shared port.
const PORT = Number(process.env.SNUG_DESKTOP_PORT) || 3210;
const LOCAL_URL = `http://localhost:${PORT}`;

let serverProcess = null;
let mainWindow = null;
let overlayWindow = null;
let sharePickerWindow = null;
let splashWindow = null;
let recordingWindow = null;
let notificationWindow = null;
let notificationTimer = null;
let tray = null;
// Reported by the renderer via preload's reportMuteState — reflected in
// the tray menu label.
let lastMuteState = false;
let lastDeafenState = false;
// See the maximize/unmaximize listeners in createWindow for why this is
// tracked by hand instead of read via mainWindow.isMaximized() — the same
// frame:false + transparent:true window made isFullScreen() report stale
// values on Windows, so the readback getter isn't trusted here either.
let isWindowMaximized = false;
// Which window size/shape the renderer last asked for — see
// applyWindowMode. Compared against on every request so navigating
// between two "compact" pages (home -> My Rooms) doesn't re-trigger a
// resize/re-center the user might be mid-drag on.
let currentWindowMode = null;
// The compact window has no fixed height of its own — it's driven entirely
// by snug:content-size reports from whatever card is on screen (see
// useDesktopContentSize.ts). Remembered across a full -> compact ->
// full round trip so returning to compact doesn't flash back to a generic
// default before the first report arrives.
let lastCompactHeight = null;

// The join/create screen and My Rooms have no OS window at all — just the
// floating card itself (transparent + frame:false below, no native shadow;
// the card supplies its own via CSS) — sized to whatever's actually on
// screen instead of a fixed box the content has to fit into, which used to
// clip the taller "Create a room" form. The room itself gets the full
// resizable, opaque app window.
const WINDOW_MODES = {
  compact: { width: 480, resizable: false },
  // Must be >= MIN_WINDOW_WIDTH below — Electron's setMinimumSize doesn't
  // retroactively grow an already-smaller window on every platform, so
  // opening below the floor it enforces would leave the window stuck
  // violating its own minimum until the next manual resize.
  full: { width: 1360, height: 940, resizable: true },
};
// Derived, not guessed: the mic control bar (see page.tsx's "mic control
// bar") is meant to always render at its full natural size, centered,
// never compacted to icons or scrolled — so the floor has to fit its
// worst case (screen-sharing, "Change screen" + "Stop Sharing" both
// showing, plus a long device name in the mic picker) measured at ~800px,
// alongside the chat panel's own fixed 390px (see page.tsx — deliberately
// one size, not user-resizable), the gap between them, and <main>'s own
// m-3 margin + p-6 padding. Bump this (and WINDOW_MODES.full.width to
// match, and MIN_WINDOW_HEIGHT together with WINDOW_MODES.full.height)
// only alongside whatever changed on the page.tsx side that fed the
// number: bar width, CHAT panel width, or the layout's own spacing.
//   820 (bar, worst case) + 20 (gap-5) + 390 (chat) + 24 (m-3 × 2)
//   + 48 (p-6 × 2) = 1302, rounded up for headroom.
const MIN_WINDOW_WIDTH = 1320;
const MIN_WINDOW_HEIGHT = 560;

function applyWindowMode(mode) {
  if (!mainWindow || mode === currentWindowMode || !WINDOW_MODES[mode]) return;
  currentWindowMode = mode;
  const { width, resizable } = WINDOW_MODES[mode];
  const height = mode === "compact" ? (lastCompactHeight ?? 620) : WINDOW_MODES.full.height;
  mainWindow.setResizable(true); // setSize can be ignored on some platforms while resizable:false
  mainWindow.setContentSize(width, height);
  mainWindow.setResizable(resizable);
  // Also clamps Windows' own snap/maximize-drag gestures, not just our
  // ResizeHandles-driven drags — setMinimumSize(0,0) on the compact screens
  // means their own fixed, non-resizable sizing (driven by content-size
  // reports, see below) isn't second-guessed by a leftover floor.
  mainWindow.setMinimumSize(mode === "full" ? MIN_WINDOW_WIDTH : 0, mode === "full" ? MIN_WINDOW_HEIGHT : 0);
  mainWindow.center();
}
// Closing the window hides it instead of quitting (same as Discord/Slack) —
// voice chat should keep running while you're gaming, not die when the
// window closes. Only the tray's real "Quit" sets this.
let isQuitting = false;

function startFrontendServer() {
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: STANDALONE_DIR,
    env: {
      ...process.env,
      // Without this, process.execPath (Electron's own binary) tries to
      // bootstrap ANOTHER full Electron app pointed at server.js instead of
      // just running it as a plain Node script — causing a runaway
      // respawn loop, not a working server. This makes it behave as Node.
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(PORT),
      HOSTNAME: "localhost",
    },
    stdio: "pipe",
  });

  serverProcess.stdout.on("data", (d) =>
    process.stdout.write(`[frontend] ${d}`),
  );
  serverProcess.stderr.on("data", (d) =>
    process.stderr.write(`[frontend] ${d}`),
  );
  serverProcess.on("exit", (code) => {
    console.log(`[snug-desktop] frontend server exited with code ${code}`);
  });
}

// The standalone server usually binds well within a second, but polling for
// a real response is more reliable than a fixed delay.
function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      http
        .get(url, (res) => {
          res.resume();
          resolve();
        })
        .on("error", () => {
          if (Date.now() - start > timeoutMs) {
            reject(new Error(`Frontend server didn't respond within ${timeoutMs}ms`));
            return;
          }
          setTimeout(attempt, 150);
        });
    }
    attempt();
  });
}

async function createWindow() {
  const win = new BrowserWindow({
    width: WINDOW_MODES.compact.width,
    height: 620,
    resizable: WINDOW_MODES.compact.resizable,
    title: "Snug",
    // No native OS title bar or window chrome, ever — the renderer draws
    // its own controls (see DesktopTitleBar.tsx) with app-region drag zones
    // and custom-styled minimize/maximize/close buttons, dispatched via the
    // IPC handlers below. transparent + hasShadow:false means there is no
    // visible window rectangle at all on the compact screens (join/create,
    // My Rooms) — only the card itself, which paints its own background,
    // radius and shadow in CSS; the full/room view fills the whole window
    // with its own opaque UI so the transparency is never visible there.
    // (backgroundColor is deliberately omitted — Electron doesn't support
    // it together with transparent: true.)
    frame: false,
    transparent: true,
    hasShadow: false,
    // Same reasoning as the splash window's roundedCorners: false — the
    // compact-mode card (see createWindow's comment above) fills this
    // window exactly the way the splash card does, so it's exposed to the
    // identical Windows-11-vs-CSS-radius mismatch at the corners.
    roundedCorners: false,
    // Stays hidden until "ready-to-show" (first real paint) so the boot
    // wait — waitForServer below, plus loadURL — shows the splash screen
    // instead of a blank/invisible transparent rectangle.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The whole point of Snug is running voice chat while some OTHER
      // window (a game) has focus — Chromium's default background
      // throttling (meant for battery life on ordinary backgrounded tabs)
      // slows down or pauses this window's JS timers once it's occluded,
      // which is exactly when it matters most. That's what was breaking
      // the per-member talking indicator (its setInterval-based level
      // polling in audioLevel.ts would stall or fire in sparse, stale
      // bursts once the window lost focus — explaining both a talking
      // state that "gets stuck" instead of tracking live audio, and
      // several members appearing to light up together when a delayed
      // batch of stale reads finally landed) and could plausibly stall
      // other backgrounded audio/reconnect logic too.
      backgroundThrottling: false,
    },
  });
  currentWindowMode = "compact";

  win.once("ready-to-show", () => {
    win.show();
    closeSplashWindow();
  });

  win.webContents.on("did-finish-load", () => {
    console.log("[snug-desktop] did-finish-load: page loaded successfully");
  });
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription) => {
      console.error(
        `[snug-desktop] did-fail-load: ${errorCode} ${errorDescription}`,
      );
    },
  );

  await waitForServer(LOCAL_URL);
  win.loadURL(LOCAL_URL);

  mainWindow = win;
  win.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  // Drives the custom title bar's maximize/restore icon — it can't just
  // track its own click, since double-clicking the drag region or an OS
  // snap gesture (Win+Up, drag-to-top) changes the state without going
  // through the button at all. Tracked in our own variable rather than read
  // back via win.isMaximized() — on this frame:false + transparent:true
  // window, the equivalent isFullScreen() getter reliably reported stale
  // values on Windows even right after its own events fired, so the same
  // pattern is used here defensively rather than trusting the getter.
  win.on("maximize", () => {
    isWindowMaximized = true;
    win.webContents.send("snug:window-maximized", true);
  });
  win.on("unmaximize", () => {
    isWindowMaximized = false;
    win.webContents.send("snug:window-maximized", false);
  });

  return win;
}

// Shown the instant the app launches, before the bundled Next.js server has
// even started listening — createWindow's own window stays hidden (show:
// false) until "ready-to-show", so without this there'd be several seconds
// of complete silence after double-clicking the icon.
// ---- theme ----
// The app's own light/dark choice lives in the web layer's localStorage,
// which these native-side windows (splash, overlay, share picker) can't
// read: they're file:// pages on a different origin entirely. Before this,
// each one just hardcoded a palette — splash was locked light while the
// overlay and share picker were locked dark, so one of them always clashed
// with whatever the user had actually chosen. The renderer reports the
// theme here instead, and it's mirrored to disk so even the splash (which
// is on screen before any renderer has loaded) starts out correct.
const THEME_FILE = path.join(app.getPath("userData"), "theme.json");

function loadUiTheme() {
  try {
    const saved = JSON.parse(fs.readFileSync(THEME_FILE, "utf8"));
    if (saved.theme === "light" || saved.theme === "dark") return saved.theme;
  } catch {
    // Never set before — fall through to the OS preference, which is the
    // same default the web app's own readInitialTheme() lands on.
  }
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

let uiTheme = loadUiTheme();

function setUiTheme(theme) {
  if (theme !== "light" && theme !== "dark") return;
  if (theme === uiTheme) return;
  uiTheme = theme;
  try {
    fs.writeFileSync(THEME_FILE, JSON.stringify({ theme }));
  } catch (err) {
    console.error("[snug-desktop] failed to save theme.json:", err);
  }
  // Only these two outlive a theme change — the splash is long gone by the
  // time anyone can reach the theme switch.
  overlayWindow?.webContents.send("snug:theme", theme);
  sharePickerWindow?.webContents.send("snug:theme", theme);
}

function createSplashWindow() {
  const win = new BrowserWindow({
    width: 320,
    height: 220,
    frame: false,
    transparent: true,
    // false, like every other transparent window here. Windows draws the
    // native shadow against an opaque backing, which shows through
    // wherever the page itself is transparent — as black wedges behind the
    // card's rounded corners. The card draws its own shadow in CSS, so
    // there's nothing to lose by turning this off.
    hasShadow: false,
    // This is the OTHER source of black wedges at the card's corners, and
    // the one that was still there after hasShadow:false: Windows 11
    // (build 22000+) rounds every frameless window's corners itself,
    // independent of anything the page draws. That OS-level clip is a
    // DIFFERENT radius than the card's own CSS border-radius: 28px, so on
    // a fully transparent window the two roundings don't line up, and the
    // sliver between them composites as opaque black instead of see-
    // through. The card already draws its own 28px corners in CSS — the
    // window doesn't need Windows rounding its corners too.
    roundedCorners: false,
    resizable: false,
    movable: true,
    center: true,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "splash.html"), { search: `theme=${uiTheme}` });
  win.on("closed", () => {
    if (splashWindow === win) splashWindow = null;
  });
  splashWindow = win;
  return win;
}

function closeSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

// ---- instant replay: a rolling recording of the last N seconds of the
// primary screen, saved on demand (Nvidia Shadowplay-style). ----
//
// Lives in its own always-present, never-shown window rather than the main
// app window, for two reasons: it needs to keep capturing regardless of
// whether the main window is on the home screen or in a room (or hidden
// entirely, minimized to tray), and getUserMedia/MediaRecorder are
// renderer-only APIs — there's no way to run this from the main process
// itself.
//
// The rolling buffer is a RING OF SHORT SEGMENTS, not one long-running
// recorder that gets trimmed — MediaRecorder's chunked output only stays
// validly playable as a whole if you keep its first chunk (the container
// header), so evicting old chunks from a continuously-running recorder
// would corrupt the file. An earlier version instead restarted a single
// recorder every bufferSeconds, which kept every segment a clean,
// self-contained file but meant "how much history is available" reset to
// 0 right after every restart — a save could come back with far less than
// the requested buffer length depending on timing. Fixed here by keeping
// segments SHORT and FIXED-length (SEGMENT_SECONDS, independent of the
// user's buffer setting) and retaining however many of them cover the
// requested length; a save stitches the needed ones together with
// ffmpeg's stream-copy concat (see buildClipFromRing) — fast and lossless
// since it's a pure remux, no re-encode, and it reuses recording.html's
// existing per-segment file format (self-contained MediaRecorder output)
// rather than needing a different capture pipeline.
const RECORDING_SETTINGS_FILE = path.join(app.getPath("userData"), "recording-settings.json");
// resolution: "auto" (match whatever the screen actually is — no width/
// height constraint passed at all, so Chromium captures at the source's
// own native resolution, 4K screen or otherwise) or one of
// RESOLUTION_PRESETS' keys to force a specific one instead.
const DEFAULT_RECORDING_SETTINGS = {
  enabled: false,
  bufferSeconds: 30,
  resolution: "auto",
  fps: 60,
  // Desktop loopback audio — game sound and anyone you can hear in the
  // room. On by default: a silent gameplay clip is half a clip.
  captureAudio: true,
  // Ceiling for the saved-clips folder in GB; oldest clips are removed once
  // it's exceeded. 0 (the default) means keep everything.
  //
  // Deliberately OFF by default. These are clips someone chose to save —
  // the whole point of the feature — not a cache, and a default that
  // quietly deletes them is the wrong trade even when the folder gets
  // large. Turning it on is a decision the person makes knowing what it
  // does. (Learned the hard way: an earlier 10GB default, exercised during
  // testing, destroyed real recordings.)
  maxStorageGb: 0,
};
const RESOLUTION_PRESETS = {
  720: { width: 1280, height: 720 },
  1080: { width: 1920, height: 1080 },
  1440: { width: 2560, height: 1440 },
  2160: { width: 3840, height: 2160 },
};
// Videos\Snug\recordings — matches the OS convention other capture tools
// (Shadowplay itself included) use, rather than anywhere inside the app's
// own install or userData directories.
const RECORDINGS_DIR = path.join(app.getPath("videos"), "Snug", "recordings");

// How often recording.html rotates to a fresh MediaRecorder segment —
// deliberately short and NOT tied to the user's buffer-length setting
// (that's handled by retention/selection below instead). Short segments
// mean fine-grained trim points (a save is short by at most this many
// seconds, instead of up to the whole buffer length) at the cost of a
// little more per-segment overhead; 3s is a reasonable middle ground.
const SEGMENT_SECONDS = 3;
// Pure scratch space for in-progress segments — never shown to the user,
// cleared on every app start (stale files from a crashed previous run)
// and continuously pruned during normal operation. The final stitched
// clip is what lands in RECORDINGS_DIR.
const SEGMENTS_DIR = path.join(app.getPath("temp"), "snug-instant-replay-segments");

// The ring buffer itself: oldest first. Each entry is one segment's
// already-written-to-disk file plus enough metadata (start/end time, and
// the capture config that produced it) to know which segments are safe to
// concatenate together — ffmpeg's stream-copy concat requires matching
// codec parameters, so a segment from before a resolution/fps change
// can't just be glued to one from after.
let segmentRing = [];
let segmentSeq = 0;
// Resolved when the segment produced by an explicit save request lands —
// see recording:flush-complete below. A plain queue (not correlated by an
// id) is enough here since saves are effectively serialized by the one
// person clicking the one button/shortcut.
let pendingFlushResolvers = [];

function loadRecordingSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(RECORDING_SETTINGS_FILE, "utf8"));
    return { ...DEFAULT_RECORDING_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_RECORDING_SETTINGS };
  }
}

function saveRecordingSettings() {
  try {
    fs.writeFileSync(RECORDING_SETTINGS_FILE, JSON.stringify(recordingSettings));
  } catch (err) {
    console.error("[snug-desktop] failed to save recording-settings.json:", err);
  }
}

let recordingSettings = loadRecordingSettings();

function createRecordingWindow() {
  const win = new BrowserWindow({
    width: 240,
    height: 120,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, "recording-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "recording.html"));
  win.on("closed", () => {
    if (recordingWindow === win) recordingWindow = null;
  });
  recordingWindow = win;
  return win;
}

// display_id matching against desktopCapturer's sources is a best effort —
// falls back to the first screen source (still correct on the very common
// single-monitor case, and a reasonable default otherwise) rather than
// failing outright if it doesn't line up.
async function getPrimaryScreenSourceId() {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1, height: 1 },
  });
  const primary = screen.getPrimaryDisplay();
  const match = sources.find((s) => s.display_id === String(primary.id));
  return (match ?? sources[0])?.id ?? null;
}

async function startRecording() {
  if (!recordingWindow) return;
  const sourceId = await getPrimaryScreenSourceId();
  if (!sourceId) {
    console.error("[snug-desktop] instant replay: no screen source available");
    return;
  }
  // A fresh start invalidates whatever's in the ring — either this is a
  // genuine start (empty already) or a restart after a setting changed
  // (old segments may be a different resolution/fps than what's coming
  // next, so keeping them around would just be dead weight at best).
  resetSegmentRing();
  // "auto" (the default) deliberately sends no width/height at all —
  // recording.html omits the constraint entirely in that case, which is
  // what makes Chromium capture at the source's own true native
  // resolution instead of us having to compute and match it ourselves
  // (DPI scaling makes that error-prone to get right from the main
  // process). A preset forces that specific size instead.
  const preset = RESOLUTION_PRESETS[recordingSettings.resolution];
  recordingWindow.webContents.send("recording:start", {
    sourceId,
    segmentSeconds: SEGMENT_SECONDS,
    fps: recordingSettings.fps,
    captureAudio: recordingSettings.captureAudio !== false,
    width: preset?.width ?? null,
    height: preset?.height ?? null,
  });
}

function stopRecording() {
  recordingWindow?.webContents.send("recording:stop");
  resetSegmentRing();
}

function resetSegmentRing() {
  for (const seg of segmentRing) {
    fs.unlink(seg.file, () => {});
  }
  segmentRing = [];
}

// Drops segments older than the current buffer setting needs (plus a
// couple of segments' worth of slack so a save landing right at the edge
// still has full coverage). Always keeps at least the newest segment
// regardless, so a save right after a buffer-length decrease still has
// something to work with.
function pruneSegmentRing() {
  const retentionMs = (recordingSettings.bufferSeconds + SEGMENT_SECONDS * 2) * 1000;
  const cutoff = Date.now() - retentionMs;
  while (segmentRing.length > 1 && segmentRing[0].endMs < cutoff) {
    const old = segmentRing.shift();
    fs.unlink(old.file, () => {});
  }
}

async function handleSegmentReady({ arrayBuffer, extension, mimeType, width, height, fps, hasAudio, startMs, endMs }) {
  try {
    await fs.promises.mkdir(SEGMENTS_DIR, { recursive: true });
    const file = path.join(SEGMENTS_DIR, `seg-${segmentSeq++}.${extension}`);
    await fs.promises.writeFile(file, Buffer.from(arrayBuffer));
    // Inserted by start time, NOT appended. Two segments can be in flight
    // at once — a save flushes one the instant after a periodic rotation —
    // and since the push happens after the awaits above, whichever write
    // finished first used to land first. An out-of-order ring means ffmpeg
    // concatenates the pieces out of sequence, which is exactly the "video
    // hangs then jumps" a reordered clip produces.
    const entry = { file, mimeType, width, height, fps, hasAudio, startMs, endMs };
    const at = segmentRing.findIndex((seg) => seg.startMs > startMs);
    if (at === -1) segmentRing.push(entry);
    else segmentRing.splice(at, 0, entry);
    pruneSegmentRing();
  } catch (err) {
    console.error("[snug-desktop] failed to persist instant-replay segment:", err);
  }
}

// Walks the ring backward from the newest segment, collecting whole
// segments until they cover at least the requested buffer length — or
// until the ring runs out (e.g. right after enabling, when there isn't
// bufferSeconds of history yet — same fundamental limit as before, just a
// much smaller and rarer window for it now) or a config change is hit
// (different resolution/fps/codec than the newest segment, which ffmpeg's
// stream-copy concat can't join). Either stopping condition means a
// shorter-than-requested clip is the correct answer, not a bug.
function selectSegmentsForConcat() {
  const newest = segmentRing[segmentRing.length - 1];
  if (!newest) return [];
  const wantMs = recordingSettings.bufferSeconds * 1000;
  const selected = [];
  let coveredMs = 0;
  for (let i = segmentRing.length - 1; i >= 0; i--) {
    const seg = segmentRing[i];
    if (
      seg.width !== newest.width ||
      seg.height !== newest.height ||
      seg.fps !== newest.fps ||
      seg.mimeType !== newest.mimeType ||
      seg.hasAudio !== newest.hasAudio
    ) {
      break;
    }
    // Stop at a real hole in the timeline. Segments normally butt up
    // against each other within a few milliseconds; a larger jump means
    // one is missing (a failed write, or pruning that outran the save),
    // and joining across it would produce a clip that freezes and then
    // skips ahead. A shorter but continuous clip is the better answer.
    const next = selected[0];
    if (next && next.startMs - seg.endMs > SEGMENT_SECONDS * 1000) break;
    selected.unshift(seg);
    coveredMs += seg.endMs - seg.startMs;
    if (coveredMs >= wantMs) break;
  }

  // Drop a stub of a first segment. The oldest one in the ring is often a
  // partial — capture started, or a setting changed, partway through its
  // slot — and joining from one produced a multi-second freeze at the head
  // of the clip: the join places the following segment at a full slot's
  // offset, so a 0.9s piece in a 3s slot leaves 2s of nothing. Measured,
  // dropping it took the clip from one 2066ms stall to no gaps at all, at
  // the cost of a second or so off the front.
  if (selected.length > 1) {
    const first = selected[0];
    if (first.endMs - first.startMs < SEGMENT_SECONDS * 1000 * 0.6) selected.shift();
  }
  return selected;
}

// ffmpeg's concat demuxer wants a text file listing input paths, one per
// `file '...'` line — forward slashes and an escaped-single-quote form
// work reliably cross-platform, including on Windows paths.
function concatListLine(filePath) {
  return `file '${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().slice(-500) || err.message));
      else resolve();
    });
  });
}

// Joins the segments WITHOUT re-encoding video, by way of MPEG-TS.
//
// The obvious approach — ffmpeg's concat demuxer straight into MP4 — turns
// out to lose frames. Each segment is an independent recording whose
// timestamps start at zero, and once they're offset and stacked the MP4
// muxer hits DTS values that don't strictly increase and silently drops
// those frames: a measured 7-segment, 707-frame capture came out the other
// side with 604, one frame lost per "non monotonically increasing dts"
// warning. That's the stutter — the gaps land at the seams, so playback
// hangs every few seconds and then catches up.
//
// MPEG-TS is designed to be concatenated (it's how broadcast streams are
// spliced), so remuxing each segment to TS, joining those, and remuxing
// back to MP4 keeps every frame. All three steps are stream copies; the
// only re-encode is the audio, for the reason below. The same 707-frame
// capture comes out as 707 frames with no gaps.
async function concatViaMpegTs(segments, outputPath, workDir) {
  const tsFiles = [];
  try {
    for (const [i, seg] of segments.entries()) {
      const tsPath = path.join(workDir, `join-${Date.now()}-${i}.ts`);
      // h264_mp4toannexb converts the MP4-style length-prefixed NAL units
      // into the start-code form TS expects.
      await runFfmpeg(["-y", "-i", seg.file, "-c", "copy", "-bsf:v", "h264_mp4toannexb", "-f", "mpegts", tsPath]);
      tsFiles.push(tsPath);
    }
    const args = ["-y", "-i", `concat:${tsFiles.join("|")}`, "-c:v", "copy"];
    // Audio is re-encoded rather than copied. Each segment carries its own
    // AAC encoder priming samples, and copying them end to end leaves those
    // embedded mid-file — real output showed decoder errors and a click at
    // every boundary. Re-encoding produces one continuous track, and for a
    // clip this short it's trivial next to the video copy.
    if (segments[0].hasAudio) args.push("-c:a", "aac", "-b:a", "160k");
    args.push(outputPath);
    await runFfmpeg(args);
  } finally {
    for (const f of tsFiles) fs.unlink(f, () => {});
  }
}

// WebM/VP9 can't go through TS, so that fallback path keeps the concat
// demuxer. It's only reached on machines where H.264 recording isn't
// available at all.
async function concatViaDemuxer(segments, outputPath, workDir) {
  const listPath = path.join(workDir, `concat-${Date.now()}.txt`);
  const list = segments.map((s) => concatListLine(s.file)).join("\n");
  await fs.promises.writeFile(listPath, list, "utf8");
  try {
    const args = ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "copy", "-avoid_negative_ts", "make_zero"];
    if (segments[0].hasAudio) args.push("-c:a", "libopus", "-b:a", "160k");
    args.push(outputPath);
    await runFfmpeg(args);
  } finally {
    fs.unlink(listPath, () => {});
  }
}

async function buildClipFromRing() {
  const segments = selectSegmentsForConcat();
  if (segments.length === 0) {
    return { ok: false, error: "Instant replay hasn't captured anything yet — give it a few seconds." };
  }
  const ext = path.extname(segments[0].file);
  await fs.promises.mkdir(RECORDINGS_DIR, { recursive: true });
  const outputPath = path.join(
    RECORDINGS_DIR,
    `snug-replay-${new Date().toISOString().replace(/[:.]/g, "-")}${ext}`,
  );

  try {
    if (ext === ".mp4") await concatViaMpegTs(segments, outputPath, SEGMENTS_DIR);
    else await concatViaDemuxer(segments, outputPath, SEGMENTS_DIR);
    // Size and duration ride along so the app can say what it actually
    // saved rather than just that it saved something — a clip's size is
    // the thing people want to know before sharing it.
    const saved = await fs.promises.stat(outputPath).catch(() => null);
    const coveredMs = segments.reduce((sum, seg) => sum + (seg.endMs - seg.startMs), 0);
    await enforceStorageCap();
    return {
      ok: true,
      path: outputPath,
      bytes: saved?.size ?? 0,
      seconds: Math.round(coveredMs / 1000),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't put the clip together: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Saved clips, oldest first. Only files this app writes are considered —
// anything else a person has put in that folder is theirs and is neither
// counted nor deleted.
async function listSavedClips() {
  try {
    const names = await fs.promises.readdir(RECORDINGS_DIR);
    const clips = await Promise.all(
      names
        .filter((n) => /^snug-replay-.*\.(mp4|webm)$/i.test(n))
        .map(async (name) => {
          const file = path.join(RECORDINGS_DIR, name);
          try {
            const stat = await fs.promises.stat(file);
            return { file, size: stat.size, mtimeMs: stat.mtimeMs };
          } catch {
            return null;
          }
        }),
    );
    return clips.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return [];
  }
}

// Deletes the oldest clips until the folder is back under the cap. Nothing
// else prunes these — segments are temp files that clean themselves up, but
// finished clips accumulate forever, and at roughly a megabyte per second
// of 4K footage that turns into tens of gigabytes quietly. 0 disables the
// cap for anyone who would rather manage the folder themselves.
async function enforceStorageCap() {
  const capGb = recordingSettings.maxStorageGb ?? DEFAULT_RECORDING_SETTINGS.maxStorageGb;
  if (!capGb || capGb <= 0) return;
  const capBytes = capGb * 1024 * 1024 * 1024;
  const clips = await listSavedClips();
  let total = clips.reduce((sum, c) => sum + c.size, 0);
  for (const clip of clips) {
    if (total <= capBytes) break;
    try {
      // shell.trashItem, not fs.unlink: these are things a person chose to
      // keep, so an automatic sweep has to be recoverable. Sending them to
      // the Recycle Bin means a cap set too aggressively is an annoyance
      // rather than permanent data loss.
      await shell.trashItem(clip.file);
      total -= clip.size;
      console.log(
        `[snug-desktop] instant replay over ${capGb}GB — moved ${path.basename(clip.file)} to the Recycle Bin`,
      );
    } catch {
      // Locked by a player or already gone — skip it and keep going rather
      // than aborting the whole sweep.
    }
  }
}

// Mirrors snug/src/lib/formatFileSize.ts — this file is plain CommonJS and
// can't import that module directly, so kept in sync by hand. Only whole
// units matter here (a notification someone glances at mid-game, not a
// precise readout), same as the original.
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// The one surface that actually reaches someone while they're playing:
// Snug's own window is in the background the whole time instant replay is
// useful for, and the overlay (if it's even on) only has room for a button
// flash, no text.
//
// This used to be a native OS notification, and is now Snug's own window so
// it looks like the rest of the app instead of like Windows. Two things
// that buys beyond appearance: Focus Assist auto-enables during fullscreen
// games and silently swallows native toasts — exactly when instant replay
// matters most — and a native toast can't be styled at all. What it costs:
// no entry in Action Center to scroll back to afterwards, and (same
// limitation as the overlay) it can't draw over an EXCLUSIVE fullscreen
// game, only windowed and borderless.
//
// The window flags here are not incidental. focusable: false plus
// showInactive() is the same pairing the overlay needs: without both, a
// window appearing over a game steals keyboard focus the moment it shows,
// which is precisely what broke Alt+F4 and Alt+Tab for this app before.
// setIgnoreMouseEvents keeps it from swallowing clicks aimed at whatever's
// behind it — it's on screen for seconds at a time in a corner someone may
// well be clicking in, and a confirmation message has no business
// intercepting that.
const NOTIFICATION_MS = 4200;
const NOTIFICATION_WIDTH = 380;
const NOTIFICATION_HEIGHT = 130;

function notifyRecordingSaveResult(result) {
  const search = new URLSearchParams({
    theme: uiTheme,
    kind: result.ok ? "ok" : "fail",
    title: result.ok ? "Instant replay saved" : "Couldn't save replay",
    detail: result.ok ? `${result.seconds}s · ${formatBytes(result.bytes)}` : (result.error ?? ""),
    ms: String(NOTIFICATION_MS),
  }).toString();

  // Bottom-right of the WORK area (not the raw screen bounds) so it sits
  // above the taskbar rather than under it, on whichever display is
  // currently primary.
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
  const bounds = {
    x: x + width - NOTIFICATION_WIDTH,
    y: y + height - NOTIFICATION_HEIGHT,
    width: NOTIFICATION_WIDTH,
    height: NOTIFICATION_HEIGHT,
  };

  clearTimeout(notificationTimer);

  // Reuse the existing window when one is still up — a second save landing
  // while the first is on screen should replace it, not stack a second card
  // on top of it. Re-loading the file replays the entrance animation, so it
  // still reads as a new arrival.
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    notificationWindow.setBounds(bounds);
    notificationWindow.loadFile(path.join(__dirname, "notification.html"), { search });
  } else {
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      roundedCorners: false,
      show: false,
      focusable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true, { forward: true });
    win.loadFile(path.join(__dirname, "notification.html"), { search });
    win.once("ready-to-show", () => win.showInactive());
    win.on("closed", () => {
      if (notificationWindow === win) notificationWindow = null;
    });
    notificationWindow = win;
  }

  notificationTimer = setTimeout(() => {
    if (notificationWindow && !notificationWindow.isDestroyed()) notificationWindow.close();
  }, NOTIFICATION_MS);
}

// Broadcasts a save result to every surface that might be showing
// feedback for it — the room's own save button (a brief flash) and the
// overlay's (same), plus a native OS notification for whichever of those
// nobody's actually looking at right now, which mid-game is usually both.
function notifyRecordingResult(result) {
  mainWindow?.webContents.send("recording:saved", result);
  overlayWindow?.webContents.send("overlay:save-result", result);
  notifyRecordingSaveResult(result);
}

function triggerSaveClip() {
  if (!recordingSettings.enabled) {
    notifyRecordingResult({
      ok: false,
      error: "Instant replay is turned off — enable it in Settings first.",
    });
    return;
  }
  if (!recordingWindow) {
    notifyRecordingResult({
      ok: false,
      error: "Instant replay hasn't captured anything yet — give it a few seconds.",
    });
    return;
  }
  // recording.html flushes its current segment early and acks via
  // recording:flush-complete — that segment lands in the ring through the
  // same recording:segment-ready path every other segment uses, so by the
  // time this resolves, buildClipFromRing has everything up to "now" to
  // work with.
  //
  // A flush that came back with nothing (flushResult.flushed === false) is
  // NOT a failed save: the ring is what gets stitched, and it holds every
  // completed segment regardless of how the newest one went. That
  // distinction is the whole reason saving twice in a row used to report
  // "hasn't captured anything yet" while 20+ good seconds sat in the ring
  // untouched — buildClipFromRing below is now the only thing that decides
  // whether there's genuinely nothing to save.
  const flushed = new Promise((resolve) => pendingFlushResolvers.push(resolve));
  recordingWindow.webContents.send("recording:save");
  flushed.then(async (flushResult) => {
    if (!flushResult.ok) {
      notifyRecordingResult(flushResult);
      return;
    }
    notifyRecordingResult(await buildClipFromRing());
  });
}

// A small always-on-top control panel for windowed/borderless games — a
// quarter-circle fan of controls hugging the screen's top-left corner, see
// overlay.html for the shape itself. Pinned exactly to the work area's
// corner (not a fixed 0,0) so it lands correctly on whichever monitor is
// primary, taskbar offsets included. Note this genuinely cannot render over
// an EXCLUSIVE fullscreen game (that needs DirectX/Vulkan hooking, a much
// bigger, separate undertaking); windowed and borderless-windowed games are
// what this actually covers.
const OVERLAY_SIZE = 200;

function createOverlayWindow() {
  const { x, y } = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({
    width: OVERLAY_SIZE,
    height: OVERLAY_SIZE,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    // Belt and braces alongside hasShadow: false — same Windows-11 corner-
    // rounding mismatch as the splash and main windows, just far less
    // visible here since the overlay's content is circular, not a
    // rectangle near the window's own edges.
    roundedCorners: false,
    show: false,
    // Without this, .show() below also FOCUSES the window (that's the
    // default Electron/OS behavior) — combined with alwaysOnTop's
    // "screen-saver" level, that silently stole keyboard focus the instant
    // the overlay appeared, which is why Alt+F4, Shift+Tab and other
    // system/app shortcuts stopped reaching whatever window the user
    // actually meant them for while it was toggled on. A HUD overlay like
    // this should never be able to take focus at all.
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  // Starts click-through — the renderer only turns this off while the
  // cursor is actually within the quarter-circle's radius (see overlay.html
  // and the overlay:set-interactive handler below), so the square window's
  // transparent corner never blocks clicks into the game behind it.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, "overlay.html"), { search: `theme=${uiTheme}` });
  win.on("closed", () => {
    if (overlayWindow === win) overlayWindow = null;
  });
  overlayWindow = win;
}

function toggleOverlay() {
  if (!overlayWindow) return;
  // showInactive (not show) as a second line of defense against the
  // overlay stealing focus, alongside focusable: false above.
  if (overlayWindow.isVisible()) overlayWindow.hide();
  else overlayWindow.showInactive();
}

// Shared by global shortcuts and the overlay's own buttons, so both
// trigger the exact same effect in the app renderer.
function dispatchToApp(channel) {
  mainWindow?.webContents.send(channel);
}

// ---- auto-update ----
// Checks GitHub Releases for a newer build, downloads it in the
// background, and applies it the next time the app quits.
//
// Nothing here ever interrupts: this app is meant to be running while
// you're in a call or a game, so an update is never installed underneath
// you and the app is never restarted for you. The most it does is say
// there's one ready and offer a restart you choose to take.
const { autoUpdater } = require("electron-updater");

// null until a check has run; then one of "checking" | "available" |
// "downloading" | "ready" | "none" | "error". Kept here so a renderer that
// mounts late (the room, or Settings being opened) can ask for the current
// state rather than having missed the event.
let updateState = { state: "idle", version: null, percent: 0 };

function setUpdateState(next) {
  updateState = { ...updateState, ...next };
  mainWindow?.webContents.send("update:status", updateState);
  refreshTrayMenu();
}

function setupAutoUpdate() {
  // Updates only make sense for an installed build — in dev there's no
  // installer to replace, and electron-updater refuses anyway.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  // The default, spelled out because it's the whole safety story: the
  // downloaded installer runs when the app exits, not while it's in use.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => console.log("[updater]", m),
    warn: (m) => console.warn("[updater]", m),
    error: (m) => console.error("[updater]", m),
    debug: () => {},
  };

  autoUpdater.on("checking-for-update", () => setUpdateState({ state: "checking" }));
  autoUpdater.on("update-available", (info) =>
    setUpdateState({ state: "downloading", version: info?.version ?? null, percent: 0 }),
  );
  autoUpdater.on("update-not-available", () => setUpdateState({ state: "none", percent: 0 }));
  autoUpdater.on("download-progress", (p) =>
    setUpdateState({ state: "downloading", percent: Math.round(p?.percent ?? 0) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    setUpdateState({ state: "ready", version: info?.version ?? null, percent: 100 }),
  );
  autoUpdater.on("error", (err) => {
    const message = String(err?.message ?? err);
    // A repo with no releases yet isn't a failure, it just means there's
    // nothing newer than what's already installed — which is what "up to
    // date" means to the person reading it.
    if (message.includes("No published versions")) {
      setUpdateState({ state: "none", percent: 0 });
      return;
    }
    // Anything else is not worth bothering anyone about either — no
    // network, or GitHub having a moment. It retries on the next interval.
    console.error("[updater] check failed:", message);
    setUpdateState({ state: "error" });
  });

  // Not at launch: the first seconds are busy starting the bundled server
  // and painting the window, and an update can wait.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 20_000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

// Quitting through this path lets electron-updater swap the app in on the
// way out — isQuitting first so the window's close handler doesn't just
// hide it and leave the install waiting forever.
function quitAndInstallUpdate() {
  if (updateState.state !== "ready") return;
  isQuitting = true;
  autoUpdater.quitAndInstall();
}

ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("update:get-status", () => updateState);
ipcMain.handle("update:check", async () => {
  if (!app.isPackaged) return { ...updateState, state: "dev" };
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    setUpdateState({ state: "error" });
  }
  return updateState;
});
ipcMain.on("update:restart", () => quitAndInstallUpdate());

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "Show Snug",
      click: () => {
        if (!mainWindow) return;
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: "separator" },
    {
      label: lastMuteState ? "Unmute" : "Mute",
      click: () => dispatchToApp("snug:mute-self-toggle"),
    },
    {
      label: "Deafen (mute everyone)",
      click: () => dispatchToApp("snug:mute-all-toggle"),
    },
    {
      label: "Toggle Overlay",
      click: () => toggleOverlay(),
    },
    { type: "separator" },
    // Instant replay captures the screen continuously with no window and
    // no visible sign of it. Somebody who forgot they switched it on
    // deserves to be able to find that out — and to switch it back off
    // without hunting through Settings.
    ...(recordingSettings.enabled
      ? [
          {
            label: "Instant replay is recording — turn off",
            click: () => {
              recordingSettings = { ...recordingSettings, enabled: false };
              saveRecordingSettings();
              stopRecording();
              refreshTrayMenu();
              mainWindow?.webContents.send("recording:settings-changed", recordingSettings);
            },
          },
          {
            label: "Save instant replay",
            click: () => triggerSaveClip(),
          },
          { type: "separator" },
        ]
      : []),
    ...(updateState.state === "ready"
      ? [
          {
            label: `Restart to update${updateState.version ? ` to ${updateState.version}` : ""}`,
            click: () => quitAndInstallUpdate(),
          },
          { type: "separator" },
        ]
      : []),
    {
      label: "Quit Snug",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "assets", "tray-icon.png");
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("Snug");
  refreshTrayTooltip();
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

function refreshTrayMenu() {
  tray?.setContextMenu(buildTrayMenu());
  refreshTrayTooltip();
}

function refreshTrayTooltip() {
  tray?.setToolTip(recordingSettings.enabled ? "Snug — instant replay is recording" : "Snug");
}

// The whole point of these is working without switching focus to Snug —
// each just forwards to the renderer (which already knows how to act on it,
// same code path as the in-app buttons) or, for the overlay, toggles it
// directly since that's purely a main-process-owned window. Registered
// globally (OS-wide), so they fire even while a game has focus.
//
// Keyed by a stable action id rather than by accelerator, since the whole
// point of the section below is that the accelerator itself is user-
// changeable — see shortcuts.json in userData, loaded into
// shortcutBindings at startup and rewritten by snug:set-shortcut.
const SHORTCUT_ACTIONS = {
  muteSelf: { channel: "snug:mute-self-toggle", label: "Mute / unmute microphone" },
  muteAll: { channel: "snug:mute-all-toggle", label: "Deafen (mute everyone, for you only)" },
  startShare: { channel: "snug:start-share", label: "Start screen share" },
  toggleOverlay: { special: "overlay", label: "Show / hide the overlay" },
  saveReplay: { special: "saveReplay", label: "Save instant replay" },
};

const DEFAULT_SHORTCUTS = {
  muteSelf: "CommandOrControl+Shift+M",
  muteAll: "CommandOrControl+Shift+D",
  startShare: "CommandOrControl+Shift+S",
  toggleOverlay: "CommandOrControl+Shift+O",
  saveReplay: "CommandOrControl+Shift+R",
};

const SHORTCUTS_FILE = path.join(app.getPath("userData"), "shortcuts.json");

function loadShortcutBindings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SHORTCUTS_FILE, "utf8"));
    // Spread over the defaults (not the other way) so an older save missing
    // an action added in a later version still gets that action's default
    // instead of silently going unregistered.
    return { ...DEFAULT_SHORTCUTS, ...saved };
  } catch {
    return { ...DEFAULT_SHORTCUTS };
  }
}

function saveShortcutBindings() {
  try {
    fs.writeFileSync(SHORTCUTS_FILE, JSON.stringify(shortcutBindings));
  } catch (err) {
    console.error("[snug-desktop] failed to save shortcuts.json:", err);
  }
}

let shortcutBindings = loadShortcutBindings();

function shortcutHandler(action) {
  const entry = SHORTCUT_ACTIONS[action];
  if (entry.special === "overlay") return () => toggleOverlay();
  if (entry.special === "saveReplay") return () => triggerSaveClip();
  return () => dispatchToApp(entry.channel);
}

function registerGlobalShortcuts() {
  globalShortcut.unregisterAll();
  for (const [action, accelerator] of Object.entries(shortcutBindings)) {
    if (!accelerator || !SHORTCUT_ACTIONS[action]) continue;
    const ok = globalShortcut.register(accelerator, shortcutHandler(action));
    if (!ok) {
      console.error(`[snug-desktop] failed to register shortcut ${action}: ${accelerator}`);
    }
  }
}

ipcMain.on("snug:mute-state", (_event, muted) => {
  lastMuteState = !!muted;
  refreshTrayMenu();
  overlayWindow?.webContents.send("overlay:mute-state", lastMuteState);
});

ipcMain.on("overlay:set-interactive", (_event, interactive) => {
  overlayWindow?.setIgnoreMouseEvents(!interactive, { forward: true });
});

ipcMain.on("snug:toggle-overlay", () => toggleOverlay());

ipcMain.handle("snug:get-shortcuts", () => ({
  bindings: shortcutBindings,
  defaults: DEFAULT_SHORTCUTS,
  actions: Object.fromEntries(Object.entries(SHORTCUT_ACTIONS).map(([id, v]) => [id, v.label])),
}));

// Rebinding an action: unregister its current accelerator, try registering
// the new one, and only persist + keep it if that actually succeeded — a
// combination already claimed by the OS or another app makes
// globalShortcut.register return false rather than throw, so the old
// binding is restored rather than leaving the action with nothing at all.
ipcMain.handle("snug:set-shortcut", (_event, { action, accelerator } = {}) => {
  if (!SHORTCUT_ACTIONS[action]) return { ok: false, error: "Unknown shortcut." };
  if (!accelerator) return { ok: false, error: "No key combination given." };

  const conflict = Object.entries(shortcutBindings).find(
    ([otherAction, otherAccelerator]) => otherAction !== action && otherAccelerator === accelerator,
  );
  if (conflict) {
    return { ok: false, error: `Already used by "${SHORTCUT_ACTIONS[conflict[0]].label}".` };
  }

  const previous = shortcutBindings[action];
  const handler = shortcutHandler(action);
  if (previous) globalShortcut.unregister(previous);

  const ok = globalShortcut.register(accelerator, handler);
  if (!ok) {
    if (previous) globalShortcut.register(previous, handler);
    return { ok: false, error: "That combination is already in use by another app." };
  }

  shortcutBindings[action] = accelerator;
  saveShortcutBindings();
  return { ok: true, bindings: shortcutBindings };
});

ipcMain.handle("snug:reset-shortcuts", () => {
  shortcutBindings = { ...DEFAULT_SHORTCUTS };
  saveShortcutBindings();
  registerGlobalShortcuts();
  return shortcutBindings;
});

ipcMain.on("snug:deafen-state", (_event, deafened) => {
  lastDeafenState = !!deafened;
  overlayWindow?.webContents.send("overlay:deafen-state", lastDeafenState);
});

// The web layer owns the theme choice; this is how the native-side windows
// find out about it. See setUiTheme's own comment.
ipcMain.on("snug:report-theme", (_event, theme) => setUiTheme(theme));

// The custom title bar's own buttons (see DesktopTitleBar.tsx) — close
// reuses the exact same "close" handler as the native X would have, which
// already hides-to-tray instead of quitting.
ipcMain.on("snug:window-minimize", () => mainWindow?.minimize());
ipcMain.on("snug:window-maximize-toggle", () => {
  if (!mainWindow) return;
  if (isWindowMaximized) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("snug:window-close", () => mainWindow?.close());
ipcMain.handle("snug:window-is-maximized", () => isWindowMaximized);
// The renderer calls this on every route change — see the compact/full
// split in applyWindowMode above (join/create + My Rooms vs. the room
// itself).
ipcMain.on("snug:window-mode", (_event, mode) => applyWindowMode(mode));

// The compact window's real sizing mechanism — see useDesktopContentSize.ts,
// which reports the actual card height via ResizeObserver on mount and on
// every change (e.g. switching from "Join a room" to the taller "Create a
// room" form). Ignored while in full/room mode, where the window is a
// fixed, user-resizable size instead.
ipcMain.on("snug:content-size", (_event, height) => {
  if (currentWindowMode !== "compact" || !mainWindow) return;
  const clamped = Math.max(420, Math.min(920, Math.round(height)));
  if (clamped === lastCompactHeight) return;
  lastCompactHeight = clamped;
  mainWindow.setResizable(true);
  mainWindow.setContentSize(WINDOW_MODES.compact.width, clamped);
  mainWindow.setResizable(false);
  mainWindow.center();
});

// Manual edge/corner resize for the room ("full") window — normally
// resizable: true alone would be enough, but this window is also
// transparent: true (needed for the borderless floating card on the
// compact screens, see createWindow above), and on Windows a transparent
// BrowserWindow doesn't get the OS's usual WM_NCHITTEST edge hit-testing,
// so dragging its edges silently does nothing. ResizeHandles.tsx renders
// invisible strips around the room view's edges that drive this instead —
// resize-start records where the drag began, resize-move (pinged on every
// mousemove while dragging) reads the cursor's current screen position
// itself and recomputes bounds from the delta, resize-end clears it.
let resizeSession = null;

ipcMain.on("snug:resize-start", (_event, edge) => {
  if (!mainWindow || currentWindowMode !== "full") return;
  resizeSession = { edge, startBounds: mainWindow.getBounds(), startCursor: screen.getCursorScreenPoint() };
});

ipcMain.on("snug:resize-move", () => {
  if (!resizeSession || !mainWindow) return;
  const cursor = screen.getCursorScreenPoint();
  const dx = cursor.x - resizeSession.startCursor.x;
  const dy = cursor.y - resizeSession.startCursor.y;
  const { x, y, width, height } = resizeSession.startBounds;
  const next = { x, y, width, height };

  if (resizeSession.edge.includes("e")) next.width = Math.max(MIN_WINDOW_WIDTH, width + dx);
  if (resizeSession.edge.includes("s")) next.height = Math.max(MIN_WINDOW_HEIGHT, height + dy);
  if (resizeSession.edge.includes("w")) {
    next.width = Math.max(MIN_WINDOW_WIDTH, width - dx);
    next.x = x + (width - next.width);
  }
  if (resizeSession.edge.includes("n")) {
    next.height = Math.max(MIN_WINDOW_HEIGHT, height - dy);
    next.y = y + (height - next.height);
  }
  mainWindow.setBounds(next);
});

ipcMain.on("snug:resize-end", () => {
  resizeSession = null;
});

// The overlay's own buttons — routed through the same dispatch as a global
// shortcut, so clicking "Mute" in the overlay behaves identically to
// pressing the hotkey.
ipcMain.on("overlay:request-mute-self", () => dispatchToApp("snug:mute-self-toggle"));
ipcMain.on("overlay:request-mute-all", () => dispatchToApp("snug:mute-all-toggle"));
ipcMain.on("overlay:request-share", () => dispatchToApp("snug:start-share"));
ipcMain.on("overlay:request-save-replay", () => triggerSaveClip());

// ---- instant replay IPC: Settings' toggle/buffer-length controls, the
// recording window reporting its own writes, and every surface that can
// trigger a save (the overlay button above, the global shortcut, and a
// manual "Save clip now" from Settings itself). ----
ipcMain.handle("recording:get-settings", () => recordingSettings);

ipcMain.handle("recording:set-settings", (_event, next) => {
  const wasEnabled = recordingSettings.enabled;
  const prevResolution = recordingSettings.resolution;
  const prevFps = recordingSettings.fps;
  const prevCaptureAudio = recordingSettings.captureAudio;
  recordingSettings = { ...recordingSettings, ...next };
  saveRecordingSettings();
  // The tray and the room's REC badge both state whether capture is live,
  // so both have to hear about this — wherever the change came from.
  refreshTrayMenu();
  mainWindow?.webContents.send("recording:settings-changed", recordingSettings);
  if (recordingSettings.enabled && !wasEnabled) {
    startRecording();
  } else if (!recordingSettings.enabled && wasEnabled) {
    stopRecording();
  } else if (
    recordingSettings.enabled &&
    (recordingSettings.resolution !== prevResolution ||
      recordingSettings.fps !== prevFps ||
      recordingSettings.captureAudio !== prevCaptureAudio)
  ) {
    // Resolution/fps changed while already running — these change the
    // encoder config, so segments already in the ring are no longer
    // compatible with the ones about to be produced, and a restart is the
    // correct response. A buffer-LENGTH-only change deliberately does NOT
    // restart: pruneSegmentRing/selectSegmentsForConcat both read
    // recordingSettings.bufferSeconds live, so it takes effect on the very
    // next prune/save without throwing away any history — restarting here
    // would defeat a chunk of the point of the ring buffer existing.
    startRecording();
  }
  return recordingSettings;
});

ipcMain.on("recording:save-clip", () => triggerSaveClip());

ipcMain.handle("recording:open-folder", async () => {
  await fs.promises.mkdir(RECORDINGS_DIR, { recursive: true }).catch(() => {});
  return shell.openPath(RECORDINGS_DIR);
});

// What the folder currently holds, so Settings can show it rather than
// leaving people to discover tens of gigabytes on their own — at 4K a clip
// runs roughly a megabyte per second, which adds up much faster than it
// feels like it should.
ipcMain.handle("recording:get-usage", async () => {
  const clips = await listSavedClips();
  return {
    count: clips.length,
    bytes: clips.reduce((sum, c) => sum + c.size, 0),
    capGb: recordingSettings.maxStorageGb ?? DEFAULT_RECORDING_SETTINGS.maxStorageGb,
  };
});

// Every finished segment recording.html produces (periodic or
// save-triggered) arrives here to be written into the ring — see
// handleSegmentReady above.
ipcMain.on("recording:segment-ready", (_event, payload) => {
  handleSegmentReady(payload);
});

// Acks a save request specifically (as opposed to segment-ready, which
// fires for every segment regardless of why it ended) — see the matching
// promise in triggerSaveClip above.
ipcMain.on("recording:flush-complete", (_event, result) => {
  const resolve = pendingFlushResolvers.shift();
  if (resolve) resolve(result);
});

// getDisplayMedia() (screen sharing, via SharePickerModal -> useVoiceRoom)
// has no native picker in Electron on Windows/Linux — useSystemPicker only
// covers macOS 15+ (and when it applies, Electron skips this handler
// entirely in favor of the real OS picker). Everywhere else, WE are the
// picker: enumerate real sources with desktopCapturer and show our own
// styled window (share-picker.html) so the user actually gets a choice,
// instead of the previous callback({}) — which resolved with no video
// track at all and silently failed every time.
let pendingShareCallback = null;
let shareSources = new Map();

// Resolves whatever's pending exactly once and clears it — every exit path
// below (pick, cancel, closed-without-picking, a second share request
// arriving) goes through this instead of touching pendingShareCallback
// directly, so it can never be double-resolved.
//
// Cancelling means calling the callback with NO arguments. Verified against
// Electron 44: callback({}) throws "Video was requested, but no video stream
// was provided" and callback({ video: null }) throws "video must be a
// WebFrameMain or DesktopCapturerSource", both as uncaught exceptions in the
// main process — which Electron puts on screen as a modal "A JavaScript error
// occurred in the main process" dialog, mid-call. callback() returns cleanly
// and still rejects the renderer's getDisplayMedia() (with AbortError), so
// nothing is left hanging.
function resolvePendingShare(result) {
  const cb = pendingShareCallback;
  pendingShareCallback = null;
  if (!cb) return;
  try {
    cb(result);
  } catch (err) {
    // Belt and braces for the above: whatever goes wrong in here, it must
    // not reach the top of the main process and become that dialog.
    console.error("[snug-desktop] display-media callback failed", err);
  }
}

async function openSharePicker(callback) {
  // A previous picker window can still be referenced here even after it's
  // gone — Electron's own "closed" event is asynchronous, so a fast second
  // "change screen" click can arrive before that cleanup runs. Calling
  // .focus() (or anything else) on an already-destroyed BrowserWindow
  // throws, which is exactly what broke every share attempt after the
  // first: the thrown error left pendingShareCallback pointing at a
  // callback that could now never resolve, wedging every later click.
  if (sharePickerWindow && !sharePickerWindow.isDestroyed()) {
    resolvePendingShare();
    pendingShareCallback = callback;
    sharePickerWindow.focus();
    return;
  }
  sharePickerWindow = null;
  pendingShareCallback = callback;

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    });
  } catch (err) {
    console.error("[snug-desktop] failed to enumerate share sources", err);
    resolvePendingShare();
    return;
  }
  shareSources = new Map(sources.map((s) => [s.id, s]));

  const win = new BrowserWindow({
    width: 720,
    height: 560,
    parent: mainWindow ?? undefined,
    modal: !!mainWindow,
    frame: false,
    resizable: false,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "share-picker-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.loadFile(path.join(__dirname, "share-picker.html"), { search: `theme=${uiTheme}` });
  win.on("closed", () => {
    if (sharePickerWindow === win) sharePickerWindow = null;
    // Closed without picking anything (Alt+F4, etc.) — resolve as a
    // cancel so the renderer's getDisplayMedia() rejects cleanly instead
    // of hanging forever waiting on a callback that'll never come. A no-op
    // if pick/cancel already resolved it — resolvePendingShare only ever
    // fires whatever's still actually pending.
    resolvePendingShare();
  });
  sharePickerWindow = win;
}

// Safe even if the window is already gone (destroyed-window methods throw
// otherwise) — every caller below goes through this instead of touching
// sharePickerWindow.close() directly.
function closeSharePickerWindow() {
  if (sharePickerWindow && !sharePickerWindow.isDestroyed()) sharePickerWindow.close();
  sharePickerWindow = null;
}

ipcMain.handle("share-picker:get-sources", () =>
  [...shareSources.values()].map((s) => ({
    id: s.id,
    name: s.name,
    isScreen: s.id.startsWith("screen:"),
    thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
    appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  })),
);

ipcMain.on("share-picker:pick", (_event, sourceId) => {
  const source = shareSources.get(sourceId);
  resolvePendingShare(source ? { video: source } : undefined);
  closeSharePickerWindow();
});

ipcMain.on("share-picker:cancel", () => {
  resolvePendingShare();
  closeSharePickerWindow();
});

function setupScreenShareSupport() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => openSharePicker(callback),
    { useSystemPicker: true },
  );
}

// Without this, launching the app a second time (e.g. Start Menu shortcut
// while it's already sitting in the tray) would try to bind the same
// port and re-register the same global shortcuts — both fail the second
// time round. Instead, a second launch just focuses the existing window.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // Electron auto-installs a default File/Edit/View/Window menu (with
    // its own accelerators — Ctrl+R reload, Ctrl+Shift+I DevTools, etc.)
    // unless something explicitly replaces or clears it. frame: false only
    // hides the menu BAR — those accelerators stay live regardless, which
    // is exactly the kind of unrelated-key-combo interference the custom
    // title bar and globalShortcut registrations were never meant to
    // coexist with. The app draws 100% of its own UI, so there's nothing
    // for a menu (visible or invisible) to usefully do here.
    Menu.setApplicationMenu(null);
    // Pure scratch space (see SEGMENTS_DIR above) — wiped on every start so
    // a crash mid-session never leaves orphaned segment files behind.
    fs.rmSync(SEGMENTS_DIR, { recursive: true, force: true });
    createSplashWindow();
    startFrontendServer();
    createWindow().catch((err) => {
      console.error("[snug-desktop] createWindow failed:", err);
      closeSplashWindow();
    });
    createOverlayWindow();
    createRecordingWindow().webContents.once("did-finish-load", () => {
      // Only actually arms the capture if the user had it on last session
      // — the window itself always exists (cheap, hidden), but getUserMedia
      // doesn't run until this says so.
      if (recordingSettings.enabled) startRecording();
    });
    registerGlobalShortcuts();
    createTray();
    setupScreenShareSupport();
    setupAutoUpdate();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("before-quit", () => {
  isQuitting = true;
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});
