import { beforeAll, describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.js";
import { FixedClock } from "../src/clock.js";
import type { Database } from "../src/db.js";
import type { JobRuntime } from "../src/jobs.js";
import {
  BLOOD_SOS_JOB_NAMES,
  createBloodSosWorkers,
  BloodSosService,
  type BloodSosConfig,
  type BloodSosRegisterPort,
} from "../src/modules/blood-sos/index.js";
import type { NotificationsPort } from "../src/modules/notifications/index.js";
import { getTestDatabase } from "./setup.js";

let db: Database;
const clock: Clock = new FixedClock(new Date("2026-09-20T10:00:00.000Z"));
const config: BloodSosConfig = {
  tierIntervalMinutes: 30,
  expiryHours: 24,
  densityFloor: 1,
  donorCooldownDays: 90,
  donorDailyAlertCap: 3,
};

beforeAll(() => {
  db = getTestDatabase();
});

class RecordingJobs implements JobRuntime {
  readonly enabled = true;

  constructor(private readonly events: string[]) {}

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
  it("commits tier-one work and recovers it after an asynchronous attempt fails", async () => {
    const requesterMemberId = "00000000-0000-4000-8000-000000000081";
    const donorMemberId = "00000000-0000-4000-8000-000000000082";
    const events: string[] = [];
    const notifications = new RejectingNotifications(events);
    const register = registerPort(donorMemberId);
    const donorCandidates = register.donorCandidates.bind(register);
    let failDonorLookup = true;
    register.donorCandidates = async (filter) => {
      if (failDonorLookup) {
        failDonorLookup = false;
        throw new Error("donor lookup unavailable");
      }
      return donorCandidates(filter);
    };
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
      register,
      notifications,
      reports: { create: () => Promise.resolve({ id: "report" }) },
      officer: { write: () => Promise.resolve() },
    });

    const view = await service.createRequest(requesterMemberId, {
      bloodGroup: "O_NEG",
      hospitalName: "City Hospital",
      hospitalPincode: "452001",
    });

    expect(events).toEqual(["job:bloodSos.processTier1"]);
    expect(view).toMatchObject({
      status: "ACTIVE",
      currentTier: 1,
      donorReach: 0,
      responses: [],
    });
    await expect(db.bloodSosRequest.findUnique({ where: { id: view.id } })).resolves.toMatchObject({
      status: "ACTIVE",
      currentTier: 0,
      donorReachTotal: 0,
    });

    const tier1Worker = createBloodSosWorkers(service).find(
      (worker) => worker.name === BLOOD_SOS_JOB_NAMES.processTier1,
    );
    if (tier1Worker === undefined) throw new Error("Tier-1 worker is missing");
    await expect(tier1Worker.handler({ requestId: view.id })).rejects.toThrow("donor lookup unavailable");
    await expect(db.bloodSosRequest.findUnique({ where: { id: view.id } })).resolves.toMatchObject({
      status: "ACTIVE",
      currentTier: 0,
      donorReachTotal: 0,
    });
    await expect(db.bloodSosAlert.findUnique({
      where: { requestId_donorMemberId: { requestId: view.id, donorMemberId } },
    })).resolves.toBeNull();

    await expect(service.processPendingRequests()).resolves.toBeUndefined();
    expect(events).toEqual(["job:bloodSos.processTier1", "push"]);
    await expect(db.bloodSosRequest.findUnique({ where: { id: view.id } })).resolves.toMatchObject({
      status: "ACTIVE",
      currentTier: 1,
      donorReachTotal: 0,
    });
    await expect(db.bloodSosAlert.findUnique({
      where: { requestId_donorMemberId: { requestId: view.id, donorMemberId } },
    })).resolves.toMatchObject({ accepted: false });

    await expect(service.processPendingRequests()).resolves.toBeUndefined();
    expect(events).toEqual(["job:bloodSos.processTier1", "push"]);
  });
});
