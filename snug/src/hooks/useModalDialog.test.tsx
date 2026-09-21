import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { useModalDialog } from "./useModalDialog";

const CLOSE_MS = 160;

function Dialog({ onClose }: { onClose: () => void }) {
  const { panelRef, closing, requestClose } = useModalDialog(onClose, CLOSE_MS);
  return (
    <div data-testid="backdrop" onClick={requestClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" data-closing={closing}>
        <button type="button">first</button>
        <button type="button">middle</button>
        <button type="button">last</button>
      </div>
    </div>
  );
}

describe("useModalDialog", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    // Explicit: Testing Library's automatic cleanup only runs when vitest
    // is configured with globals, and without it every rendered dialog
    // stays in the document and the next test's queries pick up the
    // leftovers.
    cleanup();
  });

  it("closes on Escape, after the exit animation rather than immediately", () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    // Still on screen: the pop-out needs to play first.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").dataset.closing).toBe("true");

    act(() => void vi.advanceTimersByTime(CLOSE_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("only closes once even if dismissed repeatedly", () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByTestId("backdrop"));

    act(() => void vi.advanceTimersByTime(CLOSE_MS * 3));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The whole point of the close timer living in the hook: a modal whose
  // parent unmounts it (a room ending while Manage Room is open) used to
  // still fire onClose afterwards.
  it("does not fire onClose after being unmounted mid-close", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Dialog onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    unmount();
    act(() => void vi.advanceTimersByTime(CLOSE_MS * 3));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("wraps focus at both ends instead of letting Tab escape the dialog", () => {
    render(<Dialog onClose={vi.fn()} />);
    const [first, , last] = screen.getAllByRole("button");

    last.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("returns focus to whatever opened it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { unmount } = render(<Dialog onClose={vi.fn()} />);
    screen.getAllByRole("button")[0].focus();
    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
