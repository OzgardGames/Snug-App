"use client";

// Krisp-style background noise removal — RNNoise (xiph/rnnoise), a small
// neural denoiser, run client-side as an AudioWorklet so it costs nothing
// server-side and needs no account/API key (unlike Krisp itself, which is a
// closed, paid SDK). The worklet processor + its .wasm binaries can't be
// bundled by Next.js (AudioWorklet.addModule and the wasm loader both need
// a fetchable URL, not a module import), so they're copied into public/ at
// install time instead — see scripts/copy-rnnoise-assets.mjs.
import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";

const WORKLET_URL = "/rnnoise/workletProcessor.js";
const WASM_URL = "/rnnoise/rnnoise.wasm";
const WASM_SIMD_URL = "/rnnoise/rnnoise_simd.wasm";

// The wasm binary and the worklet module registration are both reusable
// across every mic acquisition / device switch for the life of the tab —
// fetched once and cached, not once per call.
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;
function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({ url: WASM_URL, simdUrl: WASM_SIMD_URL }).catch((err) => {
      wasmBinaryPromise = null; // let a later attempt retry instead of caching the failure forever
      throw err;
    });
  }
  return wasmBinaryPromise;
}

// AudioContext#audioWorklet.addModule is per-context, but the module itself
// is cheap to re-register (the browser caches the fetch) — no need for the
// same never-retry-after-failure caching as the wasm binary above.
async function ensureWorkletModule(ctx: AudioContext) {
  await ctx.audioWorklet.addModule(WORKLET_URL);
}

export type NoiseSuppressionHandle = {
  /** The processed, denoised track — attach this to peer connections instead of the raw mic track. */
  track: MediaStreamTrack;
  stop: () => void;
};

export function isNoiseSuppressionSupported(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    "audioWorklet" in AudioContext.prototype
  );
}

// Builds a small Web Audio graph — rawTrack -> RNNoise worklet -> a fresh
// output track — and hands back that output track plus a matching cleanup
// function. rawTrack itself is untouched (not stopped, not disabled); the
// caller keeps owning it exactly as before.
export async function applyNoiseSuppression(
  rawTrack: MediaStreamTrack,
): Promise<NoiseSuppressionHandle> {
  if (!isNoiseSuppressionSupported()) {
    throw new Error("AudioWorklet isn't supported in this browser.");
  }

  // RNNoise's model assumes 48kHz input/output (see RnnoiseWorkletNode's own
  // doc comment) — forcing the context to that rate makes the browser
  // resample the mic's native rate at the graph boundary instead of feeding
  // RNNoise samples it wasn't trained on.
  const ctx = new AudioContext({ sampleRate: 48000 });
  try {
    const [wasmBinary] = await Promise.all([getWasmBinary(), ensureWorkletModule(ctx)]);

    const source = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
    const rnnoise = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    const destination = ctx.createMediaStreamDestination();
    source.connect(rnnoise).connect(destination);

    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error("RNNoise produced no output track.");

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      rnnoise.destroy();
      source.disconnect();
      ctx.close().catch(() => {});
    };
    // If the underlying device disappears mid-call, tear the graph down
    // with it rather than leaking an AudioContext nothing is reading from.
    track.addEventListener("ended", stop);

    return { track, stop };
  } catch (err) {
    ctx.close().catch(() => {});
    throw err;
  }
}
