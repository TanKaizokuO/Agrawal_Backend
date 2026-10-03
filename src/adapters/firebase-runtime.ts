import { isRecord } from "./guards.js";

export interface FirebaseRuntimeOptions {
  readonly projectId: string;
  readonly serviceAccountJson: string;
  readonly environment: "local" | "staging" | "production";
}

export interface FirebaseServiceAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
}

function accountValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Firebase service account JSON is missing ${name}`);
  }
  return value;
}

export function parseFirebaseServiceAccount(value: string): FirebaseServiceAccount {
  const trimmed = value.trim();
  const json = trimmed.startsWith("{")
    ? trimmed
    : Buffer.from(trimmed, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Firebase service account JSON is invalid");
  }
  if (!isRecord(parsed)) throw new Error("Firebase service account JSON is invalid");
  return {
    projectId: accountValue(parsed.project_id, "project_id"),
    clientEmail: accountValue(parsed.client_email, "client_email"),
    privateKey: accountValue(parsed.private_key, "private_key").replaceAll("\\n", "\n"),
  };
}

export function normalizedFirebaseServiceAccountJson(value: string): string {
  const account = parseFirebaseServiceAccount(value);
  return JSON.stringify({
    project_id: account.projectId,
    client_email: account.clientEmail,
    private_key: account.privateKey,
  });
}

