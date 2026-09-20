import { describe, expect, it } from "vitest";
import type { Clock } from "../src/clock.js";
import { FixedClock } from "../src/clock.js";
import type { JobRuntime } from "../src/jobs.js";
import type { PushMessage, PushSender } from "../src/adapters/ports.js";
import type {
  FirebaseDeviceToken,
  FirebaseTokenDeliveryResult,
  TokenPushSender,
} from "../src/adapters/fcm.js";
import {
  NotificationsService,
  type MemberLanguageResolver,
} from "../src/modules/notifications/index.js";
import type { LocalizedPushMessage } from "../src/modules/notifications/schemas.js";
import { getTestDatabase } from "./setup.js";

const db = getTestDatabase();
const clock: Clock = new FixedClock(new Date("2026-09-19T10:00:00.000Z"));

const message: LocalizedPushMessage = {
  topic: "OFFICER_MESSAGE",
  subjectId: "00000000-0000-4000-8000-000000000001",
  title: { en: "English title", hi: "हिन्दी शीर्षक" },
  body: { en: "English body", hi: "हिन्दी संदेश" },
  data: { messageId: "00000000-0000-4000-8000-000000000002" },
};

class TestJobs implements JobRuntime {
  readonly enabled = true;
  readonly sent: Array<{ name: string; payload: unknown }> = [];

  start(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  isReady(): Promise<boolean> { return Promise.resolve(true); }
  send(name: string, payload: unknown): Promise<string> {
    this.sent.push({ name, payload });
    return Promise.resolve(`job-${String(this.sent.length)}`);
  }
  registerWorker(): Promise<void> { return Promise.resolve(); }
}

class TestLanguages implements MemberLanguageResolver {
  constructor(private readonly language: "en" | "hi") {}
  languageForMember(): Promise<"en" | "hi"> { return Promise.resolve(this.language); }
}

class TestPushSender implements TokenPushSender {
  readonly calls: Array<{ tokens: readonly FirebaseDeviceToken[]; message: PushMessage }> = [];
  private callNumber = 0;
  constructor(private readonly outcomes: (tokens: readonly FirebaseDeviceToken[], call: number) => readonly FirebaseTokenDeliveryResult[]) {}

  send(): Promise<Readonly<Record<string, number>>> {
    return Promise.reject(new Error("Notifications should use token outcomes for this test"));
  }

  sendTokens(
    tokens: readonly FirebaseDeviceToken[],
    pushMessage: PushMessage,
  ): Promise<readonly FirebaseTokenDeliveryResult[]> {
    this.callNumber += 1;
    this.calls.push({ tokens, message: pushMessage });
    return Promise.resolve(this.outcomes(tokens, this.callNumber));
  }
}

function service(
  sender: PushSender | TokenPushSender,
  jobs = new TestJobs(),
  language: "en" | "hi" = "en",
): NotificationsService {
  return new NotificationsService({
    db,
    clock,
    jobs,
    pushSender: sender,
    memberLanguage: new TestLanguages(language),
    config: { environment: "staging" },
  });
}

function accepted(tokens: readonly FirebaseDeviceToken[]): readonly FirebaseTokenDeliveryResult[] {
  return tokens.map((token) => ({
    memberId: token.memberId,
    token: token.token,
    status: "ACCEPTED",
  }));
}

describe("notifications", () => {
  it("does not transfer a token between Members without an explicit ownership flow", async () => {
    const sender = new TestPushSender(accepted);
    const notifications = service(sender);
    const firstMember = "00000000-0000-4000-8000-000000000011";
    const secondMember = "00000000-0000-4000-8000-000000000012";

    await notifications.registerDevice(firstMember, "token-shared", { platform: "ANDROID" });
    await expect(
      notifications.registerDevice(secondMember, "token-shared", { platform: "IOS" }),
    ).rejects.toMatchObject({
      code: "DEVICE_TOKEN_OWNERSHIP_CONFLICT",
      httpStatus: 409,
    });

    await expect(db.deviceToken.findUnique({ where: { token: "token-shared" } })).resolves.toMatchObject({
      memberId: firstMember,
      platform: "ANDROID",
    });

    await notifications.deleteDevice(firstMember, "token-shared");
    await notifications.registerDevice(secondMember, "token-shared", { platform: "IOS" });
    await expect(db.deviceToken.findUnique({ where: { token: "token-shared" } })).resolves.toMatchObject({
      memberId: secondMember,
      platform: "IOS",
    });

    await notifications.deleteDevice(secondMember, "token-shared");
    await expect(db.deviceToken.findUnique({ where: { token: "token-shared" } })).resolves.toBeNull();
  });

  it("removes invalid tokens and does not multiply a logical delivery on replay", async () => {
    const memberId = "00000000-0000-4000-8000-000000000021";
    const sender = new TestPushSender((tokens) => tokens.map((token) => ({
      memberId: token.memberId,
      token: token.token,
      status: "INVALID",
      errorCode: "messaging/registration-token-not-registered",
    })));
    const notifications = service(sender);
    await notifications.registerDevice(memberId, "token-invalid", { platform: "ANDROID" });

    await expect(notifications.send([memberId, memberId], message)).resolves.toEqual(
      new Map([[memberId, { accepted: false }]]),
    );
    await notifications.send([memberId], message);

    await expect(db.deviceToken.findUnique({ where: { token: "token-invalid" } })).resolves.toBeNull();
    await expect(db.pushDelivery.count({ where: { memberId, topic: message.topic, subjectId: message.subjectId } })).resolves.toBe(1);
    expect(sender.calls).toHaveLength(1);
    await expect(db.pushDelivery.findFirst({ where: { memberId } })).resolves.toMatchObject({
      acceptedCount: 0,
      failedCount: 1,
      status: "COMPLETE",
    });
  });

  it("accepts a Member when one of two devices succeeds and retries only the failed device", async () => {
    const memberId = "00000000-0000-4000-8000-000000000031";
    const jobs = new TestJobs();
    const sender = new TestPushSender((tokens, call) => {
      if (call === 1) {
        return [
          { memberId, token: "token-good", status: "ACCEPTED" },
          { memberId, token: "token-retry", status: "FAILED", errorCode: "messaging/unavailable" },
        ];
      }
      return accepted(tokens);
    });
    const notifications = service(sender, jobs);
    await notifications.registerDevice(memberId, "token-good", { platform: "ANDROID" });
    await notifications.registerDevice(memberId, "token-retry", { platform: "ANDROID" });

    await expect(notifications.send([memberId], message)).resolves.toEqual(
      new Map([[memberId, { accepted: true }]]),
    );
    expect(jobs.sent).toHaveLength(1);
    await notifications.deliver(message, [memberId], true);

    expect(sender.calls).toHaveLength(2);
    expect(sender.calls[0]?.tokens).toHaveLength(2);
    expect(sender.calls[1]?.tokens.map((token) => token.token)).toEqual(["token-retry"]);
    await expect(db.pushDelivery.findFirst({ where: { memberId } })).resolves.toMatchObject({
      acceptedCount: 2,
      failedCount: 0,
      status: "COMPLETE",
    });
  });

  it("uses the required Member language resolver when constructing the vendor message", async () => {
    const memberId = "00000000-0000-4000-8000-000000000041";
    const sender = new TestPushSender(accepted);
    const notifications = service(sender, new TestJobs(), "hi");
    await notifications.registerDevice(memberId, "token-language", { platform: "ANDROID" });

    await notifications.send([memberId], message);

    expect(sender.calls[0]?.message.title).toBe("हिन्दी शीर्षक");
    expect(sender.calls[0]?.message.body).toBe("हिन्दी संदेश");
  });

  it("records a delivery with zero counts when the Member has no devices", async () => {
    const memberId = "00000000-0000-4000-8000-000000000051";
    const sender = new TestPushSender(accepted);
    const notifications = service(sender);

    await expect(notifications.send([memberId], message)).resolves.toEqual(
      new Map([[memberId, { accepted: false }]]),
    );
    await expect(db.pushDelivery.findFirst({ where: { memberId } })).resolves.toMatchObject({
      acceptedCount: 0,
      failedCount: 0,
    });
    expect(sender.calls).toHaveLength(0);
  });

  it("rejects sensitive payload fields before they reach FCM", async () => {
    const memberId = "00000000-0000-4000-8000-000000000061";
    const sender = new TestPushSender(accepted);
    const notifications = service(sender);
    await notifications.registerDevice(memberId, "token-safe", { platform: "ANDROID" });

    await expect(notifications.send([memberId], {
      ...message,
      data: { bloodGroup: "A+" },
    })).rejects.toMatchObject({ code: "INVALID_NOTIFICATION_PAYLOAD" });
    expect(sender.calls).toHaveLength(0);
  });

  it("deletes every device token through the erasure transaction hook", async () => {
    const memberId = "00000000-0000-4000-8000-000000000071";
    const sender = new TestPushSender(accepted);
    const notifications = service(sender);
    await notifications.registerDevice(memberId, "token-erase-1", { platform: "ANDROID" });
    await notifications.registerDevice(memberId, "token-erase-2", { platform: "IOS" });

    await db.$transaction((tx) => notifications.deleteTokensForMember(tx, memberId));

    await expect(db.deviceToken.findMany({ where: { memberId } })).resolves.toHaveLength(0);
  });
});
