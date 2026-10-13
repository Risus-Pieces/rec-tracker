import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The tests share one database, so they can't run side by side.
    fileParallelism: false,
  },
});
