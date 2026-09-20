import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type {
  ArchivalRequestCreateData,
  ArchivalRequestDelegate,
  ArchivalRequestOrderByInput,
  ArchivalRequestRow,
  ArchivalRequestWhereInput,
  BusinessListingMetaDelegate,
  BusinessListingMetaRow,
  BusinessListingMetaWhereInput,
  NoticeCreateData,
  NoticeDelegate,
  NoticeOrderByInput,
  NoticeRow,
  NoticeWhereInput,
  NoticesDatabase,
  NoticesRegisterPort,
  NoticesTxClient,
  ReportDelegate,
  ReportRow,
  ReportWhereInput,
  SuspensionDelegate,
  SuspensionRow,
  SuspensionWhereInput,
} from "../modules/notices/index.js";
import type { Actor, RegisterService } from "../modules/register/index.js";
import { isRecord } from "./guards.js";

function jsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (isRecord(value)) {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = jsonValue(item);
    }
    return result;
  }
  return JSON.stringify(value);
}

function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) return Prisma.JsonNull;
  const result = jsonValue(value);
  return result === null ? Prisma.JsonNull : result;
}

function isNoticeOrderByArray(input: NoticeOrderByInput | readonly NoticeOrderByInput[]): input is readonly NoticeOrderByInput[] {
  return Array.isArray(input);
}

function isArchivalOrderByArray(input: ArchivalRequestOrderByInput | readonly ArchivalRequestOrderByInput[]): input is readonly ArchivalRequestOrderByInput[] {
  return Array.isArray(input);
}

function noticeWhere(input: NoticeWhereInput | undefined): Prisma.NoticeWhereInput | undefined {
  if (input === undefined) return undefined;
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.board === undefined ? {} : { board: input.board }),
    ...(input.status === undefined
      ? {}
      : typeof input.status === "string"
        ? { status: input.status }
        : { status: { ...(input.status.in === undefined ? {} : { in: [...input.status.in] }), ...(input.status.not === undefined ? {} : { not: input.status.not }) } }),
    ...(input.authorMemberId === undefined ? {} : { authorMemberId: input.authorMemberId }),
    ...(input.authorFamilyId === undefined ? {} : { authorFamilyId: input.authorFamilyId }),
    ...(input.linkedMemberId === undefined ? {} : { linkedMemberId: input.linkedMemberId }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  };
}

function noticeOrderBy(input: NoticeOrderByInput | readonly NoticeOrderByInput[] | undefined): Prisma.NoticeOrderByWithRelationInput | Prisma.NoticeOrderByWithRelationInput[] | undefined {
  if (input === undefined) return undefined;
  if (isNoticeOrderByArray(input)) {
    const list: Prisma.NoticeOrderByWithRelationInput[] = [];
    for (const item of input) {
      list.push({
        ...(item.publishedAt === undefined ? {} : { publishedAt: item.publishedAt }),
        ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
      });
    }
    return list;
  }
  return {
    ...(input.publishedAt === undefined ? {} : { publishedAt: input.publishedAt }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  };
}

function metaWhere(input: BusinessListingMetaWhereInput | undefined): Prisma.BusinessListingMetaWhereInput | undefined {
  if (input === undefined) return undefined;
  const result: Prisma.BusinessListingMetaWhereInput = {};
  if (input.noticeId !== undefined) {
    if (typeof input.noticeId === "string") {
      result.noticeId = input.noticeId;
    } else if (input.noticeId.in !== undefined) {
      result.noticeId = { in: [...input.noticeId.in] };
    }
  }
  if (input.category !== undefined) {
    result.category = input.category;
  }
  if (input.businessCityKey !== undefined) {
    result.businessCityKey = input.businessCityKey;
  }
  return result;
}

function archivalWhere(input: ArchivalRequestWhereInput | undefined): Prisma.ArchivalRequestWhereInput | undefined {
  if (input === undefined) return undefined;
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.deceasedMemberId === undefined ? {} : { deceasedMemberId: input.deceasedMemberId }),
    ...(input.familyId === undefined ? {} : { familyId: input.familyId }),
    ...(input.status === undefined
      ? {}
      : typeof input.status === "string"
        ? { status: input.status }
        : input.status.in === undefined
          ? {}
          : { status: { in: [...input.status.in] } }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
}

function archivalOrderBy(input: ArchivalRequestOrderByInput | readonly ArchivalRequestOrderByInput[] | undefined): Prisma.ArchivalRequestOrderByWithRelationInput | Prisma.ArchivalRequestOrderByWithRelationInput[] | undefined {
  if (input === undefined) return undefined;
  if (isArchivalOrderByArray(input)) {
    const list: Prisma.ArchivalRequestOrderByWithRelationInput[] = [];
    for (const item of input) {
      list.push({
        ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
      });
    }
    return list;
  }
  return {
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
  };
}

function reportWhere(input: ReportWhereInput | undefined): Prisma.ReportWhereInput | undefined {
  if (input === undefined) return undefined;
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.targetType === undefined ? {} : { targetType: input.targetType }),
    ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
    ...(input.noticeId === undefined ? {} : { noticeId: input.noticeId }),
    ...(input.reporterMemberId === undefined ? {} : { reporterMemberId: input.reporterMemberId }),
    ...(input.reporterFamilyId === undefined ? {} : { reporterFamilyId: input.reporterFamilyId }),
  };
}

function suspensionWhere(input: SuspensionWhereInput | undefined): Prisma.SuspensionWhereInput | undefined {
  if (input === undefined) return undefined;
  return {
    ...(input.id === undefined ? {} : { id: input.id }),
    ...(input.memberId === undefined ? {} : { memberId: input.memberId }),
    ...(input.activeNoticeId === undefined ? {} : { activeNoticeId: input.activeNoticeId }),
    ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
    ...(input.endsAt === undefined ? {} : { endsAt: input.endsAt }),
    ...(input.liftedAt === undefined ? {} : { liftedAt: input.liftedAt }),
  };
}

function noticeCreate(data: NoticeCreateData): Prisma.NoticeUncheckedCreateInput {
  return {
    id: data.id,
    board: data.board,
    authorMemberId: data.authorMemberId,
    authorFamilyId: data.authorFamilyId,
    ...(data.status === undefined ? {} : { status: data.status }),
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.bodyHi === undefined ? {} : { bodyHi: data.bodyHi }),
    ...(data.bodyEn === undefined ? {} : { bodyEn: data.bodyEn }),
    ...(data.linkedMemberId === undefined ? {} : { linkedMemberId: data.linkedMemberId }),
    ...(data.imageId === undefined ? {} : { imageId: data.imageId }),
    ...(data.metadata === undefined ? {} : { metadata: data.metadata === null ? Prisma.JsonNull : jsonInput(data.metadata) }),
    ...(data.paymentId === undefined ? {} : { paymentId: data.paymentId }),
    ...(data.publishedAt === undefined ? {} : { publishedAt: data.publishedAt }),
    ...(data.expiresAt === undefined ? {} : { expiresAt: data.expiresAt }),
    ...(data.hiddenAt === undefined ? {} : { hiddenAt: data.hiddenAt }),
    ...(data.hiddenReason === undefined ? {} : { hiddenReason: data.hiddenReason }),
    ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
  };
}

function noticeUpdate(data: Partial<NoticeRow>): Prisma.NoticeUncheckedUpdateInput {
  return {
    ...(data.board === undefined ? {} : { board: data.board }),
    ...(data.authorMemberId === undefined ? {} : { authorMemberId: data.authorMemberId }),
    ...(data.authorFamilyId === undefined ? {} : { authorFamilyId: data.authorFamilyId }),
    ...(data.status === undefined ? {} : { status: data.status }),
    ...(data.title === undefined ? {} : { title: data.title }),
    ...(data.bodyHi === undefined ? {} : { bodyHi: data.bodyHi }),
    ...(data.bodyEn === undefined ? {} : { bodyEn: data.bodyEn }),
    ...(data.linkedMemberId === undefined ? {} : { linkedMemberId: data.linkedMemberId }),
    ...(data.imageId === undefined ? {} : { imageId: data.imageId }),
    ...(data.metadata === undefined ? {} : { metadata: data.metadata === null ? Prisma.JsonNull : jsonInput(data.metadata) }),
    ...(data.paymentId === undefined ? {} : { paymentId: data.paymentId }),
    ...(data.publishedAt === undefined ? {} : { publishedAt: data.publishedAt }),
    ...(data.expiresAt === undefined ? {} : { expiresAt: data.expiresAt }),
    ...(data.hiddenAt === undefined ? {} : { hiddenAt: data.hiddenAt }),
    ...(data.hiddenReason === undefined ? {} : { hiddenReason: data.hiddenReason }),
  };
}

function archivalCreate(data: ArchivalRequestCreateData): Prisma.ArchivalRequestUncheckedCreateInput {
  return {
    id: data.id,
    deceasedMemberId: data.deceasedMemberId,
    familyId: data.familyId,
    ...(data.noticeMemberId === undefined ? {} : { noticeMemberId: data.noticeMemberId }),
    ...(data.status === undefined ? {} : { status: data.status }),
    ...(data.createdAt === undefined ? {} : { createdAt: data.createdAt }),
    ...(data.respondedAt === undefined ? {} : { respondedAt: data.respondedAt }),
    ...(data.respondedBy === undefined ? {} : { respondedBy: data.respondedBy }),
    ...(data.escalatedAt === undefined ? {} : { escalatedAt: data.escalatedAt }),
    expiresAt: data.expiresAt,
  };
}

function rowNotice(row: NoticeRow): NoticeRow { return row; }
function rowArchival(row: ArchivalRequestRow): ArchivalRequestRow { return row; }
function rowMeta(row: BusinessListingMetaRow): BusinessListingMetaRow { return row; }
function rowReport(row: ReportRow): ReportRow { return row; }
function rowSuspension(row: SuspensionRow): SuspensionRow { return row; }

export class PrismaNoticesTx implements NoticesTxClient {
  public readonly processingRecord: Pick<Prisma.TransactionClient, "processingRecord">["processingRecord"];
  public readonly rawTx: Prisma.TransactionClient | undefined;
  public readonly notice: NoticeDelegate;
  public readonly businessListingMeta: BusinessListingMetaDelegate;
  public readonly archivalRequest: ArchivalRequestDelegate;
  public readonly report: ReportDelegate;
  public readonly suspension: SuspensionDelegate;

  public constructor(
    private readonly raw: Pick<PrismaClient, "notice" | "businessListingMeta" | "archivalRequest" | "report" | "suspension" | "processingRecord">,
    rawTx?: Prisma.TransactionClient,
  ) {
    this.rawTx = rawTx;
    this.processingRecord = raw.processingRecord;
    this.notice = {
      create: async ({ data }) => rowNotice(await this.raw.notice.create({ data: noticeCreate(data) })),
      findUnique: async ({ where }) => {
        const row = await this.raw.notice.findUnique({ where: { id: where.id } });
        return row === null ? null : rowNotice(row);
      },
      findFirst: async ({ where }) => {
        const whereInput = noticeWhere(where);
        const row = await this.raw.notice.findFirst({
          ...(whereInput === undefined ? {} : { where: whereInput }),
        });
        return row === null ? null : rowNotice(row);
      },
      findMany: async (args) => {
        const where = noticeWhere(args?.where);
        const orderBy = noticeOrderBy(args?.orderBy);
        const cursor = args?.cursor === undefined ? undefined : { id: args.cursor.id };
        const rows = await this.raw.notice.findMany({
          ...(where === undefined ? {} : { where }),
          ...(args?.take === undefined ? {} : { take: args.take }),
          ...(args?.skip === undefined ? {} : { skip: args.skip }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(orderBy === undefined ? {} : { orderBy }),
        });
        return rows.map(rowNotice);
      },
      update: async ({ where, data }) => rowNotice(await this.raw.notice.update({ where: { id: where.id }, data: noticeUpdate(data) })),
      updateMany: async ({ where, data }) => {
        const whereInput = noticeWhere(where);
        return this.raw.notice.updateMany({
          ...(whereInput === undefined ? {} : { where: whereInput }),
          data: noticeUpdate(data),
        });
      },
      count: async (args) => {
        const where = noticeWhere(args?.where);
        return this.raw.notice.count({
          ...(where === undefined ? {} : { where }),
        });
      },
      deleteMany: async (args) => {
        const where = noticeWhere(args?.where);
        return this.raw.notice.deleteMany({
          ...(where === undefined ? {} : { where }),
        });
      },
    };

    this.businessListingMeta = {
      create: async ({ data }) => rowMeta(await this.raw.businessListingMeta.create({ data })),
      findUnique: async ({ where }) => {
        const row = await this.raw.businessListingMeta.findUnique({ where: { noticeId: where.noticeId } });
        return row === null ? null : rowMeta(row);
      },
      findMany: async (args) => {
        const where = metaWhere(args?.where);
        const rows = await this.raw.businessListingMeta.findMany({
          ...(where === undefined ? {} : { where }),
        });
        return rows.map(rowMeta);
      },
      deleteMany: async (args) => {
        const where = metaWhere(args?.where);
        return this.raw.businessListingMeta.deleteMany({
          ...(where === undefined ? {} : { where }),
        });
      },
    };

    this.archivalRequest = {
      create: async ({ data }) => rowArchival(await this.raw.archivalRequest.create({ data: archivalCreate(data) })),
      findUnique: async ({ where }) => {
        const row = await this.raw.archivalRequest.findUnique({ where: { id: where.id } });
        return row === null ? null : rowArchival(row);
      },
      findFirst: async ({ where }) => {
        const whereInput = archivalWhere(where);
        const row = await this.raw.archivalRequest.findFirst({
          ...(whereInput === undefined ? {} : { where: whereInput }),
        });
        return row === null ? null : rowArchival(row);
      },
      findMany: async (args) => {
        const where = archivalWhere(args?.where);
        const orderBy = archivalOrderBy(args?.orderBy);
        const cursor = args?.cursor === undefined ? undefined : { id: args.cursor.id };
        const rows = await this.raw.archivalRequest.findMany({
          ...(where === undefined ? {} : { where }),
          ...(args?.take === undefined ? {} : { take: args.take }),
          ...(args?.skip === undefined ? {} : { skip: args.skip }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(orderBy === undefined ? {} : { orderBy }),
        });
        return rows.map(rowArchival);
      },
      update: async ({ where, data }) => rowArchival(await this.raw.archivalRequest.update({ where: { id: where.id }, data })),
      updateMany: async ({ where, data }) => {
        const whereInput = archivalWhere(where);
        return this.raw.archivalRequest.updateMany({
          ...(whereInput === undefined ? {} : { where: whereInput }),
          data,
        });
      },
    };

    this.report = {
      create: async ({ data }) => rowReport(await this.raw.report.create({ data })),
      findUnique: async ({ where }) => {
        const row = await this.raw.report.findUnique({ where });
        return row === null ? null : rowReport(row);
      },
      findMany: async (args) => {
        const where = reportWhere(args?.where);
        const rows = await this.raw.report.findMany({
          ...(where === undefined ? {} : { where }),
          ...(args?.take === undefined ? {} : { take: args.take }),
          ...(args?.skip === undefined ? {} : { skip: args.skip }),
          ...(args?.cursor === undefined ? {} : { cursor: args.cursor }),
          ...(args?.orderBy === undefined ? {} : { orderBy: args.orderBy }),
        });
        return rows.map(rowReport);
      },
      count: async (args) => {
        const where = reportWhere(args?.where);
        return this.raw.report.count({
          ...(where === undefined ? {} : { where }),
        });
      },
      deleteMany: async (args) => {
        const where = reportWhere(args?.where);
        return this.raw.report.deleteMany({
          ...(where === undefined ? {} : { where }),
        });
      },
    };

    this.suspension = {
      create: async ({ data }) => rowSuspension(await this.raw.suspension.create({ data })),
      findUnique: async ({ where }) => {
        const row = await this.raw.suspension.findUnique({ where: { id: where.id } });
        return row === null ? null : rowSuspension(row);
      },
      findFirst: async ({ where }) => {
        const whereInput = suspensionWhere(where);
        const row = await this.raw.suspension.findFirst({
          ...(whereInput === undefined ? {} : { where: whereInput }),
        });
        return row === null ? null : rowSuspension(row);
      },
      findMany: async (args) => {
        const where = suspensionWhere(args?.where);
        const rows = await this.raw.suspension.findMany({
          ...(where === undefined ? {} : { where }),
          ...(args?.take === undefined ? {} : { take: args.take }),
          ...(args?.skip === undefined ? {} : { skip: args.skip }),
          ...(args?.cursor === undefined ? {} : { cursor: args.cursor }),
          ...(args?.orderBy === undefined ? {} : { orderBy: args.orderBy }),
        });
        return rows.map(rowSuspension);
      },
      update: async ({ where, data }) => rowSuspension(await this.raw.suspension.update({ where: { id: where.id }, data })),
      updateMany: async ({ where, data }) => {
        const whereInput = suspensionWhere(where);
        return this.raw.suspension.updateMany({
          ...(whereInput === undefined ? {} : { where: whereInput }),
          data,
        });
      },
      deleteMany: async (args) => {
        const where = suspensionWhere(args?.where);
        return this.raw.suspension.deleteMany({
          ...(where === undefined ? {} : { where }),
        });
      },
    };
  }
}

export class PrismaNoticesDatabase implements NoticesDatabase {
  public readonly notice: NoticeDelegate;
  public readonly businessListingMeta: BusinessListingMetaDelegate;
  public readonly archivalRequest: ArchivalRequestDelegate;
  public readonly report: ReportDelegate;
  public readonly suspension: SuspensionDelegate;

  public constructor(private readonly raw: PrismaClient) {
    const tx = new PrismaNoticesTx(this.raw);
    this.notice = tx.notice;
    this.businessListingMeta = tx.businessListingMeta;
    this.archivalRequest = tx.archivalRequest;
    this.report = tx.report;
    this.suspension = tx.suspension;
  }

  public async $transaction<T>(fn: (tx: NoticesTxClient) => Promise<T>): Promise<T> {
    return this.raw.$transaction((tx) => fn(new PrismaNoticesTx(tx, tx)));
  }
}

export function createNoticesDatabase(raw: PrismaClient): NoticesDatabase {
  return new PrismaNoticesDatabase(raw);
}

export function createNoticesRegisterAdapter(register: RegisterService): NoticesRegisterPort {
  return {
    isActiveMember: (memberId) => register.isActiveMember(memberId),
    familyOf: (memberId) => register.familyOf(memberId),
    adultMembersOfFamily: (familyId, exceptMemberId) => register.adultMembersOfFamily(familyId, exceptMemberId),
    archiveMember: async (tx, memberId, confirmedBy) => {
      const rawTx = tx instanceof PrismaNoticesTx && tx.rawTx !== undefined
        ? tx.rawTx
        : undefined;
      if (rawTx === undefined) {
        throw new Error("Archive member requires a valid Prisma transaction");
      }
      const actor: Actor = confirmedBy.kind === "OFFICER"
        ? { kind: "OFFICER", officerId: confirmedBy.officerId ?? "" }
        : { kind: "MEMBER", memberId: confirmedBy.memberId ?? "" };
      await register.archiveMember(rawTx, memberId, actor);
    },
    project: (viewerMemberId, memberIds) => register.project(viewerMemberId, memberIds),
    onMemberErased: (handler) => {
      register.onMemberErased(async (prismaTx, memberId) => {
        await handler(new PrismaNoticesTx(prismaTx, prismaTx), memberId);
      });
    },
    onMemberArchived: (handler) => {
      register.onMemberArchived(async (prismaTx, memberId) => {
        await handler(new PrismaNoticesTx(prismaTx, prismaTx), memberId);
      });
    },
  };
}
