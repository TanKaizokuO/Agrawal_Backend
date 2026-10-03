import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import type { JobRuntime } from "../../jobs.js";
import type { PaymentView } from "../payments/index.js";
import { IdentityService } from "../identity/index.js";
import { RegisterService } from "../register/index.js";
import {
  createRegistrationWorkers,
  REGISTRATION_JOB_NAMES,
  RegistrationService,
  type RegistrationDeps,
  type RegistrationTx,
} from "./index.js";
import { SubmitBody, type SubmitInput } from "./schemas.js";
import { getTestDatabase } from "../../../test/setup.js";

// completed_member_id is a uuid column, so member fixtures must be UUIDs.
const HEAD_ID = "018f4b7c-3a15-7f20-9f2c-000000000001";
const OTHER_HEAD_ID = "018f4b7c-3a15-7f20-9f2c-000000000002";
const FOUNDER_ID = "018f4b7c-3a15-7f20-9f2c-000000000003";
const JOINER_ID = "018f4b7c-3a15-7f20-9f2c-000000000004";

const clock = {
  now: () => new Date("2026-09-22T12:00:00.000Z"),
  todayIst: () => "2026-09-22",
};

const jobs: JobRuntime = {
  enabled: false,
  start: () => Promise.resolve(),
  stop: () => Promise.resolve(),
  isReady: () => Promise.resolve(true),
  send: () => Promise.resolve(null),
  registerWorker: () => Promise.resolve(),
};

function profile(route: "INDIVIDUAL" | "CREATE" | "JOIN"): SubmitInput {
  return {
    route,
    ...(route === "JOIN" ? { familyPublicId: "AGR-492001-00001" } : { gotra: "GARG" }),
    uiLanguage: "en",
    typingScript: "en",
    name: { en: "Rakesh Agrawal" },
    nameEnConfirmed: true,
    fatherOrHusbandName: { en: "Mohan Agrawal" },
    gender: "MALE",
    dateOfBirth: "1990-01-01",
    bloodGroup: "A_POS",
    address: {
      line1: "1 Samaj Marg",
      city: "Hisar",
      state: "HARYANA",
      pincode: "492001",
    },
    nativePlace: { kind: "UNKNOWN" },
    consents: {
      directoryListing: true,
      bloodGroupMatching: true,
      photoVisible: false,
    },
    paymentRetentionDisclosureAcknowledged: true,
  };
}

function capturedPayment(paymentId: string): PaymentView {
  return {
    paymentId,
    purpose: "REGISTRATION",
    status: "CAPTURED",
    amountPaise: 100,
    currency: "INR",
    method: "upi",
    capturedAt: clock.now(),
    refund: null,
  };
}

function createPersistentRegister(db: RegistrationDeps["db"]): RegisterService {
  return new RegisterService({
    db,
    clock,
    config: {
      retentionDaysPayments: 2920,
      retentionDaysConsentAndLogs: 365,
      mediaUrlTtlSeconds: 3600,
      erasureSelfServiceEnabled: false,
    },
    pincodeDirectory: { lookup: () => Promise.resolve(null) },
    objectStore: {
      put: () => Promise.resolve(),
      presignGet: () => Promise.resolve(""),
      delete: () => Promise.resolve(),
    },
    jobs,
    payments: {
      moveToRestricted: () => Promise.resolve(),
      releaseHeadAnchor: () => Promise.resolve(),
    },
    suspensionResolver: { resolveActiveSuspension: () => Promise.resolve(null) },
  });
}

function createPersistentIdentity(
  db: RegistrationDeps["db"],
  register: RegisterService,
): IdentityService {
  return new IdentityService({
    db,
    smsSender: { sendOtp: () => Promise.resolve() },
    registration: { openForPhone: () => Promise.resolve({ registrationId: uuidv7() }) },
    register,
    clock,
    config: {
      sessionTtlWebDays: 30,
      sessionTtlMobileDays: 90,
      otpHmacKey: Buffer.alloc(32, 1).toString("base64"),
    },
    processingRecord: { write: () => Promise.resolve() },
  });
}

async function createApplicantSession(
  db: RegistrationDeps["db"],
  registrationId: string,
  phoneE164: string,
): Promise<string> {
  const id = uuidv7();
  await db.session.create({
    data: {
      id,
      tokenHash: `token-${uuidv7()}`,
      client: "MOBILE",
      phoneE164,
      registrationId,
      createdAt: clock.now(),
      lastSeenAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + 90 * 24 * 60 * 60 * 1000),
    },
  });
  return id;
}

async function createCapturedPayment(
  db: RegistrationDeps["db"],
  payment: Map<string, PaymentView>,
  registrationId: string,
  phoneE164: string,
): Promise<string> {
  const paymentId = uuidv7();
  await db.payment.create({
    data: {
      id: paymentId,
      purpose: "REGISTRATION",
      subjectId: registrationId,
      payerPhoneE164: phoneE164,
      amountPaise: 100,
      status: "CAPTURED",
      razorpayOrderId: `order-${paymentId}`,
      razorpayPaymentId: `provider-${paymentId}`,
      method: "upi",
      capturedAt: clock.now(),
    },
  });
  payment.set(paymentId, capturedPayment(paymentId));
  return paymentId;
}

function harness(options: {
  readonly registrationPaymentRequired?: boolean;
  readonly persistMembers?: boolean;
} = {}) {
  const db = getTestDatabase();
  const payment = new Map<string, PaymentView>();
  const refunds: string[] = [];
  const flags: string[] = [];
  const detailedFlags: Array<{ kind: string; subjectType: string; subjectId: string; relatedIds?: readonly string[] }> = [];
  let familyCreations = 0;
  let memberCreations = 0;
  let promotions = 0;
  const paymentCalls: string[] = [];
  const persistentRegister = options.persistMembers ? createPersistentRegister(db) : null;
  const family = {
    familyId: "family-1",
    publicId: "AGR-492001-00001",
    gotra: "GARG" as const,
    headMemberId: HEAD_ID,
  };

  const registerStub = {
    createFamilyWithHead: (): Promise<{ familyId: string; memberId: string }> => {
      familyCreations += 1;
      memberCreations += 1;
      return Promise.resolve({ familyId: family.familyId, memberId: FOUNDER_ID });
    },
    createMemberInFamily: (): Promise<{ memberId: string }> => {
      memberCreations += 1;
      return Promise.resolve({ memberId: JOINER_ID });
    },
    onFamilyGainedMember: () => Promise.resolve(),
    familyByPublicId: (publicId: string) =>
      Promise.resolve(publicId === family.publicId ? { id: family.familyId, gotra: family.gotra, status: "ACTIVE" } : null),
    familyOf: (memberId: string) => {
      if (memberId === OTHER_HEAD_ID) {
        return Promise.resolve({ familyId: "family-2", publicId: "AGR-492001-00002", gotra: "GARG" as const, headMemberId: OTHER_HEAD_ID });
      }
      if (memberId === HEAD_ID || memberId === FOUNDER_ID || memberId === JOINER_ID) return Promise.resolve(family);
      return Promise.resolve(null);
    },
    findPossibleDuplicates: () => Promise.resolve({ samePerson: [], sharedAddressHeads: [] }),
  } satisfies RegistrationDeps["register"];
  const register: RegistrationDeps["register"] = persistentRegister ?? registerStub;

  const payments = {
    createOrder: () => {
      paymentCalls.push("createOrder");
      return Promise.resolve({
        paymentId: "payment-order",
        razorpayOrderId: "order-1",
        keyId: "key",
        amountPaise: 100,
        currency: "INR" as const,
        prefill: { contact: "+919876543210" },
        alreadyPaid: false,
      });
    },
    getView: (paymentId: string) => {
      paymentCalls.push("getView");
      return Promise.resolve(payment.get(paymentId) ?? capturedPayment(paymentId));
    },
    getForSubject: () => {
      paymentCalls.push("getForSubject");
      return Promise.resolve(null);
    },
    identityOf: () => {
      paymentCalls.push("identityOf");
      return Promise.resolve({ kind: "NONE" as const, hash: null, masked: null });
    },
    findHeadAnchor: () => {
      paymentCalls.push("findHeadAnchor");
      return Promise.resolve(null);
    },
    createHeadAnchor: () => {
      paymentCalls.push("createHeadAnchor");
      return Promise.resolve();
    },
    markConsumed: async (tx: RegistrationTx, paymentId: string) => {
      paymentCalls.push("markConsumed");
      await tx.payment.updateMany({
        where: { id: paymentId, consumedAt: null },
        data: { consumedAt: clock.now() },
      });
    },
    refund: (...args: [RegistrationTx, string]): Promise<void> => {
      paymentCalls.push("refund");
      const paymentId = args[1];
      refunds.push(paymentId);
      payment.set(paymentId, { ...(payment.get(paymentId) ?? capturedPayment(paymentId)), status: "REFUND_PENDING" });
      return Promise.resolve();
    },
  } satisfies RegistrationDeps["payments"];

  const identityStub = {
    promoteToMember: (): Promise<void> => {
      promotions += 1;
      return Promise.resolve();
    },
  } satisfies RegistrationDeps["identity"];
  const identity: RegistrationDeps["identity"] = persistentRegister === null
    ? identityStub
    : createPersistentIdentity(db, persistentRegister);
  const officer = {
    raiseFlag: (...args: [RegistrationTx, { readonly kind: string; readonly subjectType: string; readonly subjectId: string; readonly relatedIds?: readonly string[] }]): Promise<void> => {
      const input = args[1];
      flags.push(input.kind);
      detailedFlags.push(input);
      return Promise.resolve();
    },
  } satisfies RegistrationDeps["officer"];
  const createService = (
    registrationPaymentRequired = options.registrationPaymentRequired ?? true,
  ): RegistrationService => new RegistrationService({
    db,
    clock,
    config: {
      registrationPaymentPaise: 100,
      registrationPaymentRequired,
      registrationAbandonAfterHours: 24,
      joinRequestExpiryDays: 14,
      joinRequestsPendingMaxPerFamily: 10,
    },
    register,
    payments,
    identity,
    officer,
    jobs,
    media: {
      reassign: (): Promise<void> => Promise.resolve(),
      deleteOwnedByRegistration: (): Promise<void> => Promise.resolve(),
    },
    romanizer: {
      romanize: (text: string): Promise<string> => Promise.resolve(text),
    },
  });
  const service = createService();

  async function createRegistration(phoneE164: string, status: "STARTED" | "PAID", paymentId?: string): Promise<string> {
    const id = uuidv7();
    await db.registration.create({
      data: {
        id,
        phoneE164,
        status,
        paymentId: paymentId ?? null,
        lastActivityAt: clock.now(),
        createdAt: clock.now(),
      },
    });
    return id;
  }

  async function openForPhone(phoneE164: string): Promise<string> {
    return db.$transaction(async (tx) => {
      const opened = await service.openForPhone(tx, phoneE164);
      return opened.registrationId;
    });
  }

  return {
    db,
    service,
    payment,
    refunds,
    flags,
    detailedFlags,
    paymentCalls,
    createService,
    createRegistration,
    get familyCreations() { return familyCreations; },
    get memberCreations() { return memberCreations; },
    get promotions() { return promotions; },
    openForPhone,
  };
}

describe("Registration public behavior", () => {
  it("creates one founding Family/Member and replays without duplicates", async () => {
    const h = harness();
    const registrationId = await h.createRegistration("+919876543210", "PAID", "payment-1");
    h.payment.set("payment-1", capturedPayment("payment-1"));

    const first = await h.service.submit(registrationId, "+919876543210", profile("CREATE"));
    const replay = await h.service.submit(registrationId, "+919876543210", profile("CREATE"));

    expect(first.status).toBe("COMPLETED");
    expect(replay.status).toBe("COMPLETED");
    expect(h.familyCreations).toBe(1);
    expect(h.memberCreations).toBe(1);
    expect(h.promotions).toBe(1);
    expect(h.flags).toContain("NO_PAYMENT_IDENTITY");
    expect(h.detailedFlags).toContainEqual({
      kind: "NO_PAYMENT_IDENTITY",
      subjectType: "MEMBER",
      subjectId: FOUNDER_ID,
    });
  });

  it("rejects an unpaid STARTED Registration while payment is required", async () => {
    const h = harness({ persistMembers: true });
    const phoneE164 = "+919876543250";
    const registrationId = await h.createRegistration(phoneE164, "STARTED");

    await expect(h.service.submit(registrationId, phoneE164, profile("CREATE")))
      .rejects.toMatchObject({ code: "REGISTRATION_NOT_PAID", httpStatus: 409 });

    expect(await h.db.member.count({ where: { phoneE164 } })).toBe(0);
    expect(await h.db.family.count()).toBe(0);
    expect(h.paymentCalls).toEqual([]);
  });

  it("creates a real unpaid pilot founder and promotes the Applicant session without payment calls", async () => {
    const h = harness({ registrationPaymentRequired: false, persistMembers: true });
    const phoneE164 = "+919876543251";
    const registrationId = await h.createRegistration(phoneE164, "STARTED");
    const sessionId = await createApplicantSession(h.db, registrationId, phoneE164);

    await expect(h.service.createPaymentOrder(registrationId, phoneE164))
      .rejects.toMatchObject({ code: "REGISTRATION_WRONG_STATE", httpStatus: 409 });
    const result = await h.service.submit(registrationId, phoneE164, profile("CREATE"));

    if (result.status !== "COMPLETED") throw new Error("Founding Registration did not complete");
    const member = await h.db.member.findUniqueOrThrow({ where: { id: result.memberId } });
    const family = await h.db.family.findUniqueOrThrow({ where: { publicId: result.family.publicId } });
    const familyLink = await h.db.familyLink.findUniqueOrThrow({ where: { memberId: member.id } });
    const session = await h.db.session.findUniqueOrThrow({ where: { id: sessionId } });

    expect(member).toMatchObject({ phoneE164, status: "ACTIVE" });
    expect(family).toMatchObject({ headMemberId: member.id, gotra: "GARG", status: "ACTIVE" });
    expect(familyLink.familyId).toBe(family.id);
    expect(session).toMatchObject({ memberId: member.id, registrationId: null });
    expect(await h.db.registration.findUniqueOrThrow({ where: { id: registrationId } }))
      .toMatchObject({ status: "COMPLETED", paymentId: null, completedMemberId: member.id });
    await expect(h.service.getCurrent(registrationId, phoneE164))
      .resolves.toMatchObject({
        status: "COMPLETED",
        paymentRequired: false,
        paymentDeferred: true,
        payment: null,
        completedMemberId: member.id,
      });
    expect(await h.db.payment.count({ where: { subjectId: registrationId } })).toBe(0);
    expect(h.paymentCalls).toEqual([]);
    expect(h.flags).toContain("NO_PAYMENT_IDENTITY");
  });

  it("restores and approves a no-payment JOIN after payment becomes required again", async () => {
    const h = harness({ registrationPaymentRequired: false, persistMembers: true });
    const headPhone = "+919876543252";
    const headRegistrationId = await h.createRegistration(headPhone, "STARTED");
    const headPaymentId = await createCapturedPayment(h.db, h.payment, headRegistrationId, headPhone);
    await h.service.onRegistrationPaymentCaptured(headPaymentId, headRegistrationId);
    const head = await h.service.submit(headRegistrationId, headPhone, profile("CREATE"));
    if (head.status !== "COMPLETED") throw new Error("Family Head Registration did not complete");

    const joinerPhone = "+919876543253";
    const joinerRegistrationId = await h.createRegistration(joinerPhone, "STARTED");
    const sessionId = await createApplicantSession(h.db, joinerRegistrationId, joinerPhone);
    const paymentCallsBeforeJoin = [...h.paymentCalls];
    const pending = await h.service.submit(joinerRegistrationId, joinerPhone, profile("JOIN"));

    expect(pending.status).toBe("AWAITING_HEAD");
    expect(await h.db.member.count({ where: { phoneE164: joinerPhone } })).toBe(0);
    expect(await h.db.registration.findUniqueOrThrow({ where: { id: joinerRegistrationId } }))
      .toMatchObject({ status: "AWAITING_HEAD", paymentId: null, route: "JOIN" });
    await expect(h.service.getCurrent(joinerRegistrationId, joinerPhone))
      .resolves.toMatchObject({ paymentRequired: false, paymentDeferred: true, payment: null });
    expect(h.paymentCalls).toEqual(paymentCallsBeforeJoin);

    const paymentRequiredService = h.createService(true);
    await expect(paymentRequiredService.getCurrent(joinerRegistrationId, joinerPhone))
      .resolves.toMatchObject({ paymentRequired: true, paymentDeferred: true, payment: null });
    const newApplicantPhone = "+919876543254";
    const newApplicantRegistration = await h.createRegistration(newApplicantPhone, "STARTED");
    await expect(paymentRequiredService.submit(newApplicantRegistration, newApplicantPhone, profile("CREATE")))
      .rejects.toMatchObject({ code: "REGISTRATION_NOT_PAID", httpStatus: 409 });
    expect(await h.db.member.count({ where: { phoneE164: newApplicantPhone } })).toBe(0);
    const approved = await paymentRequiredService.approveJoin(joinerRegistrationId, head.memberId);
    const joiner = await h.db.member.findUniqueOrThrow({ where: { phoneE164: joinerPhone } });
    const headFamily = await h.db.family.findUniqueOrThrow({ where: { publicId: head.family.publicId } });
    const joinerLink = await h.db.familyLink.findUniqueOrThrow({ where: { memberId: joiner.id } });
    const session = await h.db.session.findUniqueOrThrow({ where: { id: sessionId } });

    expect(approved.status).toBe("COMPLETED");
    expect(joinerLink.familyId).toBe(headFamily.id);
    expect(await h.db.registration.findUniqueOrThrow({ where: { id: joinerRegistrationId } }))
      .toMatchObject({
        status: "COMPLETED",
        paymentId: null,
        completedMemberId: joiner.id,
        submittedProfile: null,
      });
    expect(session).toMatchObject({ memberId: joiner.id, registrationId: null });
    await expect(paymentRequiredService.getCurrent(joinerRegistrationId, joinerPhone))
      .resolves.toMatchObject({ paymentRequired: true, paymentDeferred: true, payment: null });
    expect(await h.db.payment.count({ where: { subjectId: joinerRegistrationId } })).toBe(0);
    expect(h.paymentCalls).toEqual(paymentCallsBeforeJoin);
  });

  it("does not extend the pilot exception to terminal registrations or uncaptured payments", async () => {
    const h = harness({ registrationPaymentRequired: false, persistMembers: true });
    const cancelledPhone = "+919876543255";
    const cancelledId = await h.createRegistration(cancelledPhone, "STARTED");
    await h.service.cancel(cancelledId, cancelledPhone);
    await expect(h.service.submit(cancelledId, cancelledPhone, profile("CREATE")))
      .rejects.toMatchObject({ code: "REGISTRATION_NOT_PAID", httpStatus: 409 });

    for (const [phoneE164, status] of [
      ["+919876543256", "FAILED"],
      ["+919876543257", "REFUNDED"],
    ] as const) {
      const paymentId = `payment-${status.toLowerCase()}`;
      const registrationId = await h.createRegistration(phoneE164, "PAID", paymentId);
      h.payment.set(paymentId, { ...capturedPayment(paymentId), status });
      await expect(h.service.submit(registrationId, phoneE164, profile("CREATE")))
        .rejects.toMatchObject({ code: "REGISTRATION_NOT_PAID", httpStatus: 409 });
    }

    const startedWithPaymentPhone = "+919876543258";
    const startedWithPaymentId = await h.createRegistration(
      startedWithPaymentPhone,
      "STARTED",
      "payment-not-captured",
    );
    await expect(h.service.submit(startedWithPaymentId, startedWithPaymentPhone, profile("CREATE")))
      .rejects.toMatchObject({ code: "REGISTRATION_NOT_PAID", httpStatus: 409 });
    expect(await h.db.family.count()).toBe(0);
  });

  it("does not request refunds when unpaid pilot JOIN requests are cancelled or declined", async () => {
    const h = harness({ registrationPaymentRequired: false });
    const cancelledPhone = "+919876543259";
    const cancelledId = await h.createRegistration(cancelledPhone, "STARTED");
    const cancelledPending = await h.service.submit(cancelledId, cancelledPhone, profile("JOIN"));
    expect(cancelledPending.status).toBe("AWAITING_HEAD");
    await expect(h.service.cancel(cancelledId, cancelledPhone)).resolves.toEqual({ status: "CANCELLED" });

    const declinedPhone = "+919876543260";
    const declinedId = await h.createRegistration(declinedPhone, "STARTED");
    const declinedPending = await h.service.submit(declinedId, declinedPhone, profile("JOIN"));
    expect(declinedPending.status).toBe("AWAITING_HEAD");
    await expect(h.service.declineJoin(declinedId, HEAD_ID, {})).resolves.toEqual({ status: "DECLINED" });

    expect(h.paymentCalls).toEqual([]);
    expect(h.refunds).toEqual([]);
  });


  it("consumes a refunded Registration payment through its purpose worker", async () => {
    const h = harness();
    const paymentId = uuidv7();
    const registrationId = await h.createRegistration("+919876543212", "PAID", paymentId);
    await h.db.payment.create({
      data: {
        id: paymentId,
        purpose: "REGISTRATION",
        subjectId: registrationId,
        payerPhoneE164: "+919876543212",
        amountPaise: 100,
        status: "REFUNDED",
        razorpayOrderId: `order-${paymentId}`,
      },
    });

    const refundWorker = createRegistrationWorkers(h.service)
      .find((worker) => worker.name === REGISTRATION_JOB_NAMES.paymentRefunded);
    if (refundWorker === undefined) throw new Error("Registration refund worker is missing");
    await refundWorker.handler({ paymentId, subjectId: registrationId });

    await expect(h.db.payment.findUniqueOrThrow({ where: { id: paymentId } }))
      .resolves.toMatchObject({ consumedAt: clock.now() });
  });
  it("moves to PAID only from authoritative capture and refunds a late capture once", async () => {
    const h = harness();
    const registrationId = await h.createRegistration("+919876543211", "STARTED");
    h.payment.set("payment-2", capturedPayment("payment-2"));

    await h.service.onRegistrationPaymentCaptured("payment-2", registrationId);
    await h.service.onRegistrationPaymentCaptured("payment-2", registrationId);
    expect((await h.db.registration.findUnique({ where: { id: registrationId } }))?.status).toBe("PAID");

    const abandonedId = await h.createRegistration("+919876543212", "STARTED");
    await h.service.cancel(abandonedId, "+919876543212");
    await h.service.onRegistrationPaymentCaptured("payment-3", abandonedId);
    await h.service.onRegistrationPaymentCaptured("payment-3", abandonedId);
    expect(h.refunds).toEqual(["payment-3"]);
  });

  it("reuses a started registration on repeat sign-in and refreshes its activity", async () => {
    const h = harness();
    const phoneE164 = "+919876543212";
    const registrationId = await h.createRegistration(phoneE164, "STARTED");
    await h.db.registration.update({
      where: { id: registrationId },
      data: { lastActivityAt: new Date(clock.now().getTime() - 25 * 60 * 60 * 1000) },
    });

    const reopenedId = await h.openForPhone(phoneE164);

    expect(reopenedId).toBe(registrationId);
    expect(await h.db.registration.findUnique({ where: { id: registrationId } })).toMatchObject({
      id: registrationId,
      status: "STARTED",
      phoneE164,
      lastActivityAt: clock.now(),
    });
    expect(h.refunds).toEqual([]);

    await h.service.abandonIdle();

    expect((await h.db.registration.findUnique({ where: { id: registrationId } }))?.status).toBe("STARTED");
    expect(h.refunds).toEqual([]);
  });

  it("starts a fresh registration after an unpaid registration was already cancelled", async () => {
    const h = harness();
    const phoneE164 = "+919876543212";
    const cancelledId = await h.createRegistration(phoneE164, "STARTED");
    await h.service.cancel(cancelledId, phoneE164);

    const reopenedId = await h.openForPhone(phoneE164);

    expect(reopenedId).not.toBe(cancelledId);
    expect(await h.db.registration.findUnique({ where: { id: cancelledId } })).toMatchObject({
      status: "ABANDONED",
      endReason: "APPLICANT_CANCELLED",
    });
    expect(await h.db.registration.findUnique({ where: { id: reopenedId } })).toMatchObject({
      status: "STARTED",
      phoneE164,
    });
    expect(h.refunds).toEqual([]);
  });

  it("preserves a paid registration on repeat sign-in and does not refund it as idle", async () => {
    const h = harness();
    const phoneE164 = "+919876543212";
    const paymentId = "payment-repeat-sign-in";
    const registrationId = await h.createRegistration(phoneE164, "PAID", paymentId);
    h.payment.set(paymentId, capturedPayment(paymentId));
    await h.db.registration.update({
      where: { id: registrationId },
      data: { lastActivityAt: new Date(clock.now().getTime() - 25 * 60 * 60 * 1000) },
    });

    const reopenedId = await h.openForPhone(phoneE164);

    expect(reopenedId).toBe(registrationId);
    expect(await h.db.registration.findUnique({ where: { id: registrationId } })).toMatchObject({
      id: registrationId,
      status: "PAID",
      paymentId,
      lastActivityAt: clock.now(),
    });
    expect(h.refunds).toEqual([]);

    await h.service.abandonIdle();

    expect(await h.db.registration.findUnique({ where: { id: registrationId } })).toMatchObject({
      status: "PAID",
      paymentId,
    });
    expect(h.refunds).toEqual([]);
  });

  it("keeps a joiner out of the register until the receiving Head approves", async () => {
    const h = harness();
    const registrationId = await h.createRegistration("+919876543213", "PAID", "payment-4");
    h.payment.set("payment-4", capturedPayment("payment-4"));

    const pending = await h.service.submit(registrationId, "+919876543213", profile("JOIN"));
    expect(pending.status).toBe("AWAITING_HEAD");
    expect(h.memberCreations).toBe(0);

    await expect(h.service.approveJoin(registrationId, "not-head")).rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    await expect(h.service.approveJoin(registrationId, OTHER_HEAD_ID)).rejects.toMatchObject({ code: "REGISTRATION_NOT_FOUND", httpStatus: 404 });
    const completed = await h.service.approveJoin(registrationId, HEAD_ID);

    expect(completed.status).toBe("COMPLETED");
    expect(h.memberCreations).toBe(1);
    expect(h.promotions).toBe(1);
  });

  it("serializes concurrent founding submissions through the Registration lock", async () => {
    const h = harness();
    const registrationId = await h.createRegistration("+919876543214", "PAID", "payment-5");
    h.payment.set("payment-5", capturedPayment("payment-5"));

    const results = await Promise.all([
      h.service.submit(registrationId, "+919876543214", profile("INDIVIDUAL")),
      h.service.submit(registrationId, "+919876543214", profile("INDIVIDUAL")),
    ]);

    expect(results.every((result) => result.status === "COMPLETED")).toBe(true);
    expect(h.familyCreations).toBe(1);
    expect(h.memberCreations).toBe(1);
  });

  it("forbids gotra and familyPhotoImageId on JOIN and throws 400 VALIDATION_FAILED on invalid join payload", async () => {
    const h = harness();
    const registrationId = await h.createRegistration("+919876543215", "PAID", "payment-6");
    h.payment.set("payment-6", capturedPayment("payment-6"));

    // Schema validation checks
    const joinWithGotra = {
      ...profile("JOIN"),
      gotra: "GARG",
    };
    expect(SubmitBody.safeParse(joinWithGotra).success).toBe(false);

    const joinWithPhoto = {
      ...profile("JOIN"),
      familyPhotoImageId: "018f4b7c-3a15-7f20-9f2c-0123456789aa",
    };
    expect(SubmitBody.safeParse(joinWithPhoto).success).toBe(false);

    // Service validation check
    await expect(
      h.service.submit(registrationId, "+919876543215", joinWithPhoto as SubmitInput),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      httpStatus: 400,
      details: { issues: [expect.objectContaining({ path: ["familyPhotoImageId"] })] },
    });
  });
});
