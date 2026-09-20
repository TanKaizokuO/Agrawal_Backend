import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { z } from "zod";
import type {
  EventPassSigningKey,
  EventPassVerificationKey,
} from "./ports.js";

export const EventPassPayloadSchema = z.object({
  p: z.string().min(1),
  e: z.string().min(1),
  m: z.string().min(1),
  h: z.boolean(),
  c: z.number().int().min(0).max(20),
  n: z.string().min(1).max(240),
  x: z.number().int().nonnegative(),
}).strict();

export type EventPassPayload = z.infer<typeof EventPassPayloadSchema>;

export interface VerifiedPass {
  readonly valid: true;
  readonly payload: EventPassPayload;
}

export type PassVerificationFailure =
  | "MALFORMED"
  | "UNKNOWN_KEY"
  | "BAD_SIGNATURE"
  | "INVALID_PAYLOAD"
  | "EVENT_MISMATCH"
  | "EXPIRED"
  | "REVOKED";

export interface InvalidPass {
  readonly valid: false;
  readonly reason: PassVerificationFailure;
}

export type PassVerificationResult = VerifiedPass | InvalidPass;

function keyIdIsSafe(kid: string): boolean {
  return kid.length > 0 && kid.length <= 100 && !kid.includes(".");
}

function decodeBase64Url(value: string): Buffer | null {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

function privateKey(value: EventPassSigningKey): KeyObject {
  if (!keyIdIsSafe(value.kid)) throw new Error("Invalid event pass signing key id");
  return createPrivateKey(value.privateKeyPem);
}

function publicKey(value: EventPassVerificationKey): KeyObject | null {
  if (!keyIdIsSafe(value.kid)) return null;
  try {
    return createPublicKey(value.publicKeyPem);
  } catch {
    return null;
  }
}

export function deterministicPassPayload(input: EventPassPayload): string {
  const parsed = EventPassPayloadSchema.parse(input);
  // Object insertion order is part of the protocol. Do not sort or re-encode
  // this JSON: the signature covers these exact UTF-8 bytes.
  return JSON.stringify({
    p: parsed.p,
    e: parsed.e,
    m: parsed.m,
    h: parsed.h,
    c: parsed.c,
    n: parsed.n,
    x: parsed.x,
  });
}

export function signEventPass(
  payload: EventPassPayload,
  signingKey: EventPassSigningKey,
): string {
  const payloadBytes = Buffer.from(deterministicPassPayload(payload), "utf8");
  const signature = sign(null, payloadBytes, privateKey(signingKey));
  return [
    signingKey.kid,
    payloadBytes.toString("base64url"),
    signature.toString("base64url"),
  ].join(".");
}

export function verifyEventPass(
  qrPayload: string,
  verificationKeys: readonly EventPassVerificationKey[],
  input: {
    readonly eventId?: string;
    readonly revokedPassIds?: ReadonlySet<string>;
    readonly now?: Date;
  } = {},
): PassVerificationResult {
  const parts = qrPayload.split(".");
  if (parts.length !== 3) return { valid: false, reason: "MALFORMED" };
  const [kid, payloadB64, signatureB64] = parts;
  if (kid === undefined || payloadB64 === undefined || signatureB64 === undefined || !keyIdIsSafe(kid)) {
    return { valid: false, reason: "MALFORMED" };
  }

  const payloadBytes = decodeBase64Url(payloadB64);
  const signature = decodeBase64Url(signatureB64);
  if (payloadBytes === null || signature === null) return { valid: false, reason: "MALFORMED" };

  const key = verificationKeys.find((candidate) => candidate.kid === kid);
  if (key === undefined) return { valid: false, reason: "UNKNOWN_KEY" };
  const publicKeyObject = publicKey(key);
  if (publicKeyObject === null) return { valid: false, reason: "UNKNOWN_KEY" };

  let authenticated = false;
  try {
    authenticated = verify(null, payloadBytes, publicKeyObject, signature);
  } catch {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }
  if (!authenticated) return { valid: false, reason: "BAD_SIGNATURE" };

  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { valid: false, reason: "INVALID_PAYLOAD" };
  }
  const parsed = EventPassPayloadSchema.safeParse(decoded);
  if (!parsed.success) return { valid: false, reason: "INVALID_PAYLOAD" };

  if (input.eventId !== undefined && parsed.data.e !== input.eventId) {
    return { valid: false, reason: "EVENT_MISMATCH" };
  }
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (parsed.data.x <= nowSeconds) return { valid: false, reason: "EXPIRED" };
  if (input.revokedPassIds?.has(parsed.data.p) === true) {
    return { valid: false, reason: "REVOKED" };
  }
  return { valid: true, payload: parsed.data };
}
