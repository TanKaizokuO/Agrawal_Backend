import { PrismaClient } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import type {
  MemberLookupQueryInput,
  OfficerMemberLookupPort,
} from "../modules/officer/index.js";

function offsetFor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new AppError("VALIDATION_FAILED", 400);
  }
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError("VALIDATION_FAILED", 400);
  }
  return offset;
}

function nextCursor(offset: number, hasMore: boolean): string | null {
  return hasMore ? Buffer.from(String(offset)).toString("base64url") : null;
}

export class PrismaOfficerMemberLookup implements OfficerMemberLookupPort {
  public constructor(private readonly db: PrismaClient) {}

  public async lookup(input: MemberLookupQueryInput): Promise<{
    readonly memberIds: readonly string[];
    readonly nextCursor: string | null;
  }> {
    const offset = offsetFor(input.cursor);
    const take = input.limit + 1;
    if (input.phone !== undefined) {
      const rows = await this.db.member.findMany({
        where: { phoneE164: input.phone },
        select: { id: true },
        orderBy: { id: "asc" },
        skip: offset,
        take,
      });
      return this.page(rows.map((row) => row.id), offset, input.limit);
    }
    if (input.familyPublicId !== undefined) {
      const rows = await this.db.familyLink.findMany({
        where: { family: { publicId: input.familyPublicId } },
        select: { memberId: true },
        orderBy: { memberId: "asc" },
        skip: offset,
        take,
      });
      return this.page(rows.map((row) => row.memberId), offset, input.limit);
    }

    const query = input.q;
    if (query === undefined) throw new AppError("VALIDATION_FAILED", 400);
    const rows = await this.db.member.findMany({
      where: {
        OR: [
          { nameEn: { contains: query, mode: "insensitive" } },
          { nameHi: { contains: query, mode: "insensitive" } },
          { city: { contains: query, mode: "insensitive" } },
        ],
      },
      select: { id: true },
      orderBy: { id: "asc" },
      skip: offset,
      take,
    });
    return this.page(rows.map((row) => row.id), offset, input.limit);
  }

  private page(
    memberIds: readonly string[],
    offset: number,
    limit: number,
  ): { readonly memberIds: readonly string[]; readonly nextCursor: string | null } {
    return {
      memberIds: memberIds.slice(0, limit),
      nextCursor: nextCursor(offset + limit, memberIds.length > limit),
    };
  }
}

export function createOfficerMemberLookup(db: PrismaClient): OfficerMemberLookupPort {
  return new PrismaOfficerMemberLookup(db);
}
