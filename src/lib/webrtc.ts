// STUN alone can't help two peers behind a symmetric NAT/restrictive
// firewall reach each other directly — confirmed with a real cross-country
// call that joined the room fine but never got audio. iceServers is passed
// in per call (see useVoiceRoom, which fetches it once per session from
// the server's "get-ice-servers" — that's where the actual TURN relay
// credentials come from) rather than hardcoded here, so this stays a safe
// default for any caller that doesn't have those yet.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export function createPeerConnection(iceServers?: RTCIceServer[]): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS });
}

export function attachLocalTracks(pc: RTCPeerConnection, stream: MediaStream) {
  stream.getTracks().forEach((track) => pc.addTrack(track, stream));
}

// stream is only needed for the addTrack fallback below — a peer
// connection made while there was no mic at all (joined with none, or the
// very first acquisition failed) never got an audio sender in the first
// place, so there's nothing for replaceTrack to find. Silently doing
// nothing in that case means the LOCAL UI can recover (mic picked back
// up, error cleared) while the remote side never actually starts hearing
// anything — addTrack is what actually wires it up for real.
export function replaceAudioTrack(pc: RTCPeerConnection, track: MediaStreamTrack, stream?: MediaStream) {
  const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
  if (sender) return sender.replaceTrack(track);
  if (stream) pc.addTrack(track, stream);
}

export function replaceVideoTrack(pc: RTCPeerConnection, track: MediaStreamTrack) {
  const sender = pc.getSenders().find((s) => s.track?.kind === "video");
  return sender?.replaceTrack(track);
}
