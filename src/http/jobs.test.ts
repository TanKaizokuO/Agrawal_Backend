import { describe, expect, it } from "vitest";
import { createHttpWorkers, JOB_NAMES, JOB_SCHEDULES } from "./jobs.js";
import type { IdempotencyStore } from "./idempotency.js";

const clock = {
  now: () => new Date("2026-09-20T00:00:00.000Z"),
  todayIst: () => "2026-09-20",
};

describe("HTTP maintenance workers", () => {
  it("purges expired idempotency records on the documented IST schedule", async () => {
    let purgedBefore: Date | undefined;
    const store: IdempotencyStore = {
      find: () => Promise.resolve(null),
      claim: () => Promise.resolve(false),
      complete: () => Promise.resolve(),
      release: () => Promise.resolve(),
      purge: (before) => {
        purgedBefore = before;
        return Promise.resolve(4);
      },
    };

    const workers = createHttpWorkers(store, clock);

    expect(workers).toHaveLength(1);
    expect(workers[0]?.name).toBe(JOB_NAMES.purgeIdempotency);
    expect(workers[0]?.schedule).toEqual(JOB_SCHEDULES.purgeIdempotency);

    await workers[0]?.handler(null);

    expect(purgedBefore?.toISOString()).toBe("2026-09-19T00:00:00.000Z");
  });
});
