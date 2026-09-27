// The Vitest setup creates and drops `test_*` databases, so it must never reach
// a shared or production server. Only loopback hosts and the `postgres` service
// hostname (Docker/CI networks) are allowed unless ALLOW_REMOTE_TEST_DB=1.
const LOCAL_TEST_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

export function assertLocalTestDatabaseUrl(
  name: string,
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.ALLOW_REMOTE_TEST_DB === "1") {
    return;
  }

  const host = new URL(connectionString).hostname.toLowerCase();
  if (!LOCAL_TEST_DATABASE_HOSTS.has(host)) {
    throw new Error(
      `${name} points at '${host}', but tests create and drop databases and only run against ` +
        "localhost, 127.0.0.1, ::1 or 'postgres'. Export a local URL in your shell, or set " +
        "ALLOW_REMOTE_TEST_DB=1 if you really mean to use a remote server.",
    );
  }
}
