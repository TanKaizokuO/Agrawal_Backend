import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock.js";
import { errorMiddleware } from "../src/http/errors.js";
import {
  createOfficerRoutes,
  maskPhone,
  OfficerService,
  type OfficerRegisterPort,
  type OfficerRouteService,
} from "../src/modules/officer/index.js";
import type { MemberProjection } from "../src/modules/register/index.js";
import { getTestDatabase } from "./setup.js";

const unreachable = (): Promise<never> =>
  Promise.reject(new Error("The service must not be called by a role-gated request."));

const service: OfficerRouteService = {
  listFlags: unreachable,
  resolveFlag: unreachable,
  listErasureRequests: unreachable,
  eraseMember: unreachable,
  lookupMembers: unreachable,
  listImages: unreachable,
  removeImage: unreachable,
  approveImage: unreachable,
  refundPayment: unreachable,
  listProcessingRecords: unreachable,
  readNominee: unreachable,
  unarchiveMember: unreachable,
  listSuspensions: unreachable,
  liftSuspension: unreachable,
  listArchivalRequests: unreachable,
  resolveArchival: unreachable,
  listReports: unreachable,
  closeBloodSos: unreachable,
  changeRole: unreachable,
};

function testApp(roles: readonly ("OFFICER" | "OPERATOR" | "ORGANISER")[]): Express {
  const app = express();
  app.use((request, _response, next) => {
    request.principal = {
      kind: "MEMBER",
      sessionId: "session",
      phoneE164: "+919876543210",
      memberId: "018f4b7c-3a15-7f20-9f2c-0123456789ab",
      familyPublicId: "AGR-492001-00017",
      roles,
      isHead: false,
    };
    next();
  });
  app.use(createOfficerRoutes({ service }));
  app.use(errorMiddleware());
  return app;
}

describe("Officer public seam", () => {
  it("masks a phone to its last four digits", () => {
    const masked = maskPhone("+919876543210");
    expect(masked).toBe("***3210");
    expect(masked).not.toContain("9876543210");
  });

  it("rejects a member without the Officer role before reading the flag queue", async () => {
    const response = await request(testApp([])).get("/v1/officer/flags");
    expect(response.status).toBe(403);
  });

  it("does not let an Officer grant roles without the Operator role", async () => {
    const response = await request(testApp(["OFFICER"]))
      .post("/v1/operator/roles")
      .send({
        memberId: "018f4b7c-3a15-7f20-9f2c-0123456789ab",
        role: "OFFICER",
        action: "GRANT",
      });
    expect(response.status).toBe(403);
  });

  it("rejects an erasure request ID belonging to another Member before erasure", async () => {
    const database = getTestDatabase();
    const targetMemberId = "018f4b7c-3a15-7f20-9f2c-0123456789ab";
    const otherMemberId = "018f4b7c-3a15-7f20-9f2c-0123456789ac";
    const otherRequestId = "018f4b7c-3a15-7f20-9f2c-0123456789ad";
    const eraseCalls: Array<{ readonly memberId: string; readonly erasureRequestId: string | undefined }> = [];
    const register: OfficerRegisterPort = {
      project: () => Promise.resolve(new Map<string, MemberProjection>()),
      eraseMember: (_tx, memberId, _actor, erasureRequestId) => {
        eraseCalls.push({ memberId, erasureRequestId });
        return Promise.resolve();
      },
      readNomineeForOfficer: () => Promise.resolve(null),
      unarchiveMember: () => Promise.resolve({ successionReverted: false }),
    };
    const officer = new OfficerService({
      db: database,
      clock: new FixedClock(new Date("2026-09-20T10:00:00.000Z")),
      retentionDaysConsentAndLogs: 365,
      register,
    });
    await database.erasureRequest.create({
      data: {
        id: otherRequestId,
        memberId: otherMemberId,
        source: "MEMBER",
        status: "PENDING",
      },
    });

    await expect(
      officer.eraseMember(targetMemberId, "officer-1", {
        reason: "Requested by the Member",
        erasureRequestId: otherRequestId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(eraseCalls).toHaveLength(0);
    await expect(database.erasureRequest.findUnique({ where: { id: otherRequestId } }))
      .resolves.toMatchObject({ status: "PENDING" });
  });

  it("passes the validated pending erasure request ID to the erasure executor", async () => {
    const database = getTestDatabase();
    const targetMemberId = "018f4b7c-3a15-7f20-9f2c-0123456789ab";
    const requestId = "018f4b7c-3a15-7f20-9f2c-0123456789ac";
    const eraseCalls: Array<{ readonly memberId: string; readonly erasureRequestId: string | undefined }> = [];
    const register: OfficerRegisterPort = {
      project: () => Promise.resolve(new Map<string, MemberProjection>()),
      eraseMember: (_tx, memberId, _actor, erasureRequestId) => {
        eraseCalls.push({ memberId, erasureRequestId });
        return Promise.resolve();
      },
      readNomineeForOfficer: () => Promise.resolve(null),
      unarchiveMember: () => Promise.resolve({ successionReverted: false }),
    };
    const officer = new OfficerService({
      db: database,
      clock: new FixedClock(new Date("2026-09-20T10:00:00.000Z")),
      retentionDaysConsentAndLogs: 365,
      register,
    });
    await database.erasureRequest.create({
      data: {
        id: requestId,
        memberId: targetMemberId,
        source: "MEMBER",
        status: "PENDING",
      },
    });

    await officer.eraseMember(targetMemberId, "officer-1", {
      reason: "Requested by the Member",
      erasureRequestId: requestId,
    });
    expect(eraseCalls).toEqual([{ memberId: targetMemberId, erasureRequestId: requestId }]);
  });
});
