import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../clock.js";
import { addMilliseconds } from "../../clock.js";
import { AppError } from "../../http/errors.js";
import { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type {
  MemberProjection,
} from "../register/index.js";
import {
  FLAG_KINDS,
  FLAG_RESOLUTIONS,
  FLAG_STATUSES,
  PROCESSING_ACTIONS,
  PROCESSING_ACTOR_KINDS,
  type EraseMemberInput,
  type ErasureRequestPage,
  type ErasureRequestsQueryInput,
  type FlagKind,
  type FlagPage,
  type FlagResolution,
  type FlagsQueryInput,
  type FlagStatus,
  type FlagView,
  type LiftSuspensionInput,
  type MemberLookupPage,
  type MemberLookupQueryInput,
  type NomineeReadInput,
  type OfficerImagesQueryInput,
  type OfficerMemberView,
  type OperatorRoleInput,
  type ProcessingAction,
  type ProcessingActorKind,
  type ProcessingRecordPage,
  type ProcessingRecordQueryInput,
  type ProcessingSubjectType,
  type ReportsQueryInput,
  type ResolveArchivalInput,
  type ResolveFlagInput,
  type SuspensionQueryInput,
} from "./schemas.js";

export type OfficerTransaction = Prisma.TransactionClient;

export type ProcessingMetadataValue = string | number | boolean | null;
export type ProcessingMetadata = Readonly<Record<string, ProcessingMetadataValue>>;

export type ProcessingActor =
  | { readonly kind: "SYSTEM" }
  | { readonly kind: "MEMBER"; readonly id: string }
  | { readonly kind: "OFFICER"; readonly id: string }
  | { readonly kind: "OPERATOR"; readonly id: string };

export interface ProcessingEntry {
  readonly action: ProcessingAction;
  readonly subjectType?: ProcessingSubjectType;
  readonly subjectId: string;
  readonly actor: ProcessingActor;
  readonly reason?: string;
  readonly metadata?: ProcessingMetadata;
}
/**
 * The small append-only seam consumed by Identity, Payments, Register and
 * Media. Implementations must be called with their transaction client, never
 * with the root Prisma client, so the record commits or rolls back with the
 * governed action.
 */
export interface ProcessingRecordWriter {
  write(tx: OfficerTransaction, entry: ProcessingEntry): Promise<void>;
}

export interface OfficerRegisterPort {
  project(
    viewerMemberId: string,
    memberIds: readonly string[],
  ): Promise<ReadonlyMap<string, MemberProjection>>;
  eraseMember(
    tx: OfficerTransaction,
    memberId: string,
    actor: { readonly kind: "OFFICER"; readonly officerId: string },
    erasureRequestId?: string,
  ): Promise<void>;
  readNomineeForOfficer(
    tx: OfficerTransaction,
    memberId: string,
    officerId: string,
    reason: "CONFIRMED_DEATH" | "ARCHIVAL_REQUEST",
    archivalRequestId?: string,
  ): Promise<MemberProjection | null>;
  unarchiveMember(
    tx: OfficerTransaction,
    memberId: string,
    officerId: string,
  ): Promise<{ readonly successionReverted: false }>;
}

export interface OfficerMediaImageView {
  readonly imageId: string;
  readonly status: string;
  readonly purpose: string;
  readonly ownerMemberId: string | null;
  readonly url: string | null;
}

export interface OfficerMediaPort {
  listOfficerImages(input: {
    readonly status?: "UNSCREENED" | "APPROVED" | "REJECTED";
    readonly cursor?: string;
    readonly limit: number;
    readonly officerMemberId: string;
  }): Promise<{
    readonly items: readonly OfficerMediaImageView[];
    readonly nextCursor: string | null;
  }>;
  removeImage(input: {
    readonly imageId: string;
    readonly officerMemberId: string;
    readonly reason: string;
  }): Promise<void>;
  approveImage(input: {
    readonly imageId: string;
    readonly officerMemberId: string;
  }): Promise<void>;
}

export interface OfficerPaymentsPort {
  refund(
    tx: OfficerTransaction,
    paymentId: string,
    reason: "OFFICER",
    actor: { readonly kind: "OFFICER"; readonly id: string },
  ): Promise<void>;
}

export interface OfficerIdentityPort {
  grantRole(
    tx: OfficerTransaction,
    memberId: string,
    role: "ORGANISER" | "OFFICER",
    grantedBy: string,
  ): Promise<void>;
  revokeRole(
    tx: OfficerTransaction,
    memberId: string,
    role: "ORGANISER" | "OFFICER",
    revokedBy: string,
  ): Promise<void>;
}

export interface OfficerMemberLookupPort {
  lookup(input: MemberLookupQueryInput): Promise<{
    readonly memberIds: readonly string[];
    readonly nextCursor: string | null;
  }>;
}

export interface OfficerErasureRequestPort {
  list(input: ErasureRequestsQueryInput): Promise<{
    readonly items: readonly {
      readonly id: string;
      readonly memberId: string;
      readonly source: string;
      readonly status: string;
      readonly requestedAt: Date;
    }[];
    readonly nextCursor: string | null;
  }>;
}

export interface OfficerSuspensionPort {
  list(input: SuspensionQueryInput): Promise<{
    readonly items: readonly Record<string, unknown>[];
    readonly nextCursor: string | null;
  }>;
  lift(input: {
    readonly suspensionId: string;
    readonly officerId: string;
    readonly reason: string;
    readonly restoreNotice: boolean;
  }): Promise<void>;
}

export interface OfficerArchivalPort {
  list(input: {
    readonly status: "OPEN" | "ESCALATED" | "RESOLVED";
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly Record<string, unknown>[];
    readonly nextCursor: string | null;
  }>;
  resolve(input: {
    readonly archivalRequestId: string;
    readonly officerId: string;
    readonly outcome: "CONFIRM" | "REFUTE";
    readonly note: string;
  }): Promise<void>;
}

export interface OfficerReportPort {
  list(input: ReportsQueryInput): Promise<{
    readonly items: readonly Record<string, unknown>[];
    readonly nextCursor: string | null;
  }>;
}

export interface OfficerBloodSosPort {
  close(input: {
    readonly bloodSosId: string;
    readonly officerId: string;
    readonly reason: string;
  }): Promise<void>;
}

export interface OfficerServiceDeps {
  readonly db: PrismaClient;
  readonly clock: Clock;
  readonly retentionDaysConsentAndLogs: number;
  readonly register: OfficerRegisterPort;
  readonly processingRecord?: ProcessingRecordWriter;
  readonly media?: OfficerMediaPort;
  readonly payments?: OfficerPaymentsPort;
  readonly identity?: OfficerIdentityPort;
  readonly memberLookup?: OfficerMemberLookupPort;
  readonly erasureRequests?: OfficerErasureRequestPort;
  readonly suspensions?: OfficerSuspensionPort;
  readonly archivals?: OfficerArchivalPort;
  readonly reports?: OfficerReportPort;
  readonly bloodSos?: OfficerBloodSosPort;
}

const DAY_MS = 86_400_000;
const FLAG_KIND_SET: Record<string, true> = {
  NO_PAYMENT_IDENTITY: true,
  POSSIBLE_DUPLICATE_PERSON: true,
  SHARED_ADDRESS: true,
  JOINER_PAYS_FROM_OTHER_HEAD: true,
};
const FLAG_STATUS_SET: Record<string, true> = { OPEN: true, RESOLVED: true };
const FLAG_RESOLUTION_SET: Record<string, true> = {
  CLEARED: true,
  ERASED_MEMBER: true,
};
const PROCESSING_ACTION_SET: Record<string, true> = {
  MEMBER_ERASED: true,
  ERASURE_REQUESTED: true,
  FLAG_RESOLVED: true,
  IMAGE_REMOVED: true,
  IMAGE_OVERRIDE_APPROVED: true,
  OFFICER_IMAGES_VIEWED: true,
  OFFICER_MEMBER_LOOKUP: true,
  NOMINEE_READ: true,
  REFUND_REQUESTED: true,
  HEAD_SUCCEEDED: true,
  FAMILY_ARCHIVED: true,
  MEMBER_ARCHIVED: true,
  MEMBER_UNARCHIVED: true,
  SUSPENSION_LIFTED: true,
  NOTICE_RESTORED: true,
  ARCHIVAL_RESOLVED_BY_OFFICER: true,
  ROLE_GRANTED: true,
  ROLE_REVOKED: true,
  BLOOD_SOS_REPORT_RESOLVED: true,
  PASS_REVOKED: true,
};
const PROCESSING_ACTOR_SET: Record<string, true> = {
  OFFICER: true,
  OPERATOR: true,
  MEMBER: true,
  SYSTEM: true,
};

function pageOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new AppError("VALIDATION_FAILED", 400);
  }
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError("VALIDATION_FAILED", 400);
  }
  return offset;
}

function nextPageCursor(offset: number, hasMore: boolean): string | null {
  return hasMore ? Buffer.from(String(offset)).toString("base64url") : null;
}

function processingAction(value: string): ProcessingAction {
  if (PROCESSING_ACTION_SET[value] !== true) throw new AppError("INTERNAL", 500);
  for (const action of PROCESSING_ACTIONS) if (action === value) return action;
  throw new AppError("INTERNAL", 500);
}

function processingActorKind(value: string): ProcessingActorKind {
  if (PROCESSING_ACTOR_SET[value] !== true) throw new AppError("INTERNAL", 500);
  for (const actor of PROCESSING_ACTOR_KINDS) if (actor === value) return actor;
  throw new AppError("INTERNAL", 500);
}

function flagKind(value: string): FlagKind {
  if (FLAG_KIND_SET[value] !== true) throw new AppError("INTERNAL", 500);
  for (const kind of FLAG_KINDS) if (kind === value) return kind;
  throw new AppError("INTERNAL", 500);
}

function flagStatus(value: string): FlagStatus {
  if (FLAG_STATUS_SET[value] !== true) throw new AppError("INTERNAL", 500);
  for (const status of FLAG_STATUSES) if (status === value) return status;
  throw new AppError("INTERNAL", 500);
}

function flagResolution(value: string | null): FlagResolution | null {
  if (value === null) return null;
  if (FLAG_RESOLUTION_SET[value] !== true) return null;
  for (const resolution of FLAG_RESOLUTIONS) if (resolution === value) return resolution;
  return null;
}

function stringIds(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function maskPhone(phoneE164: string): string {
  const lastFour = phoneE164.slice(-4);
  return `***${lastFour}`;
}

const SENSITIVE_OFFICER_KEYS: Record<string, true> = {
  address: true,
  addressline1: true,
  addressline2: true,
  bloodgroup: true,
  dateofbirth: true,
  district: true,
  dob: true,
  nominee: true,
  nomineeMemberid: true,
  pincode: true,
  phonee164: true,
  vpa: true,
};

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeOfficerValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeOfficerValue(item));
  // Dates are objects with no own entries; without this they serialize as `{}`.
  if (value instanceof Date) return value.toISOString();
  if (!isUnknownRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.replaceAll("_", "").toLowerCase();
    if (
      normalizedKey === "phone"
      || normalizedKey === "phonenumber"
      || normalizedKey === "phonee164"
    ) {
      if (typeof nested === "string") result.phoneLast4 = maskPhone(nested);
      continue;
    }
    if (SENSITIVE_OFFICER_KEYS[normalizedKey] === true) continue;
    result[key] = sanitizeOfficerValue(nested);
  }
  return result;
}

function safeOfficerItems(items: readonly Record<string, unknown>[]): readonly Record<string, unknown>[] {
  return items.map((item) => sanitizeOfficerValue(item)).filter(isUnknownRecord);
}

function officerView(projection: MemberProjection | undefined): OfficerMemberView | null {
  if (projection === undefined) return null;
  const view: {
    memberId: string;
    familyPublicId: string;
    isHead: boolean;
    name?: { readonly en: string | null; readonly hi: string | null };
    gotra?: string;
    city?: string;
    state?: string;
    photoUrl?: string | null;
    phoneLast4?: string;
  } = {
    memberId: projection.memberId,
    familyPublicId: projection.familyPublicId,
    isHead: projection.isHead,
  };
  if (projection.name !== undefined) {
    view.name = { en: projection.name.en, hi: projection.name.hi };
  }
  if (projection.gotra !== undefined) view.gotra = projection.gotra;
  if (projection.city !== undefined) view.city = projection.city;
  if (projection.state !== undefined) view.state = projection.state;
  if (projection.photoUrl !== undefined) view.photoUrl = projection.photoUrl;
  if (projection.phoneE164 !== undefined) view.phoneLast4 = maskPhone(projection.phoneE164);
  return view;
}
function requireDependency<T>(value: T | undefined): T {
  if (value === undefined) throw new AppError("INTERNAL", 500);
  return value;
}

function recordIdsForFlag(
  subjectType: string,
  subjectId: string,
  relatedIds: readonly string[],
): string[] {
  const ids = subjectType === "MEMBER" ? [subjectId, ...relatedIds] : [...relatedIds];
  return [...new Set(ids)];
}
const PROCESSING_SUBJECT_BY_ACTION: Record<ProcessingAction, ProcessingSubjectType> = {
  MEMBER_ERASED: "MEMBER",
  ERASURE_REQUESTED: "MEMBER",
  FLAG_RESOLVED: "FLAG",
  IMAGE_REMOVED: "IMAGE",
  IMAGE_OVERRIDE_APPROVED: "IMAGE",
  OFFICER_IMAGES_VIEWED: "IMAGE",
  OFFICER_MEMBER_LOOKUP: "MEMBER",
  NOMINEE_READ: "MEMBER",
  REFUND_REQUESTED: "PAYMENT",
  HEAD_SUCCEEDED: "FAMILY",
  FAMILY_ARCHIVED: "FAMILY",
  MEMBER_ARCHIVED: "MEMBER",
  MEMBER_UNARCHIVED: "MEMBER",
  SUSPENSION_LIFTED: "SUSPENSION",
  NOTICE_RESTORED: "NOTICE",
  ARCHIVAL_RESOLVED_BY_OFFICER: "ARCHIVAL_REQUEST",
  ROLE_GRANTED: "MEMBER",
  ROLE_REVOKED: "MEMBER",
  BLOOD_SOS_REPORT_RESOLVED: "BLOOD_SOS",
  PASS_REVOKED: "EVENT_PASS",
};

function processingSubjectType(entry: ProcessingEntry): ProcessingSubjectType {
  return entry.subjectType ?? PROCESSING_SUBJECT_BY_ACTION[entry.action];
}

export class OfficerService implements ProcessingRecordWriter {
  private readonly db: PrismaClient;
  private readonly clock: Clock;
  private readonly retentionDaysConsentAndLogs: number;
  private readonly register: OfficerRegisterPort;
  private readonly media: OfficerMediaPort | undefined;
  private readonly payments: OfficerPaymentsPort | undefined;
  private readonly identity: OfficerIdentityPort | undefined;
  private readonly memberLookup: OfficerMemberLookupPort | undefined;
  private readonly erasureRequests: OfficerErasureRequestPort | undefined;
  private readonly suspensions: OfficerSuspensionPort | undefined;
  private readonly archivals: OfficerArchivalPort | undefined;
  private readonly reports: OfficerReportPort | undefined;
  private readonly bloodSos: OfficerBloodSosPort | undefined;

  constructor(deps: OfficerServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.retentionDaysConsentAndLogs = deps.retentionDaysConsentAndLogs;
    this.register = deps.register;
    this.media = deps.media;
    this.payments = deps.payments;
    this.identity = deps.identity;
    this.memberLookup = deps.memberLookup;
    this.erasureRequests = deps.erasureRequests;
    this.suspensions = deps.suspensions;
    this.archivals = deps.archivals;
    this.reports = deps.reports;
    this.bloodSos = deps.bloodSos;
  }

  async withTransaction<T>(callback: (tx: OfficerTransaction) => Promise<T>): Promise<T> {
    return this.db.$transaction(callback);
  }

  async write(tx: OfficerTransaction, entry: ProcessingEntry): Promise<void> {
    const now = this.clock.now();
    const retainUntil = addMilliseconds(now, this.retentionDaysConsentAndLogs * DAY_MS);
    await tx.processingRecord.create({
      data: {
        id: uuidv7(),
        at: now,
        actorKind: entry.actor.kind,
        actorId: entry.actor.kind === "SYSTEM" ? null : entry.actor.id,
        action: entry.action,
        subjectType: processingSubjectType(entry),
        subjectId: entry.subjectId,
        reason: entry.reason ?? null,
        ...(entry.metadata === undefined ? {} : { metadata: { ...entry.metadata } }),
        retainUntil,
      },
    });
  }


  async raiseFlag(
    tx: OfficerTransaction,
    input: {
      readonly kind: FlagKind;
      readonly subjectType: string;
      readonly subjectId: string;
      readonly relatedIds?: readonly string[];
    },
  ): Promise<void> {
    await tx.flag.create({
      data: {
        id: uuidv7(),
        kind: input.kind,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        ...(input.relatedIds === undefined ? {} : { relatedIds: [...input.relatedIds] }),
        createdAt: this.clock.now(),
      },
    });
  }

  async listFlags(officerId: string, input: FlagsQueryInput): Promise<FlagPage> {
    const offset = pageOffset(input.cursor);
    return this.withTransaction(async (tx) => {
      const rows = await tx.flag.findMany({
        where: { status: input.status },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: input.limit + 1,
      });
      const pageRows = rows.slice(0, input.limit);
      const ids = pageRows.flatMap((row) => {
        const relatedIds = stringIds(row.relatedIds);
        return recordIdsForFlag(row.subjectType, row.subjectId, relatedIds);
      });
      const projections = ids.length === 0
        ? new Map<string, MemberProjection>()
        : await this.register.project(officerId, ids);
      for (const memberId of ids) {
        await this.write(tx, {
          action: "OFFICER_MEMBER_LOOKUP",
          subjectType: "MEMBER",
          subjectId: memberId,
          actor: { kind: "OFFICER", id: officerId },
          metadata: { source: "FLAG_QUEUE" },
        });
      }
      const items: FlagView[] = pageRows.map((row) => {
        const relatedIds = stringIds(row.relatedIds);
        return {
          id: row.id,
          kind: flagKind(row.kind),
          status: flagStatus(row.status),
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          relatedIds,
          createdAt: row.createdAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
          resolvedBy: row.resolvedBy,
          resolution: flagResolution(row.resolution),
          note: row.note,
          subject: row.subjectType === "MEMBER"
            ? officerView(projections.get(row.subjectId))
            : null,
          relatedMembers: relatedIds.flatMap((id) => {
            const view = officerView(projections.get(id));
            return view === null ? [] : [view];
          }),
        };
      });
      return {
        items,
        nextCursor: nextPageCursor(offset + input.limit, rows.length > input.limit),
      };
    });
  }

  async resolveFlag(
    flagId: string,
    officerId: string,
    input: ResolveFlagInput,
  ): Promise<void> {
    await this.withTransaction(async (tx) => {
      const flag = await tx.flag.findUnique({ where: { id: flagId } });
      if (flag === null) throw new AppError("FLAG_NOT_FOUND", 404);
      if (flag.status === "RESOLVED") throw new AppError("FLAG_ALREADY_RESOLVED", 409);
      if (input.outcome === "ERASED_MEMBER") {
        if (flag.subjectType !== "MEMBER") throw new AppError("VALIDATION_FAILED", 400);
        await this.register.eraseMember(tx, flag.subjectId, {
          kind: "OFFICER",
          officerId,
        });
      }
      await tx.flag.update({
        where: { id: flagId },
        data: {
          status: "RESOLVED",
          resolvedAt: this.clock.now(),
          resolvedBy: officerId,
          resolution: input.outcome,
          note: input.note,
        },
      });
      await this.write(tx, {
        action: "FLAG_RESOLVED",
        subjectType: "FLAG",
        subjectId: flagId,
        actor: { kind: "OFFICER", id: officerId },
        reason: input.note,
        metadata: { outcome: input.outcome },
      });
    });
  }

  async listErasureRequests(
    officerId: string,
    input: ErasureRequestsQueryInput,
  ): Promise<ErasureRequestPage> {
    const source = requireDependency(this.erasureRequests);
    const page = await source.list(input);
    const ids = page.items.map((item) => item.memberId);
    const projections = ids.length === 0
      ? new Map<string, MemberProjection>()
      : await this.register.project(officerId, ids);
    await this.withTransaction(async (tx) => {
      for (const memberId of ids) {
        await this.write(tx, {
          action: "OFFICER_MEMBER_LOOKUP",
          subjectType: "MEMBER",
          subjectId: memberId,
          actor: { kind: "OFFICER", id: officerId },
          metadata: { source: "ERASURE_QUEUE" },
        });
      }
    });
    return {
      items: page.items.map((item) => ({
        id: item.id,
        memberId: item.memberId,
        source: item.source,
        status: item.status,
        requestedAt: item.requestedAt.toISOString(),
        member: officerView(projections.get(item.memberId)),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async eraseMember(
    memberId: string,
    officerId: string,
    input: EraseMemberInput,
  ): Promise<void> {
    input.reason.trim();
    await this.withTransaction(async (tx) => {
      const erasureRequestId = input.erasureRequestId;
      let validatedRequestId: string | undefined;
      if (erasureRequestId !== undefined) {
        const request = await tx.erasureRequest.findFirst({
          where: {
            id: erasureRequestId,
            memberId,
            status: "PENDING",
          },
          select: { id: true },
        });
        if (request === null) throw new AppError("FORBIDDEN", 403);
        validatedRequestId = request.id;
      }
      await this.register.eraseMember(tx, memberId, {
        kind: "OFFICER",
        officerId,
      }, validatedRequestId);
    });
  }

  async lookupMembers(
    officerId: string,
    input: MemberLookupQueryInput,
  ): Promise<MemberLookupPage> {
    const source = requireDependency(this.memberLookup);
    const page = await source.lookup(input);
    const projections = page.memberIds.length === 0
      ? new Map<string, MemberProjection>()
      : await this.register.project(officerId, page.memberIds);
    await this.withTransaction(async (tx) => {
      for (const memberId of page.memberIds) {
        await this.write(tx, {
          action: "OFFICER_MEMBER_LOOKUP",
          subjectType: "MEMBER",
          subjectId: memberId,
          actor: { kind: "OFFICER", id: officerId },
          metadata: {
            queryKind: input.phone !== undefined
              ? "PHONE"
              : input.familyPublicId !== undefined
                ? "FAMILY_PUBLIC_ID"
                : "TEXT",
          },
        });
      }
    });
    return {
      items: page.memberIds.flatMap((memberId) => {
        const member = officerView(projections.get(memberId));
        return member === null ? [] : [{ member }];
      }),
      nextCursor: page.nextCursor,
    };
  }

  async listImages(officerId: string, input: OfficerImagesQueryInput): Promise<{
    readonly items: readonly OfficerMediaImageView[];
    readonly nextCursor: string | null;
  }> {
    const media = requireDependency(this.media);
    if (input.status === undefined) {
      return media.listOfficerImages({
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        limit: input.limit,
        officerMemberId: officerId,
      });
    }
    return media.listOfficerImages({
      status: input.status,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: input.limit,
      officerMemberId: officerId,
    });
  }

  async removeImage(imageId: string, officerId: string, reason: string): Promise<void> {
    const media = requireDependency(this.media);
    await media.removeImage({ imageId, officerMemberId: officerId, reason });
  }

  async approveImage(imageId: string, officerId: string): Promise<void> {
    const media = requireDependency(this.media);
    await media.approveImage({ imageId, officerMemberId: officerId });
  }

  async refundPayment(paymentId: string, officerId: string, _reason: string): Promise<void> {
    _reason.trim();
    const payments = requireDependency(this.payments);
    await this.withTransaction((tx) => payments.refund(
      tx,
      paymentId,
      "OFFICER",
      { kind: "OFFICER", id: officerId },
    ));
  }

  async listProcessingRecords(input: ProcessingRecordQueryInput): Promise<ProcessingRecordPage> {
    const offset = pageOffset(input.cursor);
    const rows = await this.db.processingRecord.findMany({
      where: { subjectId: input.subjectId },
      orderBy: [{ at: "desc" }, { id: "desc" }],
      skip: offset,
      take: input.limit + 1,
    });
    const pageRows = rows.slice(0, input.limit);
    return {
      items: pageRows.map((row) => ({
        id: row.id,
        at: row.at.toISOString(),
        actorKind: processingActorKind(row.actorKind),
        actorId: row.actorId,
        action: processingAction(row.action),
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        reason: row.reason,
        metadata: sanitizeOfficerValue(row.metadata),
        retainUntil: row.retainUntil.toISOString(),
      })),
      nextCursor: nextPageCursor(offset + input.limit, rows.length > input.limit),
    };
  }

  async readNominee(
    memberId: string,
    officerId: string,
    input: NomineeReadInput,
  ): Promise<{ readonly nominee: OfficerMemberView | null }> {
    const nominee = await this.withTransaction((tx) => {
      if (input.archivalRequestId === undefined) {
        return this.register.readNomineeForOfficer(
          tx,
          memberId,
          officerId,
          input.reason,
        );
      }
      return this.register.readNomineeForOfficer(
        tx,
        memberId,
        officerId,
        input.reason,
        input.archivalRequestId,
      );
    });
    return { nominee: officerView(nominee ?? undefined) };
  }

  async unarchiveMember(memberId: string, officerId: string): Promise<{
    readonly successionReverted: false;
  }> {
    return this.withTransaction((tx) => this.register.unarchiveMember(tx, memberId, officerId));
  }

  async listSuspensions(input: SuspensionQueryInput): Promise<{
    readonly items: readonly Record<string, unknown>[];
    readonly nextCursor: string | null;
  }> {
    const page = await requireDependency(this.suspensions).list(input);
    return { items: safeOfficerItems(page.items), nextCursor: page.nextCursor };
  }

  async liftSuspension(
    suspensionId: string,
    officerId: string,
    input: LiftSuspensionInput,
  ): Promise<void> {
    await requireDependency(this.suspensions).lift({
      suspensionId,
      officerId,
      reason: input.reason,
      restoreNotice: input.restoreNotice,
    });
  }

  async listArchivalRequests(input: {
    readonly status: "OPEN" | "ESCALATED" | "RESOLVED";
    readonly cursor?: string;
    readonly limit: number;
  }): Promise<{
    readonly items: readonly Record<string, unknown>[];
    readonly nextCursor: string | null;
  }> {
    const page = await requireDependency(this.archivals).list(input);
    return { items: safeOfficerItems(page.items), nextCursor: page.nextCursor };
  }

  async resolveArchival(
    archivalRequestId: string,
    officerId: string,
    input: ResolveArchivalInput,
  ): Promise<void> {
    await requireDependency(this.archivals).resolve({
      archivalRequestId,
      officerId,
      outcome: input.outcome,
      note: input.note,
    });
  }

  async listReports(input: ReportsQueryInput): Promise<{
    readonly items: readonly Record<string, unknown>[];
    readonly nextCursor: string | null;
  }> {
    const page = await requireDependency(this.reports).list(input);
    return { items: safeOfficerItems(page.items), nextCursor: page.nextCursor };
  }

  async closeBloodSos(
    bloodSosId: string,
    officerId: string,
    reason: string,
  ): Promise<void> {
    await requireDependency(this.bloodSos).close({ bloodSosId, officerId, reason });
  }

  async changeRole(operatorId: string, input: OperatorRoleInput): Promise<void> {
    const identity = requireDependency(this.identity);
    await this.withTransaction(async (tx) => {
      if (input.action === "GRANT") {
        await identity.grantRole(tx, input.memberId, input.role, operatorId);
      } else {
        await identity.revokeRole(tx, input.memberId, input.role, operatorId);
      }
    });
  }

  async purgeExpiredProcessingRecords(): Promise<void> {
    // The app role cannot DELETE processing records; this owner-owned SECURITY
    // DEFINER function deletes only those whose retain_until has passed.
    await this.db.$executeRaw`SELECT public.purge_expired_processing_records()`;
  }
}
