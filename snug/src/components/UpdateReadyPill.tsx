"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { getDesktopBridge } from "@/lib/desktopBridge";

// Renders nothing at all until an update has finished downloading and is
// waiting to be applied. Settings -> About and the tray both offer the
// restart too, but neither is visible at a glance — without this you'd
// only find out an update was ready by going looking for it.
//
// Clicking asks first: applying an update restarts the app, which drops
// you out of whatever room you're in. Nothing here ever restarts on its
// own (see setupAutoUpdate in main.js); the update also applies by itself
// next time you quit, so declining costs nothing.
export function UpdateReadyPill({ inRoom = false }: { inRoom?: boolean }) {
  const [version, setVersion] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    bridge
      .getUpdateStatus()
      .then((s) => {
        setReady(s.state === "ready");
        setVersion(s.version);
      })
      .catch(() => {});
    return bridge.onUpdateStatus((s) => {
      setReady(s.state === "ready");
      setVersion(s.version);
    });
  }, []);

  if (!ready) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`Update${version ? ` to ${version}` : ""} is ready — restart to install`}
        title={`Update${version ? ` to ${version}` : ""} is ready — restart to install`}
        className="flex flex-shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 transition active:scale-95"
        style={{ background: "var(--snug-mint)" }}
      >
        <svg
          viewBox="0 0 24 24"
          width="13"
          height="13"
          fill="none"
          stroke="var(--snug-on-accent)"
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
        <span className="text-xs font-extrabold" style={{ color: "var(--snug-on-accent)" }}>
          Update
        </span>
      </button>

      {confirming && (
        <ConfirmDialog
          title={`Restart to update${version ? ` to ${version}` : ""}?`}
          description={
            inRoom
              ? "Snug will close and reopen to finish updating, so you'll leave the room and rejoin. It also updates on its own next time you quit."
              : "Snug will close and reopen to finish updating. It also updates on its own next time you quit, so this is only if you'd rather not wait."
          }
          confirmLabel="Restart now"
          cancelLabel="Later"
          danger={false}
          onConfirm={() => getDesktopBridge()?.restartToUpdate()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
