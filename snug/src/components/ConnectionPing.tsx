"use client";

// Signal bars, coloured by how good the connection actually is, with the
// number itself kept behind a hover. Someone glancing at this mid-game
// wants "am I fine?" answered by the colour alone; the millisecond figure
// is for the moment they're already suspicious, so it doesn't need to take
// up room the rest of the time.

const THRESHOLDS = [
  { max: 80, bars: 3, color: "var(--snug-mint)", label: "Good connection" },
  { max: 180, bars: 2, color: "var(--snug-peach)", label: "Okay connection" },
  { max: Infinity, bars: 1, color: "var(--snug-pink)", label: "Poor connection" },
];

export function ConnectionPing({ pingMs }: { pingMs: number | null }) {
  // Nothing measured yet (alone in the room, or still connecting) — showing
  // a grey "0 ms" would be a worse answer than showing nothing.
  if (pingMs === null) return null;

  const quality = THRESHOLDS.find((t) => pingMs < t.max) ?? THRESHOLDS[2];

  return (
    <div
      className="group flex flex-shrink-0 items-center gap-1.5 rounded-full bg-snug-chip px-2 py-1.5"
      title={`${quality.label} — ${pingMs} ms round trip`}
      aria-label={`${quality.label}, ${pingMs} milliseconds`}
    >
      {/* Width/opacity rather than mounting on hover: animating between two
          real widths is what makes it slide out instead of popping in, and
          the text stays in the DOM so screen readers and the title above
          agree with what's on screen.
          Sits BEFORE the bars so the growth eats space on the left — this
          whole header group is right-aligned, so nothing to the right of it
          has to move (or shrink) to make room. */}
      <span
        className="max-w-0 overflow-hidden text-xs font-extrabold whitespace-nowrap opacity-0 transition-all duration-300 ease-out group-hover:max-w-[70px] group-hover:opacity-100 motion-reduce:transition-none"
        style={{ color: quality.color }}
      >
        {pingMs} ms
      </span>
      <div className="flex items-end gap-[2px]" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-[3px] rounded-full transition-colors duration-300"
            style={{
              height: 4 + i * 3,
              background: i < quality.bars ? quality.color : "var(--snug-divider)",
            }}
          />
        ))}
      </div>
    </div>
  );
}
