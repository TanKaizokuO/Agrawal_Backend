import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../clock.js";
import { addMilliseconds } from "../../clock.js";
import type { PhoneTokenVerifier, VerifiedPhoneToken } from "../../adapters/ports.js";
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
// Deliberately fixed until an SMS provider is integrated; accept only on MOBILE.
const FIXED_MOBILE_OTP = "123456";
const TEN_MINUTES_MS = 10 * 60 * 1000;
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
}

export interface IdentityServiceDeps {
  readonly db: IdentityDatabase;
  readonly verifier: PhoneTokenVerifier;
  readonly registration: RegistrationIdentityPort;
  readonly register: RegisterIdentityPort;
  readonly clock: Clock;
  readonly config: IdentityServiceConfig;
  readonly rateLimitStore?: RateLimitStore;
  readonly processingRecord: ProcessingRecordWriter;
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

function validatePhoneToken(
  token: {
    readonly authTime: Date;
    readonly phoneE164: string;
    readonly signInProvider: string;
  },
  now: Date,
): void {
  const authTime = token.authTime instanceof Date
    ? token.authTime.getTime()
    : Number.NaN;
  const age = now.getTime() - authTime;
  if (
    token.signInProvider !== "phone" ||
    !INDIAN_PHONE.test(token.phoneE164) ||
    !Number.isFinite(authTime) ||
    age < 0 ||
    age > TEN_MINUTES_MS
  ) {
    throw new AppError("FIREBASE_TOKEN_INVALID", 401);
  }
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
  private readonly verifier: PhoneTokenVerifier;
  private readonly registration: RegistrationIdentityPort;
  private readonly register: RegisterIdentityPort;
  private readonly clock: Clock;
  private readonly config: IdentityServiceConfig;
  private readonly rateLimitStore: RateLimitStore;
  private readonly processingRecord: ProcessingRecordWriter;

  public constructor(deps: IdentityServiceDeps) {
    this.db = deps.db;
    this.verifier = deps.verifier;
    this.registration = deps.registration;
    this.register = deps.register;
    this.clock = deps.clock;
    this.config = deps.config;
    this.rateLimitStore = deps.rateLimitStore ?? new PrismaRateLimitStore(deps.db);
    this.processingRecord = deps.processingRecord;
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

  private async verifiedPhone(idToken: string): Promise<VerifiedPhoneToken> {
    let verified: VerifiedPhoneToken;
    try {
      verified = await this.verifier.verifyIdToken(idToken, true);
    } catch {
      throw new AppError("FIREBASE_TOKEN_INVALID", 401);
    }
    validatePhoneToken(verified, this.clock.now());
    return verified;
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

  public async createSession(input: {
    readonly authentication:
      | { readonly kind: "FIREBASE"; readonly idToken: string }
      | {
          readonly kind: "FIXED_OTP";
          readonly phoneE164: string;
          readonly otp: string;
        };
    readonly client: SessionClient;
    readonly ipAddress: string;
    readonly userAgent?: string;
  }): Promise<CreatedSession> {
    await this.consumeRateLimit("session.create.ip", input.ipAddress, SESSION_IP_LIMIT);

    const authentication = input.authentication;
    if (authentication.kind === "FIXED_OTP" && input.client !== "MOBILE") {
      throw new AppError("VALIDATION_FAILED", 400);
    }
    const phoneE164 = authentication.kind === "FIREBASE"
      ? (await this.verifiedPhone(authentication.idToken)).phoneE164
      : authentication.phoneE164;
    await this.consumeRateLimit("session.create.phone", phoneE164, SESSION_PHONE_LIMIT);
    if (authentication.kind === "FIXED_OTP" && authentication.otp !== FIXED_MOBILE_OTP) {
      throw new AppError("FIXED_OTP_INVALID", 401);
    }

    const existingMember = await this.register.memberPrincipalForPhone(phoneE164);
    if (existingMember?.status === "ARCHIVED") {
      throw new AppError("PHONE_BELONGS_TO_ARCHIVED_MEMBER", 403);
    }

    const token = createToken();
    const now = this.clock.now();
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
