import { z } from "zod";

export const SessionClientSchema = z.enum(["WEB", "MOBILE"]);
export const PhoneE164 = z.string().regex(/^\+91[6-9]\d{9}$/u);
export const FamilyPublicId = z.string().regex(/^AGR-[1-9]\d{5}-\d{5}$/u);
export type SessionClientInput = z.infer<typeof SessionClientSchema>;

const FirebaseSessionRequest = z.object({
  firebaseIdToken: z.string().trim().min(1),
  client: SessionClientSchema,
}).strict();

const FixedOtpSessionRequest = z.object({
  phoneE164: PhoneE164,
  otp: z.string().regex(/^\d{6}$/u),
  client: z.literal("MOBILE"),
}).strict();

export const CreateSessionBody = z.union([
  FirebaseSessionRequest,
  FixedOtpSessionRequest,
]);

const PublicApplicantPrincipal = z.object({
  kind: z.literal("APPLICANT"),
  phoneE164: PhoneE164,
  registrationId: z.uuid(),
});

const PublicMemberPrincipal = z.object({
  kind: z.literal("MEMBER"),
  phoneE164: PhoneE164,
  memberId: z.uuid(),
  familyPublicId: FamilyPublicId,
  roles: z.array(z.enum(["OFFICER", "OPERATOR", "ORGANISER"])),
  isHead: z.boolean(),
});

export const Principal = z.discriminatedUnion("kind", [
  PublicApplicantPrincipal,
  PublicMemberPrincipal,
]);

export const PrincipalResponse = z.object({
  principal: Principal,
});

export const SessionResponse = z.object({
  principal: Principal,
  token: z.string().min(1).optional(),
});

export const AuthSessionRequest = CreateSessionBody;
export const AuthSessionResponse = SessionResponse;
export const MeResponse = PrincipalResponse;

export type PublicPrincipal = z.infer<typeof Principal>;
export type SessionResponseBody = z.infer<typeof SessionResponse>;
