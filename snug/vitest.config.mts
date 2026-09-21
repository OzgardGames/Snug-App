import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    // server/ is plain Node ESM with no JSX or path aliases — it runs fine
    // under jsdom, and keeping one project means one `npm test`.
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.mjs"],
  },
});
