import type { NoticesService } from "./service.js";
import type { ReportsQueryInput, SuspensionQueryInput } from "./schemas.js";
/**
 * Notices module public interface.
 *
 * This is the ONLY file other modules may import from this module.
 */

export {
  NoticesService,
  type BusinessListingView,
  type NoticeView,
  type ArchivalRequestView,
  type NoticesServiceDeps,
} from "./service.js";

export {
  createNoticesRoutes,
  noticesRouteManifest,
  type NoticesRouteDeps,
} from "./routes.js";

export {
  createNoticesWorkers,
  NOTICES_JOB_NAMES,
  JOB_SCHEDULES as NOTICES_JOB_SCHEDULES,
} from "./jobs.js";

export {
  InMemoryNoticesDatabase,
  type ArchivalRequestCreateData,
  type ArchivalRequestDelegate,
  type ArchivalRequestOrderByInput,
  type ArchivalRequestRow,
  type ArchivalRequestStatusType,
  type ArchivalRequestWhereInput,
  type BusinessListingMetaDelegate,
  type BusinessListingMetaRow,
  type BusinessListingMetaWhereInput,
  type NoticeBoardType,
  type NoticeCreateData,
  type NoticeDelegate,
  type NoticeOrderByInput,
  type NoticeRow,
  type NoticeStatusType,
  type NoticeWhereInput,
  type NoticesDatabase,
  type NoticesTxClient,
  type ReportDelegate,
  type ReportRow,
  type ReportWhereInput,
  type SuspensionDelegate,
  type SuspensionRow,
  type SuspensionWhereInput,
} from "./db.js";

export {
  BUSINESS_CATEGORIES,
  NOTICE_BOARDS,
  NOTICE_STATUSES,
  ARCHIVAL_REQUEST_STATUSES,
  BusinessListingBody,
  BusinessListingListQuery,
  LiftSuspensionBody,
  NoticeIdParams,
  NoticeListQuery,
  PaginationQuery,
  ReportBody,
  ReportsQuery,
  ResolveArchivalBody,
  ShokSandeshBody,
  SuspensionIdParams,
  SuspensionQuery,
  type BusinessCategory,
  type BusinessListingInput,
  type BusinessListingListQueryInput,
  type LiftSuspensionInput,
  type NoticeBoard,
  type NoticeListQueryInput,
  type NoticeStatus,
  type PaginationQueryInput,
  type ReportInput,
  type ReportsQueryInput,
  type ResolveArchivalInput,
  type ShokSandeshInput,
  type SuspensionQueryInput,
} from "./schemas.js";

export type {
  BusinessCheckoutOrder,
  LocalizedText,
  NoticeAuthorProjection,
  NoticePushMessage,
  NoticesBusinessPort,
  NoticesClock,
  NoticesConfig,
  NoticesMediaPort,
  NoticesNotificationsPort,
  NoticesProcessingRecordWriter,
  NoticesRegisterPort,
  ProcessingActor,
  ProcessingEntry,
} from "./ports.js";

export const NOTICES_ERROR_CODES = {
  BOARD_NOT_OPEN: "BOARD_NOT_OPEN",
  POSTING_CAP_REACHED: "POSTING_CAP_REACHED",
  POSTING_SUSPENDED: "POSTING_SUSPENDED",
  NOTICE_CONTAINS_PHONE: "NOTICE_CONTAINS_PHONE",
  NOTICE_CONTAINS_BLOCKED_WORD: "NOTICE_CONTAINS_BLOCKED_WORD",
  CANNOT_REPORT_OWN: "CANNOT_REPORT_OWN",
  ALREADY_REPORTED: "ALREADY_REPORTED",
  NOTICE_NOT_FOUND: "NOTICE_NOT_FOUND",
  LISTING_NOT_FOUND: "LISTING_NOT_FOUND",
  ARCHIVAL_REQUEST_NOT_FOUND: "ARCHIVAL_REQUEST_NOT_FOUND",
  ARCHIVAL_REQUEST_ALREADY_RESOLVED: "ARCHIVAL_REQUEST_ALREADY_RESOLVED",
  NOT_FAMILY_MEMBER: "NOT_FAMILY_MEMBER",
} as const;

export type NoticesErrorCode = (typeof NOTICES_ERROR_CODES)[keyof typeof NOTICES_ERROR_CODES];

// ---------------------------------------------------------------------------
// Narrow adapters for Officer governance module
// ---------------------------------------------------------------------------
function toOfficerRecord(row: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key] = value;
  }
  return result;
}

export function createOfficerSuspensionAdapter(service: NoticesService) {
  return {
    list: async (input: SuspensionQueryInput) => {
      const page = await service.listSuspensionsForOfficer(input);
      return {
        items: page.items.map(toOfficerRecord),
        nextCursor: page.nextCursor,
      };
    },
    lift: async (input: {
      readonly suspensionId: string;
      readonly officerId: string;
      readonly reason: string;
      readonly restoreNotice: boolean;
    }) => service.liftSuspensionForOfficer(input.suspensionId, input.officerId, input),
  };
}

export function createOfficerArchivalAdapter(service: NoticesService) {
  return {
    list: async (input: {
      readonly status: "OPEN" | "ESCALATED" | "RESOLVED";
      readonly cursor?: string;
      readonly limit: number;
    }) => {
      const page = await service.listArchivalRequestsForOfficer(input);
      return {
        items: page.items.map(toOfficerRecord),
        nextCursor: page.nextCursor,
      };
    },
    resolve: async (input: {
      readonly archivalRequestId: string;
      readonly officerId: string;
      readonly outcome: "CONFIRM" | "REFUTE";
      readonly note: string;
    }) => service.resolveArchivalForOfficer(input.archivalRequestId, input.officerId, input),
  };
}

export function createOfficerReportAdapter(service: NoticesService) {
  return {
    list: async (input: ReportsQueryInput) => {
      const page = await service.listReportsForOfficer(input);
      return {
        items: page.items.map(toOfficerRecord),
        nextCursor: page.nextCursor,
      };
    },
  };
}
export function createRegisterSuspensionResolver(service: NoticesService) {
  return {
    resolveActiveSuspension: async (memberId: string) => {
      const active = await service.activeSuspension(memberId);
      if (active === null) return null;
      return {
        endsAt: active.endsAt.toISOString(),
        reason: active.reason,
        noticeId: active.activeNoticeId ?? null,
      };
    },
  };
}
