"use client";

import { useEffect, useState } from "react";
import { getDesktopBridge } from "@/lib/desktopBridge";
import type { UpdateStatus } from "@/lib/desktopBridge";

// Desktop-only: a browser tab updates by reloading. See setupAutoUpdate in
// main.js for the behaviour this reflects — updates download quietly and
// are applied on quit, so the only thing this ever asks of anyone is a
// restart they choose to take.
export function UpdateSettings({ showHeading = true }: { showHeading?: boolean } = {}) {
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    bridge.getAppVersion().then(setVersion).catch(() => {});
    bridge.getUpdateStatus().then(setStatus).catch(() => {});
    return bridge.onUpdateStatus(setStatus);
  }, []);

  if (!version) return null;

  const state = status?.state ?? "idle";
  const ready = state === "ready";

  const detail =
    state === "checking"
      ? "Checking…"
      : state === "downloading"
        ? `Downloading ${status?.version ?? "update"}… ${status?.percent ?? 0}%`
        : ready
          ? `Version ${status?.version ?? ""} is ready — it installs when you quit Snug.`
          : state === "none"
            ? "You're on the latest version."
            : state === "error"
              ? "Couldn't reach the update server. It'll try again later."
              : state === "dev"
                ? "Updates are disabled in a development build."
                : "Checks automatically every few hours.";

  return (
    <section>
      {showHeading && (
        <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
          About
        </div>
      )}
      <div className="rounded-2xl bg-snug-chip px-3.5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13.5px] font-bold text-snug-text">Snug {version}</div>
            <div className="mt-0.5 text-[11px] font-bold text-snug-muted">{detail}</div>
          </div>
          <button
            type="button"
            disabled={checking || state === "checking" || state === "downloading"}
            onClick={() => {
              if (ready) {
                getDesktopBridge()?.restartToUpdate();
                return;
              }
              setChecking(true);
              getDesktopBridge()
                ?.checkForUpdate()
                .then(setStatus)
                .catch(() => {})
                .finally(() => setChecking(false));
            }}
            className="flex-shrink-0 rounded-xl px-3 py-2 text-[12.5px] font-extrabold transition active:scale-95 disabled:opacity-60"
            style={{
              background: ready ? "var(--snug-mint)" : "var(--snug-bg)",
              color: ready ? "var(--snug-on-accent)" : "var(--snug-text)",
            }}
          >
            {ready ? "Restart now" : "Check"}
          </button>
        </div>

        {state === "downloading" && (
          <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-snug-bg">
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${status?.percent ?? 0}%`, background: "var(--snug-mint)" }}
            />
          </div>
        )}
      </div>
    </section>
  );
}
