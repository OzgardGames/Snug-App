"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SnugMark } from "@/components/SnugMark";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { colorForId } from "@/lib/participantColor";
import { getMyRooms, forgetRoom, type MyRoom } from "@/lib/myRooms";
import { getDeviceId } from "@/lib/deviceId";
import { getSocket, type RoomStatus } from "@/lib/socket";
import { getDesktopBridge } from "@/lib/desktopBridge";
import { useDesktopContentSize } from "@/hooks/useDesktopContentSize";
import { getHomeCardHeight } from "@/lib/homeCardSize";
import { dragRegion, noDragRegion } from "@/lib/desktopDrag";

type LiveRoom = MyRoom & { online: number; lastActiveAt: number; hasPasscode: boolean };

function formatActivity(online: number, lastActiveAt: number): string {
  if (online > 0) return online === 1 ? "1 online" : `${online} online`;
  const deltaMs = Date.now() - lastActiveAt;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) return "Active moments ago";
  if (minutes < 60) return `Active ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Active ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Active ${days}d ago`;
}

type MyRoomsPanelProps = {
  // "page" (default) is the standalone /rooms route — its own full-bleed
  // main + sized card. "inline" is just the header/list/footer, meant to
  // be slotted into another screen's own card (the home screen, which
  // swaps its join/create form out for this instead of navigating away —
  // see SettingsModal's identical variant split for why).
  variant?: "page" | "inline";
  // Only used (and required) for variant "inline" — variant "page" always
  // navigates via Link instead.
  onBack?: () => void;
  onCreateRoom?: () => void;
};

export function MyRoomsPanel({ variant = "page", onBack, onCreateRoom }: MyRoomsPanelProps) {
  const router = useRouter();
  const [rooms, setRooms] = useState<LiveRoom[] | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LiveRoom | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);
  // Fixed (not just a floor) to the home screen's own card height — see
  // homeCardSize.ts — so the standalone page never resizes the window
  // relative to the home screen. Meaningless for "inline", which inherits
  // its size from the home screen's own card instead.
  const [fixedCardHeight, setFixedCardHeight] = useState<number | undefined>(undefined);
  const cardRef = useRef<HTMLDivElement>(null);
  useDesktopContentSize(cardRef);

  // Bookmarks live in localStorage, so they can only be read after mount;
  // this effect's job is exactly that sync, not mirroring a prop.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDesktop(!!getDesktopBridge()?.isDesktop);
    setFixedCardHeight(getHomeCardHeight());
    const bookmarked = getMyRooms();
    if (bookmarked.length === 0) {
      setRooms([]);
      return;
    }

    const socket = getSocket();
    function refresh() {
      socket.emit(
        "get-rooms-status",
        { codes: bookmarked.map((r) => r.code), deviceToken: getDeviceId() },
        (statuses: RoomStatus[]) => {
          const byCode = new Map(statuses.map((s) => [s.code, s]));
          const live: LiveRoom[] = [];
          for (const room of bookmarked) {
            const status = byCode.get(room.code);
            if (!status || !status.exists) {
              forgetRoom(room.code);
              continue;
            }
            live.push({
              code: room.code,
              name: status.name,
              isOwner: status.isOwner,
              online: status.online,
              lastActiveAt: status.lastActiveAt,
              hasPasscode: status.hasPasscode,
            });
          }
          setRooms(live);
        },
      );
    }

    if (socket.connected) refresh();
    else socket.once("connect", refresh);

    return () => {
      socket.off("connect", refresh);
    };
  }, []);

  function handleJoin(code: string) {
    router.push(`/room/${code}`);
  }

  function removeFromList(code: string) {
    forgetRoom(code);
    setRooms((prev) => prev?.filter((r) => r.code !== code) ?? prev);
  }

  // Owning the room means "delete" actually destroys it — for everyone,
  // everywhere, permanently — so it goes through an explicit confirm
  // dialog rather than a quick double-click. Just being a member means
  // there's nothing to destroy; removing it only drops it from this
  // device's own list, which is trivially undone by rejoining with the code.
  function handleDeleteClick(room: LiveRoom) {
    if (!room.isOwner) {
      removeFromList(room.code);
      return;
    }
    setDeleteTarget(room);
  }

  function handleConfirmDelete() {
    if (!deleteTarget) return;
    const code = deleteTarget.code;
    getSocket().emit(
      "delete-room-by-code",
      { code, deviceToken: getDeviceId() },
      (ack: { ok?: boolean; error?: string }) => {
        if (ack?.ok) removeFromList(code);
      },
    );
    setDeleteTarget(null);
  }

  const content = (
    <>
      <div className="flex-shrink-0 px-7 pt-7 pb-1.5">
        {variant === "inline" ? (
          <button
            type="button"
            onClick={onBack}
            style={isDesktop ? noDragRegion : undefined}
            className="mb-4 flex w-fit items-center gap-1.5 text-snug-muted transition hover:brightness-105 active:scale-95"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
            <span className="text-xs font-extrabold">Home</span>
          </button>
        ) : (
          <Link
            href="/"
            style={isDesktop ? noDragRegion : undefined}
            className="mb-4 flex w-fit items-center gap-1.5 text-snug-muted transition hover:brightness-105 active:scale-95"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
            <span className="text-xs font-extrabold">Home</span>
          </Link>
        )}
        <div className="flex items-center gap-3">
          <SnugMark size="md" />
          <div>
            <div className="font-display text-xl font-extrabold text-snug-text">My Rooms</div>
            <div className="mt-0.5 text-xs font-semibold text-snug-muted">
              Persistent rooms you can drop back into anytime.
            </div>
          </div>
        </div>
      </div>

      {/* Fills whatever's left between the header and the "Create a new
          room" button (flex-shrink-0 keeps that pinned at the bottom) —
          since the card itself is fixed to the home screen's height, this
          is what actually absorbs any size difference: more rooms scroll
          within it rather than growing the card. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-5 py-3.5">
        {rooms === null && (
          <p className="mt-4 text-center text-xs font-semibold text-snug-muted">Loading…</p>
        )}
        {rooms?.length === 0 && (
          <p className="mt-4 text-center text-xs font-semibold text-snug-muted">
            No rooms yet — create a persistent room to see it here.
          </p>
        )}
        {rooms?.map((r) => (
          <div
            key={r.code}
            style={isDesktop ? noDragRegion : undefined}
            className="flex items-center gap-3.5 rounded-[20px] bg-snug-surface-tint py-3.5 pr-3.5 pl-4 transition hover:-translate-y-0.5"
          >
            <div className="relative h-11 w-11 flex-shrink-0">
              {r.isOwner && (
                <div className="absolute top-[-8px] left-1/2 z-10 flex h-[18px] w-[18px] -translate-x-1/2 items-center justify-center rounded-full bg-snug-surface shadow-[0_1px_3px_rgba(42,38,64,0.18)]">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="var(--snug-gold)" stroke="none">
                    <path d="M3 18h18l-1.5-9-4.7 3.3L12 5l-2.8 7.3L4.5 9 3 18Z" />
                  </svg>
                </div>
              )}
              <div
                className="flex h-full w-full items-center justify-center rounded-2xl"
                style={{ background: colorForId(r.code) }}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 15V9a1 1 0 0 1 1-1h3l4-3v14l-4-3H5a1 1 0 0 1-1-1Z" />
                  <path d="M16 9a3 3 0 0 1 0 6" />
                  <path d="M18.5 6.5a7 7 0 0 1 0 11" />
                </svg>
              </div>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[14.5px] font-extrabold text-snug-text">
                  {r.name}
                </span>
                {r.hasPasscode && (
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-snug-muted" aria-label="Passcode protected">
                    <rect x="3" y="11" width="18" height="10" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="font-display text-[10.5px] font-bold tracking-wide text-snug-muted">
                  {r.code}
                </span>
                <span className="text-[10px] text-snug-placeholder">·</span>
                <span className="text-[11px] font-bold text-snug-muted">
                  {formatActivity(r.online, r.lastActiveAt)}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => handleDeleteClick(r)}
              aria-label={r.isOwner ? "Delete room" : "Remove from My Rooms"}
              title={r.isOwner ? "Delete room" : "Remove from My Rooms"}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[11px] border-[1.5px] bg-transparent transition active:scale-95"
              style={{ borderColor: r.isOwner ? "var(--snug-divider)" : "var(--snug-pink)" }}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke={r.isOwner ? "var(--snug-muted)" : "var(--snug-pink)"}
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => handleJoin(r.code)}
              className="flex-shrink-0 rounded-full px-4.5 py-2 font-display text-xs font-bold transition active:scale-95"
              style={{ background: "var(--snug-primary)", color: "var(--snug-primary-text)" }}
            >
              Join
            </button>
          </div>
        ))}
      </div>

      <div className="flex-shrink-0 px-5 pt-1 pb-6">
        {variant === "inline" ? (
          <button
            type="button"
            onClick={onCreateRoom}
            style={isDesktop ? noDragRegion : undefined}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-snug-divider py-3.5 transition active:scale-[0.98]"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            <span className="font-display text-[13.5px] font-bold text-snug-text">
              Create a new room
            </span>
          </button>
        ) : (
          <Link
            href="/?mode=create"
            style={isDesktop ? noDragRegion : undefined}
            className="flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-snug-divider py-3.5 transition active:scale-[0.98]"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            <span className="font-display text-[13.5px] font-bold text-snug-text">
              Create a new room
            </span>
          </Link>
        )}
      </div>
    </>
  );

  const confirmDialog = deleteTarget && (
    <ConfirmDialog
      title="Delete this room forever?"
      description={`"${deleteTarget.name}" and its entire chat history will be gone for everyone — this can't be undone.`}
      confirmLabel="Delete forever"
      onConfirm={handleConfirmDelete}
      onCancel={() => setDeleteTarget(null)}
    />
  );

  if (variant === "inline") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {content}
        {confirmDialog}
      </div>
    );
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
        className="relative z-10 flex max-h-[85vh] w-full max-w-[440px] flex-col overflow-hidden rounded-[32px] bg-snug-surface p-0 shadow-snug-card animate-[cardPopIn_320ms_cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none"
        style={{
          height: fixedCardHeight ? `${fixedCardHeight}px` : undefined,
          ...(isDesktop ? dragRegion : undefined),
        }}
      >
        {content}
      </div>

      {confirmDialog}
    </main>
  );
}
