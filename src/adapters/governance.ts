import type { PrismaClient } from "../generated/prisma/client.js";
import { AppError } from "../http/errors.js";
import type { MemberLanguageResolver } from "../modules/notifications/index.js";
import type {
  ErasureRequestsQueryInput,
  OfficerErasureRequestPort,
} from "../modules/officer/index.js";

function offsetFor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError("VALIDATION_FAILED", 400);
  }
  return offset;
}
function nextCursor(offset: number, hasMore: boolean): string | null {
  return hasMore ? Buffer.from(String(offset)).toString("base64url") : null;
}

export class PrismaOfficerErasureRequests implements OfficerErasureRequestPort {
  public constructor(private readonly db: PrismaClient) {}

  public async list(input: ErasureRequestsQueryInput): Promise<{
    readonly items: readonly {
      readonly id: string;
      readonly memberId: string;
      readonly source: string;
      readonly status: string;
      readonly requestedAt: Date;
    }[];
    readonly nextCursor: string | null;
  }> {
    const offset = offsetFor(input.cursor);
    const rows = await this.db.erasureRequest.findMany({
      where: { status: input.status },
      orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
      skip: offset,
      take: input.limit + 1,
      select: { id: true, memberId: true, source: true, status: true, requestedAt: true },
    });
    return {
      items: rows.slice(0, input.limit),
      nextCursor: nextCursor(offset + input.limit, rows.length > input.limit),
    };
  }
}

export class PrismaMemberLanguageResolver implements MemberLanguageResolver {
  public constructor(private readonly db: PrismaClient) {}

  public async languageForMember(memberId: string): Promise<"en" | "hi"> {
    const member = await this.db.member.findUnique({
      where: { id: memberId },
      select: { uiLanguage: true },
    });
    return member?.uiLanguage.toLowerCase().startsWith("hi") === true ? "hi" : "en";
  }
}

export function createOfficerErasureRequests(db: PrismaClient): OfficerErasureRequestPort {
  return new PrismaOfficerErasureRequests(db);
}

export function createMemberLanguageResolver(db: PrismaClient): MemberLanguageResolver {
  return new PrismaMemberLanguageResolver(db);
}
