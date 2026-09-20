import { describe, expect, it } from "vitest";
import {
  provisionRecurringSchedules,
  recurringJobSchedules,
  registerAllWorkers,
  type JobRuntime,
  type WorkerRegistration,
} from "./jobs.js";
import { BLOOD_SOS_JOB_NAMES } from "./modules/blood-sos/index.js";
import { EVENTS_JOB_NAMES } from "./modules/events/index.js";
import {
  IDENTITY_JOB_NAMES,
  IDENTITY_JOB_SCHEDULES,
} from "./modules/identity/index.js";
import {
  MEDIA_JOB_NAMES,
  MEDIA_JOB_SCHEDULES,
} from "./modules/media/index.js";
import {
  NOTICES_JOB_NAMES as NOTICE_JOB_NAMES,
  NOTICES_JOB_SCHEDULES as NOTICE_JOB_SCHEDULES,
} from "./modules/notices/index.js";
import {
  OFFICER_JOB_NAMES,
  OFFICER_JOB_SCHEDULES,
} from "./modules/officer/index.js";
import {
  PAYMENT_JOB_NAMES,
  PAYMENT_JOB_SCHEDULES,
} from "./modules/payments/index.js";
import {
  REGISTER_JOB_NAMES,
  REGISTER_JOB_SCHEDULES,
} from "./modules/register/index.js";
import {
  REGISTRATION_JOB_NAMES,
  REGISTRATION_JOB_SCHEDULES,
} from "./modules/registration/index.js";
import {
  JOB_NAMES as HTTP_JOB_NAMES,
  JOB_SCHEDULES as HTTP_JOB_SCHEDULES,
} from "./http/jobs.js";

describe("recurring job schedules", () => {
  it("covers every documented periodic maintenance handler with IST cadence", () => {
    const registrations: readonly WorkerRegistration[] = [
      {
        name: IDENTITY_JOB_NAMES.purgeSessionsAndBuckets,
        handler: () => undefined,
        schedule: IDENTITY_JOB_SCHEDULES.purgeSessionsAndBuckets,
      },
      {
        name: REGISTER_JOB_NAMES.purgeRestricted,
        handler: () => undefined,
        schedule: REGISTER_JOB_SCHEDULES.purgeRestricted,
      },
      {
        name: OFFICER_JOB_NAMES.PURGE_PROCESSING_RECORDS,
        handler: () => undefined,
        schedule: OFFICER_JOB_SCHEDULES.PURGE_PROCESSING_RECORDS,
      },
      {
        name: HTTP_JOB_NAMES.purgeIdempotency,
        handler: () => undefined,
        schedule: HTTP_JOB_SCHEDULES.purgeIdempotency,
      },
      {
        name: REGISTRATION_JOB_NAMES.expireJoinRequests,
        handler: () => undefined,
        schedule: REGISTRATION_JOB_SCHEDULES.expireJoinRequests,
      },
      {
        name: REGISTRATION_JOB_NAMES.abandonIdle,
        handler: () => undefined,
        schedule: REGISTRATION_JOB_SCHEDULES.abandonIdle,
      },
      {
        name: PAYMENT_JOB_NAMES.reconcile,
        handler: () => undefined,
        schedule: PAYMENT_JOB_SCHEDULES.reconcile,
      },
      {
        name: MEDIA_JOB_NAMES.gcOrphans,
        handler: () => undefined,
        schedule: MEDIA_JOB_SCHEDULES.gcOrphans,
      },
      {
        name: MEDIA_JOB_NAMES.screenBacklog,
        handler: () => undefined,
        schedule: MEDIA_JOB_SCHEDULES.screenBacklog,
      },
      {
        name: MEDIA_JOB_NAMES.purgeQuarantine,
        handler: () => undefined,
        schedule: MEDIA_JOB_SCHEDULES.purgeQuarantine,
      },
      {
        name: NOTICE_JOB_NAMES.expireListings,
        handler: () => undefined,
        schedule: NOTICE_JOB_SCHEDULES.expireListings,
      },
      {
        name: NOTICE_JOB_NAMES.endSuspensions,
        handler: () => undefined,
        schedule: NOTICE_JOB_SCHEDULES.endSuspensions,
      },
      {
        name: NOTICE_JOB_NAMES.escalateArchivals,
        handler: () => undefined,
        schedule: NOTICE_JOB_SCHEDULES.escalateArchivals,
      },
    ];

    expect(recurringJobSchedules(registrations)).toEqual([
      { ...IDENTITY_JOB_SCHEDULES.purgeSessionsAndBuckets, name: IDENTITY_JOB_NAMES.purgeSessionsAndBuckets },
      { ...REGISTER_JOB_SCHEDULES.purgeRestricted, name: REGISTER_JOB_NAMES.purgeRestricted },
      { ...OFFICER_JOB_SCHEDULES.PURGE_PROCESSING_RECORDS, name: OFFICER_JOB_NAMES.PURGE_PROCESSING_RECORDS },
      { ...HTTP_JOB_SCHEDULES.purgeIdempotency, name: HTTP_JOB_NAMES.purgeIdempotency },
      { ...REGISTRATION_JOB_SCHEDULES.expireJoinRequests, name: REGISTRATION_JOB_NAMES.expireJoinRequests },
      { ...REGISTRATION_JOB_SCHEDULES.abandonIdle, name: REGISTRATION_JOB_NAMES.abandonIdle },
      { ...PAYMENT_JOB_SCHEDULES.reconcile, name: PAYMENT_JOB_NAMES.reconcile },
      { ...MEDIA_JOB_SCHEDULES.gcOrphans, name: MEDIA_JOB_NAMES.gcOrphans },
      { ...MEDIA_JOB_SCHEDULES.screenBacklog, name: MEDIA_JOB_NAMES.screenBacklog },
      { ...MEDIA_JOB_SCHEDULES.purgeQuarantine, name: MEDIA_JOB_NAMES.purgeQuarantine },
      { ...NOTICE_JOB_SCHEDULES.expireListings, name: NOTICE_JOB_NAMES.expireListings },
      { ...NOTICE_JOB_SCHEDULES.endSuspensions, name: NOTICE_JOB_NAMES.endSuspensions },
      { ...NOTICE_JOB_SCHEDULES.escalateArchivals, name: NOTICE_JOB_NAMES.escalateArchivals },
    ]);
    expect(BLOOD_SOS_JOB_NAMES).not.toHaveProperty("schedule");
    expect(EVENTS_JOB_NAMES).not.toHaveProperty("schedule");
  });

  it("deduplicates a stable schedule key during startup", async () => {
    const registration: WorkerRegistration = {
      name: "maintenance.example",
      handler: () => undefined,
      schedule: { cron: "0 * * * *", timezone: "Asia/Kolkata", key: "maintenance.example" },
    };
    const scheduled: string[] = [];
    const runtime: JobRuntime = {
      enabled: true,
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      isReady: () => Promise.resolve(true),
      send: () => Promise.resolve(null),
      registerWorker: () => Promise.resolve(),
      schedule: (name) => {
        scheduled.push(name);
        return Promise.resolve();
      },
    };

    await provisionRecurringSchedules(runtime, [registration, registration]);

    expect(scheduled).toEqual([registration.name]);
  });

  it("registers workers before provisioning their recurring schedules", async () => {
    const order: string[] = [];
    const registration: WorkerRegistration = {
      name: "maintenance.ordered",
      handler: () => undefined,
      schedule: { cron: "*/10 * * * *", timezone: "Asia/Kolkata" },
    };
    const runtime: JobRuntime = {
      enabled: true,
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      isReady: () => Promise.resolve(true),
      send: () => Promise.resolve(null),
      registerWorker: () => {
        order.push("worker");
        return Promise.resolve();
      },
      schedule: () => {
        order.push("schedule");
        return Promise.resolve();
      },
    };

    await registerAllWorkers(runtime, [registration]);

    expect(order).toEqual(["worker", "schedule"]);
  });
});
