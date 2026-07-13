import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// `@vault/*` + `@forge/*` mirror tsconfig so tests import like the source does.
export default defineConfig({
  resolve: {
    alias: {
      "@vault": resolve(__dirname, "./src"),
      "@forge": resolve(__dirname, "../rewind_forge/src"),
      "@sdk": resolve(__dirname, "../rewind_addon_sdk/src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
    isolate: true,
  },
});
