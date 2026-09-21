"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { SnugMark } from "@/components/SnugMark";
import { SharePickerModal } from "@/components/SharePickerModal";
import { SettingsModal } from "@/components/SettingsModal";
import { UpdateReadyPill } from "@/components/UpdateReadyPill";
import { ToastStack, type ToastItem, type ToastKind } from "@/components/Toast";
import { useTheme } from "@/lib/theme";
import { colorForId, initialFor } from "@/lib/participantColor";
import { getMainRoomPalette } from "@/lib/mainRoomPalette";
import { ManageRoomModal } from "@/components/ManageRoomModal";
import { MemberContextMenu } from "@/components/MemberContextMenu";
import { AttachmentView, LinkPreviewView } from "@/components/ChatAttachment";
import { useVoiceRoom, type DisplaySurface } from "@/hooks/useVoiceRoom";
import { useNotificationPrefs, fireNotification, type NotificationPrefs } from "@/lib/notifications";
import { playSound } from "@/lib/sounds";
import { getDeviceId } from "@/lib/deviceId";
import { getDesktopBridge } from "@/lib/desktopBridge";
import { formatFileSize } from "@/lib/formatFileSize";
import { dragRegion, noDragRegion } from "@/lib/desktopDrag";
import { WindowControlsPill } from "@/components/WindowControlsPill";
import { ResizeHandles } from "@/components/ResizeHandles";
import { rememberRoom, forgetRoom } from "@/lib/myRooms";
import { uploadFile } from "@/lib/upload";
import {
  getSocket,
  MAX_ROOM_MEMBERS,
  type ChatMessage,
  type RoomMember,
  type RoomState,
  type SocketAck,
} from "@/lib/socket";

type Status = "loading" | "joined" | "error" | "needs-passcode";

type ChatFilter = "all" | "images" | "videos" | "links";

const CHAT_FILTERS: { key: ChatFilter; label: string }[] = [
  { key: "all", label: "All messages" },
  { key: "images", label: "Images" },
  { key: "videos", label: "Videos" },
  { key: "links", label: "Links" },
];

function applySinkId(el: HTMLAudioElement, deviceId: string | undefined) {
  const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  withSink.setSinkId?.(deviceId ?? "").catch(() => {});
}

export default function RoomPage(props: PageProps<"/room/[code]">) {
  const { code } = use(props.params);
  const router = useRouter();
  const { theme } = useTheme();
  const dark = theme === "dark";
  const palette = getMainRoomPalette(dark);

  const [status, setStatus] = useState<Status>("loading");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selfId, setSelfId] = useState<string | undefined>(() => getSocket().id);
  const [roomName, setRoomName] = useState("");
  const [roomPersistent, setRoomPersistent] = useState(false);
  const [roomHasPasscode, setRoomHasPasscode] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [passcodeInput, setPasscodeInput] = useState("");
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [passcodeSubmitting, setPasscodeSubmitting] = useState(false);
  const joinRef = useRef<(passcode?: string) => void>(() => {});
  // Tracks whether we've ever successfully joined this room, so a later
  // "connect" (a reconnect after a dropped connection, not the initial one)
  // knows to silently rejoin instead of leaving us a ghost member — the
  // server already forgot us the moment the old socket disconnected.
  const hasJoinedRef = useRef(false);
  // See the leave-room emit in the socket effect's cleanup below.
  const pendingLeaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deviceOpen, setDeviceOpen] = useState(false);
  // Clicking away closes this, matching MemberContextMenu — without it the
  // mic list was the one popover in the app that stayed open until you
  // clicked its trigger again.
  const deviceMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!deviceOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!deviceMenuRef.current?.contains(e.target as Node)) setDeviceOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [deviceOpen]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  // Mirrors the desktop app's instant-replay setting so the room can show
  // that capture is live. Updated both on mount and whenever anything else
  // changes it (Settings, or the tray's own "turn off").
  const [recordingActive, setRecordingActive] = useState(false);
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    bridge.getRecordingSettings().then((r) => setRecordingActive(r.enabled)).catch(() => {});
    return bridge.onRecordingSettingsChanged((r) => setRecordingActive(r.enabled));
  }, []);
  const chatFilterRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filterOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!chatFilterRef.current?.contains(e.target as Node)) setFilterOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setFilterOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [filterOpen]);
  const [copied, setCopied] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [pickedSpotlightId, setPickedSpotlightId] = useState<string | null>(null);
  const [sharePickerMode, setSharePickerMode] = useState<"start" | "change" | null>(null);
  const [stageFullscreen, setStageFullscreen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Below this, the member grid + chat side-by-side layout simply doesn't
  // fit — matches Tailwind's own `md` breakpoint so it agrees with the
  // rest of the responsive classes used throughout this page.
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileLayout(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const [isDesktop, setIsDesktop] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Every deferred UI action in this screen (toast auto-dismiss, the "Copied"
  // flag) goes through here so leaving the room can't leave timers running
  // against a screen that's gone — several of these fire 5-6s out, which is
  // easily long enough to outlive the room itself.
  const timeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const scheduleTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timeoutsRef.current.delete(id);
      fn();
    }, ms);
    timeoutsRef.current.add(id);
  }, []);
  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      timeouts.forEach(clearTimeout);
      timeouts.clear();
    };
  }, []);
  const [localVolumes, setLocalVolumes] = useState<Record<string, number>>({});
  const [localMutes, setLocalMutes] = useState<Record<string, boolean>>({});
  // "Deafen" — mutes every incoming voice at once, for the desktop app's
  // global hotkey (quickly silence Snug to play a game with its own voice
  // chat, without alt-tabbing). Distinct from muting one person via
  // localMutes: this is an all-at-once override on top of it.
  const [deafened, setDeafened] = useState(false);
  const [contextMenuFor, setContextMenuFor] = useState<{ memberId: string; x: number; y: number } | null>(
    null,
  );

  // Drives the mic control bar's compact layout — measured off the voice
  // column's own rendered width (not the viewport) since that's what
  // actually shrinks when the chat panel is dragged wider, and CSS
  // breakpoints alone can't see that (they only know the viewport, and the
  // chat panel's width is JS state, not a media query). Below this, the
  // bar drops its text labels (mic name, "Push to talk", "Share Screen")
  // down to icon-only so nothing gets clipped or overlapped.
  const BAR_COMPACT_BREAKPOINT = 640;
  const [barCompact, setBarCompact] = useState(false);
  // A callback ref, not useRef + useEffect([]): this component early-returns
  // a loading screen until status flips to "joined", so the voice column
  // simply doesn't exist on mount. An effect with empty deps ran once
  // against a null ref and never again, which left barCompact stuck false
  // forever — the whole icon-only fallback was dead. A callback ref fires
  // whenever the node actually attaches or detaches, which is exactly when
  // there's something to observe.
  const observerRef = useRef<ResizeObserver | null>(null);
  const voiceColumnRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    if (!el) {
      observerRef.current = null;
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      setBarCompact(entry.contentRect.width < BAR_COMPACT_BREAKPOINT);
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const stageRef = useRef<HTMLDivElement>(null);
  const selfIdRef = useRef(selfId);
  const prevMembersRef = useRef<RoomMember[]>([]);

  const { prefs: notifPrefs } = useNotificationPrefs();
  const notifPrefsRef = useRef(notifPrefs);

  const memberIds = useMemo(() => members.map((m) => m.id), [members]);
  const selfMember = members.find((m) => m.id === selfId);
  const isOwner = selfMember?.isOwner ?? false;
  const isForceMuted = selfMember?.forceMuted ?? false;
  const voice = useVoiceRoom({
    active: status === "joined",
    selfId,
    memberIds,
    forceMuted: isForceMuted,
  });

  useEffect(() => {
    selfIdRef.current = selfId;
  }, [selfId]);

  useEffect(() => {
    notifPrefsRef.current = notifPrefs;
  }, [notifPrefs]);

  const sharers = members.filter((m) => m.sharing);
  // A manual pick wins as long as that person is still sharing; otherwise
  // fall back to whoever's first. Derived at render time rather than
  // synced via an effect, so there's no stale-then-correct flash.
  const spotlightId =
    pickedSpotlightId && sharers.some((s) => s.id === pickedSpotlightId)
      ? pickedSpotlightId
      : (sharers[0]?.id ?? null);

  useEffect(() => {
    if (status !== "joined") return;
    getSocket().emit("set-muted", { muted: voice.muted });
  }, [status, voice.muted]);

  // Sound only — useVoiceRoom owns the `sharing` flag and already emits
  // set-sharing itself on every real start/stop, so emitting it again from
  // here just gave one server-side flag two independent writers.
  const prevSharingRef = useRef(false);
  useEffect(() => {
    if (status !== "joined") return;
    if (voice.sharing !== prevSharingRef.current) {
      playSound(voice.sharing ? "shareStart" : "shareStop");
      prevSharingRef.current = voice.sharing;
    }
  }, [status, voice.sharing]);

  // Deafening always force-mutes your own mic too (same as Discord) — you
  // can't hear anyone to know if you should be talking. Un-deafening
  // restores hearing but leaves the mic muted, so you don't start talking
  // without realizing your mic came back too.
  // The mute side effect deliberately runs OUTSIDE the setDeafened updater.
  // React treats updaters as pure and may invoke them more than once for a
  // single update (it does exactly that in StrictMode), which called
  // toggleMute twice and silently cancelled it out — deafening left the mic
  // live. Reading `deafened` directly is safe here because this only ever
  // runs from a real user action, never in a batch with another change to it.
  const handleToggleDeafen = useCallback(() => {
    const next = !deafened;
    if (next && !voice.muted) voice.toggleMute();
    setDeafened(next);
  }, [deafened, voice]);

  // Wires the desktop app's global hotkeys to the same actions their
  // in-app buttons already trigger. No-ops entirely in a browser tab —
  // getDesktopBridge() returns undefined there.
  // Held in a ref and re-pointed on every render rather than listed as
  // effect dependencies: `voice` is a fresh object each render, so depending
  // on it directly unsubscribed and re-subscribed all three IPC listeners
  // constantly — including on every talking-indicator tick, which is several
  // times a second while anyone is speaking.
  const hotkeyActionsRef = useRef({ voice, handleToggleDeafen });
  useEffect(() => {
    hotkeyActionsRef.current = { voice, handleToggleDeafen };
  });
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge || status !== "joined") return;
    const offMute = bridge.onGlobalMuteSelfToggle(() => hotkeyActionsRef.current.voice.toggleMute());
    const offDeafen = bridge.onGlobalMuteAllToggle(() => hotkeyActionsRef.current.handleToggleDeafen());
    const offShare = bridge.onGlobalStartShare(() => {
      if (getDesktopBridge()?.isDesktop) hotkeyActionsRef.current.voice.startSharing();
      else setSharePickerMode("start");
    });
    return () => {
      offMute();
      offDeafen();
      offShare();
    };
  }, [status]);

  // Instant replay saves come from the overlay button, the global
  // shortcut, or Settings' own "Save clip now" — none of which have
  // anywhere to show a result themselves (the overlay has no room for
  // text, Settings might not even be open), so this is the one place
  // that surfaces it, regardless of which of those triggered it.
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) return;
    return bridge.onRecordingSaved((result) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const item = result.ok
        ? {
            id,
            kind: "recording" as const,
            // What was saved, in the terms someone deciding whether to
            // share it cares about — length and size, not a long path.
            title: `Replay saved — ${result.seconds}s, ${formatFileSize(result.bytes)}`,
            body: "Click to open the recordings folder",
            onClick: () => void getDesktopBridge()?.openRecordingsFolder(),
          }
        : { id, kind: "recording" as const, title: "Couldn't save the replay", body: result.error };
      setToasts((prev) => [...prev, item]);
      scheduleTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 6000);
    });
  }, [scheduleTimeout]);

  useEffect(() => {
    getDesktopBridge()?.reportMuteState(voice.muted || isForceMuted);
  }, [voice.muted, isForceMuted]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDesktop(!!getDesktopBridge()?.isDesktop);
  }, []);

  useEffect(() => {
    getDesktopBridge()?.reportDeafenState(deafened);
  }, [deafened]);

  function dismissToast(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  useEffect(() => {
    const socket = getSocket();
    // A pending leave from a previous run of this effect means we're being
    // re-mounted rather than torn down (React's dev double-invoke does
    // exactly this) — cancel it before the server ever hears about it.
    if (pendingLeaveRef.current) {
      clearTimeout(pendingLeaveRef.current);
      pendingLeaveRef.current = null;
    }

    function pushToast(kind: ToastKind, title: string, body?: string, onClick?: () => void) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { id, kind, title, body, onClick }]);
      scheduleTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    }

    function notify(kind: keyof NotificationPrefs, title: string, body?: string, onClick?: () => void) {
      if (!notifPrefsRef.current[kind]) return;
      pushToast(kind, title, body, onClick);
      fireNotification(title, { body, onClick });
    }

    function onRoomUpdate(state: RoomState) {
      if (state.code !== code) return;
      // A reconnect (network blip, laptop sleep) gets a brand new socket
      // id — the server evicts the stale one and adds a fresh entry, which
      // looks identical to a real leave+join from here unless correlated
      // by something that survives the reconnect. deviceKey is that thing;
      // id is only a fallback for the rare case it's missing entirely.
      const keyFor = (m: RoomMember) => m.deviceKey ?? m.id;
      const prevByKey = new Map(prevMembersRef.current.map((m) => [keyFor(m), m]));
      for (const member of state.members) {
        if (member.id === selfIdRef.current) continue;
        const prior = prevByKey.get(keyFor(member));
        if (!prior) {
          notify("join", `${member.name} joined`, code);
          playSound("join");
        }
        if (prior && !prior.sharing && member.sharing) {
          notify("share", `${member.name} started sharing their screen`, code, () =>
            setPickedSpotlightId(member.id),
          );
          playSound("shareStart");
        }
        if (prior?.sharing && !member.sharing) {
          playSound("shareStop");
        }
      }
      prevMembersRef.current = state.members;
      setMembers(state.members);
      setRoomName(state.name);
      setRoomPersistent(state.persistent);
      setRoomHasPasscode(state.hasPasscode);
      const self = state.members.find((m) => m.id === selfIdRef.current);
      if (state.persistent) {
        rememberRoom({ code: state.code, name: state.name, isOwner: self?.isOwner ?? false });
      } else {
        forgetRoom(state.code);
      }
    }
    function onChatMessage(message: ChatMessage) {
      setMessages((prev) => [...prev, message]);
      if (message.authorId !== selfIdRef.current) {
        notify("message", message.authorName, message.text);
        playSound("messageReceived");
      }
    }
    function onMessageUpdated(message: ChatMessage) {
      setMessages((prev) => prev.map((m) => (m.id === message.id ? message : m)));
    }
    function onRoomRecoded({ code: newCode }: { code: string }) {
      router.replace(`/room/${newCode}`);
    }
    function onKicked() {
      setStatus("error");
      setJoinError("You were removed from this room by its owner.");
      playSound("kicked");
    }
    function onRoomEnded() {
      setStatus("error");
      setJoinError("This room was ended by its owner.");
      playSound("kicked");
    }
    socket.on("room-update", onRoomUpdate);
    socket.on("chat-message", onChatMessage);
    socket.on("message-updated", onMessageUpdated);
    socket.on("room-recoded", onRoomRecoded);
    socket.on("kicked", onKicked);
    socket.on("room-ended", onRoomEnded);
    function onConnect() {
      setSelfId(socket.id);
      // The socket reconnected with a fresh id after already having joined
      // once — the server dropped our old membership the instant the
      // previous connection closed, so without this we'd sit here looking
      // "joined" while actually invisible to everyone else.
      if (hasJoinedRef.current) joinRef.current();
    }
    socket.on("connect", onConnect);

    const name = sessionStorage.getItem("snug-name") || localStorage.getItem("snug-last-name");
    if (!name) {
      router.replace(`/?code=${encodeURIComponent(code)}`);
      return;
    }
    sessionStorage.setItem("snug-name", name);

    function attemptJoin(passcode?: string) {
      socket.emit(
        "join-room",
        { name, code, deviceToken: getDeviceId(), passcode },
        (ack: SocketAck) => {
          if ("error" in ack) {
            setPasscodeSubmitting(false);
            if (ack.needsPasscode) {
              setStatus("needs-passcode");
              setPasscodeError(passcode ? "Incorrect passcode." : null);
              return;
            }
            setStatus("error");
            setJoinError(ack.error);
            return;
          }
          prevMembersRef.current = ack.members;
          setMembers(ack.members);
          setMessages(ack.messages);
          setRoomName(ack.name);
          setRoomPersistent(ack.persistent);
          setRoomHasPasscode(ack.hasPasscode);
          setPasscodeSubmitting(false);
          const self = ack.members.find((m) => m.id === socket.id);
          if (ack.persistent) {
            rememberRoom({ code: ack.code, name: ack.name, isOwner: self?.isOwner ?? false });
          }
          hasJoinedRef.current = true;
          setStatus("joined");
          playSound("roomJoined");
        },
      );
    }
    joinRef.current = attemptJoin;
    attemptJoin();

    return () => {
      socket.off("room-update", onRoomUpdate);
      socket.off("chat-message", onChatMessage);
      socket.off("message-updated", onMessageUpdated);
      socket.off("room-recoded", onRoomRecoded);
      socket.off("kicked", onKicked);
      socket.off("room-ended", onRoomEnded);
      socket.off("connect", onConnect);
      // The socket is a long-lived singleton that survives route changes, so
      // the server sees neither a disconnect nor a leave when this screen
      // unmounts any way other than the Leave button (browser Back, a kick
      // redirect, the room ending). Without this, everyone else keeps seeing
      // a ghost member who already left.
      //
      // Deferred by a tick rather than emitted outright: an unmount that's
      // immediately followed by a re-mount isn't a real departure, and
      // announcing one would drop us out of a room we're still in — which
      // for a one-person ephemeral room would end it outright. The re-mount
      // above cancels this before it ever runs.
      if (hasJoinedRef.current) {
        pendingLeaveRef.current = setTimeout(() => {
          pendingLeaveRef.current = null;
          socket.emit("leave-room");
        }, 0);
      }
      hasJoinedRef.current = false;
    };
  }, [code, router, scheduleTimeout]);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    audioRefs.current.forEach((el) => applySinkId(el, voice.selectedOutputDeviceId));
  }, [voice.selectedOutputDeviceId]);

  // Per-listener volume/mute — client-side only, and local to this tab: it
  // changes what you hear, never what anyone else hears.
  useEffect(() => {
    audioRefs.current.forEach((el, peerId) => {
      el.volume = deafened || localMutes[peerId] ? 0 : (localVolumes[peerId] ?? 1);
    });
  }, [localVolumes, localMutes, deafened]);

  useEffect(() => {
    function onFullscreenChange() {
      setStageFullscreen(document.fullscreenElement === stageRef.current);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  function toggleStageFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      stageRef.current?.requestFullscreen().catch(() => {});
    }
  }

  function handleSharePick(surface: DisplaySurface) {
    if (sharePickerMode === "change") {
      voice.changeSharing(surface);
    } else {
      voice.startSharing(surface);
    }
    setSharePickerMode(null);
  }

  // On desktop, getDisplayMedia() itself opens the app's own real
  // screen/window picker (desktopCapturer-backed, with live thumbnails —
  // see snug-desktop/electron/share-picker.html), so this in-app modal's
  // category chooser would just be a redundant, choice-less extra step in
  // front of it. Only shown in a plain browser tab, where the browser's own
  // native picker is what actually lets someone choose a source.
  function handleStartShareClick() {
    if (getDesktopBridge()?.isDesktop) voice.startSharing();
    else setSharePickerMode("start");
  }

  function handleChangeShareClick() {
    if (getDesktopBridge()?.isDesktop) voice.changeSharing();
    else setSharePickerMode("change");
  }

  function handleSend() {
    const text = messageInput.trim();
    if (!text) return;
    getSocket().emit("send-message", { text });
    setMessageInput("");
    playSound("messageSent");
  }

  async function handleFilesSelected(files: FileList | File[]) {
    const file = files[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const uploaded = await uploadFile(file, code, getDeviceId());
      const text = messageInput.trim();
      getSocket().emit("send-message", { text, attachment: uploaded });
      setMessageInput("");
      playSound("messageSent");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  // Same path browsers use for copy-pasting images into WhatsApp/Discord/
  // iMessage's web clients — a copied image (from a browser, Explorer/
  // Finder, or an editor) shows up as a File-kind clipboard item rather
  // than plain text, so anything text-only just falls through to the
  // input's own default paste behavior untouched.
  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItem = Array.from(items).find(
      (item) => item.kind === "file" && item.type.startsWith("image/"),
    );
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    e.preventDefault();
    handleFilesSelected([file]);
  }

  function handleDragEnter(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDraggingFile(true);
  }

  function handleDragOver(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  }

  function handleDragLeave(e: DragEvent) {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDraggingFile(false);
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingFile(false);
    if (e.dataTransfer.files.length > 0) handleFilesSelected(e.dataTransfer.files);
  }

  function handleCopyCode() {
    navigator.clipboard?.writeText(code).catch(() => {});
    setCopied(true);
    scheduleTimeout(() => setCopied(false), 1600);
  }

  function handleLeave() {
    getSocket().emit("leave-room");
    router.push("/");
  }

  function handlePasscodeSubmit() {
    const trimmed = passcodeInput.trim();
    if (!trimmed || passcodeSubmitting) return;
    setPasscodeSubmitting(true);
    setPasscodeError(null);
    joinRef.current(trimmed);
  }

  function handleRenameRoom(nextName: string) {
    getSocket().emit("rename-room", { roomName: nextName });
  }

  function handleRegenerateCode() {
    getSocket().emit("regenerate-code");
  }

  function handleTogglePersistent() {
    getSocket().emit("set-persistent", { persistent: !roomPersistent });
  }

  function handleSetPasscode(passcode: string | null): Promise<string | null> {
    return new Promise((resolve) => {
      getSocket().emit(
        "set-passcode",
        { passcode },
        (ack: { hasPasscode?: boolean; error?: string }) => {
          if (ack?.error) {
            resolve(ack.error);
            return;
          }
          setRoomHasPasscode(!!ack?.hasPasscode);
          resolve(null);
        },
      );
    });
  }

  function handleKickMember(memberId: string) {
    getSocket().emit("kick-member", { memberId });
  }

  function handleToggleForceMute(memberId: string, muted: boolean) {
    getSocket().emit("force-mute-member", { memberId, muted });
  }

  function handleTileContextMenu(e: MouseEvent, memberId: string) {
    if (memberId === selfId) return;
    e.preventDefault();
    setContextMenuFor({ memberId, x: e.clientX, y: e.clientY });
  }

  // Per-member volume and mute used to be right-click only, which left them
  // unreachable by keyboard entirely (and on a touchscreen). This opens the
  // same menu from a focused tile, anchored to the tile itself since there's
  // no pointer position to use.
  function handleTileKeyDown(e: ReactKeyboardEvent<HTMLElement>, memberId: string) {
    if (memberId === selfId) return;
    if (e.key !== "Enter" && e.key !== " " && e.key !== "ContextMenu") return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenuFor({ memberId, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }

  function handleToggleLocalMute(memberId: string) {
    setLocalMutes((prev) => ({ ...prev, [memberId]: !prev[memberId] }));
  }

  function handleSetLocalVolume(memberId: string, volume: number) {
    setLocalVolumes((prev) => ({ ...prev, [memberId]: volume }));
  }

  function handleEndRoom() {
    getSocket().emit("end-room");
  }

  if (status === "error") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="font-display text-xl font-extrabold text-snug-text">
          Couldn&apos;t join {code}
        </div>
        <p className="max-w-xs text-sm text-snug-muted">{joinError}</p>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="mt-2 text-xs font-extrabold text-snug-muted underline underline-offset-2"
        >
          ← Back home
        </button>
      </main>
    );
  }

  if (status === "needs-passcode") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <SnugMark size="lg" />
        <div>
          <div className="font-display text-xl font-extrabold text-snug-text">
            This room is locked
          </div>
          <p className="mt-1 max-w-xs text-sm text-snug-muted">
            Enter the passcode for {code} to join.
          </p>
        </div>
        <div className="flex w-full max-w-[280px] flex-col gap-2.5">
          <input
            type="text"
            value={passcodeInput}
            onChange={(e) => setPasscodeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handlePasscodeSubmit();
            }}
            placeholder="Passcode"
            autoFocus
            className="w-full rounded-[13px] border-none bg-snug-surface px-3.5 py-3 text-center font-display text-sm font-bold tracking-wide text-snug-text shadow-snug-card placeholder:text-snug-placeholder focus:ring-2 focus:ring-snug-focus focus:outline-none"
          />
          {passcodeError && (
            <p className="text-xs font-bold" style={{ color: "var(--snug-pink)" }}>
              {passcodeError}
            </p>
          )}
          <button
            type="button"
            onClick={handlePasscodeSubmit}
            disabled={!passcodeInput.trim() || passcodeSubmitting}
            className="rounded-[15px] py-3 text-center font-display text-sm font-bold transition active:scale-[0.97] disabled:opacity-50"
            style={{ background: "var(--snug-primary)", color: "var(--snug-primary-text)" }}
          >
            {passcodeSubmitting ? "Checking…" : "Unlock"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => router.push("/")}
          className="mt-1 text-xs font-extrabold text-snug-muted underline underline-offset-2"
        >
          ← Back home
        </button>
      </main>
    );
  }

  if (status === "loading") {
    return (
      <main className="flex flex-1 items-center justify-center p-6 animate-[overlayFadeIn_200ms_ease-out] motion-reduce:animate-none">
        <SnugMark size="lg" />
      </main>
    );
  }

  const query = searchQuery.trim().toLowerCase();
  const filteredMessages = messages.filter((m) => {
    if (chatFilter === "images" && m.attachment?.kind !== "image") return false;
    if (chatFilter === "videos" && m.attachment?.kind !== "video") return false;
    if (chatFilter === "links" && !m.linkPreview) return false;
    if (!query) return true;
    return m.authorName.toLowerCase().includes(query) || m.text.toLowerCase().includes(query);
  });

  // The Settings/Manage Room modals, the share picker, and the member
  // context menu are all position:fixed — normally scoped to the whole
  // viewport, which on desktop bled their backdrop out past the room
  // panel's own rounded corners into the transparent margin around it (see
  // main.js's transparent window). Any non-none `transform` makes an
  // element the containing block for its position:fixed descendants
  // instead (a real CSS mechanism, not a hack) — applied permanently on
  // <main> below (unlike the entrance animation's own transform, which
  // reverts once it finishes), so every one of those now aligns to the
  // panel's actual bounds and gets clipped to its rounded corners by the
  // overflow-hidden there too, on every platform.
  return (
    <main
      className={`flex min-h-0 flex-1 flex-col overflow-hidden p-4 md:p-6 animate-[cardPopIn_320ms_cubic-bezier(0.34,1.56,0.64,1)] motion-reduce:animate-none ${isDesktop ? "m-3 rounded-[32px] bg-snug-bg" : ""}`}
      style={{ transform: "translateZ(0)", ...(isDesktop ? dragRegion : undefined) }}
    >
      {isDesktop && <ResizeHandles />}
      {/* top bar */}
      <div className="flex flex-shrink-0 items-center gap-5 pb-4">
        <div className="flex min-w-0 flex-1 items-center gap-3.5" style={isDesktop ? dragRegion : undefined}>
          <SnugMark size="md" />
          <div className="min-w-0">
            <div className="truncate font-display text-xl font-extrabold text-snug-text md:text-[22px]">
              {roomName || code}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyCode}
                className="flex items-center gap-1.5 rounded-full py-1 pr-3 pl-3.5 transition active:scale-95"
                style={{ background: palette.copyPillBg, ...(isDesktop ? noDragRegion : undefined) }}
              >
                <span
                  className="font-display text-xs font-bold tracking-wide"
                  style={{ color: palette.copyPillText }}
                >
                  {code}
                </span>
                {copied ? (
                  <svg
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke={palette.copyPillIconCopied}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    width="12"
                    height="12"
                    fill="none"
                    stroke={palette.copyPillIconDefault}
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                )}
              </button>
              <span className="hidden text-xs font-bold text-snug-muted sm:inline">
                tap to copy &amp; invite friends
              </span>
              {roomHasPasscode && (
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-snug-muted" aria-label="Passcode protected">
                  <rect x="3" y="11" width="18" height="10" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              )}
            </div>
          </div>
        </div>
        <div
          className="flex flex-shrink-0 items-center justify-end gap-1.5 md:w-[390px] md:gap-2"
          style={isDesktop ? noDragRegion : undefined}
        >
          {/* Instant replay otherwise runs with no window and nothing on
              screen — this is the only in-app sign that your screen is
              being captured. Clicking it saves the clip, which is also the
              thing you most likely want when you notice it. */}
          {recordingActive && (
            <button
              type="button"
              onClick={() => getDesktopBridge()?.saveReplayNow()}
              aria-label="Instant replay is recording — save a clip"
              title="Instant replay is recording — click to save a clip"
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition active:scale-95"
              style={{ background: "var(--snug-pink)" }}
            >
              <span
                className="inline-block h-2 w-2 flex-shrink-0 animate-[recPulse_1.6s_ease-in-out_infinite] rounded-full motion-reduce:animate-none"
                style={{ background: "#FFFFFF" }}
              />
              <span className="text-xs font-extrabold" style={{ color: "#FFFFFF" }}>
                REC
              </span>
            </button>
          )}
          <div
            className="flex items-center gap-1 rounded-full bg-snug-chip px-2 py-1.5"
            title={`${members.length} of ${MAX_ROOM_MEMBERS} online`}
          >
            <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-snug-mint" />
            <span className="text-xs font-extrabold text-snug-text">
              {members.length}/{MAX_ROOM_MEMBERS}
            </span>
          </div>
          {isOwner && (
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-snug-chip transition active:scale-95"
              aria-label="Manage room"
              title="Manage room"
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--snug-gold)" stroke="none">
                <path d="M3 18h18l-1.5-9-4.7 3.3L12 5l-2.8 7.3L4.5 9 3 18Z" />
              </svg>
            </button>
          )}
          {isDesktop && <UpdateReadyPill inRoom />}
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-snug-chip transition active:scale-95"
            aria-label="Settings"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-snug-text"
            >
              <line x1="4" y1="6" x2="20" y2="6" />
              <circle cx="15" cy="6" r="2.1" fill="currentColor" stroke="none" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <circle cx="9" cy="12" r="2.1" fill="currentColor" stroke="none" />
              <line x1="4" y1="18" x2="20" y2="18" />
              <circle cx="17" cy="18" r="2.1" fill="currentColor" stroke="none" />
            </svg>
          </button>
          {isDesktop && (
            <button
              type="button"
              onClick={() => getDesktopBridge()?.toggleOverlay()}
              className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-snug-chip transition active:scale-95"
              aria-label="Toggle overlay"
              title="Show/hide the in-game overlay"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-snug-text"
              >
                <rect x="3" y="4" width="18" height="14" rx="2.5" />
                <rect x="12.5" y="11.5" width="7" height="5.5" rx="1.5" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={handleLeave}
            className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] bg-snug-chip transition active:scale-95"
            aria-label="Leave room"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="var(--snug-pink)"
              strokeWidth="2.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5" />
              <path d="M21 12H9" />
            </svg>
          </button>
          {isDesktop && <WindowControlsPill showMaximize />}
        </div>
      </div>

      {voice.micError && (
        <div
          className="mb-3 flex flex-shrink-0 items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-xs font-bold"
          style={{ background: "var(--snug-surface-tint)", color: "var(--snug-pink)" }}
        >
          <span>{voice.micError} You can still use text chat.</span>
          <button
            type="button"
            onClick={voice.retryMic}
            disabled={voice.retryingMic}
            className="flex-shrink-0 rounded-full px-3 py-1.5 text-[11px] font-extrabold transition active:scale-95 disabled:opacity-60"
            style={{ background: "var(--snug-pink)", color: "#FFFFFF" }}
          >
            {voice.retryingMic ? "Checking…" : "Check again"}
          </button>
        </div>
      )}
      {voice.screenError && (
        <div className="mb-3 flex-shrink-0 rounded-2xl px-4 py-2.5 text-xs font-bold" style={{ background: "var(--snug-surface-tint)", color: "var(--snug-pink)" }}>
          {voice.screenError}
        </div>
      )}
      {isForceMuted && (
        <div className="mb-3 flex-shrink-0 rounded-2xl px-4 py-2.5 text-xs font-bold" style={{ background: "var(--snug-surface-tint)", color: "var(--snug-pink)" }}>
          You&apos;ve been muted by the room owner.
        </div>
      )}
      {deafened && (
        <div className="mb-3 flex flex-shrink-0 items-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-bold" style={{ background: "var(--snug-surface-tint)", color: "var(--snug-pink)" }}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          You&apos;ve deafened yourself — everyone&apos;s locked out, no audio is coming through. Toggle it off to hear the room again.
        </div>
      )}

      {/* hidden audio sinks for remote peers */}
      {[...voice.remoteStreams.entries()].map(([peerId, stream]) => (
        <audio
          key={peerId}
          autoPlay
          ref={(el) => {
            if (el) {
              audioRefs.current.set(peerId, el);
              if (el.srcObject !== stream) el.srcObject = stream;
              applySinkId(el, voice.selectedOutputDeviceId);
              el.volume = deafened || localMutes[peerId] ? 0 : (localVolumes[peerId] ?? 1);
            } else {
              audioRefs.current.delete(peerId);
            }
          }}
        />
      ))}

      {/* body — side-by-side (voice | chat) on desktop; stacked and each
          scrolling on its own below md, since there's no width left to
          split once the window is phone-sized. The voice column keeps a
          bounded height there (40vh) instead of flex-1, so chat — normally
          what people actually spend most of their time in — gets the rest
          of the screen instead of being squeezed to whatever's left under
          a tall member grid. */}
      <div className={`flex min-h-0 flex-1 gap-5 ${isMobileLayout ? "flex-col overflow-y-auto" : ""}`}>
        {/* voice column */}
        <div
          ref={voiceColumnRef}
          className={`flex min-h-0 min-w-0 flex-col ${isMobileLayout ? "max-h-[40vh] flex-shrink-0 overflow-hidden" : "flex-1"}`}
        >
          {sharers.length > 0 ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3.5">
              {/* who's sharing picker */}
              <div className="flex flex-shrink-0 items-center gap-2 overflow-x-auto pt-[3px] pb-0.5">
                <span className="mr-0.5 flex-shrink-0 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
                  Sharing now
                </span>
                {sharers.map((p) => {
                  const selected = p.id === spotlightId;
                  const pColor = colorForId(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setPickedSpotlightId(p.id)}
                      onContextMenu={(e) => handleTileContextMenu(e, p.id)}
                      className="flex flex-shrink-0 items-center gap-1.5 rounded-full py-1.5 pr-3 pl-1.5 transition active:scale-95"
                      style={{
                        background: selected ? "var(--snug-surface-tint)" : "var(--snug-chip)",
                        boxShadow: selected ? "0 0 0 2px var(--snug-mint)" : "none",
                        ...(isDesktop ? noDragRegion : undefined),
                      }}
                    >
                      <div className="relative h-[26px] w-[26px]">
                        {p.isOwner && (
                          <div
                            className="absolute top-[-8px] left-1/2 z-10 flex h-3.5 w-3.5 -translate-x-1/2 items-center justify-center rounded-full shadow-[0_1px_2px_rgba(42,38,64,0.2)]"
                            style={{ background: "var(--snug-chip)" }}
                          >
                            <svg viewBox="0 0 24 24" width="8" height="8" fill="var(--snug-gold)" stroke="none">
                              <path d="M3 18h18l-1.5-9-4.7 3.3L12 5l-2.8 7.3L4.5 9 3 18Z" />
                            </svg>
                          </div>
                        )}
                        <div
                          className="flex h-full w-full items-center justify-center rounded-full font-display text-[11px] font-extrabold"
                          style={{ background: pColor, color: palette.cardInk }}
                        >
                          {initialFor(p.name)}
                        </div>
                      </div>
                      <span className="text-xs font-bold text-snug-text">{p.name}</span>
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
                        <rect x="3" y="4" width="18" height="13" rx="2" />
                        <path d="M8 21h8" />
                        <path d="M12 17v4" />
                      </svg>
                    </button>
                  );
                })}
              </div>

              {/* stage — a steady mint glow keeps the shared screen visually in focus */}
              <div
                ref={stageRef}
                className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl bg-snug-surface"
                style={{ boxShadow: "0 0 0 2px var(--snug-mint), 0 0 32px 2px rgba(56,201,168,0.28)" }}
              >
                <div className="flex flex-shrink-0 items-center gap-1.5 border-b px-4 py-3" style={{ borderColor: "var(--snug-divider)" }}>
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--snug-divider)" }} />
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--snug-divider)" }} />
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--snug-divider)" }} />
                  <span className="ml-1.5 text-xs font-bold text-snug-muted">
                    {spotlightId === selfId ? "Your screen" : `${sharers.find((s) => s.id === spotlightId)?.name ?? ""}'s screen`}
                  </span>
                  <button
                    type="button"
                    onClick={toggleStageFullscreen}
                    className="ml-auto flex h-6 w-6 items-center justify-center rounded-lg transition active:scale-95"
                    style={{ background: "var(--snug-chip)", ...(isDesktop ? noDragRegion : undefined) }}
                    aria-label={stageFullscreen ? "Exit fullscreen" : "View fullscreen"}
                  >
                    {stageFullscreen ? (
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
                        <path d="M9 4v3a2 2 0 0 1-2 2H4" />
                        <path d="M15 4v3a2 2 0 0 0 2 2h3" />
                        <path d="M9 20v-3a2 2 0 0 0-2-2H4" />
                        <path d="M15 20v-3a2 2 0 0 1 2-2h3" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
                        <path d="M4 9V5a1 1 0 0 1 1-1h4" />
                        <path d="M15 4h4a1 1 0 0 1 1 1v4" />
                        <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
                        <path d="M9 20H5a1 1 0 0 1-1-1v-4" />
                      </svg>
                    )}
                  </button>
                </div>
                <div className="relative flex-1 bg-snug-bg">
                  {spotlightId && (
                    <video
                      key={spotlightId}
                      autoPlay
                      playsInline
                      muted={spotlightId === selfId}
                      className="h-full w-full object-contain"
                      ref={(el) => {
                        if (!el) return;
                        const stream =
                          spotlightId === selfId
                            ? voice.localScreenStream
                            : voice.remoteScreenStreams.get(spotlightId);
                        if (stream && el.srcObject !== stream) el.srcObject = stream;
                      }}
                    />
                  )}
                  <div className="absolute bottom-3.5 left-3.5 flex items-center gap-2 rounded-full py-1.5 pr-3 pl-1.5" style={{ background: "var(--snug-chip)", opacity: 0.92 }}>
                    <div
                      className="flex h-6 w-6 items-center justify-center rounded-full font-display text-[10px] font-extrabold"
                      style={{ background: spotlightId ? colorForId(spotlightId) : undefined, color: palette.cardInk }}
                    >
                      {spotlightId ? initialFor(sharers.find((s) => s.id === spotlightId)?.name ?? "") : ""}
                    </div>
                    <span className="inline-block h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full" style={{ background: "var(--snug-pink)" }} />
                    <span className="text-xs font-extrabold text-snug-text">
                      {spotlightId === selfId ? "You're presenting" : `${sharers.find((s) => s.id === spotlightId)?.name ?? ""} is presenting`}
                    </span>
                  </div>
                </div>
              </div>

              {/* not-sharing participants strip */}
              <div className="flex flex-shrink-0 items-center gap-2.5 overflow-x-auto p-0.5">
                {members
                  .filter((m) => !m.sharing)
                  .map((p) => {
                    const isYou = p.id === selfId;
                    // Matches the member grid's own rule below — an
                    // owner-force-muted person is muted, and this strip used
                    // to show them as live.
                    const pMuted = isYou ? voice.muted || isForceMuted : p.muted || p.forceMuted;
                    const pColor = colorForId(p.id);
                    return (
                      <div
                        key={p.id}
                        onContextMenu={(e) => handleTileContextMenu(e, p.id)}
                        onKeyDown={(e) => handleTileKeyDown(e, p.id)}
                        tabIndex={isYou ? undefined : 0}
                        role={isYou ? undefined : "button"}
                        aria-haspopup={isYou ? undefined : "menu"}
                        aria-label={isYou ? undefined : `${p.name} — volume and mute options`}
                        className="relative flex flex-shrink-0 items-center gap-1.5 rounded-full bg-snug-chip py-1 pr-3 pl-1 focus-visible:ring-2 focus-visible:ring-snug-focus focus-visible:outline-none"
                        style={{
                          boxShadow: pMuted ? "0 0 0 2px var(--snug-pink)" : "none",
                          ...(isDesktop ? noDragRegion : undefined),
                        }}
                      >
                        <div className="relative h-8 w-8">
                          {deafened && !isYou && (
                            <div
                              className="absolute inset-0 z-20 flex items-center justify-center rounded-full"
                              style={{ background: "rgba(23,22,31,0.55)" }}
                              title="You're deafened — you can't hear this person"
                            >
                              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="5" y="11" width="14" height="9" rx="2" />
                                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                              </svg>
                            </div>
                          )}
                          {p.isOwner && (
                            <div
                              className="absolute top-[-9px] left-1/2 z-10 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full shadow-[0_1px_3px_rgba(42,38,64,0.18)]"
                              style={{ background: "var(--snug-chip)" }}
                            >
                              <svg viewBox="0 0 24 24" width="10" height="10" fill="var(--snug-gold)" stroke="none">
                                <path d="M3 18h18l-1.5-9-4.7 3.3L12 5l-2.8 7.3L4.5 9 3 18Z" />
                              </svg>
                            </div>
                          )}
                          <div
                            className="flex h-full w-full items-center justify-center rounded-full font-display text-xs font-extrabold"
                            style={{ background: pColor, color: palette.cardInk }}
                          >
                            {initialFor(p.name)}
                          </div>
                          <div
                            className="absolute right-[-2px] bottom-[-2px] flex h-[15px] w-[15px] items-center justify-center rounded-full border-2"
                            style={{ background: palette.badgeBg(pMuted), borderColor: "var(--snug-chip)" }}
                          >
                            <svg viewBox="0 0 24 24" width="7" height="7" fill="none" stroke={palette.badgeIconColor(pMuted)} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              {pMuted ? (
                                <>
                                  <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v1" />
                                  <path d="M19 11a7 7 0 0 1-1.34 4.12" />
                                  <path d="M5 11a7 7 0 0 0 9.9 6.36" />
                                  <path d="M12 18v3" />
                                  <path d="M4 4l16 16" />
                                </>
                              ) : (
                                <>
                                  <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                                  <path d="M19 11a7 7 0 0 1-14 0" />
                                  <path d="M12 18v3" />
                                </>
                              )}
                            </svg>
                          </div>
                        </div>
                        <span className="text-xs font-bold text-snug-text">{p.name}</span>
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
          <div className="grid flex-1 auto-rows-min grid-cols-2 gap-4 overflow-auto p-1 sm:grid-cols-3 lg:grid-cols-4">
            {members.map((member) => {
              const isYou = member.id === selfId;
              const memberMuted = isYou
                ? voice.muted || isForceMuted
                : member.muted || member.forceMuted;
              const talking = voice.talkingIds.has(member.id);
              const cardBg = colorForId(member.id);
              const canModerate = isOwner && !member.isOwner && !isYou;
              const locallyMuted = !!localMutes[member.id];
              const localVolume = localVolumes[member.id] ?? 1;
              return (
                <div
                  key={member.id}
                  onContextMenu={(e) => handleTileContextMenu(e, member.id)}
                  onKeyDown={(e) => handleTileKeyDown(e, member.id)}
                  tabIndex={isYou ? undefined : 0}
                  role={isYou ? undefined : "button"}
                  aria-haspopup={isYou ? undefined : "menu"}
                  aria-label={isYou ? undefined : `${member.name} — volume and mute options`}
                  className="relative flex flex-col items-center gap-2.5 rounded-[26px] px-2.5 pt-5 pb-4 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-snug-focus focus-visible:outline-none"
                  style={{
                    background: cardBg,
                    boxShadow: memberMuted ? "0 0 0 3px var(--snug-pink)" : "none",
                    ...(isDesktop ? noDragRegion : undefined),
                  }}
                >
                  {!isYou && (locallyMuted || localVolume < 1) && (
                    <div
                      className="absolute top-2.5 left-2.5 z-10 flex h-6 w-6 items-center justify-center rounded-full"
                      style={{ background: "rgba(23,22,31,0.35)" }}
                      title={locallyMuted ? "Muted for you" : "Volume lowered for you"}
                    >
                      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 5 6 9H3v6h3l5 4V5Z" />
                        {locallyMuted ? (
                          <path d="M16 9l5 6M21 9l-5 6" />
                        ) : (
                          <path d="M16 8a6 6 0 0 1 0 8" />
                        )}
                      </svg>
                    </div>
                  )}
                  {canModerate && (
                    <div
                      className="absolute top-2.5 right-2.5 z-10 flex gap-1"
                      style={isDesktop ? noDragRegion : undefined}
                    >
                      <button
                        type="button"
                        onClick={() => handleToggleForceMute(member.id, !member.forceMuted)}
                        aria-label={member.forceMuted ? `Unmute ${member.name}` : `Mute ${member.name}`}
                        title={member.forceMuted ? "Unmute" : "Mute"}
                        className="flex h-6 w-6 items-center justify-center rounded-full transition active:scale-90"
                        style={{ background: "rgba(23,22,31,0.35)" }}
                      >
                        {member.forceMuted ? (
                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v1" />
                            <path d="M19 11a7 7 0 0 1-1.34 4.12" />
                            <path d="M5 11a7 7 0 0 0 9.9 6.36" />
                            <path d="M12 18v3" />
                            <path d="M4 4l16 16" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                            <path d="M19 11a7 7 0 0 1-14 0" />
                          </svg>
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleKickMember(member.id)}
                        aria-label={`Remove ${member.name}`}
                        title="Remove"
                        className="flex h-6 w-6 items-center justify-center rounded-full transition active:scale-90"
                        style={{ background: "rgba(23,22,31,0.35)" }}
                      >
                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6 6 18" />
                          <path d="M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  )}
                  <div className="relative h-[76px] w-[76px]">
                    {member.isOwner && (
                      <div
                        className="absolute top-[-11px] left-1/2 z-10 flex h-[23px] w-[23px] -translate-x-1/2 items-center justify-center rounded-full shadow-[0_2px_5px_rgba(42,38,64,0.18)]"
                        style={{ background: "var(--snug-chip)" }}
                      >
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="var(--snug-gold)" stroke="none">
                          <path d="M3 18h18l-1.5-9-4.7 3.3L12 5l-2.8 7.3L4.5 9 3 18Z" />
                        </svg>
                      </div>
                    )}
                    <div
                      className={talking ? "talk-ring" : ""}
                      style={{ width: "100%", height: "100%", borderRadius: "50%", padding: 4 }}
                    >
                      <div
                        className="flex h-full w-full items-center justify-center rounded-full font-display text-2xl font-extrabold"
                        style={{
                          background: "var(--snug-avatar-overlay)",
                          color: palette.cardInk,
                        }}
                      >
                        {initialFor(member.name)}
                      </div>
                    </div>
                    {deafened && !isYou && (
                      <div
                        className="absolute inset-0 z-20 flex items-center justify-center rounded-full"
                        style={{ background: "rgba(23,22,31,0.55)" }}
                        title="You're deafened — you can't hear this person"
                      >
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="5" y="11" width="14" height="9" rx="2" />
                          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                        </svg>
                      </div>
                    )}
                    <div
                      className="absolute right-[-3px] bottom-[-3px] flex h-[25px] w-[25px] items-center justify-center rounded-full"
                      style={{
                        background: palette.badgeBg(memberMuted || talking),
                        border: `2.5px solid ${cardBg}`,
                      }}
                    >
                      {memberMuted ? (
                        <svg
                          viewBox="0 0 24 24"
                          width="12"
                          height="12"
                          fill="none"
                          stroke={palette.badgeIconColor(memberMuted || talking)}
                          strokeWidth="2.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v1" />
                          <path d="M19 11a7 7 0 0 1-1.34 4.12" />
                          <path d="M5 11a7 7 0 0 0 9.9 6.36" />
                          <path d="M12 18v3" />
                          <path d="M4 4l16 16" />
                        </svg>
                      ) : (
                        <svg
                          viewBox="0 0 24 24"
                          width="12"
                          height="12"
                          fill="none"
                          stroke={palette.badgeIconColor(memberMuted || talking)}
                          strokeWidth="2.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                          <path d="M19 11a7 7 0 0 1-14 0" />
                          <path d="M12 18v3" />
                        </svg>
                      )}
                    </div>
                  </div>
                  {/* w-full + truncate: without a width bound this flex child
                      grows to its text and spills past the card's own padding,
                      so a long name ran edge to edge and looked clipped. */}
                  <div
                    className="w-full truncate text-center font-display text-sm font-bold"
                    style={{ color: palette.cardInk }}
                    title={member.name}
                  >
                    {member.name}
                  </div>
                  {isYou && (
                    <div
                      className="rounded-full px-2.5 py-0.5 font-display text-[10px] font-extrabold tracking-wide"
                      style={{ background: palette.cardInk, color: cardBg }}
                    >
                      YOU
                    </div>
                  )}
                  {talking && (
                    <div className="flex h-3.5 items-end gap-0.5">
                      <span className="wave-bar h-2 [animation-delay:0s]" style={{ background: palette.cardInk }} />
                      <span className="wave-bar h-3.5 [animation-delay:0.15s]" style={{ background: palette.cardInk }} />
                      <span className="wave-bar h-2.5 [animation-delay:0.3s]" style={{ background: palette.cardInk }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          )}

          {/* mic control bar — always centered. `justify-content: safe
              center` was tried here to protect against clipping if the
              bar ever overflowed its row, but "safe" isn't supported by
              every Chromium build (Electron's included) — an unsupported
              value invalidates the whole declaration, which is why this
              was rendering flush-left instead of centered, at every
              width, not just when actually too narrow. Plain center is
              correct now anyway: MIN_WINDOW_WIDTH in main.js is derived
              from this bar's own full natural width specifically so it
              can never overflow on desktop in the first place (see that
              file's comment). overflow-x-auto stays only as a last-resort
              safety net (e.g. an actual phone browser, where no window
              minimum can be enforced) — content that small already drops
              to icon-only via BAR_COMPACT_BREAKPOINT well before that. */}
          <div className="flex max-w-full flex-shrink-0 justify-center overflow-x-auto pt-3">
            <div
              className={`relative flex flex-shrink-0 items-center rounded-full bg-snug-chip shadow-lg ${barCompact ? "gap-2 px-3 py-2" : "gap-4 px-5 py-2.5"}`}
              style={isDesktop ? noDragRegion : undefined}
            >
              <button
                type="button"
                onClick={voice.toggleMute}
                disabled={!!voice.micError || isForceMuted}
                className="flex h-12 w-12 items-center justify-center rounded-full transition active:scale-95 disabled:opacity-50"
                style={{ background: palette.muteBtnBg(voice.muted || isForceMuted) }}
                aria-label={isForceMuted ? "Muted by room owner" : voice.muted ? "Unmute" : "Mute"}
                title={isForceMuted ? "Muted by room owner" : undefined}
              >
                {voice.muted || isForceMuted ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke={palette.muteIconColor(voice.muted || isForceMuted)} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v1" />
                    <path d="M19 11a7 7 0 0 1-1.34 4.12" />
                    <path d="M5 11a7 7 0 0 0 9.9 6.36" />
                    <path d="M12 18v3" />
                    <path d="M4 4l16 16" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke={palette.muteIconColor(voice.muted || isForceMuted)} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                    <path d="M19 11a7 7 0 0 1-14 0" />
                    <path d="M12 18v3" />
                  </svg>
                )}
              </button>

              <button
                type="button"
                onClick={handleToggleDeafen}
                className="flex h-12 w-12 items-center justify-center rounded-full transition active:scale-95"
                style={{ background: palette.muteBtnBg(deafened) }}
                aria-label={deafened ? "Un-deafen" : "Deafen — mute everyone at once"}
                title={deafened ? "Un-deafen" : "Deafen — mute everyone at once"}
              >
                {deafened ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke={palette.muteIconColor(deafened)} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
                    <path d="M4 15a2 2 0 0 1 2-2h1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2Z" />
                    <path d="M20 15a2 2 0 0 0-2-2h-1a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2Z" />
                    <path d="M3 3l18 18" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke={palette.muteIconColor(deafened)} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
                    <path d="M4 15a2 2 0 0 1 2-2h1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2Z" />
                    <path d="M20 15a2 2 0 0 0-2-2h-1a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2Z" />
                  </svg>
                )}
              </button>

              <div className="h-[30px] w-px bg-snug-divider" />

              <div className="relative" ref={deviceMenuRef}>
                <button
                  type="button"
                  onClick={() => setDeviceOpen((d) => !d)}
                  disabled={!!voice.micError}
                  aria-haspopup="listbox"
                  aria-expanded={deviceOpen}
                  aria-label={`Microphone: ${
                    voice.devices.find((d) => d.deviceId === voice.selectedDeviceId)?.label ?? "default"
                  }`}
                  title={
                    barCompact
                      ? (voice.devices.find((d) => d.deviceId === voice.selectedDeviceId)?.label ?? "Microphone")
                      : undefined
                  }
                  className={`flex items-center gap-2 rounded-2xl bg-snug-bg transition active:scale-95 disabled:opacity-50 ${barCompact ? "px-2.5 py-2.5" : "px-3.5 py-2.5"}`}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-snug-text">
                    <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                    <path d="M19 11a7 7 0 0 1-14 0" />
                  </svg>
                  {!barCompact && (
                    <span className="max-w-[150px] overflow-hidden text-sm font-extrabold text-ellipsis whitespace-nowrap text-snug-text">
                      {voice.devices.find((d) => d.deviceId === voice.selectedDeviceId)?.label ||
                        "Microphone"}
                    </span>
                  )}
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-snug-text">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>

                {deviceOpen && (
                  <div className="animate-[fadeIn_150ms_cubic-bezier(0.16,1,0.3,1)] absolute bottom-[64px] left-0 w-[220px] rounded-[18px] bg-snug-chip p-1.5 shadow-snug-popover motion-reduce:animate-none">
                    {voice.devices.length === 0 && (
                      <div className="px-2.5 py-2 text-sm text-snug-muted">No microphones found</div>
                    )}
                    {voice.devices.map((d, i) => {
                      const selected = d.deviceId === voice.selectedDeviceId;
                      return (
                        <button
                          key={d.deviceId}
                          type="button"
                          onClick={() => {
                            voice.selectDevice(d.deviceId);
                            setDeviceOpen(false);
                          }}
                          className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left transition active:scale-95"
                          style={{ background: selected ? "var(--snug-bg)" : "transparent" }}
                        >
                          <span
                            className="truncate text-sm text-snug-text"
                            style={{ fontWeight: selected ? 800 : 500 }}
                          >
                            {d.label || `Microphone ${i + 1}`}
                          </span>
                          {selected && (
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--snug-mint)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 6 9 17l-5-5" />
                            </svg>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="h-[30px] w-px bg-snug-divider" />

              <button
                type="button"
                onClick={() => voice.setPushToTalkMode((p) => !p)}
                disabled={!!voice.micError}
                className="flex items-center gap-2.5 px-1.5 py-2.5 transition active:scale-95 disabled:opacity-50"
                title={barCompact ? "Push to talk" : voice.pushToTalkMode ? "Hold Space to talk" : undefined}
                aria-label="Push to talk"
                aria-pressed={voice.pushToTalkMode}
              >
                {barCompact ? (
                  // Compact mode used to render the bare toggle track alone —
                  // no label, no icon, just an unexplained grey pill. The
                  // keycap icon keeps it recognizable once the text is gone.
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-snug-text"
                    aria-hidden="true"
                  >
                    <rect x="2.5" y="6" width="19" height="12" rx="3" />
                    <path d="M8 13h8" />
                  </svg>
                ) : (
                  <span className="text-sm font-extrabold text-snug-text">Push to talk</span>
                )}
                <div
                  className="relative h-[22px] w-[38px] rounded-full transition-colors duration-150"
                  style={{ background: voice.pushToTalkMode ? palette.pttTrackOn : palette.pttTrackOff }}
                >
                  <div
                    className="absolute top-0.5 h-[18px] w-[18px] rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left,background-color] duration-150"
                    style={{
                      left: voice.pushToTalkMode ? 18 : 2,
                      background: palette.pttThumbBg(voice.pushToTalkMode),
                    }}
                  />
                </div>
              </button>

              <div className="h-[30px] w-px bg-snug-divider" />

              {voice.sharing ? (
                <>
                  <button
                    type="button"
                    onClick={handleChangeShareClick}
                    className="flex h-12 w-12 items-center justify-center rounded-full transition active:scale-95"
                    style={{ background: palette.shareBtnBg(true) }}
                    aria-label="Change shared screen"
                    title="Change shared screen"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={palette.shareIconColor} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17 2.1 21 6l-4 3.9" />
                      <path d="M3 11.5v-1a4 4 0 0 1 4-4h14" />
                      <path d="M7 21.9 3 18l4-3.9" />
                      <path d="M21 12.5v1a4 4 0 0 1-4 4H3" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={voice.stopSharing}
                    title={barCompact ? "Stop Sharing" : undefined}
                    className={`flex items-center gap-2 rounded-full transition active:scale-95 ${barCompact ? "px-3 py-2.5" : "px-4.5 py-2.5"}`}
                    style={{ background: palette.shareBtnBg(true) }}
                  >
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke={palette.shareIconColor} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="13" rx="2" />
                      <path d="M8 21h8" />
                      <path d="M12 17v4" />
                    </svg>
                    <span className="inline-block h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: palette.shareIconColor }} />
                    {!barCompact && (
                      <span className="text-sm font-extrabold whitespace-nowrap" style={{ color: palette.shareIconColor }}>
                        Stop Sharing
                      </span>
                    )}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleStartShareClick}
                  title={barCompact ? "Share Screen" : undefined}
                  className={`flex items-center gap-2 rounded-full transition active:scale-95 ${barCompact ? "px-3 py-2.5" : "px-4.5 py-2.5"}`}
                  style={{ background: palette.shareBtnBg(false) }}
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke={palette.shareIconColor} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="13" rx="2" />
                    <path d="M8 21h8" />
                    <path d="M12 17v4" />
                  </svg>
                  {!barCompact && (
                    <span className="text-sm font-extrabold whitespace-nowrap" style={{ color: palette.shareIconColor }}>
                      Share Screen
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* chat panel — one fixed size (390px on desktop, up from the
            original 336px); full-width and growing to fill the rest of
            the screen once stacked (mobile). This width, plus the mic
            control bar's own natural width beside it, is what
            MIN_WINDOW_WIDTH in main.js is derived from — see the comment
            there. Changing this number means that one needs updating
            too. */}
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={isDesktop ? noDragRegion : undefined}
          className={`flex flex-col overflow-hidden rounded-[26px] bg-snug-surface ${
            isMobileLayout ? "min-h-[320px] w-full flex-1" : "w-[390px] flex-shrink-0"
          }`}
        >
          <div className="flex-shrink-0 p-5 pb-3">
            <div className="flex items-center justify-between">
              <span className="font-display text-lg font-extrabold text-snug-text">Chat</span>
              <div className="flex items-center gap-1.5">
                {/* Single-select, not checkboxes: these are mutually
                    exclusive views of the same list, and "All" only means
                    anything as one option among them. As a popover instead
                    of a permanent chip row it gives the messages back
                    ~34px — but a filter you can't see is a filter people
                    forget is on, so the button itself turns accent-colored
                    and grows a dot whenever anything but "All" is active. */}
                <div className="relative" ref={chatFilterRef}>
                  <button
                    type="button"
                    onClick={() => setFilterOpen((f) => !f)}
                    aria-haspopup="menu"
                    aria-expanded={filterOpen}
                    aria-label={`Filter messages: ${CHAT_FILTERS.find((f) => f.key === chatFilter)?.label ?? "All"}`}
                    title={`Filter: ${CHAT_FILTERS.find((f) => f.key === chatFilter)?.label ?? "All"}`}
                    className="relative flex h-8 w-8 items-center justify-center rounded-[11px] transition active:scale-95"
                    style={{
                      background: chatFilter === "all" ? "var(--snug-chip)" : "var(--snug-mint)",
                      color: chatFilter === "all" ? "var(--snug-text)" : "var(--snug-on-accent)",
                    }}
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 5h18l-7 8v6l-4 2v-8Z" />
                    </svg>
                    {chatFilter !== "all" && (
                      <span
                        className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full"
                        style={{ background: "var(--snug-pink)" }}
                      />
                    )}
                  </button>
                  {filterOpen && (
                    <div
                      role="menu"
                      className="animate-[popoverIn_140ms_cubic-bezier(0.16,1,0.3,1)] absolute top-[38px] right-0 z-20 w-[150px] origin-top-right rounded-[14px] bg-snug-surface p-1.5 shadow-snug-popover motion-reduce:animate-none"
                    >
                      {CHAT_FILTERS.map((f) => {
                        const active = chatFilter === f.key;
                        return (
                          <button
                            key={f.key}
                            type="button"
                            role="menuitemradio"
                            aria-checked={active}
                            onClick={() => {
                              setChatFilter(f.key);
                              setFilterOpen(false);
                            }}
                            className="flex w-full items-center justify-between gap-2 rounded-[10px] px-2.5 py-2 text-left text-[12.5px] font-extrabold transition active:scale-[0.98]"
                            style={{
                              background: active ? "var(--snug-surface-tint)" : "transparent",
                              color: active ? "var(--snug-text)" : "var(--snug-muted)",
                            }}
                          >
                            {f.label}
                            {active && (
                              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="var(--snug-mint)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <path d="m20 6-11 11-5-5" />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSearchOpen((s) => !s);
                    setSearchQuery("");
                  }}
                  aria-label="Search messages"
                  aria-expanded={searchOpen}
                  className="flex h-8 w-8 items-center justify-center rounded-[11px] bg-snug-chip transition active:scale-95"
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
                    <circle cx="11" cy="11" r="7" />
                    <path d="m21 21-4.35-4.35" />
                  </svg>
                </button>
              </div>
            </div>
            {searchOpen && (
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search messages..."
                autoFocus
                className="animate-[fadeIn_150ms_cubic-bezier(0.16,1,0.3,1)] mt-2.5 w-full rounded-xl border-none bg-snug-chip px-3 py-2 text-sm font-semibold text-snug-text outline-none placeholder:text-snug-placeholder motion-reduce:animate-none"
              />
            )}
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={chatScrollRef} className="flex flex-1 flex-col gap-3 overflow-auto px-5 py-1">
            {filteredMessages.length === 0 && (
              <p className="mt-4 text-center text-xs text-snug-muted">
                {messages.length === 0
                  ? "No messages yet — say hi!"
                  : chatFilter === "images"
                    ? "No images yet."
                    : chatFilter === "videos"
                      ? "No videos yet."
                      : chatFilter === "links"
                        ? "No links yet."
                        : "No messages match."}
              </p>
            )}
            {filteredMessages.map((m) => {
              const msgColor = colorForId(m.authorId);
              return (
                <div key={m.id} className="flex gap-2.5">
                  <div
                    className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full font-display text-xs font-extrabold"
                    style={{ background: msgColor, color: palette.cardInk }}
                  >
                    {initialFor(m.authorName)}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[12.5px] font-extrabold text-snug-text">
                        {m.authorName}
                      </span>
                      <span className="text-[10.5px] font-bold text-snug-placeholder">
                        {new Date(m.createdAt).toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    {m.text && (
                      <div className="mt-0.5 text-[13px] leading-relaxed font-semibold text-snug-text">
                        {m.text}
                      </div>
                    )}
                    {m.attachment && <AttachmentView attachment={m.attachment} />}
                    {m.linkPreview && <LinkPreviewView preview={m.linkPreview} />}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Only while something is actually being dragged in. This used to
              be a permanent dashed panel below the messages, which cost
              ~70px of chat height at all times to advertise something the
              composer's paperclip already does. As an overlay it costs
              nothing until it's relevant, and it covers the whole message
              area, which is a bigger and more obvious drop target than the
              old strip was. */}
          {isDraggingFile && (
            <div
              className="animate-[fadeIn_120ms_ease-out] pointer-events-none absolute inset-x-4 inset-y-2 z-10 flex flex-col items-center justify-center gap-1 rounded-2xl border-2 border-dashed motion-reduce:animate-none"
              style={{
                borderColor: "var(--snug-mint)",
                background: "var(--snug-surface-tint)",
              }}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="var(--snug-mint)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <path d="M17 8l-5-5-5 5" />
                <path d="M12 3v12" />
              </svg>
              <span className="text-[13px] font-extrabold" style={{ color: "var(--snug-mint)" }}>
                Drop to upload
              </span>
              <span className="text-[10.5px] font-bold text-snug-placeholder">
                images, videos &amp; files
              </span>
            </div>
          )}
          </div>
          {uploading && (
            <p className="mx-5 mb-2 flex-shrink-0 text-center text-xs font-bold text-snug-muted">
              Uploading…
            </p>
          )}
          {uploadError && (
            <p className="mx-5 mb-2 flex-shrink-0 text-center text-xs font-bold" style={{ color: "var(--snug-pink)" }}>
              {uploadError}
            </p>
          )}

          <div className="flex-shrink-0 p-5 pt-2">
            <div
              className="flex items-center gap-2 rounded-2xl py-2 pr-2 pl-3.5"
              style={{ background: palette.composerBg }}
            >
              <input
                type="text"
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSend();
                }}
                onPaste={handlePaste}
                placeholder="Message the room..."
                className="min-w-0 flex-1 border-none bg-transparent text-sm font-semibold text-snug-text placeholder:text-snug-placeholder outline-none"
              />
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) handleFilesSelected(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[11px] transition active:scale-95 disabled:opacity-50"
                aria-label="Attach a file"
                title="Attach a file"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className="text-snug-muted">
                  <path d="M21.44 11.05 12.25 20.24a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95L10.13 17.1a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <button
                type="button"
                onClick={handleSend}
                disabled={!messageInput.trim()}
                className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] transition active:scale-95 disabled:opacity-50"
                style={{ background: "var(--snug-primary)" }}
                aria-label="Send message"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--snug-primary-text)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m22 2-7 20-4-9-9-4Z" />
                  <path d="M22 2 11 13" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Every modal/overlay below floats on its own (fixed/absolute)
          positioning, so wrapping them in a plain div doesn't affect their
          placement — it's only here so their sliders, toggles, and buttons
          don't inherit main's drag region and fight click-drag gestures
          like dragging a volume slider. */}
      <div style={isDesktop ? noDragRegion : undefined}>
        {sharePickerMode && (
          <SharePickerModal
            mode={sharePickerMode}
            onPick={handleSharePick}
            onClose={() => setSharePickerMode(null)}
          />
        )}

        {settingsOpen && (
          <SettingsModal
            onClose={() => setSettingsOpen(false)}
            audio={{
              micError: voice.micError,
              devices: voice.devices,
              selectedDeviceId: voice.selectedDeviceId,
              onSelectDevice: voice.selectDevice,
              outputDevices: voice.outputDevices,
              selectedOutputDeviceId: voice.selectedOutputDeviceId,
              onSelectOutputDevice: voice.selectOutputDevice,
              pushToTalkMode: voice.pushToTalkMode,
              onTogglePushToTalk: () => voice.setPushToTalkMode((p) => !p),
              noiseSuppressionEnabled: voice.noiseSuppressionEnabled,
              onToggleNoiseSuppression: () =>
                voice.setNoiseSuppressionEnabled(!voice.noiseSuppressionEnabled),
              noiseSuppressionSupported: voice.noiseSuppressionSupported,
              noiseSuppressionError: voice.noiseSuppressionError,
            }}
          />
        )}

        {manageOpen && (
          <ManageRoomModal
            onClose={() => setManageOpen(false)}
            roomName={roomName || code}
            roomCode={code}
            persistent={roomPersistent}
            hasPasscode={roomHasPasscode}
            members={members}
            selfId={selfId}
            onRename={handleRenameRoom}
            onRegenerateCode={handleRegenerateCode}
            onTogglePersistent={handleTogglePersistent}
            onSetPasscode={handleSetPasscode}
            onKickMember={handleKickMember}
            onToggleForceMute={handleToggleForceMute}
            onEndRoom={() => {
              handleEndRoom();
              setManageOpen(false);
            }}
          />
        )}

        {contextMenuFor &&
          (() => {
            const target = members.find((m) => m.id === contextMenuFor.memberId);
            if (!target) return null;
            return (
              <MemberContextMenu
                x={contextMenuFor.x}
                y={contextMenuFor.y}
                memberName={target.name}
                canForceMute={isOwner && !target.isOwner}
                locallyMuted={!!localMutes[target.id]}
                volume={localVolumes[target.id] ?? 1}
                forceMuted={!!target.forceMuted}
                onToggleLocalMute={() => handleToggleLocalMute(target.id)}
                onVolumeChange={(v) => handleSetLocalVolume(target.id, v)}
                onToggleForceMute={() => {
                  handleToggleForceMute(target.id, !target.forceMuted);
                  setContextMenuFor(null);
                }}
                onClose={() => setContextMenuFor(null)}
              />
            );
          })()}

        <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    </main>
  );
}
