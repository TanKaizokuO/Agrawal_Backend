import express, { type Express } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../../clock.js";
import { errorMiddleware } from "../../http/errors.js";
import { InMemoryNoticesDatabase, type NoticesTxClient } from "./db.js";
import {
  createNoticesWorkers,
  createOfficerArchivalAdapter,
  createOfficerReportAdapter,
  createOfficerSuspensionAdapter,
  NOTICES_JOB_NAMES,
} from "./index.js";
import type {
  NoticeAuthorProjection,
  NoticesBusinessPort,
  NoticesConfig,
  NoticeImagePurpose,
  NoticesMediaPort,
  NoticesNotificationsPort,
  NoticePushMessage,
  NoticesProcessingRecordWriter,
  NoticesRegisterPort,
  ProcessingEntry,
} from "./ports.js";
import { createNoticesRoutes } from "./routes.js";
import { ShokSandeshBody } from "./schemas.js";
import { NoticesService } from "./service.js";

const BASE_TIME = new Date("2026-09-19T10:00:00.000Z");

interface MemberRecord {
  readonly id: string;
  readonly familyId: string;
  readonly familyPublicId: string;
  readonly phoneE164: string;
  status: "ACTIVE" | "ARCHIVED";
  nameEn: string;
  nameHi: string;
}
type TestResponse<T = unknown> = { readonly body: T };

interface NoticeResponseBody {
  readonly notice: {
    readonly id: string;
    readonly status?: string;
    readonly imageUrl?: string | null;
    readonly author: {
      readonly name?: { readonly en?: string };
    };
  };
}

interface ListingResponseBody {
  readonly listing: {
    readonly id: string;
    readonly status?: string;
    readonly businessPhone?: string;
  };
}

interface ErrorResponseBody {
  readonly error: { readonly code: string };
}

interface ItemsResponseBody {
  readonly items: readonly { readonly id: string }[];
}

interface SuspensionResponseBody {
  readonly suspension: {
    readonly reason: string;
    readonly noticeId: string;
    readonly endsAt: string;
  } | null;
}

interface ArchivalResponseBody {
  readonly archivalRequest: { readonly status: string };
}

interface AmountResponseBody {
  readonly amount: { readonly amountPaise: number };
}

function responseBody<T>(response: TestResponse<T>): T {
  return response.body;
}

interface TestContext {
  readonly db: InMemoryNoticesDatabase;
  readonly clock: FixedClock;
  readonly service: NoticesService;
  readonly app: Express;
  readonly notifications: NoticePushMessage[];
  readonly notificationsPort: NoticesNotificationsPort;
  readonly processingRecords: ProcessingEntry[];
  readonly members: Map<string, MemberRecord>;
  readonly consumedPayments: string[];
  readonly refundedPayments: Array<{ paymentId: string; reason: string }>;
  activeViewerId: string;
  businessFeePaise: number | null;
  screeningEnabled: boolean;
  ownImage(memberId: string, purpose: NoticeImagePurpose): string;
}

function createTestContext(options?: {
  readonly businessFeePaise?: number | null;
  readonly blockedWords?: readonly string[];
  readonly postingCapPerDay?: number;
}): TestContext {
  const db = new InMemoryNoticesDatabase();
  const clock = new FixedClock(BASE_TIME);
  const notifications: NoticePushMessage[] = [];
  const processingRecords: ProcessingEntry[] = [];
  const members = new Map<string, MemberRecord>();

  let activeViewerId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";
  let businessFeePaise: number | null = options?.businessFeePaise !== undefined ? options.businessFeePaise : 4900;
  let screeningEnabled = false;

  // Pre-seed some default members
  const member1: MemberRecord = {
    id: "018f4b7c-3a15-7f20-9f2c-0123456789aa",
    familyId: "fam-01",
    familyPublicId: "AGR-1001",
    phoneE164: "+919876543210",
    status: "ACTIVE",
    nameEn: "Aarav Agrawal",
    nameHi: "आरव अग्रवाल",
  };
  const member2: MemberRecord = {
    id: "018f4b7c-3a15-7f20-9f2c-0123456789bb",
    familyId: "fam-02",
    familyPublicId: "AGR-1002",
    phoneE164: "+919876543211",
    status: "ACTIVE",
    nameEn: "Diya Agrawal",
    nameHi: "दीया अग्रवाल",
  };
  const deceasedMember: MemberRecord = {
    id: "018f4b7c-3a15-7f20-9f2c-0123456789dd",
    familyId: "fam-deceased",
    familyPublicId: "AGR-1099",
    phoneE164: "+919876543299",
    status: "ACTIVE",
    nameEn: "Late Ramesh Agrawal",
    nameHi: "स्व. रमेश अग्रवाल",
  };
  const deceasedFamilyMember: MemberRecord = {
    id: "018f4b7c-3a15-7f20-9f2c-0123456789ee",
    familyId: "fam-deceased",
    familyPublicId: "AGR-1099",
    phoneE164: "+919876543298",
    status: "ACTIVE",
    nameEn: "Suresh Agrawal",
    nameHi: "सुरेश अग्रवाल",
  };

  members.set(member1.id, member1);
  members.set(member2.id, member2);
  members.set(deceasedMember.id, deceasedMember);
  members.set(deceasedFamilyMember.id, deceasedFamilyMember);


  const registerPort: NoticesRegisterPort = {
    isActiveMember: (memberId: string) => {
      const m = members.get(memberId);
      return Promise.resolve(m !== undefined && m.status === "ACTIVE");
    },
    familyOf: (memberId: string) => {
      const m = members.get(memberId);
      return Promise.resolve(m === undefined ? null : {
        familyId: m.familyId,
        publicId: m.familyPublicId,
        headMemberId: m.id,
      });
    },
    adultMembersOfFamily: (familyId: string, exceptMemberId?: string) => {
      const result: string[] = [];
      for (const m of members.values()) {
        if (m.familyId === familyId && m.status === "ACTIVE" && m.id !== exceptMemberId) {
          result.push(m.id);
        }
      }
      return Promise.resolve(result);
    },
    archiveMember: (_tx: NoticesTxClient, memberId: string) => Promise.resolve().then(() => {
      const m = members.get(memberId);
      if (m) {
        m.status = "ARCHIVED";
      }
    }),
    project: (viewerMemberId: string, memberIds: readonly string[]) => Promise.resolve().then(() => {
      const result = new Map<string, NoticeAuthorProjection>();
      for (const id of memberIds) {
        const m = members.get(id);
        if (m) {
          result.set(id, {
            memberId: m.id,
            familyPublicId: m.familyPublicId,
            isHead: true,
            name: { en: m.nameEn, hi: m.nameHi },
            city: "Indore",
            state: "MP",
            photoUrl: viewerMemberId === m.id ? "https://media.example.com/owner.jpg" : null,
          });
        }
      }
      return result;
    }),
    onMemberErased: () => {},
  };

  const images = new Map<string, { readonly ownerMemberId: string; readonly purpose: NoticeImagePurpose }>();
  const mediaPort: NoticesMediaPort = {
    ownedBy: (imageId, memberId, purpose) => {
      const image = images.get(imageId);
      return Promise.resolve(image?.ownerMemberId === memberId && image.purpose === purpose);
    },
    urlFor: (imageId: string, viewerMemberId: string | null) => Promise.resolve().then(() => {
      if (screeningEnabled) {
        return `https://media.example.com/${imageId}.jpg`;
      }
      // Screening off: uploader/owner only (member1)
      if (viewerMemberId === member1.id) {
        return `https://media.example.com/${imageId}.jpg`;
      }
      return null;
    }),
  };

  const consumedPayments: string[] = [];
  const refundedPayments: Array<{ paymentId: string; reason: string }> = [];

  const businessPort: NoticesBusinessPort = {
    isBoardOpen: () => businessFeePaise !== null,
    getListingFeePaise: () => businessFeePaise,
    createPaymentOrder: (input) => Promise.resolve({
      paymentId: crypto.randomUUID(),
      razorpayOrderId: `order_${crypto.randomUUID().slice(0, 8)}`,
      keyId: "rzp_test_key",
      amountPaise: input.amountPaise,
      currency: "INR",
      prefill: { contact: input.payerPhoneE164 },
      alreadyPaid: false,
    }),
    markConsumed: (paymentId: string) => {
      consumedPayments.push(paymentId);
      return Promise.resolve();
    },
    refund: (paymentId: string, reason: "PUBLICATION_FAILED") => {
      refundedPayments.push({ paymentId, reason });
      return Promise.resolve();
    },
  };

  const notificationsPort: NoticesNotificationsPort = {
    send: (_memberIds, message) => {
      notifications.push(message);
      return Promise.resolve();
    },
  };

  const processingWriter: NoticesProcessingRecordWriter = {
    write: (_tx, entry) => {
      processingRecords.push(entry);
      return Promise.resolve();
    },
  };


  const config: NoticesConfig = {
    postingCapPerDay: options?.postingCapPerDay ?? 3,
    reportsThreshold: 5,
    suspensionDurationDays: 7,
    archivalEscalationDays: 7,
    businessListingDurationDays: 180,
    blockedWords: options?.blockedWords ?? ["fraud", "spam"],
    phoneRegexInText: "(?:\\+91[\\s-]?)?[6-9]\\d{9}",
    get businessListingFeePaise() {
      return businessFeePaise;
    },
  };

  const service = new NoticesService({
    db,
    clock,
    config,
    register: registerPort,
    media: mediaPort,
    business: businessPort,
    notifications: notificationsPort,
    processingRecord: processingWriter,
  });

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const currentMember = members.get(activeViewerId) ?? member1;
    request.principal = {
      kind: "MEMBER",
      sessionId: "test-session",
      phoneE164: currentMember.phoneE164,
      memberId: currentMember.id,
      familyPublicId: currentMember.familyPublicId,
      roles: ["OFFICER"],
      isHead: true,
    };
    next();
  });
  app.use(createNoticesRoutes({ service }));
  app.use(errorMiddleware({
    error: (bindings, msg) => {
      console.error("CAUGHT_ERROR:", msg, bindings.err);
    },
  }));

  const ctx: TestContext = {
    db,
    clock,
    service,
    app,
    notifications,
    notificationsPort,
    processingRecords,
    members,
    consumedPayments,
    refundedPayments,
    get activeViewerId() {
      return activeViewerId;
    },
    set activeViewerId(v: string) {
      activeViewerId = v;
    },
    set businessFeePaise(v: number | null) {
      businessFeePaise = v;
    },
    get screeningEnabled() {
      return screeningEnabled;
    },
    set screeningEnabled(v: boolean) {
      screeningEnabled = v;
    },
    ownImage(memberId: string, purpose: NoticeImagePurpose) {
      const imageId = crypto.randomUUID();
      images.set(imageId, { ownerMemberId: memberId, purpose });
      return imageId;
    },
  };

  return ctx;
}

describe("Notices Module Behavioral Specifications", () => {
  it("authorizes nominee reads only for the exact deceased Member and Family", async () => {
    const ctx = createTestContext();
    const request = await ctx.db.archivalRequest.create({
      data: {
        id: crypto.randomUUID(),
        deceasedMemberId: "018f4b7c-3a15-7f20-9f2c-0123456789dd",
        familyId: "fam-deceased",
        status: "OPEN",
        expiresAt: new Date(BASE_TIME.getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await expect(
      ctx.service.isArchivalRequestOpen(
        "018f4b7c-3a15-7f20-9f2c-0123456789ee",
        request.id,
      ),
    ).resolves.toBe(false);
    await expect(
      ctx.service.isArchivalRequestOpen(
        "018f4b7c-3a15-7f20-9f2c-0123456789dd",
        request.id,
      ),
    ).resolves.toBe(true);

    await ctx.db.archivalRequest.update({
      where: { id: request.id },
      data: { status: "ESCALATED" },
    });
    await expect(
      ctx.service.isArchivalRequestOpen(
        "018f4b7c-3a15-7f20-9f2c-0123456789dd",
        request.id,
      ),
    ).resolves.toBe(true);

    await ctx.db.archivalRequest.update({
      where: { id: request.id },
      data: { status: "CONFIRMED" },
    });
    await expect(
      ctx.service.isArchivalRequestOpen(
        "018f4b7c-3a15-7f20-9f2c-0123456789dd",
        request.id,
      ),
    ).resolves.toBe(false);

  });

  it("invariant 10: a Shok Sandesh linked to a Member does not change the Member's status; only confirm does", async () => {
    const ctx = createTestContext();
    const deceasedId = "018f4b7c-3a15-7f20-9f2c-0123456789dd";

    // 1. Publish Shok Sandesh linked to deceasedId
    const res = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        linkedMemberId: deceasedId,
        title: "Sad demise of Ramesh Agrawal",
        bodyEn: "With deep grief we announce the passing of Shri Ramesh Agrawal.",
      });

    expect(res.status).toBe(201);
    expect(responseBody<NoticeResponseBody>(res).notice.id).toBeDefined();

    // Member status must STILL be ACTIVE (publication never archives a member)
    const deceasedMember = ctx.members.get(deceasedId);
    expect(deceasedMember?.status).toBe("ACTIVE");

    // ArchivalRequest was opened
    const requests = await ctx.db.archivalRequest.findMany({ where: { deceasedMemberId: deceasedId } });
    expect(requests.length).toBe(1);
    expect(requests[0]?.status).toBe("OPEN");

    const requestId = requests[0]?.id;
    if (requestId === undefined) throw new Error("Expected archival request");

    // 2. Family member confirms the archival request
    const familyMemberId = "018f4b7c-3a15-7f20-9f2c-0123456789ee";
    ctx.activeViewerId = familyMemberId;

    const confirmRes = await request(ctx.app)
      .post(`/v1/archival-requests/${requestId}/confirm`)
      .send({});

    expect(confirmRes.status).toBe(200);
    expect(responseBody<ArchivalResponseBody>(confirmRes).archivalRequest.status).toBe("CONFIRMED");

    // Now the member is ARCHIVED!
    expect(deceasedMember?.status).toBe("ARCHIVED");
    // Audited in Processing Record
    expect(ctx.processingRecords.some((p) => p.action === "MEMBER_ARCHIVED" && p.subjectId === deceasedId)).toBe(true);
  });

  it("invariant 12: a Business Listing in DRAFT is not visible in GET /v1/business-listings; becomes ACTIVE only after payment capture", async () => {
    const ctx = createTestContext();

    // Create DRAFT listing
    const createRes = await request(ctx.app)
      .post("/v1/business-listings")
      .send({
        name: "Agrawal Sweets",
        category: "GROCERY",
        businessCity: "Indore",
        businessPhone: "+919876543210",
        bodyEn: "Finest sweets and namkeen since 1950",
      });

    expect(createRes.status).toBe(201);
    const listingId = responseBody<ListingResponseBody>(createRes).listing.id;
    expect(responseBody<ListingResponseBody>(createRes).listing.status).toBe("DRAFT");

    // Public browse GET /v1/business-listings must NOT contain the DRAFT listing
    const browseRes1 = await request(ctx.app).get("/v1/business-listings");
    expect(browseRes1.status).toBe(200);
    expect(responseBody<ItemsResponseBody>(browseRes1).items.some((item) => item.id === listingId)).toBe(false);

    // Simulate payment capture worker: payments.captured.BUSINESS_LISTING
    const paymentId = crypto.randomUUID();
    await ctx.service.onPaymentCaptured({
      id: paymentId,
      subjectId: listingId,
      purpose: "BUSINESS_LISTING",
    });
    expect(ctx.consumedPayments).toContain(paymentId);
    // Listing is now ACTIVE
    const notice = await ctx.db.notice.findUnique({ where: { id: listingId } });
    expect(notice?.status).toBe("ACTIVE");
    expect(notice?.publishedAt).toBeDefined();
    expect(notice?.expiresAt).toBeDefined();

    // Now visible in public browse
    const browseRes2 = await request(ctx.app).get("/v1/business-listings");
    expect(browseRes2.status).toBe(200);
    expect(responseBody<ItemsResponseBody>(browseRes2).items.some((item) => item.id === listingId)).toBe(true);
  });

  it("calls payments.markConsumed on activation and idempotent refund(PUBLICATION_FAILED) on invalid state", async () => {
    const ctx = createTestContext();
    // 1. Invalid state (non-existent notice) -> refund PUBLICATION_FAILED
    const badPaymentId = crypto.randomUUID();
    await ctx.service.onPaymentCaptured({
      id: badPaymentId,
      subjectId: crypto.randomUUID(),
      purpose: "BUSINESS_LISTING",
    });
    expect(ctx.refundedPayments).toContainEqual({
      paymentId: badPaymentId,
      reason: "PUBLICATION_FAILED",
    });

    // 2. Hidden notice -> refund PUBLICATION_FAILED
    const hiddenNotice = await ctx.db.notice.create({
      data: {
        id: crypto.randomUUID(),
        board: "BUSINESS_LISTING",
        authorMemberId: "018f4b7c-3a15-7f20-9f2c-0123456789aa",
        authorFamilyId: "018f4b7c-3a15-7f20-9f2c-0123456789ff",
        status: "HIDDEN",
        title: "Hidden Listing",
        publishedAt: ctx.clock.now(),
        expiresAt: new Date(ctx.clock.now().getTime() + 86400000),
      },
    });
    const hiddenPaymentId = crypto.randomUUID();
    await ctx.service.onPaymentCaptured({
      id: hiddenPaymentId,
      subjectId: hiddenNotice.id,
      purpose: "BUSINESS_LISTING",
    });
    expect(ctx.refundedPayments).toContainEqual({
      paymentId: hiddenPaymentId,
      reason: "PUBLICATION_FAILED",
    });
  });

  it("consumes a processed Business Listing refund through its purpose worker", async () => {
    const ctx = createTestContext();
    const paymentId = crypto.randomUUID();
    const refundWorker = createNoticesWorkers(ctx.service)
      .find((worker) => worker.name === NOTICES_JOB_NAMES.paymentRefunded);
    if (refundWorker === undefined) throw new Error("Business Listing refund worker is missing");

    await refundWorker.handler({ paymentId, subjectId: crypto.randomUUID() });

    expect(ctx.consumedPayments).toContain(paymentId);
  });

  it("invariant 13: 4 reports from 4 families keep notice ACTIVE; 5th from 5th family sets HIDDEN", async () => {
    const ctx = createTestContext();

    // Author creates notice
    const createRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        title: "Announcement",
        bodyEn: "Community notice message body.",
      });
    const noticeId = responseBody<NoticeResponseBody>(createRes).notice.id;
    // Register 5 distinct reporter members from 5 distinct families
    for (let i = 1; i <= 5; i++) {
      const repId = `reporter-member-${String(i)}`;
      ctx.members.set(repId, {
        id: repId,
        familyId: `reporter-fam-${String(i)}`,
        familyPublicId: `AGR-REP-${String(i)}`,
        phoneE164: `+91987654300${String(i)}`,
        status: "ACTIVE",
        nameEn: `Reporter ${String(i)}`,
        nameHi: `रिपोर्टर ${String(i)}`,
      });
    }

    // Reports 1 to 4
    for (let i = 1; i <= 4; i++) {
      ctx.activeViewerId = `reporter-member-${String(i)}`;
      const repRes = await request(ctx.app)
        .post(`/v1/notices/${noticeId}/report`)
        .send({ reason: `Inappropriate content from family ${String(i)}` });
      expect(repRes.status).toBe(201);

      // Notice must STILL be ACTIVE
      const current = await ctx.db.notice.findUnique({ where: { id: noticeId } });
      expect(current?.status).toBe("ACTIVE");
    }

    // Report 5 from 5th distinct family
    ctx.activeViewerId = "reporter-member-5";
    const repRes5 = await request(ctx.app)
      .post(`/v1/notices/${noticeId}/report`)
      .send({ reason: "Fifth report reaches threshold" });
    expect(repRes5.status).toBe(201);

    // Notice is now HIDDEN
    const finalNotice = await ctx.db.notice.findUnique({ where: { id: noticeId } });
    expect(finalNotice?.status).toBe("HIDDEN");
    expect(finalNotice?.hiddenReason).toBe("REPORTS");

    // Suspension created for author
    const suspension = await ctx.service.activeSuspension("018f4b7c-3a15-7f20-9f2c-0123456789aa");
    expect(suspension).not.toBeNull();
    expect(suspension?.reason).toBe("REPORTS");
  });

  it("invariant 13: two reports from the same Family (different Members) count as one distinct Family", async () => {
    const ctx = createTestContext();

    // Author creates notice
    const createRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        title: "Announcement",
        bodyEn: "Community notice message body.",
      });
    const noticeId = responseBody<NoticeResponseBody>(createRes).notice.id;

    // Two members belonging to the SAME family
    ctx.members.set("fam-a-mem-1", {
      id: "fam-a-mem-1",
      familyId: "fam-shared",
      familyPublicId: "AGR-SHARED",
      phoneE164: "+919876543111",
      status: "ACTIVE",
      nameEn: "Brother 1",
      nameHi: "भाई 1",
    });
    ctx.members.set("fam-a-mem-2", {
      id: "fam-a-mem-2",
      familyId: "fam-shared",
      familyPublicId: "AGR-SHARED",
      phoneE164: "+919876543112",
      status: "ACTIVE",
      nameEn: "Brother 2",
      nameHi: "भाई 2",
    });

    ctx.activeViewerId = "fam-a-mem-1";
    const rep1 = await request(ctx.app)
      .post(`/v1/notices/${noticeId}/report`)
      .send({ reason: "Report 1" });
    expect(rep1.status).toBe(201);

    ctx.activeViewerId = "fam-a-mem-2";
    const rep2 = await request(ctx.app)
      .post(`/v1/notices/${noticeId}/report`)
      .send({ reason: "Report 2 from same family" });
    expect(rep2.status).toBe(201);

    // Duplicate report from member 1 fails ALREADY_REPORTED (409)
    ctx.activeViewerId = "fam-a-mem-1";
    const repDuplicate = await request(ctx.app)
      .post(`/v1/notices/${noticeId}/report`)
      .send({ reason: "Duplicate report" });
    expect(repDuplicate.status).toBe(409);

    // Total distinct families reporting is only 1
    const allReports = await ctx.db.report.findMany({ where: { noticeId } });
    const distinctFamilies = new Set(allReports.map((r) => r.reporterFamilyId));
    expect(distinctFamilies.size).toBe(1);

    const notice = await ctx.db.notice.findUnique({ where: { id: noticeId } });
    expect(notice?.status).toBe("ACTIVE");
  });

  it("invariant 13: a report from the author's own Family fails CANNOT_REPORT_OWN", async () => {
    const ctx = createTestContext();

    // Author creates notice
    const createRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        title: "Announcement",
        bodyEn: "Community notice message body.",
      });
    const noticeId = responseBody<NoticeResponseBody>(createRes).notice.id;

    // A member in the author's own family (fam-01) tries to report
    ctx.members.set("author-brother", {
      id: "author-brother",
      familyId: "fam-01",
      familyPublicId: "AGR-1001",
      phoneE164: "+919876543099",
      status: "ACTIVE",
      nameEn: "Author Brother",
      nameHi: "लेखक भाई",
    });

    ctx.activeViewerId = "author-brother";
    const repRes = await request(ctx.app)
      .post(`/v1/notices/${noticeId}/report`)
      .send({ reason: "Reporting family notice" });

    expect(repRes.status).toBe(422);
    expect(responseBody<ErrorResponseBody>(repRes).error.code).toBe("CANNOT_REPORT_OWN");
  });

  it("invariant 14: when a Notice is hidden, author receives SUSPENSION push; GET /v1/me/suspension returns active suspension; ends after SUSPENSION_DURATION_DAYS", async () => {
    const ctx = createTestContext();
    const authorId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";

    const createRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        title: "Announcement",
        bodyEn: "Community notice message body.",
      });
    const noticeId = responseBody<NoticeResponseBody>(createRes).notice.id;

    // 5 distinct families report
    for (let i = 1; i <= 5; i++) {
      const repId = `rep-fam-member-${String(i)}`;
      ctx.members.set(repId, {
        id: repId,
        familyId: `fam-rep-${String(i)}`,
        familyPublicId: `AGR-F-${String(i)}`,
        phoneE164: `+91987654900${String(i)}`,
        status: "ACTIVE",
        nameEn: `Reporter ${String(i)}`,
        nameHi: `रिपोर्टर ${String(i)}`,
      });
      ctx.activeViewerId = repId;
      await request(ctx.app)
        .post(`/v1/notices/${noticeId}/report`)
        .send({ reason: `Report ${String(i)}` });
    }

    // Push notification was sent with topic: SUSPENSION and topic: NOTICE_HIDDEN
    expect(ctx.notifications.some((n) => n.topic === "SUSPENSION")).toBe(true);
    expect(ctx.notifications.some((n) => n.topic === "NOTICE_HIDDEN")).toBe(true);

    // GET /v1/me/suspension returns the active suspension with endsAt
    ctx.activeViewerId = authorId;
    const suspRes = await request(ctx.app).get("/v1/me/suspension");
    expect(suspRes.status).toBe(200);
    const activeSuspension = responseBody<SuspensionResponseBody>(suspRes).suspension;
    expect(activeSuspension).not.toBeNull();
    if (activeSuspension === null) throw new Error("Expected active suspension");
    expect(activeSuspension.reason).toBe("REPORTS");
    expect(activeSuspension.noticeId).toBe(noticeId);
    expect(activeSuspension.endsAt).toBeDefined();

    // Suspended author cannot create new notice -> 403 POSTING_SUSPENDED
    const postRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        bodyEn: "Trying to post while suspended.",
      });
    expect(postRes.status).toBe(403);
    expect(responseBody<ErrorResponseBody>(postRes).error.code).toBe("POSTING_SUSPENDED");

    // Advance clock past SUSPENSION_DURATION_DAYS (7 days)
    ctx.clock.advance(7 * 24 * 60 * 60 * 1000 + 1000);

    // Run endSuspensions job
    const ended = await ctx.service.endSuspensions();
    expect(ended).toBe(1);

    // GET /v1/me/suspension is now null
    const suspResAfter = await request(ctx.app).get("/v1/me/suspension");
    expect(suspResAfter.status).toBe(200);
    expect(responseBody<SuspensionResponseBody>(suspResAfter).suspension).toBeNull();
  });

  it("dispatches hide and suspension notices concurrently and rejects after both settle", async () => {
    const ctx = createTestContext();
    const authorId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";
    const createRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        title: "Announcement",
        bodyEn: "Community notice message body.",
      });
    const noticeId = responseBody<NoticeResponseBody>(createRes).notice.id;

    for (let index = 1; index <= 4; index++) {
      const reporterId = `parallel-reporter-${String(index)}`;
      ctx.members.set(reporterId, {
        id: reporterId,
        familyId: `parallel-family-${String(index)}`,
        familyPublicId: `AGR-P-${String(index)}`,
        phoneE164: `+91987654000${String(index)}`,
        status: "ACTIVE",
        nameEn: `Reporter ${String(index)}`,
        nameHi: `रिपोर्टर ${String(index)}`,
      });
      await ctx.service.reportNotice(
        { memberId: reporterId },
        noticeId,
        { reason: `Report ${String(index)}` },
      );
    }

    const finalReporterId = "parallel-reporter-5";
    ctx.members.set(finalReporterId, {
      id: finalReporterId,
      familyId: "parallel-family-5",
      familyPublicId: "AGR-P-5",
      phoneE164: "+919876540005",
      status: "ACTIVE",
      nameEn: "Reporter 5",
      nameHi: "रिपोर्टर ५",
    });

    let inFlight = 0;
    let maximumInFlight = 0;
    const sentTopics: string[] = [];
    const notificationError = new Error("notification queue unavailable");
    ctx.notificationsPort.send = async (_memberIds, message) => {
      sentTopics.push(message.topic);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      try {
        await Promise.resolve();
        if (message.topic === "NOTICE_HIDDEN") throw notificationError;
      } finally {
        inFlight -= 1;
      }
    };

    await expect(ctx.service.reportNotice(
      { memberId: finalReporterId },
      noticeId,
      { reason: "Fifth report reaches threshold" },
    )).rejects.toBe(notificationError);

    expect(maximumInFlight).toBe(2);
    expect(sentTopics).toEqual(["NOTICE_HIDDEN", "SUSPENSION"]);
    expect(inFlight).toBe(0);
    expect((await ctx.db.notice.findUnique({ where: { id: noticeId } }))?.status).toBe("HIDDEN");
    expect(await ctx.db.suspension.findMany({ where: { memberId: authorId } })).toHaveLength(1);
  });


  it("text check: personal phone numbers and blocked words are refused", async () => {
    const ctx = createTestContext();

    // 1. Shok Sandesh with phone number in body -> 422 NOTICE_CONTAINS_PHONE
    const phoneNoticeRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        title: "Condolences",
        bodyEn: "Call family at 9812345678 for details.",
      });
    expect(phoneNoticeRes.status).toBe(422);
    expect(responseBody<ErrorResponseBody>(phoneNoticeRes).error.code).toBe("NOTICE_CONTAINS_PHONE");

    // 2. Shok Sandesh with blocked word -> 422 NOTICE_CONTAINS_BLOCKED_WORD
    const blockedNoticeRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        title: "Notice with spam",
        bodyEn: "This notice contains spam content.",
      });
    expect(blockedNoticeRes.status).toBe(422);
    expect(responseBody<ErrorResponseBody>(blockedNoticeRes).error.code).toBe("NOTICE_CONTAINS_BLOCKED_WORD");

    // 3. Business Listing with businessPhone in structured field -> accepted
    const validListingRes = await request(ctx.app)
      .post("/v1/business-listings")
      .send({
        name: "Agrawal Electronics",
        category: "SOFTWARE",
        businessCity: "Indore",
        businessPhone: "+919876543210",
        bodyEn: "High quality electronics store.",
      });
    expect(validListingRes.status).toBe(201);
    expect(responseBody<ListingResponseBody>(validListingRes).listing.businessPhone).toBe("+919876543210");

    // 4. Business Listing with phone in bodyEn -> 422 NOTICE_CONTAINS_PHONE
    const phoneInDescRes = await request(ctx.app)
      .post("/v1/business-listings")
      .send({
        name: "Agrawal Hardware",
        category: "CA",
        businessCity: "Indore",
        businessPhone: "+919876543210",
        bodyEn: "Contact the owner personally at 9876543211",
      });
    expect(phoneInDescRes.status).toBe(422);
    expect(responseBody<ErrorResponseBody>(phoneInDescRes).error.code).toBe("NOTICE_CONTAINS_PHONE");
  });

  it("archival request: refutation by linked member vs refutation by family", async () => {
    const ctx = createTestContext();
    const deceasedId = "018f4b7c-3a15-7f20-9f2c-0123456789dd";

    // Post Shok Sandesh linked to deceasedId
    await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        linkedMemberId: deceasedId,
        bodyEn: "Announcement of passing.",
      });

    const reqs = await ctx.db.archivalRequest.findMany({ where: { deceasedMemberId: deceasedId } });
    const reqId = reqs[0]?.id;
    if (reqId === undefined) throw new Error("Expected archival request");

    // Deceased member CANNOT confirm their own death -> 403 NOT_FAMILY_MEMBER
    ctx.activeViewerId = deceasedId;
    const confirmBySelf = await request(ctx.app)
      .post(`/v1/archival-requests/${reqId}/confirm`)
      .send({});
    expect(confirmBySelf.status).toBe(403);
    expect(responseBody<ErrorResponseBody>(confirmBySelf).error.code).toBe("NOT_FAMILY_MEMBER");

    // Deceased member CAN refute their own death!
    const refuteBySelf = await request(ctx.app)
      .post(`/v1/archival-requests/${reqId}/refute`)
      .send({});
    expect(refuteBySelf.status).toBe(200);
    expect(responseBody<ArchivalResponseBody>(refuteBySelf).archivalRequest.status).toBe("REFUTED");

    // Deceased member remains ACTIVE
    expect(ctx.members.get(deceasedId)?.status).toBe("ACTIVE");

    // After a REFUTED request, a fresh Shok Sandesh can open a new Archival Request
    ctx.activeViewerId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";
    const secondNotice = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        linkedMemberId: deceasedId,
        bodyEn: "Second announcement after clarification.",
      });
    expect(secondNotice.status).toBe(201);

    const allReqs = await ctx.db.archivalRequest.findMany({ where: { deceasedMemberId: deceasedId } });
    expect(allReqs.length).toBe(2);
    expect(allReqs.some((r) => r.status === "REFUTED")).toBe(true);
    expect(allReqs.some((r) => r.status === "OPEN")).toBe(true);
  });

  it("archival escalation: OPEN request past expiresAt escalates to ESCALATED", async () => {
    const ctx = createTestContext();
    const deceasedId = "018f4b7c-3a15-7f20-9f2c-0123456789dd";

    await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        linkedMemberId: deceasedId,
        bodyEn: "Announcement.",
      });

    // Advance clock past 7 days
    ctx.clock.advance(7 * 24 * 60 * 60 * 1000 + 1000);

    const escalatedCount = await ctx.service.escalateArchivals();
    expect(escalatedCount).toBe(1);

    const reqs = await ctx.db.archivalRequest.findMany({ where: { deceasedMemberId: deceasedId } });
    expect(reqs[0]?.status).toBe("ESCALATED");
  });

  it("business listing expires after 180 days and can be renewed", async () => {
    const ctx = createTestContext();

    const createRes = await request(ctx.app)
      .post("/v1/business-listings")
      .send({
        name: "Agrawal Textiles",
        category: "TEXTILES",
        businessCity: "Indore",
        businessPhone: "+919876543210",
        bodyEn: "Best fabrics.",
      });
    const listingId = responseBody<ListingResponseBody>(createRes).listing.id;

    // Payment captured -> ACTIVE for 180 days
    await ctx.service.onPaymentCaptured({
      id: crypto.randomUUID(),
      subjectId: listingId,
      purpose: "BUSINESS_LISTING",
    });

    let listing = await ctx.db.notice.findUnique({ where: { id: listingId } });
    expect(listing?.status).toBe("ACTIVE");

    // Advance clock past 180 days
    ctx.clock.advance(181 * 24 * 60 * 60 * 1000);

    // Run expireListings job
    await ctx.service.expireListings();

    listing = await ctx.db.notice.findUnique({ where: { id: listingId } });
    expect(listing?.status).toBe("EXPIRED");

    // Renew listing creates payment order
    const renewRes = await request(ctx.app)
      .post(`/v1/business-listings/${listingId}/renew`)
      .send({});
    expect(renewRes.status).toBe(201);
    expect(responseBody<AmountResponseBody>(renewRes).amount.amountPaise).toBe(4900);

    // On capture: extended by another 180 days from now
    await ctx.service.onPaymentCaptured({
      id: crypto.randomUUID(),
      subjectId: listingId,
      purpose: "BUSINESS_LISTING",
    });

    listing = await ctx.db.notice.findUnique({ where: { id: listingId } });
    expect(listing?.status).toBe("ACTIVE");
    expect(listing?.expiresAt?.getTime()).toBeGreaterThan(ctx.clock.now().getTime());
  });

  it("erasure: author erased -> Shok Sandesh text retained with former member; listings REMOVED; reports deleted; suspension lifted", async () => {
    const ctx = createTestContext();
    const authorId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";

    // Create Shok Sandesh
    const shokRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        title: "Historical Obituary",
        bodyEn: "Historical obituary text to be retained.",
      });
    const shokId = responseBody<NoticeResponseBody>(shokRes).notice.id;

    // Create Business Listing
    const bizRes = await request(ctx.app)
      .post("/v1/business-listings")
      .send({
        name: "My Shop",
        category: "GROCERY",
        businessCity: "Indore",
        businessPhone: "+919876543210",
      });
    const bizId = responseBody<ListingResponseBody>(bizRes).listing.id;

    // Create a suspension for author
    await ctx.db.suspension.create({
      data: {
        id: crypto.randomUUID(),
        memberId: authorId,
        reason: "REPORTS",
        activeNoticeId: null,
        startsAt: ctx.clock.now(),
        endsAt: new Date(ctx.clock.now().getTime() + 7 * 24 * 60 * 60 * 1000),
        liftedAt: null,
        liftedBy: null,
        liftedReason: null,
      },
    });

    // Create a report filed by author on another target
    await ctx.db.report.create({
      data: {
        id: crypto.randomUUID(),
        targetType: "NOTICE",
        targetId: crypto.randomUUID(),
        noticeId: null,
        reporterMemberId: authorId,
        reporterFamilyId: "fam-01",
        reason: "Inappropriate",
      },
    });

    // Execute erasure hook
    await ctx.db.$transaction(async (tx) => {
      await ctx.service.handleMemberErased(tx, authorId);
    });

    // 1. Shok Sandesh retained with author scrubbed
    const shokNotice = await ctx.db.notice.findUnique({ where: { id: shokId } });
    expect(shokNotice?.bodyEn).toBe("Historical obituary text to be retained.");
    expect(shokNotice?.authorMemberId).toBe("00000000-0000-0000-0000-000000000000");

    // Viewed via API, author is "A former member"
    ctx.activeViewerId = "018f4b7c-3a15-7f20-9f2c-0123456789bb";
    const viewRes = await request(ctx.app).get(`/v1/notices/${shokId}`);
    expect(responseBody<NoticeResponseBody>(viewRes).notice.author.name?.en).toBe("A former member");

    // 2. Business listing status REMOVED
    const bizNotice = await ctx.db.notice.findUnique({ where: { id: bizId } });
    expect(bizNotice?.status).toBe("REMOVED");

    // 3. Reports filed by author deleted
    const authorReports = await ctx.db.report.findMany({ where: { reporterMemberId: authorId } });
    expect(authorReports.length).toBe(0);

    // 4. Suspensions lifted
    const suspensions = await ctx.db.suspension.findMany({ where: { memberId: authorId } });
    expect(suspensions.every((s) => s.liftedAt !== null)).toBe(true);
  });

  it("posting cap: 3 notices on same IST day pass; 4th fails with 429 POSTING_CAP_REACHED", async () => {
    const ctx = createTestContext({ postingCapPerDay: 3 });

    for (let i = 1; i <= 3; i++) {
      const res = await request(ctx.app)
        .post("/v1/notices")
        .send({
          board: "SHOK_SANDESH",
          bodyEn: `Notice number ${String(i)}`,
        });
      expect(res.status).toBe(201);
    }

    const fourth = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        bodyEn: "Notice number 4 should fail cap",
      });

    expect(fourth.status).toBe(429);
    expect(responseBody<ErrorResponseBody>(fourth).error.code).toBe("POSTING_CAP_REACHED");
  });

  it("enforces the daily posting cap for concurrent Shok Sandesh submissions", async () => {
    const ctx = createTestContext({ postingCapPerDay: 2 });
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => request(ctx.app)
        .post("/v1/notices")
        .send({
          board: "SHOK_SANDESH",
          bodyEn: `Concurrent notice ${String(index)}`,
        })),
    );
    const successful = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status === 429);

    expect(successful).toHaveLength(2);
    expect(rejected).toHaveLength(4);
    expect(rejected.every(
      (response) => responseBody<ErrorResponseBody>(response).error.code === "POSTING_CAP_REACHED",
    )).toBe(true);
    await expect(ctx.db.notice.count({
      where: {
        authorMemberId: "018f4b7c-3a15-7f20-9f2c-0123456789aa",
        createdAt: {
          gte: new Date("2026-09-19T04:30:00.000Z"),
          lt: new Date("2026-09-20T04:30:00.000Z"),
        },
      },
    })).resolves.toBe(2);
  });

  it("keeps a Shok Sandesh and its archival request committed when notification enqueue fails", async () => {
    const ctx = createTestContext();
    const authorId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";
    const deceasedId = "018f4b7c-3a15-7f20-9f2c-0123456789dd";
    ctx.notificationsPort.send = () => Promise.reject(new Error("notification queue unavailable"));

    await expect(ctx.service.createNotice(
      { memberId: authorId },
      ShokSandeshBody.parse({
        board: "SHOK_SANDESH",
        linkedMemberId: deceasedId,
        bodyEn: "A family announcement.",
      }),
    )).rejects.toThrow("notification queue unavailable");

    const notices = await ctx.db.notice.findMany({ where: { linkedMemberId: deceasedId } });
    const archivalRequests = await ctx.db.archivalRequest.findMany({
      where: { deceasedMemberId: deceasedId },
    });
    expect(notices).toHaveLength(1);
    expect(archivalRequests).toHaveLength(1);
    expect(archivalRequests[0]?.status).toBe("OPEN");
  });

  it("Blood SOS report: no auto-hiding or suspension; appears in officer report queue", async () => {
    const ctx = createTestContext();
    const bloodSosId = crypto.randomUUID();

    // Member reports a Blood SOS
    const repRes = await ctx.service.reportBloodSos(
      { memberId: "018f4b7c-3a15-7f20-9f2c-0123456789aa" },
      bloodSosId,
      { reason: "Spam emergency request" },
    );
    expect(repRes.report.targetType).toBe("BLOOD_SOS");

    // Officer report port queries BLOOD_SOS reports
    const reportAdapter = createOfficerReportAdapter(ctx.service);
    const officerReports = await reportAdapter.list({ target: "BLOOD_SOS", limit: 20 });
    expect(officerReports.items.some((r) => r["targetId"] === bloodSosId)).toBe(true);

    // No suspensions created
    const suspensions = await ctx.db.suspension.findMany();
    expect(suspensions.length).toBe(0);
  });

  it("invariant 16: strict schema rejects contactPhone field in ShokSandeshBody", () => {
    // Parsing with contactPhone must fail validation
    const invalidInput = {
      board: "SHOK_SANDESH",
      bodyEn: "Obituary text",
      contactPhone: "+919876543210",
    };

    const parsed = ShokSandeshBody.safeParse(invalidInput);
    expect(parsed.success).toBe(false);
  });

  it("invariant 11: with screening off, photo URL returned for author only, null for others", async () => {
    const ctx = createTestContext();
    const authorId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";
    const imageId = ctx.ownImage(authorId, "SHOK_SANDESH_PHOTO");
    const otherViewerId = "018f4b7c-3a15-7f20-9f2c-0123456789bb";

    ctx.activeViewerId = authorId;
    const createRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        bodyEn: "Notice with photo",
        imageId,
      });
    const noticeId = responseBody<NoticeResponseBody>(createRes).notice.id;

    // Author gets presigned image URL
    ctx.activeViewerId = authorId;
    const authorGet = await request(ctx.app).get(`/v1/notices/${noticeId}`);
    expect(responseBody<NoticeResponseBody>(authorGet).notice.imageUrl).toBe(`https://media.example.com/${imageId}.jpg`);

    // Other viewer gets null image URL (screening is off)
    ctx.activeViewerId = otherViewerId;
    const otherGet = await request(ctx.app).get(`/v1/notices/${noticeId}`);
    expect(responseBody<NoticeResponseBody>(otherGet).notice.imageUrl).toBeNull();
  });

  it("refuses a Shok Sandesh image the author does not own", async () => {
    const ctx = createTestContext();
    const authorId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";
    const otherMemberId = "018f4b7c-3a15-7f20-9f2c-0123456789bb";
    const theirs = ctx.ownImage(otherMemberId, "SHOK_SANDESH_PHOTO");

    ctx.activeViewerId = authorId;
    const res = await request(ctx.app)
      .post("/v1/notices")
      .send({ board: "SHOK_SANDESH", bodyEn: "Notice with a borrowed photo", imageId: theirs });

    expect(res.status).toBe(422);
    expect(responseBody<ErrorResponseBody>(res).error.code).toBe("IMAGE_NOT_OWNED");
    await expect(ctx.db.notice.findMany()).resolves.toHaveLength(0);
  });

  it("refuses a Business Listing image the author does not own or uploaded for another purpose", async () => {
    const ctx = createTestContext();
    const authorId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";
    const otherMemberId = "018f4b7c-3a15-7f20-9f2c-0123456789bb";
    const listing = {
      name: "Agrawal Sweets",
      category: "GROCERY",
      businessCity: "Indore",
      businessPhone: "+919876543210",
    };

    ctx.activeViewerId = authorId;
    for (const imageId of [
      ctx.ownImage(otherMemberId, "BUSINESS_PHOTO"),
      ctx.ownImage(authorId, "SHOK_SANDESH_PHOTO"),
    ]) {
      const res = await request(ctx.app).post("/v1/business-listings").send({ ...listing, imageId });
      expect(res.status).toBe(422);
      expect(responseBody<ErrorResponseBody>(res).error.code).toBe("IMAGE_NOT_OWNED");
    }

    const own = await request(ctx.app)
      .post("/v1/business-listings")
      .send({ ...listing, imageId: ctx.ownImage(authorId, "BUSINESS_PHOTO") });
    expect(own.status).toBe(201);
  });

  it("invariant 12: with BUSINESS_LISTING_FEE_PAISE unset, all business listing routes fail 503 BOARD_NOT_OPEN", async () => {
    const ctx = createTestContext({ businessFeePaise: null });

    // 1. Create fails
    const createRes = await request(ctx.app)
      .post("/v1/business-listings")
      .send({
        name: "Shop",
        category: "CA",
        businessCity: "Indore",
        businessPhone: "+919876543210",
      });
    expect(createRes.status).toBe(503);
    expect(responseBody<ErrorResponseBody>(createRes).error.code).toBe("BOARD_NOT_OPEN");

    // 2. Browse fails
    const browseRes = await request(ctx.app).get("/v1/business-listings");
    expect(browseRes.status).toBe(503);
    expect(responseBody<ErrorResponseBody>(browseRes).error.code).toBe("BOARD_NOT_OPEN");

    // 3. Mine fails
    const mineRes = await request(ctx.app).get("/v1/business-listings/mine");
    expect(mineRes.status).toBe(503);
    expect(responseBody<ErrorResponseBody>(mineRes).error.code).toBe("BOARD_NOT_OPEN");
  });

  it("officer actions: suspension lifting with notice restoration and archival resolution", async () => {
    const ctx = createTestContext();
    const officerId = "officer-01";

    // 1. Suspension lifting + restore notice
    const notice = await ctx.db.notice.create({
      data: {
        id: crypto.randomUUID(),
        board: "SHOK_SANDESH",
        authorMemberId: "author-suspended",
        authorFamilyId: "fam-auth",
        status: "HIDDEN",
        bodyEn: "Hidden notice",
      },
    });
    const suspension = await ctx.db.suspension.create({
      data: {
        id: crypto.randomUUID(),
        memberId: "author-suspended",
        reason: "REPORTS",
        activeNoticeId: notice.id,
        startsAt: ctx.clock.now(),
        endsAt: new Date(ctx.clock.now().getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const suspAdapter = createOfficerSuspensionAdapter(ctx.service);
    await suspAdapter.lift({
      suspensionId: suspension.id,
      officerId,
      reason: "Appealed and approved by Officer",
      restoreNotice: true,
    });

    const updatedSusp = await ctx.db.suspension.findUnique({ where: { id: suspension.id } });
    expect(updatedSusp?.liftedAt).toBeDefined();
    expect(updatedSusp?.liftedBy).toBe(officerId);

    const updatedNotice = await ctx.db.notice.findUnique({ where: { id: notice.id } });
    expect(updatedNotice?.status).toBe("ACTIVE");

    // Check Processing Records
    expect(ctx.processingRecords.some((p) => p.action === "SUSPENSION_LIFTED")).toBe(true);
    expect(ctx.processingRecords.some((p) => p.action === "NOTICE_RESTORED")).toBe(true);

    // 2. Archival resolution by Officer
    const deceasedId = "018f4b7c-3a15-7f20-9f2c-0123456789dd";
    const archivalReq = await ctx.db.archivalRequest.create({
      data: {
        id: crypto.randomUUID(),
        deceasedMemberId: deceasedId,
        familyId: "fam-deceased",
        status: "ESCALATED",
        expiresAt: ctx.clock.now(),
      },
    });

    const archAdapter = createOfficerArchivalAdapter(ctx.service);
    await archAdapter.resolve({
      archivalRequestId: archivalReq.id,
      officerId,
      outcome: "CONFIRM",
      note: "Death certificate verified by Officer",
    });

    const resolvedReq = await ctx.db.archivalRequest.findUnique({ where: { id: archivalReq.id } });
    expect(resolvedReq?.status).toBe("CONFIRMED");
    expect(resolvedReq?.respondedBy).toBe(`OFFICER:${officerId}`);
    expect(ctx.members.get(deceasedId)?.status).toBe("ARCHIVED");
    expect(ctx.processingRecords.some((p) => p.action === "ARCHIVAL_RESOLVED_BY_OFFICER")).toBe(true);
  });

  it("acceptance: only one unresolved archival request exists per subject (database-enforced partial uniqueness)", async () => {
    const ctx = createTestContext();
    const deceasedId = "018f4b7c-3a15-7f20-9f2c-0123456789dd";

    // Create first in-flight (OPEN) request
    await ctx.db.archivalRequest.create({
      data: {
        id: crypto.randomUUID(),
        deceasedMemberId: deceasedId,
        familyId: "fam-deceased",
        status: "OPEN",
        expiresAt: ctx.clock.now(),
      },
    });

    // Attempting to create a second OPEN request for the same deceased member throws unique violation
    await expect(
      ctx.db.archivalRequest.create({
        data: {
          id: crypto.randomUUID(),
          deceasedMemberId: deceasedId,
          familyId: "fam-deceased",
          status: "OPEN",
          expiresAt: ctx.clock.now(),
        },
      }),
    ).rejects.toThrow(/Unique constraint failed on archival_request_one_open/);

    // Attempting to create an ESCALATED request for the same deceased member also throws
    await expect(
      ctx.db.archivalRequest.create({
        data: {
          id: crypto.randomUUID(),
          deceasedMemberId: deceasedId,
          familyId: "fam-deceased",
          status: "ESCALATED",
          expiresAt: ctx.clock.now(),
        },
      }),
    ).rejects.toThrow(/Unique constraint failed on archival_request_one_open/);
  });

  it("acceptance: officer resolution on already resolved request fails with 409", async () => {
    const ctx = createTestContext();
    const deceasedId = "018f4b7c-3a15-7f20-9f2c-0123456789dd";
    const officerId = "officer-01";

    const archivalReq = await ctx.db.archivalRequest.create({
      data: {
        id: crypto.randomUUID(),
        deceasedMemberId: deceasedId,
        familyId: "fam-deceased",
        status: "ESCALATED",
        expiresAt: ctx.clock.now(),
      },
    });

    const archAdapter = createOfficerArchivalAdapter(ctx.service);
    await archAdapter.resolve({
      archivalRequestId: archivalReq.id,
      officerId,
      outcome: "CONFIRM",
      note: "Confirmed by Officer",
    });

    // Second resolution must fail with 409 ARCHIVAL_REQUEST_ALREADY_RESOLVED
    await expect(
      archAdapter.resolve({
        archivalRequestId: archivalReq.id,
        officerId,
        outcome: "REFUTE",
        note: "Trying to resolve already resolved request",
      }),
    ).rejects.toThrow(/ARCHIVAL_REQUEST_ALREADY_RESOLVED/);
  });

  it("acceptance: suspended author cannot create business listings", async () => {
    const ctx = createTestContext();
    const authorId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";

    // Suspend author
    await ctx.db.suspension.create({
      data: {
        id: crypto.randomUUID(),
        memberId: authorId,
        reason: "REPORTS",
        activeNoticeId: null,
        startsAt: ctx.clock.now(),
        endsAt: new Date(ctx.clock.now().getTime() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    ctx.activeViewerId = authorId;
    const res = await request(ctx.app)
      .post("/v1/business-listings")
      .send({
        name: "Suspended Listing",
        category: "LEGAL",
        businessCity: "Indore",
        businessPhone: "+919876543210",
      });

    expect(res.status).toBe(403);
    expect(responseBody<ErrorResponseBody>(res).error.code).toBe("POSTING_SUSPENDED");
  });

  it("officer suspension pages continue after the cursor row instead of repeating it", async () => {
    const ctx = createTestContext();
    const startsAt = ctx.clock.now().getTime();
    for (let index = 0; index < 3; index += 1) {
      await ctx.db.suspension.create({
        data: {
          id: crypto.randomUUID(),
          memberId: `member-${String(index)}`,
          reason: "REPORTS",
          activeNoticeId: null,
          startsAt: new Date(startsAt - index * 60_000),
          endsAt: new Date(startsAt + 7 * 24 * 60 * 60 * 1000),
        },
      });
    }

    const first = await ctx.service.listSuspensionsForOfficer({ active: true, limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    const second = await ctx.service.listSuspensionsForOfficer({
      active: true,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });

    const ids = [...first.items, ...second.items].map((row) => row.memberId);
    expect(ids).toEqual(["member-0", "member-1", "member-2"]);
    expect(second.nextCursor).toBeNull();
  });

  it("acceptance: audience filters never leak author personal phone number", async () => {
    const ctx = createTestContext();
    const authorId = "018f4b7c-3a15-7f20-9f2c-0123456789aa";
    const viewerId = "018f4b7c-3a15-7f20-9f2c-0123456789bb";

    // Author creates notice
    ctx.activeViewerId = authorId;
    const createRes = await request(ctx.app)
      .post("/v1/notices")
      .send({
        board: "SHOK_SANDESH",
        bodyEn: "Announcement for the community.",
      });
    const noticeId = responseBody<NoticeResponseBody>(createRes).notice.id;

    // Different member views notice
    ctx.activeViewerId = viewerId;
    const getRes = await request(ctx.app).get(`/v1/notices/${noticeId}`);
    expect(getRes.status).toBe(200);

    const authorObj = responseBody<NoticeResponseBody>(getRes).notice.author;
    expect(authorObj).toBeDefined();
    // Personal phone is NEVER present on SAMAJ projection
    expect((authorObj as Record<string, unknown>).phoneE164).toBeUndefined();
    expect(JSON.stringify(responseBody<unknown>(getRes))).not.toContain("+919876543210");
  });
});
