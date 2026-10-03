import { Router, type Request, type Response } from "express";
import { requireHead, requireMember } from "../../http/auth.js";
import { AppError } from "../../http/errors.js";
import { validate } from "../../http/validate.js";
import {
  DirectorySearchQuery,
  FamilyPublicIdParams,
  InviteCodeParams,
  MemberIdParams,
  MessageIdParams,
  PatchMeBody,
  PostErasureBody,
  PutConsentsBody,
  PutFamilyPhotoBody,
  PutNomineeBody,
  PutPhotoBody,
} from "./schemas.js";
import type { RegisterService } from "./service.js";
import type { IdentityService } from "../identity/index.js";
import {
  defineRouteManifest,
  registerRoute,
} from "../../openapi/route-manifest.js";

export const registerRouteManifest = defineRouteManifest({
  getMe: { method: "get", path: "/v1/me" },
  updateMe: { method: "patch", path: "/v1/me" },
  updateConsents: { method: "put", path: "/v1/me/consents" },
  updateNominee: { method: "put", path: "/v1/me/nominee" },
  dismissNomineePrompt: { method: "post", path: "/v1/me/nominee-prompt/dismiss" },
  updateMemberPhoto: { method: "put", path: "/v1/me/photo" },
  readOfficerMessage: { method: "post", path: "/v1/me/officer-messages/:messageId/read" },
  requestErasure: { method: "post", path: "/v1/me/erasure" },
  getMyFamily: { method: "get", path: "/v1/families/mine" },
  updateFamilyPhoto: { method: "put", path: "/v1/families/mine/photo" },
  searchDirectoryMembers: { method: "get", path: "/v1/directory/members" },
  getDirectoryFamily: { method: "get", path: "/v1/directory/families/:publicId" },
  getDirectoryMember: { method: "get", path: "/v1/directory/members/:memberId" },
  createFamilyInvite: { method: "post", path: "/v1/families/mine/invites" },
  getInvite: { method: "get", path: "/v1/invites/:code" },
} as const);

export interface RegisterRouteDeps {
  readonly service: RegisterService;
  readonly webBaseUrl?: string;
  readonly erasureSelfServiceEnabled: boolean;
  readonly identityService?: Pick<IdentityService, "verifyAndConsumeOtp"> | undefined;
}

function memberIdFromRequest(request: Request): string {
  const principal = request.principal;
  if (principal?.kind !== "MEMBER") throw new AppError("UNAUTHENTICATED", 401);
  return principal.memberId;
}
function memberPhoneFromRequest(request: Request): string {
  const principal = request.principal;
  if (principal?.kind !== "MEMBER" || !principal.phoneE164) {
    throw new AppError("UNAUTHENTICATED", 401);
  }
  return principal.phoneE164;
}


function memberRolesFromRequest(request: Request): readonly string[] {
  const principal = request.principal;
  if (principal?.kind !== "MEMBER") throw new AppError("UNAUTHENTICATED", 401);
  return principal.roles;
}

export function createRegisterRoutes(deps: RegisterRouteDeps): Router {
  const router = Router();

  registerRoute(router, registerRouteManifest.getMe, requireMember(), async (request: Request, response: Response) => {
    const memberId = memberIdFromRequest(request);
    response.json(await deps.service.getMe(memberId, memberRolesFromRequest(request)));
  });

  registerRoute(router, registerRouteManifest.updateMe,
    requireMember(),
    validate({ body: PatchMeBody }),
    async (request: Request, response: Response) => {
      const memberId = memberIdFromRequest(request);
      const body = PatchMeBody.parse(request.body);
      await deps.service.updateMe(memberId, body);
      response.status(204).send();
    },
  );

  registerRoute(router, registerRouteManifest.updateConsents,
    requireMember(),
    validate({ body: PutConsentsBody }),
    async (request: Request, response: Response) => {
      await deps.service.updateConsents(memberIdFromRequest(request), PutConsentsBody.parse(request.body));
      response.status(204).send();
    },
  );

  registerRoute(router, registerRouteManifest.updateNominee,
    requireMember(),
    validate({ body: PutNomineeBody }),
    async (request: Request, response: Response) => {
      const body = PutNomineeBody.parse(request.body);
      await deps.service.setNominee(memberIdFromRequest(request), body.nomineeMemberId);
      response.status(204).send();
    },
  );

  registerRoute(router, registerRouteManifest.dismissNomineePrompt,
    requireMember(),
    async (request: Request, response: Response) => {
      await deps.service.dismissNomineePrompt(memberIdFromRequest(request));
      response.status(204).send();
    },
  );

  registerRoute(router, registerRouteManifest.updateMemberPhoto,
    requireMember(),
    validate({ body: PutPhotoBody }),
    async (request: Request, response: Response) => {
      const body = PutPhotoBody.parse(request.body);
      await deps.service.setMemberPhoto(memberIdFromRequest(request), body.imageId);
      response.status(204).send();
    },
  );

  registerRoute(router, registerRouteManifest.readOfficerMessage,
    requireMember(),
    validate({ params: MessageIdParams }),
    async (request: Request, response: Response) => {
      const { messageId } = MessageIdParams.parse(request.params);
      await deps.service.markOfficerMessageRead(memberIdFromRequest(request), messageId);
      response.status(204).send();
    },
  );

  registerRoute(router, registerRouteManifest.requestErasure,
    requireMember(),
    validate({ body: PostErasureBody }),
    async (request: Request, response: Response) => {
      const memberId = memberIdFromRequest(request);
      const body = PostErasureBody.parse(request.body) ?? {};
      if (deps.erasureSelfServiceEnabled) {
        if (body.otp === undefined) {
          throw new AppError("VALIDATION_FAILED", 400);
        }
        const phoneE164 = memberPhoneFromRequest(request);
        if (!deps.identityService) {
          throw new AppError("INTERNAL_ERROR", 500);
        }
        await deps.identityService.verifyAndConsumeOtp(phoneE164, body.otp);
        await deps.service.withTransaction((tx) => deps.service.eraseMember(tx, memberId, { kind: "SELF" }));
        response.clearCookie("sid");
        response.status(200).json({ status: "ERASED" });
        return;
      }
      const result = await deps.service.requestErasure(memberId, "MEMBER");
      response.status(result.httpStatus).json({ status: result.status });
    },
  );

  registerRoute(router, registerRouteManifest.getMyFamily, requireMember(), async (request: Request, response: Response) => {
    response.json(await deps.service.getFamilyForMember(memberIdFromRequest(request)));
  });

  registerRoute(router, registerRouteManifest.updateFamilyPhoto,
    requireHead(),
    validate({ body: PutFamilyPhotoBody }),
    async (request: Request, response: Response) => {
      const body = PutFamilyPhotoBody.parse(request.body);
      await deps.service.setFamilyPhoto(memberIdFromRequest(request), body.imageId);
      response.status(204).send();
    },
  );

  registerRoute(router, registerRouteManifest.searchDirectoryMembers,
    requireMember(),
    validate({ query: DirectorySearchQuery }),
    async (request: Request, response: Response) => {
      const input = DirectorySearchQuery.parse(request.query);
      response.json(await deps.service.searchDirectory(memberIdFromRequest(request), input));
    },
  );

  registerRoute(router, registerRouteManifest.getDirectoryFamily,
    requireMember(),
    validate({ params: FamilyPublicIdParams }),
    async (request: Request, response: Response) => {
      const { publicId } = FamilyPublicIdParams.parse(request.params);
      response.json(await deps.service.getDirectoryFamily(memberIdFromRequest(request), publicId));
    },
  );

  registerRoute(router, registerRouteManifest.getDirectoryMember,
    requireMember(),
    validate({ params: MemberIdParams }),
    async (request: Request, response: Response) => {
      const { memberId } = MemberIdParams.parse(request.params);
      response.json(await deps.service.getDirectoryMember(memberIdFromRequest(request), memberId));
    },
  );

  registerRoute(router, registerRouteManifest.createFamilyInvite,
    requireMember(),
    async (request: Request, response: Response) => {
      if (deps.webBaseUrl === undefined) throw new AppError("INTERNAL", 500);
      const result = await deps.service.createInvite(memberIdFromRequest(request), deps.webBaseUrl);
      response.status(201).json({ ...result, expiresAt: result.expiresAt.toISOString() });
    },
  );

  registerRoute(router, registerRouteManifest.getInvite,
    validate({ params: InviteCodeParams }),
    async (request: Request, response: Response) => {
      const { code } = InviteCodeParams.parse(request.params);
      const invite = await deps.service.lookupInvite(code);
      if (invite === null) throw new AppError("NOT_FOUND", 404);
      response.json(invite);
    },
  );


  return router;
}
