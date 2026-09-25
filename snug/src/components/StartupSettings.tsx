"use client";

import { useEffect, useState } from "react";
import { Toggle } from "@/components/Toggle";
import { getDesktopBridge } from "@/lib/desktopBridge";

// Desktop-only, same reasoning as the other three: "start with Windows" is
// a registry entry the main process writes (see setOpenAtLogin in main.js),
// with no browser-tab equivalent at all.
export function StartupSettings({ showHeading = true }: { showHeading?: boolean } = {}) {
  const [openAtLogin, setOpenAtLogin] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getDesktopBridge()
      ?.getOpenAtLogin()
      .then(setOpenAtLogin)
      .catch(() => {});
  }, []);

  // Until the real value arrives there's nothing honest to show — a toggle
  // that renders off and then flips itself on a moment later reads as the
  // app changing the setting by itself.
  if (openAtLogin === null) return null;

  function toggle() {
    // Toggle has no disabled state (and adding one would change a shared
    // component's API for this single caller), so a save in flight just
    // swallows further clicks.
    if (saving) return;
    const next = !openAtLogin;
    setOpenAtLogin(next); // optimistic; main.js is the source of truth and corrects below
    setSaving(true);
    getDesktopBridge()
      ?.setOpenAtLogin(next)
      .then(setOpenAtLogin)
      .catch(() => setOpenAtLogin(!next))
      .finally(() => setSaving(false));
  }

  return (
    <section>
      {showHeading && (
        <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
          Startup
        </div>
      )}
      <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
        <div className="min-w-0 pr-3">
          <div className="text-[13.5px] font-bold text-snug-text">Start with Windows</div>
          <div className="text-[11px] font-bold text-snug-muted">
            Opens quietly in the tray, so you&apos;re reachable without opening anything
          </div>
        </div>
        <Toggle checked={openAtLogin} onChange={toggle} label="Start with Windows" />
      </div>
    </section>
  );
}
