import { AppError } from "../../http/errors.js";
import { dateToIstDate } from "../../clock.js";
import type {
  ArchivalRequestRow,
  ArchivalRequestStatusType,
  BusinessListingMetaRow,
  NoticeRow,
  NoticesDatabase,
  NoticesTxClient,
  ReportRow,
  SuspensionRow,
} from "./db.js";
import type {
  BusinessCheckoutOrder,
  NoticeAuthorProjection,
  NoticesBusinessPort,
  NoticesClock,
  NoticesConfig,
  NoticesMediaPort,
  NoticesNotificationsPort,
  NoticesProcessingRecordWriter,
  NoticesRegisterPort,
} from "./ports.js";
import type {
  ArchivalRequestsQueryInput,
  BusinessListingInput,
  BusinessListingListQueryInput,
  LiftSuspensionInput,
  NoticeListQueryInput,
  PaginationQueryInput,
  ReportsQueryInput,
  ReportInput,
  ResolveArchivalInput,
  ShokSandeshInput,
  SuspensionQueryInput,
} from "./schemas.js";

const DAY_MS = 86_400_000;
const FORMER_MEMBER_ID = "00000000-0000-0000-0000-000000000000";

function normalizeCityKey(city: string): string {
  return city.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function escapeRegex(text: string): string {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

function generateUuid(): string {
  return crypto.randomUUID();
}

export interface NoticesServiceDeps {
  readonly db: NoticesDatabase;
  readonly clock: NoticesClock;
  readonly config: NoticesConfig;
  readonly register: NoticesRegisterPort;
  readonly media: NoticesMediaPort;
  readonly business: NoticesBusinessPort;
  readonly notifications: NoticesNotificationsPort;
  readonly processingRecord: NoticesProcessingRecordWriter;
}

export interface NoticeView extends NoticeRow {
  readonly author: NoticeAuthorProjection;
  readonly linkedMember?: NoticeAuthorProjection | null;
  readonly imageUrl: string | null;
}

export interface BusinessListingView {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly businessCity: string;
  readonly businessPhone: string;
  readonly businessAddress: string | null;
  readonly bodyHi: string | null;
  readonly bodyEn: string | null;
  readonly imageId: string | null;
  readonly imageUrl: string | null;
  readonly status: NoticeRow["status"];
  readonly owner: NoticeAuthorProjection;
  readonly publishedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface ArchivalRequestView extends ArchivalRequestRow {
  readonly deceasedMember?: NoticeAuthorProjection | null;
  readonly familyPublicId: string;
}

export class NoticesService {
  readonly db: NoticesDatabase;
  readonly clock: NoticesClock;
  readonly config: NoticesConfig;
  readonly register: NoticesRegisterPort;
  readonly media: NoticesMediaPort;
  readonly business: NoticesBusinessPort;
  readonly notifications: NoticesNotificationsPort;
  readonly processingRecord: NoticesProcessingRecordWriter;

  constructor(deps: NoticesServiceDeps) {
    if (
      typeof deps.business.markConsumed !== "function"
      || typeof deps.business.refund !== "function"
    ) {
      throw new AppError("INTERNAL", 500);
    }
    this.db = deps.db;
    this.clock = deps.clock;
    this.config = deps.config;
    this.register = deps.register;
    this.media = deps.media;
    this.business = deps.business;
    this.notifications = deps.notifications;
    this.processingRecord = deps.processingRecord;

    // Register erasure hook on register port
    this.register.onMemberErased(async (tx, memberId) => {
      await this.handleMemberErased(tx, memberId);
    });
  }

  // ---------------------------------------------------------------------------
  // Validation checks (text check, posting cap, suspension)
  // ---------------------------------------------------------------------------

  private checkText(textParts: readonly (string | null | undefined)[]): void {
    const combined = textParts.filter((t): t is string => Boolean(t && t.trim().length > 0)).join(" ");
    if (combined.length === 0) return;

    for (const blocked of this.config.blockedWords) {
      if (!blocked || blocked.trim().length === 0) continue;
      const pattern = new RegExp(`(?:^|\\W)${escapeRegex(blocked.trim())}(?:$|\\W)`, "iu");
      if (pattern.test(combined)) {
        throw new AppError("NOTICE_CONTAINS_BLOCKED_WORD", 422);
      }
    }

    if (this.config.phoneRegexInText) {
      const phonePattern = new RegExp(this.config.phoneRegexInText, "u");
      if (phonePattern.test(combined)) {
        throw new AppError("NOTICE_CONTAINS_PHONE", 422);
      }
    }
  }

  private async checkPostingCap(memberId: string): Promise<void> {
    const todayIst = this.clock.todayIst();
    // Blood SOS is exempt (it lives in a different module and table).
    // Notices across all boards authored by this member on today's IST calendar day.
    const notices = await this.db.notice.findMany({
      where: { authorMemberId: memberId },
    });
    const todayCount = notices.filter((n) => dateToIstDate(n.createdAt) === todayIst).length;
    if (todayCount >= this.config.postingCapPerDay) {
      throw new AppError("POSTING_CAP_REACHED", 429);
    }
  }

  private async checkSuspension(memberId: string): Promise<void> {
    const active = await this.activeSuspension(memberId);
    if (active !== null) {
      throw new AppError("POSTING_SUSPENDED", 403, {
        endsAt: active.endsAt.toISOString(),
      });
    }
  }

  private checkBoardOpen(): number {
    const fee = this.config.businessListingFeePaise;
    if (!this.business.isBoardOpen() || fee === undefined || fee === null) {
      throw new AppError("BOARD_NOT_OPEN", 503);
    }
    return fee;
  }

  // ---------------------------------------------------------------------------
  // Shok Sandesh (Notices)
  // ---------------------------------------------------------------------------

  async createNotice(
    authorPrincipal: { readonly memberId: string },
    input: ShokSandeshInput,
  ): Promise<{ readonly notice: NoticeView }> {
    await this.checkSuspension(authorPrincipal.memberId);
    await this.checkPostingCap(authorPrincipal.memberId);

    this.checkText([input.title, input.bodyEn, input.bodyHi]);

    const authorFamily = await this.register.familyOf(authorPrincipal.memberId);
    if (authorFamily === null) {
      throw new AppError("UNAUTHENTICATED", 401);
    }

    const now = this.clock.now();
    const noticeId = generateUuid();

    const createdNotice = await this.db.$transaction(async (tx) => {
      // If linkedMemberId is supplied and ACTIVE, open ArchivalRequest
      if (input.linkedMemberId) {
        const isActive = await this.register.isActiveMember(input.linkedMemberId);
        if (isActive) {
          const deceasedFamily = await this.register.familyOf(input.linkedMemberId);
          if (deceasedFamily !== null) {
            const archivalRequestId = generateUuid();
            const expiresAt = new Date(now.getTime() + this.config.archivalEscalationDays * DAY_MS);

            // Create ArchivalRequest (enforces database partial uniqueness)
            await tx.archivalRequest.create({
              data: {
                id: archivalRequestId,
                noticeMemberId: authorPrincipal.memberId,
                deceasedMemberId: input.linkedMemberId,
                familyId: deceasedFamily.familyId,
                status: "OPEN",
                createdAt: now,
                expiresAt,
                respondedAt: null,
                respondedBy: null,
                escalatedAt: null,
              },
            });

            // Notify adult members of deceased's family (excluding Shok Sandesh author)
            const recipientIds = await this.register.adultMembersOfFamily(
              deceasedFamily.familyId,
              authorPrincipal.memberId,
            );
            if (recipientIds.length > 0) {
              await this.notifications.send(recipientIds, {
                topic: "ARCHIVAL_REQUEST",
                subjectId: archivalRequestId,
                title: {
                  en: "Archival request for family member",
                  hi: "परिवार के सदस्य के लिए अभिलेखागार अनुरोध",
                },
                body: {
                  en: "A Shok Sandesh was posted linked to a member of your family.",
                  hi: "आपके परिवार के सदस्य से जुड़ा एक शोक संदेश प्रकाशित हुआ है।",
                },
                data: {},
              });
            }
          }
        }
      }

      return tx.notice.create({
        data: {
          id: noticeId,
          board: "SHOK_SANDESH",
          authorMemberId: authorPrincipal.memberId,
          authorFamilyId: authorFamily.familyId,
          status: "ACTIVE",
          title: input.title ?? null,
          bodyHi: input.bodyHi ?? null,
          bodyEn: input.bodyEn ?? null,
          linkedMemberId: input.linkedMemberId ?? null,
          imageId: input.imageId ?? null,
          metadata: null,
          paymentId: null,
          publishedAt: now,
          expiresAt: null,
          hiddenAt: null,
          hiddenReason: null,
          createdAt: now,
        },
      });
    });

    const view = await this.buildNoticeView(authorPrincipal.memberId, createdNotice);
    return { notice: view };
  }

  async listNotices(
    viewerMemberId: string,
    query: NoticeListQueryInput,
  ): Promise<{ readonly items: readonly NoticeView[]; readonly nextCursor: string | null }> {
    const take = query.limit;
    const notices = await this.db.notice.findMany({
      where: {
        board: query.board,
        status: "ACTIVE",
      },
      orderBy: { publishedAt: "desc" },
      take: take + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor } }),
    });

    const hasMore = notices.length > take;
    const pageItems = hasMore ? notices.slice(0, take) : notices;
    const nextCursor = hasMore ? (pageItems[pageItems.length - 1]?.id ?? null) : null;

    const views = await Promise.all(pageItems.map((n) => this.buildNoticeView(viewerMemberId, n)));
    return { items: views, nextCursor };
  }

  async getNotice(
    viewerMemberId: string,
    noticeId: string,
  ): Promise<{ readonly notice: NoticeView }> {
    const notice = await this.db.notice.findUnique({ where: { id: noticeId } });
    if (notice === null) {
      throw new AppError("NOTICE_NOT_FOUND", 404);
    }
    if (notice.status !== "ACTIVE" && notice.authorMemberId !== viewerMemberId) {
      throw new AppError("NOTICE_NOT_FOUND", 404);
    }

    const view = await this.buildNoticeView(viewerMemberId, notice);
    return { notice: view };
  }

  async reportNotice(
    reporterPrincipal: { readonly memberId: string },
    noticeId: string,
    input: ReportInput,
  ): Promise<{ readonly report: ReportRow }> {
    const notice = await this.db.notice.findUnique({ where: { id: noticeId } });
    if (notice === null || notice.status !== "ACTIVE") {
      throw new AppError("NOTICE_NOT_FOUND", 404);
    }

    const reporterFamily = await this.register.familyOf(reporterPrincipal.memberId);
    if (reporterFamily === null) {
      throw new AppError("UNAUTHENTICATED", 401);
    }

    // Invariant 13: Author's own family cannot report their notice
    if (reporterFamily.familyId === notice.authorFamilyId) {
      throw new AppError("CANNOT_REPORT_OWN", 422);
    }

    const now = this.clock.now();
    const reportId = generateUuid();

    const createdReport = await this.db.$transaction(async (tx) => {
      const existing = await tx.report.findUnique({
        where: {
          targetId_reporterMemberId: {
            targetId: noticeId,
            reporterMemberId: reporterPrincipal.memberId,
          },
        },
      });
      if (existing !== null) {
        throw new AppError("ALREADY_REPORTED", 409);
      }

      const rep = await tx.report.create({
        data: {
          id: reportId,
          targetType: "NOTICE",
          targetId: noticeId,
          noticeId,
          reporterMemberId: reporterPrincipal.memberId,
          reporterFamilyId: reporterFamily.familyId,
          reason: input.reason,
          createdAt: now,
        },
      });

      // Distinct family count excluding author's family
      const allReports = await tx.report.findMany({
        where: { noticeId, targetType: "NOTICE" },
      });
      const distinctFamilies = new Set(
        allReports
          .map((r) => r.reporterFamilyId)
          .filter((fId) => fId !== notice.authorFamilyId),
      );

      if (distinctFamilies.size >= this.config.reportsThreshold) {
        // Hide notice
        await tx.notice.update({
          where: { id: noticeId },
          data: {
            status: "HIDDEN",
            hiddenAt: now,
            hiddenReason: "REPORTS",
          },
        });

        // Create suspension for author
        const suspensionId = generateUuid();
        const endsAt = new Date(now.getTime() + this.config.suspensionDurationDays * DAY_MS);

        await tx.suspension.create({
          data: {
            id: suspensionId,
            memberId: notice.authorMemberId,
            reason: "REPORTS",
            activeNoticeId: notice.id,
            startsAt: now,
            endsAt,
            liftedAt: null,
            liftedBy: null,
            liftedReason: null,
          },
        });

        // Notifications to author
        await this.notifications.send([notice.authorMemberId], {
          topic: "NOTICE_HIDDEN",
          subjectId: notice.id,
          title: {
            en: "Your notice was hidden",
            hi: "आपकी सूचना छिपा दी गई है",
          },
          body: {
            en: "A notice you published received multiple community reports and was hidden.",
            hi: "आपकी प्रकाशित सूचना पर कई रिपोर्ट मिलीं और उसे छिपा दिया गया है।",
          },
          data: {},
        });

        await this.notifications.send([notice.authorMemberId], {
          topic: "SUSPENSION",
          subjectId: suspensionId,
          title: {
            en: "Posting privileges suspended",
            hi: "पोस्ट करने की सुविधा निलंबित कर दी गई है",
          },
          body: {
            en: `Your posting ability is suspended until ${endsAt.toISOString().slice(0, 10)}.`,
            hi: `आपकी पोस्ट करने की सुविधा ${endsAt.toISOString().slice(0, 10)} तक निलंबित है।`,
          },
          data: {},
        });
      }

      return rep;
    });

    return { report: createdReport };
  }

  async reportBloodSos(
    reporterPrincipal: { readonly memberId: string },
    bloodSosId: string,
    input: ReportInput,
  ): Promise<{ readonly report: ReportRow }> {
    const reporterFamily = await this.register.familyOf(reporterPrincipal.memberId);
    if (reporterFamily === null) {
      throw new AppError("UNAUTHENTICATED", 401);
    }

    const now = this.clock.now();
    const reportId = generateUuid();

    const report = await this.db.$transaction(async (tx) => {
      const existing = await tx.report.findUnique({
        where: {
          targetId_reporterMemberId: {
            targetId: bloodSosId,
            reporterMemberId: reporterPrincipal.memberId,
          },
        },
      });
      if (existing !== null) {
        throw new AppError("ALREADY_REPORTED", 409);
      }

      // Blood SOS reports are saved but NEVER auto-hide or trigger suspensions
      return tx.report.create({
        data: {
          id: reportId,
          targetType: "BLOOD_SOS",
          targetId: bloodSosId,
          noticeId: null,
          reporterMemberId: reporterPrincipal.memberId,
          reporterFamilyId: reporterFamily.familyId,
          reason: input.reason,
          createdAt: now,
        },
      });
    });

    return { report };
  }

  // ---------------------------------------------------------------------------
  // Business Listings
  // ---------------------------------------------------------------------------

  async createBusinessListing(
    authorPrincipal: { readonly memberId: string },
    input: BusinessListingInput,
  ): Promise<{ readonly listing: BusinessListingView }> {
    this.checkBoardOpen();
    await this.checkSuspension(authorPrincipal.memberId);
    await this.checkPostingCap(authorPrincipal.memberId);

    if (this.business.checkEligibility) {
      const eligible = await this.business.checkEligibility(authorPrincipal.memberId);
      if (!eligible) throw new AppError("FORBIDDEN", 403);
    }

    // Name (title) and description checked for personal phone numbers and blocked words
    // Business phone is structured and exempt from text regex check
    this.checkText([input.name, input.bodyEn, input.bodyHi]);

    const authorFamily = await this.register.familyOf(authorPrincipal.memberId);
    if (authorFamily === null) {
      throw new AppError("UNAUTHENTICATED", 401);
    }

    const now = this.clock.now();
    const noticeId = generateUuid();
    const cityKey = normalizeCityKey(input.businessCity);

    const { notice, meta } = await this.db.$transaction(async (tx) => {
      const createdNotice = await tx.notice.create({
        data: {
          id: noticeId,
          board: "BUSINESS_LISTING",
          authorMemberId: authorPrincipal.memberId,
          authorFamilyId: authorFamily.familyId,
          status: "DRAFT",
          title: input.name,
          bodyHi: input.bodyHi ?? null,
          bodyEn: input.bodyEn ?? null,
          linkedMemberId: null,
          imageId: input.imageId ?? null,
          metadata: {
            category: input.category,
            businessCity: input.businessCity,
            businessPhone: input.businessPhone,
            businessAddress: input.businessAddress ?? null,
          },
          paymentId: null,
          publishedAt: null,
          expiresAt: null,
          hiddenAt: null,
          hiddenReason: null,
          createdAt: now,
        },
      });

      const createdMeta = await tx.businessListingMeta.create({
        data: {
          noticeId,
          category: input.category,
          businessCity: input.businessCity,
          businessCityKey: cityKey,
          businessPhone: input.businessPhone,
          businessAddress: input.businessAddress ?? null,
        },
      });

      return { notice: createdNotice, meta: createdMeta };
    });

    const view = await this.buildBusinessListingView(authorPrincipal.memberId, notice, meta);
    return { listing: view };
  }

  async createPaymentOrder(
    authorPrincipal: { readonly memberId: string; readonly phoneE164: string },
    listingId: string,
  ): Promise<BusinessCheckoutOrder> {
    const fee = this.checkBoardOpen();

    const notice = await this.db.notice.findUnique({ where: { id: listingId } });
    if (notice === null || notice.board !== "BUSINESS_LISTING") {
      throw new AppError("LISTING_NOT_FOUND", 404);
    }
    if (notice.authorMemberId !== authorPrincipal.memberId) {
      throw new AppError("FORBIDDEN", 403);
    }
    if (notice.status !== "DRAFT") {
      throw new AppError("CONFLICT", 409);
    }

    return this.business.createPaymentOrder({
      noticeId: notice.id,
      payerMemberId: authorPrincipal.memberId,
      payerPhoneE164: authorPrincipal.phoneE164,
      amountPaise: fee,
    });
  }

  async renewBusinessListing(
    authorPrincipal: { readonly memberId: string; readonly phoneE164: string },
    listingId: string,
  ): Promise<BusinessCheckoutOrder> {
    const fee = this.checkBoardOpen();

    const notice = await this.db.notice.findUnique({ where: { id: listingId } });
    if (notice === null || notice.board !== "BUSINESS_LISTING") {
      throw new AppError("LISTING_NOT_FOUND", 404);
    }
    if (notice.authorMemberId !== authorPrincipal.memberId) {
      throw new AppError("FORBIDDEN", 403);
    }
    if (notice.status !== "ACTIVE" && notice.status !== "EXPIRED") {
      throw new AppError("CONFLICT", 409);
    }

    return this.business.createPaymentOrder({
      noticeId: notice.id,
      payerMemberId: authorPrincipal.memberId,
      payerPhoneE164: authorPrincipal.phoneE164,
      amountPaise: fee,
    });
  }

  async onPaymentCaptured(payment: {
    readonly id: string;
    readonly subjectId: string;
    readonly purpose: string;
  }): Promise<void> {
    if (payment.purpose !== "BUSINESS_LISTING") return;

    const notice = await this.db.notice.findUnique({ where: { id: payment.subjectId } });
    if (notice === null) {
      await this.business.refund(payment.id, "PUBLICATION_FAILED");
      return;
    }

    const now = this.clock.now();
    const durationMs = this.config.businessListingDurationDays * DAY_MS;

    if (notice.status === "DRAFT") {
      await this.db.notice.update({
        where: { id: notice.id },
        data: {
          status: "ACTIVE",
          publishedAt: now,
          expiresAt: new Date(now.getTime() + durationMs),
          paymentId: payment.id,
        },
      });
      await this.business.markConsumed(payment.id);
    } else if (notice.paymentId === payment.id && notice.status === "ACTIVE") {
      return;
    } else if (notice.status === "ACTIVE" || notice.status === "EXPIRED") {
      const baseTime = notice.expiresAt && notice.expiresAt.getTime() > now.getTime()
        ? notice.expiresAt.getTime()
        : now.getTime();
      await this.db.notice.update({
        where: { id: notice.id },
        data: {
          status: "ACTIVE",
          expiresAt: new Date(baseTime + durationMs),
          paymentId: payment.id,
        },
      });
      await this.business.markConsumed(payment.id);
    } else {
      await this.business.refund(payment.id, "PUBLICATION_FAILED");
    }
  }

  async listBusinessListings(
    viewerMemberId: string,
    query: BusinessListingListQueryInput,
  ): Promise<{ readonly items: readonly BusinessListingView[]; readonly nextCursor: string | null }> {
    this.checkBoardOpen();

    const take = query.limit;
    // Active notices only
    const notices = await this.db.notice.findMany({
      where: {
        board: "BUSINESS_LISTING",
        status: "ACTIVE",
        ...(query.ownerMemberId === undefined ? {} : { authorMemberId: query.ownerMemberId }),
      },
      orderBy: { publishedAt: "desc" },
    });

    const metaList = await this.db.businessListingMeta.findMany({
      where: {
        ...(query.category === undefined ? {} : { category: query.category }),
        ...(query.city === undefined ? {} : { businessCityKey: normalizeCityKey(query.city) }),
      },
    });
    const metaMap = new Map(metaList.map((m) => [m.noticeId, m]));

    let filtered = notices.filter((n) => {
      const meta = metaMap.get(n.id);
      if (!meta) return false;
      if (query.q && query.q.trim().length > 0) {
        const needle = query.q.trim().toLowerCase();
        const haystack = (n.title ?? "").toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });

    if (query.cursor) {
      const idx = filtered.findIndex((n) => n.id === query.cursor);
      if (idx !== -1) filtered = filtered.slice(idx + 1);
    }

    const hasMore = filtered.length > take;
    const pageItems = hasMore ? filtered.slice(0, take) : filtered;
    const nextCursor = hasMore ? (pageItems[pageItems.length - 1]?.id ?? null) : null;

    const views = await Promise.all(
      pageItems.map((n) => {
        const meta = metaMap.get(n.id);
        if (meta === undefined) throw new AppError("INTERNAL", 500);
        return this.buildBusinessListingView(viewerMemberId, n, meta);
      }),
    );

    return { items: views, nextCursor };
  }

  async listMyBusinessListings(
    authorPrincipal: { readonly memberId: string },
    query: PaginationQueryInput,
  ): Promise<{ readonly items: readonly BusinessListingView[]; readonly nextCursor: string | null }> {
    this.checkBoardOpen();

    const take = query.limit;
    // Returns listings across ALL statuses
    const notices = await this.db.notice.findMany({
      where: {
        board: "BUSINESS_LISTING",
        authorMemberId: authorPrincipal.memberId,
      },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor } }),
    });

    const hasMore = notices.length > take;
    const pageItems = hasMore ? notices.slice(0, take) : notices;
    const nextCursor = hasMore ? (pageItems[pageItems.length - 1]?.id ?? null) : null;

    const metas = await this.db.businessListingMeta.findMany({
      where: {
        noticeId: { in: pageItems.map((n) => n.id) },
      },
    });
    const metaMap = new Map(metas.map((m) => [m.noticeId, m]));

    const views = await Promise.all(
      pageItems.map((n) => {
        const meta = metaMap.get(n.id) ?? {
          noticeId: n.id,
          category: "CA",
          businessCity: "",
          businessCityKey: "",
          businessPhone: "",
          businessAddress: null,
        };
        return this.buildBusinessListingView(authorPrincipal.memberId, n, meta);
      }),
    );

    return { items: views, nextCursor };
  }

  async getBusinessListing(
    viewerMemberId: string,
    listingId: string,
  ): Promise<{ readonly listing: BusinessListingView }> {
    this.checkBoardOpen();

    const notice = await this.db.notice.findUnique({ where: { id: listingId } });
    if (notice === null || notice.board !== "BUSINESS_LISTING") {
      throw new AppError("LISTING_NOT_FOUND", 404);
    }
    if (notice.status !== "ACTIVE" && notice.authorMemberId !== viewerMemberId) {
      throw new AppError("LISTING_NOT_FOUND", 404);
    }

    const meta = await this.db.businessListingMeta.findUnique({ where: { noticeId: listingId } });
    if (meta === null) {
      throw new AppError("LISTING_NOT_FOUND", 404);
    }

    const view = await this.buildBusinessListingView(viewerMemberId, notice, meta);
    return { listing: view };
  }

  async removeBusinessListing(
    authorPrincipal: { readonly memberId: string },
    listingId: string,
  ): Promise<void> {
    this.checkBoardOpen();

    const notice = await this.db.notice.findUnique({ where: { id: listingId } });
    if (notice === null || notice.board !== "BUSINESS_LISTING") {
      throw new AppError("LISTING_NOT_FOUND", 404);
    }
    if (notice.authorMemberId !== authorPrincipal.memberId) {
      throw new AppError("FORBIDDEN", 403);
    }

    await this.db.notice.update({
      where: { id: listingId },
      data: { status: "REMOVED" },
    });
  }

  // ---------------------------------------------------------------------------
  // Archival Requests
  // ---------------------------------------------------------------------------

  async confirmArchivalRequest(
    memberPrincipal: { readonly memberId: string },
    archivalRequestId: string,
  ): Promise<{ readonly archivalRequest: ArchivalRequestView }> {
    const request = await this.db.archivalRequest.findUnique({ where: { id: archivalRequestId } });
    if (request === null) {
      throw new AppError("ARCHIVAL_REQUEST_NOT_FOUND", 404);
    }

    const memberFamily = await this.register.familyOf(memberPrincipal.memberId);
    if (memberFamily === null || memberFamily.familyId !== request.familyId) {
      throw new AppError("NOT_FAMILY_MEMBER", 403);
    }

    // The deceased Member themselves cannot confirm their own death
    if (memberPrincipal.memberId === request.deceasedMemberId) {
      throw new AppError("NOT_FAMILY_MEMBER", 403);
    }

    const now = this.clock.now();

    const updated = await this.db.$transaction(async (tx) => {
      const locked = await tx.archivalRequest.findUnique({ where: { id: archivalRequestId } });
      if (
        locked === null ||
        (locked.status !== "OPEN" && locked.status !== "ESCALATED") ||
        Boolean(locked.respondedBy)
      ) {
        throw new AppError("ARCHIVAL_REQUEST_ALREADY_RESOLVED", 409);
      }

      await this.register.archiveMember(tx, locked.deceasedMemberId, {
        kind: "MEMBER",
        memberId: memberPrincipal.memberId,
      });

      const res = await tx.archivalRequest.update({
        where: { id: archivalRequestId },
        data: {
          status: "CONFIRMED",
          respondedAt: now,
          respondedBy: memberPrincipal.memberId,
        },
      });

      await this.processingRecord.write(tx, {
        action: "MEMBER_ARCHIVED",
        subjectType: "MEMBER",
        subjectId: locked.deceasedMemberId,
        actor: { kind: "MEMBER", id: memberPrincipal.memberId },
        reason: "Confirmed by family member",
      });

      return res;
    });

    const view = await this.buildArchivalRequestView(memberPrincipal.memberId, updated, memberFamily.publicId);
    return { archivalRequest: view };
  }

  async refuteArchivalRequest(
    memberPrincipal: { readonly memberId: string },
    archivalRequestId: string,
  ): Promise<{ readonly archivalRequest: ArchivalRequestView }> {
    const request = await this.db.archivalRequest.findUnique({ where: { id: archivalRequestId } });
    if (request === null) {
      throw new AppError("ARCHIVAL_REQUEST_NOT_FOUND", 404);
    }

    const memberFamily = await this.register.familyOf(memberPrincipal.memberId);
    if (memberFamily === null || memberFamily.familyId !== request.familyId) {
      throw new AppError("NOT_FAMILY_MEMBER", 403);
    }

    // The linked Member themselves is allowed and encouraged to refute!
    const now = this.clock.now();

    const updated = await this.db.$transaction(async (tx) => {
      const locked = await tx.archivalRequest.findUnique({ where: { id: archivalRequestId } });
      if (
        locked === null ||
        (locked.status !== "OPEN" && locked.status !== "ESCALATED") ||
        Boolean(locked.respondedBy)
      ) {
        throw new AppError("ARCHIVAL_REQUEST_ALREADY_RESOLVED", 409);
      }

      return tx.archivalRequest.update({
        where: { id: archivalRequestId },
        data: {
          status: "REFUTED",
          respondedAt: now,
          respondedBy: memberPrincipal.memberId,
        },
      });
    });

    const view = await this.buildArchivalRequestView(memberPrincipal.memberId, updated, memberFamily.publicId);
    return { archivalRequest: view };
  }

  async listMyArchivalRequests(
    memberPrincipal: { readonly memberId: string },
    query: PaginationQueryInput,
  ): Promise<{ readonly items: readonly ArchivalRequestView[]; readonly nextCursor: string | null }> {
    const memberFamily = await this.register.familyOf(memberPrincipal.memberId);
    if (memberFamily === null) {
      throw new AppError("UNAUTHENTICATED", 401);
    }

    const take = query.limit;
    const requests = await this.db.archivalRequest.findMany({
      where: { familyId: memberFamily.familyId },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor } }),
    });

    const hasMore = requests.length > take;
    const pageItems = hasMore ? requests.slice(0, take) : requests;
    const nextCursor = hasMore ? (pageItems[pageItems.length - 1]?.id ?? null) : null;

    const views = await Promise.all(
      pageItems.map((r) => this.buildArchivalRequestView(memberPrincipal.memberId, r, memberFamily.publicId)),
    );

    return { items: views, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // Officer Operations
  // ---------------------------------------------------------------------------

  async listSuspensionsForOfficer(
    query: SuspensionQueryInput,
  ): Promise<{ readonly items: readonly SuspensionRow[]; readonly nextCursor: string | null }> {
    const now = this.clock.now();
    const take = query.limit;

    const where = query.active
      ? { liftedAt: null, endsAt: { gt: now } }
      : { liftedAt: { not: null } };

    const rows = await this.db.suspension.findMany({
      where,
      orderBy: { startsAt: "desc" },
      take: take + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor } }),
    });

    const hasMore = rows.length > take;
    const pageItems = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? (pageItems[pageItems.length - 1]?.id ?? null) : null;

    return { items: pageItems, nextCursor };
  }

  async liftSuspensionForOfficer(
    suspensionId: string,
    officerId: string,
    input: LiftSuspensionInput,
  ): Promise<void> {
    const suspension = await this.db.suspension.findUnique({ where: { id: suspensionId } });
    if (suspension === null) {
      throw new AppError("NOT_FOUND", 404);
    }

    const now = this.clock.now();

    await this.db.$transaction(async (tx) => {
      await tx.suspension.update({
        where: { id: suspensionId },
        data: {
          liftedAt: now,
          liftedBy: officerId,
          liftedReason: input.reason,
        },
      });

      await this.processingRecord.write(tx, {
        action: "SUSPENSION_LIFTED",
        subjectType: "SUSPENSION",
        subjectId: suspensionId,
        actor: { kind: "OFFICER", id: officerId },
        reason: input.reason,
      });

      if (input.restoreNotice && suspension.activeNoticeId) {
        const notice = await tx.notice.findUnique({ where: { id: suspension.activeNoticeId } });
        if (notice && notice.status === "HIDDEN") {
          await tx.notice.update({
            where: { id: notice.id },
            data: {
              status: "ACTIVE",
              hiddenAt: null,
              hiddenReason: null,
            },
          });

          await this.processingRecord.write(tx, {
            action: "NOTICE_RESTORED",
            subjectType: "NOTICE",
            subjectId: notice.id,
            actor: { kind: "OFFICER", id: officerId },
            reason: input.reason,
          });
        }
      }
    });
  }

  async restoreNoticeForOfficer(
    noticeId: string,
    officerId: string,
    reason: string,
  ): Promise<void> {
    const notice = await this.db.notice.findUnique({ where: { id: noticeId } });
    if (notice === null) {
      throw new AppError("NOTICE_NOT_FOUND", 404);
    }
    if (notice.status !== "HIDDEN") {
      throw new AppError("CONFLICT", 409);
    }

    await this.db.$transaction(async (tx) => {
      await tx.notice.update({
        where: { id: noticeId },
        data: {
          status: "ACTIVE",
          hiddenAt: null,
          hiddenReason: null,
        },
      });

      await this.processingRecord.write(tx, {
        action: "NOTICE_RESTORED",
        subjectType: "NOTICE",
        subjectId: noticeId,
        actor: { kind: "OFFICER", id: officerId },
        reason,
      });
    });
  }

  async listArchivalRequestsForOfficer(
    query: ArchivalRequestsQueryInput,
  ): Promise<{ readonly items: readonly ArchivalRequestRow[]; readonly nextCursor: string | null }> {
    const take = query.limit;
    let whereStatus: ArchivalRequestStatusType | { in: ArchivalRequestStatusType[] } = query.status as ArchivalRequestStatusType;
    if (query.status === "RESOLVED") {
      whereStatus = { in: ["CONFIRMED", "REFUTED"] };
    }

    const rows = await this.db.archivalRequest.findMany({
      where: { status: whereStatus },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor } }),
    });

    const hasMore = rows.length > take;
    const pageItems = hasMore ? rows.slice(0, take) : rows;
    const nextCursor = hasMore ? (pageItems[pageItems.length - 1]?.id ?? null) : null;

    return { items: pageItems, nextCursor };
  }

  async resolveArchivalForOfficer(
    archivalRequestId: string,
    officerId: string,
    input: ResolveArchivalInput,
  ): Promise<void> {
    const request = await this.db.archivalRequest.findUnique({ where: { id: archivalRequestId } });
    if (request === null) {
      throw new AppError("ARCHIVAL_REQUEST_NOT_FOUND", 404);
    }

    const now = this.clock.now();

    await this.db.$transaction(async (tx) => {
      const locked = await tx.archivalRequest.findUnique({ where: { id: archivalRequestId } });
      if (
        locked === null ||
        locked.status === "CONFIRMED" ||
        locked.status === "REFUTED" ||
        Boolean(locked.respondedBy)
      ) {
        throw new AppError("ARCHIVAL_REQUEST_ALREADY_RESOLVED", 409);
      }

      if (input.outcome === "CONFIRM") {
        await this.register.archiveMember(tx, locked.deceasedMemberId, {
          kind: "OFFICER",
          officerId,
        });

        await tx.archivalRequest.update({
          where: { id: archivalRequestId },
          data: {
            status: "CONFIRMED",
            respondedAt: now,
            respondedBy: `OFFICER:${officerId}`,
          },
        });
      } else {
        await tx.archivalRequest.update({
          where: { id: archivalRequestId },
          data: {
            status: "REFUTED",
            respondedAt: now,
            respondedBy: `OFFICER:${officerId}`,
          },
        });
      }

      await this.processingRecord.write(tx, {
        action: "ARCHIVAL_RESOLVED_BY_OFFICER",
        subjectType: "ARCHIVAL_REQUEST",
        subjectId: archivalRequestId,
        actor: { kind: "OFFICER", id: officerId },
        reason: input.note,
        metadata: { outcome: input.outcome },
      });
    });
  }

  async listReportsForOfficer(
    query: ReportsQueryInput,
  ): Promise<{ readonly items: readonly ReportRow[]; readonly nextCursor: string | null }> {
    const take = query.limit;
    const reports = await this.db.report.findMany({
      where: { targetType: query.target },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor } }),
    });

    const hasMore = reports.length > take;
    const pageItems = hasMore ? reports.slice(0, take) : reports;
    const nextCursor = hasMore ? (pageItems[pageItems.length - 1]?.id ?? null) : null;

    return { items: pageItems, nextCursor };
  }

  // ---------------------------------------------------------------------------
  // Jobs (expiry, suspension cleanup, escalation)
  // ---------------------------------------------------------------------------

  async expireListings(): Promise<number> {
    const now = this.clock.now();
    const result = await this.db.notice.updateMany({
      where: {
        board: "BUSINESS_LISTING",
        status: "ACTIVE",
        expiresAt: { lte: now },
      },
      data: { status: "EXPIRED" },
    });
    return result.count;
  }

  async endSuspensions(): Promise<number> {
    const now = this.clock.now();
    const toEnd = await this.db.suspension.findMany({
      where: {
        endsAt: { lte: now },
        liftedAt: null,
      },
    });

    for (const s of toEnd) {
      await this.db.suspension.update({
        where: { id: s.id },
        data: {
          liftedAt: s.endsAt,
          liftedReason: "EXPIRED",
        },
      });
    }

    return toEnd.length;
  }

  async escalateArchivals(): Promise<number> {
    const now = this.clock.now();
    const result = await this.db.archivalRequest.updateMany({
      where: {
        status: "OPEN",
        expiresAt: { lte: now },
      },
      data: {
        status: "ESCALATED",
        escalatedAt: now,
      },
    });
    return result.count;
  }

  // ---------------------------------------------------------------------------
  // Public Seam & Hooks
  // ---------------------------------------------------------------------------

  async activeSuspension(memberId: string): Promise<SuspensionRow | null> {
    const now = this.clock.now();
    return this.db.suspension.findFirst({
      where: {
        memberId,
        startsAt: { lte: now },
        endsAt: { gt: now },
        liftedAt: null,
      },
    });
  }

  async isArchivalRequestOpen(memberId: string, archivalRequestId: string): Promise<boolean> {
    const family = await this.register.familyOf(memberId);
    if (family === null) return false;
    const request = await this.db.archivalRequest.findFirst({
      where: {
        id: archivalRequestId,
        deceasedMemberId: memberId,
        familyId: family.familyId,
        status: { in: ["OPEN", "ESCALATED"] },
      },
    });
    return request !== null;
  }

  async handleMemberErased(tx: NoticesTxClient, memberId: string): Promise<void> {
    // 1. Shok Sandesh Notices: author fields scrubbed, text retained as Historical Content
    await tx.notice.updateMany({
      where: {
        authorMemberId: memberId,
        board: "SHOK_SANDESH",
      },
      data: {
        authorMemberId: FORMER_MEMBER_ID,
        authorFamilyId: "",
      },
    });

    // 2. Business Listings: deleted (status REMOVED)
    await tx.notice.updateMany({
      where: {
        authorMemberId: memberId,
        board: "BUSINESS_LISTING",
      },
      data: {
        status: "REMOVED",
      },
    });

    // 3. Reports they filed: deleted
    await tx.report.deleteMany({
      where: { reporterMemberId: memberId },
    });

    // 4. Their Suspensions: lifted/deleted
    const now = this.clock.now();
    await tx.suspension.updateMany({
      where: { memberId, liftedAt: null },
      data: { liftedAt: now, liftedReason: "MEMBER_ERASED" },
    });
  }

  // ---------------------------------------------------------------------------
  // View Projection Helpers
  // ---------------------------------------------------------------------------

  private async buildNoticeView(viewerMemberId: string, notice: NoticeRow): Promise<NoticeView> {
    const isErasedAuthor = notice.authorMemberId === FORMER_MEMBER_ID;
    let author: NoticeAuthorProjection;

    if (isErasedAuthor) {
      author = {
        memberId: FORMER_MEMBER_ID,
        familyPublicId: "FORMER",
        isHead: false,
        name: {
          en: "A former member",
          hi: "पूर्व सदस्य",
        },
      };
    } else {
      const projections = await this.register.project(viewerMemberId, [notice.authorMemberId]);
      author = projections.get(notice.authorMemberId) ?? {
        memberId: notice.authorMemberId,
        familyPublicId: "",
        isHead: false,
      };
    }

    let linkedMember: NoticeAuthorProjection | null = null;
    if (notice.linkedMemberId) {
      const projections = await this.register.project(viewerMemberId, [notice.linkedMemberId]);
      linkedMember = projections.get(notice.linkedMemberId) ?? null;
    }

    const imageUrl = notice.imageId
      ? await this.media.urlFor(notice.imageId, viewerMemberId)
      : null;

    return {
      ...notice,
      author,
      linkedMember,
      imageUrl,
    };
  }

  private async buildBusinessListingView(
    viewerMemberId: string,
    notice: NoticeRow,
    meta: BusinessListingMetaRow,
  ): Promise<BusinessListingView> {
    const isErased = notice.authorMemberId === FORMER_MEMBER_ID;
    let owner: NoticeAuthorProjection;

    if (isErased) {
      owner = {
        memberId: FORMER_MEMBER_ID,
        familyPublicId: "FORMER",
        isHead: false,
        name: {
          en: "A former member",
          hi: "पूर्व सदस्य",
        },
      };
    } else {
      const projections = await this.register.project(viewerMemberId, [notice.authorMemberId]);
      owner = projections.get(notice.authorMemberId) ?? {
        memberId: notice.authorMemberId,
        familyPublicId: "",
        isHead: false,
      };
    }

    const imageUrl = notice.imageId
      ? await this.media.urlFor(notice.imageId, viewerMemberId)
      : null;

    return {
      id: notice.id,
      name: notice.title ?? "",
      category: meta.category,
      businessCity: meta.businessCity,
      businessPhone: meta.businessPhone,
      businessAddress: meta.businessAddress,
      bodyHi: notice.bodyHi,
      bodyEn: notice.bodyEn,
      imageId: notice.imageId,
      imageUrl,
      status: notice.status,
      owner,
      publishedAt: notice.publishedAt,
      expiresAt: notice.expiresAt,
      createdAt: notice.createdAt,
    };
  }

  private async buildArchivalRequestView(
    viewerMemberId: string,
    request: ArchivalRequestRow,
    familyPublicId: string,
  ): Promise<ArchivalRequestView> {
    const projections = await this.register.project(viewerMemberId, [request.deceasedMemberId]);
    const deceasedMember = projections.get(request.deceasedMemberId) ?? null;

    return {
      ...request,
      deceasedMember,
      familyPublicId,
    };
  }
}
