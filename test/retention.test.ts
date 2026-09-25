import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixedClock } from "../src/clock.js";
import { createPrismaClient, type Database } from "../src/db.js";
import { createJobRuntime, type JobRuntime } from "../src/jobs.js";
import { OfficerService, type OfficerRegisterPort } from "../src/modules/officer/index.js";
import { RegisterService } from "../src/modules/register/index.js";
import { getTestAppDatabaseUrl, getTestDatabase } from "./setup.js";

// The least-privilege runtime role. The shared test setup connects as the
// owner, so these checks only run when a separate app-role URL is provided.
const appDatabaseUrl = getTestAppDatabaseUrl();

const RESTRICTED_TABLES = ["consent_event", "payment", "refund", "member_tombstone"] as const;
type RestrictedTable = (typeof RESTRICTED_TABLES)[number];

const clock = new FixedClock(new Date("2026-09-23T10:00:00.000Z"));

const unusedRegisterPort: OfficerRegisterPort = {
  project: () => Promise.reject(new Error("unused")),
  eraseMember: () => Promise.reject(new Error("unused")),
  readNomineeForOfficer: () => Promise.reject(new Error("unused")),
  unarchiveMember: () => Promise.reject(new Error("unused")),
};

function registerServiceFor(db: Database): RegisterService {
  const unused = (): Promise<never> => Promise.reject(new Error("unused"));
  return new RegisterService({
    db,
    clock,
    config: {
      retentionDaysPayments: 2920,
      retentionDaysConsentAndLogs: 365,
      mediaUrlTtlSeconds: 3600,
      erasureSelfServiceEnabled: true,
    },
    pincodeDirectory: { lookup: unused },
    objectStore: { put: unused, presignGet: unused, delete: unused },
    jobs: {
      send: unused,
      registerWorker: unused,
      start: unused,
      stop: unused,
      isReady: () => Promise.resolve(false),
      enabled: false,
    },
    payments: { moveToRestricted: unused, releaseHeadAnchor: unused },
    suspensionResolver: { resolveActiveSuspension: () => Promise.resolve(null) },
  });
}

async function seedRestricted(owner: Database, id: string, retainUntil: string): Promise<void> {
  await owner.$executeRaw`
    INSERT INTO restricted.consent_event (id, member_id, toggle, value, source, retain_until)
    VALUES (${id}, 'member-1', 'photo', true, 'MEMBER', ${retainUntil}::timestamptz)`;
  await owner.$executeRaw`
    INSERT INTO restricted.payment
      (id, purpose, subject_id, payer_phone_e164, amount_paise, status, razorpay_order_id, retain_until)
    VALUES (${id}, 'REGISTRATION', 'subject-1', '+919876543210', 10000, 'CAPTURED', ${`order-${id}`},
            ${retainUntil}::timestamptz)`;
  await owner.$executeRaw`
    INSERT INTO restricted.refund (id, payment_id, reason, amount_paise, status, retain_until)
    VALUES (${id}, ${id}, 'DUPLICATE', 10000, 'PROCESSED', ${retainUntil}::timestamptz)`;
  await owner.$executeRaw`
    INSERT INTO restricted.member_tombstone (member_id, erased_at, retain_until)
    VALUES (${id}, ${retainUntil}::timestamptz - interval '1 day', ${retainUntil}::timestamptz)`;
}

async function restrictedIds(owner: Database, table: RestrictedTable): Promise<string[]> {
  const idColumn = table === "member_tombstone" ? "member_id" : "id";
  const rows = await owner.$queryRawUnsafe<{ id: string }[]>(
    `SELECT ${idColumn} AS id FROM restricted.${table} ORDER BY 1`,
  );
  return rows.map((row) => row.id);
}

describe.skipIf(!appDatabaseUrl)("retention purges under the least-privilege app role", () => {
  let app: Database;

  beforeAll(() => {
    app = createPrismaClient(appDatabaseUrl ?? "");
  });

  afterAll(async () => {
    await app.$disconnect();
  });

  it("purgeRestricted deletes expired restricted rows and keeps live ones", async () => {
    const owner = getTestDatabase();
    await seedRestricted(owner, "expired", "2000-01-01T00:00:00Z");
    await seedRestricted(owner, "live", "2999-01-01T00:00:00Z");

    await registerServiceFor(app).purgeRestricted();

    for (const table of RESTRICTED_TABLES) {
      await expect(restrictedIds(owner, table)).resolves.toEqual(["live"]);
    }
  });

  it("still cannot read or delete restricted rows directly", async () => {
    for (const table of RESTRICTED_TABLES) {
      await expect(app.$queryRawUnsafe(`SELECT 1 FROM restricted.${table}`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(app.$executeRawUnsafe(`DELETE FROM restricted.${table}`)).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("purgeExpiredProcessingRecords deletes expired records and keeps live ones", async () => {
    const owner = getTestDatabase();
    const base = { actorKind: "SYSTEM", action: "OFFICER_MEMBER_LOOKUP", subjectType: "MEMBER", subjectId: "member-1" };
    await owner.processingRecord.createMany({
      data: [
        { ...base, id: "expired", at: new Date("1999-01-01T00:00:00Z"), retainUntil: new Date("2000-01-01T00:00:00Z") },
        { ...base, id: "live", at: new Date("2026-09-01T00:00:00Z"), retainUntil: new Date("2999-01-01T00:00:00Z") },
      ],
    });

    const officer = new OfficerService({
      db: app,
      clock,
      retentionDaysConsentAndLogs: 365,
      register: unusedRegisterPort,
    });
    await officer.purgeExpiredProcessingRecords();

    const remaining = await owner.processingRecord.findMany({ select: { id: true } });
    expect(remaining).toEqual([{ id: "live" }]);
    await expect(app.processingRecord.deleteMany({})).rejects.toThrow(/permission denied/);
  });

  describe("pg-boss", () => {
    let runtime: JobRuntime | undefined;

    afterAll(async () => {
      await runtime?.stop();
    });

    it("starts, sends and works as the app role", async () => {
      runtime = createJobRuntime({ connectionString: appDatabaseUrl ?? "" });
      await runtime.start();

      await expect(runtime.send("test.app-role", { ok: true })).resolves.toEqual(expect.any(String));
      await expect(
        runtime.registerWorker({ name: "test.app-role", handler: () => undefined }),
      ).resolves.toBeUndefined();
    });
  });
});
