import type { Request, RequestHandler } from "express";
import type { Clock } from "../clock.js";
import { dateFromEpochMilliseconds } from "../clock.js";
import { AppError } from "./errors.js";

interface RateLimitBucketDelegate {
  upsert(args: {
    where: {
      name_key_windowStart: {
        name: string;
        key: string;
        windowStart: Date;
      };
    };
    create: {
      name: string;
      key: string;
      windowStart: Date;
      count: number;
    };
    update: { count: { increment: number } };
  }): Promise<{ count: number }>;
  deleteMany(args: { where: { windowStart: { lt: Date } } }): Promise<{ count: number }>;
}

export interface RateLimitDatabase {
  readonly rateLimitBucket: RateLimitBucketDelegate;
}

export interface RateLimitStore {
  increment(name: string, key: string, windowStart: Date): Promise<number>;
  purge(before: Date): Promise<number>;
}

export class PrismaRateLimitStore implements RateLimitStore {
  constructor(private readonly database: RateLimitDatabase) {}

  async increment(name: string, key: string, windowStart: Date): Promise<number> {
    const bucket = await this.database.rateLimitBucket.upsert({
      where: { name_key_windowStart: { name, key, windowStart } },
      create: { name, key, windowStart, count: 1 },
      update: { count: { increment: 1 } },
    });
    return bucket.count;
  }

  async purge(before: Date): Promise<number> {
    const result = await this.database.rateLimitBucket.deleteMany({
      where: { windowStart: { lt: before } },
    });
    return result.count;
  }
}

export interface RateLimitOptions {
  readonly name: string;
  readonly key: (request: Request) => string | Promise<string>;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly store?: RateLimitStore;
  readonly database?: RateLimitDatabase;
  readonly clock?: Clock;
}

export type RateLimiter = (
  options: Omit<RateLimitOptions, "database" | "clock" | "store">
) => RequestHandler;

export function configuredRateLimit(
  limiter: RateLimiter | undefined,
  options: Parameters<RateLimiter>[0],
): readonly RequestHandler[] {
  return limiter === undefined ? [] : [limiter(options)];
}


function windowStart(now: Date, windowSeconds: number): Date {
  const seconds = Math.floor(now.getTime() / 1000);
  const start = Math.floor(seconds / windowSeconds) * windowSeconds;
  return dateFromEpochMilliseconds(start * 1000);
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error("Rate-limit limit must be a positive integer");
  }
  if (!Number.isInteger(options.windowSeconds) || options.windowSeconds < 1) {
    throw new Error("Rate-limit windowSeconds must be a positive integer");
  }

  const store = options.store ??
    (options.database === undefined
      ? undefined
      : new PrismaRateLimitStore(options.database));
  const clock = options.clock;

  return async (request, _response, next) => {
    if (store === undefined || clock === undefined) {
      next(new AppError("INTERNAL", 500));
      return;
    }

    try {
      const key = await options.key(request);
      const now = clock.now();
      const start = windowStart(now, options.windowSeconds);
      const count = await store.increment(options.name, key, start);
      if (count > options.limit) {
        const endsAt = start.getTime() + options.windowSeconds * 1000;
        const retryAfterSeconds = Math.max(1, (endsAt - now.getTime()) / 1000);
        next(AppError.rateLimited(retryAfterSeconds));
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function createRateLimiter(dependencies: {
  readonly database: RateLimitDatabase;
  readonly clock: Clock;
}): RateLimiter {
  const store = new PrismaRateLimitStore(dependencies.database);
  return (options) => rateLimit({ ...options, store, clock: dependencies.clock });
}

export async function purgeRateLimitBuckets(
  store: RateLimitStore,
  clock: Clock,
): Promise<number> {
  const before = dateFromEpochMilliseconds(
    clock.now().getTime() - 2 * 24 * 60 * 60 * 1000,
  );
  return store.purge(before);
}
