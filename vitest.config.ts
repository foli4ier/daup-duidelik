import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest config for the port. The core/ engine tests are pure logic (node env is
// fine), but the P2 UI render tests need a DOM, so the whole suite runs under jsdom.
// `globals: true` lets describe/it/expect be used without imports (tsconfig adds the
// vitest/globals types so this also typechecks).
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.{test,spec}.{ts,tsx}"],
  },
});
