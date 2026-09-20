const STORAGE_KEY = "snug-device-id";

// A stable per-browser identity, unrelated to any one socket connection or
// session. Room ownership is checked against this instead of socket.id so
// the owner doesn't lose ownership on reload/reconnect — there are no user
// accounts, so this is the only durable "who is this" the app has.
export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}
