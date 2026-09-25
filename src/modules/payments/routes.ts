import { Router, type Request, type Response } from "express";
import { AppError } from "../../http/errors.js";
import { requirePrincipal } from "../../http/auth.js";
import { validate } from "../../http/validate.js";
import type { PaymentView, PaymentViewer, PaymentService } from "./service.js";
import type { PaymentWebhookService } from "./webhooks.js";
import {
  ConfirmPaymentBody,
  ConfirmPaymentParams,
  GetPaymentParams,
  PaymentViewResponse,
  type ConfirmPaymentInput,
  type PaymentViewResponseBody,
} from "./schemas.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";

export const paymentRouteManifest = defineRouteManifest({
  confirmPayment: { method: "post", path: "/v1/payments/:paymentId/confirm" },
  getPayment: { method: "get", path: "/v1/payments/:paymentId" },
  receiveWebhook: { method: "post", path: "/v1/webhooks/razorpay" },
} as const);

export interface PaymentRouteDeps {
  readonly service: PaymentService;
}

export interface PaymentWebhookRouteDeps {
  readonly webhookService: PaymentWebhookService;
}

function viewer(request: Request): PaymentViewer {
  const principal = request.principal;
  if (principal === null) {
    throw new AppError("UNAUTHENTICATED", 401);
  }
  if (principal.kind === "MEMBER") {
    return { phoneE164: principal.phoneE164, memberId: principal.memberId };
  }
  return { phoneE164: principal.phoneE164 };
}

function parameter(value: string | readonly string[] | undefined): string {
  if (typeof value !== "string") throw new AppError("VALIDATION_FAILED", 400);
  return value;
}

function responseBody(view: PaymentView): PaymentViewResponseBody {
  return PaymentViewResponse.parse({
    ...view,
    capturedAt: view.capturedAt?.toISOString() ?? null,
  });
}

export function createPaymentRoutes(deps: PaymentRouteDeps): Router {
  const router = Router();

  registerRoute(router, paymentRouteManifest.confirmPayment,
    requirePrincipal(),
    validate({ params: ConfirmPaymentParams, body: ConfirmPaymentBody }),
    async (request: Request, response: Response) => {
      const paymentId = parameter(request.params.paymentId);
      const body: ConfirmPaymentInput = ConfirmPaymentBody.parse(request.body);
      const view = await deps.service.confirmPaymentForPrincipal(paymentId, body, viewer(request));
      response.json(responseBody(view));
    },
  );

  registerRoute(router, paymentRouteManifest.getPayment,
    requirePrincipal(),
    validate({ params: GetPaymentParams }),
    async (request: Request, response: Response) => {
      const paymentId = parameter(request.params.paymentId);
      const view = await deps.service.getViewForPrincipal(paymentId, viewer(request));
      response.json(responseBody(view));
    },
  );

  return router;
}

/**
 * Mount this handler before express.json(). Razorpay signs the exact raw
 * request bytes, so parsing before verification would make the signature
 * unverifiable and would allow malformed requests to reach persistence.
 */
export function createWebhookHandler(deps: PaymentWebhookRouteDeps) {
  return async (request: Request, response: Response): Promise<void> => {
    const signature = request.get("X-Razorpay-Signature");
    const eventId = request.get("x-razorpay-event-id");
    if (!Buffer.isBuffer(request.body) || signature === undefined || eventId === undefined) {
      response.status(400).json({ error: "invalid webhook" });
      return;
    }
    const accepted = await deps.webhookService.receive(request.body, signature, eventId);
    if (!accepted) {
      response.status(400).json({ error: "invalid webhook" });
      return;
    }
    response.status(200).json({ ok: true });
  };
}
