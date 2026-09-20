import { Router, type Request, type Response } from "express";
import { requireMember } from "../../http/auth.js";
import { AppError } from "../../http/errors.js";
import { validate } from "../../http/validate.js";
import { DeviceTokenParams, RegisterDeviceBody } from "./schemas.js";
import type { NotificationsService } from "./service.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";

export const notificationsRouteManifest = defineRouteManifest({
  upsertDeviceToken: { method: "put", path: "/v1/me/devices/:token" },
  deleteDeviceToken: { method: "delete", path: "/v1/me/devices/:token" },
} as const);

export interface NotificationsRouteDeps {
  readonly service: NotificationsService;
}

function memberIdFromRequest(request: Request): string {
  const principal = request.principal;
  if (principal?.kind !== "MEMBER") throw new AppError("UNAUTHENTICATED", 401);
  return principal.memberId;
}

export function createNotificationRoutes(deps: NotificationsRouteDeps): Router {
  const router = Router();
  registerRoute(router, notificationsRouteManifest.upsertDeviceToken,
    requireMember(),
    validate({ params: DeviceTokenParams, body: RegisterDeviceBody }),
    async (request: Request, response: Response) => {
      const { token } = DeviceTokenParams.parse(request.params);
      const body = RegisterDeviceBody.parse(request.body);
      await deps.service.registerDevice(memberIdFromRequest(request), token, body);
      response.status(204).send();
    },
  );

  registerRoute(router, notificationsRouteManifest.deleteDeviceToken,
    requireMember(),
    validate({ params: DeviceTokenParams }),
    async (request: Request, response: Response) => {
      const { token } = DeviceTokenParams.parse(request.params);
      await deps.service.deleteDevice(memberIdFromRequest(request), token);
      response.status(204).send();
    },
  );

  return router;
}
