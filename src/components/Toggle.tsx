type ToggleProps = {
  checked: boolean;
  onChange: () => void;
  label?: string;
};

export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="relative h-[23px] w-10 shrink-0 cursor-pointer rounded-full transition-transform duration-75 active:scale-95"
      style={{
        background: checked
          ? "var(--snug-toggle-on)"
          : "var(--snug-toggle-off)",
        transition: "background-color 150ms ease, transform 75ms ease",
      }}
    >
      <span
        className="absolute top-0.5 h-[19px] w-[19px] rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.22),0_0_0_1px_rgba(42,38,64,0.14)] transition-[left,background-color] duration-150 ease-out"
        style={{
          left: checked ? 19 : 2,
          background: checked
            ? "var(--snug-thumb-on)"
            : "var(--snug-thumb-off)",
        }}
      />
    </button>
  );
}
