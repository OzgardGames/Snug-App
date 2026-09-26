"use client";

// HTMLMediaElement.volume is capped at 1.0 by spec — it cannot make anyone
// LOUDER than they already are, only quieter. Boosting past 100% needs a
// Web Audio gain stage.
//
// ONLY past 100%. Everything at or below unity plays the peer's own stream
// straight out of the <audio> element, untouched. The first version of this
// routed EVERY peer through the graph whatever their volume, which made the
// whole room silent: Chromium only runs a remote WebRTC stream's audio
// pipeline while that stream is attached to a media element, and swapping
// the element over to the processed stream detached it. Outgoing audio was
// unaffected, so it presented as "they can hear me, I can't hear anyone" —
// and it did that for everybody, since nobody has to touch a volume slider
// for the default path to run.
//
// When a boost IS asked for, the source stream is kept attached to a muted
// element of its own (`pump` below) for exactly that reason.
//
// The processed audio is handed back to the same <audio> element rather
// than played through the AudioContext's own output, which keeps
// setSinkId() working: speaker selection is a media-element feature, and
// routing playback through the context instead would have silently broken
// it. So the element stays the thing that plays; the graph only sits in
// front of it.
//
// ponytail: one AudioContext per boosted peer, created lazily. Fine at a
// 10-person ceiling, and in practice only one or two people are ever
// boosted at once.

type Chain = {
  context: AudioContext;
  gain: GainNode;
  /** The processed stream to feed the <audio> element. */
  stream: MediaStream;
  /** Keeps the source stream attached to SOME element — see the note above. */
  pump: HTMLAudioElement;
  /** The source stream this chain was built for, to detect a peer's stream changing. */
  sourceStream: MediaStream;
};

const chains = new Map<string, Chain>();

/**
 * The stream that should actually be played for this peer.
 *
 * At or below 1 that's the peer's own stream and any existing gain chain is
 * torn down; above 1 it's a gain-boosted copy (2 = double). Falls back to
 * the original stream if Web Audio isn't usable, so audio is never lost to
 * a failure here — worst case the boost doesn't apply.
 */
export function playbackStream(peerId: string, source: MediaStream, volume: number): MediaStream {
  if (volume <= 1) {
    releaseGain(peerId);
    return source;
  }

  let chain = chains.get(peerId);

  // A reconnect hands over a brand new stream for the same peer; the old
  // graph is wired to a track that's finished and would stay silent.
  if (chain && chain.sourceStream !== source) {
    releaseGain(peerId);
    chain = undefined;
  }

  if (!chain) {
    try {
      const context = new AudioContext();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      context.createMediaStreamSource(source).connect(gain);
      gain.connect(destination);

      const pump = new Audio();
      pump.srcObject = source;
      pump.muted = true;
      void pump.play().catch(() => {});

      chain = { context, gain, stream: destination.stream, pump, sourceStream: source };
      chains.set(peerId, chain);
    } catch {
      return source;
    }
  }

  // Chromium suspends a context created before any user gesture; without
  // this the peer is inaudible rather than merely un-boosted.
  if (chain.context.state === "suspended") void chain.context.resume().catch(() => {});

  chain.gain.gain.value = volume;
  return chain.stream;
}

export function releaseGain(peerId: string) {
  const chain = chains.get(peerId);
  if (!chain) return;
  chains.delete(peerId);
  chain.pump.pause();
  chain.pump.srcObject = null;
  try {
    chain.gain.disconnect();
  } catch {
    // Already torn down with the context — nothing to undo.
  }
  void chain.context.close().catch(() => {});
}
