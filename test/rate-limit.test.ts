import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock.js";
import { errorMiddleware } from "../src/http/errors.js";
import {
  rateLimit,
  type RateLimitStore,
} from "../src/http/rate-limit.js";

class MemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, number>();

  increment(name: string, key: string, windowStart: Date): Promise<number> {
    const bucket = `${name}:${key}:${windowStart.toISOString()}`;
    const count = (this.counts.get(bucket) ?? 0) + 1;
    this.counts.set(bucket, count);
    return Promise.resolve(count);
  }

  purge(): Promise<number> {
    return Promise.resolve(0);
  }
}

function limitedApp(store: RateLimitStore): express.Express {
  const app = express();
  const limiter = rateLimit({
    name: "test.endpoint",
    key: (request: Request) => {
      const principal = request.get("X-Principal");
      if (principal === undefined || principal.length === 0) {
        throw new Error("X-Principal is required");
      }
      return principal;
    },
    limit: 2,
    windowSeconds: 60 * 60,
    store,
    clock: new FixedClock(new Date("2026-09-22T04:00:00.000Z")),
  });
  app.get("/v1/limited", limiter, (_request, response) => {
    response.status(204).end();
  });
  app.use(errorMiddleware());
  return app;
}

describe("database-backed rate-limit middleware", () => {
  it("rejects the request immediately after the configured boundary", async () => {
    const app = limitedApp(new MemoryRateLimitStore());

    await expect(request(app).get("/v1/limited").set("X-Principal", "member-a")).resolves.toMatchObject({
      status: 204,
    });
    await expect(request(app).get("/v1/limited").set("X-Principal", "member-a")).resolves.toMatchObject({
      status: 204,
    });
    const rejected = await request(app).get("/v1/limited").set("X-Principal", "member-a");

    expect(rejected.status).toBe(429);
    expect(rejected.headers["retry-after"]).toBeDefined();
  });

  it("keeps counters separate for distinct principals", async () => {
    const app = limitedApp(new MemoryRateLimitStore());

    for (const principal of ["member-a", "member-b"]) {
      await expect(request(app).get("/v1/limited").set("X-Principal", principal)).resolves.toMatchObject({
        status: 204,
      });
      await expect(request(app).get("/v1/limited").set("X-Principal", principal)).resolves.toMatchObject({
        status: 204,
      });
    }

    const memberARejected = await request(app).get("/v1/limited").set("X-Principal", "member-a");
    expect(memberARejected.status).toBe(429);
    const memberBRejected = await request(app).get("/v1/limited").set("X-Principal", "member-b");
    expect(memberBRejected.status).toBe(429);
  });
});
