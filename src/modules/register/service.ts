// ---------------------------------------------------------------------------
// Register module — domain logic.
// ---------------------------------------------------------------------------
import { v7 as uuidv7 } from "uuid";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { AppError } from "../../http/errors.js";
import type { Clock } from "../../clock.js";
import type { PincodeDirectory, ObjectStore, Romanizer } from "../../adapters/ports.js";
import type { JobRuntime } from "../../jobs.js";
import type { ProcessingMetadata } from "../officer/index.js";
import type {
  Actor,
  BilingualName,
  BloodGroup,
  DonorRow,
  FamilyView,
  Gender,
  Gotra,
  IndianState,
  MeResponse,
  MemberAddress,
  MemberNativePlace,
  MemberProjection,
  MemberSuspensionView,
  OfficerMessageView,
  PatchMeInput,
  PutConsentsInput,
  ViewerRelation,
  DirectorySearchInput,
} from "./schemas.js";
import {
  PROJECTION_ALLOWLIST,
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Prisma transaction client — accepted by every function that operates in tx. */
type Tx = Prisma.TransactionClient;

export type ProcessingActor =
  | { readonly kind: "SYSTEM" }
  | { readonly kind: "MEMBER"; readonly id: string }
  | { readonly kind: "OFFICER"; readonly id: string };

export type RegisterProcessingAction =
  | "MEMBER_ERASED"
  | "ERASURE_REQUESTED"
  | "HEAD_SUCCEEDED"
  | "FAMILY_ARCHIVED"
  | "MEMBER_ARCHIVED"
  | "MEMBER_UNARCHIVED"
  | "NOMINEE_READ";

export interface RegisterProcessingRecordPort {
  write(
    tx: Tx,
    entry: {
      readonly action: RegisterProcessingAction;
      readonly subjectType: "MEMBER" | "FAMILY";
      readonly subjectId: string;
      readonly actor: ProcessingActor;
      readonly metadata?: ProcessingMetadata;
    },
  ): Promise<void>;
}

export interface NomineeReadAuthorizer {
  isArchivalRequestOpen(memberId: string, archivalRequestId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Cross-module ports — Register calls these; implementors are wired at boot.
// ---------------------------------------------------------------------------

export interface RegisterConfig {
  readonly retentionDaysPayments: number;
  readonly retentionDaysConsentAndLogs: number;
  readonly mediaUrlTtlSeconds: number;
  readonly erasureSelfServiceEnabled: boolean;
}

export interface PaymentsPort {
  moveToRestricted(tx: Tx, payerMemberId: string, retainUntil: Date): Promise<void>;
  releaseHeadAnchor(tx: Tx, familyId: string): Promise<void>;
}

export interface MediaPort {
  isVisibleToOthers(imageId: string): Promise<boolean>;
  presignUrl(imageId: string, ttlSeconds: number): Promise<string>;
  ownedBy(
    imageId: string,
    owner: { readonly memberId?: string; readonly familyId?: string },
    purpose: "MEMBER_PHOTO" | "FAMILY_PHOTO",
  ): Promise<boolean>;
}
export interface RegisterSuspensionResolver {
  resolveActiveSuspension(memberId: string): Promise<MemberSuspensionView | null>;
}

export type SuspensionResolver =
  | RegisterSuspensionResolver
  | ((memberId: string) => Promise<MemberSuspensionView | null>);

export interface RegisterDeps {
  readonly db: PrismaClient;
  readonly clock: Clock;
  readonly config: RegisterConfig;
  readonly pincodeDirectory: PincodeDirectory;
  readonly objectStore: ObjectStore;
  readonly jobs: JobRuntime;
  readonly payments: PaymentsPort;
  readonly suspensionResolver: SuspensionResolver;
  readonly media?: MediaPort;
  readonly romanizer?: Romanizer;
  readonly processingRecord?: RegisterProcessingRecordPort;
  readonly nomineeReadAuthorizer?: NomineeReadAuthorizer;
}


// ---------------------------------------------------------------------------
// Hook registries
// ---------------------------------------------------------------------------
type ErasureHook = (tx: Tx, memberId: string) => Promise<void>;
type ArchivalHook = (tx: Tx, memberId: string) => Promise<void>;

// ---------------------------------------------------------------------------
// Member creation input (used by Registration module)
// ---------------------------------------------------------------------------
export interface CreateMemberInput {
  readonly phoneE164: string;
  readonly nameEn: string | null;
  readonly nameHi: string | null;
  readonly nameEnSearchKey: string | null;
  readonly fatherNameEn: string | null;
  readonly fatherNameHi: string | null;
  readonly fatherNameEnSearchKey: string | null;
  readonly gender: Gender;
  readonly dateOfBirth: string;
  readonly bloodGroup: BloodGroup;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: IndianState;
  readonly pincode: string;
  readonly nativePlaceKind: "LISTED" | "OTHER" | "UNKNOWN";
  readonly nativePlaceId: string | null;
  readonly nativePlaceText: string | null;
  readonly kuldevi: string | null;
  readonly kuldevta: string | null;
  readonly photoImageId: string | null;
  readonly consentBloodGroup: boolean;
  readonly consentPhoto: boolean;
  readonly uiLanguage: string;
}

export interface CreateFamilyInput extends CreateMemberInput {
  readonly publicId: string;
  readonly pincodeSnapshot: string;
  readonly gotra: Gotra;
  readonly familyPhotoImageId: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeCityKey(city: string): string {
  return city.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

function dateOnlyToDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function isAdult(dateOfBirth: Date, todayIst: string): boolean {
  const birth = dateOfBirth.toISOString().slice(0, 10);
  const [birthYear, birthMonth, birthDay] = birth.split("-").map(Number);
  const [todayYear, todayMonth, todayDay] = todayIst.split("-").map(Number);
  if (
    birthYear === undefined || birthMonth === undefined || birthDay === undefined
    || todayYear === undefined || todayMonth === undefined || todayDay === undefined
  ) return false;
  let age = todayYear - birthYear;
  if (todayMonth < birthMonth || (todayMonth === birthMonth && todayDay < birthDay)) age--;
  return age >= 18;
}


/** Generate a 10-char Crockford Base32 invite code. */
function generateInviteCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) {
    code += alphabet.charAt(b % 32);
  }
  return code;
}

// ---------------------------------------------------------------------------
// RegisterService
// ---------------------------------------------------------------------------

export class RegisterService {
  private readonly db: PrismaClient;
  private readonly clock: Clock;
  private readonly config: RegisterConfig;
  private readonly pincodeDirectory: PincodeDirectory;
  private readonly objectStore: ObjectStore;
  private readonly jobs: JobRuntime;
  private readonly payments: PaymentsPort;
  private readonly media: MediaPort | undefined;
  private readonly romanizer: Romanizer | undefined;
  private readonly processingRecord: RegisterProcessingRecordPort | undefined;
  private readonly nomineeReadAuthorizer: NomineeReadAuthorizer | undefined;
  private readonly suspensionResolver: SuspensionResolver;
  private readonly erasureHooks: ErasureHook[] = [];
  private readonly archivalHooks: ArchivalHook[] = [];

  constructor(deps: RegisterDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.config = deps.config;
    this.pincodeDirectory = deps.pincodeDirectory;
    this.objectStore = deps.objectStore;
    this.jobs = deps.jobs;
    this.payments = deps.payments;
    this.media = deps.media;
    this.romanizer = deps.romanizer;
    this.processingRecord = deps.processingRecord;
    this.nomineeReadAuthorizer = deps.nomineeReadAuthorizer;
    if (
      typeof deps.suspensionResolver !== "function"
      && typeof deps.suspensionResolver.resolveActiveSuspension !== "function"
    ) {
      throw new Error("RegisterService requires suspensionResolver");
    }
    this.suspensionResolver = deps.suspensionResolver;
  }
  async withTransaction<T>(
    callback: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.db.$transaction(callback);
  }

  // -----------------------------------------------------------------------
  // Hook registration
  // -----------------------------------------------------------------------

  onMemberErased(handler: ErasureHook): void {
    this.erasureHooks.push(handler);
  }

  onMemberArchived(handler: ArchivalHook): void {
    this.archivalHooks.push(handler);
  }

  // -----------------------------------------------------------------------
  // Identity seam
  // -----------------------------------------------------------------------

  async memberPrincipalForPhone(
    phoneE164: string,
  ): Promise<{ memberId: string; status: "ACTIVE" | "ARCHIVED" } | null> {
    const member = await this.db.member.findUnique({
      where: { phoneE164 },
      select: { id: true, status: true },
    });
    if (!member) return null;
    return { memberId: member.id, status: member.status };
  }

  async isActiveMember(memberId: string): Promise<boolean> {
    const member = await this.db.member.findUnique({
      where: { id: memberId },
      select: { status: true },
    });
    return member?.status === "ACTIVE";
  }

  async isHeadOf(memberId: string): Promise<boolean> {
    const family = await this.db.family.findUnique({
      where: { headMemberId: memberId },
      select: { id: true },
    });
    return family !== null;
  }

  async familyOf(
    memberId: string,
  ): Promise<{ familyId: string; publicId: string; gotra: Gotra; headMemberId: string | null } | null> {
    const link = await this.db.familyLink.findUnique({
      where: { memberId },
      select: {
        family: {
          select: { id: true, publicId: true, gotra: true, headMemberId: true },
        },
      },
    });
    if (!link) return null;
    const f = link.family;
    return {
      familyId: f.id,
      publicId: f.publicId,
      gotra: f.gotra,
      headMemberId: f.headMemberId,
    };
  }

  async familyByPublicId(
    publicId: string,
  ): Promise<{ id: string; gotra: Gotra; status: string } | null> {
    const family = await this.db.family.findUnique({
      where: { publicId },
      select: { id: true, gotra: true, status: true },
    });
    if (!family) return null;
    return { id: family.id, gotra: family.gotra, status: family.status };
  }

  // -----------------------------------------------------------------------
  // Creating Members — called by Registration only
  // -----------------------------------------------------------------------

  async createFamilyWithHead(
    tx: Tx,
    input: CreateFamilyInput,
  ): Promise<{ familyId: string; memberId: string }> {
    const existingPhone = await tx.member.findUnique({
      where: { phoneE164: input.phoneE164 },
      select: { id: true },
    });
    if (existingPhone) throw new AppError("PHONE_ALREADY_REGISTERED", 409);
    const dateOfBirth = dateOnlyToDate(input.dateOfBirth);
    if (!isAdult(dateOfBirth, this.clock.todayIst())) throw new AppError("NOT_ADULT", 422);
    const memberId = uuidv7();
    const familyId = uuidv7();
    const now = this.clock.now();
    const cityKey = computeCityKey(input.city);

    // Look up district from pincode
    const district = await this.lookupDistrict(input.pincode, tx);

    await tx.family.create({
      data: {
        id: familyId,
        publicId: input.publicId,
        gotra: input.gotra,
        pincodeSnapshot: input.pincodeSnapshot,
        headMemberId: memberId,
        status: "ACTIVE",
        photoImageId: input.familyPhotoImageId,
        createdAt: now,
      },
    });

    await tx.member.create({
      data: {
        id: memberId,
        phoneE164: input.phoneE164,
        status: "ACTIVE",
        nameEn: input.nameEn,
        nameHi: input.nameHi,
        nameEnSearchKey: input.nameEnSearchKey,
        fatherNameEn: input.fatherNameEn,
        fatherNameHi: input.fatherNameHi,
        fatherNameEnSearchKey: input.fatherNameEnSearchKey,
        gender: input.gender,
        dateOfBirth,
        bloodGroup: input.bloodGroup,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        cityKey,
        district,
        state: input.state,
        pincode: input.pincode,
        nativePlaceKind: input.nativePlaceKind,
        nativePlaceId: input.nativePlaceId,
        nativePlaceText: input.nativePlaceText,
        kuldevi: input.kuldevi,
        kuldevta: input.kuldevta,
        photoImageId: input.photoImageId,
        consentDirectory: true,
        consentBloodGroup: input.consentBloodGroup,
        consentPhoto: input.consentPhoto,
        paymentDisclosureAckAt: now,
        uiLanguage: input.uiLanguage,
        createdAt: now,
      },
    });

    await tx.familyLink.create({
      data: { memberId, familyId, kind: "BIRTH", createdAt: now },
    });

    // Record initial consent events
    await this.recordInitialConsents(tx, memberId, input, now);

    // If district lookup failed, enqueue a background fill job
    if (district === null) {
      await this.jobs.send("register.fillDistrict", { memberId, pincode: input.pincode });
    }

    return { familyId, memberId };
  }

  async createMemberInFamily(
    tx: Tx,
    familyId: string,
    input: CreateMemberInput,
  ): Promise<{ memberId: string }> {
    const family = await tx.family.findUnique({
      where: { id: familyId },
      select: { status: true },
    });
    if (!family) throw new AppError("FAMILY_NOT_FOUND", 404);
    if (family.status !== "ACTIVE") throw new AppError("FAMILY_NOT_ACCEPTING_JOINS", 409);

    const existingPhone = await tx.member.findUnique({
      where: { phoneE164: input.phoneE164 },
      select: { id: true },
    });
    if (existingPhone) throw new AppError("PHONE_ALREADY_REGISTERED", 409);
    const dateOfBirth = dateOnlyToDate(input.dateOfBirth);
    if (!isAdult(dateOfBirth, this.clock.todayIst())) throw new AppError("NOT_ADULT", 422);
    const memberId = uuidv7();
    const now = this.clock.now();
    const cityKey = computeCityKey(input.city);
    const district = await this.lookupDistrict(input.pincode, tx);

    await tx.member.create({
      data: {
        id: memberId,
        phoneE164: input.phoneE164,
        status: "ACTIVE",
        nameEn: input.nameEn,
        nameHi: input.nameHi,
        nameEnSearchKey: input.nameEnSearchKey,
        fatherNameEn: input.fatherNameEn,
        fatherNameHi: input.fatherNameHi,
        fatherNameEnSearchKey: input.fatherNameEnSearchKey,
        gender: input.gender,
        dateOfBirth,
        bloodGroup: input.bloodGroup,
        addressLine1: input.addressLine1,
        addressLine2: input.addressLine2,
        city: input.city,
        cityKey,
        district,
        state: input.state,
        pincode: input.pincode,
        nativePlaceKind: input.nativePlaceKind,
        nativePlaceId: input.nativePlaceId,
        nativePlaceText: input.nativePlaceText,
        kuldevi: input.kuldevi,
        kuldevta: input.kuldevta,
        photoImageId: input.photoImageId,
        consentDirectory: true,
        consentBloodGroup: input.consentBloodGroup,
        consentPhoto: input.consentPhoto,
        paymentDisclosureAckAt: now,
        uiLanguage: input.uiLanguage,
        createdAt: now,
      },
    });

    await tx.familyLink.create({
      data: { memberId, familyId, kind: "BIRTH", createdAt: now },
    });

    await this.recordInitialConsents(tx, memberId, input, now);

    if (district === null) {
      await this.jobs.send("register.fillDistrict", { memberId, pincode: input.pincode });
    }

    return { memberId };
  }

  async onFamilyGainedMember(tx: Tx, familyId: string): Promise<void> {
    const activeLinks = await tx.familyLink.findMany({
      where: {
        familyId,
        member: { status: "ACTIVE" },
      },
      select: { memberId: true },
    });
    if (activeLinks.length >= 2) {
      // Prompt every member who has no nominee set
      const memberIds = activeLinks.map((l) => l.memberId);
      await tx.member.updateMany({
        where: {
          id: { in: memberIds },
          nomineeMemberId: null,
          nomineePromptPending: false,
        },
        data: { nomineePromptPending: true },
      });
    }
  }

  // -----------------------------------------------------------------------
  // Visibility projections (invariants 16, 20, 22)
  // -----------------------------------------------------------------------

  async project(
    viewerMemberId: string,
    memberIds: readonly string[],
  ): Promise<Map<string, MemberProjection>> {
    if (memberIds.length === 0) return new Map();

    const members = await this.db.member.findMany({
      where: { id: { in: [...memberIds] } },
      include: {
        link: {
          select: {
            familyId: true,
            family: {
              select: {
                publicId: true, gotra: true, headMemberId: true,
              },
            },
          },
        },
      },
    });

    // Determine viewer's family
    const viewerLink = await this.db.familyLink.findUnique({
      where: { memberId: viewerMemberId },
      select: { familyId: true },
    });
    const viewerFamilyId = viewerLink?.familyId ?? null;

    const result = new Map<string, MemberProjection>();
    for (const m of members) {
      const relation = this.computeRelation(viewerMemberId, viewerFamilyId, m.id, m.link?.familyId ?? null);

      if (m.status === "ARCHIVED" && relation !== "SELF") {
        result.set(m.id, {
          memberId: m.id,
          familyPublicId: m.link?.family.publicId ?? "",
          isHead: false,
          name: { en: m.nameEn, hi: m.nameHi },
          ...(m.link?.family.gotra === undefined ? {} : { gotra: m.link.family.gotra }),
          deceased: true,
        });
        continue;
      }

      const projection = await this.buildProjection(m, relation);
      result.set(m.id, projection);
    }

    return result;
  }

  private computeRelation(
    viewerId: string,
    viewerFamilyId: string | null,
    subjectId: string,
    subjectFamilyId: string | null,
  ): ViewerRelation {
    if (viewerId === subjectId) return "SELF";
    if (viewerFamilyId !== null && viewerFamilyId === subjectFamilyId) return "FAMILY";
    return "SAMAJ";
  }
  private async buildProjection(
    m: MemberWithLink,
    relation: ViewerRelation,
  ): Promise<MemberProjection> {
    const allowedFields = PROJECTION_ALLOWLIST[relation];
    const familyPublicId = m.link?.family.publicId ?? "";
    const gotra = m.link?.family.gotra;
    const isHead = m.link?.family.headMemberId === m.id;
    const photo = allowedFields.includes("photoUrl")
      ? await this.resolvePhotoUrl(m, relation)
      : undefined;

    return {
      memberId: m.id,
      familyPublicId,
      isHead,
      ...(allowedFields.includes("name")
        ? { name: { en: m.nameEn, hi: m.nameHi } satisfies BilingualName }
        : {}),
      ...(allowedFields.includes("gotra") && gotra !== undefined ? { gotra } : {}),
      ...(allowedFields.includes("city") ? { city: m.city } : {}),
      ...(allowedFields.includes("state") ? { state: m.state } : {}),
      ...(photo === undefined
        ? {}
        : {
            photoUrl: photo.url,
            ...(photo.status === undefined ? {} : { photoStatus: photo.status }),
          }),
      ...(allowedFields.includes("phoneE164") ? { phoneE164: m.phoneE164 } : {}),
      ...(allowedFields.includes("fatherOrHusbandName")
        ? {
            fatherOrHusbandName: {
              en: m.fatherNameEn,
              hi: m.fatherNameHi,
            } satisfies BilingualName,
          }
        : {}),
      ...(allowedFields.includes("gender") ? { gender: m.gender } : {}),
      ...(allowedFields.includes("dateOfBirth")
        ? { dateOfBirth: m.dateOfBirth.toISOString().slice(0, 10) }
        : {}),
      ...(allowedFields.includes("bloodGroup") ? { bloodGroup: m.bloodGroup } : {}),
      ...(allowedFields.includes("address")
        ? {
            address: {
              line1: m.addressLine1,
              line2: m.addressLine2,
              pincode: m.pincode,
              district: m.district,
            } satisfies MemberAddress,
          }
        : {}),
      ...(allowedFields.includes("nativePlace")
        ? {
            nativePlace: {
              kind: m.nativePlaceKind,
              id: m.nativePlaceId,
              text: m.nativePlaceText,
            } satisfies MemberNativePlace,
          }
        : {}),
      ...(allowedFields.includes("kuldevi") ? { kuldevi: m.kuldevi } : {}),
      ...(allowedFields.includes("kuldevta") ? { kuldevta: m.kuldevta } : {}),
      ...(allowedFields.includes("nominee")
        ? { nominee: { memberId: m.nomineeMemberId } }
        : {}),
      ...(allowedFields.includes("consents")
        ? {
            consents: {
              directory: m.consentDirectory,
              bloodGroupMatching: m.consentBloodGroup,
              photoVisible: m.consentPhoto,
            },
          }
        : {}),
    };
  }

  private async resolvePhotoUrl(
    m: { photoImageId: string | null; consentPhoto: boolean },
    relation: ViewerRelation,
  ): Promise<{ url: string | null; status?: "UNSCREENED" }> {
    if (!m.photoImageId) return { url: null };
    if (relation === "SELF") {
      const url = await this.presignPhoto(m.photoImageId);
      if (!this.media || !(await this.media.isVisibleToOthers(m.photoImageId))) {
        return { url, status: "UNSCREENED" };
      }
      return { url };
    }
    if (!m.consentPhoto || !this.media) return { url: null };
    if (!(await this.media.isVisibleToOthers(m.photoImageId))) return { url: null };
    return {
      url: await this.media.presignUrl(m.photoImageId, this.config.mediaUrlTtlSeconds),
    };
  }


  private async presignPhoto(imageId: string): Promise<string> {
    if (this.media) {
      return this.media.presignUrl(imageId, this.config.mediaUrlTtlSeconds);
    }
    return this.objectStore.presignGet(imageId, this.config.mediaUrlTtlSeconds);
  }

  // -----------------------------------------------------------------------
  // /v1/me
  // -----------------------------------------------------------------------

  async getMe(
    memberId: string,
    roles: readonly string[],
  ): Promise<MeResponse> {
    const member = await this.db.member.findUnique({
      where: { id: memberId },
      include: {
        link: {
          select: {
            familyId: true,
            family: {
              select: {
                publicId: true, gotra: true, headMemberId: true,
                _count: { select: { links: true } },
              },
            },
          },
        },
      },
    });
    if (!member) throw new AppError("MEMBER_NOT_FOUND", 404);

    const selfProjection = await this.buildProjection(member, "SELF");

    const family = member.link?.family;
    const officerMessages = await this.db.officerMessage.findMany({
      where: { memberId },
      orderBy: [{ readAt: "asc" }, { createdAt: "desc" }],
    });

    const erasureRequest = await this.db.erasureRequest.findFirst({
      where: { memberId, status: { in: ["PENDING", "EXECUTED"] } },
      orderBy: { requestedAt: "desc" },
      select: { status: true },
    });


    const suspension = typeof this.suspensionResolver === "function"
      ? await this.suspensionResolver(memberId)
      : await this.suspensionResolver.resolveActiveSuspension(memberId);

    return {
      self: selfProjection,
      family: {
        publicId: family?.publicId ?? "",
        gotra: family?.gotra ?? "GARG",
        isHead: family?.headMemberId === memberId,
        memberCount: family?._count.links ?? 0,
      },
      roles: [...roles],
      prompts: { nominee: member.nomineePromptPending },
      officerMessages: officerMessages.map((m) => ({
        id: m.id,
        kind: m.kind,
        reason: m.reason,
        createdAt: m.createdAt.toISOString(),
        readAt: m.readAt?.toISOString() ?? null,
      } satisfies OfficerMessageView)),
      erasureRequest: erasureRequest ? { status: erasureRequest.status } : null,
      suspension: suspension ? {
        endsAt: suspension.endsAt,
        reason: suspension.reason,
        noticeId: suspension.noticeId ?? null,
      } : null,
    };
  }

  // -----------------------------------------------------------------------
  // PATCH /v1/me
  // -----------------------------------------------------------------------

  async updateMe(memberId: string, input: PatchMeInput): Promise<void> {
    const update: Prisma.MemberUpdateInput = {};

    if (input.name !== undefined) {
      const nameEn = input.nameEnConfirmed === false ? null : (input.name.en ?? null);
      update.nameEn = nameEn;
      update.nameHi = input.name.hi ?? null;
      update.nameEnSearchKey = await this.searchKeyForName(input.name.hi, nameEn);
    }
    if (input.fatherOrHusbandName !== undefined) {
      const fatherNameEn = input.fatherOrHusbandName.en ?? null;
      update.fatherNameEn = fatherNameEn;
      update.fatherNameHi = input.fatherOrHusbandName.hi ?? null;
      update.fatherNameEnSearchKey = await this.searchKeyForName(
        input.fatherOrHusbandName.hi,
        fatherNameEn,
      );
    }
    if (input.gender !== undefined) update.gender = input.gender;
    if (input.dateOfBirth !== undefined) {
      const dateOfBirth = dateOnlyToDate(input.dateOfBirth);
      if (!isAdult(dateOfBirth, this.clock.todayIst())) {
        throw new AppError("NOT_ADULT", 422);
      }
      update.dateOfBirth = dateOfBirth;
    }
    if (input.bloodGroup !== undefined) update.bloodGroup = input.bloodGroup;
    if (input.address !== undefined) {
      update.addressLine1 = input.address.line1;
      update.addressLine2 = input.address.line2 ?? null;
      update.city = input.address.city;
      update.cityKey = computeCityKey(input.address.city);
      update.state = input.address.state;
      update.pincode = input.address.pincode;
      const district = await this.lookupDistrict(input.address.pincode);
      update.district = district;
      if (district === null) {
        await this.jobs.send("register.fillDistrict", { memberId, pincode: input.address.pincode });
      }
    }
    if (input.nativePlace !== undefined) {
      update.nativePlaceKind = input.nativePlace.kind;
      if (input.nativePlace.kind === "LISTED") {
        update.nativePlaceId = input.nativePlace.id;
        update.nativePlaceText = null;
      } else if (input.nativePlace.kind === "OTHER") {
        update.nativePlaceId = null;
        update.nativePlaceText = input.nativePlace.text;
      } else {
        update.nativePlaceId = null;
        update.nativePlaceText = null;
      }
    }
    if (input.kuldevi !== undefined) update.kuldevi = input.kuldevi;
    if (input.kuldevta !== undefined) update.kuldevta = input.kuldevta;
    if (input.uiLanguage !== undefined) update.uiLanguage = input.uiLanguage;

    if (Object.keys(update).length > 0) {
      await this.db.member.update({ where: { id: memberId }, data: update });
    }
  }

  // -----------------------------------------------------------------------
  // Consents
  // -----------------------------------------------------------------------

  async updateConsents(memberId: string, input: PutConsentsInput): Promise<void> {
    const member = await this.db.member.findUnique({
      where: { id: memberId },
      select: { consentBloodGroup: true, consentPhoto: true },
    });
    if (!member) throw new AppError("MEMBER_NOT_FOUND", 404);

    const now = this.clock.now();
    const events: Array<{ toggle: "BLOOD_GROUP" | "PHOTO"; value: boolean }> = [];
    const update: Prisma.MemberUpdateInput = {};

    if (input.bloodGroupMatching !== member.consentBloodGroup) {
      events.push({ toggle: "BLOOD_GROUP", value: input.bloodGroupMatching });
      update.consentBloodGroup = input.bloodGroupMatching;
    }
    if (input.photoVisible !== member.consentPhoto) {
      events.push({ toggle: "PHOTO", value: input.photoVisible });
      update.consentPhoto = input.photoVisible;
    }

    if (events.length === 0) return;

    await this.db.$transaction(async (tx) => {
      for (const event of events) {
        await tx.consentEvent.create({
          data: {
            id: uuidv7(),
            memberId,
            toggle: event.toggle,
            value: event.value,
            source: "MEMBER",
            at: now,
          },
        });
      }
      await tx.member.update({ where: { id: memberId }, data: update });
    });
  }

  // -----------------------------------------------------------------------
  // Nominee
  // -----------------------------------------------------------------------

  async setNominee(memberId: string, nomineeMemberId: string | null): Promise<void> {
    const subject = await this.db.member.findUnique({
      where: { id: memberId },
      select: { status: true },
    });
    if (!subject) throw new AppError("MEMBER_NOT_FOUND", 404);
    if (subject.status !== "ACTIVE") throw new AppError("FORBIDDEN", 403);

    if (nomineeMemberId === memberId) {
      throw new AppError("NOMINEE_IS_SELF", 422);
    }

    if (nomineeMemberId !== null) {
      const memberFamily = await this.familyOf(memberId);
      if (!memberFamily) throw new AppError("MEMBER_NOT_FOUND", 404);

      const nomineeLink = await this.db.familyLink.findUnique({
        where: { memberId: nomineeMemberId },
        select: {
          familyId: true,
          member: { select: { status: true } },
        },
      });
      if (!nomineeLink || nomineeLink.familyId !== memberFamily.familyId) {
        throw new AppError("NOMINEE_NOT_IN_FAMILY", 422);
      }
      if (nomineeLink.member.status !== "ACTIVE") {
        throw new AppError("NOMINEE_NOT_IN_FAMILY", 422);
      }
    }

    await this.db.member.update({
      where: { id: memberId },
      data: {
        nomineeMemberId,
        nomineePromptPending: false,
      },
    });
  }

  async dismissNomineePrompt(memberId: string): Promise<void> {
    await this.db.member.update({
      where: { id: memberId },
      data: { nomineePromptPending: false },
    });
  }

  // -----------------------------------------------------------------------
  // Photo
  // -----------------------------------------------------------------------

  async setMemberPhoto(memberId: string, imageId: string | null): Promise<void> {
    if (imageId !== null) await this.assertPhotoOwned(imageId, { memberId }, "MEMBER_PHOTO");
    await this.db.member.update({
      where: { id: memberId },
      data: { photoImageId: imageId },
    });
  }

  async setFamilyPhoto(memberId: string, imageId: string | null): Promise<void> {
    const family = await this.familyOf(memberId);
    if (!family) throw new AppError("MEMBER_NOT_FOUND", 404);
    if (family.headMemberId !== memberId) {
      throw new AppError("NOT_HEAD", 403);
    }
    if (imageId !== null) {
      await this.assertPhotoOwned(imageId, { memberId, familyId: family.familyId }, "FAMILY_PHOTO");
    }
    await this.db.family.update({
      where: { id: family.familyId },
      data: { photoImageId: imageId },
    });
  }

  private async assertPhotoOwned(
    imageId: string,
    owner: { readonly memberId?: string; readonly familyId?: string },
    purpose: "MEMBER_PHOTO" | "FAMILY_PHOTO",
  ): Promise<void> {
    if (!this.media || !(await this.media.ownedBy(imageId, owner, purpose))) {
      throw new AppError("IMAGE_NOT_OWNED", 422);
    }
  }

  // -----------------------------------------------------------------------
  // Officer messages
  // -----------------------------------------------------------------------

  async postOfficerMessage(
    tx: Tx,
    memberId: string,
    kind: string,
    reason: string,
  ): Promise<void> {
    await tx.officerMessage.create({
      data: {
        id: uuidv7(),
        memberId,
        kind,
        reason,
        createdAt: this.clock.now(),
      },
    });
  }

  async markOfficerMessageRead(memberId: string, messageId: string): Promise<void> {
    await this.db.officerMessage.updateMany({
      where: { id: messageId, memberId, readAt: null },
      data: { readAt: this.clock.now() },
    });
  }

  // -----------------------------------------------------------------------
  // Erasure request
  // -----------------------------------------------------------------------

  async requestErasure(
    memberId: string,
    source: string,
  ): Promise<{ status: string; httpStatus: number }> {
    const existing = await this.db.erasureRequest.findFirst({
      where: { memberId, status: "PENDING" },
    });
    if (existing) return { status: "PENDING", httpStatus: 202 };

    const now = this.clock.now();
    await this.db.$transaction(async (tx) => {
      await tx.erasureRequest.create({
        data: {
          id: uuidv7(),
          memberId,
          source,
          status: "PENDING",
          requestedAt: now,
        },
      });
      await this.writeProcessing(tx, {
        action: "ERASURE_REQUESTED",
        subjectType: "MEMBER",
        subjectId: memberId,
        actor: { kind: "MEMBER", id: memberId },
      });
    });
    return { status: "PENDING", httpStatus: 202 };
  }

  // -----------------------------------------------------------------------
  // Erasure execution (invariant 17)
  // -----------------------------------------------------------------------

  async eraseMember(
    tx: Tx,
    memberId: string,
    actor: Actor,
    erasureRequestId?: string,
  ): Promise<void> {
    if (erasureRequestId !== undefined) {
      const request = await tx.erasureRequest.findFirst({
        where: { id: erasureRequestId, memberId, status: "PENDING" },
        select: { id: true },
      });
      if (request === null) throw new AppError("FORBIDDEN", 403);
    }
    const members = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM member WHERE id = ${memberId} FOR UPDATE
    `;
    if (members.length === 0) throw new AppError("MEMBER_NOT_FOUND", 404);

    const familyRows = await tx.$queryRaw<Array<{
      family_id: string;
      head_member_id: string | null;
    }>>`
      SELECT fl.family_id, f.head_member_id
      FROM family_link fl
      JOIN family f ON f.id = fl.family_id
      WHERE fl.member_id = ${memberId}
      FOR UPDATE OF fl, f
    `;
    const family = familyRows[0];
    if (family?.head_member_id === memberId) {
      await this.succeedHead(tx, family.family_id, memberId);
    }

    await tx.member.updateMany({
      where: { nomineeMemberId: memberId },
      data: { nomineeMemberId: null, nomineePromptPending: true },
    });
    await tx.invite.deleteMany({ where: { createdBy: memberId } });

    for (const hook of this.erasureHooks) await hook(tx, memberId);

    const now = this.clock.now();
    const paymentRetainUntil = addDays(now, this.config.retentionDaysPayments);
    const consentRetainUntil = addDays(now, this.config.retentionDaysConsentAndLogs);
    const retainUntil = paymentRetainUntil.getTime() > consentRetainUntil.getTime()
      ? paymentRetainUntil
      : consentRetainUntil;

    await this.payments.moveToRestricted(tx, memberId, paymentRetainUntil);

    const consentEvents = await tx.consentEvent.findMany({ where: { memberId } });
    for (const event of consentEvents) {
      await tx.$executeRaw`
        INSERT INTO restricted.consent_event
          (id, member_id, toggle, value, source, at, retain_until)
        VALUES
          (${event.id}, ${event.memberId}, ${event.toggle}, ${event.value},
           ${event.source}, ${event.at}, ${consentRetainUntil})
      `;
    }
    await tx.consentEvent.deleteMany({ where: { memberId } });

    await tx.$executeRaw`
      INSERT INTO restricted.member_tombstone (member_id, erased_at, retain_until)
      VALUES (${memberId}, ${now}, ${retainUntil})
    `;

    await tx.familyLink.deleteMany({ where: { memberId } });
    await tx.officerMessage.deleteMany({ where: { memberId } });
    await tx.member.delete({ where: { id: memberId } });

    const executedBy = actor.kind === "SELF"
      ? "SELF"
      : actor.kind === "OFFICER"
        ? `OFFICER:${actor.officerId}`
        : actor.memberId;
    if (erasureRequestId === undefined) {
      await tx.erasureRequest.updateMany({
        where: { memberId, status: "PENDING" },
        data: { status: "EXECUTED", executedAt: now, executedBy },
      });
    } else {
      await tx.erasureRequest.update({
        where: { id: erasureRequestId },
        data: { status: "EXECUTED", executedAt: now, executedBy },
      });
    }
    await this.writeProcessing(tx, {
      action: "MEMBER_ERASED",
      subjectType: "MEMBER",
      subjectId: memberId,
      actor: actor.kind === "SELF"
        ? { kind: "MEMBER", id: memberId }
        : actor.kind === "OFFICER"
          ? { kind: "OFFICER", id: actor.officerId }
          : { kind: "MEMBER", id: actor.memberId },
      ...(erasureRequestId === undefined ? {} : { metadata: { erasureRequestId } }),
    });
  }

  // -----------------------------------------------------------------------
  // Head succession (invariant 5)
  // -----------------------------------------------------------------------

  private async succeedHead(
    tx: Tx,
    familyId: string,
    departingHeadId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM family WHERE id = ${familyId} FOR UPDATE`;

    const candidates = await tx.familyLink.findMany({
      where: {
        familyId,
        memberId: { not: departingHeadId },
        member: { status: "ACTIVE" },
      },
      select: {
        memberId: true,
        createdAt: true,
        member: { select: { dateOfBirth: true } },
      },
    });

    if (candidates.length === 0) {
      await tx.family.update({
        where: { id: familyId },
        data: {
          headMemberId: null,
          status: "ARCHIVED",
          archivedAt: this.clock.now(),
        },
      });
      await this.payments.releaseHeadAnchor(tx, familyId);
      await this.writeProcessing(tx, {
        action: "FAMILY_ARCHIVED",
        subjectType: "FAMILY",
        subjectId: familyId,
        actor: { kind: "SYSTEM" },
        metadata: { departingHeadId },
      });
      return;
    }

    const departingHead = await tx.member.findUnique({
      where: { id: departingHeadId },
      select: { nomineeMemberId: true },
    });
    const nomineeCandidate = departingHead?.nomineeMemberId === null
      ? undefined
      : candidates.find((candidate) => candidate.memberId === departingHead?.nomineeMemberId);

    let successorId: string;
    if (nomineeCandidate !== undefined) {
      successorId = nomineeCandidate.memberId;
    } else {
      const sorted = [...candidates].sort((a, b) => {
        const ageOrder = a.member.dateOfBirth.getTime() - b.member.dateOfBirth.getTime();
        return ageOrder !== 0 ? ageOrder : a.createdAt.getTime() - b.createdAt.getTime();
      });
      const oldest = sorted[0];
      if (oldest === undefined) throw new AppError("INTERNAL", 500);
      successorId = oldest.memberId;
    }

    await tx.family.update({
      where: { id: familyId },
      data: { headMemberId: successorId },
    });
    await this.writeProcessing(tx, {
      action: "HEAD_SUCCEEDED",
      subjectType: "FAMILY",
      subjectId: familyId,
      actor: { kind: "SYSTEM" },
      metadata: { departingHeadId, successorId },
    });
  }

  // -----------------------------------------------------------------------
  async archiveMember(
    tx: Tx,
    memberId: string,
    confirmedBy: Actor,
  ): Promise<void> {
    const lockedMember = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM member WHERE id = ${memberId} FOR UPDATE
    `;
    if (lockedMember.length === 0) throw new AppError("MEMBER_NOT_FOUND", 404);
    const member = await tx.member.findUnique({
      where: { id: memberId },
      select: { status: true },
    });
    if (!member) throw new AppError("MEMBER_NOT_FOUND", 404);
    if (member.status === "ARCHIVED") return;

    const now = this.clock.now();
    const archivedBy = confirmedBy.kind === "OFFICER"
      ? `OFFICER:${confirmedBy.officerId}`
      : confirmedBy.kind === "MEMBER"
        ? confirmedBy.memberId
        : "SELF";

    const link = await tx.familyLink.findUnique({
      where: { memberId },
      select: {
        familyId: true,
        family: { select: { headMemberId: true } },
      },
    });
    if (!link) throw new AppError("FAMILY_NOT_FOUND", 404);
    if (link.family.headMemberId === memberId) {
      await this.succeedHead(tx, link.familyId, memberId);
    }

    await tx.member.update({
      where: { id: memberId },
      data: { status: "ARCHIVED", archivedAt: now, archivedBy },
    });
    await tx.member.updateMany({
      where: { nomineeMemberId: memberId },
      data: { nomineeMemberId: null, nomineePromptPending: true },
    });
    for (const hook of this.archivalHooks) await hook(tx, memberId);

    await this.writeProcessing(tx, {
      action: "MEMBER_ARCHIVED",
      subjectType: "MEMBER",
      subjectId: memberId,
      actor: confirmedBy.kind === "OFFICER"
        ? { kind: "OFFICER", id: confirmedBy.officerId }
        : confirmedBy.kind === "MEMBER"
          ? { kind: "MEMBER", id: confirmedBy.memberId }
          : { kind: "MEMBER", id: memberId },
    });
  }

  async unarchiveMember(
    tx: Tx,
    memberId: string,
    officerId: string,
  ): Promise<{ successionReverted: false }> {
    const member = await tx.member.findUnique({
      where: { id: memberId },
      select: { status: true },
    });
    if (!member) throw new AppError("MEMBER_NOT_FOUND", 404);
    if (member.status === "ACTIVE") return { successionReverted: false };
    await tx.member.update({
      where: { id: memberId },
      data: { status: "ACTIVE", archivedAt: null, archivedBy: null },
    });
    await this.writeProcessing(tx, {
      action: "MEMBER_UNARCHIVED",
      subjectType: "MEMBER",
      subjectId: memberId,
      actor: { kind: "OFFICER", id: officerId },
    });
    return { successionReverted: false };
  }

  // -----------------------------------------------------------------------
  // Family view
  // -----------------------------------------------------------------------

  async getFamilyForMember(
    viewerMemberId: string,
  ): Promise<{ family: FamilyView; members: MemberProjection[] }> {
    const viewerLink = await this.db.familyLink.findUnique({
      where: { memberId: viewerMemberId },
      select: { familyId: true },
    });
    if (!viewerLink) throw new AppError("FAMILY_NOT_FOUND", 404);

    const family = await this.db.family.findUnique({
      where: { id: viewerLink.familyId },
      include: {
        links: { select: { memberId: true } },
      },
    });
    if (!family) throw new AppError("FAMILY_NOT_FOUND", 404);

    const memberIds = family.links.map((l) => l.memberId);
    const projections = await this.project(viewerMemberId, memberIds);

    const familyPhotoUrl = family.photoImageId
      ? await this.presignPhoto(family.photoImageId)
      : null;

    return {
      family: {
        familyId: family.id,
        publicId: family.publicId,
        gotra: family.gotra,
        status: family.status,
        headMemberId: family.headMemberId,
        memberCount: family.links.length,
        photoUrl: familyPhotoUrl,
      },
      members: [...projections.values()],
    };
  }

  // -----------------------------------------------------------------------
  // Directory search (Stage 2)
  // -----------------------------------------------------------------------

  async searchDirectory(
    viewerMemberId: string,
    input: DirectorySearchInput,
  ): Promise<{ items: MemberProjection[]; nextCursor: string | null }> {
    const queryText = input.q?.trim() ?? "";
    const filters: Prisma.Sql[] = [Prisma.sql`m.status = 'ACTIVE'`];
    let orderBy = Prisma.sql`m.name_en ASC NULLS LAST, m.name_hi ASC NULLS LAST`;

    if (/^AGR-/iu.test(queryText)) {
      filters.push(Prisma.sql`f.public_id = ${queryText.toUpperCase()}`);
    } else if (queryText.length >= 2) {
      const isDevanagari = /[\u0900-\u097F]/u.test(queryText);
      if (isDevanagari) {
        const romanized = this.romanizer === undefined
          ? null
          : await this.romanizer.romanize(queryText);
        filters.push(Prisma.sql`(
          m.name_hi % ${queryText}
          OR (${romanized} IS NOT NULL AND m.name_en % ${romanized})
          OR (${romanized} IS NOT NULL AND m.name_en_search_key % ${romanized})
        )`);
        orderBy = romanized === null
          ? Prisma.sql`similarity(m.name_hi, ${queryText}) DESC, m.name_hi ASC`
          : Prisma.sql`GREATEST(
              COALESCE(similarity(m.name_hi, ${queryText}), 0),
              COALESCE(similarity(m.name_en, ${romanized}), 0),
              COALESCE(similarity(m.name_en_search_key, ${romanized}), 0)
            ) DESC, m.name_en ASC NULLS LAST, m.name_hi ASC NULLS LAST`;
      } else {
        filters.push(Prisma.sql`(
          m.name_en % ${queryText}
          OR m.name_en_search_key % ${queryText}
          OR m.name_en ILIKE ${`${queryText}%`}
          OR m.name_en_search_key ILIKE ${`${queryText}%`}
        )`);
        orderBy = Prisma.sql`GREATEST(
            COALESCE(similarity(m.name_en, ${queryText}), 0),
            COALESCE(similarity(m.name_en_search_key, ${queryText}), 0)
          ) DESC, m.name_en ASC NULLS LAST, m.name_hi ASC NULLS LAST`;
      }
    }

    if (input.gotra !== undefined) filters.push(Prisma.sql`f.gotra = ${input.gotra}`);
    if (input.city !== undefined) filters.push(Prisma.sql`m.city_key = ${computeCityKey(input.city)}`);
    if (input.state !== undefined) filters.push(Prisma.sql`m.state = ${input.state}`);
    if (input.familyPublicId !== undefined) {
      filters.push(Prisma.sql`f.public_id = ${input.familyPublicId}`);
    }

    const offset = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError("VALIDATION_FAILED", 400);

    const rows = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT m.id
      FROM member m
      JOIN family_link fl ON fl.member_id = m.id
      JOIN family f ON f.id = fl.family_id
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY ${orderBy}
      LIMIT ${input.limit + 1}
      OFFSET ${offset}
    `);

    const hasMore = rows.length > input.limit;
    const memberIds = (hasMore ? rows.slice(0, input.limit) : rows).map((row) => row.id);
    const projections = await this.project(viewerMemberId, memberIds);
    const items = memberIds.flatMap((id) => {
      const projection = projections.get(id);
      return projection === undefined ? [] : [projection];
    });

    return {
      items,
      nextCursor: hasMore ? String(offset + input.limit) : null,
    };
  }

  // -----------------------------------------------------------------------
  // Directory single-member and single-family (Stage 2)
  // -----------------------------------------------------------------------

  async getDirectoryMember(
    viewerMemberId: string,
    memberId: string,
  ): Promise<MemberProjection> {
    const member = await this.db.member.findUnique({
      where: { id: memberId },
      select: { id: true, status: true },
    });
    if (!member || member.status !== "ACTIVE") {
      throw new AppError("MEMBER_NOT_FOUND", 404);
    }
    const projections = await this.project(viewerMemberId, [memberId]);
    const p = projections.get(memberId);
    if (!p) throw new AppError("MEMBER_NOT_FOUND", 404);
    return p;
  }

  async getDirectoryFamily(
    viewerMemberId: string,
    publicId: string,
  ): Promise<{ family: FamilyView; members: MemberProjection[] }> {
    const family = await this.db.family.findUnique({
      where: { publicId },
      include: {
        links: {
          select: { memberId: true, member: { select: { status: true } } },
        },
      },
    });
    if (!family) throw new AppError("FAMILY_NOT_FOUND", 404);

    const activeMemberIds = family.links
      .filter((l) => l.member.status === "ACTIVE")
      .map((l) => l.memberId);

    const projections = await this.project(viewerMemberId, activeMemberIds);

    return {
      family: {
        familyId: family.id,
        publicId: family.publicId,
        gotra: family.gotra,
        status: family.status,
        headMemberId: family.headMemberId,
        memberCount: activeMemberIds.length,
      },
      members: [...projections.values()],
    };
  }

  // -----------------------------------------------------------------------
  // Invites (Stage 2)
  // -----------------------------------------------------------------------

  async createInvite(
    memberId: string,
    webBaseUrl: string,
  ): Promise<{ code: string; url: string; expiresAt: Date }> {
    const link = await this.db.familyLink.findUnique({
      where: { memberId },
      select: { familyId: true },
    });
    if (!link) throw new AppError("MEMBER_NOT_FOUND", 404);

    const code = generateInviteCode();
    const now = this.clock.now();
    const expiresAt = addDays(now, 14);

    await this.db.invite.create({
      data: { code, familyId: link.familyId, createdBy: memberId, createdAt: now, expiresAt },
    });

    return { code, url: `${webBaseUrl}/join/${code}`, expiresAt };
  }

  async lookupInvite(
    code: string,
  ): Promise<{ familyPublicId: string; gotra: Gotra } | null> {
    const invite = await this.db.invite.findUnique({
      where: { code },
    });
    if (!invite || invite.expiresAt.getTime() <= this.clock.now().getTime()) return null;

    const family = await this.db.family.findUnique({
      where: { id: invite.familyId },
      select: { publicId: true, gotra: true, status: true },
    });
    if (!family || family.status !== "ACTIVE") return null;

    return { familyPublicId: family.publicId, gotra: family.gotra };
  }

  // -----------------------------------------------------------------------
  // Donor candidates (for Blood SOS, read-only)
  // -----------------------------------------------------------------------

  async requesterLocation(memberId: string): Promise<{
    readonly city: string;
    readonly cityKey: string;
    readonly district: string | null;
    readonly state: string;
    readonly pincode: string;
  } | null> {
    const member = await this.db.member.findUnique({
      where: { id: memberId },
      select: {
        city: true,
        cityKey: true,
        district: true,
        state: true,
        pincode: true,
        status: true,
      },
    });
    if (member === null || member.status !== "ACTIVE") return null;
    return {
      city: member.city,
      cityKey: member.cityKey,
      district: member.district,
      state: member.state,
      pincode: member.pincode,
    };
  }

  async donorCandidates(filter: {
    readonly bloodGroups?: readonly BloodGroup[];
    readonly cityKey?: string;
    readonly district?: string;
    readonly state?: IndianState;
  }): Promise<DonorRow[]> {
    const where: Prisma.MemberWhereInput = {
      status: "ACTIVE",
      consentBloodGroup: true,
      ...(filter.bloodGroups !== undefined && filter.bloodGroups.length > 0
        ? { bloodGroup: { in: [...filter.bloodGroups] } }
        : {}),
      ...(filter.cityKey !== undefined ? { cityKey: filter.cityKey } : {}),
      ...(filter.district !== undefined ? { district: filter.district } : {}),
      ...(filter.state !== undefined ? { state: filter.state } : {}),
    };

    const members = await this.db.member.findMany({
      where,
      select: {
        id: true,
        bloodGroup: true,
        cityKey: true,
        district: true,
        state: true,
      },
    });

    return members.map((member) => ({
      memberId: member.id,
      bloodGroup: member.bloodGroup,
      cityKey: member.cityKey,
      district: member.district,
      state: member.state,
    }));
  }

  // -----------------------------------------------------------------------
  // Adult members of family (for Registration nominee prompt, etc.)
  // -----------------------------------------------------------------------

  async adultMembersOfFamily(
    familyId: string,
    exceptMemberId?: string,
  ): Promise<string[]> {
    const links = await this.db.familyLink.findMany({
      where: {
        familyId,
        member: { status: "ACTIVE" },
        ...(exceptMemberId ? { memberId: { not: exceptMemberId } } : {}),
      },
      select: { memberId: true },
    });
    return links.map((l) => l.memberId);
  }

  // -----------------------------------------------------------------------
  // Officer nominee read (invariant 24)
  // -----------------------------------------------------------------------

  async readNomineeForOfficer(
    tx: Tx,
    memberId: string,
    officerId: string,
    reason: "CONFIRMED_DEATH" | "ARCHIVAL_REQUEST",
    archivalRequestId?: string,
  ): Promise<MemberProjection | null> {
    const reasonValue: string = reason;
    if (reasonValue !== "CONFIRMED_DEATH" && reasonValue !== "ARCHIVAL_REQUEST") {
      throw new AppError("NOMINEE_READ_NOT_PERMITTED", 403);
    }
    const member = await tx.member.findUnique({
      where: { id: memberId },
      select: { nomineeMemberId: true, status: true },
    });
    if (!member) throw new AppError("MEMBER_NOT_FOUND", 404);

    const archivalRequestOpen = reasonValue === "ARCHIVAL_REQUEST"
      && archivalRequestId !== undefined
      && this.nomineeReadAuthorizer !== undefined
      && await this.nomineeReadAuthorizer.isArchivalRequestOpen(memberId, archivalRequestId);
    if (
      (reasonValue === "CONFIRMED_DEATH" && member.status !== "ARCHIVED")
      || (reasonValue === "ARCHIVAL_REQUEST" && !archivalRequestOpen)
    ) {
      throw new AppError("NOMINEE_READ_NOT_PERMITTED", 403);
    }

    if (member.nomineeMemberId === null) {
      await this.writeProcessing(tx, {
        action: "NOMINEE_READ",
        subjectType: "MEMBER",
        subjectId: memberId,
        actor: { kind: "OFFICER", id: officerId },
        reason: reasonValue,
      });
      return null;
    }
    await this.writeProcessing(tx, {
      action: "NOMINEE_READ",
      subjectType: "MEMBER",
      subjectId: memberId,
      actor: { kind: "OFFICER", id: officerId },
      reason: reasonValue,
      metadata: { nomineeMemberId: member.nomineeMemberId },
    });

    const projections = await this.project("", [member.nomineeMemberId]);
    return projections.get(member.nomineeMemberId) ?? null;
  }

  // -----------------------------------------------------------------------
  // Duplicate detection (for Registration)
  // -----------------------------------------------------------------------

  async findPossibleDuplicates(profile: {
    readonly nameEn?: string | null;
    readonly nameHi?: string | null;
    readonly dateOfBirth: string;
    readonly addressLine1: string;
    readonly pincode: string;
  }): Promise<{ samePerson: string[]; sharedAddressHeads: string[] }> {
    const dob = dateOnlyToDate(profile.dateOfBirth);
    const conditions: Prisma.MemberWhereInput[] = [];

    if (profile.nameEn) {
      conditions.push({
        nameEn: { equals: profile.nameEn, mode: "insensitive" },
        dateOfBirth: dob,
      });
    }
    if (profile.nameHi) {
      conditions.push({
        nameHi: profile.nameHi,
        dateOfBirth: dob,
      });
    }

    const samePerson = conditions.length > 0
      ? await this.db.member.findMany({
          where: { OR: conditions, status: { in: ["ACTIVE", "ARCHIVED"] } },
          select: { id: true },
        })
      : [];

    // Shared address heads: different family's head with same normalized line1 + pincode
    const normalizedLine1 = profile.addressLine1.trim().toLowerCase();
    const sharedAddressHeads = await this.db.member.findMany({
      where: {
        addressLine1: { equals: normalizedLine1, mode: "insensitive" },
        pincode: profile.pincode,
        status: "ACTIVE",
      },
      select: { id: true },
    });

    // Filter to heads only
    const headIds: string[] = [];
    for (const m of sharedAddressHeads) {
      if (await this.isHeadOf(m.id)) {
        headIds.push(m.id);
      }
    }

    return {
      samePerson: samePerson.map((m) => m.id),
      sharedAddressHeads: headIds,
    };
  }
  private async writeProcessing(
    tx: Tx,
    entry: {
      readonly action: RegisterProcessingAction;
      readonly subjectType: "MEMBER" | "FAMILY";
      readonly subjectId: string;
      readonly actor: ProcessingActor;
      readonly reason?: string;
      readonly metadata?: ProcessingMetadata;
    },
  ): Promise<void> {
    if (this.processingRecord === undefined) throw new AppError("INTERNAL", 500);
    await this.processingRecord.write(tx, entry);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async lookupDistrict(
    pincode: string,
    database: PrismaClient | Tx = this.db,
  ): Promise<string | null> {
    const cached = await database.pincodeCache.findUnique({
      where: { pincode },
      select: { district: true },
    });
    if (cached) return cached.district;

    try {
      const place = await this.pincodeDirectory.lookup(pincode);
      if (!place || place.district === null) return null;

      await database.pincodeCache.upsert({
        where: { pincode },
        create: {
          pincode,
          district: place.district,
          state: place.state,
          fetchedAt: this.clock.now(),
        },
        update: {
          district: place.district,
          state: place.state,
          fetchedAt: this.clock.now(),
        },
      });
      return place.district;
    } catch {
      return null;
    }
  }
  private async searchKeyForName(
    nameHi: string | undefined,
    nameEn: string | null,
  ): Promise<string | null> {
    if (nameEn !== null || nameHi === undefined || this.romanizer === undefined) return null;
    try {
      return await this.romanizer.romanize(nameHi);
    } catch {
      return null;
    }
  }

  private async recordInitialConsents(
    tx: Tx,
    memberId: string,
    input: { consentBloodGroup: boolean; consentPhoto: boolean },
    now: Date,
  ): Promise<void> {
    const events = [
      { toggle: "DIRECTORY", value: true },
      { toggle: "BLOOD_GROUP", value: input.consentBloodGroup },
      { toggle: "PHOTO", value: input.consentPhoto },
      { toggle: "PAYMENT_DISCLOSURE_ACK", value: true },
    ] as const;

    for (const e of events) {
      await tx.consentEvent.create({
        data: {
          id: uuidv7(),
          memberId,
          toggle: e.toggle,
          value: e.value,
          source: "REGISTRATION",
          at: now,
        },
      });
    }
  }

  // -----------------------------------------------------------------------
  // Purge restricted records (retention job)
  // -----------------------------------------------------------------------

  async purgeRestricted(): Promise<void> {
    // The app role has INSERT only on restricted.*; this owner-owned SECURITY
    // DEFINER function deletes rows whose retain_until has passed.
    await this.db.$executeRaw`SELECT restricted.purge_expired()`;
  }

  // -----------------------------------------------------------------------
  // Fill district (background job)
  // -----------------------------------------------------------------------

  async fillDistrict(memberId: string, pincode: string): Promise<void> {
    const district = await this.lookupDistrict(pincode);
    if (district !== null) {
      await this.db.member.updateMany({
        where: { id: memberId, district: null },
        data: { district },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Internal type aliases for the raw Prisma result shape with relations.
// These are inferred from the Prisma include pattern used in project().
// ---------------------------------------------------------------------------
interface MemberWithLink {
  id: string;
  phoneE164: string;
  status: "ACTIVE" | "ARCHIVED";
  nameEn: string | null;
  nameHi: string | null;
  nameEnSearchKey: string | null;
  fatherNameEn: string | null;
  fatherNameHi: string | null;
  gender: Gender;
  dateOfBirth: Date;
  bloodGroup: BloodGroup;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  cityKey: string;
  district: string | null;
  state: IndianState;
  pincode: string;
  nativePlaceKind: "LISTED" | "OTHER" | "UNKNOWN";
  nativePlaceId: string | null;
  nativePlaceText: string | null;
  kuldevi: string | null;
  kuldevta: string | null;
  photoImageId: string | null;
  nomineeMemberId: string | null;
  nomineePromptPending: boolean;
  consentDirectory: boolean;
  consentBloodGroup: boolean;
  consentPhoto: boolean;
  link: {
    familyId: string;
    family: {
      publicId: string;
      gotra: Gotra;
      headMemberId: string | null;
    };
  } | null;
}
