import { afterEach, describe, expect, it } from "vitest";
import { createJobRuntime, type JobRuntime } from "../src/jobs.js";

// Prefer the least-privilege app role: pg-boss tables created by the owner would
// not be usable by the app role that runs pg-boss in production.
const connectionString =
  process.env.TEST_APP_DATABASE_URL
  ?? process.env.TEST_DATABASE_MIGRATION_URL
  ?? process.env.DATABASE_MIGRATION_URL
  ?? "";

describe("pg-boss job runtime", () => {
  let runtime: JobRuntime | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
  });

  it("sends, works and schedules on queues that have never been created", async () => {
    runtime = createJobRuntime({ connectionString });
    await runtime.start();

    await expect(runtime.send("test.send-only", { ok: true })).resolves.toEqual(expect.any(String));
    await expect(
      runtime.registerWorker({ name: "test.worker-only", handler: () => undefined }),
    ).resolves.toBeUndefined();
    await expect(runtime.schedule?.("test.scheduled-only", "0 3 * * *", null)).resolves.toBeUndefined();
  });
});
