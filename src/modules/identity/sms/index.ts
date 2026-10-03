import type { SmsSender } from "../../../adapters/ports.js";
import type { Logger } from "pino";
import { ConsoleSmsSender } from "./console-sms-sender.js";
import { Msg91SmsSender } from "./msg91-sms-sender.js";

export { ConsoleSmsSender, type ConsoleSmsSenderOptions } from "./console-sms-sender.js";
export { Msg91SmsSender, type Msg91SmsSenderOptions } from "./msg91-sms-sender.js";

export interface SmsSenderConfig {
  readonly smsProvider: "msg91" | "console";
  readonly msg91AuthKey?: string | undefined;
  readonly msg91TemplateId?: string | undefined;
  readonly msg91OtpVar?: string | undefined;
  readonly nodeEnv?: string | undefined;
}

export interface SmsSenderDeps {
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
}

export function createSmsSender(
  config: SmsSenderConfig,
  deps: SmsSenderDeps = {},
): SmsSender {
  if (config.smsProvider === "msg91") {
    if (!config.msg91AuthKey || config.msg91AuthKey.trim().length === 0) {
      throw new Error("MSG91_AUTH_KEY is required when SMS_PROVIDER=msg91");
    }
    if (!config.msg91TemplateId || config.msg91TemplateId.trim().length === 0) {
      throw new Error("MSG91_TEMPLATE_ID is required when SMS_PROVIDER=msg91");
    }
    return new Msg91SmsSender({
      authKey: config.msg91AuthKey,
      templateId: config.msg91TemplateId,
      otpVar: config.msg91OtpVar ?? "otp",
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }

  return new ConsoleSmsSender({
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    isProduction: config.nodeEnv === "production",
  });
}
