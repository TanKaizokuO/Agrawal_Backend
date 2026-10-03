import type { SmsSender } from "../../../adapters/ports.js";
import type { Logger } from "pino";
import { createLogger } from "../../../logger.js";

export interface ConsoleSmsSenderOptions {
  readonly logger?: Logger;
  readonly isProduction?: boolean;
}

export class ConsoleSmsSender implements SmsSender {
  private readonly logger: Logger;
  private readonly isProduction: boolean;

  public constructor(options: ConsoleSmsSenderOptions = {}) {
    this.logger = options.logger ?? createLogger();
    this.isProduction = options.isProduction ?? false;
  }

  public sendOtp(phoneE164: string, code: string): Promise<void> {
    if (this.isProduction) {
      return Promise.reject(new Error("Console SMS provider is not permitted in production"));
    }

    this.logger.info(
      { phone: phoneE164, code },
      `[DEV SMS OTP] Code for ${phoneE164}: ${code}`,
    );
    return Promise.resolve();
  }
}
