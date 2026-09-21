"use client";

import { useEffect, useState } from "react";
import { getDesktopBridge } from "@/lib/desktopBridge";
import { noDragRegion } from "@/lib/desktopDrag";

// The desktop app's only window chrome — there's no native OS title bar at
// all (see snug-desktop/electron/main.js's frame: false). Grouped into one
// small rounded chip rather than floating separately so it reads as one
// connected piece of the design instead of buttons sitting on top of
// nothing. Used both in the compact join/create/My Rooms title bar
// (DesktopTitleBar.tsx) and inline in the room view's own header, next to
// the Exit room button.
export function WindowControlsPill({ showMaximize }: { showMaximize: boolean }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!showMaximize) return;
    const bridge = getDesktopBridge();
    if (!bridge) return;
    bridge.isWindowMaximized().then(setMaximized);
    return bridge.onWindowMaximizedChange(setMaximized);
  }, [showMaximize]);

  return (
    <div
      className="flex items-center gap-1 rounded-full bg-snug-chip p-1 shadow-[0_1px_3px_rgba(0,0,0,0.15)]"
      style={noDragRegion}
    >
      <button
        type="button"
        onClick={() => getDesktopBridge()?.minimizeWindow()}
        aria-label="Minimize"
        title="Minimize"
        className="flex h-7 w-7 items-center justify-center rounded-full text-snug-muted transition hover:bg-snug-bg hover:text-snug-text active:scale-90"
      >
        <svg viewBox="0 0 12 12" width="10" height="10">
          <rect x="1" y="5.3" width="10" height="1.4" rx="0.7" fill="currentColor" />
        </svg>
      </button>
      {showMaximize && (
        <button
          type="button"
          onClick={() => getDesktopBridge()?.maximizeWindow()}
          aria-label={maximized ? "Restore" : "Maximize"}
          title={maximized ? "Restore" : "Maximize"}
          className="flex h-7 w-7 items-center justify-center rounded-full text-snug-muted transition hover:bg-snug-bg hover:text-snug-text active:scale-90"
        >
          {maximized ? (
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
              <rect x="1.5" y="3.5" width="6.7" height="6.7" rx="0.6" />
              <path d="M3.7 3.5V2a0.7 0.7 0 0 1 0.7-0.7H10a0.7 0.7 0 0 1 0.7 0.7v6a0.7 0.7 0 0 1-0.7 0.7H8.5" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.3">
              <rect x="1.5" y="1.5" width="9" height="9" rx="0.7" />
            </svg>
          )}
        </button>
      )}
      <button
        type="button"
        onClick={() => getDesktopBridge()?.closeWindow()}
        aria-label="Close"
        title="Close"
        className="flex h-7 w-7 items-center justify-center rounded-full text-snug-muted transition hover:bg-snug-pink hover:text-white active:scale-90"
      >
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M2 2l8 8M10 2l-8 8" />
        </svg>
      </button>
    </div>
  );
}
