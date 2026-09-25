"use client";

// HTMLMediaElement.volume is capped at 1.0 by spec — it cannot make anyone
// LOUDER than they already are, only quieter. Boosting past 100% needs a
// Web Audio gain stage.
//
// The processed audio is handed back to the same <audio> element rather
// than played through the AudioContext's own output, which keeps
// setSinkId() working: speaker selection is a media-element feature, and
// routing playback through the context instead would have silently broken
// it. So the element stays the thing that plays; the graph only sits in
// front of it.
//
// ponytail: one AudioContext per peer, created lazily. Fine at a 10-person
// ceiling; if rooms ever get much bigger, share a single context and give
// each peer only its own GainNode.

type Chain = {
  context: AudioContext;
  gain: GainNode;
  /** The processed stream to feed the <audio> element. */
  stream: MediaStream;
  /** The source stream this chain was built for, to detect a peer's stream changing. */
  sourceStream: MediaStream;
};

const chains = new Map<string, Chain>();

/**
 * Returns the stream that should be played for this peer, with `volume`
 * applied as gain (1 = unchanged, 2 = double). Falls back to the original
 * stream if Web Audio isn't usable, so audio is never lost to a failure
 * here — worst case the boost doesn't apply.
 */
export function gainedStream(peerId: string, source: MediaStream, volume: number): MediaStream {
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
      chain = { context, gain, stream: destination.stream, sourceStream: source };
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
  try {
    chain.gain.disconnect();
  } catch {
    // Already torn down with the context — nothing to undo.
  }
  void chain.context.close().catch(() => {});
}
