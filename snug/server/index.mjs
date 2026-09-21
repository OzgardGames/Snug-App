import { createServer } from "node:http";
import { Server } from "socket.io";
import crypto from "node:crypto";
import path from "node:path";
import {
  loadPersistentRooms,
  loadMessages,
  upsertRoom,
  renameRoomRow,
  recodeRoomRow,
  deleteRoomRow,
  insertMessage,
  touchRoomActivity,
  updateMessageAttachment,
  loadRoomAccess,
  addRoomAccess,
  clearRoomAccess,
  setRoomPasscodeRow,
} from "./db.mjs";
import { hashPasscode, verifyPasscode } from "./passcode.mjs";
import {
  createUploadsRequestHandler,
  fetchLinkPreview,
  deleteAttachmentFiles,
  finalizeVideoUpload,
} from "./uploads.mjs";

// Railway injects PORT and expects the app to bind to it — but locally,
// `dev:all` runs this alongside Next.js under a launcher that also sets
// PORT (for Next.js's benefit), so blindly honoring PORT here would make
// the signal server race Next.js for the same port. Only trust it when
// something Railway-specific confirms we're actually deployed there.
const PORT = (process.env.RAILWAY_ENVIRONMENT_ID && process.env.PORT) || process.env.SIGNAL_PORT || 3001;
// Comma-separated so the same server can serve multiple real clients: the
// Vercel-hosted web app AND the desktop app's own bundled frontend (which
// runs on a local port, a completely different origin — CORS rejects it
// otherwise, which is exactly what got the desktop app stuck on "Creating…"
// forever with no error, since the socket connection never completed).
const ORIGIN = (process.env.SIGNAL_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// TURN relay for voice/screen-share when two peers can't reach each other
// directly (symmetric NAT, restrictive firewalls — STUN alone can't help
// there; confirmed the hard way with a real cross-country call that joined
// fine but never got audio). Credentials are short-lived and generated
// per-connection server-side — the API token itself never reaches the
// client. Missing env vars degrade gracefully to STUN-only, the previous
// behavior, rather than breaking voice entirely.
const TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID;
const TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN;
const FALLBACK_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

async function fetchIceServers() {
  if (!TURN_KEY_ID || !TURN_API_TOKEN) return FALLBACK_ICE_SERVERS;
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TURN_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 86400 }),
      },
    );
    if (!res.ok) return FALLBACK_ICE_SERVERS;
    const data = await res.json();
    return Array.isArray(data.iceServers) ? data.iceServers : FALLBACK_ICE_SERVERS;
  } catch {
    return FALLBACK_ICE_SERVERS;
  }
}

// Room codes are said out loud and typed by hand, so they stay short and
// friendly — but the space they're drawn from has to be big enough that
// nobody can simply walk it. The original 14 words x 2 digits was 1,260
// codes: a script could have tried every one in well under a minute and
// dropped in on whichever rooms happened to be open. These 40 words x 4
// digits give 360,000, and joinThrottle below is what actually makes
// guessing impractical.
const WORDS = [
  "PLAY", "COZY", "GLOW", "HAZE", "DRIFT", "ECHO", "SPARK", "MELLOW",
  "BREEZE", "GLIDE", "EMBER", "CORAL", "DUSK", "LUME", "FROST", "PEBBLE",
  "MAPLE", "RIVER", "CEDAR", "AMBER", "OTTER", "MOSSY", "LANTERN", "HOLLOW",
  "MEADOW", "PIXEL", "COMET", "VELVET", "SUNNY", "QUARTZ", "BRAMBLE", "NIMBUS",
  "THICKET", "RIPPLE", "BURROW", "CLOVER", "BEACON", "MARBLE", "WILLOW", "SAFFRON",
];

const MAX_HISTORY = 500;
// Matches the "Members · X/10" label in Manage Room — a mesh WebRTC call
// means every extra participant costs everyone else another peer
// connection, so this is a real ceiling, not just a UI number.
const MAX_MEMBERS = 10;

/** @type {Map<string, { code: string, name: string, persistent: boolean, ownerToken: string, createdAt: number, members: Map<string, { id: string, name: string, isOwner: boolean, muted: boolean, sharing: boolean }>, messages: Array<{ id: string, authorId: string, authorName: string, text: string, createdAt: number }> }>} */
const rooms = new Map();

// Persistent rooms survive a server restart — reload them (and their chat
// history) from disk before accepting any connections.
for (const saved of loadPersistentRooms()) {
  rooms.set(saved.code, {
    code: saved.code,
    name: saved.name,
    persistent: true,
    ownerToken: saved.ownerToken,
    createdAt: saved.createdAt,
    lastActiveAt: saved.lastActiveAt,
    passcodeHash: saved.passcodeHash,
    passcodeSalt: saved.passcodeSalt,
    authorizedTokens: new Set(loadRoomAccess(saved.code)),
    members: new Map(),
    deviceSockets: new Map(),
    messages: loadMessages(saved.code),
  });
}

function generateCode() {
  // Bounded, unlike the do/while this replaces: that looped until it found
  // a free code, which with a small space meant that once enough rooms
  // were open it would spin forever and take the server with it.
  for (let i = 0; i < 200; i += 1) {
    const word = WORDS[Math.floor(Math.random() * WORDS.length)];
    const num = Math.floor(1000 + Math.random() * 9000);
    const code = `${word}-${num}`;
    if (!rooms.has(code)) return code;
  }
  // Absurdly unlikely — 200 misses means the space is genuinely crowded.
  // A longer code is worse to read out but better than not starting.
  return `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

// Guessing a code is the only way into a room you weren't given the code
// for, so the thing that matters is how fast someone can try. Each
// connection gets a budget of failed joins; successful ones don't count,
// so nobody legitimately typing a code wrong a few times is affected.
const JOIN_FAIL_LIMIT = 10;
const JOIN_FAIL_WINDOW_MS = 60_000;
const joinFailures = new Map(); // socket.id -> { count, resetAt }

function tooManyFailedJoins(socketId) {
  const now = Date.now();
  const entry = joinFailures.get(socketId);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= JOIN_FAIL_LIMIT;
}

function noteFailedJoin(socketId) {
  const now = Date.now();
  const entry = joinFailures.get(socketId);
  if (!entry || now > entry.resetAt) {
    joinFailures.set(socketId, { count: 1, resetAt: now + JOIN_FAIL_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function roomMembers(room) {
  return Array.from(room.members.values());
}

// A one-way, non-reversible stand-in for deviceToken that's safe to hand
// to every other member of the room — used only so their clients can tell
// "this is the same person reconnecting with a new socket id" apart from
// "someone genuinely new joined" (see the join-detection diff in
// room/[code]/page.tsx). The raw token itself never leaves this server.
function deviceKeyFor(token) {
  if (!token) return undefined;
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

// Runs after the "processing" message has already gone out, so it patches
// the message in place once compression/thumbnail work is done. finalizeVideoUpload
// owns every detail of where the file actually lives (R2 vs. the local
// volume) and always cleans up its own local temp files regardless of how
// this turns out — if the room's gone by the time it resolves (emptied
// out, deleted), there's simply nothing left here to patch.
async function processVideoMessage(io, roomCode, messageId, originalUrl, duration) {
  const diskFilename = path.basename(originalUrl);
  const result = await finalizeVideoUpload(diskFilename, duration);

  const room = rooms.get(roomCode);
  const message = room?.messages.find((m) => m.id === messageId);
  if (!room || !message || !message.attachment) return;

  const updatedAttachment = { ...message.attachment, ...result, status: "ready" };
  message.attachment = updatedAttachment;

  if (room.persistent) updateMessageAttachment(room.code, message.id, updatedAttachment);
  io.to(room.code).emit("message-updated", message);
}

// Shared by the in-room "End/Delete Room" button and the "My Rooms" list's
// delete action — the latter operates on a room the caller isn't currently
// joined to, so it can't reuse socket.data.roomCode to find it.
function destroyRoom(io, room) {
  io.to(room.code).emit("room-ended");
  for (const memberId of room.members.keys()) {
    const memberSocket = io.sockets.sockets.get(memberId);
    if (memberSocket) {
      memberSocket.leave(room.code);
      memberSocket.data.roomCode = undefined;
    }
  }
  rooms.delete(room.code);
  if (room.persistent) deleteRoomRow(room.code);
  deleteAttachmentFiles(room.messages).catch(() => {});
}

function broadcastRoom(io, room) {
  io.to(room.code).emit("room-update", {
    code: room.code,
    name: room.name,
    persistent: room.persistent,
    hasPasscode: !!room.passcodeHash,
    members: roomMembers(room),
  });
}

// Passed into the raw upload endpoint (which has no socket/session concept
// of its own) so it can reject a file from anyone who isn't a currently-
// connected member of a real room, instead of accepting one from literally
// anyone who finds this server's URL. deviceSockets is exactly "which
// devices are live in this room right now" — the same map join-room
// itself uses to detect a reconnect.
function isRoomMember(code, token) {
  const room = rooms.get((code ?? "").trim().toUpperCase());
  return !!room && !!token && room.deviceSockets.has(token);
}

const httpServer = createServer();
httpServer.on("request", createUploadsRequestHandler(ORIGIN, isRoomMember));
const io = new Server(httpServer, {
  cors: { origin: ORIGIN },
});

io.on("connection", (socket) => {
  function currentRoom() {
    const code = socket.data.roomCode;
    return code ? rooms.get(code) : undefined;
  }

  // The owner is whoever holds the device token the room was created
  // with — not tied to any one socket/session, so it survives reloads and
  // reconnects (a plain socket.id would not).
  function requireOwnerRoom() {
    const room = currentRoom();
    if (!room) return null;
    if (room.ownerToken !== socket.data.deviceToken) return null;
    return room;
  }

  socket.on("create-room", ({ name, roomName, persistent, deviceToken, passcode } = {}, ack) => {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return ack?.({ error: "Name is required." });
    const token = (deviceToken ?? "").trim();
    if (!token) return ack?.({ error: "Missing device token." });

    const trimmedPasscode = (passcode ?? "").trim();
    if (trimmedPasscode && trimmedPasscode.length < 4) {
      return ack?.({ error: "Passcode must be at least 4 characters." });
    }

    const code = generateCode();
    const now = Date.now();
    const { hash, salt } = trimmedPasscode ? hashPasscode(trimmedPasscode) : { hash: null, salt: null };
    const room = {
      code,
      name: (roomName ?? "").trim() || code,
      persistent: !!persistent,
      ownerToken: token,
      createdAt: now,
      lastActiveAt: now,
      passcodeHash: hash,
      passcodeSalt: salt,
      authorizedTokens: new Set(),
      members: new Map(),
      // device token -> current socket id, kept separate from the member
      // record itself so the token never gets sent to any client (see
      // roomMembers) — used purely to detect and evict a stale duplicate
      // when the same device reconnects under a new socket id.
      deviceSockets: new Map(),
      messages: [],
    };
    room.members.set(socket.id, {
      id: socket.id,
      name: trimmed,
      isOwner: true,
      muted: false,
      forceMuted: false,
      sharing: false,
      deviceKey: deviceKeyFor(token),
    });
    if (token) room.deviceSockets.set(token, socket.id);
    rooms.set(code, room);

    if (room.persistent) {
      upsertRoom({ code, name: room.name, ownerToken: token, createdAt: now, lastActiveAt: now });
      if (room.passcodeHash) setRoomPasscodeRow(room.code, room.passcodeHash, room.passcodeSalt);
    }

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = trimmed;
    socket.data.deviceToken = token;

    ack?.({
      code,
      name: room.name,
      persistent: room.persistent,
      hasPasscode: !!room.passcodeHash,
      members: roomMembers(room),
      messages: room.messages,
    });
  });

  socket.on("join-room", ({ name, code, deviceToken, passcode } = {}, ack) => {
    const trimmed = (name ?? "").trim();
    const normalizedCode = (code ?? "").trim().toUpperCase();
    if (!trimmed) return ack?.({ error: "Name is required." });

    if (tooManyFailedJoins(socket.id)) {
      return ack?.({ error: "Too many attempts. Wait a minute and try again." });
    }

    const room = rooms.get(normalizedCode);
    if (!room) {
      noteFailedJoin(socket.id);
      return ack?.({ error: "No room found with that code." });
    }

    if (!room.members.has(socket.id) && room.members.size >= MAX_MEMBERS) {
      return ack?.({ error: "This room is full." });
    }

    const token = (deviceToken ?? "").trim();
    const isOwnerToken = !!token && token === room.ownerToken;
    const alreadyAuthorized = !!token && room.authorizedTokens.has(token);

    if (room.passcodeHash && !isOwnerToken && !alreadyAuthorized) {
      const attempt = (passcode ?? "").trim();
      if (!verifyPasscode(attempt, room.passcodeHash, room.passcodeSalt)) {
        // Counts against the same budget as a wrong code: otherwise
        // knowing a room's code buys unlimited guesses at its passcode.
        // An empty attempt is the client asking whether a passcode is
        // needed before it shows the prompt, so it isn't held against you.
        if (attempt) noteFailedJoin(socket.id);
        return ack?.({ error: "This room requires a passcode.", needsPasscode: true });
      }
      if (token) {
        room.authorizedTokens.add(token);
        if (room.persistent) addRoomAccess(room.code, token);
      }
    }

    // A fast client-side reconnect (new socket id) can beat the server's
    // own disconnect detection for the OLD socket, which only fires after
    // a missed-heartbeat timeout — without this, the old member sits around
    // as a visible ghost duplicate for up to that timeout before vanishing.
    // Evicting it here, the moment the same device rejoins, closes that gap.
    if (token) {
      const staleId = room.deviceSockets.get(token);
      if (staleId && staleId !== socket.id) {
        room.members.delete(staleId);
        io.sockets.sockets.get(staleId)?.disconnect(true);
      }
      room.deviceSockets.set(token, socket.id);
    }

    const existing = room.members.get(socket.id);
    room.members.set(socket.id, {
      id: socket.id,
      name: trimmed,
      isOwner: isOwnerToken,
      muted: existing?.muted ?? false,
      forceMuted: existing?.forceMuted ?? false,
      sharing: existing?.sharing ?? false,
      deviceKey: deviceKeyFor(token),
    });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.name = trimmed;
    socket.data.deviceToken = token;

    room.lastActiveAt = Date.now();
    if (room.persistent) touchRoomActivity(room.code, room.lastActiveAt);

    ack?.({
      code: room.code,
      name: room.name,
      persistent: room.persistent,
      hasPasscode: !!room.passcodeHash,
      members: roomMembers(room),
      messages: room.messages,
    });
    broadcastRoom(io, room);
  });

  socket.on("send-message", async ({ text, attachment } = {}, ack) => {
    const trimmed = (text ?? "").trim();
    if (!trimmed && !attachment) return;

    const room = currentRoom();
    if (!room) return ack?.({ error: "You're not in a room." });

    const author = room.members.get(socket.id);
    if (!author) return ack?.({ error: "You're not in a room." });

    let linkPreview;
    if (!attachment && /^https?:\/\/\S+$/i.test(trimmed)) {
      linkPreview = await fetchLinkPreview(trimmed).catch(() => undefined);
    }

    const message = {
      id: `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      authorId: socket.id,
      authorName: author.name,
      text: trimmed,
      attachment: attachment ?? undefined,
      linkPreview,
      createdAt: Date.now(),
    };
    room.messages.push(message);
    if (room.messages.length > MAX_HISTORY) room.messages.shift();
    room.lastActiveAt = message.createdAt;
    if (room.persistent) {
      insertMessage(room.code, message);
      touchRoomActivity(room.code, room.lastActiveAt);
    }

    io.to(room.code).emit("chat-message", message);
    ack?.({ ok: true });

    if (attachment?.kind === "video" && attachment.status === "processing") {
      processVideoMessage(io, room.code, message.id, attachment.url, attachment.duration).catch(
        () => {},
      );
    }
  });

  socket.on("set-muted", ({ muted } = {}) => {
    const room = currentRoom();
    const member = room?.members.get(socket.id);
    if (!room || !member) return;
    member.muted = !!muted;
    broadcastRoom(io, room);
  });

  socket.on("set-sharing", ({ sharing } = {}) => {
    const room = currentRoom();
    const member = room?.members.get(socket.id);
    if (!room || !member) return;
    member.sharing = !!sharing;
    broadcastRoom(io, room);
  });

  socket.on("rename-room", ({ roomName } = {}) => {
    const room = requireOwnerRoom();
    const trimmed = (roomName ?? "").trim();
    if (!room || !trimmed) return;
    room.name = trimmed;
    if (room.persistent) renameRoomRow(room.code, trimmed);
    broadcastRoom(io, room);
  });

  socket.on("regenerate-code", (_payload, ack) => {
    const room = requireOwnerRoom();
    if (!room) return ack?.({ error: "Only the room owner can do that." });

    const oldCode = room.code;
    const newCode = generateCode();
    rooms.delete(oldCode);
    room.code = newCode;
    rooms.set(newCode, room);
    if (room.persistent) recodeRoomRow(oldCode, newCode);

    io.to(oldCode).emit("room-recoded", { code: newCode });
    ack?.({ code: newCode });
  });

  socket.on("set-persistent", ({ persistent } = {}) => {
    const room = requireOwnerRoom();
    if (!room) return;
    room.persistent = !!persistent;
    if (room.persistent) {
      upsertRoom({
        code: room.code,
        name: room.name,
        ownerToken: room.ownerToken,
        createdAt: room.createdAt,
        lastActiveAt: room.lastActiveAt,
      });
      if (room.passcodeHash) setRoomPasscodeRow(room.code, room.passcodeHash, room.passcodeSalt);
      for (const authorizedToken of room.authorizedTokens) addRoomAccess(room.code, authorizedToken);
    } else {
      deleteRoomRow(room.code);
    }
    broadcastRoom(io, room);
  });

  // Setting a new passcode revokes everyone else's standing access (they'll
  // need the new one too) — the owner never needed it in the first place.
  socket.on("set-passcode", ({ passcode } = {}, ack) => {
    const room = requireOwnerRoom();
    if (!room) return ack?.({ error: "Only the room owner can do that." });

    const trimmed = (passcode ?? "").trim();
    if (trimmed) {
      if (trimmed.length < 4) return ack?.({ error: "Passcode must be at least 4 characters." });
      const { hash, salt } = hashPasscode(trimmed);
      room.passcodeHash = hash;
      room.passcodeSalt = salt;
      room.authorizedTokens = new Set();
      if (room.persistent) {
        setRoomPasscodeRow(room.code, hash, salt);
        clearRoomAccess(room.code);
      }
    } else {
      room.passcodeHash = null;
      room.passcodeSalt = null;
      if (room.persistent) setRoomPasscodeRow(room.code, null, null);
    }
    ack?.({ hasPasscode: !!room.passcodeHash });
  });

  socket.on("kick-member", ({ memberId } = {}) => {
    const room = requireOwnerRoom();
    if (!room || !memberId || memberId === socket.id) return;
    const target = io.sockets.sockets.get(memberId);
    if (!target || !room.members.has(memberId)) return;

    target.emit("kicked");
    leaveCurrentRoom(target);
    target.disconnect(true);
  });

  // A server-enforced mute — distinct from a member's own "muted" flag
  // (which they toggle freely for themselves) so the target can't just
  // unmute themselves back. The target's own client forces its outgoing
  // track off whenever its own member entry comes back force-muted.
  socket.on("force-mute-member", ({ memberId, muted } = {}) => {
    const room = requireOwnerRoom();
    if (!room || !memberId || memberId === socket.id) return;
    const member = room.members.get(memberId);
    if (!member) return;
    member.forceMuted = !!muted;
    broadcastRoom(io, room);
  });

  socket.on("end-room", () => {
    const room = requireOwnerRoom();
    if (!room) return;
    destroyRoom(io, room);
  });

  // Deletes a persistent room from the "My Rooms" list without requiring
  // the caller to actually be joined to it — ownership is proven by device
  // token alone, the same way "get-rooms-status" reports it.
  socket.on("delete-room-by-code", ({ code, deviceToken } = {}, ack) => {
    const normalizedCode = (code ?? "").trim().toUpperCase();
    const token = (deviceToken ?? "").trim();
    const room = rooms.get(normalizedCode);
    if (!room || !token || room.ownerToken !== token) {
      return ack?.({ error: "Only the room owner can do that." });
    }
    destroyRoom(io, room);
    ack?.({ ok: true });
  });

  // Lets the "My Rooms" list show live status (online / last known name)
  // for a batch of bookmarked codes without joining any of them.
  socket.on("get-rooms-status", ({ codes, deviceToken } = {}, ack) => {
    const list = Array.isArray(codes) ? codes : [];
    const token = (deviceToken ?? "").trim();
    const statuses = list.map((code) => {
      const room = rooms.get(code);
      if (!room) return { code, exists: false };
      return {
        code: room.code,
        exists: true,
        name: room.name,
        online: room.members.size,
        lastActiveAt: room.lastActiveAt,
        isOwner: !!token && room.ownerToken === token,
        hasPasscode: !!room.passcodeHash,
      };
    });
    ack?.(statuses);
  });

  // Fetched once per voice session (see useVoiceRoom's mic-acquisition
  // effect) rather than baked into client code, so the TURN credentials
  // stay short-lived and the API token never leaves this server. Gated on
  // actually being in a room — these are real, working relay credentials,
  // usable for anything, not just this app's own traffic, so a socket that
  // never joined a room (i.e. never got past create-room/join-room) only
  // gets the free public STUN server, never the paid TURN allocation.
  socket.on("get-ice-servers", async (ack) => {
    if (!socket.data.roomCode) return ack?.(FALLBACK_ICE_SERVERS);
    ack?.(await fetchIceServers());
  });

  // WebRTC signaling relay — the server never inspects SDP/ICE payloads,
  // it just forwards them to the named peer. Both sides already learned
  // each other's socket id from room-update, so this is enough to
  // establish a mesh of direct peer connections for voice.
  socket.on("voice-offer", ({ to, sdp } = {}) => {
    if (!to || !sdp) return;
    io.to(to).emit("voice-offer", { from: socket.id, sdp });
  });
  socket.on("voice-answer", ({ to, sdp } = {}) => {
    if (!to || !sdp) return;
    io.to(to).emit("voice-answer", { from: socket.id, sdp });
  });
  socket.on("voice-ice-candidate", ({ to, candidate } = {}) => {
    if (!to || !candidate) return;
    io.to(to).emit("voice-ice-candidate", { from: socket.id, candidate });
  });

  socket.on("leave-room", () => leaveCurrentRoom(socket));
  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);
    joinFailures.delete(socket.id);
  });

  function leaveCurrentRoom(socket) {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.members.delete(socket.id);
    // Only clear the device's slot if it's still pointing at this socket —
    // a newer reconnect may have already claimed it and evicted this one,
    // in which case that mapping belongs to the new socket, not this leave.
    if (socket.data.deviceToken && room.deviceSockets.get(socket.data.deviceToken) === socket.id) {
      room.deviceSockets.delete(socket.data.deviceToken);
    }
    socket.leave(code);
    socket.data.roomCode = undefined;

    if (room.members.size === 0 && !room.persistent) {
      rooms.delete(code);
      deleteAttachmentFiles(room.messages).catch(() => {});
      return;
    }
    broadcastRoom(io, room);
  }
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server listening on :${PORT}`);
});
