import { describe, expect, it } from "vitest";
import { assertLocalTestDatabaseUrl } from "./test-database-guard.js";

const rdsUrl =
  "postgresql://postgres:password@database-1.abc123.ap-south-1.rds.amazonaws.com:5432/agrawal_test?sslmode=verify-full";

function check(url: string, env: NodeJS.ProcessEnv = {}): () => void {
  return () => {
    assertLocalTestDatabaseUrl("DATABASE_URL", url, env);
  };
}

describe("assertLocalTestDatabaseUrl", () => {
  it.each([
    "postgresql://postgres:password@localhost:5432/agrawal_test",
    "postgresql://postgres:password@127.0.0.1:5432/agrawal_test?schema=public",
    "postgresql://postgres:password@[::1]:5432/agrawal_test",
    "postgres://postgres:password@postgres:5432/agrawal_test",
  ])("allows the local database %s", (url) => {
    expect(check(url)).not.toThrow();
  });

  it("rejects a remote host such as RDS", () => {
    expect(check(rdsUrl)).toThrow(
      "DATABASE_URL points at 'database-1.abc123.ap-south-1.rds.amazonaws.com'",
    );
  });

  it("allows a remote host only with ALLOW_REMOTE_TEST_DB=1", () => {
    expect(check(rdsUrl, { ALLOW_REMOTE_TEST_DB: "true" })).toThrow();
    expect(check(rdsUrl, { ALLOW_REMOTE_TEST_DB: "1" })).not.toThrow();
  });
});
