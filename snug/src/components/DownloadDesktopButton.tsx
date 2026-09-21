"use client";

import { useEffect, useState } from "react";
import { formatFileSize } from "@/lib/formatFileSize";

const REPO = "OzgardGames/Snug-App";
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

type Asset = { url: string; version: string; bytes: number };

// Browser-only: inside the desktop app this is the thing you already have.
//
// Resolves the newest release's installer from the GitHub API so the link
// never points at a stale version, and quietly falls back to the releases
// page if that call fails — rate-limited, offline, or no release published
// yet. The button is always clickable; only the detail line changes.
export function DownloadDesktopButton() {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: { tag_name?: string; name?: string; assets?: { name: string; browser_download_url: string; size: number }[] }) => {
        if (cancelled) return;
        const exe = data.assets?.find((a) => a.name.toLowerCase().endsWith(".exe"));
        if (exe) {
          setAsset({
            url: exe.browser_download_url,
            version: (data.tag_name ?? data.name ?? "").replace(/^v/, ""),
            bytes: exe.size,
          });
        }
      })
      .catch(() => {})
      .finally(() => !cancelled && setResolved(true));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mt-5 flex flex-col items-center gap-1.5">
      <a
        href={asset?.url ?? RELEASES_PAGE}
        className="flex items-center gap-2 rounded-[14px] px-4 py-2.5 transition active:scale-95"
        style={{ background: "var(--snug-surface)", boxShadow: "var(--snug-shadow-card)" }}
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-snug-text"
        >
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
        <span className="font-display text-[13.5px] font-bold text-snug-text">
          Download for Windows
        </span>
      </a>
      <span className="text-[11px] font-bold text-snug-muted">
        {asset
          ? `Version ${asset.version} · ${formatFileSize(asset.bytes)}`
          : resolved
            ? "Opens the releases page"
            : " "}
      </span>
    </div>
  );
}
