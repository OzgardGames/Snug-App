import { io, type Socket } from "socket.io-client";

const SIGNAL_URL =
  process.env.NEXT_PUBLIC_SIGNAL_URL ?? "http://localhost:3001";

// Mirrors server/index.mjs's own MAX_MEMBERS — the server is the actual
// enforcement point (this is display-only), but it's duplicated as a
// literal there too, so keep both in sync by hand if it ever changes.
export const MAX_ROOM_MEMBERS = 10;

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SIGNAL_URL, { autoConnect: true });
  }
  return socket;
}

export type RoomMember = {
  id: string;
  name: string;
  isOwner: boolean;
  muted: boolean;
  forceMuted: boolean;
  sharing: boolean;
  /** Foreground app, reported by the desktop app only. null in a browser. */
  game?: string | null;
  // A stable stand-in for "this device," unlike `id` (the live socket id,
  // which changes on every reconnect) — see the join-detection diff in
  // room/[code]/page.tsx, which is why this exists at all.
  deviceKey?: string;
};

export type ChatAttachment = {
  url: string;
  name: string;
  size: number;
  sizeLabel: string;
  mime: string;
  kind: "image" | "video" | "audio" | "file";
  status?: "ready" | "processing";
  thumbnailUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
};

export type LinkPreview = {
  title: string;
  domain: string;
  image?: string;
  url: string;
};

export type ChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  text: string;
  attachment?: ChatAttachment;
  linkPreview?: LinkPreview;
  createdAt: number;
};

export type RoomState = {
  code: string;
  name: string;
  persistent: boolean;
  hasPasscode: boolean;
  members: RoomMember[];
  messages: ChatMessage[];
};

export type RoomStatus =
  | { code: string; exists: false }
  | {
      code: string;
      exists: true;
      name: string;
      online: number;
      lastActiveAt: number;
      isOwner: boolean;
      hasPasscode: boolean;
    };

export type SocketAck = RoomState | { error: string; needsPasscode?: boolean };
