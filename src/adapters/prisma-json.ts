import { Prisma } from "../generated/prisma/client.js";
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

export function jsonInputValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === null) return Prisma.JsonNull;
  const result = jsonValue(value);
  return result === null ? Prisma.JsonNull : result;
}
