"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalDialog } from "@/hooks/useModalDialog";
import { Toggle } from "@/components/Toggle";
import { useTheme } from "@/lib/theme";
import { useNotificationPrefs, type NotificationPrefs } from "@/lib/notifications";
import { useSoundEffectsPref, playSound } from "@/lib/sounds";
import { getDesktopBridge } from "@/lib/desktopBridge";
import { ShortcutSettings } from "@/components/ShortcutSettings";
import { RecordingSettings } from "@/components/RecordingSettings";
import { UpdateSettings } from "@/components/UpdateSettings";
import {
  getPreferredMic,
  setPreferredMic,
  getPreferredSpeaker,
  setPreferredSpeaker,
} from "@/lib/audioPrefs";

type AudioSettings = {
  micError: string | null;
  devices: MediaDeviceInfo[];
  selectedDeviceId?: string;
  onSelectDevice: (deviceId: string) => void;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId?: string;
  onSelectOutputDevice: (deviceId: string) => void;
  pushToTalkMode: boolean;
  onTogglePushToTalk: () => void;
  noiseSuppressionEnabled: boolean;
  onToggleNoiseSuppression: () => void;
  noiseSuppressionSupported: boolean;
  noiseSuppressionError: string | null;
};

type SettingsModalProps = {
  onClose: () => void;
  audio?: AudioSettings;
  // "modal" (default) is the usual centered popover with a backdrop, used
  // from inside a room. "inline" drops the backdrop/box/Done button and
  // renders just the header (with a back arrow instead of an X) and
  // sections, meant to be slotted directly into another screen's own card
  // — see the home screen, which swaps its join/create form out for this
  // instead of layering a popover over it.
  variant?: "modal" | "inline";
};

// How long the modal variant's own pop-out plays before onClose actually
// unmounts it — must match modalPopOut's duration in globals.css.
const CLOSE_ANIMATION_MS = 160;

const outputSupported =
  typeof window !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
      <path d="M19 11a7 7 0 0 1-14 0" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </svg>
  );
}

function DeviceRow({
  icon,
  label,
  devices,
  selectedId,
  onSelect,
  open,
  onToggleOpen,
  emptyLabel,
  fallbackLabel,
}: {
  icon: ReactNode;
  label: string;
  devices: MediaDeviceInfo[];
  selectedId: string | undefined;
  onSelect: (deviceId: string) => void;
  open: boolean;
  onToggleOpen: () => void;
  emptyLabel: string;
  fallbackLabel: string;
}) {
  const selected = devices.find((d) => d.deviceId === selectedId);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );

  // The settings sections list scrolls (overflow-y-auto) to fit the fixed
  // card height — an absolutely-positioned dropdown anchored inside it gets
  // clipped the moment it would extend past that scroll box, instead of
  // floating over everything else the way a dropdown should. Rendering it
  // through a portal onto document.body, positioned from the trigger's own
  // measured rect, escapes that clipping entirely.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) setMenuRect({ top: rect.bottom + 6, left: rect.left, width: rect.width });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  return (
    <div className="relative" ref={triggerRef}>
      <button
        type="button"
        onClick={onToggleOpen}
        className="flex w-full items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3 transition active:scale-[0.98]"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-snug-text">{icon}</span>
          <div className="text-left">
            <div className="text-[10.5px] font-extrabold text-snug-muted">{label}</div>
            <div className="max-w-[190px] truncate text-[13.5px] font-bold text-snug-text">
              {selected?.label || (devices.length > 0 ? fallbackLabel : emptyLabel)}
            </div>
          </div>
        </div>
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0 text-snug-muted transition-transform"
          style={{ transform: open ? "rotate(180deg)" : "none" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open &&
        devices.length > 0 &&
        menuRect &&
        createPortal(
          <div
            className="fixed z-[200] animate-[popoverIn_140ms_cubic-bezier(0.34,1.56,0.64,1)] origin-top rounded-2xl bg-snug-surface p-1.5 shadow-snug-popover motion-reduce:animate-none"
            style={{ top: menuRect.top, left: menuRect.left, width: menuRect.width }}
          >
            {devices.map((d, i) => {
              const isSelected = d.deviceId === selectedId;
              return (
                <button
                  key={d.deviceId}
                  type="button"
                  onClick={() => onSelect(d.deviceId)}
                  className="flex w-full items-center justify-between rounded-xl px-2.5 py-2 text-left transition active:scale-[0.98]"
                  style={{ background: isSelected ? "var(--snug-bg)" : "transparent" }}
                >
                  <span
                    className="truncate text-sm text-snug-text"
                    style={{ fontWeight: isSelected ? 800 : 500 }}
                  >
                    {d.label || `${fallbackLabel} ${i + 1}`}
                  </span>
                  {isSelected && (
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="var(--snug-mint)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

const NOTIFICATION_ROWS: { key: keyof NotificationPrefs; label: string }[] = [
  { key: "join", label: "Someone joins the room" },
  { key: "share", label: "Someone starts sharing their screen" },
  { key: "message", label: "New chat message" },
];

export function SettingsModal({ onClose, audio, variant = "modal" }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  const { prefs, setPref } = useNotificationPrefs();
  const { enabled: soundsEnabled, setEnabled: setSoundsEnabled } = useSoundEffectsPref();

  // Only present inside the desktop app (see desktopBridge.ts) — global
  // shortcuts have no meaning in a plain browser tab, so this stays false
  // (and the Shortcuts section stays hidden) there.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsDesktop(!!getDesktopBridge()?.isDesktop);
  }, []);

  const [inputOpen, setInputOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);
  // Only the modal variant plays its own pop-out — the inline variant is
  // just content the home screen slots in, and owns its own transition.
  // The inline variant is just content the home screen slots in and owns
  // its own transition, so it closes immediately (0ms) rather than playing
  // the modal pop-out. panelRef is only attached in the modal branch, and
  // the focus trap no-ops while it's null.
  const { panelRef, closing, requestClose: handleClose } = useModalDialog(
    onClose,
    variant === "modal" ? CLOSE_ANIMATION_MS : 0,
  );

  // No `audio` prop means this is opened from the home screen, before any
  // voice connection exists — there's no live device list to show, so this
  // manages its own lightweight one instead, letting a preferred mic/speaker
  // be picked ahead of time. useVoiceRoom reads that preference the next
  // time it actually acquires a mic (see src/lib/audioPrefs.ts).
  const homeAudioMode = !audio;
  const [homeDevices, setHomeDevices] = useState<MediaDeviceInfo[]>([]);
  const [homeOutputDevices, setHomeOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [homeMicId, setHomeMicId] = useState<string | undefined>(undefined);
  const [homeSpeakerId, setHomeSpeakerId] = useState<string | undefined>(undefined);
  const [homeAudioError, setHomeAudioError] = useState<string | null>(null);

  useEffect(() => {
    if (!homeAudioMode) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHomeMicId(getPreferredMic());
    setHomeSpeakerId(getPreferredSpeaker());
    let cancelled = false;
    navigator.mediaDevices
      .enumerateDevices()
      .then((list) => {
        if (cancelled) return;
        setHomeDevices(list.filter((d) => d.kind === "audioinput"));
        setHomeOutputDevices(list.filter((d) => d.kind === "audiooutput"));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [homeAudioMode]);

  // Device labels stay blank until the browser has granted mic access at
  // least once — this only fires on an explicit click, briefly opening (and
  // immediately closing) the mic purely to unlock real names.
  function handleRevealDeviceNames() {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((t) => t.stop());
        return navigator.mediaDevices.enumerateDevices();
      })
      .then((list) => {
        setHomeDevices(list.filter((d) => d.kind === "audioinput"));
        setHomeOutputDevices(list.filter((d) => d.kind === "audiooutput"));
      })
      .catch((err: DOMException) => {
        setHomeAudioError(
          err.name === "NotAllowedError"
            ? "Microphone access was blocked. Allow it in your settings to see device names."
            : "Couldn't access the microphone.",
        );
      });
  }

  function handleSelectHomeMic(deviceId: string) {
    setHomeMicId(deviceId);
    setPreferredMic(deviceId);
    setInputOpen(false);
  }

  function handleSelectHomeSpeaker(deviceId: string) {
    setHomeSpeakerId(deviceId);
    setPreferredSpeaker(deviceId);
    setOutputOpen(false);
  }

  const homeDeviceNamesHidden = homeDevices.length > 0 && homeDevices.every((d) => !d.label);

  const header = (
    <div className="flex flex-shrink-0 items-center gap-2.5 px-6 pt-[22px] pb-4">
      {variant === "inline" && (
        <button
          type="button"
          onClick={handleClose}
          aria-label="Back"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[11px] bg-snug-chip transition active:scale-95"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      )}
      <span className="flex-1 font-display text-lg font-extrabold text-snug-text">Settings</span>
      {variant === "modal" && (
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close settings"
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[11px] bg-snug-chip transition active:scale-95"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
            <path d="M18 6 6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );

  const sections = (
    <>
      {audio && (
            <section>
              <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
                Audio
              </div>
              <div className="flex flex-col gap-2">
                {audio.micError ? (
                  <p className="px-1 text-xs font-semibold" style={{ color: "var(--snug-pink)" }}>
                    {audio.micError}
                  </p>
                ) : (
                  <DeviceRow
                    icon={<MicIcon />}
                    label="Microphone"
                    devices={audio.devices}
                    selectedId={audio.selectedDeviceId}
                    onSelect={(id) => {
                      audio.onSelectDevice(id);
                      setInputOpen(false);
                    }}
                    open={inputOpen}
                    onToggleOpen={() => {
                      setInputOpen((o) => !o);
                      setOutputOpen(false);
                    }}
                    emptyLabel="No microphones found"
                    fallbackLabel="Microphone"
                  />
                )}

                {outputSupported ? (
                  <DeviceRow
                    icon={<SpeakerIcon />}
                    label="Speaker"
                    devices={audio.outputDevices}
                    selectedId={audio.selectedOutputDeviceId}
                    onSelect={(id) => {
                      audio.onSelectOutputDevice(id);
                      setOutputOpen(false);
                    }}
                    open={outputOpen}
                    onToggleOpen={() => {
                      setOutputOpen((o) => !o);
                      setInputOpen(false);
                    }}
                    emptyLabel="No speakers found"
                    fallbackLabel="Speaker"
                  />
                ) : (
                  <p className="px-1 text-xs font-semibold text-snug-muted">
                    Speaker selection isn&apos;t supported in this browser.
                  </p>
                )}

                <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
                  <div className="flex items-center gap-2.5">
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
                      <path d="m9 11 3 3L22 4" />
                      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                    <div>
                      <div className="text-[13.5px] font-bold text-snug-text">Push to talk</div>
                      <div className="text-[11px] font-bold text-snug-muted">
                        Hold Space to talk while muted
                      </div>
                    </div>
                  </div>
                  <Toggle
                    checked={audio.pushToTalkMode}
                    onChange={audio.onTogglePushToTalk}
                    label="Push to talk"
                  />
                </div>

                {audio.noiseSuppressionSupported ? (
                  <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
                    <div className="flex items-center gap-2.5">
                      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
                        <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" />
                        <path d="M19 11a7 7 0 0 1-14 0" />
                        <path d="m4 4 16 16" />
                      </svg>
                      <div>
                        <div className="text-[13.5px] font-bold text-snug-text">Noise suppression</div>
                        <div className="text-[11px] font-bold text-snug-muted">
                          Filters out background noise from your mic
                        </div>
                      </div>
                    </div>
                    <Toggle
                      checked={audio.noiseSuppressionEnabled}
                      onChange={audio.onToggleNoiseSuppression}
                      label="Noise suppression"
                    />
                  </div>
                ) : (
                  <p className="px-1 text-xs font-semibold text-snug-muted">
                    Noise suppression isn&apos;t supported in this browser.
                  </p>
                )}
                {audio.noiseSuppressionError && (
                  <p className="px-1 text-xs font-semibold" style={{ color: "var(--snug-pink)" }}>
                    {audio.noiseSuppressionError}
                  </p>
                )}
              </div>
            </section>
          )}

          {homeAudioMode && (
            <section>
              <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
                Audio
              </div>
              <div className="flex flex-col gap-2">
                <DeviceRow
                  icon={<MicIcon />}
                  label="Microphone"
                  devices={homeDevices}
                  selectedId={homeMicId}
                  onSelect={handleSelectHomeMic}
                  open={inputOpen}
                  onToggleOpen={() => {
                    setInputOpen((o) => !o);
                    setOutputOpen(false);
                  }}
                  emptyLabel="No microphones found"
                  fallbackLabel="Microphone"
                />

                {outputSupported ? (
                  <DeviceRow
                    icon={<SpeakerIcon />}
                    label="Speaker"
                    devices={homeOutputDevices}
                    selectedId={homeSpeakerId}
                    onSelect={handleSelectHomeSpeaker}
                    open={outputOpen}
                    onToggleOpen={() => {
                      setOutputOpen((o) => !o);
                      setInputOpen(false);
                    }}
                    emptyLabel="No speakers found"
                    fallbackLabel="Speaker"
                  />
                ) : (
                  <p className="px-1 text-xs font-semibold text-snug-muted">
                    Speaker selection isn&apos;t supported in this browser.
                  </p>
                )}

                {homeDeviceNamesHidden && (
                  <button
                    type="button"
                    onClick={handleRevealDeviceNames}
                    className="px-1 text-left text-xs font-bold underline underline-offset-2"
                    style={{ color: "var(--snug-mint)" }}
                  >
                    Allow microphone access to see device names
                  </button>
                )}

                {homeAudioError && (
                  <p className="px-1 text-xs font-semibold" style={{ color: "var(--snug-pink)" }}>
                    {homeAudioError}
                  </p>
                )}

                <p className="px-1 text-[11px] font-semibold text-snug-muted">
                  Used the next time you join or create a room.
                </p>
              </div>
            </section>
          )}

          <section>
            <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
              Appearance
            </div>
            <div className="relative flex rounded-2xl bg-snug-chip p-1">
              <div
                className="absolute top-1 left-1 h-[calc(100%-8px)] w-[calc(50%-4px)] rounded-xl bg-snug-primary transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
                style={{ transform: `translateX(${isDark ? "100%" : "0"})` }}
              />
              <button
                type="button"
                onClick={() => setTheme("light")}
                className="relative z-10 flex-1 rounded-xl py-2.5 text-center font-display text-[13px] font-bold transition-colors"
                style={{ color: !isDark ? "var(--snug-primary-text)" : "var(--snug-muted)" }}
              >
                Light
              </button>
              <button
                type="button"
                onClick={() => setTheme("dark")}
                className="relative z-10 flex-1 rounded-xl py-2.5 text-center font-display text-[13px] font-bold transition-colors"
                style={{ color: isDark ? "var(--snug-primary-text)" : "var(--snug-muted)" }}
              >
                Dark
              </button>
            </div>
          </section>

          <section>
            <div className="mb-2.5 text-[11px] font-extrabold tracking-wide text-snug-muted uppercase">
              Notifications
            </div>
            <div className="flex items-center justify-between rounded-2xl bg-snug-chip px-3.5 py-3">
              <div className="flex items-center gap-2.5">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-snug-text">
                  <path d="M11 5 6 9H2v6h4l5 4Z" />
                  <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  <path d="M18.5 5.5a9 9 0 0 1 0 13" />
                </svg>
                <div>
                  <div className="text-[13.5px] font-bold text-snug-text">Sound effects</div>
                  <div className="text-[11px] font-bold text-snug-muted">
                    Playful cues for messages, joins &amp; sharing
                  </div>
                </div>
              </div>
              <Toggle
                checked={soundsEnabled}
                onChange={() => {
                  const next = !soundsEnabled;
                  setSoundsEnabled(next);
                  if (next) playSound("join");
                }}
                label="Sound effects"
              />
            </div>
            <div className="mt-3 mb-1 px-1 text-[11px] font-bold text-snug-muted">
              Tell me when&hellip;
            </div>
            <div className="flex flex-col gap-0.5">
              {NOTIFICATION_ROWS.map((row) => (
                <div
                  key={row.key}
                  className="flex items-center justify-between py-2.5"
                >
                  <span className="pr-3 text-[13.5px] font-bold text-snug-text">{row.label}</span>
                  <Toggle
                    checked={prefs[row.key]}
                    onChange={() => setPref(row.key, !prefs[row.key])}
                    label={row.label}
                  />
                </div>
              ))}
            </div>
          </section>

          {/* Desktop-only sections last, kept together: neither exists in a
              browser tab, so they'd otherwise interrupt the list with a gap
              for anyone on the web. */}
          {isDesktop && <RecordingSettings />}
          {isDesktop && <ShortcutSettings />}
          {isDesktop && <UpdateSettings />}
    </>
  );

  if (variant === "inline") {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-2">{sections}</div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      style={{ animation: `${closing ? "overlayFadeOut" : "overlayFadeIn"} 160ms ease both` }}
      onClick={handleClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="flex max-h-[85vh] w-full max-w-sm flex-col rounded-3xl bg-snug-surface p-0 shadow-snug-popover"
        style={{
          animation: `${closing ? "modalPopOut" : "modalPopIn"} 200ms cubic-bezier(0.34,1.56,0.64,1) both`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {header}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-2">{sections}</div>

        <div className="flex-shrink-0 px-6 pt-4 pb-6">
          <button
            type="button"
            onClick={handleClose}
            className="w-full rounded-2xl py-3 text-center font-display text-[14px] font-bold transition active:scale-[0.98]"
            style={{ background: "var(--snug-primary)", color: "var(--snug-primary-text)" }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
