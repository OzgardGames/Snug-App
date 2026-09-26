"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSocket } from "@/lib/socket";
import {
  attachLocalTracks,
  createPeerConnection,
  replaceAudioTrack,
  replaceVideoTrack,
} from "@/lib/webrtc";
import { watchAudioLevel, type LevelMeter } from "@/lib/audioLevel";
import {
  getPreferredMic,
  setPreferredMic,
  getPreferredSpeaker,
  setPreferredSpeaker,
  getNoiseSuppressionEnabled,
  setNoiseSuppressionEnabled as persistNoiseSuppressionEnabled,
  getShareSystemAudio,
  getPushToTalkKey,
  setPushToTalkKey as persistPushToTalkKey,
} from "@/lib/audioPrefs";
import {
  applyNoiseSuppression,
  isNoiseSuppressionSupported,
  type NoiseSuppressionHandle,
} from "@/lib/noiseSuppression";
import { getDesktopBridge } from "@/lib/desktopBridge";

type UseVoiceRoomArgs = {
  active: boolean;
  selfId: string | undefined;
  memberIds: string[];
  forceMuted?: boolean;
};

// A hint for which tab the browser's native share picker should open on —
// respected by Chromium browsers, harmlessly ignored elsewhere. It can never
// skip the native picker itself (no web page is allowed to).
export type DisplaySurface = "monitor" | "window" | "browser";

// audio: true asks for the SHARED SCREEN's sound — the game, a video,
// whatever is playing — not the sharer's microphone, which is already going
// to everyone over their own voice track. On desktop that resolves to
// Windows loopback (see the share picker's callback in main.js); in a
// browser it's the "share audio" checkbox in Chrome's own picker, which the
// person can decline, so an audio track is never guaranteed and everything
// downstream treats it as optional.
//
// KNOWN CONSEQUENCE, worth understanding before "fixing" it: Windows
// loopback captures the whole output mix, which includes the room's own
// voices, because Snug is playing them to that same device. So whoever is
// sharing sends everyone else's voices back to them, a few hundred
// milliseconds late — audible echo for them, inaudible to the sharer, so
// it will not show up in solo testing. Headphones don't help: loopback taps
// the digital render stream, not the air. Echo cancellation doesn't touch
// it either, since to the receiver it arrives as a separate remote stream
// rather than as their own speakers bleeding into their mic.
//
// The real fix is per-process audio capture (grab only the game), which is
// what Discord does and what Electron gives no way to reach. Until then the
// honest mitigation is not sharing system audio when several people are
// talking.
function displayMediaConstraints(surface?: DisplaySurface): DisplayMediaStreamOptions {
  // Read at share time, not at mount: it's a Settings toggle, and the next
  // share should honour whatever it says now.
  const audio = getShareSystemAudio();
  return surface ? { video: { displaySurface: surface }, audio } : { video: true, audio };
}

// Closing the picker without choosing anything is a dismissal, not a failure,
// and must not raise the red banner. A browser's native picker signals that
// with NotAllowedError. The desktop app's own picker can't: cancelling means
// calling Electron's display-media callback with no arguments (see
// resolvePendingShare in snug-desktop/electron/main.js), and Electron turns
// that into AbortError "Invalid capture constraints". AbortError is only
// treated as a dismissal there, because in a real browser it means something
// genuinely went wrong and the user deserves to be told.
function isPickerDismissal(err: unknown): boolean {
  const name = (err as DOMException)?.name;
  if (name === "NotAllowedError") return true;
  return name === "AbortError" && !!getDesktopBridge()?.isDesktop;
}

export function useVoiceRoom({ active, selfId, memberIds, forceMuted = false }: UseVoiceRoomArgs) {
  const [micReady, setMicReady] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [pushToTalkMode, setPushToTalkMode] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [talkingIds, setTalkingIds] = useState<Set<string>>(new Set());
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(undefined);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] = useState<string | undefined>(
    () => getPreferredSpeaker(),
  );
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabledState] = useState(() =>
    getNoiseSuppressionEnabled(),
  );
  const [noiseSuppressionError, setNoiseSuppressionError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [remoteScreenStreams, setRemoteScreenStreams] = useState<Map<string, MediaStream>>(new Map());
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);

  const localStreamRef = useRef<MediaStream | null>(null);
  // Whichever track is actually attached to peer connections — the raw mic
  // track with suppression off, or RNNoise's output track with it on.
  // Always a single-track wrapper around whatever noiseSuppressorRef
  // currently points at (or the raw track, if it doesn't).
  const outgoingAudioStreamRef = useRef<MediaStream | null>(null);
  const noiseSuppressorRef = useRef<NoiseSuppressionHandle | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  // Stream ids known to be somebody's shared screen rather than their
  // voice. Needed because a screen share's audio and video arrive as
  // separate ontrack events in no guaranteed order, so the audio can land
  // before there's any video to identify the stream by.
  const screenStreamIdsRef = useRef<Set<string>>(new Set());
  // Fetched once per session (see the mic-acquisition effect below) from
  // the server's "get-ice-servers", which holds the actual TURN
  // credentials — never hardcoded here. Read fresh by createConnection, so
  // any peer connection made after the fetch resolves gets TURN; one made
  // before it resolves just falls back to STUN-only (createPeerConnection's
  // own default), not a broken call.
  const iceServersRef = useRef<RTCIceServer[]>([]);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const levelMetersRef = useRef<Map<string, LevelMeter>>(new Map());
  const makingOfferRef = useRef<Map<string, boolean>>(new Map());
  const selfIdRef = useRef(selfId);
  useEffect(() => {
    selfIdRef.current = selfId;
  }, [selfId]);
  // Read by the mic-acquisition effect below, which intentionally doesn't
  // depend on noiseSuppressionEnabled itself — toggling it mid-call is
  // handled by setNoiseSuppressionEnabled instead, without re-acquiring the
  // mic or rebuilding every peer connection. This just needs the current
  // value for the very first track it builds.
  const noiseSuppressionEnabledRef = useRef(noiseSuppressionEnabled);
  useEffect(() => {
    noiseSuppressionEnabledRef.current = noiseSuppressionEnabled;
  }, [noiseSuppressionEnabled]);

  // Round-trip time to the peers, straight from WebRTC's own stats rather
  // than a ping of our own: currentRoundTripTime on the succeeded candidate
  // pair is the actual media path, which is what "how good is my
  // connection" means here. The WORST peer is reported, not the average —
  // one bad link is what you'll actually hear, and averaging hides it.
  // null while there's nothing connected yet.
  const [pingMs, setPingMs] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    async function sample() {
      const peers = [...peersRef.current.values()];
      if (peers.length === 0) {
        if (!cancelled) setPingMs(null);
        return;
      }
      let worst: number | null = null;
      for (const pc of peers) {
        try {
          const report = await pc.getStats();
          report.forEach((stat) => {
            if (
              stat.type === "candidate-pair" &&
              stat.state === "succeeded" &&
              typeof stat.currentRoundTripTime === "number"
            ) {
              const ms = stat.currentRoundTripTime * 1000;
              if (worst === null || ms > worst) worst = ms;
            }
          });
        } catch {
          // A connection torn down mid-sample — the next tick covers it.
        }
      }
      if (!cancelled) setPingMs(worst === null ? null : Math.round(worst));
    }
    void sample();
    const id = setInterval(sample, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [active]);

  // Instant replay records in its own hidden window, which has no access to
  // this page's device list and gets different deviceIds for the same
  // hardware (Chromium salts them per origin). The label is the one thing
  // that means the same in both places, so it's what gets reported — see
  // resolveMicConstraint in recording.html.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    const label = devices.find((d) => d.deviceId === selectedDeviceId)?.label ?? null;
    bridge.reportPreferredMicLabel(label);
  }, [devices, selectedDeviceId]);

  // Tears down any RNNoise graph and (if suppress) builds a fresh one for
  // rawTrack, returning whichever track should actually go out over the
  // wire. Shared by the mic-acquisition effect, selectDevice, and the
  // public toggle — all three points where the outgoing track can change.
  const buildOutgoingTrack = useCallback(async (rawTrack: MediaStreamTrack, suppress: boolean) => {
    noiseSuppressorRef.current?.stop();
    noiseSuppressorRef.current = null;
    if (!suppress) {
      setNoiseSuppressionError(null);
      return rawTrack;
    }
    try {
      // applyNoiseSuppression fetches + compiles a WASM module and spins up
      // an AudioWorklet — on a slow connection or first launch (nothing
      // cached yet) that can stall well past what feels like "the mic
      // isn't working", and unlike a rejection, a stall never reaches the
      // catch below on its own — it would just hang the whole mic
      // acquisition effect forever, leaving micReady stuck false with no
      // error shown (the exact "mic not detected until I reconnect" report).
      // Racing it against a timeout guarantees this always settles one way
      // or the other.
      const handle = await Promise.race([
        applyNoiseSuppression(rawTrack),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Noise suppression setup timed out.")), 4000),
        ),
      ]);
      noiseSuppressorRef.current = handle;
      setNoiseSuppressionError(null);
      return handle.track;
    } catch {
      setNoiseSuppressionError(
        "Noise suppression isn't supported in this browser — using your raw microphone instead.",
      );
      return rawTrack;
    }
  }, []);

  const trackTalking = useCallback((id: string, talking: boolean) => {
    setTalkingIds((prev) => {
      if (talking === prev.has(id)) return prev;
      const next = new Set(prev);
      if (talking) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Every connection uses "perfect negotiation": whoever has the lower id
  // is impolite (their offer always wins a collision), the other is polite
  // (rolls back and accepts the incoming offer instead). This lets either
  // side freely add/remove tracks later — e.g. starting a screen share —
  // without the two sides ever deadlocking or double-offering.
  const createConnection = useCallback(
    (peerId: string) => {
      const pc = createPeerConnection(iceServersRef.current);
      makingOfferRef.current.set(peerId, false);

      pc.onnegotiationneeded = async () => {
        try {
          makingOfferRef.current.set(peerId, true);
          await pc.setLocalDescription();
          getSocket().emit("voice-offer", { to: peerId, sdp: pc.localDescription });
        } catch {
          // ignored — a follow-up negotiationneeded will retry if this was transient
        } finally {
          makingOfferRef.current.set(peerId, false);
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          getSocket().emit("voice-ice-candidate", { to: peerId, candidate: e.candidate.toJSON() });
        }
      };

      pc.ontrack = (e) => {
        const [stream] = e.streams;
        if (!stream) return;
        if (e.track.kind === "video") {
          screenStreamIdsRef.current.add(stream.id);
          setRemoteScreenStreams((prev) => new Map(prev).set(peerId, stream));
          // If this stream's AUDIO arrived first it was taken for their
          // voice — the video track is what identifies it as a screen, so
          // undo that here rather than leaving a game's soundtrack driving
          // their talking indicator.
          setRemoteStreams((prev) => {
            if (prev.get(peerId)?.id !== stream.id) return prev;
            const next = new Map(prev);
            next.delete(peerId);
            return next;
          });
          if (levelMetersRef.current.get(peerId)) {
            levelMetersRef.current.get(peerId)?.stop();
            levelMetersRef.current.delete(peerId);
            trackTalking(peerId, false);
          }
          e.track.onended = () => {
            screenStreamIdsRef.current.delete(stream.id);
            setRemoteScreenStreams((prev) => {
              if (!prev.has(peerId)) return prev;
              const next = new Map(prev);
              next.delete(peerId);
              return next;
            });
          };
          return;
        }
        // A screen share with sound sends its audio in the SAME stream as
        // its video, so anything arriving in a stream that carries video
        // belongs to the shared screen, not to the person. It still reaches
        // the viewer — the <video> element playing that stream plays its
        // audio too — it just isn't their voice, and must not replace it or
        // light up their talking indicator.
        if (screenStreamIdsRef.current.has(stream.id) || stream.getVideoTracks().length > 0) {
          screenStreamIdsRef.current.add(stream.id);
          return;
        }
        setRemoteStreams((prev) => new Map(prev).set(peerId, stream));
        levelMetersRef.current.get(peerId)?.stop();
        levelMetersRef.current.set(
          peerId,
          watchAudioLevel(stream, (talking) => trackTalking(peerId, talking)),
        );
      };

      // A network blip (WiFi hiccup, brief packet loss) drops ICE into
      // "disconnected" — often self-clearing within a couple of seconds as
      // the existing candidates recover, which is exactly the "can't talk
      // for a bit, then it's back on its own" pattern. Nothing here forced
      // that recovery before; audio was purely at the mercy of Chrome's own
      // internal retry, which can also just never happen. Giving it a
      // grace window before forcing a real ICE restart (which re-triggers
      // onnegotiationneeded above, reusing the same perfect-negotiation
      // flow) means a real recovery is never fought — only a stall that's
      // still stuck once the grace period elapses gets kicked.
      pc.oniceconnectionstatechange = () => {
        const state = pc.iceConnectionState;
        if (state === "failed") {
          pc.restartIce();
        } else if (state === "disconnected") {
          setTimeout(() => {
            if (pc.iceConnectionState === "disconnected") pc.restartIce();
          }, 3000);
        }
      };

      if (outgoingAudioStreamRef.current) attachLocalTracks(pc, outgoingAudioStreamRef.current);
      if (screenStreamRef.current) attachLocalTracks(pc, screenStreamRef.current);

      peersRef.current.set(peerId, pc);
      return pc;
    },
    [trackTalking],
  );

  // ---- acquire the local microphone ----
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // These Maps are owned by this hook and never reassigned, only
    // mutated in place — capturing the reference here and using it in
    // cleanup is equivalent to reading .current there.
    const peers = peersRef.current;
    const pendingCandidates = pendingCandidatesRef.current;
    const levelMeters = levelMetersRef.current;
    const makingOffer = makingOfferRef.current;

    // Fired independently of mic acquisition (not chained after it) so it's
    // already in flight well before the first peer connection is ever made.
    getSocket().emit("get-ice-servers", (servers: RTCIceServer[]) => {
      if (!cancelled) iceServersRef.current = servers ?? [];
    });

    const preferredMic = getPreferredMic();
    navigator.mediaDevices
      .getUserMedia(preferredMic ? { audio: { deviceId: { exact: preferredMic } } } : { audio: true })
      .catch((err: DOMException) => {
        // The device picked earlier (on the home screen, or in a past
        // room) might be unplugged or gone now — fall back to whatever
        // the OS considers default rather than failing to join at all.
        if (!preferredMic) throw err;
        return navigator.mediaDevices.getUserMedia({ audio: true });
      })
      .then(async (stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = stream;
        const acquiredDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId;
        setSelectedDeviceId(acquiredDeviceId);
        // Keeps the stored preference honest if the preferred device was
        // unavailable and this is actually the fallback default.
        if (acquiredDeviceId) setPreferredMic(acquiredDeviceId);

        const rawTrack = stream.getAudioTracks()[0];
        const outgoingTrack = rawTrack
          ? await buildOutgoingTrack(rawTrack, noiseSuppressionEnabledRef.current)
          : undefined;
        if (cancelled) {
          noiseSuppressorRef.current?.stop();
          noiseSuppressorRef.current = null;
          return;
        }
        if (outgoingTrack) {
          const outgoingStream = new MediaStream([outgoingTrack]);
          outgoingAudioStreamRef.current = outgoingStream;
          // Wire the mic into any connection that already exists. Outgoing
          // connections wait for micReady, but an INCOMING offer doesn't:
          // someone already in the room offers the moment you appear in the
          // member list, which is usually while getUserMedia is still
          // pending — the permission prompt on a first visit, or just a slow
          // device. createConnection could only attach what existed at that
          // moment, so that connection answered with no audio sender at all
          // and nothing ever added one. That's the "new person joins, can't
          // be heard until they leave and come back" bug: rejoining worked
          // only because the permission was already granted the second time,
          // so the mic won the race. replaceAudioTrack's addTrack fallback
          // fires onnegotiationneeded, so the SDP is redone properly.
          peersRef.current.forEach((pc) =>
            replaceAudioTrack(
              pc,
              outgoingTrack,
              outgoingStream,
              screenStreamRef.current?.getAudioTracks()[0] ?? null,
            ),
          );
        }

        levelMetersRef.current.set(
          "self",
          watchAudioLevel(stream, (talking) => {
            const id = selfIdRef.current;
            if (id) trackTalking(id, talking);
          }),
        );
        setMicReady(true);
        return navigator.mediaDevices.enumerateDevices();
      })
      .then((list) => {
        if (cancelled || !list) return;
        setDevices(list.filter((d) => d.kind === "audioinput"));
        const outputs = list.filter((d) => d.kind === "audiooutput");
        setOutputDevices(outputs);
        // A remembered speaker that isn't here any more (headset unplugged,
        // monitor switched off) would otherwise stay selected forever: it's
        // in localStorage, so it survives rejoining and restarting, and
        // setSinkId to a device that's gone leaves you hearing nothing with
        // nothing on screen to explain why. Fall back to the system default.
        const remembered = getPreferredSpeaker();
        if (remembered && outputs.length > 0 && !outputs.some((d) => d.deviceId === remembered)) {
          setPreferredSpeaker(undefined);
          setSelectedOutputDeviceId(undefined);
        }
      })
      .catch((err: DOMException) => {
        if (cancelled) return;
        setMicError(
          err.name === "NotAllowedError"
            ? "Microphone access was blocked. Allow it in your browser's site settings to talk."
            : "Couldn't access a microphone.",
        );
      });

    return () => {
      cancelled = true;
      setMicReady(false);
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      noiseSuppressorRef.current?.stop();
      noiseSuppressorRef.current = null;
      outgoingAudioStreamRef.current = null;
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      setLocalScreenStream(null);
      peers.forEach((pc) => pc.close());
      peers.clear();
      pendingCandidates.clear();
      makingOffer.clear();
      levelMeters.forEach((m) => m.stop());
      levelMeters.clear();
      setRemoteStreams(new Map());
      setRemoteScreenStreams(new Map());
      setTalkingIds(new Set());
      setSharing(false);
    };
  }, [active, trackTalking, buildOutgoingTrack]);

  // ---- keep peer connections in sync with who's in the room ----
  const memberKey = [...memberIds].sort().join(",");
  useEffect(() => {
    if (!active || !micReady || !selfId) return;
    const currentIds = new Set(memberIds.filter((id) => id !== selfId));

    for (const [id, pc] of peersRef.current) {
      if (currentIds.has(id)) continue;
      pc.close();
      peersRef.current.delete(id);
      pendingCandidatesRef.current.delete(id);
      makingOfferRef.current.delete(id);
      levelMetersRef.current.get(id)?.stop();
      levelMetersRef.current.delete(id);
      setRemoteStreams((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setRemoteScreenStreams((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      trackTalking(id, false);
    }

    for (const id of currentIds) {
      if (peersRef.current.has(id)) continue;
      // Deterministic tie-break so exactly one side initiates per pair,
      // regardless of join order or timing — attaching a track below
      // triggers onnegotiationneeded, which sends the actual offer.
      if (selfId < id) createConnection(id);
    }
  }, [active, micReady, selfId, memberKey, memberIds, createConnection, trackTalking]);

  // ---- signaling: respond to offers/answers/candidates from peers ----
  useEffect(() => {
    if (!active) return;
    const socket = getSocket();

    async function flushCandidates(peerId: string, pc: RTCPeerConnection) {
      const queued = pendingCandidatesRef.current.get(peerId);
      if (!queued) return;
      pendingCandidatesRef.current.delete(peerId);
      for (const c of queued) {
        await pc.addIceCandidate(c).catch(() => {});
      }
    }

    async function onOffer({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) {
      const pc = peersRef.current.get(from) ?? createConnection(from);
      const polite = (selfIdRef.current ?? "") > from;
      const collision = makingOfferRef.current.get(from) || pc.signalingState !== "stable";
      if (collision) {
        if (!polite) return; // our own offer will win; ignore theirs
        await pc.setLocalDescription({ type: "rollback" });
      }
      await pc.setRemoteDescription(sdp);
      await flushCandidates(from, pc);
      await pc.setLocalDescription();
      socket.emit("voice-answer", { to: from, sdp: pc.localDescription });
    }

    async function onAnswer({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) {
      const pc = peersRef.current.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(sdp);
      await flushCandidates(from, pc);
    }

    async function onCandidate({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) {
      const pc = peersRef.current.get(from);
      if (pc?.remoteDescription) {
        await pc.addIceCandidate(candidate).catch(() => {});
      } else {
        const list = pendingCandidatesRef.current.get(from) ?? [];
        list.push(candidate);
        pendingCandidatesRef.current.set(from, list);
      }
    }

    socket.on("voice-offer", onOffer);
    socket.on("voice-answer", onAnswer);
    socket.on("voice-ice-candidate", onCandidate);
    return () => {
      socket.off("voice-offer", onOffer);
      socket.off("voice-answer", onAnswer);
      socket.off("voice-ice-candidate", onCandidate);
    };
  }, [active, createConnection]);

  // ---- apply mute / push-to-talk / owner force-mute to the outgoing track ----
  // Deliberately the OUTGOING track (raw mic, or RNNoise's output when
  // suppression is on) rather than the raw capture track — disabling the
  // raw track instead would starve RNNoise's input mid-call, and there's no
  // guarantee its own output goes perfectly silent in response rather than
  // trailing off over a few frames, which would leak a sliver of audio
  // right as you mute.
  // The one definition of "should the mic actually be live right now" —
  // mirrored into a ref so the callbacks below (which only need to READ it
  // when they happen to rebuild a track) don't have to take muted/PTT state
  // as dependencies. That mattered: applyMicStream used to close over these
  // four values directly, so its identity changed on every mute toggle and
  // every push-to-talk keypress, which in turn tore down and restarted the
  // devicechange effect's 3s hot-plug poll each time — with push-to-talk on,
  // that poll could effectively never complete a cycle.
  const micShouldBeLiveRef = useRef(false);
  useEffect(() => {
    micShouldBeLiveRef.current = !muted && !forceMuted && (!pushToTalkMode || spaceHeld);
    const track = outgoingAudioStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = micShouldBeLiveRef.current;
  }, [muted, forceMuted, pushToTalkMode, spaceHeld, micReady]);

  // ---- push-to-talk key binding (Space by default, ignored while typing)
  // spaceHeld is ignored by the mute effect above whenever pushToTalkMode
  // is off (short-circuited by !pushToTalkMode), so it doesn't need to be
  // reset here.
  const [pushToTalkKey, setPushToTalkKeyState] = useState("Space");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPushToTalkKeyState(getPushToTalkKey());
  }, []);

  const selectPushToTalkKey = useCallback((code: string) => {
    persistPushToTalkKey(code);
    setPushToTalkKeyState(code);
  }, []);

  useEffect(() => {
    if (!pushToTalkMode) return;
    function isTypingTarget(target: EventTarget | null) {
      const el = target as HTMLElement | null;
      const tag = el?.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || !!el?.isContentEditable;
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== pushToTalkKey || isTypingTarget(e.target)) return;
      // Space scrolls and Tab moves focus; a key being held to talk should
      // do neither. Only swallowed while push-to-talk is actually on and
      // you're not typing, both checked above.
      e.preventDefault();
      setSpaceHeld(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === pushToTalkKey) setSpaceHeld(false);
    }
    // A key can be let go while another window has focus (alt-tabbing mid
    // sentence), and the keyup then never arrives here — which would leave
    // the mic open. Losing focus ends the transmission.
    function onBlur() {
      setSpaceHeld(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [pushToTalkMode, pushToTalkKey]);

  const toggleMute = useCallback(() => setMuted((m) => !m), []);

  // Swaps in newStream as the live mic — shared by selectDevice (an
  // explicit Settings pick) and the devicechange auto-follow effect below
  // (a hot-plugged device picked up on its own). Stops the old stream only
  // once every dependent piece (peers, level meter, outgoing track) is
  // already pointed at the new one, so nothing goes silent mid-swap.
  const applyMicStream = useCallback(
    async (newStream: MediaStream) => {
      const newTrack = newStream.getAudioTracks()[0];
      if (!newTrack) {
        newStream.getTracks().forEach((t) => t.stop());
        return;
      }
      const oldStream = localStreamRef.current;

      const outgoingTrack = await buildOutgoingTrack(newTrack, noiseSuppressionEnabledRef.current);
      const outgoingStream = new MediaStream([outgoingTrack]);
      // stream passed through for the case a peer connection was made
      // with no mic at all (see replaceAudioTrack's own comment) — it
      // never got an audio sender to replaceTrack onto in the first
      // place, so this is what actually wires audio up to them for real.
      // The last argument is the shared screen's own audio track, when the
      // share has one: with it on the wire, "the first audio sender" is no
      // longer a safe way to say "the mic", so it's excluded by name.
      peersRef.current.forEach((pc) =>
        replaceAudioTrack(
          pc,
          outgoingTrack,
          outgoingStream,
          screenStreamRef.current?.getAudioTracks()[0] ?? null,
        ),
      );
      oldStream?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = newStream;
      outgoingTrack.enabled = micShouldBeLiveRef.current;
      outgoingAudioStreamRef.current = outgoingStream;
      const newDeviceId = newTrack.getSettings().deviceId;
      setSelectedDeviceId(newDeviceId);
      setPreferredMic(newDeviceId);

      levelMetersRef.current.get("self")?.stop();
      const id = selfIdRef.current;
      levelMetersRef.current.set(
        "self",
        watchAudioLevel(newStream, (talking) => {
          if (id) trackTalking(id, talking);
        }),
      );
      // Recovers the UI out of "no microphone" — the hot-plug case this
      // matters most for is exactly the one where there was NEVER a
      // working mic to begin with (micReady never became true, micError
      // is still set from the original failed join), so this can't just
      // assume it's already in the ready state.
      setMicReady(true);
      setMicError(null);
    },
    [trackTalking, buildOutgoingTrack],
  );

  // Read by the devicechange effect below — true only once the user has
  // actually picked a mic themselves (via Settings) this session. Until
  // then, a hot-plugged device is treated as "start following whatever the
  // OS default now is" instead of silently sticking with whatever used to
  // be default; once they've picked one on purpose, that pick is respected
  // until the device it points at actually disappears.
  const explicitMicChoiceRef = useRef(false);

  const selectDevice = useCallback(
    async (deviceId: string) => {
      explicitMicChoiceRef.current = true;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: { deviceId: { exact: deviceId } },
        });
        await applyMicStream(newStream);
      } catch {
        setMicError("Couldn't switch microphone.");
      }
    },
    [applyMicStream],
  );

  // ---- pick up a hot-plugged (or unplugged) audio device without requiring a reconnect ----
  // getUserMedia resolves "default"/no-constraint audio to a CONCRETE
  // device at call time and then just keeps using that same physical
  // device for the rest of the track's life — plugging in a headset mid-
  // call, even though it becomes the new OS default, does nothing on its
  // own. devicechange SHOULD be the signal something changed, but it's
  // known to be unreliable on Windows for exactly this case — Bluetooth/
  // USB headset connects that either never fire it or fire it before
  // Windows has actually flipped its own default device, so relying on it
  // alone silently regresses back to "reconnect to fix it." A cheap
  // enumerateDevices() poll underneath it catches whatever the event
  // misses; the signature check below keeps that from being wasteful —
  // most polls see no change and do nothing.
  const lastDeviceSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;

    async function checkDevices() {
      const list = await navigator.mediaDevices.enumerateDevices().catch(() => null);
      if (!list) return;
      const audioInputs = list.filter((d) => d.kind === "audioinput");
      setDevices(audioInputs);
      setOutputDevices(list.filter((d) => d.kind === "audiooutput"));

      const signature = audioInputs
        .map((d) => d.deviceId)
        .sort()
        .join(",");
      if (lastDeviceSignatureRef.current === null) {
        // First observation this session — nothing to compare against yet.
        lastDeviceSignatureRef.current = signature;
        return;
      }
      if (signature === lastDeviceSignatureRef.current) return; // nothing actually changed
      lastDeviceSignatureRef.current = signature;

      // Only skip while the very first acquisition attempt is still
      // genuinely in flight — NOT whenever micReady happens to be false,
      // since that's also the permanent state after it FAILED (no mic
      // present at join time). That failure case is exactly the one this
      // is for: someone joins with no mic, then plugs a headset in and
      // expects it to just start working, not to need a reconnect. Once
      // either micReady or micError has a value, the initial attempt has
      // settled one way or the other and this is free to react.
      if (!micReady && !micError) return;
      const currentDeviceId = localStreamRef.current?.getAudioTracks()[0]?.getSettings().deviceId;
      const stillPresent = !!currentDeviceId && audioInputs.some((d) => d.deviceId === currentDeviceId);
      // An explicit pick that's still plugged in is left alone — only a
      // disappeared device, or one nobody ever explicitly chose, reacts to
      // whatever just changed.
      if (stillPresent && explicitMicChoiceRef.current) return;

      try {
        let newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        let newDeviceId = newStream.getAudioTracks()[0]?.getSettings().deviceId;
        // A newly-appeared device (the headset just got plugged in) that
        // resolves back to the SAME device we already had is almost
        // always Windows not having flipped its own default yet — the
        // device list updates a beat before the OS's default-device
        // pointer does. One short retry catches that without adding a
        // standing retry loop for the (much more common) "nothing to do"
        // case below.
        if (newDeviceId === currentDeviceId && stillPresent) {
          newStream.getTracks().forEach((t) => t.stop());
          await new Promise((resolve) => setTimeout(resolve, 1000));
          newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          newDeviceId = newStream.getAudioTracks()[0]?.getSettings().deviceId;
        }
        if (newDeviceId === currentDeviceId) {
          // Still the same device — genuinely an unrelated change (an
          // output device, say) triggered this check, not a new default.
          newStream.getTracks().forEach((t) => t.stop());
          return;
        }
        await applyMicStream(newStream);
      } catch {
        if (!stillPresent) setMicError("Couldn't access a microphone.");
      }
    }

    navigator.mediaDevices.addEventListener("devicechange", checkDevices);
    // 3s: frequent enough to feel automatic, cheap enough (an
    // enumerateDevices() call that no-ops on no change) not to matter.
    const pollId = setInterval(checkDevices, 3000);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", checkDevices);
      clearInterval(pollId);
    };
  }, [active, micReady, micError, applyMicStream]);

  // Re-processes the CURRENT mic track through (or out of) RNNoise, without
  // a full getUserMedia re-acquisition — same replaceTrack-based swap
  // startSharing/changeSharing use for the screen share source.
  const setNoiseSuppressionEnabled = useCallback(
    async (enabled: boolean) => {
      persistNoiseSuppressionEnabled(enabled);
      setNoiseSuppressionEnabledState(enabled);
      const rawTrack = localStreamRef.current?.getAudioTracks()[0];
      // No mic yet — the acquisition effect will read the freshly-persisted
      // preference itself once it runs.
      if (!rawTrack) return;

      const outgoingTrack = await buildOutgoingTrack(rawTrack, enabled);
      peersRef.current.forEach((pc) =>
        replaceAudioTrack(
          pc,
          outgoingTrack,
          undefined,
          screenStreamRef.current?.getAudioTracks()[0] ?? null,
        ),
      );
      outgoingTrack.enabled = micShouldBeLiveRef.current;
      outgoingAudioStreamRef.current = new MediaStream([outgoingTrack]);
    },
    [buildOutgoingTrack],
  );

  // Applying the choice to actual <audio> elements is the page's job (it
  // owns those elements) — this just tracks which device was picked.
  const selectOutputDevice = useCallback((deviceId: string) => {
    setSelectedOutputDeviceId(deviceId);
    setPreferredSpeaker(deviceId);
  }, []);

  const stopSharing = useCallback(() => {
    const stream = screenStreamRef.current;
    if (!stream) return;
    // Every sender for this stream, not just the video one — a share with
    // sound has an audio sender too, and leaving it behind would keep peers
    // subscribed to a track that's about to be stopped.
    const shared = new Set(stream.getTracks());
    peersRef.current.forEach((pc) => {
      pc.getSenders().forEach((s) => {
        if (s.track && shared.has(s.track)) pc.removeTrack(s);
      });
    });
    stream.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setLocalScreenStream(null);
    setSharing(false);
    getSocket().emit("set-sharing", { sharing: false });
  }, []);

  const startSharing = useCallback(
    async (surface?: DisplaySurface) => {
      setScreenError(null);
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia(
          displayMediaConstraints(surface),
        );
        const track = stream.getVideoTracks()[0];
        // Nothing should resolve without a video track, but if anything
        // ever does, bail rather than letting `track.onended = ...` throw
        // on undefined. Cancelling the desktop picker rejects (handled
        // below); this is the belt-and-braces path.
        if (!track) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        screenStreamRef.current = stream;
        setLocalScreenStream(stream);
        // Covers the browser's own native "Stop sharing" bar/button.
        track.onended = () => stopSharing();

        peersRef.current.forEach((pc) => attachLocalTracks(pc, stream));
        setSharing(true);
        getSocket().emit("set-sharing", { sharing: true });
      } catch (err) {
        if (!isPickerDismissal(err)) setScreenError("Couldn't start screen sharing.");
      }
    },
    [stopSharing],
  );

  // Swaps the shared source (screen/window/tab) without ever dropping to
  // "not sharing" in between — replaceTrack on the existing sender means no
  // renegotiation, so it's seamless for peers watching the stage.
  const changeSharing = useCallback(async (surface?: DisplaySurface) => {
    setScreenError(null);
    try {
      const newStream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaConstraints(surface),
      );
      const newTrack = newStream.getVideoTracks()[0];
      // Same belt-and-braces case as startSharing above — leave the CURRENT
      // share running untouched rather than tearing it down for a
      // replacement that never actually arrived.
      if (!newTrack) {
        newStream.getTracks().forEach((t) => t.stop());
        return;
      }
      const oldStream = screenStreamRef.current;
      const oldAudio = oldStream?.getAudioTracks()[0] ?? null;
      const newAudio = newStream.getAudioTracks()[0] ?? null;

      peersRef.current.forEach((pc) => {
        replaceVideoTrack(pc, newTrack);
        // Audio is only seamless when both shares have it. Going from a
        // silent share to one with sound (or the reverse) changes how many
        // tracks are on the wire, which needs renegotiation whichever way
        // it's done — so those cases add or remove rather than replace.
        const sender = oldAudio ? pc.getSenders().find((s) => s.track === oldAudio) : undefined;
        if (newAudio && sender) void sender.replaceTrack(newAudio);
        else if (newAudio) pc.addTrack(newAudio, newStream);
        else if (sender) pc.removeTrack(sender);
      });
      oldStream?.getTracks().forEach((t) => t.stop());

      newTrack.onended = () => stopSharing();
      screenStreamRef.current = newStream;
      setLocalScreenStream(newStream);
    } catch (err) {
      if (!isPickerDismissal(err)) setScreenError("Couldn't switch your shared screen.");
    }
  }, [stopSharing]);

  // Manual fallback for the automatic hot-plug detection above — a button
  // the user can press themselves when a newly-connected device still
  // isn't picked up on its own. Does the exact same "acquire, hand off to
  // applyMicStream" as the very first join, just re-triggerable on demand
  // instead of only once.
  const [retryingMic, setRetryingMic] = useState(false);
  const retryMic = useCallback(async () => {
    setRetryingMic(true);
    setMicError(null);
    try {
      const preferredMic = getPreferredMic();
      const newStream = await navigator.mediaDevices
        .getUserMedia(preferredMic ? { audio: { deviceId: { exact: preferredMic } } } : { audio: true })
        .catch((err: DOMException) => {
          if (!preferredMic) throw err;
          return navigator.mediaDevices.getUserMedia({ audio: true });
        });
      await applyMicStream(newStream);
    } catch (err) {
      setMicError(
        (err as DOMException).name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in your browser's site settings to talk."
          : "Couldn't access a microphone.",
      );
    } finally {
      setRetryingMic(false);
    }
  }, [applyMicStream]);

  return {
    micError,
    retryingMic,
    retryMic,
    muted,
    toggleMute,
    pushToTalkMode,
    setPushToTalkMode,
    remoteStreams,
    talkingIds,
    devices,
    selectedDeviceId,
    selectDevice,
    outputDevices,
    selectedOutputDeviceId,
    selectOutputDevice,
    noiseSuppressionEnabled,
    setNoiseSuppressionEnabled,
    noiseSuppressionError,
    noiseSuppressionSupported: isNoiseSuppressionSupported(),
    sharing,
    screenError,
    startSharing,
    changeSharing,
    stopSharing,
    remoteScreenStreams,
    localScreenStream,
    pingMs,
    pushToTalkKey,
    selectPushToTalkKey,
  };
}
