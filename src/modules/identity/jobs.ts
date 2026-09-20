import type { WorkerRegistration } from "../../jobs.js";
import type { Clock } from "../../clock.js";
import type { RateLimitStore } from "../../http/rate-limit.js";
import { purgeRateLimitBuckets } from "../../http/rate-limit.js";

export const JOB_NAMES = {
  purgeSessionsAndBuckets: "identity.purgeSessionsAndBuckets",
} as const;

export const IDENTITY_JOB_NAMES = JOB_NAMES;

export const JOB_SCHEDULES = {
  purgeSessionsAndBuckets: {
    cron: "30 3 * * *",
    timezone: "Asia/Kolkata",
    key: JOB_NAMES.purgeSessionsAndBuckets,
  },
} as const;

export const IDENTITY_JOB_SCHEDULES = JOB_SCHEDULES;

export interface SessionPurgeDatabase {
  readonly session: {
    deleteMany(args: {
      readonly where: {
        readonly OR?: readonly [
          { readonly revokedAt: { readonly not: null } },
          { readonly expiresAt: { readonly lt: Date } },
        ];
        readonly revokedAt?: { readonly not: null };
        readonly expiresAt?: { readonly lt: Date };
      };
    }): Promise<{ readonly count: number }>;
  };
}

export interface IdentityMaintenanceDeps {
  readonly purgeSessions?: () => Promise<number>;
  readonly purgeRateLimitBuckets?: () => Promise<number>;
  readonly db?: SessionPurgeDatabase;
  readonly rateLimitStore?: RateLimitStore;
  readonly clock?: Clock;
}

export async function purgeSessions(
  db: SessionPurgeDatabase,
  clock: Clock,
): Promise<number> {
  const now = clock.now();
  const result = await db.session.deleteMany({
    where: {
      OR: [
        { revokedAt: { not: null } },
        { expiresAt: { lt: now } },
      ],
    },
  });
  return result.count;
}

export async function runIdentityPurge(
  deps: IdentityMaintenanceDeps,
): Promise<{ readonly purgedSessions: number; readonly purgedBuckets: number }> {
  let purgedSessions = 0;
  if (deps.purgeSessions) {
    purgedSessions = await deps.purgeSessions();
  } else if (deps.db && deps.clock) {
    purgedSessions = await purgeSessions(deps.db, deps.clock);
  } else {
    throw new Error("Identity maintenance requires purgeSessions function or db with clock");
  }

  let purgedBuckets = 0;
  if (deps.purgeRateLimitBuckets) {
    purgedBuckets = await deps.purgeRateLimitBuckets();
  } else if (deps.rateLimitStore && deps.clock) {
    purgedBuckets = await purgeRateLimitBuckets(deps.rateLimitStore, deps.clock);
  }

  return { purgedSessions, purgedBuckets };
}

export function createIdentityWorkers(
  deps: IdentityMaintenanceDeps,
): readonly WorkerRegistration[] {
  if (!deps.purgeSessions && !deps.db) {
    throw new Error("createIdentityWorkers requires purgeSessions or db");
  }

  return [
    {
      name: JOB_NAMES.purgeSessionsAndBuckets,
      schedule: JOB_SCHEDULES.purgeSessionsAndBuckets,
      handler: async () => {
        await runIdentityPurge(deps);
      },
    },
  ];
}
