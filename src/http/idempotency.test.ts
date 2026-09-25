import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createIdempotencyStore } from "../adapters/idempotency.js";
import { FixedClock } from "../clock.js";
import { AppError, errorMiddleware } from "./errors.js";
import { idempotent } from "./idempotency.js";
import { getTestDatabase } from "../../test/setup.js";

const ErrorResponse = z.object({
  error: z.object({ code: z.string() }),
});

const KEY = "123e4567-e89b-42d3-a456-426614174000";
const ERROR_KEY = "123e4567-e89b-42d3-a456-426614174001";
const OWNER = "member:member-1";
const clock = new FixedClock(new Date("2026-09-25T12:00:00.000Z"));

describe("idempotent HTTP requests", () => {
  it("allows one in-flight operation and replays its result and headers", async () => {
    const store = createIdempotencyStore(getTestDatabase());
    const app = express();
    app.use(express.json());
    let releaseOperation!: () => void;
    let markStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const operationReleased = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let executions = 0;
    app.post(
      "/v1/idempotent-resource",
      idempotent({ store, clock, principalKey: () => OWNER }),
      async (_request, response) => {
        executions += 1;
        markStarted();
        await operationReleased;
        response.setHeader(
          "Set-Cookie",
          "sid=created; Path=/; HttpOnly; Secure; SameSite=Lax",
        );
        response.location("/v1/resources/resource-1").status(201).json({ id: "resource-1" });
      },
    );
    app.use(errorMiddleware());

    const firstRequest = request(app)
      .post("/v1/idempotent-resource")
      .set("Idempotency-Key", KEY)
      .send({ value: "same" })
      .then((response) => response);
    await operationStarted;

    const concurrent = await request(app)
      .post("/v1/idempotent-resource")
      .set("Idempotency-Key", KEY)
      .send({ value: "same" });
    expect(concurrent.status).toBe(409);
    const concurrentBody = ErrorResponse.parse(concurrent.body);
    expect(concurrentBody.error.code).toBe("CONFLICT");

    releaseOperation();
    const first = await firstRequest;
    const replay = await request(app)
      .post("/v1/idempotent-resource")
      .set("Idempotency-Key", KEY)
      .send({ value: "same" });

    expect(first.status).toBe(201);
    expect(first.body).toEqual({ id: "resource-1" });
    expect(first.headers.location).toBe("/v1/resources/resource-1");
    expect(first.headers["set-cookie"]).toEqual([
      "sid=created; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(replay.status).toBe(first.status);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers.location).toBe(first.headers.location);
    expect(replay.headers["set-cookie"]).toEqual(first.headers["set-cookie"]);
    expect(executions).toBe(1);
  });

  it("releases the key after a completed client error", async () => {
    const store = createIdempotencyStore(getTestDatabase());
    const app = express();
    app.use(express.json());
    let executions = 0;
    app.post(
      "/v1/idempotent-error",
      idempotent({ store, clock, principalKey: () => OWNER }),
      (_request, _response, next) => {
        executions += 1;
        next(AppError.rateLimited(13));
      },
    );
    app.use(errorMiddleware());

    const first = await request(app)
      .post("/v1/idempotent-error")
      .set("Idempotency-Key", ERROR_KEY)
      .send({ action: "same" });
    const retry = await request(app)
      .post("/v1/idempotent-error")
      .set("Idempotency-Key", ERROR_KEY)
      .send({ action: "same" });

    expect(first.status).toBe(429);
    expect(first.headers["retry-after"]).toBe("13");
    expect(retry.status).toBe(429);
    expect(retry.headers["retry-after"]).toBe("13");
    expect(executions).toBe(2);
  });
});
