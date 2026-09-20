import { Router, type Request, type Response } from "express";
import { requireMember, type MemberPrincipal } from "../../http/auth.js";
import { AppError } from "../../http/errors.js";
import { configuredRateLimit, type RateLimiter } from "../../http/rate-limit.js";
import { validate } from "../../http/validate.js";
import {
  ArchivalRequestIdParams,
  BusinessListingBody,
  BusinessListingListQuery,
  ListingIdParams,
  NoticeIdParams,
  NoticeListQuery,
  PaginationQuery,
  ReportBody,
  ShokSandeshBody,
} from "./schemas.js";
import type { NoticesService } from "./service.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";

export const noticesRouteManifest = defineRouteManifest({
  createNotice: { method: "post", path: "/v1/notices" },
  listNotices: { method: "get", path: "/v1/notices" },
  getNotice: { method: "get", path: "/v1/notices/:noticeId" },
  reportNotice: { method: "post", path: "/v1/notices/:noticeId/report" },
  createBusinessListing: { method: "post", path: "/v1/business-listings" },
  listBusinessListings: { method: "get", path: "/v1/business-listings" },
  listMyBusinessListings: { method: "get", path: "/v1/business-listings/mine" },
  getBusinessListing: { method: "get", path: "/v1/business-listings/:listingId" },
  removeBusinessListing: { method: "delete", path: "/v1/business-listings/:listingId" },
  createBusinessListingPaymentOrder: {
    method: "post",
    path: "/v1/business-listings/:listingId/payment-order",
  },
  renewBusinessListing: { method: "post", path: "/v1/business-listings/:listingId/renew" },
  listMyArchivalRequests: { method: "get", path: "/v1/archival-requests/mine" },
  confirmArchivalRequest: {
    method: "post",
    path: "/v1/archival-requests/:archivalRequestId/confirm",
  },
  refuteArchivalRequest: {
    method: "post",
    path: "/v1/archival-requests/:archivalRequestId/refute",
  },
  getMySuspension: { method: "get", path: "/v1/me/suspension" },
} as const);

function getMemberPrincipal(request: Request): MemberPrincipal {
  if (request.principal === null || request.principal.kind !== "MEMBER") {
    throw new AppError("UNAUTHENTICATED", 401);
  }
  return request.principal;
}
function memberIdKey(request: Request): string {
  return getMemberPrincipal(request).memberId;
}

export interface NoticesRouteDeps {
  readonly service: NoticesService;
  readonly rateLimiter?: RateLimiter;
}

export function createNoticesRoutes(deps: NoticesRouteDeps): Router {
  const router = Router();
  const { service } = deps;
  const noticeCreateRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "notice.create",
    key: memberIdKey,
    limit: 10,
    windowSeconds: 60 * 60,
  });
  const noticeReportRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "notice.report",
    key: memberIdKey,
    limit: 30,
    windowSeconds: 60 * 60,
  });
  const businessListingCreateRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "businessListing.create",
    key: memberIdKey,
    limit: 10,
    windowSeconds: 60 * 60,
  });

  // ---------------------------------------------------------------------------
  // Notices (Shok Sandesh)
  // ---------------------------------------------------------------------------

  registerRoute(router, noticesRouteManifest.createNotice,
    requireMember(),
    ...noticeCreateRateLimit,
    validate({ body: ShokSandeshBody }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const parsedBody = ShokSandeshBody.parse(request.body);
      const result = await service.createNotice(principal, parsedBody);
      response.status(201).json(result);
    },
  );

  registerRoute(router, noticesRouteManifest.listNotices,
    requireMember(),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const query = NoticeListQuery.parse(request.query);
      const result = await service.listNotices(principal.memberId, query);
      response.status(200).json(result);
    },
  );

  registerRoute(router, noticesRouteManifest.getNotice,
    requireMember(),
    validate({ params: NoticeIdParams }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const { noticeId } = NoticeIdParams.parse(request.params);
      const result = await service.getNotice(principal.memberId, noticeId);
      response.status(200).json(result);
    },
  );

  registerRoute(router, noticesRouteManifest.reportNotice,
    requireMember(),
    ...noticeReportRateLimit,
    validate({ params: NoticeIdParams, body: ReportBody }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const { noticeId } = NoticeIdParams.parse(request.params);
      const body = ReportBody.parse(request.body);
      const result = await service.reportNotice(principal, noticeId, body);
      response.status(201).json(result);
    },
  );

  // ---------------------------------------------------------------------------
  // Business Listings
  // ---------------------------------------------------------------------------

  registerRoute(router, noticesRouteManifest.createBusinessListing,
    requireMember(),
    ...businessListingCreateRateLimit,
    validate({ body: BusinessListingBody }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const body = BusinessListingBody.parse(request.body);
      const result = await service.createBusinessListing(principal, body);
      response.status(201).json(result);
    },
  );

  registerRoute(router, noticesRouteManifest.listBusinessListings,
    requireMember(),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const query = BusinessListingListQuery.parse(request.query);
      const result = await service.listBusinessListings(principal.memberId, query);
      response.status(200).json(result);
    },
  );

  registerRoute(router, noticesRouteManifest.listMyBusinessListings,
    requireMember(),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const query = PaginationQuery.parse(request.query);
      const result = await service.listMyBusinessListings(principal, query);
      response.status(200).json(result);
    },
  );

  registerRoute(router, noticesRouteManifest.getBusinessListing,
    requireMember(),
    validate({ params: ListingIdParams }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const { listingId } = ListingIdParams.parse(request.params);
      const result = await service.getBusinessListing(principal.memberId, listingId);
      response.status(200).json(result);
    },
  );

  registerRoute(router, noticesRouteManifest.removeBusinessListing,
    requireMember(),
    validate({ params: ListingIdParams }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const { listingId } = ListingIdParams.parse(request.params);
      await service.removeBusinessListing(principal, listingId);
      response.status(204).end();
    },
  );

  registerRoute(router, noticesRouteManifest.createBusinessListingPaymentOrder,
    requireMember(),
    validate({ params: ListingIdParams }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const { listingId } = ListingIdParams.parse(request.params);
      const order = await service.createPaymentOrder(principal, listingId);
      response.status(201).json({
        paymentId: order.paymentId,
        razorpayOrderId: order.razorpayOrderId,
        keyId: order.keyId,
        amount: {
          amountPaise: order.amountPaise,
          currency: order.currency,
        },
        prefill: order.prefill,
        alreadyPaid: order.alreadyPaid,
      });
    },
  );

  registerRoute(router, noticesRouteManifest.renewBusinessListing,
    requireMember(),
    validate({ params: ListingIdParams }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const { listingId } = ListingIdParams.parse(request.params);
      const order = await service.renewBusinessListing(principal, listingId);
      response.status(201).json({
        paymentId: order.paymentId,
        razorpayOrderId: order.razorpayOrderId,
        keyId: order.keyId,
        amount: {
          amountPaise: order.amountPaise,
          currency: order.currency,
        },
        prefill: order.prefill,
        alreadyPaid: order.alreadyPaid,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Archival Requests
  // ---------------------------------------------------------------------------

  registerRoute(router, noticesRouteManifest.listMyArchivalRequests,
    requireMember(),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const query = PaginationQuery.parse(request.query);
      const result = await service.listMyArchivalRequests(principal, query);
      response.status(200).json(result);
    },
  );

  registerRoute(router, noticesRouteManifest.confirmArchivalRequest,
    requireMember(),
    validate({ params: ArchivalRequestIdParams }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const { archivalRequestId } = ArchivalRequestIdParams.parse(request.params);
      const result = await service.confirmArchivalRequest(principal, archivalRequestId);
      response.status(200).json(result);
    },
  );

  registerRoute(router, noticesRouteManifest.refuteArchivalRequest,
    requireMember(),
    validate({ params: ArchivalRequestIdParams }),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const { archivalRequestId } = ArchivalRequestIdParams.parse(request.params);
      const result = await service.refuteArchivalRequest(principal, archivalRequestId);
      response.status(200).json(result);
    },
  );

  // ---------------------------------------------------------------------------
  // Current Suspension
  // ---------------------------------------------------------------------------

  registerRoute(router, noticesRouteManifest.getMySuspension,
    requireMember(),
    async (request: Request, response: Response) => {
      const principal = getMemberPrincipal(request);
      const active = await service.activeSuspension(principal.memberId);
      if (active === null) {
        response.status(200).json({ suspension: null });
        return;
      }
      response.status(200).json({
        suspension: {
          id: active.id,
          endsAt: active.endsAt.toISOString(),
          reason: active.reason,
          noticeId: active.activeNoticeId,
        },
      });
    },
  );

  return router;
}
