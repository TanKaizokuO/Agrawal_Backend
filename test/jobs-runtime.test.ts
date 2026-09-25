import { afterEach, describe, expect, it } from "vitest";
import { createJobRuntime, type JobRuntime } from "../src/jobs.js";
import { getTestAppDatabaseUrl, getTestDatabaseMigrationUrl } from "./setup.js";

// Prefer the least-privilege app role: pg-boss tables created by the owner would
// not be usable by the app role that runs pg-boss in production.
const connectionString = getTestAppDatabaseUrl() ?? getTestDatabaseMigrationUrl();

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
  it("keeps enqueueing available when local workers are disabled", async () => {
    runtime = createJobRuntime({ connectionString, enabled: false });
    await runtime.start();

    const queueName = `test.api-only.${crypto.randomUUID()}`;
    await expect(runtime.isReady()).resolves.toBe(true);
    await expect(runtime.send(queueName, { requestId: crypto.randomUUID() })).resolves.toEqual(expect.any(String));
    await expect(
      runtime.registerWorker({ name: queueName, handler: () => undefined }),
    ).rejects.toThrow("The job runtime is not started");

    await expect(runtime.schedule?.(queueName, "0 3 * * *", null))
      .rejects.toThrow("The job runtime is not started");
  });
});
