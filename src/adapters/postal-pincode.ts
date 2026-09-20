import type { PincodeDirectory, PincodePlace } from "./ports.js";
import { isRecord } from "./guards.js";

export interface PostalPincodeOptions {
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_ENDPOINT = "https://api.postalpincode.in/pincode";
const DEFAULT_TIMEOUT_MS = 5_000;

function cityKey(city: string): string {
  return city.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function stringField(value: Record<string, unknown>, name: string): string | null {
  const field = value[name];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

function placeFromResponse(value: unknown): PincodePlace | null {
  if (!Array.isArray(value)) return null;
  const first: unknown = value[0];
  if (!isRecord(first)) return null;
  const status = stringField(first, "Status");
  if (status !== null && status.toLowerCase() !== "success") return null;
  const offices = first.PostOffice;
  if (!Array.isArray(offices)) return null;
  const office = offices.find((entry): entry is Record<string, unknown> => isRecord(entry));
  if (office === undefined) return null;
  const city = stringField(office, "Name");
  const district = stringField(office, "District");
  const state = stringField(office, "State");
  if (city === null || state === null) return null;
  return {
    city,
    cityKey: cityKey(city),
    district,
    state,
  };
}

export class PostalPincodeDirectory implements PincodeDirectory {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: PostalPincodeOptions = {}) {
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public async lookup(pincode: string): Promise<PincodePlace | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${this.endpoint}/${encodeURIComponent(pincode)}`,
        { signal: controller.signal, headers: { Accept: "application/json" } },
      );
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      return placeFromResponse(payload);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createPostalPincodeDirectory(options: PostalPincodeOptions = {}): PincodeDirectory {
  return new PostalPincodeDirectory(options);
}
