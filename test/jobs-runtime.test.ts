import { afterEach, describe, expect, it } from "vitest";
import { createJobRuntime, type JobRuntime } from "../src/jobs.js";

const connectionString = process.env.TEST_DATABASE_MIGRATION_URL ?? process.env.DATABASE_MIGRATION_URL ?? "";

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
