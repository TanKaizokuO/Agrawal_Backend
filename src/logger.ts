import pino, { type DestinationStream, type Logger } from "pino";

export const logRedaction = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.params.token",
    "*.firebaseIdToken",
    "*.phoneE164",
    "*.vpa",
    "*.dateOfBirth",
    "*.address*",
    "*.bloodGroup",
    "*.nominee*",
    "req.body",
  ],
  censor: "[REDACTED]",
};

// Device push tokens are path parameters (/v1/me/devices/:token), so they reach the access log via the URL.
const DEVICE_TOKEN_PATH = /^(\/v1\/me\/devices\/)[^/?#]+/u;

export function redactRequestUrl<T extends { url?: unknown }>(request: T): T {
  if (typeof request.url !== "string") return request;
  return { ...request, url: request.url.replace(DEVICE_TOKEN_PATH, `$1${logRedaction.censor}`) };
}

export function createLogger(destination?: DestinationStream): Logger {
  return pino({ redact: logRedaction }, destination);
}

// Callers may pass any logger; the redaction must not depend on how they built it.
export function withRedaction(logger: Logger): Logger {
  return logger.child({}, { redact: logRedaction });
}
