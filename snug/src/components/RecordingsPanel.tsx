"use client";

import { useCallback, useEffect, useState } from "react";
import { getDesktopBridge, type SessionClip } from "@/lib/desktopBridge";
import { formatFileSize } from "@/lib/formatFileSize";

// The clips you caught this session, in the chat's own panel.
//
// Deliberately session-scoped rather than a browser for the whole
// recordings folder: this is "what just happened while we were playing",
// which is when you'd want to send one to the room. The folder itself is
// still the archive, and Settings still opens it.
//
// The files are never moved or copied by anything here. Sharing reads the
// bytes and uploads a copy; the clip stays exactly where instant replay put
// it. Deleting is the one exception, and that goes to the Recycle Bin.

function timeOf(ms: number) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// The row's title. Reuses the number the file itself was given (see
// nextClipName in the desktop app) rather than counting rows, so the third
// clip of the day reads the same here as it does in the folder — worth it
// the moment someone goes looking for one of these on disk. The date isn't
// repeated: everything in this list is from the session you're in.
//
// `position` is the fallback for a clip whose name predates that numbering.
function clipLabel(name: string, position: number) {
  const numbered = /_clip_(\d+)\./.exec(name);
  const n = numbered ? numbered[1] : String(position).padStart(2, "0");
  return `recorded_clip_${n}`;
}

type Props = {
  /** Uploads the clip into the room's chat. Resolves when it's sent. */
  onShare: (clip: SessionClip) => Promise<void>;
};

export function RecordingsPanel({ onShare }: Props) {
  const [clips, setClips] = useState<SessionClip[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getDesktopBridge()
      ?.listSessionClips()
      .then(setClips)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // A clip saved while this list is open should appear in it — the whole
    // point of the panel is the moment right after the save notification.
    return getDesktopBridge()?.onRecordingSaved(() => refresh());
  }, [refresh]);

  async function play(clip: SessionClip) {
    const result = await getDesktopBridge()?.playClip(clip.file);
    if (result && !result.ok) setError(result.error ?? "Couldn't open that clip.");
  }

  async function share(clip: SessionClip) {
    setBusy(clip.file);
    setError(null);
    try {
      await onShare(clip);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't share that clip.");
    } finally {
      setBusy(null);
    }
  }

  async function remove(clip: SessionClip) {
    setBusy(clip.file);
    const result = await getDesktopBridge()?.deleteClip(clip.file);
    setBusy(null);
    setConfirmDelete(null);
    if (result && !result.ok) setError(result.error ?? "Couldn't delete that clip.");
    refresh();
  }

  if (clips.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-snug-muted">
          <rect x="2.5" y="5.5" width="13" height="13" rx="2.5" />
          <path d="m18.5 9 3-2v10l-3-2" />
        </svg>
        <p className="text-xs font-bold text-snug-muted">No clips saved yet this session.</p>
        <p className="text-[11px] font-semibold text-snug-muted opacity-80">
          Hit save while instant replay is recording and they&apos;ll land here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-2 overflow-auto px-5 py-2">
      {error && (
        <p className="px-1 text-[11px] font-bold" style={{ color: "var(--snug-pink)" }}>
          {error}
        </p>
      )}
      {clips.map((clip, i) => {
        const working = busy === clip.file;
        // The list arrives newest first, so the fallback numbering counts
        // up from the bottom — the oldest clip is 01.
        const label = clipLabel(clip.name, clips.length - i);
        return (
          <div key={clip.file} className="flex items-center gap-2.5 rounded-2xl bg-snug-chip px-3 py-2.5">
            <button
              type="button"
              onClick={() => play(clip)}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl transition active:scale-90"
              style={{ background: "var(--snug-surface)" }}
              aria-label={`Play ${label}`}
              title="Play"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" className="text-snug-text">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>

            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-bold text-snug-text">{label}</div>
              <div className="truncate text-[11px] font-bold text-snug-muted">
                {timeOf(clip.savedAt)} · {clip.seconds}s · {formatFileSize(clip.bytes)}
              </div>
            </div>

            {confirmDelete === clip.file ? (
              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => remove(clip)}
                  disabled={working}
                  className="rounded-lg px-2 py-1 text-[11px] font-extrabold transition active:scale-95 disabled:opacity-60"
                  style={{ background: "var(--snug-pink)", color: "var(--snug-on-accent)" }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  className="rounded-lg px-2 py-1 text-[11px] font-extrabold text-snug-muted transition active:scale-95"
                >
                  Keep
                </button>
              </div>
            ) : (
              <div className="flex flex-shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => share(clip)}
                  disabled={working}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-extrabold transition active:scale-95 disabled:opacity-60"
                  style={{ background: "var(--snug-primary)", color: "var(--snug-primary-text)" }}
                  title="Send this clip to the room"
                >
                  {working ? (
                    "Sending…"
                  ) : (
                    <>
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m4 12 16-8-6 16-2.5-6.5L4 12Z" />
                      </svg>
                      Share
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(clip.file)}
                  disabled={working}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-snug-muted transition hover:text-snug-pink active:scale-90 disabled:opacity-60"
                  aria-label="Delete this clip"
                  title="Delete — goes to the Recycle Bin"
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h16" />
                    <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    <path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
