import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../http/errors.js";
import type { Clock } from "../../clock.js";
import type { Romanizer } from "../../adapters/ports.js";
import type { JobRuntime } from "../../jobs.js";
import type {
  IdentityService,
  IdentityTxClient,
} from "../identity/index.js";
import type {
  RegisterService,
  CreateFamilyInput,
  CreateMemberInput,
} from "../register/index.js";
import type {
  PaymentService,
  PaymentView,
  OrderForCheckout,
} from "../payments/index.js";
import {
  SubmitBody,
  SubmittedProfile,
  type SubmitInput,
  type RegistrationResponseBody,
  type DeclineJoinInput,
  type Gotra,
  type IndianState,
  type Gender,
} from "./schemas.js";

export type Tx = Prisma.TransactionClient;

type RegisterPort = Pick<
  RegisterService,
  | "createFamilyWithHead"
  | "createMemberInFamily"
  | "onFamilyGainedMember"
  | "familyByPublicId"
  | "familyOf"
  | "findPossibleDuplicates"
>;
type PaymentsPort = Pick<
  PaymentService,
  | "createOrder"
  | "getView"
  | "getForSubject"
  | "identityOf"
  | "findHeadAnchor"
  | "createHeadAnchor"
  | "markConsumed"
  | "refund"
>;
type IdentityPort = Pick<IdentityService, "promoteToMember">;

export type RegistrationFlagKind =
  | "NO_PAYMENT_IDENTITY"
  | "POSSIBLE_DUPLICATE_PERSON"
  | "SHARED_ADDRESS"
  | "JOINER_PAYS_FROM_OTHER_HEAD";

export interface RegistrationOfficerPort {
  raiseFlag(
    tx: Tx,
    input: {
      readonly kind: RegistrationFlagKind;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly relatedIds?: readonly string[];
    },
  ): Promise<void>;
}

export interface RegistrationMediaPort {
  reassign(
    tx: Tx,
    imageIds: readonly string[],
    owner: { readonly ownerMemberId: string; readonly familyId?: string },
  ): Promise<void>;
  deleteOwnedByRegistration(tx: Tx, registrationId: string): Promise<void>;
}

export interface RegistrationConfig {
  readonly registrationPaymentPaise: number;
  readonly registrationAbandonAfterHours: number;
  readonly joinRequestExpiryDays: number;
  readonly joinRequestsPendingMaxPerFamily: number;
}

export interface RegistrationDeps {
  readonly db: PrismaClient;
  readonly clock: Clock;
  readonly config: RegistrationConfig;
  readonly register: RegisterPort;
  readonly payments: PaymentsPort;
  readonly identity: IdentityPort;
  readonly jobs: JobRuntime;
  readonly media?: RegistrationMediaPort;
  readonly officer: RegistrationOfficerPort;
  readonly romanizer?: Romanizer;
}

export interface FoundingResult {
  readonly status: "COMPLETED";
  readonly memberId: string;
  readonly family: { readonly publicId: string; readonly gotra: Gotra };
  readonly completedAt: Date;
}

export interface JoiningResult {
  readonly status: "AWAITING_HEAD";
  readonly family: { readonly publicId: string; readonly gotra: Gotra };
  readonly expiresAt: Date;
}

export interface RegistrationIdentityPort {
  openForPhone(
    tx: IdentityTxClient,
    phoneE164: string,
  ): Promise<{ readonly registrationId: string }>;
}
export type SubmitResult = FoundingResult | JoiningResult;

interface RegistrationRow {
  readonly id: string;
  readonly phoneE164: string;
  readonly status: "STARTED" | "PAID" | "AWAITING_HEAD" | "COMPLETED" | "ABANDONED" | "CANCELLED" | "DECLINED" | "EXPIRED";
  readonly route: "INDIVIDUAL" | "CREATE" | "JOIN" | null;
  readonly foundingKind: "INDIVIDUAL" | "CREATE" | null;
  readonly joinFamilyId: string | null;
  readonly joinFamilyPublicId: string | null;
  readonly submittedProfile: Prisma.JsonValue | null;
  readonly paymentId: string | null;
  readonly completedMemberId: string | null;
  readonly lastActivityAt: Date;
  readonly submittedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  readonly declineReason: string | null;
  readonly createdAt: Date;
}

export interface FamilyCheckResult {
  readonly exists: boolean;
  readonly gotra?: Gotra;
  readonly acceptingJoins?: boolean;
}

export interface JoinRequestView {
  readonly registrationId: string;
  readonly name: { readonly en: string | null; readonly hi: string | null };
  readonly fatherOrHusbandName: { readonly en: string | null; readonly hi: string | null };
  readonly gender: Gender;
  readonly city: string;
  readonly state: IndianState;
  readonly submittedAt: Date;
  readonly expiresAt: Date;
  readonly flags: readonly string[];
}

interface RegistrationTxShape {
  readonly registration: Tx["registration"];
  readonly payment: Tx["payment"];
  readonly refund: Tx["refund"];
  readonly headAnchor: Tx["headAnchor"];
  readonly familyIdCounter: Tx["familyIdCounter"];
  readonly romanizationCache: Tx["romanizationCache"];
  readonly $queryRaw: Tx["$queryRaw"];
}

function hasRegistrationTx(tx: IdentityTxClient): tx is IdentityTxClient & Tx & RegistrationTxShape {
  return (
    "registration" in tx
    && "payment" in tx
    && "refund" in tx
    && "headAnchor" in tx
    && "familyIdCounter" in tx
    && "romanizationCache" in tx
    && "$queryRaw" in tx
  );
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 3_600_000);
}

function todayAge(dateOfBirth: string, todayIst: string): boolean {
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split("-").map(Number);
  const [todayYear, todayMonth, todayDay] = todayIst.split("-").map(Number);
  if (
    birthYear === undefined || birthMonth === undefined || birthDay === undefined
    || todayYear === undefined || todayMonth === undefined || todayDay === undefined
  ) return false;
  let age = todayYear - birthYear;
  if (todayMonth < birthMonth || (todayMonth === birthMonth && todayDay < birthDay)) age -= 1;
  return age >= 18;
}

function uniqueIds(ids: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== undefined && id !== null))];
}


export class RegistrationService implements RegistrationIdentityPort {
  private readonly db: PrismaClient;
  private readonly clock: Clock;
  private readonly config: RegistrationConfig;
  private readonly register: RegisterPort;
  private readonly payments: PaymentsPort;
  private readonly identity: IdentityPort;
  private readonly jobs: JobRuntime;
  private readonly media: RegistrationMediaPort | undefined;
  private readonly officer: RegistrationOfficerPort;
  private readonly romanizer: Romanizer | undefined;

  constructor(deps: RegistrationDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.config = deps.config;
    this.register = deps.register;
    this.payments = deps.payments;
    this.identity = deps.identity;
    this.jobs = deps.jobs;
    this.media = deps.media;
    this.officer = deps.officer;
    this.romanizer = deps.romanizer;
  }

  async withTransaction<T>(callback: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(callback);
  }

  /** The exact Identity seam. Identity invokes this with its transaction client. */
  async openForPhone(
    tx: IdentityTxClient,
    phoneE164: string,
  ): Promise<{ readonly registrationId: string }> {
    if (!hasRegistrationTx(tx)) throw new AppError("INTERNAL", 500);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`registration-phone:${phoneE164}`}))`;
    const now = this.clock.now();
    const existing = await tx.registration.findFirst({
      where: { phoneE164, status: { in: ["STARTED", "PAID", "AWAITING_HEAD"] } },
      orderBy: { createdAt: "desc" },
    });

    if (existing?.status === "AWAITING_HEAD") {
      await tx.registration.update({
        where: { id: existing.id },
        data: { lastActivityAt: now },
      });
      return { registrationId: existing.id };
    }

    if (existing !== null) {
      await this.endRegistration(
        tx,
        existing,
        "ABANDONED",
        "RESIGNED_IN",
        existing.status === "PAID" ? "REGISTRATION_ABANDONED" : undefined,
      );
    }

    const created = await tx.registration.create({
      data: {
        id: uuidv7(),
        phoneE164,
        status: "STARTED",
        lastActivityAt: now,
        createdAt: now,
      },
      select: { id: true },
    });
    return { registrationId: created.id };
  }

  async onRegistrationPaymentCaptured(paymentId: string, registrationId: string): Promise<void> {
    const payment = await this.payments.getView(paymentId);
    if (payment.purpose !== "REGISTRATION" || payment.status !== "CAPTURED") return;

    await this.db.$transaction(async (tx) => {
      const registration = await this.lockedRegistration(tx, registrationId);
      if (registration === null) {
        await this.payments.refund(tx, paymentId, "REGISTRATION_ABANDONED", { kind: "SYSTEM" });
        return;
      }
      if (registration.status === "STARTED") {
        await tx.registration.update({
          where: { id: registration.id },
          data: {
            status: "PAID",
            paymentId,
            lastActivityAt: this.clock.now(),
          },
        });
        return;
      }
      if (registration.status === "PAID" && registration.paymentId === paymentId) return;
      await this.payments.refund(tx, paymentId, "REGISTRATION_ABANDONED", { kind: "SYSTEM" });
    });
  }

  async createPaymentOrder(
    registrationId: string,
    phoneE164: string,
  ): Promise<OrderForCheckout> {
    const registration = await this.db.registration.findUnique({ where: { id: registrationId } });
    if (registration === null || registration.phoneE164 !== phoneE164) {
      throw new AppError("REGISTRATION_NOT_FOUND", 404);
    }
    if (registration.status !== "STARTED") throw new AppError("REGISTRATION_WRONG_STATE", 409);
    const order = await this.payments.createOrder({
      purpose: "REGISTRATION",
      subjectId: registration.id,
      payerPhoneE164: phoneE164,
      amountPaise: this.config.registrationPaymentPaise,
    });
    await this.db.registration.updateMany({
      where: { id: registration.id, status: "STARTED" },
      data: { lastActivityAt: this.clock.now() },
    });
    return order;
  }

  async getCurrent(registrationId: string, phoneE164: string): Promise<RegistrationResponseBody> {
    const registration = await this.db.registration.findUnique({ where: { id: registrationId } });
    if (registration === null || registration.phoneE164 !== phoneE164) {
      throw new AppError("REGISTRATION_NOT_FOUND", 404);
    }
    await this.db.registration.update({
      where: { id: registration.id },
      data: { lastActivityAt: this.clock.now() },
    });

    const payment = registration.paymentId === null
      ? null
      : await this.payments.getView(registration.paymentId);
    const founding = await this.foundingStatus(registration.paymentId, registration.route);
    let join: RegistrationResponseBody["join"] = null;
    if (
      registration.joinFamilyPublicId !== null
      && registration.expiresAt !== null
    ) {
      const family = await this.register.familyByPublicId(registration.joinFamilyPublicId);
      if (family !== null) {
        join = {
          family: { publicId: registration.joinFamilyPublicId, gotra: family.gotra },
          expiresAt: registration.expiresAt.toISOString(),
          declineReason: registration.declineReason,
        };
      }
    }
    const refund = payment?.refund === null || payment?.refund === undefined
      ? null
      : { status: payment.refund.status };
    return {
      id: registration.id,
      status: registration.status,
      route: registration.route,
      payment: payment === null ? null : this.paymentResponse(payment),
      founding,
      join,
      refund,
      completedMemberId: registration.completedMemberId,
    };
  }

  async familyCheck(familyPublicId: string): Promise<FamilyCheckResult> {
    const family = await this.register.familyByPublicId(familyPublicId);
    if (family === null) return { exists: false };
    const pending = await this.db.registration.findMany({
      where: { joinFamilyId: family.id, status: "AWAITING_HEAD" },
      select: { id: true },
    });
    return {
      exists: true,
      gotra: family.gotra,
      acceptingJoins:
        family.status === "ACTIVE"
        && pending.length < this.config.joinRequestsPendingMaxPerFamily,
    };
  }

  async submit(
    registrationId: string,
    phoneE164: string,
    input: SubmitInput,
  ): Promise<SubmitResult> {
    const parsed = SubmitBody.parse(input);
    const current = await this.db.registration.findUnique({ where: { id: registrationId } });
    if (current === null || current.phoneE164 !== phoneE164) {
      throw new AppError("REGISTRATION_NOT_FOUND", 404);
    }
    if (current.status === "COMPLETED" && current.completedMemberId !== null) {
      return this.completedResult(current.completedMemberId);
    }
    if (current.status !== "PAID") throw new AppError("REGISTRATION_NOT_PAID", 409);
    if (current.paymentId === null) throw new AppError("REGISTRATION_NOT_PAID", 409);

    const payment = await this.payments.getView(current.paymentId);
    if (payment.purpose !== "REGISTRATION" || payment.status !== "CAPTURED") {
      throw new AppError("REGISTRATION_NOT_PAID", 409);
    }
    const prepared = await this.prepareProfile(parsed, phoneE164);
    if (parsed.route === "JOIN") {
      return this.submitJoin(current.id, current.paymentId, prepared, parsed);
    }
    return this.submitFounding(current.id, current.paymentId, prepared, parsed);
  }

  async cancel(registrationId: string, phoneE164: string): Promise<{ status: "ABANDONED" | "CANCELLED" }> {
    return this.db.$transaction(async (tx) => {
      const registration = await this.lockedRegistration(tx, registrationId);
      if (registration === null || registration.phoneE164 !== phoneE164) {
        throw new AppError("REGISTRATION_NOT_FOUND", 404);
      }
      if (registration.status === "STARTED") {
        await this.endRegistration(tx, registration, "ABANDONED", "APPLICANT_CANCELLED");
        return { status: "ABANDONED" };
      }
      if (registration.status === "PAID") {
        await this.endRegistration(
          tx,
          registration,
          "ABANDONED",
          "APPLICANT_CANCELLED",
          "REGISTRATION_CANCELLED",
        );
        return { status: "ABANDONED" };
      }
      if (registration.status === "AWAITING_HEAD") {
        await this.endRegistration(
          tx,
          registration,
          "CANCELLED",
          "APPLICANT_CANCELLED",
          "REGISTRATION_CANCELLED",
        );
        return { status: "CANCELLED" };
      }
      throw new AppError("REGISTRATION_WRONG_STATE", 409);
    });
  }

  async listJoinRequests(headMemberId: string): Promise<JoinRequestView[]> {
    const family = await this.register.familyOf(headMemberId);
    if (family === null || family.headMemberId !== headMemberId) {
      throw new AppError("FORBIDDEN", 403);
    }
    const rows = await this.db.registration.findMany({
      where: { joinFamilyId: family.familyId, status: "AWAITING_HEAD" },
      orderBy: { submittedAt: "asc" },
    });
    return rows.map((row) => this.joinRequestView(row));
  }

  async approveJoin(registrationId: string, headMemberId: string): Promise<FoundingResult> {
    const family = await this.assertHeadForRegistration(registrationId, headMemberId);
    return this.db.$transaction(async (tx) => {
      const registration = await this.lockedRegistration(tx, registrationId);
      if (
        registration === null
        || registration.status !== "AWAITING_HEAD"
        || registration.joinFamilyId !== family.familyId
        || registration.paymentId === null
        || registration.submittedProfile === null
      ) {
        throw new AppError("REGISTRATION_WRONG_STATE", 409);
      }
      if (registration.expiresAt !== null && registration.expiresAt.getTime() <= this.clock.now().getTime()) {
        throw new AppError("REGISTRATION_WRONG_STATE", 409);
      }
      const profile = this.profileFromJson(registration.submittedProfile);
      const createInput = await this.createMemberInput(registration.phoneE164, profile);
      const created = await this.register.createMemberInFamily(tx, family.familyId, createInput);
      await this.reassignImages(tx, profile, created.memberId, family.familyId);
      await this.payments.markConsumed(tx, registration.paymentId);
      await this.identity.promoteToMember(tx, registration.id, created.memberId);
      const completedAt = this.clock.now();
      await tx.registration.update({
        where: { id: registration.id },
        data: {
          status: "COMPLETED",
          route: "JOIN",
          completedMemberId: created.memberId,
          submittedProfile: Prisma.DbNull,
          endedAt: completedAt,
          expiresAt: null,
          lastActivityAt: completedAt,
        },
      });
      await this.register.onFamilyGainedMember(tx, family.familyId);
      return {
        status: "COMPLETED",
        memberId: created.memberId,
        family: { publicId: family.publicId, gotra: family.gotra },
        completedAt,
      };
    });
  }

  async declineJoin(
    registrationId: string,
    headMemberId: string,
    input: DeclineJoinInput,
  ): Promise<{ status: "DECLINED" }> {
    const family = await this.assertHeadForRegistration(registrationId, headMemberId);
    return this.db.$transaction(async (tx) => {
      const registration = await this.lockedRegistration(tx, registrationId);
      if (
        registration === null
        || registration.status !== "AWAITING_HEAD"
        || registration.joinFamilyId !== family.familyId
        || registration.paymentId === null
      ) {
        throw new AppError("REGISTRATION_WRONG_STATE", 409);
      }
      await this.endRegistration(
        tx,
        registration,
        "DECLINED",
        "HEAD_DECLINED",
        "JOIN_DECLINED",
        input.reason,
      );
      return { status: "DECLINED" };
    });
  }

  async expireJoinRequest(registrationId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const registration = await this.lockedRegistration(tx, registrationId);
      if (
        registration === null
        || registration.status !== "AWAITING_HEAD"
        || registration.expiresAt === null
        || registration.expiresAt.getTime() > this.clock.now().getTime()
      ) return;
      await this.endRegistration(
        tx,
        registration,
        "EXPIRED",
        "HEAD_CONFIRMATION_EXPIRED",
        "JOIN_EXPIRED",
      );
    });
  }

  async expireJoinRequests(): Promise<void> {
    const now = this.clock.now();
    const rows = await this.db.registration.findMany({
      where: { status: "AWAITING_HEAD", expiresAt: { lte: now } },
      select: { id: true },
    });
    for (const row of rows) await this.expireJoinRequest(row.id);
  }

  async abandonIdle(): Promise<void> {
    const cutoff = addHours(this.clock.now(), -this.config.registrationAbandonAfterHours);
    const rows = await this.db.registration.findMany({
      where: { status: { in: ["STARTED", "PAID"] }, lastActivityAt: { lt: cutoff } },
      select: { id: true },
    });
    for (const row of rows) {
      await this.db.$transaction(async (tx) => {
        const registration = await this.lockedRegistration(tx, row.id);
        if (
          registration === null
          || (registration.status !== "STARTED" && registration.status !== "PAID")
          || registration.lastActivityAt.getTime() >= cutoff.getTime()
        ) return;
        await this.endRegistration(
          tx,
          registration,
          "ABANDONED",
          "IDLE_TIMEOUT",
          registration.status === "PAID" ? "REGISTRATION_ABANDONED" : undefined,
        );
      });
    }
  }

  async romanize(text: string): Promise<string> {
    const normalized = text.normalize("NFC");
    const textHash = createHash("sha256").update(normalized).digest("hex");
    const cached = await this.db.romanizationCache.findUnique({ where: { textHash } });
    if (cached !== null) return cached.latin;
    if (this.romanizer === undefined) throw new AppError("UPSTREAM_UNAVAILABLE", 503);
    let latin: string;
    try {
      latin = (await this.romanizer.romanize(normalized)).trim();
    } catch {
      throw new AppError("UPSTREAM_UNAVAILABLE", 503);
    }
    if (latin.length === 0) throw new AppError("UPSTREAM_UNAVAILABLE", 503);
    try {
      await this.db.romanizationCache.create({ data: { textHash, latin, createdAt: this.clock.now() } });
    } catch (error: unknown) {
      if (!this.isUniqueViolation(error)) throw error;
    }
    return latin;
  }

  private async submitFounding(
    registrationId: string,
    paymentId: string,
    profile: PreparedProfile,
    input: SubmitInput,
  ): Promise<FoundingResult> {
    if (input.gotra === undefined) throw new AppError("GOTRA_REQUIRED", 422);
    const gotra = input.gotra;
    const foundingKind = input.route === "INDIVIDUAL" ? "INDIVIDUAL" : "CREATE";
    const identity = await this.payments.identityOf(paymentId);
    if (identity.hash !== null && (identity.kind === "VPA" || identity.kind === "CARD")) {
      const anchor = await this.payments.findHeadAnchor(identity.hash);
      if (anchor !== null) throw new AppError("DUPLICATE_HEAD", 409);
    }
    const possibleDuplicates = await this.register.findPossibleDuplicates({
      nameEn: profile.nameEn,
      nameHi: profile.nameHi,
      dateOfBirth: input.dateOfBirth,
      addressLine1: input.address.line1,
      pincode: input.address.pincode,
    });

    return this.db.$transaction(async (tx) => {
      const registration = await this.lockedRegistration(tx, registrationId);
      if (
        registration === null
        || registration.status !== "PAID"
        || registration.phoneE164 !== profile.phoneE164
        || registration.paymentId !== paymentId
      ) throw new AppError("REGISTRATION_NOT_PAID", 409);
      const publicId = await this.mintFamilyPublicId(tx, input.address.pincode);
      const createInput: CreateFamilyInput = {
        ...profile,
        publicId,
        pincodeSnapshot: input.address.pincode,
        gotra,
        familyPhotoImageId: input.familyPhotoImageId ?? null,
      };
      const created = await this.register.createFamilyWithHead(tx, createInput);
      if (identity.kind === "VPA" || identity.kind === "CARD") {
        if (identity.hash === null) throw new AppError("INTERNAL", 500);
        await this.payments.createHeadAnchor(tx, {
          identityHash: identity.hash,
          familyId: created.familyId,
          paymentId,
        });
      } else {
        await this.raiseFlag(tx, {
          kind: "NO_PAYMENT_IDENTITY",
          subjectType: "MEMBER",
          subjectId: created.memberId,
        });
      }
      if (possibleDuplicates.samePerson.length > 0) {
        await this.raiseFlag(tx, {
          kind: "POSSIBLE_DUPLICATE_PERSON",
          subjectType: "MEMBER",
          subjectId: created.memberId,
          relatedIds: possibleDuplicates.samePerson,
        });
      }
      if (possibleDuplicates.sharedAddressHeads.length > 0) {
        await this.raiseFlag(tx, {
          kind: "SHARED_ADDRESS",
          subjectType: "MEMBER",
          subjectId: created.memberId,
          relatedIds: possibleDuplicates.sharedAddressHeads,
        });
      }
      await this.reassignImages(tx, input, created.memberId, created.familyId);
      await this.payments.markConsumed(tx, paymentId);
      await this.identity.promoteToMember(tx, registration.id, created.memberId);
      const completedAt = this.clock.now();
      await tx.registration.update({
        where: { id: registration.id },
        data: {
          status: "COMPLETED",
          route: input.route,
          foundingKind,
          completedMemberId: created.memberId,
          submittedProfile: Prisma.DbNull,
          endedAt: completedAt,
          lastActivityAt: completedAt,
        },
      });
      return {
        status: "COMPLETED",
        memberId: created.memberId,
        family: { publicId, gotra },
        completedAt,
      };
    });
  }

  private async submitJoin(
    registrationId: string,
    paymentId: string,
    profile: PreparedProfile,
    input: SubmitInput,
  ): Promise<JoiningResult> {
    if (input.gotra !== undefined) throw new AppError("GOTRA_NOT_ALLOWED_FOR_JOIN", 422);
    if (input.familyPhotoImageId !== undefined) throw new AppError("VALIDATION_FAILED", 400);
    const familyPublicId = input.familyPublicId;
    if (familyPublicId === undefined) throw new AppError("FAMILY_NOT_FOUND", 404);
    const family = await this.register.familyByPublicId(familyPublicId);
    if (family === null) throw new AppError("FAMILY_NOT_FOUND", 404);
    if (family.status !== "ACTIVE") throw new AppError("FAMILY_NOT_ACCEPTING_JOINS", 409);

    const expiresAt = addDays(this.clock.now(), this.config.joinRequestExpiryDays);
    const identity = await this.payments.identityOf(paymentId);
    const result = await this.db.$transaction(async (tx) => {
      const registration = await this.lockedRegistration(tx, registrationId);
      if (
        registration === null
        || registration.status !== "PAID"
        || registration.paymentId !== paymentId
        || registration.phoneE164 !== profile.phoneE164
      ) throw new AppError("REGISTRATION_NOT_PAID", 409);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`registration-family:${family.id}`}))`;
      const pending = await tx.registration.findMany({
        where: { joinFamilyId: family.id, status: "AWAITING_HEAD" },
        select: { id: true },
      });
      if (pending.length >= this.config.joinRequestsPendingMaxPerFamily) {
        throw new AppError("FAMILY_NOT_ACCEPTING_JOINS", 409);
      }
      if (
        identity.hash !== null
        && (identity.kind === "VPA" || identity.kind === "CARD")
      ) {
        const anchor = await this.payments.findHeadAnchor(identity.hash);
        if (anchor !== null && anchor.familyId !== family.id) {
          await this.raiseFlag(tx, {
            kind: "JOINER_PAYS_FROM_OTHER_HEAD",
            subjectType: "REGISTRATION",
            subjectId: registration.id,
            relatedIds: [anchor.familyId],
          });
        }
      }
      await tx.registration.update({
        where: { id: registration.id },
        data: {
          status: "AWAITING_HEAD",
          route: "JOIN",
          joinFamilyId: family.id,
          joinFamilyPublicId: familyPublicId,
          submittedProfile: input,
          submittedAt: this.clock.now(),
          expiresAt,
          lastActivityAt: this.clock.now(),
        },
      });
      return { status: "AWAITING_HEAD" as const, family: { publicId: familyPublicId, gotra: family.gotra }, expiresAt };
    });
    await this.jobs.send("registration.expireJoinRequest", { registrationId }, { startAfter: expiresAt });
    return result;
  }

  private async prepareProfile(input: SubmitInput, phoneE164: string): Promise<PreparedProfile> {
    if (!todayAge(input.dateOfBirth, this.clock.todayIst())) throw new AppError("NOT_ADULT", 422);
    const nameEn = input.name.en ?? null;
    const nameHi = input.name.hi ?? null;
    const fatherNameEn = input.fatherOrHusbandName.en ?? null;
    const fatherNameHi = input.fatherOrHusbandName.hi ?? null;
    const nameEnSearchKey = nameEn === null && nameHi !== null
      ? await this.romanize(nameHi)
      : null;
    const fatherNameEnSearchKey = fatherNameEn === null && fatherNameHi !== null
      ? await this.romanize(fatherNameHi)
      : null;
    return {
      phoneE164,
      nameEn,
      nameHi,
      nameEnSearchKey,
      fatherNameEn,
      fatherNameHi,
      fatherNameEnSearchKey,
      gender: input.gender,
      dateOfBirth: input.dateOfBirth,
      bloodGroup: input.bloodGroup,
      addressLine1: input.address.line1,
      addressLine2: input.address.line2 ?? null,
      city: input.address.city,
      state: input.address.state,
      pincode: input.address.pincode,
      nativePlaceKind: input.nativePlace.kind,
      nativePlaceId: input.nativePlace.kind === "LISTED" ? input.nativePlace.id : null,
      nativePlaceText: input.nativePlace.kind === "OTHER" ? input.nativePlace.text : null,
      kuldevi: input.kuldevi ?? null,
      kuldevta: input.kuldevta ?? null,
      photoImageId: input.photoImageId ?? null,
      consentBloodGroup: input.consents.bloodGroupMatching,
      consentPhoto: input.consents.photoVisible,
      uiLanguage: input.uiLanguage,
    };
  }

  private async createMemberInput(phoneE164: string, input: SubmitInput): Promise<CreateMemberInput> {
    const prepared = await this.prepareProfile(input, phoneE164);
    return prepared;
  }

  private profileFromJson(value: unknown): SubmitInput {
    const result = SubmittedProfile.safeParse(value);
    if (!result.success) throw new AppError("INTERNAL", 500);
    return result.data;
  }

  private async reassignImages(
    tx: Tx,
    input: SubmitInput | PreparedProfile,
    ownerMemberId: string,
    familyId: string,
  ): Promise<void> {
    const ids = "familyPhotoImageId" in input
      ? uniqueIds([input.photoImageId, input.familyPhotoImageId ?? undefined])
      : uniqueIds([input.photoImageId]);
    if (ids.length === 0) return;
    if (this.media === undefined) throw new AppError("IMAGE_NOT_OWNED", 422);
    await this.media.reassign(tx, ids, { ownerMemberId, familyId });
  }

  private async assertHeadForRegistration(
    registrationId: string,
    headMemberId: string,
  ): Promise<{ familyId: string; publicId: string; gotra: Gotra; headMemberId: string | null }> {
    const registration = await this.db.registration.findUnique({
      where: { id: registrationId },
      select: { joinFamilyId: true, status: true },
    });
    if (registration === null || registration.joinFamilyId === null) {
      throw new AppError("REGISTRATION_NOT_FOUND", 404);
    }
    const family = await this.register.familyOf(headMemberId);
    if (family === null) throw new AppError("FORBIDDEN", 403);
    if (family.familyId !== registration.joinFamilyId) {
      if (family.headMemberId === headMemberId) throw new AppError("REGISTRATION_NOT_FOUND", 404);
      throw new AppError("FORBIDDEN", 403);
    }
    if (family.headMemberId !== headMemberId) throw new AppError("FORBIDDEN", 403);
    return family;
  }

  private joinRequestView(row: {
    id: string;
    submittedProfile: Prisma.JsonValue | null;
    submittedAt: Date | null;
    expiresAt: Date | null;
  }): JoinRequestView {
    if (row.submittedAt === null || row.expiresAt === null) throw new AppError("INTERNAL", 500);
    const profile = this.profileFromJson(row.submittedProfile);
    return {
      registrationId: row.id,
      name: { en: profile.name.en ?? null, hi: profile.name.hi ?? null },
      fatherOrHusbandName: {
        en: profile.fatherOrHusbandName.en ?? null,
        hi: profile.fatherOrHusbandName.hi ?? null,
      },
      gender: profile.gender,
      city: profile.address.city,
      state: profile.address.state,
      submittedAt: row.submittedAt,
      expiresAt: row.expiresAt,
      flags: [],
    };
  }

  private paymentResponse(payment: PaymentView): NonNullable<RegistrationResponseBody["payment"]> {
    return {
      paymentId: payment.paymentId,
      purpose: "REGISTRATION",
      status: payment.status,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      refund: payment.refund === null
        ? null
        : { status: payment.refund.status, reason: payment.refund.reason },
    };
  }

  private async foundingStatus(
    paymentId: string | null,
    route: "INDIVIDUAL" | "CREATE" | "JOIN" | null,
  ): Promise<{ allowed: boolean; reason?: string }> {
    if (route === "JOIN" || paymentId === null) return { allowed: true };
    const identity = await this.payments.identityOf(paymentId);
    if (identity.hash === null || (identity.kind !== "VPA" && identity.kind !== "CARD")) return { allowed: true };
    const anchor = await this.payments.findHeadAnchor(identity.hash);
    return anchor === null ? { allowed: true } : { allowed: false, reason: "DUPLICATE_HEAD" };
  }

  private async completedResult(memberId: string): Promise<FoundingResult> {
    const family = await this.register.familyOf(memberId);
    if (family === null) throw new AppError("REGISTRATION_WRONG_STATE", 409);
    return {
      status: "COMPLETED",
      memberId,
      family: { publicId: family.publicId, gotra: family.gotra },
      completedAt: this.clock.now(),
    };
  }

  private async mintFamilyPublicId(tx: Tx, pincode: string): Promise<string> {
    const counter = await tx.familyIdCounter.upsert({
      where: { pincode },
      create: { pincode, nextSeq: 2 },
      update: { nextSeq: { increment: 1 } },
      select: { nextSeq: true },
    });
    const sequence = counter.nextSeq - 1;
    if (sequence < 1 || sequence > 99_999) throw new AppError("INTERNAL", 500);
    return `AGR-${pincode}-${String(sequence).padStart(5, "0")}`;
  }

  private async lockedRegistration(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`registration:${id}`}))`;
    return tx.registration.findUnique({ where: { id } });
  }

  private async endRegistration(
    tx: Tx,
    registration: RegistrationRow | null,
    status: "ABANDONED" | "CANCELLED" | "DECLINED" | "EXPIRED",
    endReason: string,
    refundReason?: "JOIN_DECLINED" | "JOIN_EXPIRED" | "REGISTRATION_CANCELLED" | "REGISTRATION_ABANDONED",
    declineReason?: string,
  ): Promise<void> {
    if (registration === null) throw new AppError("REGISTRATION_NOT_FOUND", 404);
    if (refundReason !== undefined && registration.paymentId !== null) {
      await this.payments.refund(tx, registration.paymentId, refundReason, { kind: "SYSTEM" });
    }
    if (this.media !== undefined) await this.media.deleteOwnedByRegistration(tx, registration.id);
    const now = this.clock.now();
    await tx.registration.update({
      where: { id: registration.id },
      data: {
        status,
        endedAt: now,
        endReason,
        declineReason: declineReason ?? null,
        submittedProfile: Prisma.DbNull,
        expiresAt: null,
        lastActivityAt: now,
      },
    });
  }

  private async raiseFlag(
    tx: Tx,
    input: {
      readonly kind: RegistrationFlagKind;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly relatedIds?: readonly string[];
    },
  ): Promise<void> {
    await this.officer.raiseFlag(tx, input);
  }

  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
  }
}

type PreparedProfile = CreateMemberInput & { readonly phoneE164: string };
