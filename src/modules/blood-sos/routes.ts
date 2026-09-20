import { Router, type Request, type RequestHandler, type Response } from "express";
import { idempotent, type IdempotencyStore } from "../../http/idempotency.js";
import { requireMember, type MemberPrincipal } from "../../http/auth.js";
import { AppError } from "../../http/errors.js";
import { configuredRateLimit, type RateLimiter } from "../../http/rate-limit.js";
import { validate } from "../../http/validate.js";
import type { Clock } from "../../clock.js";
import {
  BloodSosCreateBody,
  BloodSosDonorStatusResponse,
  BloodSosIdParams,
  BloodSosLastDonationBody,
  BloodSosMineResponse,
  BloodSosReportBody,
  BloodSosReportResponse,
  BloodSosRequestView,
  BloodSosSnoozeBody,
  type BloodSosCreateInput,
  type BloodSosLastDonationInput,
  type BloodSosReportInput,
  type BloodSosSnoozeInput,
} from "./schemas.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";
import type { BloodSosService } from "./service.js";

function memberPrincipal(request: Request): MemberPrincipal {
  if (
    request.principal === null
    || request.principal.kind !== "MEMBER"
  ) {
    throw new AppError("UNAUTHENTICATED", 401);
  }
  return request.principal;
}

export interface BloodSosRouteDeps {
  readonly service: BloodSosService;
  readonly idempotency?: {
    readonly store: IdempotencyStore;
    readonly clock: Clock;
  };
  readonly rateLimiter?: RateLimiter;
}

export const bloodSosRouteManifest = defineRouteManifest({
  create: { method: "post", path: "/v1/blood-sos" },
  mine: { method: "get", path: "/v1/blood-sos/mine" },
  get: { method: "get", path: "/v1/blood-sos/:id" },
  fulfil: { method: "post", path: "/v1/blood-sos/:id/fulfil" },
  cancel: { method: "post", path: "/v1/blood-sos/:id/cancel" },
  respond: { method: "post", path: "/v1/blood-sos/:id/respond" },
  report: { method: "post", path: "/v1/blood-sos/:id/report" },
  snooze: { method: "put", path: "/v1/me/blood-sos/snooze" },
  unsnooze: { method: "delete", path: "/v1/me/blood-sos/snooze" },
  lastDonation: { method: "put", path: "/v1/me/blood-sos/last-donation" },
  donorStatus: { method: "get", path: "/v1/me/blood-sos/donor-status" },
} as const);

function memberIdKey(request: Request): string {
  return memberPrincipal(request).memberId;
}

function idempotencyMiddleware(
  options: BloodSosRouteDeps["idempotency"],
): readonly RequestHandler[] {
  if (options === undefined) return [];
  return [idempotent({ store: options.store, clock: options.clock })];
}

export function createBloodSosRoutes(deps: BloodSosRouteDeps): Router {
  const router = Router();
  const { service } = deps;
  const writes = idempotencyMiddleware(deps.idempotency);
  const createRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "bloodSos.create",
    key: memberIdKey,
    limit: 3,
    windowSeconds: 60 * 60,
  });
  const respondRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "bloodSos.respond",
    key: memberIdKey,
    limit: 30,
    windowSeconds: 60 * 60,
  });
  const reportRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "bloodSos.report",
    key: memberIdKey,
    limit: 10,
    windowSeconds: 60 * 60,
  });

  registerRoute(router, bloodSosRouteManifest.create,
    requireMember(),
    ...createRateLimit,
    ...writes,
    validate({ body: BloodSosCreateBody }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const body: BloodSosCreateInput = BloodSosCreateBody.parse(request.body);
      const result = await service.createRequest(principal.memberId, body);
      response.status(201).json(BloodSosRequestView.parse(result));
    },
  );

  registerRoute(router, bloodSosRouteManifest.mine,
    requireMember(),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const result = await service.getMine(principal.memberId);
      response.status(200).json(BloodSosMineResponse.parse(result));
    },
  );

  registerRoute(router, bloodSosRouteManifest.get,
    requireMember(),
    validate({ params: BloodSosIdParams }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const { id } = BloodSosIdParams.parse(request.params);
      const result = await service.getRequest(principal.memberId, id);
      response.status(200).json(BloodSosRequestView.parse(result));
    },
  );

  registerRoute(router, bloodSosRouteManifest.fulfil,
    requireMember(),
    ...writes,
    validate({ params: BloodSosIdParams }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const { id } = BloodSosIdParams.parse(request.params);
      const result = await service.fulfilRequest(principal.memberId, id);
      response.status(200).json(BloodSosRequestView.parse(result));
    },
  );

  registerRoute(router, bloodSosRouteManifest.cancel,
    requireMember(),
    ...writes,
    validate({ params: BloodSosIdParams }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const { id } = BloodSosIdParams.parse(request.params);
      const result = await service.cancelRequest(principal.memberId, id);
      response.status(200).json(BloodSosRequestView.parse(result));
    },
  );

  registerRoute(router, bloodSosRouteManifest.respond,
    requireMember(),
    ...respondRateLimit,
    ...writes,
    validate({ params: BloodSosIdParams }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const { id } = BloodSosIdParams.parse(request.params);
      const result = await service.respond(principal.memberId, id);
      response.status(201).json(result);
    },
  );

  registerRoute(router, bloodSosRouteManifest.report,
    requireMember(),
    ...reportRateLimit,
    ...writes,
    validate({ params: BloodSosIdParams, body: BloodSosReportBody }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const { id } = BloodSosIdParams.parse(request.params);
      const body: BloodSosReportInput = BloodSosReportBody.parse(request.body);
      const result = await service.report(principal.memberId, id, body);
      response.status(201).json(BloodSosReportResponse.parse(result));
    },
  );

  registerRoute(router, bloodSosRouteManifest.snooze,
    requireMember(),
    ...writes,
    validate({ body: BloodSosSnoozeBody }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const body: BloodSosSnoozeInput = BloodSosSnoozeBody.parse(request.body);
      const result = await service.snooze(principal.memberId, body);
      response.status(200).json(BloodSosDonorStatusResponse.parse(result));
    },
  );

  registerRoute(router, bloodSosRouteManifest.unsnooze,
    requireMember(),
    ...writes,
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      await service.unsnooze(principal.memberId);
      response.status(204).end();
    },
  );

  registerRoute(router, bloodSosRouteManifest.lastDonation,
    requireMember(),
    ...writes,
    validate({ body: BloodSosLastDonationBody }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const body: BloodSosLastDonationInput = BloodSosLastDonationBody.parse(request.body);
      const result = await service.setLastDonation(principal.memberId, body);
      response.status(200).json(BloodSosDonorStatusResponse.parse(result));
    },
  );

  registerRoute(router, bloodSosRouteManifest.donorStatus,
    requireMember(),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const result = await service.donorStatus(principal.memberId);
      response.status(200).json(BloodSosDonorStatusResponse.parse(result));
    },
  );

  return router;
}
