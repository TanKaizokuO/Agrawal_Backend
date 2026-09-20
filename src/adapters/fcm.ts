import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging, type BatchResponse, type Message, type Messaging } from "firebase-admin/messaging";
import type { PushMessage, PushSender } from "./ports.js";
import { assertFirebaseAppMatchesProject } from "./firebase-app.js";
import { isRecord } from "./guards.js";

export type FirebasePlatform = "ANDROID" | "IOS";
export type FirebaseEnvironment = "local" | "staging" | "production";

export interface FirebaseDeviceToken {
  readonly memberId: string;
  readonly token: string;
  readonly platform: FirebasePlatform;
}

export type FirebaseTokenDeliveryStatus = "ACCEPTED" | "FAILED" | "INVALID";

export interface FirebaseTokenDeliveryResult {
  readonly memberId: string;
  readonly token: string;
  readonly status: FirebaseTokenDeliveryStatus;
  readonly errorCode?: string;
}

/**
 * The richer seam used by Notifications. It deliberately sits beside the
 * existing PushSender port: PushSender remains useful to callers that only
 * need per-Member accepted counts, while Notifications needs token outcomes
 * to remove invalid registrations and retry transient failures precisely.
 */
export interface TokenPushSender extends PushSender {
  sendTokens(
    tokens: readonly FirebaseDeviceToken[],
    message: PushMessage,
  ): Promise<readonly FirebaseTokenDeliveryResult[]>;
}

export interface FirebaseTokenResolver {
  resolve(memberIds: readonly string[]): Promise<readonly FirebaseDeviceToken[]>;
}

export interface FirebasePushSenderOptions {
  readonly projectId?: string;
  readonly serviceAccountJson?: string;
  readonly environment?: FirebaseEnvironment;
  readonly tokenResolver?: FirebaseTokenResolver;
}

const MAX_BATCH_SIZE = 500;
const INVALID_TOKEN_ERRORS = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

function errorCode(error: unknown): string {
  if (isRecord(error) && typeof error.code === "string" && error.code.length > 0) {
    return error.code;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "messaging/send-failed";
}

function messageForToken(token: string, message: PushMessage): Message {
  const data: Record<string, string> = {
    topic: message.topic,
    subjectId: message.subjectId,
    ...message.data,
  };
  const apns = message.topic === "BLOOD_SOS_ALERT"
    ? { headers: { "apns-priority": "10" } }
    : undefined;
  return {
    token,
    notification: { title: message.title, body: message.body },
    data,
    android: { priority: "high" },
    ...(apns === undefined ? {} : { apns }),
  };
}

function fallbackTokens(memberIds: readonly string[]): readonly FirebaseDeviceToken[] {
  return memberIds.map((memberId) => ({
    memberId,
    token: memberId,
    platform: "ANDROID" as const,
  }));
}

function resultsForBatch(
  tokens: readonly FirebaseDeviceToken[],
  response: BatchResponse,
): FirebaseTokenDeliveryResult[] {
  return tokens.map((token, index) => {
    const result = response.responses[index];
    if (result?.success === true) {
      return { memberId: token.memberId, token: token.token, status: "ACCEPTED" };
    }
    const code = errorCode(result?.error);
    return {
      memberId: token.memberId,
      token: token.token,
      status: INVALID_TOKEN_ERRORS.has(code) ? "INVALID" : "FAILED",
      errorCode: code,
    };
  });
}

export class FirebasePushSender implements TokenPushSender {
  public constructor(
    private readonly messaging: Pick<Messaging, "sendEach">,
    private readonly tokenResolver?: FirebaseTokenResolver,
  ) {}

  public async sendTokens(
    tokens: readonly FirebaseDeviceToken[],
    message: PushMessage,
  ): Promise<readonly FirebaseTokenDeliveryResult[]> {
    const results: FirebaseTokenDeliveryResult[] = [];
    for (let offset = 0; offset < tokens.length; offset += MAX_BATCH_SIZE) {
      const batch = tokens.slice(offset, offset + MAX_BATCH_SIZE);
      const messages = batch.map((token) => messageForToken(token.token, message));
      let response: BatchResponse;
      try {
        response = await this.messaging.sendEach(messages);
      } catch (error) {
        const code = errorCode(error);
        for (const token of batch) {
          results.push({
            memberId: token.memberId,
            token: token.token,
            status: "FAILED",
            errorCode: code,
          });
        }
        continue;
      }
      results.push(...resultsForBatch(batch, response));
    }
    return results;
  }

  /** Implements the existing adapter port with per-Member accepted counts. */
  public async send(
    memberIds: readonly string[],
    message: PushMessage,
  ): Promise<Readonly<Record<string, number>>> {
    const tokens = this.tokenResolver === undefined
      ? fallbackTokens(memberIds)
      : await this.tokenResolver.resolve(memberIds);
    const results = await this.sendTokens(tokens, message);
    const accepted = new Map<string, number>();
    for (const memberId of memberIds) accepted.set(memberId, 0);
    for (const result of results) {
      if (result.status !== "ACCEPTED") continue;
      accepted.set(result.memberId, (accepted.get(result.memberId) ?? 0) + 1);
    }
    return Object.fromEntries(accepted);
  }
}

export interface FirebaseAdminPushSenderOptions {
  readonly projectId: string;
  readonly serviceAccountJson: string;
  readonly environment: FirebaseEnvironment;
  readonly tokenResolver?: FirebaseTokenResolver;
}

function serviceAccountFromJson(value: string): {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Firebase service account JSON is invalid");
  }
  if (!isRecord(parsed)) throw new Error("Firebase service account JSON is invalid");
  const projectId = parsed.project_id;
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  if (
    typeof projectId !== "string" || projectId.length === 0
    || typeof clientEmail !== "string" || clientEmail.length === 0
    || typeof privateKey !== "string" || privateKey.length === 0
  ) {
    throw new Error("Firebase service account JSON is missing credentials");
  }
  return {
    projectId,
    clientEmail,
    privateKey: privateKey.replaceAll("\\n", "\n"),
  };
}

/** Creates a named Firebase Admin app so local, staging, and production
 * projects cannot accidentally share an app instance in one process. */
export function createFirebaseAdminPushSender(
  options: FirebaseAdminPushSenderOptions,
): FirebasePushSender {
  const account = serviceAccountFromJson(options.serviceAccountJson);
  const projectId = options.projectId || account.projectId;
  const appName = `agrawal-notifications-${options.environment}`;
  const existing = getApps().find((app) => app.name === appName);
  const app = existing === undefined
    ? initializeApp(
      {
        credential: cert(account),
        projectId,
      },
      appName,
    )
    : existing;
  if (existing !== undefined) assertFirebaseAppMatchesProject(app, projectId);
  return new FirebasePushSender(getMessaging(app), options.tokenResolver);
}

export function createFirebasePushSender(
  messaging: Pick<Messaging, "sendEach">,
  tokenResolver?: FirebaseTokenResolver,
): TokenPushSender {
  return new FirebasePushSender(messaging, tokenResolver);
}
