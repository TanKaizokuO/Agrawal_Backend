import { TranslationServiceClient } from "@google-cloud/translate";
import type { Romanizer } from "./ports.js";
import { isRecord } from "./guards.js";

export interface TranslateRomanizerOptions {
  readonly projectId: string;
  readonly serviceAccountJson: string;
  readonly location?: string;
}

function credentialsFromJson(value: string): {
  readonly client_email: string;
  readonly private_key: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Google service account JSON is invalid");
  }
  if (!isRecord(parsed)) throw new Error("Google service account JSON is invalid");
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  if (
    typeof clientEmail !== "string" || clientEmail.length === 0
    || typeof privateKey !== "string" || privateKey.length === 0
  ) {
    throw new Error("Google service account JSON is missing credentials");
  }
  return {
    client_email: clientEmail,
    private_key: privateKey.replaceAll("\\n", "\n"),
  };
}

function romanizedText(value: unknown): string {
  if (!isRecord(value)) throw new Error("Google romanization response is invalid");
  const romanizations = value.romanizations;
  if (!Array.isArray(romanizations) || romanizations.length !== 1) {
    throw new Error("Google romanization response is invalid");
  }
  const first: unknown = romanizations[0];
  if (!isRecord(first) || typeof first.romanizedText !== "string") {
    throw new Error("Google romanization response is invalid");
  }
  return first.romanizedText;
}

export class GoogleRomanizer implements Romanizer {
  private readonly client: TranslationServiceClient;
  private readonly parent: string;

  public constructor(options: TranslateRomanizerOptions) {
    this.client = new TranslationServiceClient({
      projectId: options.projectId,
      credentials: credentialsFromJson(options.serviceAccountJson),
    });
    const location = options.location ?? "global";
    this.parent = `projects/${options.projectId}/locations/${location}`;
  }

  public async romanize(devanagari: string): Promise<string> {
    const [response] = await this.client.romanizeText({
      parent: this.parent,
      sourceLanguageCode: "hi",
      contents: [devanagari],
    });
    return romanizedText(response);
  }
}

export function createGoogleRomanizer(options: TranslateRomanizerOptions): Romanizer {
  return new GoogleRomanizer(options);
}
