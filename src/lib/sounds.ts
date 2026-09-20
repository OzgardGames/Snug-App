"use client";

import { useCallback, useEffect, useState } from "react";

// Every cue is synthesized on the fly with the Web Audio API — no audio
// files to ship, license, or load. Short pentatonic-flavored blips read as
// pleasant/playful regardless of exact timing, which keeps this forgiving
// to tweak.

export type SoundName =
  | "messageSent"
  | "messageReceived"
  | "join"
  | "shareStart"
  | "shareStop"
  | "roomJoined"
  | "kicked";

const NOTE = {
  F4: 349.23,
  A4: 440,
  C5: 523.25,
  D5: 587.33,
  E5: 659.25,
  G5: 783.99,
  A5: 880,
  B5: 987.77,
  C6: 1046.5,
  D6: 1174.66,
  E6: 1318.51,
  G6: 1567.98,
};

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// The only tone generator in the palette: two gently detuned sine
// oscillators (a natural chorus/shimmer) plus a very quiet octave-up
// overtone, with a soft bell-like decay instead of a blip. Kept quiet and
// breathy by default — every cue below leans on a couple of these at most.
function playChime(
  context: AudioContext,
  freq: number,
  start: number,
  duration: number,
  gain = 0.04,
  detuneCents = 4,
) {
  const t0 = context.currentTime + start;
  const gainNode = context.createGain();
  gainNode.gain.setValueAtTime(0, t0);
  gainNode.gain.linearRampToValueAtTime(gain, t0 + 0.04);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  gainNode.connect(context.destination);

  for (const cents of [-detuneCents, detuneCents]) {
    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.detune.value = cents;
    osc.connect(gainNode);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  }

  const overtone = context.createOscillator();
  const overtoneGain = context.createGain();
  overtone.type = "sine";
  overtone.frequency.value = freq * 2;
  overtoneGain.gain.setValueAtTime(0, t0);
  overtoneGain.gain.linearRampToValueAtTime(gain * 0.15, t0 + 0.04);
  overtoneGain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration * 0.6);
  overtone.connect(overtoneGain);
  overtoneGain.connect(context.destination);
  overtone.start(t0);
  overtone.stop(t0 + duration * 0.6 + 0.05);
}

const SEQUENCES: Record<SoundName, (c: AudioContext) => void> = {
  messageSent: (c) => playChime(c, NOTE.E5, 0, 0.28, 0.03),
  messageReceived: (c) => playChime(c, NOTE.A5, 0, 0.32, 0.03),
  // Two soft, overlapping notes — barely more than a breath.
  join: (c) => {
    playChime(c, NOTE.E5, 0, 0.4, 0.035);
    playChime(c, NOTE.B5, 0.1, 0.45, 0.032);
  },
  // A touch fuller for your own arrival, still just three quiet notes.
  roomJoined: (c) => {
    playChime(c, NOTE.C5, 0, 0.38, 0.038);
    playChime(c, NOTE.G5, 0.1, 0.42, 0.035);
    playChime(c, NOTE.D6, 0.2, 0.55, 0.032);
  },
  shareStart: (c) => {
    playChime(c, NOTE.A4, 0, 0.28, 0.03);
    playChime(c, NOTE.E5, 0.08, 0.35, 0.03);
  },
  shareStop: (c) => {
    playChime(c, NOTE.E5, 0, 0.28, 0.028);
    playChime(c, NOTE.A4, 0.08, 0.35, 0.026);
  },
  kicked: (c) => {
    playChime(c, NOTE.A4, 0, 0.3, 0.035);
    playChime(c, NOTE.F4, 0.1, 0.4, 0.032);
  },
};

const STORAGE_KEY = "snug-sound-effects";
let cache: boolean | null = null;
const listeners = new Set<(enabled: boolean) => void>();

function readPref(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === null ? true : raw === "1";
}

function isEnabled(): boolean {
  if (cache === null) cache = readPref();
  return cache;
}

export function playSound(name: SoundName) {
  if (!isEnabled()) return;
  const context = getContext();
  if (!context) return;
  try {
    SEQUENCES[name](context);
  } catch {
    // A synthesis hiccup should never take down the app.
  }
}

export function useSoundEffectsPref() {
  const [enabled, setEnabledState] = useState<boolean>(() => {
    cache = cache ?? readPref();
    return cache;
  });

  useEffect(() => {
    const listener = (next: boolean) => setEnabledState(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    cache = next;
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    listeners.forEach((l) => l(next));
  }, []);

  return { enabled, setEnabled };
}
