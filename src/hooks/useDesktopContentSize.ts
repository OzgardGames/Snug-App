"use client";

import { useEffect, type RefObject } from "react";
import { getDesktopBridge } from "@/lib/desktopBridge";

// Lets the desktop app's compact window (join/create, My Rooms) size itself
// to whatever card is actually on screen instead of being a fixed box the
// content has to fit into — switching from "Join a room" to the visibly
// taller "Create a room" form used to clip inside a window sized for the
// shorter one. No-ops entirely in a browser tab.
// Covers everything around the card that isn't the card itself: the title
// bar row above it (DesktopTitleBar.tsx — pt-3 + the 36px control pill +
// pb-1 = 52px), plus the page's own top/bottom padding around the card
// (pt-2 + pb-6 = 32px). Under-counting this clips the card's bottom edge
// against a window that's a few pixels too short for it.
const WINDOW_PADDING = 84;

export function useDesktopContentSize(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const bridge = getDesktopBridge();
    const el = ref.current;
    if (!bridge || !el) return;

    const report = () => bridge.reportContentSize(el.offsetHeight + WINDOW_PADDING);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
}
