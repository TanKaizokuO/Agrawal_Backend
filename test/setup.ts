import "dotenv/config";
import { randomUUID } from "node:crypto";
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
const appDatabaseUrl = process.env.TEST_APP_DATABASE_URL
  ? requireTestDatabaseUrl("TEST_APP_DATABASE_URL")
  : undefined;
const testDatabaseName = `test_${process.pid.toString()}_${randomUUID().replaceAll("-", "")}`;
const testRuntimeDatabaseUrl = databaseUrlForName(runtimeDatabaseUrl, testDatabaseName);
const testMigrationDatabaseUrl = databaseUrlForName(migrationDatabaseUrl, testDatabaseName);
const testAppDatabaseUrl = appDatabaseUrl
  ? databaseUrlForName(appDatabaseUrl, testDatabaseName)
  : undefined;

let database: Database | undefined;
let testDatabaseCreated = false;
let adminPool: Pool | undefined;
let maintenancePool: Pool | undefined;
// Resolve when each admin pool connection's socket has closed; see
// releaseTestDatabaseResources.
const adminConnectionsClosed: Promise<void>[] = [];

type TestDatabaseUrlName = "DATABASE_URL" | "DATABASE_MIGRATION_URL" | "TEST_APP_DATABASE_URL";

function requireTestDatabaseUrl(name: TestDatabaseUrlName): string {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Vitest database setup requires NODE_ENV=test.");
  }

  const testName =
    name === "DATABASE_URL"
      ? "TEST_DATABASE_URL"
      : name === "DATABASE_MIGRATION_URL"
        ? "TEST_DATABASE_MIGRATION_URL"
        : name;
  const value = process.env[testName] ?? process.env[name];
  if (!value) {
    const configuredNames = testName === name ? name : `${testName} or ${name}`;
    throw new Error(`${configuredNames} is required for the real-Postgres test setup.`);
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

function databaseUrlForName(connectionString: string, databaseName: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${databaseName}`;
  return url.toString();
}


function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function dropTestDatabase(): Promise<void> {
  if (!maintenancePool || !testDatabaseCreated) {
    return;
  }

  await maintenancePool.query(
    `DROP DATABASE IF EXISTS ${quoteIdentifier(testDatabaseName)} WITH (FORCE)`,
  );
  testDatabaseCreated = false;
}

async function releaseTestDatabaseResources(): Promise<void> {
  const currentAdminPool = adminPool;
  adminPool = undefined;
  try {
    await currentAdminPool?.end();
    // Pool.end() resolves before the sockets close. Dropping the database
    // WITH (FORCE) while one is still closing terminates it with 57P01, which
    // surfaces as an unhandled error, so wait for every socket first.
    await Promise.all(adminConnectionsClosed);
  } finally {
    try {
      await dropTestDatabase();
    } finally {
      const currentMaintenancePool = maintenancePool;
      maintenancePool = undefined;
      await currentMaintenancePool?.end();
    }
  }
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

export function getTestDatabaseMigrationUrl(): string {
  return testMigrationDatabaseUrl;
}

export function getTestAppDatabaseUrl(): string | undefined {
  return testAppDatabaseUrl;
}

beforeAll(async () => {
  maintenancePool = new Pool({ connectionString: migrationDatabaseUrl });

  try {
    // Prisma models explicitly target public/restricted, so isolate by database.
    await maintenancePool.query(
      `CREATE DATABASE ${quoteIdentifier(testDatabaseName)} TEMPLATE template0`,
    );
    testDatabaseCreated = true;
    adminPool = new Pool({ connectionString: testMigrationDatabaseUrl });
    adminPool.on("connect", (client) => {
      adminConnectionsClosed.push(new Promise((resolve) => client.once("end", () => { resolve(); })));
    });
    await migrateFreshSchema(testMigrationDatabaseUrl);
    database = createPrismaClient(testRuntimeDatabaseUrl);
  } catch (error) {
    await database?.$disconnect().catch(() => undefined);
    database = undefined;
    await releaseTestDatabaseResources().catch(() => undefined);
    throw error;
  }
});

beforeEach(async () => {
  await truncateTables();
});

afterAll(async () => {
  const currentDatabase = database;
  database = undefined;
  try {
    await currentDatabase?.$disconnect();
  } finally {
    await releaseTestDatabaseResources();
  }
});
