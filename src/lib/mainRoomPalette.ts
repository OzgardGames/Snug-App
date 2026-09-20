// Colors for Main Room chrome that don't map cleanly onto a single global
// token per theme (the light and dark mockups pair them asymmetrically —
// e.g. the copy-code pill is filled navy in light but an elevated chip in
// dark). Centralized here rather than scattered as inline ternaries.
export function getMainRoomPalette(dark: boolean) {
  return {
    cardInk: dark ? "#17161F" : "#2A2640",
    composerBg: dark ? "var(--snug-surface-tint)" : "var(--snug-bg)",

    copyPillBg: dark ? "var(--snug-chip)" : "var(--snug-primary)",
    copyPillText: dark ? "var(--snug-primary)" : "#FFFFFF",
    copyPillIconDefault: dark ? "var(--snug-muted)" : "#FFFFFF",
    copyPillIconCopied: dark ? "var(--snug-primary)" : "#B8F542",

    // Both of these used to be a one-off #FF5C5C in dark only. "Muted" is
    // already signalled elsewhere on this same screen with --snug-pink
    // regardless of theme (the member tile's muted ring), so a second,
    // slightly different red sitting next to it read as drift rather than
    // intent — they're the same state and now the same color.
    muteBtnBg: (muted: boolean) =>
      muted ? "var(--snug-pink)" : "var(--snug-primary)",
    muteIconColor: (muted: boolean) =>
      dark ? (muted ? "#FFFFFF" : "#17161F") : "#FFFFFF",

    shareBtnBg: (sharing: boolean) =>
      sharing ? "var(--snug-pink)" : dark ? "var(--snug-primary)" : "var(--snug-mint)",
    shareIconColor: dark ? "#17161F" : "#FFFFFF",

    pttTrackOn: dark ? "var(--snug-primary)" : "#2A2640",
    pttTrackOff: "var(--snug-divider)",
    pttThumbBg: (on: boolean) =>
      dark ? (on ? "#17161F" : "var(--snug-text)") : "#FFFFFF",

    badgeBg: (mutedOrTalking: boolean) =>
      dark ? "var(--snug-bg)" : mutedOrTalking ? "#2A2640" : "#FFFFFF",
    badgeIconColor: (mutedOrTalking: boolean) =>
      dark ? "#FFFFFF" : mutedOrTalking ? "#FFFFFF" : "#2A2640",
  };
}
