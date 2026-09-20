"use client";

// The desktop app's preload script exposes this on `window.snugDesktop`. In
// a plain browser tab it's simply undefined — every caller here goes
// through getDesktopBridge() so the web app behaves exactly as before with
// zero desktop-specific code paths when it isn't present.
export type ShortcutBindings = Record<string, string>;
export type ShortcutInfo = {
  bindings: ShortcutBindings;
  defaults: ShortcutBindings;
  // action id -> human-readable label, e.g. "muteSelf" -> "Mute / unmute microphone"
  actions: Record<string, string>;
};
export type SetShortcutResult =
  | { ok: true; bindings: ShortcutBindings }
  | { ok: false; error: string };

export type RecordingResolution = "auto" | 720 | 1080 | 1440 | 2160;
export type RecordingSettings = {
  enabled: boolean;
  bufferSeconds: number;
  resolution: RecordingResolution;
  fps: 30 | 60;
  /** Desktop loopback audio — game sound plus anyone audible in the room. */
  captureAudio: boolean;
  /** Ceiling for the saved-clips folder, in GB. 0 keeps everything. */
  maxStorageGb: number;
};
export type RecordingUsage = { count: number; bytes: number; capGb: number };
export type RecordingSaveResult = { ok: true; path: string } | { ok: false; error: string };

export type SnugDesktopBridge = {
  isDesktop: true;
  onGlobalMuteSelfToggle: (callback: () => void) => () => void;
  onGlobalMuteAllToggle: (callback: () => void) => () => void;
  onGlobalStartShare: (callback: () => void) => () => void;
  reportMuteState: (muted: boolean) => void;
  reportDeafenState: (deafened: boolean) => void;
  reportTheme: (theme: "light" | "dark") => void;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
  setWindowMode: (mode: "compact" | "full") => void;
  reportContentSize: (height: number) => void;
  getShortcuts: () => Promise<ShortcutInfo>;
  setShortcut: (action: string, accelerator: string) => Promise<SetShortcutResult>;
  resetShortcuts: () => Promise<ShortcutBindings>;
  toggleOverlay: () => void;
  startResize: (edge: ResizeEdge) => void;
  resizeMove: () => void;
  endResize: () => void;
  getRecordingSettings: () => Promise<RecordingSettings>;
  setRecordingSettings: (next: Partial<RecordingSettings>) => Promise<RecordingSettings>;
  saveReplayNow: () => void;
  openRecordingsFolder: () => Promise<string>;
  onRecordingSaved: (callback: (result: RecordingSaveResult) => void) => () => void;
  getRecordingUsage: () => Promise<RecordingUsage>;
  onRecordingSettingsChanged: (callback: (settings: RecordingSettings) => void) => () => void;
};

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

declare global {
  interface Window {
    snugDesktop?: SnugDesktopBridge;
  }
}

export function getDesktopBridge(): SnugDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.snugDesktop;
}
