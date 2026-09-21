"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { getDesktopBridge } from "@/lib/desktopBridge";
import { dragRegion } from "@/lib/desktopDrag";
import { WindowControlsPill } from "@/components/WindowControlsPill";

// Mounted once at the root layout. Two jobs that have to happen everywhere,
// regardless of what (if anything) this renders: telling the main process
// which window size to be (see main.js's compact/full split), and toggling
// the page background transparent so the desktop window's rounded floating
// panels (this compact bar's own card, and the room view's own panel — see
// room/[code]/page.tsx) don't just repaint a boxed-in rectangle behind
// themselves. The room view draws its own window controls inline next to
// its Exit room button instead of using this bar — see WindowControlsPill.
// Renders nothing at all in a plain browser tab, where getDesktopBridge()
// is undefined and none of this applies.
export function DesktopTitleBar() {
  const pathname = usePathname();
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    // window.snugDesktop only exists client-side (injected by the desktop
    // app's preload script) — this can't be read during the server-rendered
    // first pass without a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDesktop(!!getDesktopBridge()?.isDesktop);
  }, []);

  const isRoom = pathname?.startsWith("/room/") ?? false;

  useEffect(() => {
    if (!isDesktop) return;
    getDesktopBridge()?.setWindowMode(isRoom ? "full" : "compact");
  }, [isDesktop, isRoom]);

  // Every desktop window is transparent with no native rectangle of its own
  // (see main.js's transparent: true) — each page paints its own rounded,
  // opaque panel with a margin around it instead, so body's normal solid
  // page background has to get out of the way everywhere, not just here.
  useEffect(() => {
    document.body.classList.toggle("desktop-window-transparent", isDesktop);
  }, [isDesktop]);

  if (!isDesktop || isRoom) return null;

  return (
    <div className="flex flex-shrink-0 justify-center px-3 pt-3 pb-1" style={dragRegion}>
      <WindowControlsPill showMaximize={false} />
    </div>
  );
}
