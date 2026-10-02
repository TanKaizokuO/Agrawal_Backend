import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../clock.js";
import { errorMiddleware } from "../../http/errors.js";
import type {
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyStore,
} from "../../http/idempotency.js";
import { createRegistrationRoutes } from "./routes.js";
import type { RegistrationService, SubmitResult } from "./service.js";

const APPLICANT_ID = "018f4b7c-3a15-7abc-8abc-000000000010";
const MEMBER_ID = "018f4b7c-3a15-7abc-8abc-000000000001";
const FAMILY_ID = "AGR-492001-00017";

const founderSubmission = {
  route: "CREATE",
  uiLanguage: "en",
  typingScript: "en",
  name: { en: "Rani Sharma" },
  nameEnConfirmed: true,
  fatherOrHusbandName: { en: "Mohan Sharma" },
  gotra: "GARG",
  gender: "FEMALE",
  dateOfBirth: "1990-01-02",
  bloodGroup: "A_POS",
  address: {
    line1: "12 Samaj Marg",
    city: "Hisar",
    state: "HARYANA",
    pincode: "492001",
  },
  nativePlace: { kind: "UNKNOWN" },
  consents: {
    directoryListing: true,
    bloodGroupMatching: false,
    photoVisible: false,
  },
  paymentRetentionDisclosureAcknowledged: true,
};

describe("Registration submission response contract", () => {
  it("returns the created Member ID in the completed founder response", async () => {
    const completedAt = new Date("2026-10-02T12:00:00.000Z");
    const response = await request(createRegistrationSubmissionApp({
      status: "COMPLETED",
      memberId: MEMBER_ID,
      family: { publicId: FAMILY_ID, gotra: "GARG" },
      completedAt,
    }))
      .post("/v1/registration/submit")
      .set("Idempotency-Key", "018f4b7c-3a15-7abc-8abc-000000000099")
      .send(founderSubmission);

    expect(response.status).toBe(201);
    expect(response.body).toStrictEqual({
      status: "COMPLETED",
      memberId: MEMBER_ID,
      family: { publicId: FAMILY_ID, gotra: "GARG" },
      completedAt: "2026-10-02T12:00:00.000Z",
    });
  });

  it("returns a pending join without a Member ID", async () => {
    const expiresAt = new Date("2026-10-16T12:00:00.000Z");
    const response = await request(createRegistrationSubmissionApp({
      status: "AWAITING_HEAD",
      family: { publicId: "AGR-492001-00001", gotra: "BANSAL" },
      expiresAt,
    }))
      .post("/v1/registration/submit")
      .set("Idempotency-Key", "018f4b7c-3a15-7abc-8abc-000000000098")
      .send({
        ...founderSubmission,
        route: "JOIN",
        familyPublicId: "AGR-492001-00001",
        gotra: undefined,
      });

    expect(response.status).toBe(202);
    expect(response.body).toStrictEqual({
      status: "AWAITING_HEAD",
      family: { publicId: "AGR-492001-00001", gotra: "BANSAL" },
      expiresAt: "2026-10-16T12:00:00.000Z",
    });
  });
});

function createRegistrationSubmissionApp(submitResult: SubmitResult) {
  const service = {
    submit: () => Promise.resolve(submitResult),
  } as unknown as RegistrationService;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    request.principal = {
      kind: "APPLICANT",
      sessionId: "registration-session",
      phoneE164: "+919876543210",
      registrationId: APPLICANT_ID,
    };
    next();
  });
  app.use(createRegistrationRoutes({
    service,
    idempotencyStore: inMemoryIdempotencyStore(),
    clock: new FixedClock(new Date("2026-10-02T12:00:00.000Z")),
  }));
  app.use(errorMiddleware());
  return app;
}

function inMemoryIdempotencyStore(): IdempotencyStore {
  const records = new Map<string, IdempotencyRecord>();
  const recordKey = (principalKey: string, key: string) => `${principalKey}:${key}`;
  return {
    find: (principalKey, key) =>
      Promise.resolve(records.get(recordKey(principalKey, key)) ?? null),
    claim: (reservation: IdempotencyReservation) => {
      const key = recordKey(reservation.principalKey, reservation.key);
      if (records.has(key)) return Promise.resolve(false);
      records.set(key, {
        ...reservation,
        responseStatus: null,
        responseBody: null,
        responseHeaders: null,
      });
      return Promise.resolve(true);
    },
    complete: (record) => {
      records.set(recordKey(record.principalKey, record.key), record);
      return Promise.resolve();
    },
    release: (reservation) => {
      records.delete(recordKey(reservation.principalKey, reservation.key));
      return Promise.resolve();
    },
    purge: () => Promise.resolve(0),
  };
}
