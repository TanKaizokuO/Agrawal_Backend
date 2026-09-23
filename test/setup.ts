import "dotenv/config";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { createPrismaClient, type Database } from "../src/db.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const prismaCli = require.resolve("prisma/build/index.js");

const runtimeDatabaseUrl = requireTestDatabaseUrl("DATABASE_URL");
const migrationDatabaseUrl = requireTestDatabaseUrl("DATABASE_MIGRATION_URL");
const testSchema = "public";

let database: Database | undefined;
let adminPool: Pool | undefined;

function requireTestDatabaseUrl(name: "DATABASE_URL" | "DATABASE_MIGRATION_URL"): string {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Vitest database setup requires NODE_ENV=test.");
  }

  const testName = name === "DATABASE_URL" ? "TEST_DATABASE_URL" : "TEST_DATABASE_MIGRATION_URL";
  const value = process.env[testName] ?? process.env[name];
  if (!value) {
    throw new Error(`${testName} or ${name} is required for the real-Postgres test setup.`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL connection URL.`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} must be a PostgreSQL connection URL.`);
  }

  const databaseName = decodeURIComponent(url.pathname.slice(1));
  if (!/(^|[-_])test(?:ing)?($|[-_])/i.test(databaseName)) {
    throw new Error(`${name} must point to a test database, not '${databaseName}'.`);
  }

  return value;
}


function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function migrateFreshSchema(connectionString: string): Promise<void> {
  const migrationsPath = `${apiRoot}/prisma/migrations`;
  const hasMigrations =
    existsSync(migrationsPath) &&
    readdirSync(migrationsPath, { withFileTypes: true }).some((entry) => entry.isDirectory());
  const command = hasMigrations ? ["migrate", "deploy"] : ["db", "push", "--skip-generate"];

  await execFileAsync(
    process.execPath,
    [prismaCli, ...command, "--schema", "prisma/schema"],
    {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_MIGRATION_URL: connectionString,
      },
    },
  );
}

async function truncateTables(): Promise<void> {
  if (!adminPool) {
    throw new Error("The Vitest database has not been initialized.");
  }

  const result = await adminPool.query<{ schemaname: string; tablename: string }>(
    `SELECT schemaname, tablename
       FROM pg_catalog.pg_tables
      WHERE schemaname IN ('public', 'restricted')
        AND tablename <> '_prisma_migrations'`,
  );

  if (result.rows.length === 0) {
    return;
  }

  const tables = result.rows
    .map(({ schemaname, tablename }) => `${quoteIdentifier(schemaname)}.${quoteIdentifier(tablename)}`)
    .join(", ");
  await adminPool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

const testDatabaseProxy = new Proxy({} as Database, {
  get(_target, prop) {
    if (!database) {
      throw new Error("The Vitest database has not been initialized.");
    }
    const value = (database as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === "function") {
      return (...args: unknown[]): unknown =>
        (value as (...innerArgs: unknown[]) => unknown).apply(database, args);
    }
    return value;
  },
});

export function getTestDatabase(): Database {
  return testDatabaseProxy;
}

beforeAll(async () => {
  adminPool = new Pool({ connectionString: migrationDatabaseUrl });

  try {
    // Prisma models explicitly target `public`/`restricted`, so a connection
    // search-path override cannot isolate them. The URL guard above guarantees
    // this is a test database; rebuild both owned schemas for each test file.
    await adminPool.query("DROP SCHEMA IF EXISTS restricted CASCADE");
    await adminPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await adminPool.query("CREATE SCHEMA public");
    await migrateFreshSchema(migrationDatabaseUrl);
    database = createPrismaClient(runtimeDatabaseUrl);
  } catch (error) {
    await adminPool.query("DROP SCHEMA IF EXISTS restricted CASCADE").catch(() => undefined);
    await adminPool.query("DROP SCHEMA IF EXISTS public CASCADE").catch(() => undefined);
    await adminPool.query("CREATE SCHEMA IF NOT EXISTS public").catch(() => undefined);
    await adminPool.end();
    adminPool = undefined;
    throw error;
  }
});

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  const currentDatabase = database;
  database = undefined;
  await currentDatabase?.$disconnect();

  if (adminPool) {
    await adminPool.query("DROP SCHEMA IF EXISTS restricted CASCADE");
    await adminPool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await adminPool.query("CREATE SCHEMA public");
    await adminPool.end();
    adminPool = undefined;
  }
});
