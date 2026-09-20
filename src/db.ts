import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Database = PrismaClient;

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const schema = new URL(databaseUrl).searchParams.get("schema");
  const adapter = schema
    ? new PrismaPg({ connectionString: databaseUrl }, { schema })
    : new PrismaPg({ connectionString: databaseUrl });

  return new PrismaClient({ adapter });
}
export interface DatabaseHealth {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export async function checkDatabase(database: DatabaseHealth): Promise<void> {
  await database.$queryRaw`SELECT 1`;
}
