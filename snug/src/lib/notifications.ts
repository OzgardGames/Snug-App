"use client";

import { useCallback, useEffect, useState } from "react";
import { getDesktopBridge } from "@/lib/desktopBridge";

export type NotificationPrefs = {
  join: boolean;
  share: boolean;
  message: boolean;
};

const STORAGE_KEY = "snug-notification-prefs";
// Joins, leaves and shares are on by default now that the desktop app draws
// them as its own card rather than asking Windows for a toast: they're the
// things you want to know about precisely when you're NOT looking at Snug.
// Messages stay off — you'll see those when you come back to the chat.
const DEFAULT_PREFS: NotificationPrefs = { join: true, share: true, message: false };
// Bumped when the defaults change in a way that should reach people who
// already have prefs saved. Without it, everyone who ran an older build
// keeps the old all-off defaults forever and sees no notifications at all,
// having never actually chosen that.
const PREFS_VERSION = 2;

// Module-level cache + subscriber list so every component using the hook
// (Settings modal, the room page) reads and writes the same state without
// needing a context provider — a toggle flipped in one place is reflected
// everywhere else immediately.
let cache: NotificationPrefs | null = null;
const listeners = new Set<(prefs: NotificationPrefs) => void>();

function readPrefs(): NotificationPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const saved = JSON.parse(raw);
    // Anything saved before the version existed was written when everything
    // defaulted to off, so its "false" is a default rather than a decision.
    // A deliberate off survives, because saving now stamps the version.
    if (saved?.v !== PREFS_VERSION) return { ...DEFAULT_PREFS, message: !!saved?.message };
    return { ...DEFAULT_PREFS, ...saved };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: NotificationPrefs) {
  cache = prefs;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...prefs, v: PREFS_VERSION }));
  listeners.forEach((l) => l(prefs));
}

export function useNotificationPrefs() {
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => {
    cache = cache ?? readPrefs();
    return cache;
  });

  useEffect(() => {
    const listener = (next: NotificationPrefs) => setPrefs(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  // Toggling a notification on on is the user gesture that's allowed to
  // prompt for permission — browsers reject a bare requestPermission() call
  // that isn't traceable to a click like this one.
  const setPref = useCallback(async (key: keyof NotificationPrefs, value: boolean) => {
    if (value && typeof window !== "undefined" && "Notification" in window) {
      if (Notification.permission === "default") {
        await Notification.requestPermission();
      }
    }
    writePrefs({ ...(cache ?? readPrefs()), [key]: value });
  }, []);

  return { prefs, setPref };
}

type FireOptions = {
  body?: string;
  onClick?: () => void;
};

// Only worth surfacing an OS notification when the user isn't already
// looking at the tab — otherwise it's just noise on top of what's already
// visible on screen.
export function fireNotification(title: string, { body, onClick }: FireOptions = {}) {
  // The desktop app draws its own card instead (same one instant replay
  // uses), which survives Focus Assist and looks like Snug rather than like
  // Windows. It decides for itself whether the window is in front — see
  // snug:notify in main.js.
  const bridge = getDesktopBridge();
  if (bridge) {
    bridge.notify({ title, detail: body, kind: "info" });
    return;
  }
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState === "visible") return;

  const notif = new Notification(title, { body });
  notif.onclick = () => {
    window.focus();
    onClick?.();
    notif.close();
  };
}
