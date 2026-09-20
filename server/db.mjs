import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";

// DATA_DIR points at a mounted persistent volume in production (a
// deployment's container filesystem is otherwise wiped on every redeploy);
// it defaults to this file's own directory for local dev, unchanged from
// before this existed.
const DATA_DIR = process.env.DATA_DIR || path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(DATA_DIR, "snug.db");

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_code TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    text TEXT NOT NULL,
    attachment TEXT,
    link_preview TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_room_idx ON messages (room_code, created_at);
  CREATE TABLE IF NOT EXISTS room_access (
    room_code TEXT NOT NULL,
    device_token TEXT NOT NULL,
    PRIMARY KEY (room_code, device_token)
  );
`);

// Lightweight migration for columns added after a table already existed on
// disk — SQLite has no "ADD COLUMN IF NOT EXISTS", so just swallow the
// "duplicate column" error on a re-run.
function addColumnIfMissing(table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}
addColumnIfMissing("rooms", "passcode_hash TEXT");
addColumnIfMissing("rooms", "passcode_salt TEXT");

// Only persistent rooms ever get a row here — ephemeral rooms are
// in-memory-only, exactly like before this feature existed.

export function loadPersistentRooms() {
  const rows = db
    .prepare(
      "SELECT code, name, owner_token, created_at, last_active_at, passcode_hash, passcode_salt FROM rooms",
    )
    .all();
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    ownerToken: r.owner_token,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at || r.created_at,
    passcodeHash: r.passcode_hash ?? null,
    passcodeSalt: r.passcode_salt ?? null,
  }));
}

export function loadRoomAccess(code) {
  return db
    .prepare("SELECT device_token FROM room_access WHERE room_code = ?")
    .all(code)
    .map((r) => r.device_token);
}

export function addRoomAccess(code, deviceToken) {
  db.prepare(
    "INSERT OR IGNORE INTO room_access (room_code, device_token) VALUES (?, ?)",
  ).run(code, deviceToken);
}

export function clearRoomAccess(code) {
  db.prepare("DELETE FROM room_access WHERE room_code = ?").run(code);
}

export function setRoomPasscodeRow(code, hash, salt) {
  db.prepare("UPDATE rooms SET passcode_hash = ?, passcode_salt = ? WHERE code = ?").run(
    hash,
    salt,
    code,
  );
}

export function loadMessages(code) {
  const rows = db
    .prepare(
      "SELECT id, author_id, author_name, text, attachment, link_preview, created_at FROM messages WHERE room_code = ? ORDER BY created_at ASC",
    )
    .all(code);
  return rows.map((r) => ({
    id: r.id,
    authorId: r.author_id,
    authorName: r.author_name,
    text: r.text,
    attachment: r.attachment ? JSON.parse(r.attachment) : undefined,
    linkPreview: r.link_preview ? JSON.parse(r.link_preview) : undefined,
    createdAt: r.created_at,
  }));
}

export function upsertRoom({ code, name, ownerToken, createdAt, lastActiveAt }) {
  db.prepare(
    `INSERT INTO rooms (code, name, owner_token, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET name = excluded.name, owner_token = excluded.owner_token`,
  ).run(code, name, ownerToken, createdAt, lastActiveAt ?? createdAt);
}

export function touchRoomActivity(code, ts) {
  db.prepare("UPDATE rooms SET last_active_at = ? WHERE code = ?").run(ts, code);
}

export function renameRoomRow(code, name) {
  db.prepare("UPDATE rooms SET name = ? WHERE code = ?").run(name, code);
}

export function recodeRoomRow(oldCode, newCode) {
  db.prepare("UPDATE rooms SET code = ? WHERE code = ?").run(newCode, oldCode);
  db.prepare("UPDATE messages SET room_code = ? WHERE room_code = ?").run(newCode, oldCode);
  db.prepare("UPDATE room_access SET room_code = ? WHERE room_code = ?").run(newCode, oldCode);
}

export function deleteRoomRow(code) {
  db.prepare("DELETE FROM rooms WHERE code = ?").run(code);
  db.prepare("DELETE FROM messages WHERE room_code = ?").run(code);
  db.prepare("DELETE FROM room_access WHERE room_code = ?").run(code);
}

export function insertMessage(code, message) {
  db.prepare(
    "INSERT INTO messages (id, room_code, author_id, author_name, text, attachment, link_preview, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    message.id,
    code,
    message.authorId,
    message.authorName,
    message.text,
    message.attachment ? JSON.stringify(message.attachment) : null,
    message.linkPreview ? JSON.stringify(message.linkPreview) : null,
    message.createdAt,
  );
}

export function roomExists(code) {
  const row = db.prepare("SELECT 1 FROM rooms WHERE code = ?").get(code);
  return !!row;
}

export function updateMessageAttachment(code, messageId, attachment) {
  db.prepare("UPDATE messages SET attachment = ? WHERE id = ? AND room_code = ?").run(
    JSON.stringify(attachment),
    messageId,
    code,
  );
}
