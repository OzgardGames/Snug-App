// "What are you playing right now", answered by looking at the foreground
// window's process.
//
// ponytail: this is a HEURISTIC, not a game database. Discord ships a
// curated list of thousands of executables; this just assumes that a
// foreground window which isn't one of the everyday desktop apps below is
// probably the thing you're doing. It will occasionally name something
// that isn't a game. The upgrade path, if that becomes annoying, is a real
// executable->title list, not more clever filtering.
//
// PowerShell rather than a native module: adding node-gyp and a prebuilt
// binary per architecture to this app, for one string every few seconds, is
// a far bigger cost than one short-lived process on a timer.
const { execFile } = require("node:child_process");

// Things that are definitely not "playing something" — the shell, browsers,
// editors, chat apps, and Snug itself. Matched on the executable name,
// lowercased, without .exe.
const IGNORED = new Set([
  "explorer", "searchhost", "shellexperiencehost", "startmenuexperiencehost",
  "applicationframehost", "textinputhost", "lockapp", "systemsettings",
  "snug", "electron", "chrome", "msedge", "firefox", "brave", "opera", "vivaldi",
  "code", "devenv", "rider64", "idea64", "pycharm64", "webstorm64", "sublime_text",
  "discord", "slack", "teams", "zoom", "spotify", "steam", "steamwebhelper",
  "epicgameslauncher", "battle.net", "riotclientux", "obs64", "notepad", "cmd",
  "powershell", "windowsterminal", "taskmgr", "dwm", "sihost",
  // Everyday desktop apps that a foreground check happily calls a game —
  // found by running the detector and watching what it reported. Matters
  // more now that a detection sticks around after you alt-tab away from it.
  "claude", "chatgpt", "notion", "obsidian", "whatsapp", "telegram", "signal",
  "outlook", "winword", "excel", "powerpnt", "acrobat", "vlc", "msteams",
  "figma", "postman", "docker desktop", "nvidia app", "nvidia overlay",
]);

// Turns "EldenRing" / "elden_ring" into something worth showing next to a
// name.
//
// Deliberately the EXECUTABLE name, never the window title. Titles are
// whatever the app decided to put there — a document name, a browser tab, a
// file path — and this string gets broadcast to everyone in the room. An
// earlier version preferred the title and, on the first real test, happily
// returned a browser tab's full title. The exe name says "Elden Ring"
// without also saying what you were reading.
function presentable(exeName) {
  return exeName
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

// Reports the foreground process name, plus whether the process we last
// called a game is still running. That second half is what makes the answer
// survive alt-tabbing INTO Snug: without it, checking the room made the
// foreground app "snug", which is ignored, which cleared your own game from
// your own tiles the moment you looked at them.
const SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@
$h = [FG]::GetForegroundWindow()
$pid_ = 0
[void][FG]::GetWindowThreadProcessId($h, [ref]$pid_)
$p = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
if ($p) { "FG:" + $p.ProcessName }
if ($env:SNUG_STICKY) {
  if (Get-Process -Name $env:SNUG_STICKY -ErrorAction SilentlyContinue) { "ALIVE:1" }
}
`;

// The executable we last decided was a game. Passed back into the script as
// an environment variable, never interpolated into it — and only when it
// looks like a plain process name, so a bizarrely-named executable degrades
// to "no stickiness" instead of anywhere near the shell.
let stickyExe = null;
const PLAIN_NAME = /^[A-Za-z0-9 ._-]+$/;

/**
 * Resolves to a display string for whatever this machine is playing, or null
 * when the foreground is an everyday app and no previously-detected game is
 * still running (or anything goes wrong — this is presence garnish, and must
 * never be the reason something else breaks).
 */
function detectForegroundGame() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      {
        timeout: 4000,
        windowsHide: true,
        env: {
          ...process.env,
          SNUG_STICKY: stickyExe && PLAIN_NAME.test(stickyExe) ? stickyExe : "",
        },
      },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const lines = stdout.split(/\r?\n/).map((l) => l.trim());
        const foreground = (lines.find((l) => l.startsWith("FG:")) || "").slice(3);
        const stickyAlive = lines.includes("ALIVE:1");

        if (foreground && !IGNORED.has(foreground.toLowerCase())) {
          stickyExe = foreground;
        } else if (!stickyAlive) {
          stickyExe = null;
        }
        resolve(stickyExe ? presentable(stickyExe) || null : null);
      },
    );
  });
}

module.exports = { detectForegroundGame };
