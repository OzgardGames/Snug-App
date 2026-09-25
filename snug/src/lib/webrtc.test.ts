import { describe, expect, it, vi } from "vitest";
import { replaceAudioTrack } from "./webrtc";

// The addTrack fallback is what lets someone who joined while their
// getUserMedia was still pending be heard at all: the connection the other
// side offered got no audio sender, so there is nothing to replaceTrack
// onto, and without addTrack they stay silent until they re-join.

const track = (kind: string) => ({ kind }) as MediaStreamTrack;

function fakePeer(senders: { track: MediaStreamTrack | null }[]) {
  return {
    getSenders: () => senders.map((s) => ({ ...s, replaceTrack: vi.fn() })),
    addTrack: vi.fn(),
  };
}

describe("replaceAudioTrack", () => {
  const mic = track("audio");
  const stream = {} as MediaStream;

  it("adds the track when the connection has no audio sender yet", () => {
    const pc = fakePeer([{ track: track("video") }]);
    replaceAudioTrack(pc as unknown as RTCPeerConnection, mic, stream);
    expect(pc.addTrack).toHaveBeenCalledWith(mic, stream);
  });

  it("does nothing without a stream to add to", () => {
    const pc = fakePeer([]);
    replaceAudioTrack(pc as unknown as RTCPeerConnection, mic);
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it("replaces an existing audio sender instead of adding a second one", () => {
    const senders = [{ track: track("audio"), replaceTrack: vi.fn() }];
    const pc = { getSenders: () => senders, addTrack: vi.fn() };
    replaceAudioTrack(pc as unknown as RTCPeerConnection, mic, stream);
    expect(senders[0].replaceTrack).toHaveBeenCalledWith(mic);
    expect(pc.addTrack).not.toHaveBeenCalled();
  });

  it("skips the shared screen's audio sender when looking for the mic", () => {
    const screenAudio = track("audio");
    const senders = [
      { track: screenAudio, replaceTrack: vi.fn() },
      { track: track("audio"), replaceTrack: vi.fn() },
    ];
    const pc = { getSenders: () => senders, addTrack: vi.fn() };
    replaceAudioTrack(pc as unknown as RTCPeerConnection, mic, stream, screenAudio);
    expect(senders[0].replaceTrack).not.toHaveBeenCalled();
    expect(senders[1].replaceTrack).toHaveBeenCalledWith(mic);
  });
});
