"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Shared plumbing for the app's four modals (Settings, Manage Room, Share
// Picker, Confirm). Each had grown its own copy of the same close-animation
// timer and Escape handler, and none of them dealt with focus at all: none
// declared themselves a dialog, opening one left focus behind on whatever
// button triggered it, Tab walked straight out into the page underneath,
// and closing one dropped focus onto <body> instead of returning it.
//
// The close timer is also cleared on unmount here — every copy of it
// previously ran loose, so a modal unmounted by its parent (a room ending
// while Manage Room is open, say) still fired onClose afterwards.
export function useModalDialog(onClose: () => void, closeAnimationMs: number) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestClose = useCallback(() => {
    if (closeTimerRef.current) return; // already closing — don't queue a second
    setClosing(true);
    closeTimerRef.current = setTimeout(onClose, closeAnimationMs);
  }, [onClose, closeAnimationMs]);

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  // Remember where focus came from so it can go back there on close —
  // otherwise closing a modal with the keyboard strands you at the top of
  // the document.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    return () => previouslyFocused?.focus?.();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        requestClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      // Wrap around at both ends, and pull focus back in if it somehow
      // escaped the panel entirely (clicking the backdrop, say).
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);

  return { panelRef, closing, requestClose };
}
