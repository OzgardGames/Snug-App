"use client";

import type { ReactNode } from "react";

export type ToastKind = "join" | "share" | "message" | "recording";

export type ToastItem = {
  id: string;
  kind: ToastKind;
  title: string;
  body?: string;
  onClick?: () => void;
};

// `fg` exists because the icon bubble used to be hardcoded text-white on
// every kind — white on mint/peach barely reads, and on `message`'s
// --snug-primary it was near-invisible in dark theme, where that token is
// bright lime. The accent colors here don't change between themes, so a
// fixed dark ink (--snug-on-accent) is correct for them; only `message`
// follows the theme, and --snug-primary-text is exactly the pairing token
// for --snug-primary.
const KIND_STYLE: Record<ToastKind, { bg: string; fg: string; icon: ReactNode }> = {
  join: {
    bg: "bg-snug-mint",
    fg: "text-snug-on-accent",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M19 8v6M22 11h-6" />
      </svg>
    ),
  },
  share: {
    bg: "bg-snug-peach",
    fg: "text-snug-on-accent",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8" />
        <path d="M12 17v4" />
      </svg>
    ),
  },
  message: {
    bg: "bg-snug-primary",
    fg: "text-snug-primary-text",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
      </svg>
    ),
  },
  recording: {
    bg: "bg-snug-peach",
    fg: "text-snug-on-accent",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="5.5" width="13" height="13" rx="2.5" />
        <path d="m18.5 9 3-2v10l-3-2" />
      </svg>
    ),
  },
};

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed top-5 right-5 z-[60] flex w-[300px] flex-col gap-2.5">
      {toasts.map((t) => {
        const { bg, fg, icon } = KIND_STYLE[t.kind];
        return (
          <div
            key={t.id}
            className="animate-[toastIn_220ms_cubic-bezier(0.16,1,0.3,1)] pointer-events-auto flex items-start gap-2.5 rounded-2xl bg-snug-surface p-3.5 shadow-snug-popover motion-reduce:animate-none"
          >
            <div
              className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${bg} ${fg}`}
            >
              {icon}
            </div>
            <button
              type="button"
              onClick={() => {
                t.onClick?.();
                onDismiss(t.id);
              }}
              className="min-w-0 flex-1 text-left"
            >
              <div className="truncate text-[13px] font-extrabold text-snug-text">{t.title}</div>
              {t.body && (
                <div className="mt-0.5 truncate text-xs font-semibold text-snug-muted">
                  {t.body}
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={() => onDismiss(t.id)}
              aria-label="Dismiss notification"
              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-snug-muted transition active:scale-90"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" />
                <path d="M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
