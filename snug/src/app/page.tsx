"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SnugMark } from "@/components/SnugMark";
import { Toggle } from "@/components/Toggle";
import { SettingsModal } from "@/components/SettingsModal";
import { MyRoomsPanel } from "@/components/MyRoomsPanel";
import { UpdateReadyPill } from "@/components/UpdateReadyPill";
import { getSocket, type SocketAck } from "@/lib/socket";
import { getDeviceId } from "@/lib/deviceId";
import { getDesktopBridge } from "@/lib/desktopBridge";
import { useDesktopContentSize } from "@/hooks/useDesktopContentSize";
import { dragRegion, noDragRegion } from "@/lib/desktopDrag";
import { reportHomeCardHeight } from "@/lib/homeCardSize";

type Mode = "join" | "create";

// How long cardPopOut takes to play before the actual route change — kept
// short and matched to the animation's own duration so the navigation lands
// right as the card finishes fading out, not before or noticeably after.
const NAV_ANIMATION_MS = 180;

// The card's own p-9 (36px) top + pb-8 (32px) bottom padding — see the card
// height calculation below, which fixes the card to the join/create form's
// height and has to add this back in since that measurement itself excludes
// the padding it sits inside.
const CARD_V_PADDING = 68;

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeForm />
    </Suspense>
  );
}

function HomeForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [mode, setMode] = useState<Mode>(() =>
    searchParams.get("mode") === "create" ? "create" : "join",
  );
  const [name, setName] = useState("");
  const [code, setCode] = useState(() => searchParams.get("code") ?? "");
  const [roomName, setRoomName] = useState("");
  const [roomPasscode, setRoomPasscode] = useState("");
  const [persistent, setPersistent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"main" | "settings" | "myRooms">("main");
  const [isDesktop, setIsDesktop] = useState(false);
  // True for the brief window between picking a room and the actual route
  // change — router.push unmounts this whole page instantly with no way to
  // cross-fade into the room screen, so this just gives the card somewhere
  // to go (a quick fade+shrink) instead of it cutting away mid-click.
  const [navigating, setNavigating] = useState(false);

  function goToRoom(code: string) {
    setNavigating(true);
    setTimeout(() => router.push(`/room/${code}`), NAV_ANIMATION_MS);
  }
  const cardRef = useRef<HTMLDivElement>(null);
  useDesktopContentSize(cardRef);

  // The reference height every other compact screen (My Rooms, and this
  // card's own Settings/My Rooms views) locks to — deliberately measured
  // from the join/create form alone, not the whole card, so swapping it
  // out in place for Settings or My Rooms (below) never corrupts it with
  // either view's own, unrelated height. It simply stops updating while
  // one of those is open and picks back up once the form is showing again.
  // Applied back onto the card itself as a fixed height (not just a floor)
  // so switching between join/create, Settings, and My Rooms never resizes
  // the window — only the join/create tab swap (already same-height by
  // design) and this form's own natural size ever drive it.
  const [homeHeight, setHomeHeight] = useState<number | undefined>(undefined);
  const mainViewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = mainViewRef.current;
    if (!el) return;
    const report = () => {
      reportHomeCardHeight(el.offsetHeight);
      setHomeHeight(el.offsetHeight);
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [view]);

  // The join/create form is what's showing on the very first paint, same
  // as the card's own cardPopIn entrance — without this, that form would
  // ALSO immediately play its slideInFromLeft on top of the card's
  // scale+fade, and the two competing transforms read as a crooked,
  // sideways wobble instead of one clean pop. Only real navigations away
  // from and back to it (Settings, My Rooms) should get the slide.
  const [skipMainEntrance, setSkipMainEntrance] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSkipMainEntrance(false);
  }, []);

  // localStorage isn't available during SSR, so the remembered name can
  // only be read after mount — this is the standard "sync from a
  // browser-only API" case, not a prop being mirrored.
  useEffect(() => {
    const stored = window.localStorage.getItem("snug-last-name");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setName(stored);
    setIsDesktop(!!getDesktopBridge()?.isDesktop);
  }, []);

  const isJoin = mode === "join";
  const passcodeValid = roomPasscode.trim().length === 0 || roomPasscode.trim().length >= 4;
  const ready =
    name.trim().length > 0 && (isJoin ? code.trim().length > 0 : passcodeValid);

  const submitLabel = submitting
    ? isJoin
      ? "Joining…"
      : "Creating…"
    : isJoin
      ? "Join Room"
      : "Create Room";
  const submitStyle = !ready
    ? { background: "var(--snug-disabled)", color: "var(--snug-muted)" }
    : isJoin
      ? { background: "var(--snug-primary)", color: "var(--snug-primary-text)" }
      : { background: "var(--snug-mint)", color: "#FFFFFF" };

  // Enter submits from any field — this is a "type a code and go" screen,
  // and reaching for the mouse (or tabbing past three more fields) to
  // finish is exactly the friction it's meant not to have. handleSubmit
  // already no-ops when the form isn't valid or a submit is in flight.
  function handleFieldKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSubmit();
  }

  function handleSubmit() {
    if (!ready || submitting) return;
    const trimmedName = name.trim();
    sessionStorage.setItem("snug-name", trimmedName);
    localStorage.setItem("snug-last-name", trimmedName);

    if (isJoin) {
      // The room page already does its own join-room round trip on
      // mount — including the passcode-gate screen when one's needed —
      // so joining from here is just a matter of sending them there.
      // Pre-flighting the join from this form duplicated that logic and
      // had no way to show a passcode prompt when one came back required,
      // leaving people stuck on a bare error.
      goToRoom(code.trim().toUpperCase());
      return;
    }

    setError(null);
    setSubmitting(true);
    const socket = getSocket();
    const deviceToken = getDeviceId();
    const payload = {
      name: trimmedName,
      roomName: roomName.trim(),
      persistent,
      deviceToken,
      passcode: roomPasscode.trim() || undefined,
    };

    socket.emit("create-room", payload, (ack: SocketAck) => {
      setSubmitting(false);
      if ("error" in ack) {
        setError(ack.error);
        return;
      }
      goToRoom(ack.code);
    });
  }

  return (
    <main
      className={`relative flex flex-1 justify-center overflow-hidden px-6 pb-6 ${isDesktop ? "items-start pt-2" : "items-center pt-6"}`}
    >
      {!isDesktop && (
        <>
          <div className="light-only pointer-events-none absolute -top-36 -right-32 h-96 w-96 rounded-full bg-snug-pink opacity-10 blur-[60px]" />
          <div className="light-only pointer-events-none absolute -bottom-40 left-24 h-96 w-96 rounded-full bg-snug-mint opacity-10 blur-[60px]" />
        </>
      )}

      <div
        ref={cardRef}
        // In a browser the window is whatever size it is, so the card caps
        // itself to the viewport and scrolls — otherwise a short window
        // clipped the taller "Create a room" tab and left its submit button
        // unreachable. On desktop the WINDOW resizes to this card instead
        // (useDesktopContentSize above), so capping here would be circular:
        // the card would report its own clamped height back and the window
        // could never grow past whatever it already was.
        className={`relative z-10 flex w-full max-w-[440px] flex-col rounded-[32px] bg-snug-surface p-9 pb-8 motion-reduce:animate-none ${
          isDesktop ? "overflow-hidden" : "max-h-full overflow-y-auto"
        } ${
          navigating
            ? "pointer-events-none animate-[cardPopOut_180ms_ease-in_forwards]"
            : "animate-[cardPopIn_320ms_cubic-bezier(0.34,1.56,0.64,1)]"
        }`}
        style={{
          // Fixed to the join/create form's own height (not just a floor)
          // so Settings — which swaps that form out for very differently
          // sized content — never resizes the card or, on desktop, the
          // window around it; it scrolls internally instead. CARD_V_PADDING
          // accounts for this card's own p-9 pb-8 (36px + 32px), since
          // homeHeight is measured from the padding-free form inside it.
          height: homeHeight !== undefined ? `${homeHeight + CARD_V_PADDING}px` : undefined,
          ...(isDesktop ? dragRegion : undefined),
        }}
      >
      {view === "settings" ? (
        <div
          key="settings"
          className="flex min-h-0 flex-1 flex-col animate-[slideInFromRight_220ms_cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none"
          style={isDesktop ? noDragRegion : undefined}
        >
          <SettingsModal variant="inline" onClose={() => setView("main")} />
        </div>
      ) : view === "myRooms" ? (
        <div
          key="myRooms"
          className="flex min-h-0 flex-1 flex-col animate-[slideInFromRight_220ms_cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none"
          style={isDesktop ? noDragRegion : undefined}
        >
          <MyRoomsPanel
            variant="inline"
            onBack={() => setView("main")}
            onCreateRoom={() => {
              setMode("create");
              setView("main");
            }}
          />
        </div>
      ) : (
        <div
          key="main"
          ref={mainViewRef}
          // Deliberately NOT flex-1, unlike the settings/myRooms views
          // above. The card's height is measured FROM this element, so
          // letting it stretch to fill the card made that circular: its
          // offsetHeight could only report the card's current height back,
          // never the height its content actually wants, and a
          // ResizeObserver on it never fired because its box genuinely
          // wasn't changing. The card stayed locked at whatever the first
          // measurement happened to be and silently clipped anything taller
          // — which is what cut "Create a room" off below the passcode
          // field. Natural height makes it one-way: content sizes this,
          // this sizes the card.
          className={`flex flex-col ${skipMainEntrance ? "" : "animate-[slideInFromLeft_220ms_cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none"}`}
        >
        {/* A real row in normal flow, not two corners floating over the
            card — absolute positioning here made both buttons' true
            clickable area hard to reason about (and, on desktop, easy to
            clip against the drag region covering the rest of the card). */}
        <div
          className="mb-5 flex items-center justify-between"
          style={isDesktop ? noDragRegion : undefined}
        >
          <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setView("settings")}
            aria-label="Settings"
            className="flex h-[30px] w-[30px] items-center justify-center rounded-[10px] bg-snug-chip transition active:scale-95"
          >
            <svg
              viewBox="0 0 24 24"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-snug-text"
            >
              <line x1="4" y1="6" x2="20" y2="6" />
              <circle cx="15" cy="6" r="2.1" fill="currentColor" stroke="none" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <circle cx="9" cy="12" r="2.1" fill="currentColor" stroke="none" />
              <line x1="4" y1="18" x2="20" y2="18" />
              <circle cx="17" cy="18" r="2.1" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {isDesktop && <UpdateReadyPill />}
          </div>

          <button
            type="button"
            onClick={() => setView("myRooms")}
            className="flex items-center gap-1.5 rounded-[10px] bg-snug-chip py-1.5 pr-2.5 pl-3 text-snug-text transition active:scale-95"
          >
            <span className="text-xs font-extrabold">My Rooms</span>
            <svg
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        </div>

        <div className="mb-6 flex flex-col items-center gap-3">
          <SnugMark size="lg" />
          <div className="font-brand text-[28px] font-extrabold tracking-tight text-snug-text">
            Snug
          </div>
          <div className="text-center text-[13.5px] text-snug-muted">
            No channels, no setup — just a code and you&apos;re in.
          </div>
        </div>

        <div
          className="relative mb-5 flex rounded-[14px] bg-snug-surface-tint p-1"
          style={isDesktop ? noDragRegion : undefined}
        >
          <div
            className="absolute top-1 left-1 h-[calc(100%-8px)] w-[calc(50%-4px)] rounded-[11px] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
            style={{
              background: "var(--snug-primary)",
              transform: `translateX(${isJoin ? "0" : "100%"})`,
            }}
          />
          <button
            type="button"
            onClick={() => setMode("join")}
            className="relative z-10 flex-1 rounded-[11px] py-[9px] text-center font-display text-[13.5px] font-bold transition-colors duration-200 active:scale-95"
            style={{
              color: isJoin ? "var(--snug-primary-text)" : "var(--snug-muted)",
            }}
          >
            Join a room
          </button>
          <button
            type="button"
            onClick={() => setMode("create")}
            className="relative z-10 flex-1 rounded-[11px] py-[9px] text-center font-display text-[13.5px] font-bold transition-colors duration-200 active:scale-95"
            style={{
              color: !isJoin ? "var(--snug-primary-text)" : "var(--snug-muted)",
            }}
          >
            Create a room
          </button>
        </div>

        <div className="flex flex-col gap-3.5">
          <div>
            <div className="mb-1.5 text-xs font-extrabold text-snug-muted">
              Your name
            </div>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Jad"
              onKeyDown={handleFieldKeyDown}
              style={isDesktop ? noDragRegion : undefined}
              className="w-full rounded-[13px] border-none bg-snug-bg px-3.5 py-3 font-body text-sm font-bold text-snug-text placeholder:text-snug-placeholder focus:ring-2 focus:ring-snug-focus focus:outline-none"
            />
          </div>

          {/* Both tabs' fields stay mounted and share ONE grid cell, stacked
              on top of each other — so this block is always as tall as the
              taller "Create a room" set, whichever tab is showing. That's
              deliberate: the window never changes size between Join,
              Create, My Rooms and Settings, so nothing jumps or resizes
              under the cursor as you move between them. */}
          <div className="grid">
            <div
              className="col-start-1 row-start-1 transition-opacity duration-150"
              style={{
                opacity: isJoin ? 1 : 0,
                visibility: isJoin ? "visible" : "hidden",
                pointerEvents: isJoin ? "auto" : "none",
              }}
              aria-hidden={!isJoin}
            >
              <div className="mb-1.5 text-xs font-extrabold text-snug-muted">
                Room code
              </div>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="PLAY-42"
                onKeyDown={handleFieldKeyDown}
                tabIndex={isJoin ? undefined : -1}
                style={isDesktop ? noDragRegion : undefined}
                className="w-full rounded-[13px] border-none bg-snug-bg px-3.5 py-3 font-display text-[15px] font-bold tracking-wide text-snug-text placeholder:text-snug-placeholder focus:ring-2 focus:ring-snug-focus focus:outline-none"
              />
            </div>
            <div
              className="col-start-1 row-start-1 transition-opacity duration-150"
              style={{
                opacity: isJoin ? 0 : 1,
                visibility: isJoin ? "hidden" : "visible",
                pointerEvents: isJoin ? "none" : "auto",
              }}
              aria-hidden={isJoin}
            >
             <div className="flex flex-col gap-3.5">
              <div>
                <div className="mb-1.5 text-xs font-extrabold text-snug-muted">
                  Room name
                </div>
                <input
                  type="text"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="e.g. Friday Hangout"
                  onKeyDown={handleFieldKeyDown}
                  tabIndex={isJoin ? -1 : undefined}
                  style={isDesktop ? noDragRegion : undefined}
                  className="w-full rounded-[13px] border-none bg-snug-bg px-3.5 py-3 font-body text-sm font-bold text-snug-text placeholder:text-snug-placeholder focus:ring-2 focus:ring-snug-focus focus:outline-none"
                />
              </div>
              <div
                className="rounded-[13px] bg-snug-bg p-3.5"
                style={isDesktop ? noDragRegion : undefined}
              >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <svg
                    viewBox="0 0 24 24"
                    width="15"
                    height="15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-snug-text"
                  >
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span className="text-[13.5px] font-bold text-snug-text">
                    {persistent ? "Persistent room" : "Ephemeral room"}
                  </span>
                </div>
                <Toggle
                  checked={persistent}
                  onChange={() => setPersistent((p) => !p)}
                  label="Persistent room"
                />
              </div>
              <div className="mt-2 text-xs leading-relaxed text-snug-muted">
                {persistent
                  ? "Stays open for good. Chat history is saved, so anyone with the code can drop back in anytime."
                  : "Closes when everyone leaves. Nothing is saved — perfect for a quick hang."}
              </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-extrabold text-snug-muted">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  Room passcode (optional)
                </div>
                <input
                  type="text"
                  value={roomPasscode}
                  onChange={(e) => setRoomPasscode(e.target.value)}
                  placeholder="Leave blank for no passcode"
                  onKeyDown={handleFieldKeyDown}
                  tabIndex={isJoin ? -1 : undefined}
                  style={isDesktop ? noDragRegion : undefined}
                  className="w-full rounded-[13px] border-none bg-snug-bg px-3.5 py-3 font-body text-sm font-bold text-snug-text placeholder:text-snug-placeholder focus:ring-2 focus:ring-snug-focus focus:outline-none"
                />
                {!passcodeValid && (
                  <div className="mt-1.5 text-xs font-bold text-snug-pink">
                    Passcode must be at least 4 characters.
                  </div>
                )}
              </div>
             </div>
            </div>
          </div>

          {error && (
            <div className="-mt-1.5 text-xs font-bold text-snug-pink">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!ready || submitting}
            className="mt-5 rounded-[15px] py-3.5 text-center font-display text-[14.5px] font-bold transition active:scale-[0.97] disabled:cursor-default"
            style={isDesktop ? { ...submitStyle, ...noDragRegion } : submitStyle}
          >
            {submitLabel}
          </button>
        </div>
        </div>
      )}
      </div>
    </main>
  );
}
