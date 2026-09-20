"use client";

import { useCallback, useRef, type CSSProperties, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { getDesktopBridge, type ResizeEdge } from "@/lib/desktopBridge";
import { noDragRegion } from "@/lib/desktopDrag";

// The room window is resizable, but it's also transparent (needed for the
// borderless floating card on the compact/join screens — see main.js's
// createWindow) — on Windows a transparent BrowserWindow doesn't get the
// OS's usual edge hit-testing, so dragging where the border "should" be
// does nothing. These invisible strips are the replacement: mousedown
// starts a resize session in the main process (see main.js's
// resizeSession), mousemove pings it to recompute bounds from the current
// cursor position, mouseup ends it. Rendered via a portal straight onto
// document.body so they sit at the window's REAL edges regardless of
// <main>'s own m-3 margin or its position:fixed containing-block override.
const THICKNESS = 8;
const CORNER = 16;

const EDGES: { edge: ResizeEdge; style: CSSProperties }[] = [
  { edge: "n", style: { top: 0, left: CORNER, right: CORNER, height: THICKNESS, cursor: "ns-resize" } },
  { edge: "s", style: { bottom: 0, left: CORNER, right: CORNER, height: THICKNESS, cursor: "ns-resize" } },
  { edge: "w", style: { left: 0, top: CORNER, bottom: CORNER, width: THICKNESS, cursor: "ew-resize" } },
  { edge: "e", style: { right: 0, top: CORNER, bottom: CORNER, width: THICKNESS, cursor: "ew-resize" } },
  { edge: "nw", style: { top: 0, left: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" } },
  { edge: "se", style: { bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" } },
  { edge: "ne", style: { top: 0, right: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" } },
  { edge: "sw", style: { bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" } },
];

export function ResizeHandles() {
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const handleMouseDown = useCallback((edge: ResizeEdge, e: MouseEvent) => {
    e.preventDefault();
    const bridge = getDesktopBridge();
    if (!bridge) return;
    draggingRef.current = true;
    bridge.startResize(edge);

    // Arrow functions (not hoisted declarations) so TS keeps `bridge`
    // narrowed to non-undefined inside them.
    const onMouseMove = () => {
      if (!draggingRef.current || rafRef.current !== null) return;
      // Throttled to one IPC round trip per frame — main.js reads the
      // cursor's live screen position itself on each ping (see
      // resizeSession), so this just needs to fire, not carry coordinates.
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (draggingRef.current) bridge.resizeMove();
      });
    };
    const onMouseUp = () => {
      draggingRef.current = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      bridge.endResize();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {EDGES.map(({ edge, style }) => (
        <div
          key={edge}
          onMouseDown={(e) => handleMouseDown(edge, e)}
          style={{
            position: "fixed",
            zIndex: 9999,
            ...noDragRegion,
            ...style,
          }}
        />
      ))}
    </>,
    document.body,
  );
}
