"use client";

// The home screen's card is the reference size for every other compact
// screen (My Rooms, and anything else that shares its window) — this is
// how they read it. Persisted (not just an in-memory value) so it's still
// known the first time My Rooms happens to mount before Home ever has in
// this session.
const KEY = "snug-home-card-height";

export function reportHomeCardHeight(height: number) {
  // A ResizeObserver can report a spurious 0 right as its element is torn
  // down mid client-side navigation — never let that clobber a real,
  // previously-measured value.
  if (!(height > 0)) return;
  try {
    window.localStorage.setItem(KEY, String(Math.round(height)));
  } catch {
    // Storage can be unavailable — sizing just falls back to each page's
    // own natural height, which is a harmless degradation.
  }
}

export function getHomeCardHeight(): number | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
