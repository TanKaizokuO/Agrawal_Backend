export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  if (!("code" in error)) return undefined;
  return error.code;
}

export function isUniqueViolation(error: unknown): boolean {
  const code = errorCode(error);
  return code === "P2002" || code === "23505";
}

export function isNotFoundViolation(error: unknown): boolean {
  const code = errorCode(error);
  return code === "P2025" || code === "02000";
}
