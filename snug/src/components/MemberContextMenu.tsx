"use client";

import { useEffect, useRef, useState } from "react";
import { noDragRegion } from "@/lib/desktopDrag";

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      {muted ? <path d="M16 9l5 6M21 9l-5 6" /> : <path d="M16 8a6 6 0 0 1 0 8" />}
    </svg>
  );
}

type MemberContextMenuProps = {
  x: number;
  y: number;
  memberName: string;
  canForceMute: boolean;
  locallyMuted: boolean;
  volume: number;
  forceMuted: boolean;
  onToggleLocalMute: () => void;
  onVolumeChange: (volume: number) => void;
  onToggleForceMute: () => void;
  onClose: () => void;
};

// A lightweight, positioned popover rather than a modal — it opens next to
// wherever the user right-clicked and closes on any outside click/Escape,
// like a native context menu.
export function MemberContextMenu({
  x,
  y,
  memberName,
  canForceMute,
  locallyMuted,
  volume,
  forceMuted,
  onToggleLocalMute,
  onVolumeChange,
  onToggleForceMute,
  onClose,
}: MemberContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // The slider renders from LOCAL state, not the prop. Driving it straight
  // from the parent meant every pixel of a drag re-rendered the whole room
  // page before the thumb could move, which showed up as the thumb sticking
  // and then jumping a few percent at a time. The parent still gets every
  // change; it just no longer sits between the pointer and the thumb.
  // Seeded once: this menu is mounted fresh each time it opens, and nothing
  // but this slider changes the value while it's open, so there's no prop
  // to stay in sync with.
  const [sliderPct, setSliderPct] = useState(() => Math.round(volume * 100));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clampedX = Math.max(12, Math.min(x, window.innerWidth - rect.width - 12));
    const clampedY = Math.max(12, Math.min(y, window.innerHeight - rect.height - 12));
    setPos({ x: clampedX, y: clampedY });
  }, [x, y]);

  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <>
      {/* Electron's -webkit-app-region: drag areas (the room's whole root)
          swallow mouse events before the page sees them, so the
          document-level outside-click handler above never fired for clicks
          on empty space — only on tiles and controls, which opt out of
          dragging. This backdrop is an actual element that receives the
          click, and opts out of dragging itself so it can. */}
      <div
        className="fixed inset-0 z-40"
        style={noDragRegion}
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 w-[220px] origin-top-left rounded-[18px] bg-snug-chip p-2.5 shadow-snug-popover animate-[popoverIn_140ms_cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none"
      style={{ left: pos.x, top: pos.y }}
    >
      <div className="truncate px-1.5 pt-0.5 pb-2 text-xs font-extrabold text-snug-muted">
        {memberName}
      </div>

      <div className="px-1.5 pb-1.5">
        <div className="mb-1.5 flex items-center justify-between text-[11px] font-bold text-snug-muted">
          <span className="flex items-center gap-1.5">
            <SpeakerIcon muted={locallyMuted} />
            Volume for you
          </span>
          {/* The readout doubles as the way back to exactly 100% — a
              free-dragging 0-200 slider never lands on it by accident, and
              this is one fewer thing under the track than the old
              0/100/200 scale was. */}
          {locallyMuted ? (
            <span>Muted</span>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSliderPct(100);
                onVolumeChange(1);
              }}
              title="Reset to 100%"
              className="transition hover:text-snug-text"
            >
              {sliderPct}%
            </button>
          )}
        </div>
        <input
          type="range"
          min={0}
          max={200}
          value={locallyMuted ? 0 : sliderPct}
          onChange={(e) => {
            const pct = Number(e.target.value);
            setSliderPct(pct);
            onVolumeChange(pct / 100);
          }}
          disabled={locallyMuted}
          className="snug-slider w-full disabled:opacity-40"
          aria-label={`Volume for ${memberName}`}
        />
      </div>

      <button
        type="button"
        onClick={onToggleLocalMute}
        className="flex w-full items-center rounded-xl px-2.5 py-2 text-left text-sm font-bold text-snug-text transition hover:bg-snug-surface-tint active:scale-[0.98]"
      >
        {locallyMuted ? "Unmute for me" : "Mute for me"}
      </button>

      {canForceMute && (
        <>
          <div className="my-1.5 h-px bg-snug-divider" />
          <button
            type="button"
            onClick={onToggleForceMute}
            className="flex w-full items-center rounded-xl px-2.5 py-2 text-left text-sm font-bold transition hover:bg-snug-surface-tint active:scale-[0.98]"
            style={{ color: "var(--snug-pink)" }}
          >
            {forceMuted ? "Unmute for everyone" : "Mute for everyone"}
          </button>
        </>
      )}
      </div>
    </>
  );
}
