import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { addMilliseconds } from "../clock.js";
import type { Clock } from "../clock.js";
import { principalKey } from "./auth.js";
import { AppError } from "./errors.js";

export interface IdempotencyRecord {
  readonly principalKey: string;
  readonly key: string;
  readonly requestHash: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
  readonly createdAt: Date;
}

export interface IdempotencyStore {
  find(principalKey: string, key: string): Promise<IdempotencyRecord | null>;
  create(record: IdempotencyRecord): Promise<void>;
  purge(before: Date): Promise<number>;
}

interface IdempotencyDelegate {
  findUnique(args: {
    where: { principalKey_key: { principalKey: string; key: string } };
  }): Promise<IdempotencyRecord | null>;
  create(args: { data: IdempotencyRecord }): Promise<unknown>;
  deleteMany(args: { where: { createdAt: { lt: Date } } }): Promise<{ count: number }>;
}

export interface IdempotencyDatabase {
  readonly idempotencyRecord: IdempotencyDelegate;
}

export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly database: IdempotencyDatabase) {}

  find(principalKeyValue: string, key: string): Promise<IdempotencyRecord | null> {
    return this.database.idempotencyRecord.findUnique({
      where: { principalKey_key: { principalKey: principalKeyValue, key } },
    });
  }

  async create(record: IdempotencyRecord): Promise<void> {
    await this.database.idempotencyRecord.create({ data: record });
  }

  async purge(before: Date): Promise<number> {
    const result = await this.database.idempotencyRecord.deleteMany({
      where: { createdAt: { lt: before } },
    });
    return result.count;
  }
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
        if (existing.requestHash !== hash) {
          next(new AppError("IDEMPOTENCY_KEY_REUSED", 422));
          return;
        }
        response.status(existing.responseStatus).json(existing.responseBody);
        return;
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
        if (!captured.hasBody() || response.statusCode >= 500) {
          return finish();
        }

        const record: IdempotencyRecord = {
          principalKey: ownerKey,
          key,
          requestHash: hash,
          responseStatus: response.statusCode,
          responseBody: captured.getBody(),
          createdAt: options.clock.now(),
        };
        void options.store.create(record).then(finish, finish);
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
