const SIGNAL_URL = process.env.NEXT_PUBLIC_SIGNAL_URL ?? "http://localhost:3001";

export type AttachmentKind = "image" | "video" | "audio" | "file";

export type UploadedFile = {
  url: string;
  name: string;
  size: number;
  sizeLabel: string;
  mime: string;
  kind: AttachmentKind;
  status?: "ready" | "processing";
  duration?: number;
  width?: number;
  height?: number;
};

// roomCode + deviceToken prove to the server that this upload is actually
// coming from someone currently in that room — appended ahead of the file
// itself so the server already knows them by the time the file's bytes
// start arriving (see handleUpload in server/uploads.mjs).
export async function uploadFile(
  file: File,
  roomCode: string,
  deviceToken: string,
): Promise<UploadedFile> {
  const form = new FormData();
  form.append("roomCode", roomCode);
  form.append("deviceToken", deviceToken);
  form.append("file", file);
  const res = await fetch(`${SIGNAL_URL}/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? "Upload failed.");
  }
  return res.json();
}

// New uploads come back as a full R2 URL (served directly from Cloudflare,
// not this server) — only a bare "/uploads/xxx" path (from before the R2
// migration, still serving old attachments straight off the signal
// server's disk) needs the signal server's origin prepended.
export function attachmentUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${SIGNAL_URL}${url}`;
}
