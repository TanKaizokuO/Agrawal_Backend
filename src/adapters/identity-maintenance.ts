import type { PrismaClient } from "../generated/prisma/client.js";
import type { SessionPurgeDatabase } from "../modules/identity/index.js";

export class PrismaSessionPurgeDatabase implements SessionPurgeDatabase {
  public constructor(private readonly db: PrismaClient) {}

  public readonly session = {
    deleteMany: async (args: {
      readonly where: {
        readonly OR?: readonly [
          { readonly revokedAt: { readonly not: null } },
          { readonly expiresAt: { readonly lt: Date } },
        ];
        readonly revokedAt?: { readonly not: null };
        readonly expiresAt?: { readonly lt: Date };
      };
    }): Promise<{ readonly count: number }> => {
      const where = args.where;
      return this.db.session.deleteMany({
        where: {
          ...(where.OR === undefined ? {} : { OR: [...where.OR] }),
          ...(where.revokedAt === undefined ? {} : { revokedAt: where.revokedAt }),
          ...(where.expiresAt === undefined ? {} : { expiresAt: where.expiresAt }),
        },
      });
    },
  };
}

export function createSessionPurgeDatabase(db: PrismaClient): SessionPurgeDatabase {
  return new PrismaSessionPurgeDatabase(db);
}
