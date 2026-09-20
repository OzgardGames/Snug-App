"use client";

import { useEffect, useRef, useState } from "react";
import { useModalDialog } from "@/hooks/useModalDialog";
import { Toggle } from "@/components/Toggle";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { colorForId, initialFor } from "@/lib/participantColor";
import { MAX_ROOM_MEMBERS, type RoomMember } from "@/lib/socket";

// How long the pop-out plays before onClose actually unmounts — must match
// modalPopOut's duration in globals.css.
const CLOSE_ANIMATION_MS = 160;

type ManageRoomModalProps = {
  onClose: () => void;
  roomName: string;
  roomCode: string;
  persistent: boolean;
  hasPasscode: boolean;
  members: RoomMember[];
  selfId: string | undefined;
  onRename: (name: string) => void;
  onRegenerateCode: () => void;
  onTogglePersistent: () => void;
  onSetPasscode: (passcode: string | null) => Promise<string | null>;
  onKickMember: (memberId: string) => void;
  onToggleForceMute: (memberId: string, muted: boolean) => void;
  onEndRoom: () => void;
};

export function ManageRoomModal({
  onClose,
  roomName,
  roomCode,
  persistent,
  hasPasscode,
  members,
  selfId,
  onRename,
  onRegenerateCode,
  onTogglePersistent,
  onSetPasscode,
  onKickMember,
  onToggleForceMute,
  onEndRoom,
}: ManageRoomModalProps) {
  const [nameInput, setNameInput] = useState(roomName);
  // Re-sync when the room is renamed while this is open (another owner, or
  // this same account from another device) — seeded once, the field kept
  // showing the old name and silently re-saved it on the next edit.
  const lastSyncedNameRef = useRef(roomName);
  useEffect(() => {
    if (roomName === lastSyncedNameRef.current) return;
    lastSyncedNameRef.current = roomName;
    setNameInput(roomName);
  }, [roomName]);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [passcodeOpen, setPasscodeOpen] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState("");
  const [passcodeErr, setPasscodeErr] = useState<string | null>(null);
  const [passcodeSaving, setPasscodeSaving] = useState(false);

  const { panelRef, closing, requestClose: handleClose } = useModalDialog(
    onClose,
    CLOSE_ANIMATION_MS,
  );


  function commitName() {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== roomName) onRename(trimmed);
    else setNameInput(roomName);
  }

  function togglePasscodeForm() {
    setPasscodeOpen((o) => !o);
    setPasscodeInput("");
    setPasscodeErr(null);
  }

  async function handleSavePasscode() {
    const trimmed = passcodeInput.trim();
    if (!trimmed || passcodeSaving) return;
    setPasscodeSaving(true);
    setPasscodeErr(null);
    const error = await onSetPasscode(trimmed);
    setPasscodeSaving(false);
    if (error) {
      setPasscodeErr(error);
      return;
    }
    setPasscodeOpen(false);
  }

  async function handleRemovePasscode() {
    setPasscodeSaving(true);
    await onSetPasscode(null);
    setPasscodeSaving(false);
    setPasscodeOpen(false);
  }


  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      style={{ animation: `${closing ? "overlayFadeOut" : "overlayFadeIn"} 160ms ease both` }}
      onClick={handleClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage Room"
        className="flex max-h-[85vh] w-full max-w-sm flex-col rounded-3xl bg-snug-surface p-0 shadow-snug-popover"
        style={{
          animation: `${closing ? "modalPopOut" : "modalPopIn"} 200ms cubic-bezier(0.34,1.56,0.64,1) both`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-shrink-0 items-center justify-between px-6 pt-[22px] pb-4">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--snug-gold)" stroke="none">
              <path d="M3 18h18l-1.5-9-4.7 3.3L12 5l-2.8 7.3L4.5 9 3 18Z" />
            </svg>
            <span className="font-display text-lg font-extrabold text-snug-text">
              Manage Room
            </span>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-[11px] bg-snug-chip transition active:scale-95"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
              <path d="M18 6 6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-2">
          <section>
            <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
              Room
            </div>
            <div className="flex flex-col gap-2">
              <div>
                <div className="mb-1.5 text-[10.5px] font-extrabold text-snug-muted">
                  Room name
                </div>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  className="w-full rounded-2xl border-none bg-snug-chip px-3.5 py-2.5 font-display text-sm font-bold text-snug-text outline-none focus:ring-2 focus:ring-snug-focus"
                />
              </div>

              <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
                <div>
                  <div className="text-[10.5px] font-extrabold text-snug-muted">Room code</div>
                  <div className="font-display text-sm font-bold tracking-wide text-snug-text">
                    {roomCode}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onRegenerateCode}
                  className="flex items-center gap-1.5 rounded-xl bg-snug-surface px-3 py-2 transition active:scale-95"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
                    <path d="M21 12a9 9 0 1 1-3-6.7" />
                    <path d="M21 4v5h-5" />
                  </svg>
                  <span className="text-xs font-extrabold text-snug-text">New code</span>
                </button>
              </div>

              <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
                <div>
                  <div className="text-[13.5px] font-bold text-snug-text">
                    {persistent ? "Persistent room" : "Ephemeral room"}
                  </div>
                  <div className="text-[11px] font-bold text-snug-muted">
                    {persistent ? "Stays open, chat history saved" : "Closes when everyone leaves"}
                  </div>
                </div>
                <Toggle checked={persistent} onChange={onTogglePersistent} label="Persistent room" />
              </div>

              <div className="rounded-2xl bg-snug-chip px-3.5 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[13.5px] font-bold text-snug-text">Room passcode</div>
                    <div className="text-[11px] font-bold text-snug-muted">
                      {hasPasscode
                        ? "Set — people need it to join"
                        : "Off — anyone with the code can join"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={togglePasscodeForm}
                    className="flex-shrink-0 rounded-xl bg-snug-surface px-3 py-2 text-xs font-extrabold text-snug-text transition active:scale-95"
                  >
                    {hasPasscode ? "Change" : "Set"}
                  </button>
                </div>

                {passcodeOpen && (
                  <div className="animate-[fadeIn_150ms_cubic-bezier(0.16,1,0.3,1)] mt-2.5 flex flex-col gap-2 motion-reduce:animate-none">
                    <input
                      type="text"
                      value={passcodeInput}
                      onChange={(e) => setPasscodeInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSavePasscode();
                      }}
                      placeholder="New passcode (min 4 characters)"
                      autoFocus
                      className="w-full rounded-xl border-none bg-snug-surface px-3 py-2.5 text-sm font-bold text-snug-text outline-none focus:ring-2 focus:ring-snug-focus"
                    />
                    {passcodeErr && (
                      <p className="text-xs font-bold" style={{ color: "var(--snug-pink)" }}>
                        {passcodeErr}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={handleSavePasscode}
                        disabled={!passcodeInput.trim() || passcodeSaving}
                        className="flex-1 rounded-xl py-2 text-xs font-extrabold transition active:scale-95 disabled:opacity-50"
                        style={{ background: "var(--snug-primary)", color: "var(--snug-primary-text)" }}
                      >
                        Save
                      </button>
                      {hasPasscode && (
                        <button
                          type="button"
                          onClick={handleRemovePasscode}
                          disabled={passcodeSaving}
                          className="rounded-xl bg-snug-surface px-3 py-2 text-xs font-extrabold transition active:scale-95 disabled:opacity-50"
                          style={{ color: "var(--snug-pink)" }}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>

          <section>
            <div className="mb-1.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
              Members · {members.length}/{MAX_ROOM_MEMBERS}
            </div>
            <div className="flex flex-col gap-0.5">
              {members.map((m) => {
                const color = colorForId(m.id);
                const canModerate = !m.isOwner && m.id !== selfId;
                return (
                  <div key={m.id} className="flex items-center gap-2.5 py-2">
                    <div className="relative h-[34px] w-[34px] flex-shrink-0">
                      {m.isOwner && (
                        <div className="absolute top-[-7px] left-1/2 z-10 flex h-[15px] w-[15px] -translate-x-1/2 items-center justify-center rounded-full bg-snug-surface shadow-[0_1px_3px_rgba(42,38,64,0.18)]">
                          <svg viewBox="0 0 24 24" width="9" height="9" fill="var(--snug-gold)" stroke="none">
                            <path d="M3 18h18l-1.5-9-4.7 3.3L12 5l-2.8 7.3L4.5 9 3 18Z" />
                          </svg>
                        </div>
                      )}
                      <div
                        className="flex h-full w-full items-center justify-center rounded-full font-display text-xs font-extrabold"
                        style={{ background: color, color: "var(--snug-on-accent)" }}
                      >
                        {initialFor(m.name)}
                      </div>
                    </div>
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="truncate text-[13.5px] font-bold text-snug-text">
                        {m.name}
                      </span>
                      {m.isOwner && (
                        <span className="flex-shrink-0 rounded-full bg-snug-chip px-2 py-0.5 text-[9.5px] font-extrabold text-snug-muted">
                          OWNER
                        </span>
                      )}
                    </div>
                    {canModerate && (
                      <div className="flex flex-shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => onToggleForceMute(m.id, !m.forceMuted)}
                          aria-label={m.forceMuted ? `Unmute ${m.name}` : `Mute ${m.name}`}
                          title={m.forceMuted ? "Unmute" : "Mute"}
                          className="flex h-7 w-7 items-center justify-center rounded-[9px] transition active:scale-95"
                          style={{ background: m.forceMuted ? "var(--snug-pink)" : "var(--snug-chip)" }}
                        >
                          {m.forceMuted ? (
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v1" />
                              <path d="M19 11a7 7 0 0 1-1.34 4.12" />
                              <path d="M5 11a7 7 0 0 0 9.9 6.36" />
                              <path d="M12 18v3" />
                              <path d="M4 4l16 16" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-snug-muted">
                              <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                              <path d="M19 11a7 7 0 0 1-14 0" />
                            </svg>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => onKickMember(m.id)}
                          aria-label={`Remove ${m.name}`}
                          title="Remove"
                          className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-snug-chip transition active:scale-95"
                        >
                          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-snug-muted">
                            <path d="M18 6 6 18" />
                            <path d="M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
              Danger zone
            </div>
            <button
              type="button"
              onClick={() => setConfirmEnd(true)}
              className="flex w-full items-center justify-center gap-2 rounded-2xl py-3 transition active:scale-[0.98]"
              style={{ background: "var(--snug-surface-tint)" }}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--snug-pink)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span className="text-[13.5px] font-bold" style={{ color: "var(--snug-pink)" }}>
                {persistent ? "Delete Room" : "End Room Now"}
              </span>
            </button>
          </section>
        </div>

        <div className="flex-shrink-0 px-6 pt-4 pb-6">
          <button
            type="button"
            onClick={handleClose}
            className="w-full rounded-2xl py-3 text-center font-display text-[14px] font-bold transition active:scale-[0.98]"
            style={{ background: "var(--snug-primary)", color: "var(--snug-primary-text)" }}
          >
            Done
          </button>
        </div>
      </div>

      {/* The same destructive action from My Rooms already went through
          this dialog; here it used to be a click-twice-within-4s button,
          so the app asked for confirmation two different ways depending on
          where you happened to be standing. */}
      {confirmEnd && (
        <ConfirmDialog
          title={persistent ? "Delete this room?" : "End this room?"}
          description={
            persistent
              ? "The room, its code and its chat history are removed for everyone. This can't be undone."
              : "Everyone is disconnected and the room closes immediately. This can't be undone."
          }
          confirmLabel={persistent ? "Delete room" : "End room"}
          onConfirm={() => {
            setConfirmEnd(false);
            onEndRoom();
          }}
          onCancel={() => setConfirmEnd(false)}
        />
      )}
    </div>
  );
}
