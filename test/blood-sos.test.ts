import { describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.js";
import { FixedClock } from "../src/clock.js";
import type { JobRuntime } from "../src/jobs.js";
import {
  BloodSosService,
  type BloodSosConfig,
  type BloodSosRegisterPort,
} from "../src/modules/blood-sos/index.js";
import type { NotificationsPort } from "../src/modules/notifications/index.js";
import { getTestDatabase } from "./setup.js";

const db = getTestDatabase();
const clock: Clock = new FixedClock(new Date("2026-09-20T10:00:00.000Z"));
const config: BloodSosConfig = {
  tierIntervalMinutes: 30,
  expiryHours: 24,
  densityFloor: 1,
  donorCooldownDays: 90,
  donorDailyAlertCap: 3,
};

class RecordingJobs implements JobRuntime {
  readonly enabled = true;
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  start(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  isReady(): Promise<boolean> { return Promise.resolve(true); }
  send(name: string): Promise<string> {
    this.events.push(`job:${name}`);
    return Promise.resolve(name);
  }
  registerWorker(): Promise<void> { return Promise.resolve(); }
}

class RejectingNotifications implements NotificationsPort {
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  send(): Promise<Map<string, { readonly accepted: boolean }>> {
    this.events.push("push");
    return Promise.reject(new Error("push rejected"));
  }

  enqueue(): Promise<string | null> { return Promise.resolve(null); }

  deleteTokensForMember(): Promise<void> { return Promise.resolve(); }
}

function registerPort(donorMemberId: string): BloodSosRegisterPort {
  return {
    donorCandidates: () => Promise.resolve([{
      memberId: donorMemberId,
      bloodGroup: "O_NEG",
      cityKey: "indore",
      district: "INDORE",
      state: "MADHYA_PRADESH",
    }]),
    requesterLocation: () => Promise.resolve({
      city: "Indore",
      cityKey: "indore",
      district: "INDORE",
      state: "MADHYA_PRADESH",
      pincode: "452001",
    }),
    project: () => Promise.resolve(new Map()),
    isActiveMember: () => Promise.resolve(true),
  };
}

describe("Blood SOS lifecycle", () => {
  it("schedules widening and expiry before isolating a rejected alert", async () => {
    const requesterMemberId = "00000000-0000-4000-8000-000000000081";
    const donorMemberId = "00000000-0000-4000-8000-000000000082";
    const events: string[] = [];
    const notifications = new RejectingNotifications(events);
    const service = new BloodSosService({
      db,
      clock,
      jobs: new RecordingJobs(events),
      config,
      pincodeDirectory: { lookup: () => Promise.resolve({
        city: "Indore",
        cityKey: "indore",
        district: "INDORE",
        state: "MADHYA_PRADESH",
      }) },
      register: registerPort(donorMemberId),
      notifications,
      reports: { create: () => Promise.resolve({ id: "report" }) },
      officer: { write: () => Promise.resolve() },
    });

    const view = await service.createRequest(requesterMemberId, {
      bloodGroup: "O_NEG",
      hospitalName: "City Hospital",
      hospitalPincode: "452001",
    });

    expect(events.slice(0, 3)).toEqual([
      "job:bloodSos.widenTier2",
      "job:bloodSos.widenTier3",
      "job:bloodSos.expire",
    ]);
    expect(events[3]).toBe("push");
    expect(view.status).toBe("ACTIVE");
    expect(view.donorReach).toBe(0);

    await expect(db.bloodSosRequest.findUnique({ where: { id: view.id } })).resolves.toMatchObject({
      status: "ACTIVE",
      donorReachTotal: 0,
    });
    await expect(db.bloodSosAlert.findUnique({
      where: { requestId_donorMemberId: { requestId: view.id, donorMemberId } },
    })).resolves.toMatchObject({ accepted: false });

    await expect(service.runTier(view.id, 2)).resolves.toBeUndefined();
    await expect(db.bloodSosRequest.findUnique({ where: { id: view.id } })).resolves.toMatchObject({
      currentTier: 2,
      status: "ACTIVE",
      donorReachTotal: 0,
    });
  });
});
