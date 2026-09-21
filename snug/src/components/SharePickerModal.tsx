"use client";

import { type ReactNode } from "react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { SnugMark } from "@/components/SnugMark";
import type { DisplaySurface } from "@/hooks/useVoiceRoom";

type Option = {
  surface: DisplaySurface;
  label: string;
  description: string;
  icon: ReactNode;
};

const OPTIONS: Option[] = [
  {
    surface: "monitor",
    label: "Entire Screen",
    description: "Share everything on your display",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8" />
        <path d="M12 17v4" />
      </svg>
    ),
  },
  {
    surface: "window",
    label: "Application Window",
    description: "Share a single open window",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 9h18" />
        <circle cx="6.5" cy="7" r="0.6" fill="currentColor" stroke="none" />
        <circle cx="8.7" cy="7" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    surface: "browser",
    label: "Browser Tab",
    description: "Share one tab, with its own audio",
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
    ),
  },
];

type SharePickerModalProps = {
  mode: "start" | "change";
  onPick: (surface: DisplaySurface) => void;
  onClose: () => void;
};

// How long the pop-out plays before onClose actually unmounts — must match
// modalPopOut's duration in globals.css. Picking an option isn't delayed by
// this: onPick fires immediately (the caller unmounts this itself right
// after), so the actual share request is never held up cosmetically.
const CLOSE_ANIMATION_MS = 160;

export function SharePickerModal({ mode, onPick, onClose }: SharePickerModalProps) {
  const { panelRef, closing, requestClose: handleClose } = useModalDialog(
    onClose,
    CLOSE_ANIMATION_MS,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      style={{ animation: `${closing ? "overlayFadeOut" : "overlayFadeIn"} 160ms ease both` }}
      onClick={handleClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Share your screen"
        className="w-full max-w-sm rounded-3xl bg-snug-surface p-6 shadow-snug-popover"
        style={{
          animation: `${closing ? "modalPopOut" : "modalPopIn"} 200ms cubic-bezier(0.34,1.56,0.64,1) both`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <SnugMark size="sm" />
          <div className="font-display text-lg font-extrabold text-snug-text">
            {mode === "change" ? "Change your shared screen" : "Share your screen"}
          </div>
        </div>
        <p className="mt-2.5 text-xs leading-relaxed font-semibold text-snug-muted">
          Pick what to share. Your browser will open its own confirmation dialog
          next — that step keeps screen sharing safe and can&apos;t be skipped.
        </p>

        <div className="mt-4 flex flex-col gap-2">
          {OPTIONS.map((opt) => (
            <button
              key={opt.surface}
              type="button"
              onClick={() => onPick(opt.surface)}
              className="flex items-center gap-3 rounded-2xl bg-snug-chip px-4 py-3 text-left transition active:scale-[0.98]"
            >
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-snug-bg text-snug-text">
                {opt.icon}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-extrabold text-snug-text">{opt.label}</div>
                <div className="truncate text-xs font-semibold text-snug-muted">
                  {opt.description}
                </div>
              </div>
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={handleClose}
          className="mt-4 w-full py-1 text-center text-xs font-extrabold text-snug-muted"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
