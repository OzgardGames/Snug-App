"use client";

// Electron's Accelerator strings ("CommandOrControl+Shift+M") aren't what
// people want to read — shown to the user as e.g. "Ctrl + Shift + M".
export function formatAccelerator(accelerator: string): string {
  return accelerator
    .split("+")
    .map((part) => (part === "CommandOrControl" ? "Ctrl" : part))
    .join(" + ");
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

const KEY_NAME_MAP: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Esc",
};

// Turns a captured keydown into an Electron Accelerator string, or null if
// it isn't one yet (a bare modifier key on its own) or never could be (no
// modifier at all — a global shortcut with no modifier would swallow that
// key everywhere, including while typing, so at least one is required).
export function acceleratorFromKeyEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (parts.length === 0) return null;

  const mainKey = KEY_NAME_MAP[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  parts.push(mainKey);
  return parts.join("+");
}
