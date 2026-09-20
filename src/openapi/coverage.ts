import type {
  OpenAPIObject,
  OperationObject,
  PathItemObject,
} from "openapi3-ts/oas31";
import { isRecord } from "../adapters/guards.js";
import { bloodSosRouteManifest } from "../modules/blood-sos/index.js";
import { eventsRouteManifest } from "../modules/events/index.js";
import { identityRouteManifest } from "../modules/identity/index.js";
import { mediaRouteManifest } from "../modules/media/index.js";
import { noticesRouteManifest } from "../modules/notices/index.js";
import { notificationsRouteManifest } from "../modules/notifications/index.js";
import { officerRouteManifest } from "../modules/officer/index.js";
import { paymentRouteManifest } from "../modules/payments/index.js";
import { registerRouteManifest } from "../modules/register/index.js";
import { registrationRouteManifest } from "../modules/registration/index.js";
import {
  HTTP_METHODS,
  operationKey,
  systemRouteManifest,
  type HttpMethod,
  type RuntimeOperation,
} from "./route-manifest.js";

export const runtimeOperations: readonly RuntimeOperation[] = [
  ...Object.values(systemRouteManifest),
  ...Object.values(identityRouteManifest),
  ...Object.values(registrationRouteManifest),
  ...Object.values(paymentRouteManifest),
  ...Object.values(registerRouteManifest),
  ...Object.values(mediaRouteManifest),
  ...Object.values(notificationsRouteManifest),
  ...Object.values(noticesRouteManifest),
  ...Object.values(officerRouteManifest),
  ...Object.values(bloodSosRouteManifest),
  ...Object.values(eventsRouteManifest),
];

function operationAt(pathItem: PathItemObject, method: HttpMethod): OperationObject | undefined {
  switch (method) {
    case "get": return pathItem.get;
    case "post": return pathItem.post;
    case "put": return pathItem.put;
    case "patch": return pathItem.patch;
    case "delete": return pathItem.delete;
    case "options": return pathItem.options;
    case "head": return pathItem.head;
    case "trace": return pathItem.trace;
  }
}

interface DocumentOperation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
}

function documentOperations(document: OpenAPIObject): readonly DocumentOperation[] {
  const operations: DocumentOperation[] = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = operationAt(pathItem, method);
      if (operation === undefined) continue;
      if (operation.operationId === undefined || operation.operationId.length === 0) {
        throw new Error(`OpenAPI operation is missing operationId: ${method.toUpperCase()} ${path}`);
      }
      operations.push({ method, path, operationId: operation.operationId });
    }
  }
  return operations;
}

function assertUniqueOperationIds(
  operations: readonly DocumentOperation[],
  source: string,
): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.operationId)) {
      throw new Error(`Duplicate operationId in ${source}: ${operation.operationId}`);
    }
    seen.add(operation.operationId);
  }
}

function assertSameKeys(
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>,
  label: string,
): void {
  const missing = [...expected].filter((key) => !actual.has(key));
  const extra = [...actual].filter((key) => !expected.has(key));
  if (missing.length === 0 && extra.length === 0) return;
  const details = [
    ...(missing.length === 0 ? [] : [`missing: ${missing.join(", ")}`]),
    ...(extra.length === 0 ? [] : [`extra: ${extra.join(", ")}`]),
  ];
  throw new Error(`${label} mismatch (${details.join("; ")})`);
}

function decodeJsonPointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveJsonPointer(root: unknown, reference: string): unknown {
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawToken of reference.slice(2).split("/")) {
    const token = decodeJsonPointerToken(rawToken);
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function assertLocalReferencesResolved(document: OpenAPIObject): void {
  const visit = (value: unknown, location: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, `${location}[${String(index)}]`);
      });
      return;
    }
    if (!isRecord(value)) return;
    const reference = value.$ref;
    if (typeof reference === "string" && reference.startsWith("#/")) {
      if (resolveJsonPointer(document, reference) === undefined) {
        throw new Error(`Unresolved OpenAPI reference at ${location}: ${reference}`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, `${location}.${key}`);
    }
  };
  visit(document, "#");
}

export function assertOpenApiCoverage(
  document: OpenAPIObject,
  frozenContract: OpenAPIObject,
  runtime: readonly RuntimeOperation[] = runtimeOperations,
): void {
  const documentEntries = documentOperations(document);
  const frozenEntries = documentOperations(frozenContract);
  assertUniqueOperationIds(documentEntries, "server document");
  assertUniqueOperationIds(frozenEntries, "frozen contract");

  const documentKeys = new Set(documentEntries.map((entry) => operationKey(entry.method, entry.path)));
  const frozenKeys = new Set(frozenEntries.map((entry) => operationKey(entry.method, entry.path)));
  const runtimeKeys = new Set(runtime.map((entry) => operationKey(entry.method, entry.path)));
  if (runtimeKeys.size !== runtime.length) {
    throw new Error("Runtime route manifest contains duplicate method/path registrations");
  }

  assertSameKeys(frozenKeys, documentKeys, "Frozen/server OpenAPI method/path coverage");
  assertSameKeys(runtimeKeys, documentKeys, "Runtime/server OpenAPI method/path coverage");

  const documentOperationIds = new Set(documentEntries.map((entry) => entry.operationId));
  const frozenOperationIds = new Set(frozenEntries.map((entry) => entry.operationId));
  assertSameKeys(frozenOperationIds, documentOperationIds, "Frozen/server OpenAPI operationId coverage");
  assertLocalReferencesResolved(document);
}
