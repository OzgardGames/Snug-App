"use client";

import { useEffect, useState } from "react";
import { Toggle } from "@/components/Toggle";
import { getDesktopBridge } from "@/lib/desktopBridge";
import { formatFileSize } from "@/lib/formatFileSize";
import type {
  RecordingResolution,
  RecordingSettings as RecordingSettingsValue,
  RecordingUsage,
} from "@/lib/desktopBridge";

const BUFFER_OPTIONS = [10, 20, 30] as const;
const FPS_OPTIONS = [30, 60] as const;
// "No limit" leads because it's the default: these are clips someone chose
// to keep, so trimming them is opt-in, not something that happens quietly.
const STORAGE_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "No limit" },
  { value: 5, label: "5 GB" },
  { value: 10, label: "10 GB" },
  { value: 25, label: "25 GB" },
];
const RESOLUTION_OPTIONS: { value: RecordingResolution; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: 720, label: "720p" },
  { value: 1080, label: "1080p" },
  { value: 1440, label: "1440p" },
  { value: 2160, label: "4K" },
];

// Desktop-only, same reasoning as ShortcutSettings — the actual capture is
// a main-process/Electron concept (getUserMedia running in a hidden
// window), nothing here has a browser-tab equivalent.
export function RecordingSettings() {
  const [settings, setSettings] = useState<RecordingSettingsValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [usage, setUsage] = useState<RecordingUsage | null>(null);

  function refreshUsage() {
    getDesktopBridge()?.getRecordingUsage().then(setUsage).catch(() => {});
  }

  useEffect(() => {
    getDesktopBridge()
      ?.getRecordingSettings()
      .then(setSettings)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    return bridge.onRecordingSaved((result) => {
      setTestResult(
        result.ok ? { ok: true, message: `Saved: ${result.path}` } : { ok: false, message: result.error },
      );
      // A save just changed what's on disk, and may have pruned older
      // clips to stay under the cap.
      refreshUsage();
    });
  }, []);

  // The tray can turn recording off without going through this panel.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    return bridge.onRecordingSettingsChanged(setSettings);
  }, []);

  useEffect(() => {
    refreshUsage();
  }, []);

  function update(next: Partial<RecordingSettingsValue>) {
    const bridge = getDesktopBridge();
    if (!bridge || !settings) return;
    const merged = { ...settings, ...next };
    setSettings(merged); // optimistic — main.js is the source of truth and corrects this if it disagrees
    setSaving(true);
    bridge
      .setRecordingSettings(next)
      .then(setSettings)
      .finally(() => setSaving(false));
  }

  if (!settings) return null;

  return (
    <section>
      <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
        Instant Replay
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
          <div className="min-w-0 pr-3">
            <div className="text-[13.5px] font-bold text-snug-text">Record in the background</div>
            <div className="text-[11px] font-bold text-snug-muted">
              Keeps the last few seconds of your screen ready to save — like Shadowplay
            </div>
          </div>
          <Toggle
            checked={settings.enabled}
            onChange={() => update({ enabled: !settings.enabled })}
            label="Record in the background"
          />
        </div>

        {settings.enabled && (
          <>
            <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
              <span className="text-[13.5px] font-bold text-snug-text">Buffer length</span>
              <div className="flex gap-1.5">
                {BUFFER_OPTIONS.map((seconds) => {
                  const active = settings.bufferSeconds === seconds;
                  return (
                    <button
                      key={seconds}
                      type="button"
                      disabled={saving}
                      onClick={() => update({ bufferSeconds: seconds })}
                      className="rounded-xl px-3 py-1.5 text-[12.5px] font-extrabold transition active:scale-95 disabled:opacity-60"
                      style={{
                        background: active ? "var(--snug-primary)" : "var(--snug-bg)",
                        color: active ? "var(--snug-primary-text)" : "var(--snug-text)",
                      }}
                    >
                      {seconds}s
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-2xl bg-snug-chip px-3.5 py-3">
              <div className="text-[13.5px] font-bold text-snug-text">Resolution</div>
              <div className="mt-0.5 text-[11px] font-bold text-snug-muted">
                {settings.resolution === "auto"
                  ? "Matches your screen — a 4K display records in 4K."
                  : "Recorded at this size whatever your screen is."}
              </div>
              <div className="mt-2.5 flex gap-1.5">
                {RESOLUTION_OPTIONS.map(({ value, label }) => {
                  const active = settings.resolution === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={saving}
                      onClick={() => update({ resolution: value })}
                      className="flex-1 rounded-xl px-1.5 py-1.5 text-[12px] font-extrabold transition active:scale-95 disabled:opacity-60"
                      style={{
                        background: active ? "var(--snug-primary)" : "var(--snug-bg)",
                        color: active ? "var(--snug-primary-text)" : "var(--snug-text)",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
              <span className="text-[13.5px] font-bold text-snug-text">Frame rate</span>
              <div className="flex gap-1.5">
                {FPS_OPTIONS.map((fps) => {
                  const active = settings.fps === fps;
                  return (
                    <button
                      key={fps}
                      type="button"
                      disabled={saving}
                      onClick={() => update({ fps })}
                      className="rounded-xl px-3 py-1.5 text-[12.5px] font-extrabold transition active:scale-95 disabled:opacity-60"
                      style={{
                        background: active ? "var(--snug-primary)" : "var(--snug-bg)",
                        color: active ? "var(--snug-primary-text)" : "var(--snug-text)",
                      }}
                    >
                      {fps} fps
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
              <div className="min-w-0 pr-3">
                <div className="text-[13.5px] font-bold text-snug-text">Record system audio</div>
                <div className="text-[11px] font-bold text-snug-muted">
                  Game sound and anyone you can hear in the room. Your own mic isn&apos;t included.
                </div>
              </div>
              <Toggle
                checked={settings.captureAudio}
                onChange={() => update({ captureAudio: !settings.captureAudio })}
                label="Record system audio"
              />
            </div>

            <div className="rounded-2xl bg-snug-chip px-3.5 py-3">
              <div className="text-[13.5px] font-bold text-snug-text">Storage limit</div>
              <div className="mt-0.5 text-[11px] font-bold text-snug-muted">
                {settings.maxStorageGb > 0
                  ? `Once saved clips pass ${settings.maxStorageGb} GB, the oldest are moved to the Recycle Bin to make room.`
                  : "Saved clips are kept until you delete them yourself."}
              </div>

              <div className="mt-2.5 flex items-center gap-2 rounded-xl bg-snug-bg px-3 py-2">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-snug-muted">
                  <ellipse cx="12" cy="6" rx="8" ry="3" />
                  <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
                  <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
                </svg>
                <span className="text-[11.5px] font-bold text-snug-muted">
                  {usage
                    ? `Using ${formatFileSize(usage.bytes)} across ${usage.count} clip${usage.count === 1 ? "" : "s"}`
                    : "Checking folder…"}
                  {settings.maxStorageGb > 0 ? ` of ${settings.maxStorageGb} GB` : ""}
                </span>
              </div>

              <div className="mt-2.5 flex gap-1.5">
                {STORAGE_OPTIONS.map(({ value, label }) => {
                  const active = settings.maxStorageGb === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={saving}
                      onClick={() => update({ maxStorageGb: value })}
                      className="flex-1 rounded-xl px-2 py-1.5 text-[12px] font-extrabold transition active:scale-95 disabled:opacity-60"
                      style={{
                        background: active ? "var(--snug-primary)" : "var(--snug-bg)",
                        color: active ? "var(--snug-primary-text)" : "var(--snug-text)",
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setTestResult(null);
                  getDesktopBridge()?.saveReplayNow();
                }}
                className="flex-1 rounded-2xl bg-snug-chip px-3.5 py-2.5 text-center text-[12.5px] font-extrabold text-snug-text transition active:scale-95"
              >
                Save clip now
              </button>
              <button
                type="button"
                onClick={() => getDesktopBridge()?.openRecordingsFolder()}
                className="flex-1 rounded-2xl bg-snug-chip px-3.5 py-2.5 text-center text-[12.5px] font-extrabold text-snug-text transition active:scale-95"
              >
                Open folder
              </button>
            </div>

            {testResult && (
              <p
                className="px-1 text-xs font-semibold break-all"
                style={{ color: testResult.ok ? "var(--snug-mint)" : "var(--snug-pink)" }}
              >
                {testResult.message}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
