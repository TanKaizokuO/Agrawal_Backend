import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

export const HealthResponse = z
  .object({
    status: z.literal("ok"),
    requestId: z.string(),
  })
  .meta({ id: "HealthResponse" });

export const ReadinessResponse = z
  .object({
    status: z.enum(["ok", "not_ready"]),
    checks: z.object({
      database: z.enum(["ok", "unavailable"]),
      jobs: z.enum(["ok", "unavailable"]),
    }),
    requestId: z.string(),
  })
  .meta({ id: "ReadinessResponse" });

export const registry = new OpenAPIRegistry();

registry.registerPath({
  method: "get",
  path: "/healthz",
  operationId: "getHealth",
  tags: ["system"],
  responses: {
    200: {
      description: "The API process is alive.",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/readyz",
  operationId: "getReadiness",
  tags: ["system"],
  responses: {
    200: {
      description: "The database and job runtime are ready.",
      content: { "application/json": { schema: ReadinessResponse } },
    },
    503: {
      description: "A required dependency is unavailable.",
      content: { "application/json": { schema: ReadinessResponse } },
    },
  },
});

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31["generateDocument"]>;

export function generateOpenApiDocument(
  source: OpenAPIRegistry = registry,
): OpenApiDocument {
  const generator = new OpenApiGeneratorV31(source.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Agrawal Samaj API",
      version: "0.1.0",
      description: "The HTTP contract for the Agrawal Samaj clients.",
    },
  });
}
