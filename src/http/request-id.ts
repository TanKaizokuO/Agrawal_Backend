import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const REQUEST_ID_HEADER = "X-Request-Id";

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function trustedRequestId(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  const value = candidate.trim();
  if (value.length === 0 || value.length > 128 || containsControlCharacter(value)) {
    return undefined;
  }
  return value;
}

export const requestId: RequestHandler = (request, response, next) => {
  const id = trustedRequestId(request.get(REQUEST_ID_HEADER)) ?? randomUUID();
  request.id = id;
  request.headers["x-request-id"] = id;
  response.setHeader(REQUEST_ID_HEADER, id);
  next();
};

declare module "express-serve-static-core" {
  interface Request {
    id: string;
  }
}

export {};
