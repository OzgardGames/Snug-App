const SIZES = {
  sm: { box: 38, mid: 5, inner: 11, border: 3 },
  md: { box: 44, mid: 6, inner: 13, border: 3 },
  lg: { box: 56, mid: 8, inner: 16, border: 4 },
  xl: { box: 76, mid: 11, inner: 22, border: 5 },
} as const;

type SnugMarkProps = {
  size?: keyof typeof SIZES;
  className?: string;
};

export function SnugMark({ size = "md", className }: SnugMarkProps) {
  const { box, mid, inner, border } = SIZES[size];

  return (
    <div
      className={className}
      style={{ position: "relative", width: box, height: box, flexShrink: 0 }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          border: `${border}px solid var(--snug-mint)`,
          opacity: 0.55,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: mid,
          borderRadius: "50%",
          border: `${border}px solid var(--snug-peach)`,
          opacity: 0.75,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: inner,
          borderRadius: "50%",
          background: "var(--snug-pink)",
        }}
      />
    </div>
  );
}
