"use client";

import { useModalDialog } from "@/hooks/useModalDialog";

type ConfirmDialogProps = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

// How long the pop-out plays before onCancel actually unmounts — must
// match modalPopOut's duration in globals.css. onConfirm isn't delayed by
// this: it fires immediately (the caller typically unmounts this itself
// right after), so the action it triggers is never held up cosmetically.
const CLOSE_ANIMATION_MS = 160;

export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { panelRef, closing, requestClose: handleCancel } = useModalDialog(
    onCancel,
    CLOSE_ANIMATION_MS,
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      style={{ animation: `${closing ? "overlayFadeOut" : "overlayFadeIn"} 160ms ease both` }}
      onClick={handleCancel}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-3xl bg-snug-surface p-6 shadow-snug-popover"
        style={{
          animation: `${closing ? "modalPopOut" : "modalPopIn"} 200ms cubic-bezier(0.34,1.56,0.64,1) both`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="font-display text-lg font-extrabold text-snug-text">{title}</div>
        <p className="mt-2 text-sm leading-relaxed font-semibold text-snug-muted">{description}</p>
        <div className="mt-5 flex gap-2.5">
          <button
            type="button"
            onClick={handleCancel}
            autoFocus
            className="flex-1 rounded-2xl bg-snug-chip py-3 text-center font-display text-sm font-bold text-snug-text transition active:scale-[0.98]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-2xl py-3 text-center font-display text-sm font-bold transition active:scale-[0.98]"
            style={{
              background: danger ? "var(--snug-pink)" : "var(--snug-primary)",
              color: danger ? "#FFFFFF" : "var(--snug-primary-text)",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
