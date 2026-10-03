import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import type { Request } from "express";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../clock.js";
import { addMilliseconds } from "../../clock.js";
import type {
  SmsSender,
} from "../../adapters/ports.js";
import type { Logger } from "pino";
import { createLogger } from "../../logger.js";
import { AppError } from "../../http/errors.js";
import {
  sessionCredentials,
  type ApplicantPrincipal,
  type MemberPrincipal,
  type Principal,
  type PrincipalResolution,
  type PrincipalRole,
  type SessionCredentials,
} from "../../http/auth.js";
import {
  PrismaRateLimitStore,
  type RateLimitStore,
} from "../../http/rate-limit.js";
import type {
  IdentityDatabase,
  IdentityRole,
  IdentityTxClient,
  SessionClient,
  SessionRow,
} from "./db.js";

const INDIAN_PHONE = /^\+91[6-9]\d{9}$/u;
const OTP_TTL_MS = 300 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const OTP_REQUEST_IP_LIMIT = 20;
const OTP_REQUEST_PHONE_LIMIT = 5;
const ONE_HOUR_MS = 60 * 60 * 1000;
const HOUR_SECONDS = 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_IP_LIMIT = 30;
const SESSION_PHONE_LIMIT = 10;
export type RevokeReason =
  | "LOGOUT"
  | "ERASURE"
  | "ARCHIVAL"
  | "OFFICER"
  | "EXPIRED_IDLE";

export interface RegistrationIdentityPort {
  openForPhone(
    tx: IdentityTxClient,
    phoneE164: string,
  ): Promise<{ readonly registrationId: string }>;
}

export interface RegisterIdentityPort {
  memberPrincipalForPhone(
    phoneE164: string,
  ): Promise<
    | { readonly memberId: string; readonly status: "ACTIVE" | "ARCHIVED" }
    | null
  >;
  isActiveMember(memberId: string): Promise<boolean>;
  isHeadOf(memberId: string): Promise<boolean>;
  familyOf(memberId: string): Promise<{ readonly publicId: string } | null>;
}

export interface ProcessingRecordWriter {
  write(
    tx: IdentityTxClient,
    input: {
      readonly action: "ROLE_GRANTED" | "ROLE_REVOKED";
      readonly subjectId: string;
      readonly actor:
        | { readonly kind: "SYSTEM" }
        | { readonly kind: "MEMBER"; readonly id: string };
    },
  ): Promise<void>;
}

export interface IdentityServiceConfig {
  readonly sessionTtlWebDays: number;
  readonly sessionTtlMobileDays: number;
  readonly otpHmacKey: string;
}

export interface IdentityServiceDeps {
  readonly db: IdentityDatabase;
  readonly smsSender: SmsSender;
  readonly registration: RegistrationIdentityPort;
  readonly register: RegisterIdentityPort;
  readonly clock: Clock;
  readonly config: IdentityServiceConfig;
  readonly rateLimitStore?: RateLimitStore;
  readonly processingRecord: ProcessingRecordWriter;
  readonly logger?: Logger;
}

export interface CreatedSession {
  readonly principal: Principal;
  readonly token: string;
  readonly client: SessionClient;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createToken(): string {
  return randomBytes(32).toString("base64url");
}
function computeOtpHash(phoneE164: string, code: string, base64Key: string): string {
  return createHmac("sha256", Buffer.from(base64Key, "base64"))
    .update(`${phoneE164}:${code}`)
    .digest("hex");
}

function maskPhone(phoneE164: string): string {
  return `***${phoneE164.slice(-4)}`;
}

function verifyOtpHash(
  expectedHash: string,
  actualCode: string,
  phoneE164: string,
  base64Key: string,
): boolean {
  const computedHash = computeOtpHash(phoneE164, actualCode, base64Key);
  if (expectedHash.length !== computedHash.length) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(expectedHash, "utf-8"),
    Buffer.from(computedHash, "utf-8"),
  );
}


function sessionTtlMilliseconds(client: string, config: IdentityServiceConfig): number {
  if (client !== "WEB" && client !== "MOBILE") {
    throw new AppError("VALIDATION_FAILED", 400);
  }
  const days = client === "WEB" ? config.sessionTtlWebDays : config.sessionTtlMobileDays;
  if (!Number.isInteger(days) || days <= 0) {
    throw new AppError("INTERNAL", 500);
  }
  return days * DAY_MS;
}


function floorWindowStart(now: Date): Date {
  const milliseconds = Math.floor(now.getTime() / (HOUR_SECONDS * 1000)) * HOUR_SECONDS * 1000;
  return new Date(milliseconds);
}


function principalForApplicant(
  session: SessionRow,
): ApplicantPrincipal {
  if (session.registrationId === null) {
    throw new AppError("SESSION_EXPIRED", 401);
  }
  return {
    kind: "APPLICANT",
    sessionId: session.id,
    phoneE164: session.phoneE164,
    registrationId: session.registrationId,
  };
}

export class IdentityService {
  private readonly db: IdentityDatabase;
  private readonly smsSender: SmsSender;
  private readonly registration: RegistrationIdentityPort;
  private readonly register: RegisterIdentityPort;
  private readonly clock: Clock;
  private readonly config: IdentityServiceConfig;
  private readonly rateLimitStore: RateLimitStore;
  private readonly processingRecord: ProcessingRecordWriter;
  private readonly logger: Logger;

  public constructor(deps: IdentityServiceDeps) {
    this.db = deps.db;
    this.smsSender = deps.smsSender;
    this.registration = deps.registration;
    this.register = deps.register;
    this.clock = deps.clock;
    this.config = deps.config;
    this.rateLimitStore = deps.rateLimitStore ?? new PrismaRateLimitStore(deps.db);
    this.processingRecord = deps.processingRecord;
    this.logger = deps.logger ?? createLogger();
  }
  public sessionTtlSeconds(client: SessionClient): number {
    return sessionTtlMilliseconds(client, this.config) / 1000;
  }

  private async consumeRateLimit(name: string, key: string, limit: number): Promise<void> {
    const now = this.clock.now();
    const windowStart = floorWindowStart(now);
    const count = await this.rateLimitStore.increment(name, key, windowStart);
    if (count <= limit) return;
    const retryAt = windowStart.getTime() + HOUR_SECONDS * 1000;
    const retryAfterSeconds = Math.max(1, (retryAt - now.getTime()) / 1000);
    throw AppError.rateLimited(retryAfterSeconds);
  }


  private async memberPrincipal(
    session: SessionRow,
    memberId: string,
  ): Promise<MemberPrincipal> {
    const member = await this.register.memberPrincipalForPhone(session.phoneE164);
    if (member === null || member.status !== "ACTIVE" || member.memberId !== memberId) {
      if (member?.status === "ARCHIVED") {
        throw new AppError("PHONE_BELONGS_TO_ARCHIVED_MEMBER", 403);
      }
      throw new AppError("SESSION_EXPIRED", 401);
    }

    const [roles, isHead, family] = await Promise.all([
      this.rolesOf(memberId),
      this.register.isHeadOf(memberId),
      this.register.familyOf(memberId),
    ]);
    if (family === null) throw new AppError("SESSION_EXPIRED", 401);

    return {
      kind: "MEMBER",
      sessionId: session.id,
      phoneE164: session.phoneE164,
      memberId,
      familyPublicId: family.publicId,
      roles,
      isHead,
    };
  }

  private async principalFromSession(session: SessionRow): Promise<Principal> {
    if (session.memberId !== null) {
      return this.memberPrincipal(session, session.memberId);
    }
    return principalForApplicant(session);
  }

  public async requestOtp(input: {
    readonly client: SessionClient;
    readonly phoneE164: string;
    readonly ipAddress: string;
  }): Promise<{ readonly expiresInSeconds: number; readonly resendAfterSeconds: number }> {
    if (!INDIAN_PHONE.test(input.phoneE164)) {
      throw new AppError("VALIDATION_FAILED", 400);
    }

    await this.consumeRateLimit("otp.request.ip", input.ipAddress, OTP_REQUEST_IP_LIMIT);

    const now = this.clock.now();
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const codeHash = computeOtpHash(input.phoneE164, code, this.config.otpHmacKey);
    const challengeId = uuidv7();
    const expiresAt = addMilliseconds(now, OTP_TTL_MS);

    await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.phoneE164}))`;

      const recentChallenge = await tx.otpChallenge.findFirst({
        where: {
          phoneE164: input.phoneE164,
        },
        orderBy: { createdAt: "desc" },
      });

      if (recentChallenge !== null) {
        const elapsedMs = now.getTime() - recentChallenge.createdAt.getTime();
        if (elapsedMs < RESEND_COOLDOWN_MS && elapsedMs >= 0) {
          const retryAfterSeconds = Math.max(1, Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000));
          throw AppError.rateLimited(retryAfterSeconds);
        }
      }

      await this.consumeRateLimit("otp.request.phone", input.phoneE164, OTP_REQUEST_PHONE_LIMIT);

      await tx.otpChallenge.updateMany({
        where: {
          phoneE164: input.phoneE164,
          consumedAt: null,
        },
        data: {
          consumedAt: now,
        },
      });

      await tx.otpChallenge.create({
        data: {
          id: challengeId,
          phoneE164: input.phoneE164,
          codeHash,
          attempts: 0,
          expiresAt,
          consumedAt: null,
          createdAt: now,
        },
      });
    });

    try {
      await this.smsSender.sendOtp(input.phoneE164, code);
    } catch (error) {
      await this.db.otpChallenge.deleteMany({
        where: { id: challengeId },
      });
      this.logger.error(
        {
          err: error,
          phone: maskPhone(input.phoneE164),
        },
        "OTP delivery failed",
      );
      throw new AppError("OTP_DELIVERY_FAILED", 502);
    }

    return {
      expiresInSeconds: 300,
      resendAfterSeconds: 30,
    };
  }

  public async verifyAndConsumeOtp(phoneE164: string, otp: string): Promise<void> {
    if (!INDIAN_PHONE.test(phoneE164) || !/^\d{6}$/u.test(otp)) {
      throw new AppError("VALIDATION_FAILED", 400);
    }

    const now = this.clock.now();

    const challenge = await this.db.otpChallenge.findFirst({
      where: {
        phoneE164,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
    });

    if (challenge === null) {
      throw new AppError("OTP_INVALID", 401);
    }

    const updateResult = await this.db.otpChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: MAX_OTP_ATTEMPTS },
      },
      data: {
        attempts: { increment: 1 },
      },
    });

    if (updateResult.count === 0) {
      const current = await this.db.otpChallenge.findFirst({
        where: { id: challenge.id },
      });
      if (current !== null && current.attempts >= MAX_OTP_ATTEMPTS) {
        if (current.consumedAt === null) {
          await this.db.otpChallenge.updateMany({
            where: { id: challenge.id, consumedAt: null },
            data: { consumedAt: now },
          });
        }
        throw new AppError("OTP_ATTEMPTS_EXCEEDED", 429);
      }
      throw new AppError("OTP_INVALID", 401);
    }

    const matches = verifyOtpHash(
      challenge.codeHash,
      otp,
      phoneE164,
      this.config.otpHmacKey,
    );

    if (!matches) {
      throw new AppError("OTP_INVALID", 401);
    }

    const consumeResult = await this.db.otpChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
      },
      data: {
        consumedAt: now,
      },
    });

    if (consumeResult.count === 0) {
      throw new AppError("OTP_INVALID", 401);
    }
  }

  public async createSession(input: {
    readonly authentication: {
      readonly kind: "SMS_OTP";
      readonly phoneE164: string;
      readonly otp: string;
    };
    readonly client: SessionClient;
    readonly ipAddress: string;
    readonly userAgent?: string;
  }): Promise<CreatedSession> {
    await this.consumeRateLimit("session.create.ip", input.ipAddress, SESSION_IP_LIMIT);

    const phoneE164 = input.authentication.phoneE164;
    if (!INDIAN_PHONE.test(phoneE164) || !/^\d{6}$/u.test(input.authentication.otp)) {
      throw new AppError("VALIDATION_FAILED", 400);
    }

    await this.consumeRateLimit("session.create.phone", phoneE164, SESSION_PHONE_LIMIT);

    await this.verifyAndConsumeOtp(phoneE164, input.authentication.otp);
    const now = this.clock.now();
    const existingMember = await this.register.memberPrincipalForPhone(phoneE164);
    if (existingMember?.status === "ARCHIVED") {
      throw new AppError("PHONE_BELONGS_TO_ARCHIVED_MEMBER", 403);
    }

    const token = createToken();
    const sessionId = uuidv7();
    const expiresAt = addMilliseconds(
      now,
      sessionTtlMilliseconds(input.client, this.config),
    );
    let registrationId: string | null = null;
    await this.db.$transaction(async (tx) => {
      if (existingMember === null) {
        registrationId = (await this.registration.openForPhone(tx, phoneE164)).registrationId;
      }
      await tx.session.create({
        data: {
          id: sessionId,
          tokenHash: hashToken(token),
          client: input.client,
          phoneE164,
          memberId: existingMember?.memberId ?? null,
          registrationId,
          createdAt: now,
          lastSeenAt: now,
          expiresAt,
          revokedAt: null,
          revokedReason: null,
          userAgent: input.userAgent ?? null,
        },
      });
    });

    const session: SessionRow = {
      id: sessionId,
      tokenHash: hashToken(token),
      client: input.client,
      phoneE164,
      memberId: existingMember?.memberId ?? null,
      registrationId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      revokedAt: null,
      revokedReason: null,
      userAgent: input.userAgent ?? null,
    };
    return {
      principal: await this.principalFromSession(session),
      token,
      client: input.client,
    };
  }

  public async resolve(request: Request): Promise<PrincipalResolution | null> {
    const credentials = sessionCredentials(request);
    if (credentials === null) return null;
    const session = await this.db.session.findUnique({
      where: { tokenHash: hashToken(credentials.token) },
    });
    if (session === null) throw new AppError("SESSION_EXPIRED", 401);

    const now = this.clock.now();
    if (session.revokedAt !== null || session.expiresAt.getTime() <= now.getTime()) {
      if (session.revokedAt === null) {
        await this.db.session.update({
          where: { id: session.id },
          data: { revokedAt: now, revokedReason: "EXPIRED_IDLE" },
        });
      }
      throw new AppError("SESSION_EXPIRED", 401);
    }

    let current = session;
    let sessionRefreshed = false;
    if (now.getTime() - session.lastSeenAt.getTime() > ONE_HOUR_MS) {
      const expiresAt = addMilliseconds(now, sessionTtlMilliseconds(session.client, this.config));
      current = await this.db.session.update({
        where: { id: session.id },
        data: { lastSeenAt: now, expiresAt },
      });
      sessionRefreshed = true;
    }
    return {
      principal: await this.principalFromSession(current),
      sessionRefreshed,
    };
  }
  public async revokeCurrentSession(request: Request): Promise<SessionCredentials> {
    const credentials = sessionCredentials(request);
    if (credentials === null) {
      throw new AppError("UNAUTHENTICATED", 401);
    }
    const session = await this.db.session.findUnique({
      where: { tokenHash: hashToken(credentials.token) },
    });
    if (session === null) {
      throw new AppError("SESSION_EXPIRED", 401);
    }
    await this.db.$transaction((tx) =>
      this.revokeSession(tx, session.id, "LOGOUT"),
    );
    return credentials;
  }


  public async revokeSession(
    tx: IdentityTxClient,
    sessionId: string,
    reason: RevokeReason,
  ): Promise<void> {
    const now = this.clock.now();
    await tx.session.update({
      where: { id: sessionId },
      data: { revokedAt: now, revokedReason: reason },
    });
  }

  public async promoteToMember(
    tx: IdentityTxClient,
    registrationId: string,
    memberId: string,
  ): Promise<void> {
    await tx.session.updateMany({
      where: { registrationId, revokedAt: null },
      data: { memberId, registrationId: null },
    });
  }

  public async revokeAllForMember(
    tx: IdentityTxClient,
    memberId: string,
    reason: RevokeReason,
  ): Promise<number> {
    const result = await tx.session.updateMany({
      where: { memberId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return result.count;
  }
  public async grantRole(
    tx: IdentityTxClient,
    memberId: string,
    role: IdentityRole,
    grantedBy: string,
  ): Promise<void> {
    await tx.memberRole.create({
      data: {
        memberId,
        role,
        grantedBy,
        grantedAt: this.clock.now(),
      },
    });
    await this.processingRecord.write(tx, {
      action: "ROLE_GRANTED",
      subjectId: memberId,
      actor: { kind: "MEMBER", id: grantedBy },
    });
  }

  public async revokeRole(
    tx: IdentityTxClient,
    memberId: string,
    role: IdentityRole,
    revokedBy: string,
  ): Promise<void> {
    const result = await tx.memberRole.deleteMany({ where: { memberId, role } });
    if (result.count === 0) return;
    await this.processingRecord.write(tx, {
      action: "ROLE_REVOKED",
      subjectId: memberId,
      actor: { kind: "MEMBER", id: revokedBy },
    });
  }

  public async rolesOf(memberId: string): Promise<readonly PrincipalRole[]> {
    const rows = await this.db.memberRole.findMany({
      where: { memberId },
      orderBy: { role: "asc" },
    });
    return rows.map((row) => row.role);
  }

  public async seedInitialRoles(
    tx: IdentityTxClient,
    memberId: string,
    roles: readonly IdentityRole[],
  ): Promise<void> {
    if (!(await this.register.isActiveMember(memberId))) {
      throw new AppError("FORBIDDEN", 403);
    }
    for (const role of roles) {
      await tx.memberRole.create({
        data: {
          memberId,
          role,
          grantedBy: null,
          grantedAt: this.clock.now(),
        },
      });
      await this.processingRecord.write(tx, {
        action: "ROLE_GRANTED",
        subjectId: memberId,
        actor: { kind: "SYSTEM" },
      });
    }
  }


  public async withTransaction<T>(callback: (tx: IdentityTxClient) => Promise<T>): Promise<T> {
    return this.db.$transaction(callback);
  }
}
