import type { Request, RequestHandler } from "express";
import { AppError } from "./errors.js";

export type PrincipalKind = "APPLICANT" | "MEMBER";
export type PrincipalRole = "OFFICER" | "OPERATOR" | "ORGANISER";

export interface ApplicantPrincipal {
  readonly kind: "APPLICANT";
  readonly sessionId: string;
  readonly phoneE164: string;
  readonly registrationId: string;
}

export interface MemberPrincipal {
  readonly kind: "MEMBER";
  readonly sessionId: string;
  readonly phoneE164: string;
  readonly memberId: string;
  readonly familyPublicId: string;
  readonly roles: readonly PrincipalRole[];
  readonly isHead: boolean;
}

export type Principal = ApplicantPrincipal | MemberPrincipal;

export interface PrincipalResolver {
  resolve(request: Request): Promise<Principal | null>;
}

export interface SessionCredentials {
  readonly token: string;
  readonly source: "COOKIE" | "BEARER";
}

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const [key, ...valueParts] = pair.trim().split("=");
    if (key !== name) continue;
    const value = valueParts.join("=").trim();
    return value.length === 0 ? undefined : value;
  }
  return undefined;
}

function validationError(path: string, message: string): AppError {
  return new AppError("VALIDATION_FAILED", 400, {
    issues: [{ path: [path], message }],
  });
}

/**
 * Reads the two supported first-party session transports. A request is never
 * allowed to select one transport implicitly when it supplied the other.
 */
export function sessionCredentials(request: Pick<Request, "get">): SessionCredentials | null {
  const cookieToken = cookieValue(request.get("Cookie"), "sid");
  const authorization = request.get("Authorization")?.trim();
  const hasBearer = authorization !== undefined && authorization.length > 0;

  if (cookieToken !== undefined && hasBearer) {
    throw validationError(
      "headers.authorization",
      "Use either the sid cookie or an Authorization bearer token, not both.",
    );
  }
  if (cookieToken !== undefined) {
    return { token: cookieToken, source: "COOKIE" };
  }
  if (!hasBearer) return null;

  const match = /^Bearer\s+(\S+)$/u.exec(authorization);
  if (match === null || match[1] === undefined) {
    throw validationError("headers.authorization", "Authorization must be a bearer token.");
  }
  return { token: match[1], source: "BEARER" };
}

declare module "express-serve-static-core" {
  interface Request {
    principal: Principal | null;
  }
}

export function authenticate(resolver?: PrincipalResolver): RequestHandler {
  return async (request, _response, next) => {
    try {
      const credentials = sessionCredentials(request);
      if (credentials === null || resolver === undefined) {
        request.principal = null;
      } else {
        request.principal = await resolver.resolve(request);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}


export function requirePrincipal(): RequestHandler {
  return (request, _response, next) => {
    if (request.principal === null) {
      next(new AppError("UNAUTHENTICATED", 401));
      return;
    }
    next();
  };
}

export function requireApplicant(): RequestHandler {
  return (request, _response, next) => {
    const unauthenticated = request.principal === null;
    if (request.principal?.kind !== "APPLICANT") {
      next(
        new AppError(
          unauthenticated ? "UNAUTHENTICATED" : "FORBIDDEN",
          unauthenticated ? 401 : 403,
        ),
      );
      return;
    }
    next();
  };
}
export function requireMember(): RequestHandler {
  return (request, _response, next) => {
    const unauthenticated = request.principal === null;
    if (request.principal?.kind !== "MEMBER") {
      next(
        new AppError(
          unauthenticated ? "UNAUTHENTICATED" : "FORBIDDEN",
          unauthenticated ? 401 : 403,
        ),
      );
      return;
    }
    next();
  };
}

export function requireRole(role: PrincipalRole): RequestHandler {
  return (request, _response, next) => {
    if (request.principal === null) {
      next(new AppError("UNAUTHENTICATED", 401));
      return;
    }
    if (
      request.principal.kind !== "MEMBER" ||
      !request.principal.roles.includes(role)
    ) {
      next(new AppError("FORBIDDEN", 403));
      return;
    }
    next();
  };
}

export function requireHead(): RequestHandler {
  return (request, _response, next) => {
    if (request.principal === null) {
      next(new AppError("UNAUTHENTICATED", 401));
      return;
    }
    if (request.principal.kind !== "MEMBER" || !request.principal.isHead) {
      next(new AppError("FORBIDDEN", 403));
      return;
    }
    next();
  };
}
export function principalKey(request: Request): string {
  const principal = request.principal;
  if (principal === null) {
    return `anonymous:${request.ip ?? "unknown"}`;
  }
  if (principal.kind === "MEMBER") return `member:${principal.memberId}`;
  return `registration:${principal.registrationId}`;
}

export {};
