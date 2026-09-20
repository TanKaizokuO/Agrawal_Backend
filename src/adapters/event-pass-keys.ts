import { createPrivateKey, createPublicKey } from "node:crypto";
import type {
  EventPassKeyPort,
  EventPassSigningKey,
  EventPassVerificationKey,
} from "../modules/events/index.js";

export interface EventPassKeyStoreOptions {
  readonly keys: readonly EventPassSigningKey[];
}

export class ConfiguredEventPassKeyStore implements EventPassKeyPort {
  private readonly keys: readonly EventPassSigningKey[];
  private readonly verificationKeys: readonly EventPassVerificationKey[];

  public constructor(options: EventPassKeyStoreOptions) {
    this.keys = options.keys.map((key) => {
      createPrivateKey(key.privateKeyPem);
      return { kid: key.kid, privateKeyPem: key.privateKeyPem };
    });
    this.verificationKeys = this.keys.map((key) => ({
      kid: key.kid,
      publicKeyPem: createPublicKey(createPrivateKey(key.privateKeyPem)).export({ format: "pem", type: "spki" }),
    }));
  }

  public getSigningKey(): Promise<EventPassSigningKey> {
    const first = this.keys[0];
    if (first === undefined) return Promise.reject(new Error("No event pass signing key is configured"));
    return Promise.resolve(first);
  }

  public getVerificationKeys(): Promise<readonly EventPassVerificationKey[]> {
    return Promise.resolve(this.verificationKeys);
  }
}

export function createEventPassKeyStore(
  options: EventPassKeyStoreOptions,
): EventPassKeyPort {
  return new ConfiguredEventPassKeyStore(options);
}
