import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import type { JobRuntime } from "../../jobs.js";
import type { PaymentView } from "../payments/index.js";
import { RegistrationService, type RegistrationDeps, type RegistrationTx } from "./index.js";
import { SubmitBody, type SubmitInput } from "./schemas.js";
import { getTestDatabase } from "../../../test/setup.js";

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

function harness() {
  const db = getTestDatabase();
  const payment = new Map<string, PaymentView>();
  const refunds: string[] = [];
  const flags: string[] = [];
  const detailedFlags: Array<{ kind: string; subjectType: string; subjectId: string; relatedIds?: readonly string[] }> = [];
  let familyCreations = 0;
  let memberCreations = 0;
  let promotions = 0;
  const family = {
    familyId: "family-1",
    publicId: "AGR-492001-00001",
    gotra: "GARG" as const,
    headMemberId: "head-1",
  };

  const register = {
    createFamilyWithHead: (): Promise<{ familyId: string; memberId: string }> => {
      familyCreations += 1;
      memberCreations += 1;
      return Promise.resolve({ familyId: family.familyId, memberId: "member-1" });
    },
    createMemberInFamily: (): Promise<{ memberId: string }> => {
      memberCreations += 1;
      return Promise.resolve({ memberId: "member-2" });
    },
    onFamilyGainedMember: () => Promise.resolve(),
    familyByPublicId: (publicId: string) =>
      Promise.resolve(publicId === family.publicId ? { id: family.familyId, gotra: family.gotra, status: "ACTIVE" } : null),
    familyOf: (memberId: string) => {
      if (memberId === "other-head") {
        return Promise.resolve({ familyId: "family-2", publicId: "AGR-492001-00002", gotra: "GARG" as const, headMemberId: "other-head" });
      }
      if (memberId === "head-1" || memberId === "member-1" || memberId === "member-2") return Promise.resolve(family);
      return Promise.resolve(null);
    },
    findPossibleDuplicates: () => Promise.resolve({ samePerson: [], sharedAddressHeads: [] }),
  } satisfies RegistrationDeps["register"];

  const payments = {
    createOrder: () => Promise.resolve({
      paymentId: "payment-order",
      razorpayOrderId: "order-1",
      keyId: "key",
      amountPaise: 100,
      currency: "INR" as const,
      prefill: { contact: "+919876543210" },
      alreadyPaid: false,
    }),
    getView: (paymentId: string) => Promise.resolve(payment.get(paymentId) ?? capturedPayment(paymentId)),
    getForSubject: () => Promise.resolve(null),
    identityOf: () => Promise.resolve({ kind: "NONE" as const, hash: null, masked: null }),
    findHeadAnchor: () => Promise.resolve(null),
    createHeadAnchor: () => Promise.resolve(),
    markConsumed: () => Promise.resolve(),
    refund: (...args: [RegistrationTx, string]): Promise<void> => {
      const paymentId = args[1];
      refunds.push(paymentId);
      return Promise.resolve();
    },
  } satisfies RegistrationDeps["payments"];

  const identity = {
    promoteToMember: (): Promise<void> => {
      promotions += 1;
      return Promise.resolve();
    },
  } satisfies RegistrationDeps["identity"];
  const officer = {
    raiseFlag: (...args: [RegistrationTx, { readonly kind: string; readonly subjectType: string; readonly subjectId: string; readonly relatedIds?: readonly string[] }]): Promise<void> => {
      const input = args[1];
      flags.push(input.kind);
      detailedFlags.push(input);
      return Promise.resolve();
    },
  } satisfies RegistrationDeps["officer"];
  const service = new RegistrationService({
    db,
    clock,
    config: {
      registrationPaymentPaise: 100,
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

  return {
    db,
    service,
    payment,
    refunds,
    flags,
    detailedFlags,
    get familyCreations() { return familyCreations; },
    get memberCreations() { return memberCreations; },
    get promotions() { return promotions; },
    createRegistration,
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
      subjectId: "member-1",
    });
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

  it("keeps a joiner out of the register until the receiving Head approves", async () => {
    const h = harness();
    const registrationId = await h.createRegistration("+919876543213", "PAID", "payment-4");
    h.payment.set("payment-4", capturedPayment("payment-4"));

    const pending = await h.service.submit(registrationId, "+919876543213", profile("JOIN"));
    expect(pending.status).toBe("AWAITING_HEAD");
    expect(h.memberCreations).toBe(0);

    await expect(h.service.approveJoin(registrationId, "not-head")).rejects.toMatchObject({ code: "FORBIDDEN", httpStatus: 403 });
    await expect(h.service.approveJoin(registrationId, "other-head")).rejects.toMatchObject({ code: "REGISTRATION_NOT_FOUND", httpStatus: 404 });
    const completed = await h.service.approveJoin(registrationId, "head-1");

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
    });
  });
});
