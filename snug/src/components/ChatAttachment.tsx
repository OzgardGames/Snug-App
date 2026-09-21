"use client";

import { useState } from "react";
import type { ChatAttachment, LinkPreview } from "@/lib/socket";
import { attachmentUrl } from "@/lib/upload";

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="var(--snug-on-accent)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function formatDuration(seconds: number | undefined): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function VideoAttachment({ attachment }: { attachment: ChatAttachment }) {
  const [playing, setPlaying] = useState(false);
  const src = attachmentUrl(attachment.url);
  const aspect =
    attachment.width && attachment.height ? `${attachment.width} / ${attachment.height}` : "16 / 9";

  if (attachment.status === "processing") {
    return (
      <div
        className="mt-1 flex w-full max-w-[240px] flex-col items-center justify-center gap-1.5 rounded-2xl bg-snug-chip"
        style={{ aspectRatio: aspect }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" className="animate-spin text-snug-muted">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.25" />
          <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <span className="text-[11px] font-bold text-snug-muted">Compressing video…</span>
      </div>
    );
  }

  if (playing) {
    return (
      <video
        src={src}
        controls
        autoPlay
        className="mt-1 w-full max-w-[260px] rounded-2xl bg-black"
        style={{ aspectRatio: aspect }}
      />
    );
  }

  const duration = formatDuration(attachment.duration);

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      className="relative mt-1 block w-full max-w-[260px] overflow-hidden rounded-2xl bg-black transition active:scale-[0.98]"
      style={{ aspectRatio: aspect }}
    >
      {attachment.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={attachmentUrl(attachment.thumbnailUrl)}
          alt={attachment.name}
          className="h-full w-full object-cover opacity-90"
        />
      ) : (
        <div className="h-full w-full bg-snug-chip" />
      )}
      <div className="absolute inset-0 flex items-center justify-center bg-black/15">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/90">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="var(--snug-on-accent)" stroke="none" style={{ marginLeft: 2 }}>
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </div>
      <div className="absolute right-2 bottom-2 flex items-center gap-1.5">
        {duration && (
          <span className="rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-extrabold text-white">
            {duration}
          </span>
        )}
        <span className="rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-extrabold text-white">
          {attachment.sizeLabel}
        </span>
      </div>
    </button>
  );
}

export function AttachmentView({ attachment }: { attachment: ChatAttachment }) {
  const src = attachmentUrl(attachment.url);

  if (attachment.kind === "image") {
    return (
      <a href={src} target="_blank" rel="noreferrer" className="mt-1 block max-w-[220px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={attachment.name}
          className="w-full rounded-2xl object-cover"
          style={{ aspectRatio: "4 / 3" }}
        />
      </a>
    );
  }

  if (attachment.kind === "video") {
    return <VideoAttachment attachment={attachment} />;
  }

  if (attachment.kind === "audio") {
    return <audio src={src} controls className="mt-1 h-9 w-full max-w-[260px]" />;
  }

  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className="mt-1 flex w-fit max-w-[240px] items-center gap-2.5 rounded-2xl bg-snug-peach px-3 py-2.5 transition active:scale-[0.98]"
    >
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-white/50">
        <FileIcon />
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs font-extrabold text-snug-on-accent">{attachment.name}</div>
        <div className="text-[10.5px] font-bold text-snug-on-accent opacity-70">{attachment.sizeLabel}</div>
      </div>
    </a>
  );
}

export function LinkPreviewView({ preview }: { preview: LinkPreview }) {
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noreferrer"
      className="mt-1 flex w-fit max-w-[260px] items-center gap-2.5 rounded-2xl border border-snug-divider bg-snug-surface p-2 transition active:scale-[0.98]"
    >
      {preview.image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview.image}
          alt=""
          className="h-12 w-16 flex-shrink-0 rounded-[9px] object-cover"
        />
      ) : (
        <div className="flex h-12 w-16 flex-shrink-0 items-center justify-center rounded-[9px] bg-snug-chip">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-snug-muted">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </div>
      )}
      <div className="min-w-0">
        <div className="line-clamp-2 text-xs font-extrabold text-snug-text">{preview.title}</div>
        <div className="mt-0.5 text-[10.5px] font-bold text-snug-muted">{preview.domain}</div>
      </div>
    </a>
  );
}
