import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { SmsSender } from "../../../adapters/ports.js";

export const OTP_PLACEHOLDER = "{otp}";
const REQUEST_TIMEOUT_MS = 10_000;

export interface SnsSmsSenderOptions {
  readonly region: string;
  /** DLT-approved sender header (AWS.SNS.SMS.SenderID). */
  readonly senderId: string;
  /** DLT Principal Entity ID (AWS.MM.SMS.EntityId). */
  readonly entityId: string;
  /** DLT content template ID (AWS.MM.SMS.TemplateId). */
  readonly templateId: string;
  /** Exact DLT-approved text with `{otp}` exactly once where the code goes. */
  readonly messageTemplate: string;
  readonly client?: SNSClient;
}

export function assertOtpMessageTemplate(template: string): void {
  if (template.split(OTP_PLACEHOLDER).length !== 2) {
    throw new Error(`SMS OTP message template must contain ${OTP_PLACEHOLDER} exactly once`);
  }
}

export class SnsSmsSender implements SmsSender {
  private readonly client: SNSClient;
  private readonly attributes: Record<string, { DataType: "String"; StringValue: string }>;
  private readonly messagePrefix: string;
  private readonly messageSuffix: string;

  public constructor(options: SnsSmsSenderOptions) {
    const required = {
      "SNS sender ID": options.senderId,
      "SNS DLT entity ID": options.entityId,
      "SNS DLT template ID": options.templateId,
    };
    for (const [label, value] of Object.entries(required)) {
      if (!value || value.trim().length === 0) {
        throw new Error(`${label} is required`);
      }
    }
    assertOtpMessageTemplate(options.messageTemplate);
    const [prefix = "", suffix = ""] = options.messageTemplate.split(OTP_PLACEHOLDER);
    this.messagePrefix = prefix;
    this.messageSuffix = suffix;

    const attribute = (value: string) => ({ DataType: "String" as const, StringValue: value.trim() });
    this.attributes = {
      "AWS.SNS.SMS.SMSType": attribute("Transactional"),
      "AWS.SNS.SMS.SenderID": attribute(options.senderId),
      "AWS.MM.SMS.EntityId": attribute(options.entityId),
      "AWS.MM.SMS.TemplateId": attribute(options.templateId),
    };
    this.client =
      options.client ??
      new SNSClient({
        region: options.region,
        requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS, connectionTimeout: REQUEST_TIMEOUT_MS },
      });
  }

  public async sendOtp(phoneE164: string, code: string): Promise<void> {
    const output = await this.client.send(
      new PublishCommand({
        PhoneNumber: phoneE164,
        Message: `${this.messagePrefix}${code}${this.messageSuffix}`,
        MessageAttributes: this.attributes,
      }),
    );
    if (!output.MessageId) {
      throw new Error("SNS Publish returned no MessageId");
    }
  }
}
