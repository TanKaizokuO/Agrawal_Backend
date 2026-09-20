import { Router, type Request, type RequestHandler, type Response } from "express";
import { requireMember, requireRole, type MemberPrincipal } from "../../http/auth.js";
import { AppError } from "../../http/errors.js";
import { configuredRateLimit, type RateLimiter } from "../../http/rate-limit.js";
import { validate } from "../../http/validate.js";
import type {
  EventActor,
  EventView,
  EventsService,
  GateManifest,
  PassView,
} from "./service.js";
import {
  AdmissionsQuery,
  AdmissionListResponse,
  ClaimPassBody,
  CreateEventBody,
  EventIdAliasParams,
  EventIdParams,
  EventListResponse,
  EventResponse,
  EventsListQuery,
  GateDeviceBody,
  GateDeviceResponse,
  GateManifestResponse,
  OfficerRevokePassBody,
  PassIdParams,
  PassListResponse,
  PassResponse,
  PatchEventBody,
  SyncAdmissionsBody,
  SyncAdmissionsResponse,
  type ClaimPassInput,
  type CreateEventInput,
  type PatchEventInput,
  type SyncAdmissionsInput,
} from "./schemas.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";

export const eventsRouteManifest = defineRouteManifest({
  create: { method: "post", path: "/v1/events" },
  list: { method: "get", path: "/v1/events" },
  get: { method: "get", path: "/v1/events/:id" },
  update: { method: "patch", path: "/v1/events/:id" },
  cancel: { method: "post", path: "/v1/events/:id/cancel" },
  claimPass: { method: "post", path: "/v1/events/:eventId/passes" },
  getMyPass: { method: "get", path: "/v1/events/:eventId/passes/mine" },
  cancelMyPass: { method: "delete", path: "/v1/events/:eventId/passes/mine" },
  listPasses: { method: "get", path: "/v1/events/:eventId/passes" },
  registerGateDevice: { method: "post", path: "/v1/events/:eventId/gate-devices" },
  getGateManifest: { method: "get", path: "/v1/events/:eventId/gate-manifest" },
  syncAdmissions: { method: "post", path: "/v1/events/:eventId/admissions/sync" },
  listAdmissions: { method: "get", path: "/v1/events/:eventId/admissions" },
  listMyPasses: { method: "get", path: "/v1/me/passes" },
  officerRevokePass: { method: "post", path: "/v1/officer/passes/:passId/revoke" },
} as const);

function memberPrincipal(request: Request): MemberPrincipal {
  const principal = request.principal;
  if (principal?.kind !== "MEMBER") throw new AppError("UNAUTHENTICATED", 401);
  return principal;
}
function actor(request: Request): EventActor {
  const principal = memberPrincipal(request);
  return { memberId: principal.memberId, roles: principal.roles };
}


export interface EventsRouteDeps {
  readonly service: EventsService;
  readonly rateLimiter?: RateLimiter;
}

function requireEventRole(): RequestHandler {
  return (request, _response, next) => {
    const principal = request.principal;
    if (principal === null) {
      next(new AppError("UNAUTHENTICATED", 401));
      return;
    }
    if (
      principal.kind !== "MEMBER" ||
      (!principal.roles.includes("ORGANISER") && !principal.roles.includes("OPERATOR"))
    ) {
      next(new AppError("NOT_ORGANISER", 403));
      return;
    }
    next();
  };
}
function memberIdKey(request: Request): string {
  return memberPrincipal(request).memberId;
}


function eventBody(event: EventView): unknown {
  return EventResponse.parse({
    id: event.id,
    title: event.title,
    titleHi: event.titleHi,
    description: event.description,
    descriptionHi: event.descriptionHi,
    venue: event.venue,
    venueCity: event.venueCity,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    createdBy: event.createdBy,
    status: event.status,
    createdAt: event.createdAt.toISOString(),
    ...(event.passCount === undefined ? {} : { passCount: event.passCount }),
  });
}

function passBody(pass: PassView): unknown {
  return PassResponse.parse({
    passId: pass.id,
    eventId: pass.eventId,
    memberId: pass.memberId,
    familyId: pass.familyId,
    isHead: pass.isHead,
    minorsCount: pass.minorsCount,
    status: pass.status,
    qrPayload: pass.qrPayload,
    issuedAt: pass.issuedAt.toISOString(),
    revokedAt: pass.revokedAt?.toISOString() ?? null,
    revokedReason: pass.revokedReason,
    ...(pass.member === undefined ? {} : { member: pass.member }),
    event: {
      id: pass.event.id,
      title: pass.event.title,
      venue: pass.event.venue,
      startsAt: pass.event.startsAt.toISOString(),
      endsAt: pass.event.endsAt.toISOString(),
    },
  });
}

function eventInput(body: CreateEventInput) {
  return {
    title: body.title,
    ...(body.titleHi === undefined ? {} : { titleHi: body.titleHi }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.descriptionHi === undefined ? {} : { descriptionHi: body.descriptionHi }),
    venue: body.venue,
    venueCity: body.venueCity,
    startsAt: new Date(body.startsAt),
    endsAt: new Date(body.endsAt),
  };
}

function patchInput(body: PatchEventInput) {
  return {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.titleHi === undefined ? {} : { titleHi: body.titleHi }),
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.descriptionHi === undefined ? {} : { descriptionHi: body.descriptionHi }),
    ...(body.venue === undefined ? {} : { venue: body.venue }),
    ...(body.venueCity === undefined ? {} : { venueCity: body.venueCity }),
    ...(body.startsAt === undefined ? {} : { startsAt: new Date(body.startsAt) }),
    ...(body.endsAt === undefined ? {} : { endsAt: new Date(body.endsAt) }),
  };
}


export function createEventsRoutes(deps: EventsRouteDeps): Router {
  const router = Router();
  const createRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "event.create",
    key: memberIdKey,
    limit: 10,
    windowSeconds: 60 * 60,
  });
  const claimPassRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "pass.claim",
    key: memberIdKey,
    limit: 30,
    windowSeconds: 60 * 60,
  });
  const admissionsSyncRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "admissions.sync",
    key: memberIdKey,
    limit: 60,
    windowSeconds: 60 * 60,
  });

  registerRoute(router, eventsRouteManifest.create,
    requireEventRole(),
    ...createRateLimit,
    validate({ body: CreateEventBody }),
    async (request: Request, response: Response) => {
      const body = CreateEventBody.parse(request.body);
      const created = await deps.service.createEvent(actor(request), eventInput(body));
      response.status(201).json(eventBody(created));
    },
  );

  registerRoute(router, eventsRouteManifest.list,
    requireMember(),
    validate({ query: EventsListQuery }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const query = EventsListQuery.parse(request.query);
      const page = await deps.service.listEvents(
        principal.memberId,
        query.cursor ?? 0,
        query.limit,
      );
      response.json(EventListResponse.parse({
        items: page.items.map((item) => eventBody(item)),
        nextCursor: page.nextCursor,
      }));
    },
  );

  registerRoute(router, eventsRouteManifest.get,
    requireMember(),
    validate({ params: EventIdParams }),
    async (request: Request, response: Response) => {
      const principal = memberPrincipal(request);
      const { id } = EventIdParams.parse(request.params);
      const includePassCount = principal.roles.includes("ORGANISER") || principal.roles.includes("OPERATOR");
      response.json(eventBody(await deps.service.getEvent(principal.memberId, id, includePassCount)));
    },
  );

  registerRoute(router, eventsRouteManifest.update,
    requireEventRole(),
    validate({ params: EventIdParams, body: PatchEventBody }),
    async (request: Request, response: Response) => {
      const { id } = EventIdParams.parse(request.params);
      const body = PatchEventBody.parse(request.body);
      const updated = await deps.service.updateEvent(actor(request), id, patchInput(body));
      response.json(eventBody(updated));
    },
  );

  registerRoute(router, eventsRouteManifest.cancel,
    requireEventRole(),
    validate({ params: EventIdParams }),
    async (request: Request, response: Response) => {
      const { id } = EventIdParams.parse(request.params);
      response.json(eventBody(await deps.service.cancelEvent(actor(request), id)));
    },
  );

  registerRoute(router, eventsRouteManifest.claimPass,
    requireMember(),
    ...claimPassRateLimit,
    validate({ params: EventIdAliasParams, body: ClaimPassBody }),
    async (request: Request, response: Response) => {
      const { eventId } = EventIdAliasParams.parse(request.params);
      const body: ClaimPassInput = ClaimPassBody.parse(request.body);
      const pass = await deps.service.claimPass(memberPrincipal(request).memberId, eventId, body.minorsCount);
      response.status(201).json(passBody(pass));
    },
  );

  registerRoute(router, eventsRouteManifest.getMyPass,
    requireMember(),
    validate({ params: EventIdAliasParams }),
    async (request: Request, response: Response) => {
      const { eventId } = EventIdAliasParams.parse(request.params);
      const pass = await deps.service.getMyPass(memberPrincipal(request).memberId, eventId);
      response.json(pass === null ? null : passBody(pass));
    },
  );

  registerRoute(router, eventsRouteManifest.cancelMyPass,
    requireMember(),
    validate({ params: EventIdAliasParams }),
    async (request: Request, response: Response) => {
      const { eventId } = EventIdAliasParams.parse(request.params);
      await deps.service.cancelMyPass(memberPrincipal(request).memberId, eventId);
      response.status(204).send();
    },
  );

  registerRoute(router, eventsRouteManifest.listPasses,
    requireEventRole(),
    validate({ params: EventIdAliasParams }),
    async (request: Request, response: Response) => {
      const { eventId } = EventIdAliasParams.parse(request.params);
      const page = await deps.service.listPasses(actor(request), eventId);
      response.json(PassListResponse.parse({
        items: page.items.map((item) => passBody(item)),
        nextCursor: page.nextCursor,
      }));
    },
  );

  registerRoute(router, eventsRouteManifest.registerGateDevice,
    requireEventRole(),
    validate({ params: EventIdAliasParams, body: GateDeviceBody }),
    async (request: Request, response: Response) => {
      const { eventId } = EventIdAliasParams.parse(request.params);
      const body = GateDeviceBody.parse(request.body);
      const result = await deps.service.registerGateDevice(actor(request), eventId, body.label);
      response.status(201).json(GateDeviceResponse.parse({
        gateDeviceId: result.gateDevice.id,
        label: result.gateDevice.label,
        eventId: result.gateDevice.eventId,
        registeredBy: result.gateDevice.registeredBy,
        registeredAt: result.gateDevice.registeredAt.toISOString(),
        manifest: manifestBody(result.manifest),
      }));
    },
  );

  registerRoute(router, eventsRouteManifest.getGateManifest,
    requireEventRole(),
    validate({ params: EventIdAliasParams }),
    async (request: Request, response: Response) => {
      const { eventId } = EventIdAliasParams.parse(request.params);
      response.json(GateManifestResponse.parse(manifestBody(await deps.service.gateManifest(actor(request), eventId))));
    },
  );

  registerRoute(router, eventsRouteManifest.syncAdmissions,
    requireEventRole(),
    ...admissionsSyncRateLimit,
    validate({ params: EventIdAliasParams, body: SyncAdmissionsBody }),
    async (request: Request, response: Response) => {
      const { eventId } = EventIdAliasParams.parse(request.params);
      const body: SyncAdmissionsInput = SyncAdmissionsBody.parse(request.body);
      const result = await deps.service.syncAdmissions(
        actor(request),
        eventId,
        body.gateDeviceId,
        body.scans.map((scan) => ({ passId: scan.passId, scannedAt: new Date(scan.scannedAt) })),
      );
      response.json(SyncAdmissionsResponse.parse({
        synced: result.synced,
        duplicates: result.duplicates.map((duplicate) => ({
          passId: duplicate.passId,
          admissions: duplicate.admissions.map((admission) => ({
            gateDeviceId: admission.gateDeviceId,
            scannedAt: admission.scannedAt.toISOString(),
          })),
        })),
      }));
    },
  );

  registerRoute(router, eventsRouteManifest.listAdmissions,
    requireEventRole(),
    validate({ params: EventIdAliasParams, query: AdmissionsQuery }),
    async (request: Request, response: Response) => {
      const { eventId } = EventIdAliasParams.parse(request.params);
      const query = AdmissionsQuery.parse(request.query);
      const page = await deps.service.listAdmissions(actor(request), eventId, query.cursor ?? 0, query.limit);
      response.json(AdmissionListResponse.parse({
        items: page.items.map((item) => ({
          id: item.id,
          passId: item.passId,
          gateDeviceId: item.gateDeviceId,
          scannedAt: item.scannedAt.toISOString(),
          scannedOffline: item.scannedOffline,
          duplicate: item.duplicate,
        })),
        nextCursor: page.nextCursor,
      }));
    },
  );

  registerRoute(router, eventsRouteManifest.listMyPasses,
    requireMember(),
    async (request: Request, response: Response) => {
      const passes = await deps.service.listMyPasses(memberPrincipal(request).memberId);
      response.json(PassListResponse.parse({ items: passes.map((pass) => passBody(pass)), nextCursor: null }));
    },
  );

  registerRoute(router, eventsRouteManifest.officerRevokePass,
    requireRole("OFFICER"),
    validate({ params: PassIdParams, body: OfficerRevokePassBody }),
    async (request: Request, response: Response) => {
      const { passId } = PassIdParams.parse(request.params);
      const body = OfficerRevokePassBody.parse(request.body);
      await deps.service.revokePass(passId, { memberId: memberPrincipal(request).memberId }, body.reason);
      response.status(204).send();
    },
  );

  return router;
}
function manifestBody(manifest: GateManifest) {
  return {
    eventId: manifest.eventId,
    endsAtEpoch: manifest.endsAtEpoch,
    publicKeys: manifest.publicKeys,
    passCount: manifest.passCount,
    revokedPassIds: manifest.revokedPassIds,
    generatedAt: manifest.generatedAt.toISOString(),
  };
}
