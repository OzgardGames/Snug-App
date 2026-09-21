import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a self-contained server bundle (.next/standalone) that the
  // desktop app spawns locally instead of depending on a hosted URL or a
  // manually-running dev server — see snug-desktop/electron/main.js.
  output: "standalone",
};

export default nextConfig;
