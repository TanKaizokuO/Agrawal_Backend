/**
 * Typed database interface for the Notices module.
 *
 * Models and delegates mirror the Prisma schema. A generated Prisma client
 * is structurally compatible with this seam. The included in-memory adapter
 * enforces partial uniqueness and isolation during tests.
 */

export type NoticeBoardType = "SHOK_SANDESH" | "BUSINESS_LISTING";
export type NoticeStatusType = "DRAFT" | "ACTIVE" | "HIDDEN" | "EXPIRED" | "REMOVED";
export type ArchivalRequestStatusType = "OPEN" | "CONFIRMED" | "REFUTED" | "ESCALATED";

export interface NoticeRow {
  readonly id: string;
  readonly board: NoticeBoardType;
  readonly authorMemberId: string;
  readonly authorFamilyId: string;
  readonly status: NoticeStatusType;
  readonly title: string | null;
  readonly bodyHi: string | null;
  readonly bodyEn: string | null;
  readonly linkedMemberId: string | null;
  readonly imageId: string | null;
  readonly metadata: unknown;
  readonly paymentId: string | null;
  readonly publishedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly hiddenAt: Date | null;
  readonly hiddenReason: string | null;
  readonly createdAt: Date;
}

export interface BusinessListingMetaRow {
  readonly noticeId: string;
  readonly category: string;
  readonly businessCity: string;
  readonly businessCityKey: string;
  readonly businessPhone: string;
  readonly businessAddress: string | null;
}

export interface ArchivalRequestRow {
  readonly id: string;
  readonly noticeMemberId: string | null;
  readonly deceasedMemberId: string;
  readonly familyId: string;
  readonly status: ArchivalRequestStatusType;
  readonly createdAt: Date;
  readonly respondedAt: Date | null;
  readonly respondedBy: string | null;
  readonly escalatedAt: Date | null;
  readonly expiresAt: Date;
}

export interface ReportRow {
  readonly id: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly noticeId: string | null;
  readonly reporterMemberId: string;
  readonly reporterFamilyId: string;
  readonly reason: string;
  readonly createdAt: Date;
}

export interface SuspensionRow {
  readonly id: string;
  readonly memberId: string;
  readonly reason: string;
  readonly activeNoticeId: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly liftedAt: Date | null;
  readonly liftedBy: string | null;
  readonly liftedReason: string | null;
}

export interface NoticeCreateData {
  readonly id: string;
  readonly board: NoticeBoardType;
  readonly authorMemberId: string;
  readonly authorFamilyId: string;
  readonly status?: NoticeStatusType;
  readonly title?: string | null;
  readonly bodyHi?: string | null;
  readonly bodyEn?: string | null;
  readonly linkedMemberId?: string | null;
  readonly imageId?: string | null;
  readonly metadata?: unknown;
  readonly paymentId?: string | null;
  readonly publishedAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly hiddenAt?: Date | null;
  readonly hiddenReason?: string | null;
  readonly createdAt?: Date;
}

export interface ArchivalRequestCreateData {
  readonly id: string;
  readonly noticeMemberId?: string | null;
  readonly deceasedMemberId: string;
  readonly familyId: string;
  readonly status?: ArchivalRequestStatusType;
  readonly createdAt?: Date;
  readonly respondedAt?: Date | null;
  readonly respondedBy?: string | null;
  readonly escalatedAt?: Date | null;
  readonly expiresAt: Date;
}

export interface SuspensionCreateData {
  readonly id: string;
  readonly memberId: string;
  readonly reason: string;
  readonly activeNoticeId?: string | null;
  readonly startsAt?: Date;
  readonly endsAt: Date;
  readonly liftedAt?: Date | null;
  readonly liftedBy?: string | null;
  readonly liftedReason?: string | null;
}

// ---------------------------------------------------------------------------
// Query filters and args
// ---------------------------------------------------------------------------

export interface NoticeWhereInput {
  readonly id?: string;
  readonly imageId?: string;
  readonly board?: NoticeBoardType;
  readonly status?: NoticeStatusType | { readonly in?: readonly NoticeStatusType[]; readonly not?: NoticeStatusType };
  readonly authorMemberId?: string;
  readonly authorFamilyId?: string;
  readonly linkedMemberId?: string | null;
  readonly expiresAt?: { readonly lte?: Date; readonly gt?: Date };
  readonly createdAt?: { readonly gte?: Date; readonly lt?: Date; readonly lte?: Date };
}

export interface NoticeOrderByInput {
  readonly publishedAt?: "asc" | "desc";
  readonly createdAt?: "asc" | "desc";
}

export interface NoticeDelegate {
  create(args: { readonly data: NoticeCreateData }): Promise<NoticeRow>;
  findUnique(args: { readonly where: { readonly id: string } }): Promise<NoticeRow | null>;
  findFirst(args: { readonly where: NoticeWhereInput }): Promise<NoticeRow | null>;
  findMany(args?: {
    readonly where?: NoticeWhereInput;
    readonly orderBy?: NoticeOrderByInput | readonly NoticeOrderByInput[];
    readonly take?: number;
    readonly skip?: number;
    readonly cursor?: { readonly id: string };
  }): Promise<NoticeRow[]>;
  update(args: { readonly where: { readonly id: string }; readonly data: Partial<NoticeRow> }): Promise<NoticeRow>;
  updateMany(args: { readonly where: NoticeWhereInput; readonly data: Partial<NoticeRow> }): Promise<{ readonly count: number }>;
  count(args?: { readonly where?: NoticeWhereInput }): Promise<number>;
  deleteMany(args?: { readonly where?: NoticeWhereInput }): Promise<{ readonly count: number }>;
}

export interface BusinessListingMetaWhereInput {
  readonly noticeId?: string | { readonly in?: readonly string[] };
  readonly category?: string;
  readonly businessCityKey?: string;
}

export interface BusinessListingMetaDelegate {
  create(args: { readonly data: BusinessListingMetaRow }): Promise<BusinessListingMetaRow>;
  findUnique(args: { readonly where: { readonly noticeId: string } }): Promise<BusinessListingMetaRow | null>;
  findMany(args?: { readonly where?: BusinessListingMetaWhereInput }): Promise<BusinessListingMetaRow[]>;
  deleteMany(args?: { readonly where?: BusinessListingMetaWhereInput }): Promise<{ readonly count: number }>;
}

export interface ArchivalRequestWhereInput {
  readonly id?: string;
  readonly deceasedMemberId?: string;
  readonly familyId?: string;
  readonly status?: ArchivalRequestStatusType | { readonly in?: readonly ArchivalRequestStatusType[] };
  readonly expiresAt?: { readonly lte?: Date; readonly gt?: Date };
}

export interface ArchivalRequestOrderByInput {
  readonly createdAt?: "asc" | "desc";
}

export interface ArchivalRequestDelegate {
  create(args: { readonly data: ArchivalRequestCreateData }): Promise<ArchivalRequestRow>;
  findUnique(args: { readonly where: { readonly id: string } }): Promise<ArchivalRequestRow | null>;
  findFirst(args: { readonly where: ArchivalRequestWhereInput }): Promise<ArchivalRequestRow | null>;
  findMany(args?: {
    readonly where?: ArchivalRequestWhereInput;
    readonly orderBy?: ArchivalRequestOrderByInput | readonly ArchivalRequestOrderByInput[];
    readonly take?: number;
    readonly skip?: number;
    readonly cursor?: { readonly id: string };
  }): Promise<ArchivalRequestRow[]>;
  update(args: { readonly where: { readonly id: string }; readonly data: Partial<ArchivalRequestRow> }): Promise<ArchivalRequestRow>;
  updateMany(args: { readonly where: ArchivalRequestWhereInput; readonly data: Partial<ArchivalRequestRow> }): Promise<{ readonly count: number }>;
}

export interface ReportWhereInput {
  readonly id?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly noticeId?: string | null;
  readonly reporterMemberId?: string;
  readonly reporterFamilyId?: string;
}

export interface ReportDelegate {
  create(args: { readonly data: Omit<ReportRow, "createdAt"> & { readonly createdAt?: Date } }): Promise<ReportRow>;
  findUnique(args: { readonly where: { readonly targetId_reporterMemberId: { readonly targetId: string; readonly reporterMemberId: string } } }): Promise<ReportRow | null>;
  findMany(args?: {
    readonly where?: ReportWhereInput;
    readonly orderBy?: { readonly createdAt?: "asc" | "desc" };
    readonly take?: number;
    readonly skip?: number;
    readonly cursor?: { readonly id: string };
  }): Promise<ReportRow[]>;
  count(args?: { readonly where?: ReportWhereInput }): Promise<number>;
  deleteMany(args?: { readonly where?: ReportWhereInput }): Promise<{ readonly count: number }>;
}

export interface SuspensionWhereInput {
  readonly id?: string;
  readonly memberId?: string;
  readonly activeNoticeId?: string | null;
  readonly startsAt?: { readonly lte?: Date };
  readonly endsAt?: { readonly lte?: Date; readonly gt?: Date };
  readonly liftedAt?: null | { readonly not?: null } | Date;
}

export interface SuspensionDelegate {
  create(args: { readonly data: SuspensionCreateData }): Promise<SuspensionRow>;
  findUnique(args: { readonly where: { readonly id: string } }): Promise<SuspensionRow | null>;
  findFirst(args: { readonly where: SuspensionWhereInput }): Promise<SuspensionRow | null>;
  findMany(args?: {
    readonly where?: SuspensionWhereInput;
    readonly orderBy?: { readonly startsAt?: "asc" | "desc"; readonly endsAt?: "asc" | "desc" };
    readonly take?: number;
    readonly skip?: number;
    readonly cursor?: { readonly id: string };
  }): Promise<SuspensionRow[]>;
  update(args: { readonly where: { readonly id: string }; readonly data: Partial<SuspensionRow> }): Promise<SuspensionRow>;
  updateMany(args: { readonly where: SuspensionWhereInput; readonly data: Partial<SuspensionRow> }): Promise<{ readonly count: number }>;
  deleteMany(args?: { readonly where?: SuspensionWhereInput }): Promise<{ readonly count: number }>;
}

interface NoticesDataClient {
  readonly notice: NoticeDelegate;
  readonly businessListingMeta: BusinessListingMetaDelegate;
  readonly archivalRequest: ArchivalRequestDelegate;
  readonly report: ReportDelegate;
  readonly suspension: SuspensionDelegate;
}

export interface NoticesTxClient extends NoticesDataClient {
  /** Locks the posting Member until the surrounding transaction completes. */
  lockMemberForNotice(memberId: string): Promise<boolean>;
}

export interface NoticesDatabase extends NoticesDataClient {
  $transaction<T>(fn: (tx: NoticesTxClient) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// In-Memory Database Implementation (for zero-leak isolated tests)
// ---------------------------------------------------------------------------

export class InMemoryNoticesDatabase implements NoticesDatabase {
  private notices: NoticeRow[] = [];
  private businessListingMetas: BusinessListingMetaRow[] = [];
  private archivalRequests: ArchivalRequestRow[] = [];
  private reports: ReportRow[] = [];
  private suspensions: SuspensionRow[] = [];
  // Shared arrays require serialized snapshots for rollback-safe concurrent transactions.
  private transactionTail: Promise<void> = Promise.resolve();

  readonly notice: NoticeDelegate;
  readonly businessListingMeta: BusinessListingMetaDelegate;
  readonly archivalRequest: ArchivalRequestDelegate;
  readonly report: ReportDelegate;
  readonly suspension: SuspensionDelegate;

  constructor() {
    this.notice = this.createNoticeDelegate();
    this.businessListingMeta = this.createBusinessListingMetaDelegate();
    this.archivalRequest = this.createArchivalRequestDelegate();
    this.report = this.createReportDelegate();
    this.suspension = this.createSuspensionDelegate();
  }

  async $transaction<T>(fn: (tx: NoticesTxClient) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const noticesBackup = [...this.notices];
    const metasBackup = [...this.businessListingMetas];
    const archivalsBackup = [...this.archivalRequests];
    const reportsBackup = [...this.reports];
    const suspensionsBackup = [...this.suspensions];

    try {
      return await fn(this);
    } catch (error) {
      this.notices = noticesBackup;
      this.businessListingMetas = metasBackup;
      this.archivalRequests = archivalsBackup;
      this.reports = reportsBackup;
      this.suspensions = suspensionsBackup;
      throw error;
    } finally {
      release();
    }
  }

  lockMemberForNotice(memberId: string): Promise<boolean> {
    return Promise.resolve(memberId.length > 0);
  }

  private createNoticeDelegate(): NoticeDelegate {
    return {
      create: (args) => {
        const row: NoticeRow = {
          id: args.data.id,
          board: args.data.board,
          authorMemberId: args.data.authorMemberId,
          authorFamilyId: args.data.authorFamilyId,
          status: args.data.status ?? "ACTIVE",
          title: args.data.title ?? null,
          bodyHi: args.data.bodyHi ?? null,
          bodyEn: args.data.bodyEn ?? null,
          linkedMemberId: args.data.linkedMemberId ?? null,
          imageId: args.data.imageId ?? null,
          metadata: args.data.metadata ?? null,
          paymentId: args.data.paymentId ?? null,
          publishedAt: args.data.publishedAt ?? null,
          expiresAt: args.data.expiresAt ?? null,
          hiddenAt: args.data.hiddenAt ?? null,
          hiddenReason: args.data.hiddenReason ?? null,
          createdAt: args.data.createdAt ?? new Date(),
        };
        this.notices.push(row);
        return Promise.resolve(row);
      },
      findUnique: (args) => Promise.resolve(
        this.notices.find((n) => n.id === args.where.id) ?? null,
      ),
      findFirst: (args) => Promise.resolve(
        this.filterNotices(args.where)[0] ?? null,
      ),
      findMany: (args) => Promise.resolve().then(() => {
        let results = this.filterNotices(args?.where);
        if (args?.orderBy) {
          const orderings: readonly NoticeOrderByInput[] =
            Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
          for (const ord of orderings) {
            if (ord.publishedAt) {
              const dir = ord.publishedAt === "desc" ? -1 : 1;
              results.sort((a, b) => {
                const at = a.publishedAt?.getTime() ?? 0;
                const bt = b.publishedAt?.getTime() ?? 0;
                return (at - bt) * dir;
              });
            } else if (ord.createdAt) {
              const dir = ord.createdAt === "desc" ? -1 : 1;
              results.sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) * dir);
            }
          }
        }
        const cursor = args?.cursor;
        if (cursor) {
          const idx = results.findIndex((row) => row.id === cursor.id);
          if (idx !== -1) results = results.slice(idx + 1);
        }
        if (args?.skip) {
          results = results.slice(args.skip);
        }
        if (args?.take !== undefined) {
          results = results.slice(0, args.take);
        }
        return results;
      }),
      update: (args) => Promise.resolve().then(() => {
        const idx = this.notices.findIndex((n) => n.id === args.where.id);
        const current = this.notices[idx];
        if (current === undefined) throw new Error(`Notice not found: ${args.where.id}`);
        const updated: NoticeRow = { ...current, ...args.data };
        this.notices[idx] = updated;
        return updated;
      }),
      updateMany: (args) => Promise.resolve().then(() => {
        const matches = this.filterNotices(args.where);
        for (const match of matches) {
          const idx = this.notices.findIndex((n) => n.id === match.id);
          const current = this.notices[idx];
          if (current !== undefined) {
            this.notices[idx] = { ...current, ...args.data };
          }
        }
        return { count: matches.length };
      }),
      count: (args) => Promise.resolve(this.filterNotices(args?.where).length),
      deleteMany: (args) => Promise.resolve().then(() => {
        const initial = this.notices.length;
        const toDelete = new Set(this.filterNotices(args?.where).map((n) => n.id));
        this.notices = this.notices.filter((n) => !toDelete.has(n.id));
        return { count: initial - this.notices.length };
      }),
    };
  }

  private filterNotices(where?: NoticeWhereInput): NoticeRow[] {
    if (!where) return [...this.notices];
    return this.notices.filter((n) => {
      if (where.id !== undefined && n.id !== where.id) return false;
      if (where.imageId !== undefined && n.imageId !== where.imageId) return false;
      if (where.board !== undefined && n.board !== where.board) return false;
      if (where.status !== undefined) {
        if (typeof where.status === "string") {
          if (n.status !== where.status) return false;
        } else {
          if (where.status.in && !where.status.in.includes(n.status)) return false;
          if (where.status.not && n.status === where.status.not) return false;
        }
      }
      if (where.authorMemberId !== undefined && n.authorMemberId !== where.authorMemberId) return false;
      if (where.authorFamilyId !== undefined && n.authorFamilyId !== where.authorFamilyId) return false;
      if (where.linkedMemberId !== undefined && n.linkedMemberId !== where.linkedMemberId) return false;
      if (where.expiresAt?.lte && (!n.expiresAt || n.expiresAt > where.expiresAt.lte)) return false;
      if (where.expiresAt?.gt && (!n.expiresAt || n.expiresAt <= where.expiresAt.gt)) return false;
      if (where.createdAt?.gte && n.createdAt < where.createdAt.gte) return false;
      if (where.createdAt?.lt && n.createdAt >= where.createdAt.lt) return false;
      if (where.createdAt?.lte && n.createdAt > where.createdAt.lte) return false;
      return true;
    });
  }

  private createBusinessListingMetaDelegate(): BusinessListingMetaDelegate {
    return {
      create: (args) => {
        this.businessListingMetas.push(args.data);
        return Promise.resolve(args.data);
      },
      findUnique: (args) => Promise.resolve(
        this.businessListingMetas.find((m) => m.noticeId === args.where.noticeId) ?? null,
      ),
      findMany: (args) => Promise.resolve().then(() => {
        if (!args?.where) return [...this.businessListingMetas];
        return this.businessListingMetas.filter((m) => {
          if (args.where?.noticeId) {
            if (typeof args.where.noticeId === "string") {
              if (m.noticeId !== args.where.noticeId) return false;
            } else if (args.where.noticeId.in && !args.where.noticeId.in.includes(m.noticeId)) {
              return false;
            }
          }
          if (args.where?.category && m.category !== args.where.category) return false;
          if (args.where?.businessCityKey && m.businessCityKey !== args.where.businessCityKey) return false;
          return true;
        });
      }),
      deleteMany: (args) => Promise.resolve().then(() => {
        const initial = this.businessListingMetas.length;
        if (!args?.where) {
          this.businessListingMetas = [];
          return { count: initial };
        }
        this.businessListingMetas = this.businessListingMetas.filter((m) => {
          if (args.where?.noticeId) {
            if (typeof args.where.noticeId === "string" && m.noticeId === args.where.noticeId) return false;
            if (typeof args.where.noticeId === "object" && args.where.noticeId.in?.includes(m.noticeId)) return false;
          }
          return true;
        });
        return { count: initial - this.businessListingMetas.length };
      }),
    };
  }

  private createArchivalRequestDelegate(): ArchivalRequestDelegate {
    return {
      create: (args) => Promise.resolve().then(() => {
        // Enforce DB partial unique index: archival_request_one_open (status IN ('OPEN', 'ESCALATED'))
        const status = args.data.status ?? "OPEN";
        if (status === "OPEN" || status === "ESCALATED") {
          const existing = this.archivalRequests.find(
            (r) => r.deceasedMemberId === args.data.deceasedMemberId && (r.status === "OPEN" || r.status === "ESCALATED"),
          );
          if (existing) {
            const error = Object.assign(new Error("Unique constraint failed on archival_request_one_open"), {
              code: "P2002",
            });
            throw error;
          }
        }
        const row: ArchivalRequestRow = {
          id: args.data.id,
          noticeMemberId: args.data.noticeMemberId ?? null,
          deceasedMemberId: args.data.deceasedMemberId,
          familyId: args.data.familyId,
          status: args.data.status ?? "OPEN",
          createdAt: args.data.createdAt ?? new Date(),
          respondedAt: args.data.respondedAt ?? null,
          respondedBy: args.data.respondedBy ?? null,
          escalatedAt: args.data.escalatedAt ?? null,
          expiresAt: args.data.expiresAt,
        };
        this.archivalRequests.push(row);
        return row;
      }),
      findUnique: (args) => Promise.resolve(
        this.archivalRequests.find((r) => r.id === args.where.id) ?? null,
      ),
      findFirst: (args) => Promise.resolve(
        this.filterArchivalRequests(args.where)[0] ?? null,
      ),
      findMany: (args) => Promise.resolve().then(() => {
        let results = this.filterArchivalRequests(args?.where);
        if (args?.orderBy) {
          const orderings: readonly ArchivalRequestOrderByInput[] =
            Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
          const ord = orderings[0];
          if (ord?.createdAt) {
            const dir = ord.createdAt === "desc" ? -1 : 1;
            results.sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) * dir);
          }
        }
        const cursor = args?.cursor;
        if (cursor) {
          const idx = results.findIndex((row) => row.id === cursor.id);
          if (idx !== -1) results = results.slice(idx + 1);
        }
        if (args?.skip) results = results.slice(args.skip);
        if (args?.take !== undefined) results = results.slice(0, args.take);
        return results;
      }),
      update: (args) => Promise.resolve().then(() => {
        const idx = this.archivalRequests.findIndex((r) => r.id === args.where.id);
        const current = this.archivalRequests[idx];
        if (current === undefined) throw new Error(`ArchivalRequest not found: ${args.where.id}`);
        const updated: ArchivalRequestRow = { ...current, ...args.data };
        this.archivalRequests[idx] = updated;
        return updated;
      }),
      updateMany: (args) => Promise.resolve().then(() => {
        const matches = this.filterArchivalRequests(args.where);
        for (const match of matches) {
          const idx = this.archivalRequests.findIndex((r) => r.id === match.id);
          const current = this.archivalRequests[idx];
          if (current !== undefined) {
            this.archivalRequests[idx] = { ...current, ...args.data };
          }
        }
        return { count: matches.length };
      }),
    };
  }

  private filterArchivalRequests(where?: ArchivalRequestWhereInput): ArchivalRequestRow[] {
    if (!where) return [...this.archivalRequests];
    return this.archivalRequests.filter((r) => {
      if (where.id !== undefined && r.id !== where.id) return false;
      if (where.deceasedMemberId !== undefined && r.deceasedMemberId !== where.deceasedMemberId) return false;
      if (where.familyId !== undefined && r.familyId !== where.familyId) return false;
      if (where.status !== undefined) {
        if (typeof where.status === "string") {
          if (r.status !== where.status) return false;
        } else if (where.status.in && !where.status.in.includes(r.status)) {
          return false;
        }
      }
      if (where.expiresAt?.lte && r.expiresAt > where.expiresAt.lte) return false;
      if (where.expiresAt?.gt && r.expiresAt <= where.expiresAt.gt) return false;
      return true;
    });
  }

  private createReportDelegate(): ReportDelegate {
    return {
      create: (args) => Promise.resolve().then(() => {
        // Enforce unique constraint [targetId, reporterMemberId]
        const existing = this.reports.find(
          (rep) => rep.targetId === args.data.targetId && rep.reporterMemberId === args.data.reporterMemberId,
        );
        if (existing) {
          const error = Object.assign(new Error("Unique constraint failed on report_target_reporter_key"), {
            code: "P2002",
          });
          throw error;
        }
        const row: ReportRow = {
          ...args.data,
          createdAt: args.data.createdAt ?? new Date(),
        };
        this.reports.push(row);
        return row;
      }),
      findUnique: (args) => Promise.resolve().then(() => {
        const { targetId, reporterMemberId } = args.where.targetId_reporterMemberId;
        return this.reports.find((r) => r.targetId === targetId && r.reporterMemberId === reporterMemberId) ?? null;
      }),
      findMany: (args) => Promise.resolve().then(() => {
        let results = this.reports.filter((rep) => {
          if (args?.where?.targetType && rep.targetType !== args.where.targetType) return false;
          if (args?.where?.targetId && rep.targetId !== args.where.targetId) return false;
          if (args?.where?.noticeId !== undefined && rep.noticeId !== args.where.noticeId) return false;
          if (args?.where?.reporterMemberId && rep.reporterMemberId !== args.where.reporterMemberId) return false;
          if (args?.where?.reporterFamilyId && rep.reporterFamilyId !== args.where.reporterFamilyId) return false;
          return true;
        });
        if (args?.orderBy?.createdAt) {
          const dir = args.orderBy.createdAt === "desc" ? -1 : 1;
          results.sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) * dir);
        }
        const cursor = args?.cursor;
        if (cursor) {
          const idx = results.findIndex((row) => row.id === cursor.id);
          if (idx !== -1) results = results.slice(idx + 1);
        }
        if (args?.skip) results = results.slice(args.skip);
        if (args?.take !== undefined) results = results.slice(0, args.take);
        return results;
      }),
      count: (args) => Promise.resolve().then(() => {
        if (!args?.where) return this.reports.length;
        return this.reports.filter((rep) => {
          if (args.where?.targetType && rep.targetType !== args.where.targetType) return false;
          if (args.where?.targetId && rep.targetId !== args.where.targetId) return false;
          if (args.where?.noticeId !== undefined && rep.noticeId !== args.where.noticeId) return false;
          if (args.where?.reporterMemberId && rep.reporterMemberId !== args.where.reporterMemberId) return false;
          if (args.where?.reporterFamilyId && rep.reporterFamilyId !== args.where.reporterFamilyId) return false;
          return true;
        }).length;
      }),
      deleteMany: (args) => Promise.resolve().then(() => {
        const initial = this.reports.length;
        if (!args?.where) {
          this.reports = [];
          return { count: initial };
        }
        this.reports = this.reports.filter((rep) => {
          if (args.where?.reporterMemberId && rep.reporterMemberId === args.where.reporterMemberId) return false;
          if (args.where?.noticeId && rep.noticeId === args.where.noticeId) return false;
          return true;
        });
        return { count: initial - this.reports.length };
      }),
    };
  }

  private createSuspensionDelegate(): SuspensionDelegate {
    return {
      create: (args) => Promise.resolve().then(() => {
        const row: SuspensionRow = {
          id: args.data.id,
          memberId: args.data.memberId,
          reason: args.data.reason,
          activeNoticeId: args.data.activeNoticeId ?? null,
          startsAt: args.data.startsAt ?? new Date(),
          endsAt: args.data.endsAt,
          liftedAt: args.data.liftedAt ?? null,
          liftedBy: args.data.liftedBy ?? null,
          liftedReason: args.data.liftedReason ?? null,
        };
        this.suspensions.push(row);
        return row;
      }),
      findUnique: (args) => Promise.resolve(
        this.suspensions.find((s) => s.id === args.where.id) ?? null,
      ),
      findFirst: (args) => Promise.resolve(
        this.filterSuspensions(args.where)[0] ?? null,
      ),
      findMany: (args) => Promise.resolve().then(() => {
        let results = this.filterSuspensions(args?.where);
        if (args?.orderBy?.startsAt) {
          const dir = args.orderBy.startsAt === "desc" ? -1 : 1;
          results.sort((a, b) => (a.startsAt.getTime() - b.startsAt.getTime()) * dir);
        }
        const cursor = args?.cursor;
        if (cursor) {
          const idx = results.findIndex((row) => row.id === cursor.id);
          if (idx !== -1) results = results.slice(idx + 1);
        }
        if (args?.skip) results = results.slice(args.skip);
        if (args?.take !== undefined) results = results.slice(0, args.take);
        return results;
      }),
      update: (args) => Promise.resolve().then(() => {
        const idx = this.suspensions.findIndex((s) => s.id === args.where.id);
        const current = this.suspensions[idx];
        if (current === undefined) throw new Error(`Suspension not found: ${args.where.id}`);
        const updated: SuspensionRow = { ...current, ...args.data };
        this.suspensions[idx] = updated;
        return updated;
      }),
      updateMany: (args) => Promise.resolve().then(() => {
        const matches = this.filterSuspensions(args.where);
        for (const match of matches) {
          const idx = this.suspensions.findIndex((s) => s.id === match.id);
          const current = this.suspensions[idx];
          if (current !== undefined) {
            this.suspensions[idx] = { ...current, ...args.data };
          }
        }
        return { count: matches.length };
      }),
      deleteMany: (args) => Promise.resolve().then(() => {
        const initial = this.suspensions.length;
        if (!args?.where) {
          this.suspensions = [];
          return { count: initial };
        }
        this.suspensions = this.suspensions.filter((s) => {
          if (args.where?.memberId && s.memberId === args.where.memberId) return false;
          return true;
        });
        return { count: initial - this.suspensions.length };
      }),
    };
  }

  private filterSuspensions(where?: SuspensionWhereInput): SuspensionRow[] {
    if (!where) return [...this.suspensions];
    return this.suspensions.filter((s) => {
      if (where.id !== undefined && s.id !== where.id) return false;
      if (where.memberId !== undefined && s.memberId !== where.memberId) return false;
      if (where.activeNoticeId !== undefined && s.activeNoticeId !== where.activeNoticeId) return false;
      if (where.startsAt?.lte && s.startsAt > where.startsAt.lte) return false;
      if (where.endsAt?.gt && s.endsAt <= where.endsAt.gt) return false;
      if (where.endsAt?.lte && s.endsAt > where.endsAt.lte) return false;
      if (where.liftedAt === null && s.liftedAt !== null) return false;
      if (where.liftedAt && typeof where.liftedAt === "object" && "not" in where.liftedAt && s.liftedAt === null) return false;
      return true;
    });
  }
}
