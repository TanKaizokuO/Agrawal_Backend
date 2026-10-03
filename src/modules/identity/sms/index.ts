import type { SmsSender } from "../../../adapters/ports.js";
import type { Logger } from "pino";
import type { SNSClient } from "@aws-sdk/client-sns";
import { ConsoleSmsSender } from "./console-sms-sender.js";
import { SnsSmsSender } from "./sns-sms-sender.js";

export { ConsoleSmsSender, type ConsoleSmsSenderOptions } from "./console-sms-sender.js";
export { SnsSmsSender, type SnsSmsSenderOptions } from "./sns-sms-sender.js";

export interface SmsSenderConfig {
  readonly smsProvider: "sns" | "console";
  readonly awsRegion: string;
  readonly snsSmsSenderId?: string | undefined;
  readonly snsSmsEntityId?: string | undefined;
  readonly snsSmsTemplateId?: string | undefined;
  readonly snsSmsOtpMessage?: string | undefined;
  readonly nodeEnv?: string | undefined;
}

export interface SmsSenderDeps {
  readonly logger?: Logger;
  readonly snsClient?: SNSClient;
}

export function createSmsSender(
  config: SmsSenderConfig,
  deps: SmsSenderDeps = {},
): SmsSender {
  if (config.smsProvider === "sns") {
    const required = {
      SNS_SMS_SENDER_ID: config.snsSmsSenderId,
      SNS_SMS_ENTITY_ID: config.snsSmsEntityId,
      SNS_SMS_TEMPLATE_ID: config.snsSmsTemplateId,
      SNS_SMS_OTP_MESSAGE: config.snsSmsOtpMessage,
    };
    for (const [name, value] of Object.entries(required)) {
      if (!value || value.trim().length === 0) {
        throw new Error(`${name} is required when SMS_PROVIDER=sns`);
      }
    }
    return new SnsSmsSender({
      region: config.awsRegion,
      senderId: config.snsSmsSenderId ?? "",
      entityId: config.snsSmsEntityId ?? "",
      templateId: config.snsSmsTemplateId ?? "",
      messageTemplate: config.snsSmsOtpMessage ?? "",
      ...(deps.snsClient !== undefined ? { client: deps.snsClient } : {}),
    });
  }

  return new ConsoleSmsSender({
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    isProduction: config.nodeEnv === "production",
  });
}
