"use client";

import { useCallback, useEffect, useState } from "react";

export type NotificationPrefs = {
  join: boolean;
  share: boolean;
  message: boolean;
};

const STORAGE_KEY = "snug-notification-prefs";
const DEFAULT_PREFS: NotificationPrefs = { join: false, share: false, message: false };

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
    return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(prefs: NotificationPrefs) {
  cache = prefs;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
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
