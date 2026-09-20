import type { CSSProperties } from "react";

// -webkit-app-region isn't in React's CSSProperties typings, so every call
// site needs this cast — centralized here rather than repeated per file.
export type DragStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };
export const dragRegion: DragStyle = { WebkitAppRegion: "drag" };
export const noDragRegion: DragStyle = { WebkitAppRegion: "no-drag" };
