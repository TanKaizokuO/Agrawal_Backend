import cors from "cors";
import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import helmet from "helmet";
import pino, { type Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { Config } from "./config.js";
import { checkDatabase } from "./db.js";
import { csrf } from "./http/csrf.js";
import { errorMiddleware, AppError } from "./http/errors.js";
import { requestId as requestIdMiddleware } from "./http/request-id.js";
import { authenticate as authenticateMiddleware } from "./http/auth.js";
import type { PrincipalResolver } from "./http/auth.js";
import type { JobRuntime } from "./jobs.js";
import {
  registerRoute,
  systemRouteManifest,
} from "./openapi/route-manifest.js";
export interface AppDatabase {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface AppDependencies {
  readonly config: Pick<Config, "webOrigins">;
  readonly database: AppDatabase;
  readonly jobs: Pick<JobRuntime, "isReady">;
  readonly logger?: Logger;
  readonly principalResolver?: PrincipalResolver;
  readonly mountRazorpayWebhook?: (app: Express) => void;
  readonly mountRoutes?: (app: Express) => void;
  readonly rawBodyPathPrefixes?: readonly string[];
}

export type ApiApp = Express;

const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function jsonOnlyBody(rawBodyPathPrefixes: readonly string[]): RequestHandler {
  return (request, _response, next) => {
    if (!unsafeMethods.has(request.method) || !request.path.startsWith("/v1")) {
      next();
      return;
    }
    if (rawBodyPathPrefixes.some((prefix) => request.path.startsWith(prefix))) {
      next();
      return;
    }

    const contentType = request.get("Content-Type");
    const contentLength = request.get("Content-Length");
    const hasBody =
      (contentLength !== undefined && Number(contentLength) > 0) ||
      request.get("Transfer-Encoding") !== undefined;
    if (
      hasBody &&
      (contentType === undefined ||
        !/^application\/json(?:\s*;|$)/iu.test(contentType))
    ) {
      next(new AppError("UNSUPPORTED_MEDIA_TYPE", 415));
      return;
    }
    next();
  };
}

function makeLogger(logger: Logger | undefined): Logger {
  if (logger !== undefined) return logger;
  return pino({
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
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
    },
  });
}
export function mountRawRazorpayWebhook(
  app: Express,
  path: string,
  handler: RequestHandler,
): void {
  app.post(path, express.raw({ type: "application/json", limit: "1mb" }), handler);
}


export function createApp(dependencies: AppDependencies): Express {
  const app = express();
  const logger = makeLogger(dependencies.logger);
  const rawBodyPathPrefixes = dependencies.rawBodyPathPrefixes ?? [
    "/v1/webhooks/razorpay",
    "/v1/media/images",
  ];
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp<Request>({
      logger,
      genReqId: (request) => {
        const id = request.headers["x-request-id"];
        return Array.isArray(id) ? id[0] ?? "" : id ?? "";
      },
      customProps: (request) => ({
        requestId: request.id,
        principalId:
          request.principal?.kind === "MEMBER"
            ? request.principal.memberId
            : undefined,
      }),
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      credentials: true,
      origin: (origin, callback) => {
        if (origin === undefined || dependencies.config.webOrigins.includes(origin)) {
          callback(null, origin ?? false);
          return;
        }
        callback(new AppError("FORBIDDEN", 403));
      },
    }),
  );

  // This seam is deliberately before express.json(): Razorpay signatures are over raw bytes.
  dependencies.mountRazorpayWebhook?.(app);
  app.use(express.json({ limit: "2mb", type: "application/json" }));
  app.use(jsonOnlyBody(rawBodyPathPrefixes));
  app.use(authenticateMiddleware(dependencies.principalResolver));
  app.use(csrf({ allowedOrigins: dependencies.config.webOrigins }));

  registerRoute(app, systemRouteManifest.health, (request: Request, response: Response) => {
    response.json({ status: "ok", requestId: request.id });
  });

  registerRoute(app, systemRouteManifest.readiness, async (request: Request, response: Response) => {
    const [databaseReady, jobsReady] = await Promise.all([
      checkDatabase(dependencies.database).then(
        () => true,
        () => false,
      ),
      dependencies.jobs.isReady().catch(() => false),
    ]);
    const status = databaseReady && jobsReady ? "ok" : "not_ready";
    response.status(status === "ok" ? 200 : 503).json({
      status,
      checks: {
        database: databaseReady ? "ok" : "unavailable",
        jobs: jobsReady ? "ok" : "unavailable",
      },
      requestId: request.id,
    });
  });

  dependencies.mountRoutes?.(app);
  app.use((_request, _response, next) => {
    next(new AppError("NOT_FOUND", 404));
  });
  app.use(errorMiddleware(logger));
  return app;
}

export {
  requestIdMiddleware as requestId,
  authenticateMiddleware as authenticate,
  csrf,
};

