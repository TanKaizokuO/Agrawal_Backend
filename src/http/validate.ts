import type { RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "./errors.js";

export interface ValidationSchemas {
  readonly body?: z.ZodType;
  readonly query?: z.ZodType;
  readonly params?: z.ZodType;
}

interface ValidationIssue {
  readonly path: Array<string | number>;
  readonly message: string;
}

export function validate(schemas: ValidationSchemas): RequestHandler {
  return (request, _response, next) => {
    const issues: ValidationIssue[] = [];
    const parts: Array<keyof ValidationSchemas> = ["body", "query", "params"];

    for (const part of parts) {
      const schema = schemas[part];
      if (schema === undefined) continue;

      const result = schema.safeParse(request[part]);
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({
            path: [
              part,
              ...issue.path.map((segment) =>
                typeof segment === "symbol"
                  ? (segment.description ?? segment.toString())
                  : segment,
              ),
            ],
            message: issue.message,
          });
        }
        continue;
      }

      if (part === "body") request.body = result.data;
      if (part === "query") request.query = result.data as typeof request.query;
      if (part === "params") request.params = result.data as typeof request.params;
    }

    if (issues.length > 0) {
      next(new AppError("VALIDATION_FAILED", 400, { issues }));
      return;
    }
    next();
  };
}
