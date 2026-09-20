import type { RateLimitDatabase } from "../../http/rate-limit.js";

export type SessionClient = "WEB" | "MOBILE";
export type IdentityRole = "OFFICER" | "OPERATOR" | "ORGANISER";

export interface SessionRow {
  readonly id: string;
  readonly tokenHash: string;
  readonly client: SessionClient;
  readonly phoneE164: string;
  readonly memberId: string | null;
  readonly registrationId: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly userAgent: string | null;
}

export interface MemberRoleRow {
  readonly memberId: string;
  readonly role: IdentityRole;
  readonly grantedBy: string | null;
  readonly grantedAt: Date;
}

interface SessionIdWhere {
  readonly id: string;
}

interface SessionTokenWhere {
  readonly tokenHash: string;
}

interface MemberRoleWhere {
  readonly memberId_role: {
    readonly memberId: string;
    readonly role: IdentityRole;
  };
}

export interface SessionDelegate {
  findUnique(args: {
    readonly where: SessionIdWhere | SessionTokenWhere;
  }): Promise<SessionRow | null>;
  create(args: { readonly data: Record<string, unknown> }): Promise<SessionRow>;
  update(args: {
    readonly where: SessionIdWhere;
    readonly data: Record<string, unknown>;
  }): Promise<SessionRow>;
  updateMany(args: {
    readonly where: Record<string, unknown>;
    readonly data: Record<string, unknown>;
  }): Promise<{ readonly count: number }>;
}

export interface MemberRoleDelegate {
  findMany(args: {
    readonly where: Record<string, unknown>;
    readonly orderBy?: Record<string, unknown>;
  }): Promise<readonly MemberRoleRow[]>;
  create(args: { readonly data: Record<string, unknown> }): Promise<MemberRoleRow>;
  deleteMany(args: { readonly where: Record<string, unknown> }): Promise<{ readonly count: number }>;
  findUnique(args: { readonly where: MemberRoleWhere }): Promise<MemberRoleRow | null>;
}

export interface IdentityTxClient {
  readonly session: SessionDelegate;
  readonly memberRole: MemberRoleDelegate;
}

export interface IdentityDatabase extends IdentityTxClient, RateLimitDatabase {
  $transaction<T>(callback: (tx: IdentityTxClient) => Promise<T>): Promise<T>;
}
