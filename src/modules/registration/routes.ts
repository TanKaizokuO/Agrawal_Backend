import { Router, type Request, type Response } from "express";
import {
  requireApplicant,
  requireHead,
  requirePrincipal,
  type ApplicantPrincipal,
} from "../../http/auth.js";
import { AppError } from "../../http/errors.js";
import { idempotent, type IdempotencyStore } from "../../http/idempotency.js";
import {
  configuredRateLimit,
  type RateLimiter,
} from "../../http/rate-limit.js";
import { validate } from "../../http/validate.js";
import type { Clock } from "../../clock.js";
import type { RegistrationService, SubmitResult } from "./service.js";
import {
  DeclineJoinBody,
  FamilyCheckQuery,
  FamilyCheckResponse,
  JoinRequestIdParams,
  JoinRequestListResponse,
  PaymentOrderResponse,
  RegistrationResponse,
  RomanizeBody,
  RomanizeResponse,
  SubmitBody,
  SubmitResponse,
} from "./schemas.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";

export const registrationRouteManifest = defineRouteManifest({
  getRegistration: { method: "get", path: "/v1/registration" },
  checkFamily: { method: "get", path: "/v1/registration/family-check" },
  createPaymentOrder: { method: "post", path: "/v1/registration/payment-order" },
  submitRegistration: { method: "post", path: "/v1/registration/submit" },
  cancelRegistration: { method: "delete", path: "/v1/registration" },
  romanize: { method: "post", path: "/v1/romanize" },
  listJoinRequests: { method: "get", path: "/v1/families/mine/join-requests" },
  approveJoinRequest: {
    method: "post",
    path: "/v1/families/mine/join-requests/:registrationId/approve",
  },
  declineJoinRequest: {
    method: "post",
    path: "/v1/families/mine/join-requests/:registrationId/decline",
  },
} as const);

export interface RegistrationRouteDeps {
  readonly service: RegistrationService;
  readonly idempotencyStore: IdempotencyStore;
  readonly clock: Clock;
  readonly rateLimiter?: RateLimiter;
}

function applicant(request: Request): ApplicantPrincipal {
  const principal = request.principal;
  if (principal?.kind !== "APPLICANT") throw new AppError("UNAUTHENTICATED", 401);
  return principal;
}

function applicantRegistrationKey(request: Request): string {
  return applicant(request).registrationId;
}

function sessionKey(request: Request): string {
  const principal = request.principal;
  if (principal === null) throw new AppError("UNAUTHENTICATED", 401);
  return principal.sessionId;
}

function submitResponse(result: SubmitResult): unknown {
  if (result.status === "COMPLETED") {
    return SubmitResponse.parse({
      status: result.status,
      memberId: result.memberId,
      family: result.family,
      completedAt: result.completedAt.toISOString(),
    });
  }
  return SubmitResponse.parse({
    status: result.status,
    family: result.family,
    expiresAt: result.expiresAt.toISOString(),
  });
}

function idempotencyMiddleware(deps: RegistrationRouteDeps) {
  return idempotent({ store: deps.idempotencyStore, clock: deps.clock });
}

export function createRegistrationRoutes(deps: RegistrationRouteDeps): Router {
  const router = Router();

  registerRoute(router, registrationRouteManifest.getRegistration, requireApplicant(), async (request: Request, response: Response) => {
    const principal = applicant(request);
    response.json(RegistrationResponse.parse(
      await deps.service.getCurrent(principal.registrationId, principal.phoneE164),
    ));
  });

  registerRoute(router, registrationRouteManifest.checkFamily,
    requireApplicant(),
    ...configuredRateLimit(deps.rateLimiter, {
      name: "registration.familyCheck",
      key: sessionKey,
      limit: 30,
      windowSeconds: 60 * 60,
    }),
    validate({ query: FamilyCheckQuery }),
    async (request: Request, response: Response) => {
      const query = FamilyCheckQuery.parse(request.query);
      response.json(FamilyCheckResponse.parse(await deps.service.familyCheck(query.familyPublicId)));
    },
  );

  registerRoute(router, registrationRouteManifest.createPaymentOrder,
    requireApplicant(),
    ...configuredRateLimit(deps.rateLimiter, {
      name: "registration.paymentOrder",
      key: applicantRegistrationKey,
      limit: 5,
      windowSeconds: 60 * 60,
    }),
    idempotencyMiddleware(deps),
    async (request: Request, response: Response) => {
      const principal = applicant(request);
      const order = await deps.service.createPaymentOrder(principal.registrationId, principal.phoneE164);
      response.status(201).json(PaymentOrderResponse.parse(order));
    },
  );

  registerRoute(router, registrationRouteManifest.submitRegistration,
    requireApplicant(),
    ...configuredRateLimit(deps.rateLimiter, {
      name: "registration.submit",
      key: applicantRegistrationKey,
      limit: 10,
      windowSeconds: 60 * 60,
    }),
    validate({ body: SubmitBody }),
    idempotencyMiddleware(deps),
    async (request: Request, response: Response) => {
      const principal = applicant(request);
      const result = await deps.service.submit(
        principal.registrationId,
        principal.phoneE164,
        SubmitBody.parse(request.body),
      );
      response.status(result.status === "COMPLETED" ? 201 : 202).json(submitResponse(result));
    },
  );

  registerRoute(router, registrationRouteManifest.cancelRegistration, requireApplicant(), async (request: Request, response: Response) => {
    const principal = applicant(request);
    response.json(await deps.service.cancel(principal.registrationId, principal.phoneE164));
  });

  registerRoute(router, registrationRouteManifest.romanize,
    requirePrincipal(),
    ...configuredRateLimit(deps.rateLimiter, {
      name: "romanize",
      key: sessionKey,
      limit: 60,
      windowSeconds: 60 * 60,
    }),
    validate({ body: RomanizeBody }),
    async (request: Request, response: Response) => {
      const body = RomanizeBody.parse(request.body);
      response.json(RomanizeResponse.parse({ latin: await deps.service.romanize(body.text) }));
    },
  );

  registerRoute(router, registrationRouteManifest.listJoinRequests,
    requireHead(),
    async (request: Request, response: Response) => {
      const principal = request.principal;
      if (principal?.kind !== "MEMBER") throw new AppError("UNAUTHENTICATED", 401);
      const items = await deps.service.listJoinRequests(principal.memberId);
      response.json(JoinRequestListResponse.parse({
        items: items.map((item) => ({
          registrationId: item.registrationId,
          name: item.name,
          fatherOrHusbandName: item.fatherOrHusbandName,
          gender: item.gender,
          city: item.city,
          state: item.state,
          submittedAt: item.submittedAt.toISOString(),
          expiresAt: item.expiresAt.toISOString(),
          flags: item.flags,
        })),
      }));
    },
  );

  registerRoute(router, registrationRouteManifest.approveJoinRequest,
    requireHead(),
    validate({ params: JoinRequestIdParams }),
    idempotencyMiddleware(deps),
    async (request: Request, response: Response) => {
      const principal = request.principal;
      if (principal?.kind !== "MEMBER") throw new AppError("UNAUTHENTICATED", 401);
      const { registrationId } = JoinRequestIdParams.parse(request.params);
      const result = await deps.service.approveJoin(registrationId, principal.memberId);
      response.status(201).json(submitResponse(result));
    },
  );

  registerRoute(router, registrationRouteManifest.declineJoinRequest,
    requireHead(),
    validate({ params: JoinRequestIdParams, body: DeclineJoinBody }),
    idempotencyMiddleware(deps),
    async (request: Request, response: Response) => {
      const principal = request.principal;
      if (principal?.kind !== "MEMBER") throw new AppError("UNAUTHENTICATED", 401);
      const { registrationId } = JoinRequestIdParams.parse(request.params);
      const result = await deps.service.declineJoin(
        registrationId,
        principal.memberId,
        DeclineJoinBody.parse(request.body),
      );
      response.status(200).json(result);
    },
  );

  return router;
}
