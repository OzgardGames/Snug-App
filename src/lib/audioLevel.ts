// Lightweight voice-activity detector: samples a stream's volume on an
// interval and reports whether it's currently above a talking threshold,
// with a short hold time so brief dips between words don't flicker the UI.
const SAMPLE_MS = 100;
const HOLD_MS = 300;
const THRESHOLD = 10; // average deviation from silence (0-128 scale)

export type LevelMeter = {
  stop: () => void;
};

export function watchAudioLevel(
  stream: MediaStream,
  onChange: (talking: boolean) => void,
): LevelMeter {
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  let talking = false;
  let lastAbove = 0;

  const interval = setInterval(() => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += Math.abs(data[i] - 128);
    }
    const level = sum / data.length;

    if (level > THRESHOLD) {
      lastAbove = Date.now();
      if (!talking) {
        talking = true;
        onChange(true);
      }
    } else if (talking && Date.now() - lastAbove > HOLD_MS) {
      talking = false;
      onChange(false);
    }
  }, SAMPLE_MS);

  return {
    stop: () => {
      clearInterval(interval);
      source.disconnect();
      ctx.close().catch(() => {});
    },
  };
}
