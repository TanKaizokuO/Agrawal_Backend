import type { RequestHandler } from "express";
import { AppError } from "./errors.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const pair of cookieHeader.split(";")) {
    const [key, ...valueParts] = pair.trim().split("=");
    if (key === name) {
      const value = valueParts.join("=");
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

function usesBearer(request: { get(name: string): string | undefined }): boolean {
  return /^Bearer\s+\S+$/u.test(request.get("Authorization")?.trim() ?? "");
}

export interface CsrfOptions {
  readonly allowedOrigins: readonly string[];
}

export function csrf(options: CsrfOptions): RequestHandler {
  const allowedOrigins = new Set(options.allowedOrigins);
  return (request, _response, next) => {
    if (!UNSAFE_METHODS.has(request.method) || usesBearer(request)) {
      next();
      return;
    }

    const sid = cookieValue(request.get("Cookie"), "sid");
    if (sid === undefined) {
      next();
      return;
    }

    const origin = request.get("Origin");
    if (origin === undefined || !allowedOrigins.has(origin)) {
      next(new AppError("FORBIDDEN", 403));
      return;
    }
    next();
  };
}

export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}
