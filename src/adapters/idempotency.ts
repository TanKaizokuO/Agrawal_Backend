import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type {
  IdempotencyRecord,
  IdempotencyReservation,
  IdempotencyResponseHeaders,
  IdempotencyStore,
} from "../http/idempotency.js";
import { isRecord } from "./guards.js";
import { jsonInputValue } from "./prisma-json.js";

function storedResponseHeaders(value: unknown): IdempotencyResponseHeaders | null {
  if (!isRecord(value)) return null;
  const headers: Record<string, string | number | readonly string[]> = {};
  for (const [name, header] of Object.entries(value)) {
    if (typeof header === "string" || typeof header === "number") {
      headers[name] = header;
    } else if (Array.isArray(header) && header.every((part) => typeof part === "string")) {
      headers[name] = header;
    }
  }
  return headers;
}

export class PrismaIdempotencyStoreAdapter implements IdempotencyStore {
  public constructor(private readonly db: PrismaClient) {}

  public async find(principalKey: string, key: string): Promise<IdempotencyRecord | null> {
    const row = await this.db.idempotencyRecord.findUnique({
      where: { principalKey_key: { principalKey, key } },
    });
    return row === null
      ? null
      : {
          principalKey: row.principalKey,
          key: row.key,
          requestHash: row.requestHash,
          responseStatus: row.responseStatus,
          responseBody: row.responseBody,
          responseHeaders: storedResponseHeaders(row.responseHeaders),
          createdAt: row.createdAt,
        };
  }

  public async claim(reservation: IdempotencyReservation): Promise<boolean> {
    const result = await this.db.idempotencyRecord.createMany({
      data: {
        principalKey: reservation.principalKey,
        key: reservation.key,
        requestHash: reservation.requestHash,
        responseStatus: null,
        responseBody: Prisma.DbNull,
        responseHeaders: Prisma.DbNull,
        createdAt: reservation.createdAt,
      },
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  public async complete(record: IdempotencyRecord): Promise<void> {
    if (record.responseStatus === null) {
      throw new Error("An idempotency response must have a status before completion.");
    }
    await this.db.idempotencyRecord.update({
      where: {
        principalKey_key: {
          principalKey: record.principalKey,
          key: record.key,
        },
      },
      data: {
        requestHash: record.requestHash,
        responseStatus: record.responseStatus,
        responseBody: jsonInputValue(record.responseBody),
        responseHeaders: record.responseHeaders === null
          ? Prisma.DbNull
          : jsonInputValue(record.responseHeaders),
        createdAt: record.createdAt,
      },
    });
  }

  public async release(reservation: IdempotencyReservation): Promise<void> {
    await this.db.idempotencyRecord.deleteMany({
      where: {
        principalKey: reservation.principalKey,
        key: reservation.key,
        requestHash: reservation.requestHash,
        responseStatus: null,
        createdAt: reservation.createdAt,
      },
    });
  }


  public async purge(before: Date): Promise<number> {
    const result = await this.db.idempotencyRecord.deleteMany({ where: { createdAt: { lt: before } } });
    return result.count;
  }
}

export function createIdempotencyStore(db: PrismaClient): IdempotencyStore {
  return new PrismaIdempotencyStoreAdapter(db);
}
