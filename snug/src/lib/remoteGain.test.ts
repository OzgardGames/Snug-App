import { afterEach, describe, expect, it, vi } from "vitest";
import { playbackStream, releaseGain } from "./remoteGain";

// The bug this guards: every peer was routed through a Web Audio graph
// whatever their volume, which detached the remote stream from any media
// element and left the whole room silent. At or below 100% the element must
// keep playing the peer's own stream, untouched.

const processed = { id: "processed" } as unknown as MediaStream;

class FakeContext {
  state = "running";
  closed = false;
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  createMediaStreamDestination() {
    return { stream: processed };
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

const pumps: { srcObject: unknown; muted: boolean; played: boolean }[] = [];
class FakeAudio {
  srcObject: unknown = null;
  muted = false;
  played = false;
  constructor() {
    pumps.push(this as unknown as (typeof pumps)[number]);
  }
  play() {
    this.played = true;
    return Promise.resolve();
  }
  pause() {}
}

vi.stubGlobal("AudioContext", FakeContext);
vi.stubGlobal("Audio", FakeAudio);

afterEach(() => {
  releaseGain("peer");
  pumps.length = 0;
});

describe("playbackStream", () => {
  const source = { id: "remote" } as unknown as MediaStream;

  it("plays the peer's own stream at normal volume", () => {
    expect(playbackStream("peer", source, 1)).toBe(source);
    expect(pumps).toHaveLength(0);
  });

  it("plays the peer's own stream when quieter than normal", () => {
    expect(playbackStream("peer", source, 0.4)).toBe(source);
    expect(pumps).toHaveLength(0);
  });

  it("routes through the graph only above 100%", () => {
    expect(playbackStream("peer", source, 1.8)).toBe(processed);
  });

  it("keeps the source attached to a muted element while boosting", () => {
    playbackStream("peer", source, 1.8);
    expect(pumps).toHaveLength(1);
    expect(pumps[0].srcObject).toBe(source);
    expect(pumps[0].muted).toBe(true);
    expect(pumps[0].played).toBe(true);
  });

  it("goes back to the untouched stream when the boost is turned off", () => {
    playbackStream("peer", source, 1.8);
    expect(playbackStream("peer", source, 1)).toBe(source);
    // ...and a later boost builds a fresh graph rather than reusing a closed one.
    expect(playbackStream("peer", source, 2)).toBe(processed);
  });
});
