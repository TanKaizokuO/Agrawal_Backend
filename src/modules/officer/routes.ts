import { Router, type Request, type Response } from "express";
import { requireRole } from "../../http/auth.js";
import { AppError } from "../../http/errors.js";
import { validate } from "../../http/validate.js";
import {
  configuredRateLimit,
  type RateLimiter,
} from "../../http/rate-limit.js";
import {
  ArchivalRequestIdParams,
  ArchivalRequestsQuery,
  BloodSosIdParams,
  CloseBloodSosBody,
  EraseMemberBody,
  EraseMemberParams,
  ErasureRequestsQuery,
  FlagIdParams,
  FlagsQuery,
  ImageIdParams,
  MemberLookupQuery,
  NomineeReadBody,
  NomineeReadParams,
  OfficerImagesQuery,
  OperatorRoleBody,
  PaymentIdParams,
  ProcessingRecordQuery,
  RefundPaymentBody,
  RemoveImageBody,
  ReportsQuery,
  ResolveArchivalBody,
  ResolveFlagBody,
  SuspensionIdParams,
  SuspensionQuery,
  LiftSuspensionBody,
  UnarchiveParams,
} from "./schemas.js";
import type { OfficerService } from "./service.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";

export const officerRouteManifest = defineRouteManifest({
  listFlags: { method: "get", path: "/v1/officer/flags" },
  resolveFlag: { method: "post", path: "/v1/officer/flags/:id/resolve" },
  listErasureRequests: { method: "get", path: "/v1/officer/erasure-requests" },
  eraseMember: { method: "post", path: "/v1/officer/members/:memberId/erase" },
  lookupMembers: { method: "get", path: "/v1/officer/members" },
  listImages: { method: "get", path: "/v1/officer/images" },
  removeImage: { method: "post", path: "/v1/officer/images/:imageId/remove" },
  approveImage: { method: "post", path: "/v1/officer/images/:imageId/approve" },
  refundPayment: { method: "post", path: "/v1/officer/payments/:paymentId/refund" },
  listProcessingRecords: { method: "get", path: "/v1/officer/processing-record" },
  readNominee: { method: "post", path: "/v1/officer/members/:memberId/nominee-read" },
  unarchiveMember: { method: "post", path: "/v1/officer/members/:memberId/unarchive" },
  listSuspensions: { method: "get", path: "/v1/officer/suspensions" },
  liftSuspension: { method: "post", path: "/v1/officer/suspensions/:suspensionId/lift" },
  listArchivalRequests: { method: "get", path: "/v1/officer/archival-requests" },
  resolveArchival: {
    method: "post",
    path: "/v1/officer/archival-requests/:archivalRequestId/resolve",
  },
  listReports: { method: "get", path: "/v1/officer/reports" },
  closeBloodSos: { method: "post", path: "/v1/officer/blood-sos/:bloodSosId/close" },
  changeRole: { method: "post", path: "/v1/operator/roles" },
} as const);
export type OfficerRouteService = Pick<
  OfficerService,
  | "listFlags"
  | "resolveFlag"
  | "listErasureRequests"
  | "eraseMember"
  | "lookupMembers"
  | "listImages"
  | "removeImage"
  | "approveImage"
  | "refundPayment"
  | "listProcessingRecords"
  | "readNominee"
  | "unarchiveMember"
  | "listSuspensions"
  | "liftSuspension"
  | "listArchivalRequests"
  | "resolveArchival"
  | "listReports"
  | "closeBloodSos"
  | "changeRole"
>;

export interface OfficerRouteDeps {
  readonly service: OfficerRouteService;
  readonly rateLimiter?: RateLimiter;
}

function memberIdFromRequest(request: Request): string {
  const principal = request.principal;
  if (principal?.kind !== "MEMBER") throw new AppError("UNAUTHENTICATED", 401);
  return principal.memberId;
}

export function createOfficerRoutes(deps: OfficerRouteDeps): Router {
  const router = Router();
  const officerRateLimit = configuredRateLimit(deps.rateLimiter, {
    name: "officer.*",
    key: memberIdFromRequest,
    limit: 600,
    windowSeconds: 60 * 60,
  });
  router.use("/v1/officer", requireRole("OFFICER"), ...officerRateLimit);
  router.use("/v1/operator", requireRole("OPERATOR"), ...officerRateLimit);

  registerRoute(router, officerRouteManifest.listFlags,
    requireRole("OFFICER"),
    validate({ query: FlagsQuery }),
    async (request: Request, response: Response) => {
      response.json(await deps.service.listFlags(
        memberIdFromRequest(request),
        FlagsQuery.parse(request.query),
      ));
    },
  );

  registerRoute(router, officerRouteManifest.resolveFlag,
    requireRole("OFFICER"),
    validate({ params: FlagIdParams, body: ResolveFlagBody }),
    async (request: Request, response: Response) => {
      const { id } = FlagIdParams.parse(request.params);
      await deps.service.resolveFlag(
        id,
        memberIdFromRequest(request),
        ResolveFlagBody.parse(request.body),
      );
      response.status(204).send();
    },
  );

  registerRoute(router, officerRouteManifest.listErasureRequests,
    requireRole("OFFICER"),
    validate({ query: ErasureRequestsQuery }),
    async (request: Request, response: Response) => {
      response.json(await deps.service.listErasureRequests(
        memberIdFromRequest(request),
        ErasureRequestsQuery.parse(request.query),
      ));
    },
  );

  registerRoute(router, officerRouteManifest.eraseMember,
    requireRole("OFFICER"),
    validate({ params: EraseMemberParams, body: EraseMemberBody }),
    async (request: Request, response: Response) => {
      const { memberId } = EraseMemberParams.parse(request.params);
      await deps.service.eraseMember(
        memberId,
        memberIdFromRequest(request),
        EraseMemberBody.parse(request.body),
      );
      response.status(204).send();
    },
  );

  registerRoute(router, officerRouteManifest.lookupMembers,
    requireRole("OFFICER"),
    validate({ query: MemberLookupQuery }),
    async (request: Request, response: Response) => {
      response.json(await deps.service.lookupMembers(
        memberIdFromRequest(request),
        MemberLookupQuery.parse(request.query),
      ));
    },
  );

  registerRoute(router, officerRouteManifest.listImages,
    requireRole("OFFICER"),
    validate({ query: OfficerImagesQuery }),
    async (request: Request, response: Response) => {
      response.json(await deps.service.listImages(
        memberIdFromRequest(request),
        OfficerImagesQuery.parse(request.query),
      ));
    },
  );

  registerRoute(router, officerRouteManifest.removeImage,
    requireRole("OFFICER"),
    validate({ params: ImageIdParams, body: RemoveImageBody }),
    async (request: Request, response: Response) => {
      const { imageId } = ImageIdParams.parse(request.params);
      const body = RemoveImageBody.parse(request.body);
      await deps.service.removeImage(imageId, memberIdFromRequest(request), body.reason);
      response.status(204).send();
    },
  );

  registerRoute(router, officerRouteManifest.approveImage,
    requireRole("OFFICER"),
    validate({ params: ImageIdParams }),
    async (request: Request, response: Response) => {
      const { imageId } = ImageIdParams.parse(request.params);
      await deps.service.approveImage(imageId, memberIdFromRequest(request));
      response.status(204).send();
    },
  );

  registerRoute(router, officerRouteManifest.refundPayment,
    requireRole("OFFICER"),
    validate({ params: PaymentIdParams, body: RefundPaymentBody }),
    async (request: Request, response: Response) => {
      const { paymentId } = PaymentIdParams.parse(request.params);
      const body = RefundPaymentBody.parse(request.body);
      await deps.service.refundPayment(paymentId, memberIdFromRequest(request), body.reason);
      response.status(204).send();
    },
  );

  registerRoute(router, officerRouteManifest.listProcessingRecords,
    requireRole("OFFICER"),
    validate({ query: ProcessingRecordQuery }),
    async (request: Request, response: Response) => {
      response.json(await deps.service.listProcessingRecords(ProcessingRecordQuery.parse(request.query)));
    },
  );

  registerRoute(router, officerRouteManifest.readNominee,
    requireRole("OFFICER"),
    validate({ params: NomineeReadParams, body: NomineeReadBody }),
    async (request: Request, response: Response) => {
      const { memberId } = NomineeReadParams.parse(request.params);
      response.json(await deps.service.readNominee(
        memberId,
        memberIdFromRequest(request),
        NomineeReadBody.parse(request.body),
      ));
    },
  );

  registerRoute(router, officerRouteManifest.unarchiveMember,
    requireRole("OFFICER"),
    validate({ params: UnarchiveParams }),
    async (request: Request, response: Response) => {
      const { memberId } = UnarchiveParams.parse(request.params);
      response.json(await deps.service.unarchiveMember(memberId, memberIdFromRequest(request)));
    },
  );

  registerRoute(router, officerRouteManifest.listSuspensions,
    requireRole("OFFICER"),
    validate({ query: SuspensionQuery }),
    async (request: Request, response: Response) => {
      response.json(await deps.service.listSuspensions(SuspensionQuery.parse(request.query)));
    },
  );

  registerRoute(router, officerRouteManifest.liftSuspension,
    requireRole("OFFICER"),
    validate({ params: SuspensionIdParams, body: LiftSuspensionBody }),
    async (request: Request, response: Response) => {
      const { suspensionId } = SuspensionIdParams.parse(request.params);
      await deps.service.liftSuspension(
        suspensionId,
        memberIdFromRequest(request),
        LiftSuspensionBody.parse(request.body),
      );
      response.status(204).send();
    },
  );

  registerRoute(router, officerRouteManifest.listArchivalRequests,
    requireRole("OFFICER"),
    validate({ query: ArchivalRequestsQuery }),
    async (request: Request, response: Response) => {
      const query = ArchivalRequestsQuery.parse(request.query);
      response.json(await deps.service.listArchivalRequests({
        status: query.status,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      }));
    },
  );

  registerRoute(router, officerRouteManifest.resolveArchival,
    requireRole("OFFICER"),
    validate({ params: ArchivalRequestIdParams, body: ResolveArchivalBody }),
    async (request: Request, response: Response) => {
      const { archivalRequestId } = ArchivalRequestIdParams.parse(request.params);
      await deps.service.resolveArchival(
        archivalRequestId,
        memberIdFromRequest(request),
        ResolveArchivalBody.parse(request.body),
      );
      response.status(204).send();
    },
  );

  registerRoute(router, officerRouteManifest.listReports,
    requireRole("OFFICER"),
    validate({ query: ReportsQuery }),
    async (request: Request, response: Response) => {
      response.json(await deps.service.listReports(ReportsQuery.parse(request.query)));
    },
  );

  registerRoute(router, officerRouteManifest.closeBloodSos,
    requireRole("OFFICER"),
    validate({ params: BloodSosIdParams, body: CloseBloodSosBody }),
    async (request: Request, response: Response) => {
      const { bloodSosId } = BloodSosIdParams.parse(request.params);
      const body = CloseBloodSosBody.parse(request.body);
      await deps.service.closeBloodSos(bloodSosId, memberIdFromRequest(request), body.reason);
      response.status(204).send();
    },
  );

  registerRoute(router, officerRouteManifest.changeRole,
    requireRole("OPERATOR"),
    validate({ body: OperatorRoleBody }),
    async (request: Request, response: Response) => {
      await deps.service.changeRole(memberIdFromRequest(request), OperatorRoleBody.parse(request.body));
      response.status(204).send();
    },
  );

  return router;
}
