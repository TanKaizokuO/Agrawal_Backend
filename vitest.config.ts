import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    isolate: true,
    sequence: {
      concurrent: false,
      hooks: "list",
      setupFiles: "list",
    },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    teardownTimeout: 30_000,
  },
});
