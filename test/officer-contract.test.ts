import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import ajvFormats from "ajv-formats";
import express, { type Express } from "express";
import request from "supertest";
import { v7 as uuidv7 } from "uuid";
import { parse as parseYaml } from "yaml";
import { beforeEach, describe, expect, it } from "vitest";
import { createOfficerErasureRequests } from "../src/adapters/governance.js";
import { createOfficerMemberLookup } from "../src/adapters/member-lookup.js";
import { createNoticesDatabase } from "../src/adapters/notices-db.js";
import { createProcessingRecordWriter } from "../src/adapters/processing-record.js";
import { FixedClock } from "../src/clock.js";
import { errorMiddleware } from "../src/http/errors.js";
import { MediaService, type MediaObjectStore } from "../src/modules/media/service.js";
import {
  createOfficerArchivalAdapter,
  createOfficerReportAdapter,
  createOfficerSuspensionAdapter,
  NoticesService,
} from "../src/modules/notices/index.js";
import {
  createOfficerRoutes,
  officerRouteManifest,
  OfficerService,
  type MemberLookupPage,
  type OfficerRouteService,
} from "../src/modules/officer/index.js";
import type { MemberProjection } from "../src/modules/register/index.js";
import { getTestDatabase } from "./setup.js";

// Guards the hand-written contract that the Flutter client is generated from:
// every Officer response the server actually sends must validate against
// openapi/v1.yaml, and every Officer route must answer with the success
// status the contract declares.

type Spec = {
  readonly paths: Record<string, Record<string, { readonly responses: Record<string, unknown> }>>;
};
const specText = readFileSync(new URL("../openapi/v1.yaml", import.meta.url), "utf8");
const spec = parseYaml(specText) as Spec;
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajvFormats.default(ajv);
ajv.addSchema({ ...(spec as object), $id: "v1" });

const OFFICER_ID = "019b3d5c-5f0f-7a00-8000-0000000000a1";
const clock = new FixedClock(new Date("2026-09-25T10:00:00.000Z"));

/** Finds the v1.yaml path for an Express route; parameter names may differ. */
function openApiPath(expressPath: string): string {
  const shape = expressPath.replaceAll(/:[A-Za-z]+/gu, "{}");
  const match = Object.keys(spec.paths).find((path) => path.replaceAll(/\{[A-Za-z]+\}/gu, "{}") === shape);
  if (match === undefined) throw new Error(`${expressPath} is not in v1.yaml`);
  return match;
}

function pointer(...segments: readonly string[]): string {
  return segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
}

function successStatus(path: string, method: string): string {
  const responses = spec.paths[path]?.[method]?.responses;
  if (responses === undefined) throw new Error(`${method.toUpperCase()} ${path} is not in v1.yaml`);
  const statuses = Object.keys(responses).filter((status) => status.startsWith("2"));
  expect(statuses, `${method.toUpperCase()} ${path} must declare exactly one success status`).toHaveLength(1);
  return statuses[0] ?? "";
}

function expectContractBody(expressPath: string, method: "get" | "post", body: unknown): void {
  const path = openApiPath(expressPath);
  const status = successStatus(path, method);
  const validate = ajv.getSchema(
    `v1#/${pointer("paths", path, method, "responses", status, "content", "application/json", "schema")}`,
  );
  if (validate === undefined) throw new Error(`${method.toUpperCase()} ${path} declares no JSON body`);
  const valid = validate(body);
  expect(
    valid ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`),
    `${method.toUpperCase()} ${path} response must match v1.yaml`,
  ).toEqual([]);
}

function fullProjection(memberId: string): MemberProjection {
  return {
    memberId,
    familyPublicId: "AGR-492001-00017",
    isHead: true,
    name: { en: "Vikram Agrawal", hi: "विक्रम अग्रवाल" },
    gotra: "BANSAL",
    city: "Raipur",
    state: "CHHATTISGARH",
    photoUrl: "https://media.test/photo.jpg",
    phoneE164: "+919876543210",
  };
}

function minimalProjection(memberId: string): MemberProjection {
  return { memberId, familyPublicId: "AGR-492001-00018", isHead: false };
}

class StaticObjectStore implements MediaObjectStore {
  put(): Promise<void> { return Promise.resolve(); }
  presignGet(key: string, ttlSeconds: number): Promise<string> {
    return Promise.resolve(`https://media.test/${encodeURIComponent(key)}?ttl=${String(ttlSeconds)}`);
  }
  delete(): Promise<void> { return Promise.resolve(); }
}

function officerApp(service: OfficerRouteService): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _response, next) => {
    req.principal = {
      kind: "MEMBER",
      sessionId: "session",
      phoneE164: "+919876500000",
      memberId: OFFICER_ID,
      familyPublicId: "AGR-492001-00001",
      roles: ["OFFICER", "OPERATOR"],
      isHead: false,
    };
    next();
  });
  app.use(createOfficerRoutes({ service }));
  app.use(errorMiddleware());
  return app;
}

async function seedMember(input: {
  readonly id: string;
  readonly nameEn: string;
  readonly status: "ACTIVE" | "ARCHIVED";
  readonly phoneE164: string;
}): Promise<void> {
  await getTestDatabase().member.create({
    data: {
      id: input.id,
      phoneE164: input.phoneE164,
      status: input.status,
      nameEn: input.nameEn,
      gender: "MALE",
      dateOfBirth: new Date("1980-01-01T00:00:00.000Z"),
      bloodGroup: "O_POS",
      addressLine1: "12 Station Road",
      city: "Raipur",
      cityKey: "raipur",
      state: "CHHATTISGARH",
      pincode: "492001",
      nativePlaceKind: "UNKNOWN",
      consentBloodGroup: true,
      consentPhoto: true,
      paymentDisclosureAckAt: clock.now(),
      ...(input.status === "ARCHIVED" ? { archivedAt: clock.now(), archivedBy: OFFICER_ID } : {}),
    },
  });
}

describe("Officer API contract (openapi/v1.yaml)", () => {
  const activeMemberId = uuidv7();
  const archivedMemberId = uuidv7();
  let app: Express;

  // setup.ts truncates every table before each test, so seed per test.
  beforeEach(async () => {
    const database = getTestDatabase();
    const processingRecord = createProcessingRecordWriter({ clock, retentionDays: 365 });
    const notices = new NoticesService({
      db: createNoticesDatabase(database),
      clock: { now: () => clock.now(), todayIst: () => "2026-09-25" },
      config: {
        postingCapPerDay: 3,
        reportsThreshold: 5,
        suspensionDurationDays: 7,
        archivalEscalationDays: 7,
        businessListingDurationDays: 180,
        blockedWords: [],
        phoneRegexInText: "",
      },
      register: {
        isActiveMember: () => Promise.resolve(true),
        familyOf: () => Promise.resolve(null),
        adultMembersOfFamily: () => Promise.resolve([]),
        archiveMember: () => Promise.resolve(),
        project: () => Promise.resolve(new Map()),
        onMemberErased: () => {},
      },
      media: { urlFor: () => Promise.resolve(null), ownedBy: () => Promise.resolve(true) },
      business: {
        isBoardOpen: () => true,
        getListingFeePaise: () => null,
        createPaymentOrder: () => Promise.reject(new Error("unused payment order")),
        markConsumed: () => Promise.resolve(),
        refund: () => Promise.resolve(),
      },
      notifications: { send: () => Promise.resolve() },
      processingRecord: { write: () => Promise.resolve() },
    });
    const media = new MediaService({
      db: database,
      clock,
      config: { imageScreeningEnabled: false, mediaUrlTtlSeconds: 3600 },
      objectStore: new StaticObjectStore(),
      jobs: { send: () => Promise.resolve("job") },
      processingRecord,
    });
    const officer = new OfficerService({
      db: database,
      clock,
      retentionDaysConsentAndLogs: 365,
      register: {
        // Officer views must hold for both a fully visible and a minimal projection.
        project: (_viewer, ids) => Promise.resolve(new Map(ids.map((id, index) => [
          id,
          index % 2 === 0 ? fullProjection(id) : minimalProjection(id),
        ]))),
        eraseMember: () => Promise.resolve(),
        readNomineeForOfficer: (_tx, memberId) => Promise.resolve(fullProjection(memberId)),
        unarchiveMember: () => Promise.resolve({ successionReverted: false }),
      },
      processingRecord,
      media,
      memberLookup: createOfficerMemberLookup(database),
      erasureRequests: createOfficerErasureRequests(database),
      suspensions: createOfficerSuspensionAdapter(notices),
      archivals: createOfficerArchivalAdapter(notices),
      reports: createOfficerReportAdapter(notices),
    });
    app = officerApp(officer);

    await seedMember({ id: activeMemberId, nameEn: "Contract Lookup", status: "ACTIVE", phoneE164: "+919800000001" });
    await seedMember({ id: archivedMemberId, nameEn: "Contract Lookup", status: "ARCHIVED", phoneE164: "+919800000002" });
    await database.flag.createMany({
      data: [
        {
          id: uuidv7(),
          kind: "POSSIBLE_DUPLICATE_PERSON",
          subjectType: "MEMBER",
          subjectId: activeMemberId,
          relatedIds: [archivedMemberId],
        },
        { id: uuidv7(), kind: "NO_PAYMENT_IDENTITY", subjectType: "REGISTRATION", subjectId: uuidv7() },
        {
          id: uuidv7(),
          kind: "SHARED_ADDRESS",
          status: "RESOLVED",
          subjectType: "MEMBER",
          subjectId: activeMemberId,
          resolvedAt: clock.now(),
          resolvedBy: OFFICER_ID,
          resolution: "CLEARED",
          note: "Different households at one address.",
        },
      ],
    });
    await database.erasureRequest.createMany({
      data: [
        { id: uuidv7(), memberId: activeMemberId, source: "MEMBER", status: "PENDING" },
        { id: uuidv7(), memberId: archivedMemberId, source: "NOMINEE", status: "PENDING" },
      ],
    });
    await database.image.createMany({
      data: [
        {
          id: uuidv7(),
          purpose: "MEMBER_PHOTO",
          ownerMemberId: activeMemberId,
          s3Key: "members/photo.jpg",
          widthPx: 640,
          heightPx: 640,
          bytes: 2048,
        },
        {
          id: uuidv7(),
          purpose: "SHOK_SANDESH_PHOTO",
          status: "REJECTED",
          statusReason: "Screening rejected the image.",
          s3Key: "notices/photo.jpg",
          widthPx: 800,
          heightPx: 600,
          bytes: 4096,
        },
      ],
    });
    await database.suspension.createMany({
      data: [
        {
          id: uuidv7(),
          memberId: activeMemberId,
          reason: "REPORT_THRESHOLD",
          activeNoticeId: uuidv7(),
          startsAt: new Date("2026-09-24T10:00:00.000Z"),
          endsAt: new Date("2026-10-01T10:00:00.000Z"),
        },
        {
          id: uuidv7(),
          memberId: archivedMemberId,
          reason: "REPORT_THRESHOLD",
          startsAt: new Date("2026-09-10T10:00:00.000Z"),
          endsAt: new Date("2026-09-17T10:00:00.000Z"),
          liftedAt: new Date("2026-09-12T10:00:00.000Z"),
          liftedBy: OFFICER_ID,
          liftedReason: "Verified in person.",
        },
      ],
    });
    await database.archivalRequest.createMany({
      data: [
        {
          id: uuidv7(),
          noticeMemberId: activeMemberId,
          deceasedMemberId: archivedMemberId,
          familyId: uuidv7(),
          status: "ESCALATED",
          escalatedAt: clock.now(),
          expiresAt: new Date("2026-10-02T10:00:00.000Z"),
        },
        {
          id: uuidv7(),
          deceasedMemberId: activeMemberId,
          familyId: uuidv7(),
          status: "CONFIRMED",
          respondedAt: clock.now(),
          respondedBy: OFFICER_ID,
          expiresAt: new Date("2026-10-02T10:00:00.000Z"),
        },
      ],
    });
    await database.report.create({
      data: {
        id: uuidv7(),
        targetType: "BLOOD_SOS",
        targetId: uuidv7(),
        reporterMemberId: activeMemberId,
        reporterFamilyId: uuidv7(),
        reason: "Not a real emergency.",
      },
    });
  });

  it.each([
    ["flags (open)", officerRouteManifest.listFlags.path, ""],
    ["flags (resolved)", officerRouteManifest.listFlags.path, "?status=RESOLVED"],
    ["erasure requests", officerRouteManifest.listErasureRequests.path, ""],
    ["member lookup", officerRouteManifest.lookupMembers.path, "?q=Contract%20Lookup"],
    ["images", officerRouteManifest.listImages.path, ""],
    ["suspensions (active)", officerRouteManifest.listSuspensions.path, ""],
    ["suspensions (lifted)", officerRouteManifest.listSuspensions.path, "?active=false"],
    ["archival requests (escalated)", officerRouteManifest.listArchivalRequests.path, ""],
    ["archival requests (resolved)", officerRouteManifest.listArchivalRequests.path, "?status=RESOLVED"],
    ["reports", officerRouteManifest.listReports.path, ""],
  ])("lists %s in the documented shape", async (_name, path, query) => {
    const response = await request(app).get(`${path}${query}`);
    expect(response.status).toBe(200);
    expectContractBody(path, "get", response.body);
  });

  it("lists the processing record in the documented shape", async () => {
    await request(app).get(`${officerRouteManifest.lookupMembers.path}?q=Contract%20Lookup`);
    const path = officerRouteManifest.listProcessingRecords.path;
    const response = await request(app).get(`${path}?subjectId=${activeMemberId}`);
    expect(response.status).toBe(200);
    expectContractBody(path, "get", response.body);
  });

  it("marks only the Archived Member as archived in lookup", async () => {
    const response = await request(app).get(`${officerRouteManifest.lookupMembers.path}?q=Contract%20Lookup`);
    const archivedById = new Map(
      (response.body as MemberLookupPage).items
        .map((item) => [item.member.memberId, item.archived]),
    );
    expect(archivedById).toEqual(new Map([[activeMemberId, false], [archivedMemberId, true]]));
  });

  it("reads a Nominee in the documented shape", async () => {
    const path = officerRouteManifest.readNominee.path;
    const response = await request(app)
      .post(path.replace(":memberId", activeMemberId))
      .send({ reason: "CONFIRMED_DEATH" });
    expect(response.status).toBe(200);
    expectContractBody(path, "post", response.body);
  });

  it("unarchives in the documented shape", async () => {
    const path = officerRouteManifest.unarchiveMember.path;
    const response = await request(app).post(path.replace(":memberId", archivedMemberId));
    expect(response.status).toBe(200);
    expectContractBody(path, "post", response.body);
  });
});

describe("Officer API success statuses (openapi/v1.yaml)", () => {
  const id = "019b3d5c-5f0f-7a00-8000-0000000000b1";
  const page = () => Promise.resolve({ items: [], nextCursor: null });
  const done = () => Promise.resolve();
  const service: OfficerRouteService = {
    listFlags: page,
    resolveFlag: done,
    listErasureRequests: page,
    eraseMember: done,
    lookupMembers: page,
    listImages: page,
    removeImage: done,
    approveImage: done,
    refundPayment: done,
    listProcessingRecords: page,
    readNominee: () => Promise.resolve({ nominee: null }),
    unarchiveMember: () => Promise.resolve({ successionReverted: false }),
    listSuspensions: page,
    liftSuspension: done,
    listArchivalRequests: page,
    resolveArchival: done,
    listReports: page,
    closeBloodSos: done,
    changeRole: done,
  };
  const validBodies: Partial<Record<keyof typeof officerRouteManifest, object>> = {
    resolveFlag: { outcome: "CLEARED", note: "Checked." },
    eraseMember: { reason: "Requested by the Member." },
    removeImage: { reason: "Explicit image." },
    refundPayment: { reason: "Charged twice." },
    readNominee: { reason: "CONFIRMED_DEATH" },
    liftSuspension: { reason: "Verified in person.", restoreNotice: false },
    resolveArchival: { outcome: "CONFIRM", note: "Confirmed." },
    closeBloodSos: { reason: "Not an emergency." },
    changeRole: { memberId: id, role: "ORGANISER", action: "GRANT" },
  };
  const queries: Partial<Record<keyof typeof officerRouteManifest, string>> = {
    lookupMembers: "?q=Agrawal",
    listProcessingRecords: `?subjectId=${id}`,
  };

  it.each(Object.entries(officerRouteManifest))("%s answers with the documented status", async (name, route) => {
    const key = name as keyof typeof officerRouteManifest;
    const url = `${route.path.replaceAll(/:[A-Za-z]+/gu, id)}${queries[key] ?? ""}`;
    const app = officerApp(service);
    const response = route.method === "get"
      ? await request(app).get(url)
      : await request(app).post(url).set("Idempotency-Key", uuidv7()).send(validBodies[key] ?? {});
    expect(String(response.status)).toBe(successStatus(openApiPath(route.path), route.method));
  });
});
