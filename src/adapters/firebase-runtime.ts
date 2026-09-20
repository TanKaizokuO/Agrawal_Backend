import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { App } from "firebase-admin/app";
import {
  createFirebasePhoneTokenVerifier,
  type FirebaseAuthPort,
  type FirebaseDecodedIdToken,
} from "./firebase.js";
import type { PhoneTokenVerifier } from "./ports.js";
import { isRecord } from "./guards.js";
import { assertFirebaseAppMatchesProject } from "./firebase-app.js";

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

function appFor(options: FirebaseRuntimeOptions, account: FirebaseServiceAccount): App {
  const name = `agrawal-api-${options.environment}`;
  const projectId = options.projectId || account.projectId;
  const existing = getApps().find((candidate) => candidate.name === name);
  const app = existing === undefined
    ? initializeApp(
      {
        credential: cert({
          projectId,
          clientEmail: account.clientEmail,
          privateKey: account.privateKey,
        }),
        projectId,
      },
      name,
    )
    : existing;
  if (existing !== undefined) assertFirebaseAppMatchesProject(app, projectId);
  return app;
}

interface FirebaseAuthClient {
  verifyIdToken(idToken: string, checkRevoked: true): Promise<{
    readonly uid: string;
    readonly phone_number?: string;
    readonly auth_time?: number;
    readonly firebase?: {
      readonly sign_in_provider?: string;
    };
  }>;
}
class FirebaseAuthAdapter implements FirebaseAuthPort {
  public constructor(private readonly auth: FirebaseAuthClient) {}

  public async verifyIdToken(
    idToken: string,
    checkRevoked: true,
  ): Promise<FirebaseDecodedIdToken> {
    const decoded = await this.auth.verifyIdToken(idToken, checkRevoked);
    return {
      uid: decoded.uid,
      ...(decoded.phone_number === undefined ? {} : { phone_number: decoded.phone_number }),
      ...(decoded.auth_time === undefined ? {} : { auth_time: decoded.auth_time }),
      ...(decoded.firebase === undefined ? {} : { firebase: decoded.firebase }),
    };
  }
}

export function createFirebasePhoneVerifier(
  options: FirebaseRuntimeOptions,
): PhoneTokenVerifier {
  const account = parseFirebaseServiceAccount(options.serviceAccountJson);
  const app = appFor(options, account);
  return createFirebasePhoneTokenVerifier(new FirebaseAuthAdapter(getAuth(app)));
}
