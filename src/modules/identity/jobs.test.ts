import { describe, expect, it } from "vitest";
import {
  createIdentityWorkers,
  IDENTITY_JOB_NAMES,
  IDENTITY_JOB_SCHEDULES,
  purgeSessions,
  type SessionPurgeDatabase,
} from "./index.js";

describe("Identity maintenance workers", () => {
  it("fails closed when required dependencies are absent", () => {
    expect(() => createIdentityWorkers({})).toThrow(/requires purgeSessions or db/);
  });

  it("registers identity.purgeSessionsAndBuckets and purges sessions and rate limit buckets", async () => {
    let sessionPurged = false;
    let bucketsPurged = false;

    const workers = createIdentityWorkers({
      purgeSessions: () => {
        sessionPurged = true;
        return Promise.resolve(5);
      },
      purgeRateLimitBuckets: () => {
        bucketsPurged = true;
        return Promise.resolve(12);
      },
    });

    expect(workers).toHaveLength(1);
    expect(workers[0]?.schedule).toEqual(IDENTITY_JOB_SCHEDULES.purgeSessionsAndBuckets);
    expect(workers[0]?.name).toBe(IDENTITY_JOB_NAMES.purgeSessionsAndBuckets);

    await workers[0]?.handler(null);
    expect(sessionPurged).toBe(true);
    expect(bucketsPurged).toBe(true);
  });

  it("purges expired and revoked sessions using SessionPurgeDatabase", async () => {
    const deletedWhere: Array<Record<string, unknown>> = [];
    const mockDb: SessionPurgeDatabase = {
      session: {
        deleteMany: ({ where }) => {
          deletedWhere.push(where);
          return Promise.resolve({ count: 3 });
        },
      },
    };

    const count = await purgeSessions(mockDb, {
      now: () => new Date("2026-09-19T10:00:00.000Z"),
      todayIst: () => "2026-09-19",
    });

    expect(count).toBe(3);
    expect(deletedWhere).toHaveLength(1);
    expect(deletedWhere[0]?.OR).toBeDefined();
  });
});
