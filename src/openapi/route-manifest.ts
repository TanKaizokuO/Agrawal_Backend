import type { RequestHandlerParams } from "express-serve-static-core";
import { Router } from "express";

export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RuntimeOperation {
  readonly method: HttpMethod;
  readonly path: string;
}

export type RuntimeRouteManifest = Readonly<Record<string, RuntimeOperation>>;

export function defineRouteManifest<const T extends RuntimeRouteManifest>(
  manifest: T,
): T {
  return manifest;
}

export const systemRouteManifest = defineRouteManifest({
  health: { method: "get", path: "/healthz" },
  readiness: { method: "get", path: "/readyz" },
} as const);

type RouteTarget = Pick<Router, (typeof HTTP_METHODS)[number]>;

export function registerRoute(
  target: RouteTarget,
  operation: RuntimeOperation,
  ...handlers: RequestHandlerParams[]
): void {
  switch (operation.method) {
    case "get": target.get(operation.path, ...handlers); return;
    case "post": target.post(operation.path, ...handlers); return;
    case "put": target.put(operation.path, ...handlers); return;
    case "patch": target.patch(operation.path, ...handlers); return;
    case "delete": target.delete(operation.path, ...handlers); return;
    case "options": target.options(operation.path, ...handlers); return;
    case "head": target.head(operation.path, ...handlers); return;
    case "trace": target.trace(operation.path, ...handlers); return;
  }
}

export function normalizedPath(path: string): string {
  return path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":") || (segment.startsWith("{") && segment.endsWith("}"))) {
        return "{}";
      }
      return segment;
    })
    .join("/");
}

export function operationKey(method: string, path: string): string {
  return `${method.toLowerCase()}:${normalizedPath(path)}`;
}
