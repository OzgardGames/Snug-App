import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPasscode(passcode) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(passcode, salt, 64).toString("hex");
  return { hash, salt };
}

export function verifyPasscode(passcode, hash, salt) {
  if (!passcode || !hash || !salt) return false;
  const candidate = scryptSync(passcode, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
