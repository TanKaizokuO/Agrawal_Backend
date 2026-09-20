import express, { Router, type Request, type RequestHandler, type Response } from "express";
import { principalKey, requirePrincipal } from "../../http/auth.js";
import { isRecord } from "../../adapters/guards.js";
import { AppError } from "../../http/errors.js";
import {
  configuredRateLimit,
  type RateLimiter,
} from "../../http/rate-limit.js";
import {
  ImagePurposeSchema,
  UploadImageResponse,
} from "./schemas.js";
import type { MediaService } from "./service.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";

export interface MediaRouteDeps {
  readonly service: MediaService;
  readonly maxUploadBytes?: number;
  readonly rateLimiter?: RateLimiter;
}

export const mediaRouteManifest = defineRouteManifest({
  uploadImage: { method: "post", path: "/v1/media/images" },
} as const);

interface MultipartPart {
  readonly name: string;
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

interface UploadParts {
  readonly purpose: string;
  readonly file: Uint8Array;
  readonly fileContentType: string;
}

function concurrentTransformGuard(): RequestHandler {
  const activePrincipals = new Set<string>();
  return (request, response, next) => {
    const key = principalKey(request);
    if (activePrincipals.has(key)) {
      next(AppError.rateLimited(1));
      return;
    }
    activePrincipals.add(key);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      activePrincipals.delete(key);
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };
}

export function createMediaRoutes(deps: MediaRouteDeps): Router {
  const router = Router();
  const rawMultipart = multipartBodyParser(deps.maxUploadBytes);
  const uploadRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "media.upload",
    key: principalKey,
    limit: 20,
    windowSeconds: 60 * 60,
  });
  const transformGuard = concurrentTransformGuard();

  registerRoute(router, mediaRouteManifest.uploadImage,
    requirePrincipal(),
    ...uploadRateLimit,
    transformGuard,
    rawMultipart,
    async (request: Request, response: Response) => {
      const parts = parseUploadParts(request.body, request.get("Content-Type"));
      const purpose = ImagePurposeSchema.parse(parts.purpose);
      const principal = request.principal;
      if (principal === null) throw new AppError("UNAUTHENTICATED", 401);
      const owner = principal.kind === "APPLICANT"
        ? { registrationId: principal.registrationId }
        : { memberId: principal.memberId };
      const uploaded = await deps.service.upload({
        purpose,
        body: parts.file,
        contentType: parts.fileContentType,
        owner,
      });
      response.status(201).json(
        UploadImageResponse.parse({
          imageId: uploaded.imageId,
          status: uploaded.status,
          previewUrl: uploaded.previewUrl,
        }),
      );
    },
  );

  return router;
}

function multipartBodyParser(maxUploadBytes = 9 * 1024 * 1024): RequestHandler {
  const parser = express.raw({
    type: (request) => {
      const contentType = request.headers["content-type"];
      return typeof contentType === "string"
        && /^multipart\/form-data(?:\s*;|$)/iu.test(contentType);
    },
    limit: maxUploadBytes,
  });
  return (request, response, next) => {
    parser(request, response, (error?: unknown) => {
      if (error === undefined) {
        next();
        return;
      }
      if (isPayloadTooLarge(error)) {
        next(new AppError("IMAGE_TOO_LARGE", 413));
        return;
      }
      next(error);
    });
  };
}

function parseUploadParts(body: unknown, contentType: string | undefined): UploadParts {
  if (!Buffer.isBuffer(body)) throw new AppError("UNSUPPORTED_MEDIA_TYPE", 415);
  const boundary = multipartBoundary(contentType);
  if (boundary === null) throw new AppError("UNSUPPORTED_MEDIA_TYPE", 415);
  const parts = parseMultipart(body, boundary);
  const purposePart = parts.find((part) => part.name === "purpose");
  const filePart = parts.find((part) => part.name === "file");
  if (purposePart === undefined || filePart === undefined || purposePart.body.byteLength === 0) {
    throw new AppError("VALIDATION_FAILED", 400);
  }
  return {
    purpose: Buffer.from(purposePart.body).toString("utf8").trim(),
    file: filePart.body,
    fileContentType: filePart.contentType ?? "application/octet-stream",
  };
}

function multipartBoundary(contentType: string | undefined): string | null {
  if (contentType === undefined) return null;
  const match = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  return boundary === undefined || boundary.length === 0 ? null : boundary;
}

function parseMultipart(body: Buffer, boundary: string): readonly MultipartPart[] {
  const delimiter = Buffer.from(`--${boundary}`, "utf8");
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(delimiter);
  while (cursor >= 0) {
    let partStart = cursor + delimiter.byteLength;
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from("--"))) break;
    if (body.subarray(partStart, partStart + 2).equals(Buffer.from("\r\n"))) partStart += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), partStart);
    if (headerEnd < 0) throw new AppError("VALIDATION_FAILED", 400);
    const nextDelimiter = body.indexOf(delimiter, headerEnd + 4);
    if (nextDelimiter < 0) throw new AppError("VALIDATION_FAILED", 400);
    const contentEnd = body.subarray(nextDelimiter - 2, nextDelimiter).equals(Buffer.from("\r\n"))
      ? nextDelimiter - 2
      : nextDelimiter;
    const headers = parsePartHeaders(body.subarray(partStart, headerEnd).toString("utf8"));
    const name = partName(headers["content-disposition"]);
    if (name !== null) {
      parts.push({
        name,
        contentType: headers["content-type"] ?? null,
        body: body.subarray(headerEnd + 4, contentEnd),
      });
    }
    cursor = nextDelimiter;
  }
  return parts;
}

function parsePartHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of value.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function partName(contentDisposition: string | undefined): string | null {
  if (contentDisposition === undefined) return null;
  const match = /(?:^|;)\s*name="([^"]+)"/iu.exec(contentDisposition);
  return match?.[1] ?? null;
}

function isPayloadTooLarge(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.type === "entity.too.large";
}
