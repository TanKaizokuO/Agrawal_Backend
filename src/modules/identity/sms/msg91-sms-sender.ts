import { z } from "zod";
import type { SmsSender } from "../../../adapters/ports.js";

const DEFAULT_ENDPOINT = "https://control.msg91.com/api/v5/flow";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_OTP_VAR = "otp";

const Msg91ResponseSchema = z.object({
  type: z.string(),
  message: z.string().optional(),
});

export interface Msg91SmsSenderOptions {
  readonly authKey: string;
  readonly templateId: string;
  readonly otpVar?: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class Msg91SmsSender implements SmsSender {
  private readonly authKey: string;
  private readonly templateId: string;
  private readonly otpVar: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: Msg91SmsSenderOptions) {
    if (!options.authKey || options.authKey.trim().length === 0) {
      throw new Error("MSG91 auth key is required");
    }
    if (!options.templateId || options.templateId.trim().length === 0) {
      throw new Error("MSG91 template ID is required");
    }

    this.authKey = options.authKey.trim();
    this.templateId = options.templateId.trim();
    this.otpVar =
      options.otpVar && options.otpVar.trim().length > 0
        ? options.otpVar.trim()
        : DEFAULT_OTP_VAR;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("MSG91 timeout must be a positive integer");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async sendOtp(phoneE164: string, code: string): Promise<void> {
    const mobiles = phoneE164.startsWith("+") ? phoneE164.slice(1) : phoneE164;
    const payload = {
      template_id: this.templateId,
      short_url: "0",
      recipients: [
        {
          mobiles,
          [this.otpVar]: code,
        },
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authkey: this.authKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody = "";
        try {
          errorBody = await response.text();
        } catch {
          // ignore
        }
        throw new Error(
          `MSG91 request failed with HTTP ${String(response.status)}${errorBody.length > 0 ? `: ${errorBody}` : ""}`,
        );
      }

      let jsonPayload: unknown;
      try {
        jsonPayload = await response.json();
      } catch (parseError) {
        throw new Error("MSG91 response was not valid JSON", { cause: parseError });
      }

      const parsed = Msg91ResponseSchema.safeParse(jsonPayload);
      if (!parsed.success || parsed.data.type !== "success") {
        const failureMessage =
          parsed.success && parsed.data.message
            ? parsed.data.message
            : "MSG91 response type was not success";
        throw new Error(`MSG91 delivery failed: ${failureMessage}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
