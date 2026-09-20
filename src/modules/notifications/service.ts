import { v7 as uuidv7 } from "uuid";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../http/errors.js";
import type { Clock } from "../../clock.js";
import type { JobRuntime } from "../../jobs.js";
import type { PushMessage, PushSender } from "../../adapters/ports.js";
import type {
  FirebaseDeviceToken,
  FirebasePlatform,
  FirebaseTokenDeliveryResult,
  TokenPushSender,
} from "../../adapters/fcm.js";
import {
  DevicePlatform,
  NotificationEnvironment,
  NotificationJobPayload,
  PushMessageSchema,
  type DevicePlatform as DevicePlatformValue,
  type LocalizedPushMessage,
  type NotificationEnvironment as NotificationEnvironmentValue,
} from "./schemas.js";
import { JOB_NAMES, type NotificationJobInput } from "./jobs.js";

export type NotificationTxClient = Prisma.TransactionClient;
export type MemberLanguage = "en" | "hi";

export interface MemberLanguageResolver {
  languageForMember(memberId: string): Promise<MemberLanguage>;
}

export interface NotificationsConfig {
  readonly environment: NotificationEnvironmentValue;
  readonly retryDelayMs?: number;
}

export interface NotificationsDeps {
  readonly db: PrismaClient;
  readonly clock: Clock;
  readonly jobs: JobRuntime;
  readonly pushSender: PushSender | TokenPushSender;
  readonly memberLanguage: MemberLanguageResolver;
  readonly config: NotificationsConfig;
}

export interface RegisterDeviceResult {
  readonly token: string;
  readonly memberId: string;
  readonly platform: DevicePlatformValue;
  readonly environment: NotificationEnvironmentValue;
  readonly appVersion: string | null;
  readonly lastSeenAt: Date;
}

export interface DeliveryResult {
  readonly accepted: boolean;
}

const DELIVERY_STATUS = {
  QUEUED: "QUEUED",
  SENDING: "SENDING",
  RETRY_WAIT: "RETRY_WAIT",
  COMPLETE: "COMPLETE",
  FAILED: "FAILED",
} as const;

const TOKEN_STATUS = {
  PENDING: "PENDING",
  SENDING: "SENDING",
  ACCEPTED: "ACCEPTED",
  FAILED: "FAILED",
  INVALID: "INVALID",
} as const;

const DEFAULT_RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 2;
const PHONE_PATTERN = /(?:\+91[\s-]?)?[6-9]\d{9}/u;
const BLOOD_GROUP_PATTERN = /^(?:A|B|AB|O)[+-]$/u;
const FORBIDDEN_DATA_KEY = /(?:phone|mobile|blood|address|pincode|district|dob|dateofbirth|nominee|email|token|firebase|auth)/iu;
const FORBIDDEN_DATA_KEYS: Record<string, true> = { topic: true, subjectid: true };

interface StoredDeviceToken {
  readonly token: string;
  readonly memberId: string;
  readonly platform: string;
}

interface DeliveryWork {
  readonly deliveryId: string;
  readonly memberId: string;
  readonly tokens: readonly StoredDeviceToken[];
  readonly attempts: number;
  readonly retryScheduledAt: Date | null;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertSafeText(value: string, field: string): void {
  if (PHONE_PATTERN.test(value)) {
    throw new AppError("INVALID_NOTIFICATION_PAYLOAD", 400, { field });
  }
}

function safeMessage(input: LocalizedPushMessage): LocalizedPushMessage {
  const parsed = PushMessageSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("INVALID_NOTIFICATION_PAYLOAD", 400, {
      issues: parsed.error.issues,
    });
  }
  const message = parsed.data;
  assertSafeText(message.title.en, "title.en");
  assertSafeText(message.title.hi, "title.hi");
  assertSafeText(message.body.en, "body.en");
  assertSafeText(message.body.hi, "body.hi");
  for (const [key, value] of Object.entries(message.data)) {
    const normalizedKey = key.replaceAll("_", "").toLowerCase();
    if (FORBIDDEN_DATA_KEYS[normalizedKey] === true || FORBIDDEN_DATA_KEY.test(key)) {
      throw new AppError("INVALID_NOTIFICATION_PAYLOAD", 400, { field: `data.${key}` });
    }
    if (PHONE_PATTERN.test(value) || BLOOD_GROUP_PATTERN.test(value)) {
      throw new AppError("INVALID_NOTIFICATION_PAYLOAD", 400, { field: `data.${key}` });
    }
  }
  return message;
}

function adapterMessage(
  message: LocalizedPushMessage,
  language: MemberLanguage,
): PushMessage {
  return {
    topic: message.topic,
    subjectId: message.subjectId,
    title: message.title[language],
    body: message.body[language],
    data: message.data,
  };
}

function platform(value: string): FirebasePlatform | null {
  const result = DevicePlatform.safeParse(value);
  return result.success ? result.data : null;
}

function asFirebaseTokens(tokens: readonly StoredDeviceToken[]): FirebaseDeviceToken[] {
  const result: FirebaseDeviceToken[] = [];
  for (const token of tokens) {
    const tokenPlatform = platform(token.platform);
    if (tokenPlatform === null) continue;
    result.push({
      token: token.token,
      memberId: token.memberId,
      platform: tokenPlatform,
    });
  }
  return result;
}

function isTokenPushSender(
  sender: PushSender | TokenPushSender,
): sender is TokenPushSender {
  return "sendTokens" in sender && typeof sender.sendTokens === "function";
}


export class NotificationsService {
  private readonly db: PrismaClient;
  private readonly clock: Clock;
  private readonly jobs: JobRuntime;
  private readonly pushSender: PushSender | TokenPushSender;
  private readonly memberLanguage: MemberLanguageResolver;
  private readonly environment: NotificationEnvironmentValue;
  private readonly retryDelayMs: number;

  public constructor(deps: NotificationsDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.jobs = deps.jobs;
    this.pushSender = deps.pushSender;
    this.memberLanguage = deps.memberLanguage;
    this.environment = NotificationEnvironment.parse(deps.config.environment);
    this.retryDelayMs = deps.config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }
  public async registerDevice(
    memberId: string,
    token: string,
    input: { readonly platform: DevicePlatformValue; readonly appVersion?: string | undefined },
  ): Promise<RegisterDeviceResult> {
    const now = this.clock.now();
    const update = {
      platform: input.platform,
      environment: this.environment,
      ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
      lastSeenAt: now,
    };
    try {
      return await this.db.$transaction(async (tx) => {
        const existing = await tx.deviceToken.findUnique({
          where: { token },
          select: { memberId: true },
        });
        if (existing !== null && existing.memberId !== memberId) {
          throw new AppError("DEVICE_TOKEN_OWNERSHIP_CONFLICT", 409);
        }
        const row = existing === null
          ? await tx.deviceToken.create({
            data: {
              token,
              memberId,
              ...update,
              createdAt: now,
            },
            select: {
              token: true,
              memberId: true,
              platform: true,
              environment: true,
              appVersion: true,
              lastSeenAt: true,
            },
          })
          : await tx.deviceToken.update({
            where: { token },
            data: update,
            select: {
              token: true,
              memberId: true,
              platform: true,
              environment: true,
              appVersion: true,
              lastSeenAt: true,
            },
          });
        return {
          token: row.token,
          memberId: row.memberId,
          platform: DevicePlatform.parse(row.platform),
          environment: NotificationEnvironment.parse(row.environment),
          appVersion: row.appVersion,
          lastSeenAt: row.lastSeenAt,
        };
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError)
        || error.code !== "P2002"
      ) throw error;
      const existing = await this.db.deviceToken.findUnique({
        where: { token },
        select: { memberId: true },
      });
      if (existing === null || existing.memberId !== memberId) {
        throw new AppError("DEVICE_TOKEN_OWNERSHIP_CONFLICT", 409);
      }
      const row = await this.db.deviceToken.update({
        where: { token },
        data: update,
        select: {
          token: true,
          memberId: true,
          platform: true,
          environment: true,
          appVersion: true,
          lastSeenAt: true,
        },
      });
      return {
        token: row.token,
        memberId: row.memberId,
        platform: DevicePlatform.parse(row.platform),
        environment: NotificationEnvironment.parse(row.environment),
        appVersion: row.appVersion,
        lastSeenAt: row.lastSeenAt,
      };
    }
  }

  public async deleteDevice(memberId: string, token: string): Promise<void> {
    await this.db.deviceToken.deleteMany({
      where: { token, memberId, environment: this.environment },
    });
  }

  /** Erasure hook called inside Register's transaction. */
  public async deleteTokensForMember(
    tx: NotificationTxClient,
    memberId: string,
  ): Promise<void> {
    await tx.deviceToken.deleteMany({ where: { memberId } });
  }

  public async enqueue(
    memberIds: readonly string[],
    input: LocalizedPushMessage,
  ): Promise<string | null> {
    const ids = uniqueStrings(memberIds);
    if (ids.length === 0) return null;
    const message = safeMessage(input);
    await this.db.$transaction(async (tx) => {
      for (const memberId of ids) {
        await tx.pushDelivery.upsert({
          where: {
            memberId_topic_subjectId: {
              memberId,
              topic: message.topic,
              subjectId: message.subjectId,
            },
          },
          create: {
            id: uuidv7(),
            memberId,
            topic: message.topic,
            subjectId: message.subjectId,
            status: DELIVERY_STATUS.QUEUED,
          },
          update: {},
        });
      }
    });
    return this.jobs.send(
      JOB_NAMES.deliver,
      { memberIds: ids, message, retry: false } satisfies NotificationJobInput,
      { retryLimit: 5, retryBackoff: true },
    );
  }

  /** Public delivery seam used by the worker and by synchronous callers. */
  public async deliver(
    input: LocalizedPushMessage,
    memberIds: readonly string[],
    retry = false,
  ): Promise<Map<string, DeliveryResult>> {
    const message = safeMessage(input);
    const results = new Map<string, DeliveryResult>();
    for (const memberId of uniqueStrings(memberIds)) {
      let accepted = false;
      try {
        accepted = await this.deliverMember(memberId, message, retry);
      } catch {
        accepted = false;
      }
      results.set(memberId, { accepted });
    }
    return results;
  }

  public async send(
    memberIds: readonly string[],
    input: LocalizedPushMessage,
  ): Promise<Map<string, DeliveryResult>> {
    return this.deliver(input, memberIds);
  }

  public async deliverJob(payload: unknown): Promise<void> {
    const parsed = NotificationJobPayload.parse(payload);
    await this.deliver(parsed.message, parsed.memberIds, parsed.retry);
  }

  private async ensureDelivery(
    memberId: string,
    message: LocalizedPushMessage,
  ): Promise<{
    id: string;
    status: string;
    acceptedCount: number;
    attempts: number;
    retryScheduledAt: Date | null;
  }> {
    return this.db.pushDelivery.upsert({
      where: {
        memberId_topic_subjectId: {
          memberId,
          topic: message.topic,
          subjectId: message.subjectId,
        },
      },
      create: {
        id: uuidv7(),
        memberId,
        topic: message.topic,
        subjectId: message.subjectId,
        status: DELIVERY_STATUS.QUEUED,
      },
      update: {},
      select: {
        id: true,
        status: true,
        acceptedCount: true,
        attempts: true,
        retryScheduledAt: true,
      },
    });
  }

  private async claimWork(
    deliveryId: string,
    memberId: string,
    retry: boolean,
  ): Promise<DeliveryWork | null> {
    return this.db.$transaction(async (tx) => {
      const delivery = await tx.pushDelivery.findUnique({
        where: { id: deliveryId },
        select: {
          id: true,
          memberId: true,
          status: true,
          attempts: true,
          retryScheduledAt: true,
        },
      });
      if (delivery === null || delivery.memberId !== memberId) return null;
      if (
        delivery.status === DELIVERY_STATUS.COMPLETE
        || delivery.status === DELIVERY_STATUS.SENDING
      ) return null;
      if (delivery.status === DELIVERY_STATUS.RETRY_WAIT && !retry) return null;
      if (delivery.attempts >= MAX_ATTEMPTS) return null;

      const deviceRows = await tx.deviceToken.findMany({
        where: { memberId, environment: this.environment },
        select: { token: true, memberId: true, platform: true },
      });
      await tx.pushDeliveryToken.createMany({
        data: deviceRows.map((device) => ({
          id: uuidv7(),
          deliveryId,
          token: device.token,
          status: TOKEN_STATUS.PENDING,
        })),
        skipDuplicates: true,
      });
      const tokenRows = await tx.pushDeliveryToken.findMany({
        where: {
          deliveryId,
          OR: [
            { status: TOKEN_STATUS.PENDING },
            { status: TOKEN_STATUS.FAILED, attempts: { lt: MAX_ATTEMPTS } },
          ],
        },
        select: { id: true, token: true },
      });
      if (tokenRows.length === 0) {
        await tx.pushDelivery.update({
          where: { id: deliveryId },
          data: {
            status: DELIVERY_STATUS.COMPLETE,
            retryScheduledAt: null,
          },
        });
        return null;
      }
      await tx.pushDeliveryToken.updateMany({
        where: { id: { in: tokenRows.map((token) => token.id) } },
        data: { status: TOKEN_STATUS.SENDING, attempts: { increment: 1 } },
      });
      await tx.pushDelivery.update({
        where: { id: deliveryId },
        data: {
          status: DELIVERY_STATUS.SENDING,
          attempts: { increment: 1 },
          retryScheduledAt: null,
        },
      });
      const currentTokens = deviceRows.filter((device) =>
        tokenRows.some((token) => token.token === device.token),
      );
      return {
        deliveryId,
        memberId,
        tokens: currentTokens,
        attempts: delivery.attempts + 1,
        retryScheduledAt: delivery.retryScheduledAt,
      };
    });
  }

  private async deliverMember(
    memberId: string,
    message: LocalizedPushMessage,
    retry: boolean,
  ): Promise<boolean> {
    const delivery = await this.ensureDelivery(memberId, message);
    if (delivery.status === DELIVERY_STATUS.COMPLETE) return delivery.acceptedCount > 0;
    if (delivery.status === DELIVERY_STATUS.RETRY_WAIT && !retry) {
      return delivery.acceptedCount > 0;
    }
    if (delivery.attempts >= MAX_ATTEMPTS && delivery.status === DELIVERY_STATUS.FAILED) {
      return delivery.acceptedCount > 0;
    }

    const work = await this.claimWork(delivery.id, memberId, retry);
    if (work === null) {
      const current = await this.db.pushDelivery.findUnique({
        where: { id: delivery.id },
        select: { acceptedCount: true },
      });
      return (current?.acceptedCount ?? delivery.acceptedCount) > 0;
    }

    const firebaseTokens = asFirebaseTokens(work.tokens);
    const supportedTokens = new Set(firebaseTokens.map((token) => token.token));
    const unsupportedOutcomes: FirebaseTokenDeliveryResult[] = work.tokens
      .filter((token) => !supportedTokens.has(token.token))
      .map((token) => ({
        memberId,
        token: token.token,
        status: "FAILED",
        errorCode: "push-sender/unsupported-platform",
      }));
    let outcomes: readonly FirebaseTokenDeliveryResult[];
    try {
      const language = await this.memberLanguage.languageForMember(memberId);
      const senderMessage = adapterMessage(message, language);
      if (isTokenPushSender(this.pushSender)) {
        outcomes = await this.pushSender.sendTokens(firebaseTokens, senderMessage);
      } else {
        const counts = await this.pushSender.send([memberId], senderMessage);
        const accepted = Math.max(0, Math.min(firebaseTokens.length, counts[memberId] ?? 0));
        outcomes = firebaseTokens.map((token, index) => ({
          memberId,
          token: token.token,
          status: index < accepted ? "ACCEPTED" : "FAILED",
          ...(index < accepted ? {} : { errorCode: "push-sender/failed" }),
        }));
      }
    } catch {
      outcomes = firebaseTokens.map((token) => ({
        memberId,
        token: token.token,
        status: "FAILED",
        errorCode: "push-sender/failed",
      }));
    }
    outcomes = [...outcomes, ...unsupportedOutcomes];

    await this.recordOutcomes(work, message, outcomes);
    const current = await this.db.pushDelivery.findUnique({
      where: { id: work.deliveryId },
      select: { acceptedCount: true },
    });
    return (current?.acceptedCount ?? 0) > 0;
  }

  private async recordOutcomes(
    work: DeliveryWork,
    message: LocalizedPushMessage,
    outcomes: readonly FirebaseTokenDeliveryResult[],
  ): Promise<void> {
    const now = this.clock.now();
    const invalidTokens: string[] = [];
    await this.db.$transaction(async (tx) => {
      for (const outcome of outcomes) {
        const status = outcome.status === "ACCEPTED"
          ? TOKEN_STATUS.ACCEPTED
          : outcome.status === "INVALID"
            ? TOKEN_STATUS.INVALID
            : TOKEN_STATUS.FAILED;
        await tx.pushDeliveryToken.updateMany({
          where: { deliveryId: work.deliveryId, token: outcome.token },
          data: {
            status,
            ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
          },
        });
        if (outcome.status === "INVALID") invalidTokens.push(outcome.token);
      }
      if (invalidTokens.length > 0) {
        await tx.deviceToken.deleteMany({
          where: {
            memberId: work.memberId,
            environment: this.environment,
            token: { in: invalidTokens },
          },
        });
      }
      const tokenStates = await tx.pushDeliveryToken.findMany({
        where: { deliveryId: work.deliveryId },
        select: { status: true },
      });
      const accepted = tokenStates.filter((token) => token.status === TOKEN_STATUS.ACCEPTED).length;
      const failed = tokenStates.filter((token) =>
        token.status === TOKEN_STATUS.FAILED || token.status === TOKEN_STATUS.INVALID,
      ).length;
      const retryable = tokenStates.some((token) => token.status === TOKEN_STATUS.FAILED);
      const exhausted = work.attempts >= MAX_ATTEMPTS;
      const retryAt = new Date(now.getTime() + this.retryDelayMs);
      const status = retryable && !exhausted
        ? DELIVERY_STATUS.RETRY_WAIT
        : retryable
          ? DELIVERY_STATUS.FAILED
          : DELIVERY_STATUS.COMPLETE;
      await tx.pushDelivery.update({
        where: { id: work.deliveryId },
        data: {
          acceptedCount: accepted,
          failedCount: failed,
          status,
          retryScheduledAt: status === DELIVERY_STATUS.RETRY_WAIT ? retryAt : null,
        },
      });
    });

    const delivery = await this.db.pushDelivery.findUnique({
      where: { id: work.deliveryId },
      select: { status: true, retryScheduledAt: true },
    });
    if (delivery?.status !== DELIVERY_STATUS.RETRY_WAIT || delivery.retryScheduledAt === null) return;
    await this.jobs.send(
      JOB_NAMES.retry,
      {
        memberIds: [work.memberId],
        message,
        retry: true,
      } satisfies NotificationJobInput,
      {
        startAfter: delivery.retryScheduledAt,
        retryLimit: 1,
        retryBackoff: true,
      },
    );
  }
}

