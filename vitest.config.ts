import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.bun.test.ts"],
    environment: "node",
    globals: false
  }
});
