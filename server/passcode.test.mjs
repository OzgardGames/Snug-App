import { describe, expect, it } from "vitest";
import { hashPasscode, verifyPasscode } from "./passcode.mjs";

// Room passcodes are the only thing standing between a guessed room code
// and someone else's room, so the properties below are the ones that
// actually matter if this is ever refactored.
describe("room passcodes", () => {
  it("accepts the correct passcode", () => {
    const { hash, salt } = hashPasscode("hunter2");
    expect(verifyPasscode("hunter2", hash, salt)).toBe(true);
  });

  it("rejects a wrong passcode", () => {
    const { hash, salt } = hashPasscode("hunter2");
    expect(verifyPasscode("hunter3", hash, salt)).toBe(false);
    expect(verifyPasscode("", hash, salt)).toBe(false);
    expect(verifyPasscode("HUNTER2", hash, salt)).toBe(false);
  });

  it("never stores the passcode itself", () => {
    const { hash, salt } = hashPasscode("hunter2");
    expect(hash).not.toContain("hunter2");
    expect(salt).not.toContain("hunter2");
  });

  it("salts each passcode separately, so identical passcodes hash differently", () => {
    const a = hashPasscode("same");
    const b = hashPasscode("same");
    expect(a.salt).not.toEqual(b.salt);
    expect(a.hash).not.toEqual(b.hash);
    // ...and each still verifies against its own salt.
    expect(verifyPasscode("same", a.hash, a.salt)).toBe(true);
    expect(verifyPasscode("same", b.hash, b.salt)).toBe(true);
  });

  it("treats missing hash/salt as a failure rather than a pass", () => {
    expect(verifyPasscode("anything", undefined, undefined)).toBe(false);
    expect(verifyPasscode("anything", "", "")).toBe(false);
  });

  it("rejects a passcode checked against another passcode's salt", () => {
    const a = hashPasscode("alpha");
    const b = hashPasscode("bravo");
    expect(verifyPasscode("alpha", a.hash, b.salt)).toBe(false);
  });
});
