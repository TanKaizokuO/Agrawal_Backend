import { z } from "zod";
import type { ImageScreener } from "./ports.js";

const SightengineResponse = z.object({
  status: z.literal("success"),
  nudity: z.record(z.string(), z.number().min(0).max(1)),
});

const EXPLICIT_CLASSES = ["sexual_activity", "sexual_display", "erotica"] as const;
const DEFAULT_ENDPOINT = "https://api.sightengine.com/1.0/check.json";
const DEFAULT_TIMEOUT_MS = 8_000;

export interface ImageScreenResult {
  readonly status: "ACCEPTED" | "REJECTED";
  readonly reason?: "EXPLICIT";
  readonly score: Readonly<Record<string, number>>;
}

export interface ImageScreenerOptions {
  readonly apiUser: string;
  readonly apiSecret: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface DetailedImageScreener extends ImageScreener {
  screenWithDetails(input: {
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<ImageScreenResult>;
}

/**
 * Sightengine's HTTP contract is deliberately contained here.  A malformed,
 * non-success or unavailable response becomes an exception; Media treats that
 * exception as the documented fail-closed screening outcome.
 */
export class SightengineImageScreener implements DetailedImageScreener {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  public constructor(private readonly options: ImageScreenerOptions) {
    if (options.apiUser.trim().length === 0 || options.apiSecret.trim().length === 0) {
      throw new Error("Sightengine credentials are required");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("Sightengine timeout must be a positive integer");
    }
  }

  public async screen(input: {
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<"ACCEPTED" | "REJECTED"> {
    const result = await this.screenWithDetails(input);
    return result.status;
  }

  public async screenWithDetails(input: {
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<ImageScreenResult> {
    if (input.body.byteLength === 0) throw new Error("Sightengine body is empty");
    if (input.contentType.trim().length === 0) throw new Error("Sightengine content type is required");

    const form = new FormData();
    form.append("media", new Blob([Buffer.from(input.body)], { type: input.contentType }), "image.jpg");
    form.set("models", "nudity-2.1");
    form.set("api_user", this.options.apiUser);
    form.set("api_secret", this.options.apiSecret);

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Sightengine returned HTTP ${String(response.status)}`);
      const payload: unknown = await response.json();
      const parsed = SightengineResponse.safeParse(payload);
      if (!parsed.success) throw new Error("Sightengine response shape was invalid");

      const explicit = EXPLICIT_CLASSES.some((name) => (parsed.data.nudity[name] ?? 0) >= 0.85);
      return {
        status: explicit ? "REJECTED" : "ACCEPTED",
        ...(explicit ? { reason: "EXPLICIT" as const } : {}),
        score: parsed.data.nudity,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createImageScreener(options: ImageScreenerOptions): DetailedImageScreener {
  return new SightengineImageScreener(options);
}
