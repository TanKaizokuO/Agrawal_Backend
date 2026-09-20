import "dotenv/config";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { createPrismaClient, type Database } from "../src/db.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const prismaCli = require.resolve("prisma/build/index.js");

const runtimeDatabaseUrl = requireTestDatabaseUrl("DATABASE_URL");
const migrationDatabaseUrl = requireTestDatabaseUrl("DATABASE_MIGRATION_URL");
const testSchema = `vitest_${String(process.pid)}_${randomUUID().replaceAll("-", "")}`;

let database: Database | undefined;
let adminPool: Pool | undefined;

function requireTestDatabaseUrl(name: "DATABASE_URL" | "DATABASE_MIGRATION_URL"): string {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Vitest database setup requires NODE_ENV=test.");
  }

  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for the real-Postgres test setup.`);
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

function withSchema(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("schema", testSchema);
  return url.toString();
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

  const result = await adminPool.query<{ tablename: string }>(
    `SELECT tablename
       FROM pg_catalog.pg_tables
      WHERE schemaname = $1
        AND tablename <> '_prisma_migrations'`,
    [testSchema],
  );

  if (result.rows.length === 0) {
    return;
  }

  const tables = result.rows
    .map(({ tablename }) => `${quoteIdentifier(testSchema)}.${quoteIdentifier(tablename)}`)
    .join(", ");
  await adminPool.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

export function getTestDatabase(): Database {
  if (!database) {
    throw new Error("The Vitest database has not been initialized.");
  }
  return database;
}

beforeAll(async () => {
  const migrationUrl = withSchema(migrationDatabaseUrl);
  const runtimeUrl = withSchema(runtimeDatabaseUrl);
  adminPool = new Pool({ connectionString: migrationDatabaseUrl });

  try {
    await adminPool.query(`CREATE SCHEMA ${quoteIdentifier(testSchema)}`);
    await migrateFreshSchema(migrationUrl);
    database = createPrismaClient(runtimeUrl);
  } catch (error) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(testSchema)} CASCADE`).catch(() => undefined);
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
    await adminPool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(testSchema)} CASCADE`);
    await adminPool.end();
    adminPool = undefined;
  }
});
