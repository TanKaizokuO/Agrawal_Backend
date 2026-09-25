import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { addMilliseconds } from "../clock.js";
import type { Clock } from "../clock.js";
import { principalKey } from "./auth.js";
import { AppError } from "./errors.js";

export type IdempotencyResponseHeader = string | number | readonly string[];
export type IdempotencyResponseHeaders = Readonly<Record<string, IdempotencyResponseHeader>>;

export interface IdempotencyReservation {
  readonly principalKey: string;
  readonly key: string;
  readonly requestHash: string;
  readonly createdAt: Date;
}

export interface IdempotencyRecord extends IdempotencyReservation {
  readonly responseStatus: number | null;
  readonly responseBody: unknown;
  readonly responseHeaders: IdempotencyResponseHeaders | null;
}

export interface IdempotencyStore {
  find(principalKey: string, key: string): Promise<IdempotencyRecord | null>;
  claim(reservation: IdempotencyReservation): Promise<boolean>;
  complete(record: IdempotencyRecord): Promise<void>;
  release(reservation: IdempotencyReservation): Promise<void>;
  purge(before: Date): Promise<number>;
}

export interface IdempotentOptions {
  readonly store: IdempotencyStore;
  readonly clock: Clock;
  readonly principalKey?: (request: Request) => string;
}
const IDEMPOTENCY_TTL_MILLISECONDS = 24 * 60 * 60 * 1000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function canonicalJson(value: unknown): string {
  if (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function requestHash(request: Request): string {
  const requestBody: unknown = request.body;
  const material = canonicalJson({
    method: request.method,
    path: request.originalUrl,
    body: requestBody ?? null,
  });
  return createHash("sha256").update(material).digest("hex");
}

function captureResponse(response: Response): {
  readonly getBody: () => unknown;
  readonly hasBody: () => boolean;
} {
  let body: unknown;
  let bodyWasSet = false;
  const originalJson = response.json.bind(response);
  const originalSend = response.send.bind(response);

  response.json = ((value: unknown) => {
    body = value;
    bodyWasSet = true;
    return originalJson(value);
  }) as Response["json"];
  response.send = ((value?: unknown) => {
    if (!bodyWasSet) {
      body = value ?? null;
      bodyWasSet = true;
    }
    return originalSend(value);
  }) as Response["send"];

  return {
    getBody: () => body,
    hasBody: () => bodyWasSet,
  };
}

const NON_REPLAYABLE_HEADERS: Readonly<Record<string, true>> = {
  connection: true,
  "content-length": true,
  date: true,
  "keep-alive": true,
  "proxy-authenticate": true,
  "proxy-authorization": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
  "x-request-id": true,
};

function responseHeaders(response: Response): IdempotencyResponseHeaders {
  const headers: Record<string, IdempotencyResponseHeader> = {};
  for (const [name, value] of Object.entries(response.getHeaders())) {
    if (Object.hasOwn(NON_REPLAYABLE_HEADERS, name)) continue;
    if (typeof value === "string" || typeof value === "number") {
      headers[name] = value;
    } else if (Array.isArray(value) && value.every((part) => typeof part === "string")) {
      headers[name] = value;
    }
  }
  return headers;
}

function respondFromRecord(
  record: IdempotencyRecord,
  requestHashValue: string,
  response: Response,
  next: (error?: unknown) => void,
): void {
  if (record.requestHash !== requestHashValue) {
    next(new AppError("IDEMPOTENCY_KEY_REUSED", 422));
    return;
  }
  if (record.responseStatus === null) {
    next(new AppError("CONFLICT", 409));
    return;
  }
  for (const [name, value] of Object.entries(record.responseHeaders ?? {})) {
    response.setHeader(name, value);
  }
  response.status(record.responseStatus).json(record.responseBody);
}


export function idempotent(options: IdempotentOptions): RequestHandler {
  const keyFor = options.principalKey ?? principalKey;
  return async (request, response, next) => {
    const key = request.get("Idempotency-Key")?.trim();
    if (key === undefined || key.length === 0) {
      next(new AppError("IDEMPOTENCY_KEY_REQUIRED", 400));
      return;
    }
    if (!UUID_PATTERN.test(key)) {
      next(new AppError("IDEMPOTENCY_KEY_INVALID", 400));
      return;
    }

    const ownerKey = keyFor(request);
    const hash = requestHash(request);
    try {
      let existing = await options.store.find(ownerKey, key);
      if (
        existing !== null &&
        options.clock.now().getTime() - existing.createdAt.getTime() >=
          IDEMPOTENCY_TTL_MILLISECONDS
      ) {
        await options.store.purge(
          addMilliseconds(options.clock.now(), -IDEMPOTENCY_TTL_MILLISECONDS),
        );
        existing = await options.store.find(ownerKey, key);
      }
      if (existing !== null) {
        respondFromRecord(existing, hash, response, next);
        return;
      }

      const reservation: IdempotencyReservation = {
        principalKey: ownerKey,
        key,
        requestHash: hash,
        createdAt: options.clock.now(),
      };
      let claimed = await options.store.claim(reservation);
      if (!claimed) {
        existing = await options.store.find(ownerKey, key);
        if (existing !== null) {
          respondFromRecord(existing, hash, response, next);
          return;
        }
        claimed = await options.store.claim(reservation);
        if (!claimed) {
          existing = await options.store.find(ownerKey, key);
          if (existing === null) throw new AppError("INTERNAL", 500);
          respondFromRecord(existing, hash, response, next);
          return;
        }
      }

      const captured = captureResponse(response);
      const originalEnd = response.end.bind(response) as (
        chunk?: unknown,
        encoding?: BufferEncoding | (() => void),
        callback?: () => void,
      ) => Response;
      let ending = false;
      response.end = ((chunk, encoding, callback) => {
        if (ending) return response;
        ending = true;
        const finish = (): Response => {
          if (typeof encoding === "function") return originalEnd(chunk, encoding);
          return originalEnd(chunk, encoding, callback);
        };
        if (response.statusCode >= 200 && response.statusCode < 300) {
          const record: IdempotencyRecord = {
            ...reservation,
            responseStatus: response.statusCode,
            responseBody: captured.hasBody() ? captured.getBody() : null,
            responseHeaders: responseHeaders(response),
            createdAt: options.clock.now(),
          };
          void options.store.complete(record).then(finish, (error: unknown) => {
            response.end = originalEnd as Response["end"];
            next(error);
          });
        } else {
          void options.store.release(reservation).then(finish, (error: unknown) => {
            response.end = originalEnd as Response["end"];
            next(error);
          });
        }
        return response;
      }) as Response["end"];
      next();
    } catch (error) {
      next(error);
    }
  };
}

export async function purgeIdempotencyRecords(
  store: IdempotencyStore,
  clock: Clock,
): Promise<number> {
  const before = addMilliseconds(clock.now(), -IDEMPOTENCY_TTL_MILLISECONDS);
  return store.purge(before);
}
