"use client";

import { useCallback, useEffect, useState } from "react";
import { getDesktopBridge } from "@/lib/desktopBridge";
import type { ShortcutBindings } from "@/lib/desktopBridge";
import { acceleratorFromKeyEvent, formatAccelerator } from "@/lib/shortcuts";

// Desktop-only — global shortcuts are a main-process (Electron) concept
// with no equivalent in a browser tab, so this whole section only renders
// when getDesktopBridge() is actually present (see SettingsModal).
export function ShortcutSettings() {
  const [bindings, setBindings] = useState<ShortcutBindings | null>(null);
  const [actions, setActions] = useState<Record<string, string>>({});
  const [listeningFor, setListeningFor] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ action: string; message: string } | null>(null);

  useEffect(() => {
    getDesktopBridge()
      ?.getShortcuts()
      .then((info) => {
        setBindings(info.bindings);
        setActions(info.actions);
      })
      .catch(() => {});
  }, []);

  // Captures the very next real key combo anywhere on the page while
  // `listeningFor` names an action, and sends it off to be registered.
  useEffect(() => {
    if (!listeningFor) return;
    const action = listeningFor;

    function onKeyDown(e: KeyboardEvent) {
      e.preventDefault();
      if (e.key === "Escape") {
        setListeningFor(null);
        return;
      }
      const accelerator = acceleratorFromKeyEvent(e);
      if (!accelerator) return; // still just a modifier — keep listening

      setListeningFor(null);
      getDesktopBridge()
        ?.setShortcut(action, accelerator)
        .then((result) => {
          if (result.ok) {
            setBindings(result.bindings);
            setRowError(null);
          } else {
            setRowError({ action, message: result.error });
          }
        })
        .catch(() => setRowError({ action, message: "Couldn't set that shortcut." }));
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [listeningFor]);

  const handleReset = useCallback(() => {
    getDesktopBridge()
      ?.resetShortcuts()
      .then((next) => {
        setBindings(next);
        setRowError(null);
      })
      .catch(() => {});
  }, []);

  if (!bindings) return null;

  return (
    <section>
      <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
        Shortcuts
      </div>
      <div className="flex flex-col gap-2">
        {Object.entries(actions).map(([action, label]) => {
          const listening = listeningFor === action;
          return (
            <div
              key={action}
              className="flex items-center justify-between gap-3 rounded-2xl bg-snug-chip px-3.5 py-3"
            >
              <div className="min-w-0">
                <div className="truncate text-[13.5px] font-bold text-snug-text">{label}</div>
                {rowError?.action === action && (
                  <div className="text-[11px] font-bold" style={{ color: "var(--snug-pink)" }}>
                    {rowError.message}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setRowError(null);
                  setListeningFor(listening ? null : action);
                }}
                className="flex-shrink-0 rounded-xl px-3 py-2 text-[12.5px] font-extrabold transition active:scale-95"
                style={{
                  background: listening ? "var(--snug-primary)" : "var(--snug-bg)",
                  color: listening ? "var(--snug-primary-text)" : "var(--snug-text)",
                }}
              >
                {listening ? "Press a key…" : formatAccelerator(bindings[action] ?? "")}
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={handleReset}
          className="self-start px-1 text-xs font-bold underline underline-offset-2 text-snug-muted"
        >
          Reset to defaults
        </button>
      </div>
    </section>
  );
}
