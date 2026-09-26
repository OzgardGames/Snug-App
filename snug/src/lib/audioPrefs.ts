"use client";

// A device chosen on the home screen (before any room/voice connection
// exists) or from within a room — either way it's remembered here so it's
// the one useVoiceRoom reaches for the next time a mic actually gets
// acquired, instead of everyone always starting back on the OS default.
const MIC_KEY = "snug-preferred-mic";
const SPEAKER_KEY = "snug-preferred-speaker";
const NOISE_SUPPRESSION_KEY = "snug-noise-suppression";

function read(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string | undefined) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private browsing, quota) — the
    // preference just won't stick, which is fine, not worth surfacing.
  }
}

export const getPreferredMic = () => read(MIC_KEY);
export const setPreferredMic = (deviceId: string | undefined) => write(MIC_KEY, deviceId);
export const getPreferredSpeaker = () => read(SPEAKER_KEY);
export const setPreferredSpeaker = (deviceId: string | undefined) => write(SPEAKER_KEY, deviceId);

// Defaults to on — RNNoise is cheap enough (a few % CPU) that most people
// are better off with it than without, and it's one click away in Settings
// for anyone who'd rather not.
export const getNoiseSuppressionEnabled = () => read(NOISE_SUPPRESSION_KEY) !== "off";
export const setNoiseSuppressionEnabled = (enabled: boolean) =>
  write(NOISE_SUPPRESSION_KEY, enabled ? "on" : "off");

// Whether a screen share carries the system's sound with it.
//
// Defaults to on: a shared game without its audio is half a share. It's a
// choice at all because Windows loopback is the whole output mix, which
// includes Snug playing everyone else's voices — so a share with sound also
// sends the room's own voices back out, arriving a few hundred milliseconds
// late for whoever is listening. Anyone who runs into that can turn it off
// here rather than stop sharing. (A viewer can also just mute the stream on
// their own side — see the stage controls in the room.)
const SHARE_SYSTEM_AUDIO_KEY = "snug-share-system-audio";

export const getShareSystemAudio = () => read(SHARE_SYSTEM_AUDIO_KEY) !== "off";
export const setShareSystemAudio = (enabled: boolean) =>
  write(SHARE_SYSTEM_AUDIO_KEY, enabled ? "on" : "off");
