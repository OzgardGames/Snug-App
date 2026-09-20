const PALETTE = [
  "#FF6F91",
  "#38C9A8",
  "#FFC145",
  "#B69CE8",
  "#6FB8E8",
  "#FFA36C",
  "#FF8FAE",
];

// Deterministic per-id color so a person's card color stays put as other
// members join/leave, instead of shifting with their position in the list.
export function colorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initialFor(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || "?";
}
