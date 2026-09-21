const STORAGE_KEY = "snug-my-rooms";

export type MyRoom = {
  code: string;
  name: string;
  isOwner: boolean;
};

function readAll(): MyRoom[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeAll(rooms: MyRoom[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
}

export function getMyRooms(): MyRoom[] {
  return readAll();
}

// Persistent rooms only — ephemeral ones stop existing once everyone
// leaves, so there'd be nothing to "drop back into" later.
export function rememberRoom(room: MyRoom) {
  const rooms = readAll();
  const next = rooms.filter((r) => r.code !== room.code);
  next.unshift(room);
  writeAll(next);
}

export function forgetRoom(code: string) {
  writeAll(readAll().filter((r) => r.code !== code));
}
