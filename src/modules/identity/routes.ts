import { Router, type Request, type Response } from "express";
import {
  expiredSessionCookie,
  requirePrincipal,
  sessionCookie,
  type ApplicantPrincipal,
  type MemberPrincipal,
  type Principal,
} from "../../http/auth.js";
import { validate } from "../../http/validate.js";
import { AppError } from "../../http/errors.js";
import type { IdentityService } from "./service.js";
import {
  CreateSessionBody,
  RequestOtpBody,
  type PublicPrincipal,
} from "./schemas.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";

export const identityRouteManifest = defineRouteManifest({
  requestOtp: { method: "post", path: "/v1/auth/otp" },
  createSession: { method: "post", path: "/v1/auth/session" },
  authMe: { method: "get", path: "/v1/auth/me" },
  deleteSession: { method: "delete", path: "/v1/auth/session" },
} as const);

export interface IdentityRouteDeps {
  readonly service: IdentityService;
}

function publicPrincipal(principal: Principal): PublicPrincipal {
  if (principal.kind === "APPLICANT") {
    const applicant: ApplicantPrincipal = principal;
    return {
      kind: applicant.kind,
      phoneE164: applicant.phoneE164,
      registrationId: applicant.registrationId,
    };
  }
  const member: MemberPrincipal = principal;
  return {
    kind: member.kind,
    phoneE164: member.phoneE164,
    memberId: member.memberId,
    familyPublicId: member.familyPublicId,
    roles: [...member.roles],
    isHead: member.isHead,
  };
}


function currentPrincipal(request: Request): Principal {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError("UNAUTHENTICATED", 401);
  }
  return principal;
}

export function createIdentityRoutes(deps: IdentityRouteDeps): Router {
  const router = Router();

  registerRoute(router, identityRouteManifest.requestOtp,
    validate({ body: RequestOtpBody }),
    async (request: Request, response: Response) => {
      const body = RequestOtpBody.parse(request.body);
      const result = await deps.service.requestOtp({
        client: body.client,
        phoneE164: body.phoneE164,
        ipAddress: request.ip || "unknown",
      });
      response.status(202).json(result);
    },
  );

  registerRoute(router, identityRouteManifest.createSession,
    validate({ body: CreateSessionBody }),
    async (request: Request, response: Response) => {
      const body = CreateSessionBody.parse(request.body);
      const userAgent = request.get("User-Agent");
      const created = await deps.service.createSession({
        authentication: body.authentication,
        client: body.client,
        ipAddress: request.ip || "unknown",
        ...(userAgent === undefined ? {} : { userAgent }),
      });
      const principal = publicPrincipal(created.principal);
      if (body.client === "WEB") {
        response.setHeader(
          "Set-Cookie",
          sessionCookie(created.token, deps.service.sessionTtlSeconds("WEB")),
        );
        response.status(201).json({ principal });
        return;
      }
      response.status(201).json({ principal, token: created.token });
    },
  );

  registerRoute(router, identityRouteManifest.authMe,
    requirePrincipal(),
    (request: Request, response: Response) => {
      response.json({ principal: publicPrincipal(currentPrincipal(request)) });
    },
  );

  registerRoute(router, identityRouteManifest.deleteSession,
    requirePrincipal(),
    async (request: Request, response: Response) => {
      const credentials = await deps.service.revokeCurrentSession(request);
      if (credentials.source === "COOKIE") {
        response.setHeader("Set-Cookie", expiredSessionCookie());
      }
      response.status(204).send();
    },
  );

  return router;
}

