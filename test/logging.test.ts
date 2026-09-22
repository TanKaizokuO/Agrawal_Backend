import { Writable } from "node:stream";
import type { Express } from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createLogger } from "../src/logger.js";
import { getTestDatabase } from "./setup.js";

const SESSION_TOKEN = "session-token-7f3a";
const COOKIE_SID = "cookie-sid-91bc";
const DEVICE_TOKEN = "fcm-device-token-44de";

function captureStream(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return { stream, output: () => chunks.join("") };
}

function appWithLogger(logger: pino.Logger): Express {
  return createApp({
    config: { webOrigins: [] },
    database: getTestDatabase(),
    jobs: { isReady: () => Promise.resolve(true) },
    logger,
    mountRoutes: (app) => {
      app.put("/v1/me/devices/:token", (_request, response) => {
        response.status(204).end();
      });
    },
  });
}

async function sendSecretBearingRequest(app: Express): Promise<void> {
  await request(app)
    .put(`/v1/me/devices/${DEVICE_TOKEN}`)
    .set("Authorization", `Bearer ${SESSION_TOKEN}`)
    .set("Cookie", `sid=${COOKIE_SID}`)
    .set("Content-Type", "application/json")
    .send("{}");
}

describe("request logging", () => {
  it("redacts credentials and device tokens even when the caller supplies a plain logger", async () => {
    const { stream, output } = captureStream();

    await sendSecretBearingRequest(appWithLogger(pino(stream)));

    const logged = output();
    expect(logged).toContain("/v1/me/devices/");
    expect(logged).not.toContain(SESSION_TOKEN);
    expect(logged).not.toContain(COOKIE_SID);
    expect(logged).not.toContain(DEVICE_TOKEN);
  });

  it("builds the production logger with the same redaction", async () => {
    const { stream, output } = captureStream();

    await sendSecretBearingRequest(appWithLogger(createLogger(stream)));
    createLogger(stream).info({ member: { phoneE164: "+919999900000" } }, "outside a request");

    const logged = output();
    expect(logged).toContain("outside a request");
    expect(logged).not.toContain(SESSION_TOKEN);
    expect(logged).not.toContain(COOKIE_SID);
    expect(logged).not.toContain(DEVICE_TOKEN);
    expect(logged).not.toContain("+919999900000");
  });
});
