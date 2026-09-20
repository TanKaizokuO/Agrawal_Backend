import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import type {
  IdempotencyRecord,
  IdempotencyStore,
} from "../http/idempotency.js";
import { isRecord } from "./guards.js";

function jsonValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (isRecord(value)) {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = jsonValue(item);
    }
    return result;
  }
  return JSON.stringify(value);
}

function jsonInput(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) return Prisma.JsonNull;
  const result = jsonValue(value);
  return result === null ? Prisma.JsonNull : result;
}

export class PrismaIdempotencyStoreAdapter implements IdempotencyStore {
  public constructor(private readonly db: PrismaClient) {}

  public async find(principalKey: string, key: string): Promise<IdempotencyRecord | null> {
    const row = await this.db.idempotencyRecord.findUnique({
      where: { principalKey_key: { principalKey, key } },
    });
    return row === null ? null : row;
  }

  public async create(record: IdempotencyRecord): Promise<void> {
    await this.db.idempotencyRecord.create({
      data: {
        principalKey: record.principalKey,
        key: record.key,
        requestHash: record.requestHash,
        responseStatus: record.responseStatus,
        responseBody: jsonInput(record.responseBody),
        createdAt: record.createdAt,
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
