import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../../clock.js";
import { AppError } from "../../http/errors.js";
import type { JobRuntime } from "../../jobs.js";
import type { MemberProjection } from "../register/index.js";
import {
  EventPassPayloadSchema,
  signEventPass,
  verifyEventPass,
  type EventPassPayload,
  type PassVerificationResult,
} from "./crypto.js";
import type {
  AdmissionRow,
  EventPassRow,
  EventRow,
  EventsDatabase,
  EventsTxClient,
  EventStatusType,
  GateDeviceRow,
} from "./db.js";
import type {
  EventPassKeyPort as EventPassKeyPortType,
  EventsNotificationsPort,
  EventsOfficerPort as EventsOfficerPortType,
  EventsRegisterPort as EventsRegisterPortType,
} from "./ports.js";

export const JOB_NAMES = {
  startEvent: "events.startEvent",
  endEvent: "events.endEvent",
} as const;

export type EventRole = "OFFICER" | "OPERATOR" | "ORGANISER";

export interface EventActor {
  readonly memberId: string;
  readonly roles: readonly EventRole[];
}

export interface CreateEventValues {
  readonly title: string;
  readonly titleHi?: string;
  readonly description?: string;
  readonly descriptionHi?: string;
  readonly venue: string;
  readonly venueCity: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface PatchEventValues {
  readonly title?: string;
  readonly titleHi?: string | null;
  readonly description?: string | null;
  readonly descriptionHi?: string | null;
  readonly venue?: string;
  readonly venueCity?: string;
  readonly startsAt?: Date;
  readonly endsAt?: Date;
}

export interface EventsServiceDeps {
  readonly db: EventsDatabase;
  readonly clock: Clock;
  readonly jobs: JobRuntime;
  readonly register: EventsRegisterPortType;
  readonly notifications: EventsNotificationsPort;
  readonly officer: EventsOfficerPortType;
  readonly signingKeys: EventPassKeyPortType;
}

export interface EventView extends EventRow {
  readonly passCount?: number;
}

export interface PassView extends EventPassRow {
  readonly event: EventRow;
  readonly member?: MemberProjection;
}

export interface EventPage {
  readonly items: readonly EventView[];
  readonly nextCursor: number | null;
}

export interface PassPage {
  readonly items: readonly PassView[];
  readonly nextCursor: number | null;
}

export interface GateManifest {
  readonly eventId: string;
  readonly endsAtEpoch: number;
  readonly publicKeys: readonly { readonly kid: string; readonly publicKeyPem: string }[];
  readonly passCount: number;
  readonly revokedPassIds: readonly string[];
  readonly generatedAt: Date;
}

export interface GateDeviceRegistration {
  readonly gateDevice: GateDeviceRow;
  readonly manifest: GateManifest;
}

export interface SyncScan {
  readonly passId: string;
  readonly scannedAt: Date;
}

export interface DuplicateAdmission {
  readonly passId: string;
  readonly admissions: readonly Pick<AdmissionRow, "gateDeviceId" | "scannedAt">[];
}

export interface SyncAdmissionsResult {
  readonly synced: number;
  readonly duplicates: readonly DuplicateAdmission[];
}

export interface AdmissionView extends AdmissionRow {
  readonly duplicate: boolean;
}

export interface AdmissionPage {
  readonly items: readonly AdmissionView[];
  readonly nextCursor: number | null;
}

export interface VerifyPassInput {
  readonly eventId?: string;
  readonly revokedPassIds?: ReadonlySet<string>;
  readonly now?: Date;
}

function hasRole(actor: EventActor, role: EventRole): boolean {
  return actor.roles.includes(role);
}

function isEventManager(actor: EventActor, event: EventRow): boolean {
  return hasRole(actor, "OPERATOR") || (hasRole(actor, "ORGANISER") && event.createdBy === actor.memberId);
}

function requireEventManager(actor: EventActor, event: EventRow): void {
  if (!isEventManager(actor, event)) throw new AppError("NOT_ORGANISER", 403);
}

function requireOrganiser(actor: EventActor): void {
  if (!hasRole(actor, "ORGANISER") && !hasRole(actor, "OPERATOR")) {
    throw new AppError("NOT_ORGANISER", 403);
  }
}


function isActiveEvent(status: EventStatusType): boolean {
  return status === "UPCOMING" || status === "ONGOING";
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = error.code;
  return code === "P2002" || code === "23505";
}

function eventNotFound(): never {
  throw new AppError("EVENT_NOT_FOUND", 404);
}

function passNotFound(): never {
  throw new AppError("PASS_NOT_FOUND", 404);
}

function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function displayName(projection: MemberProjection | undefined): string | null {
  const name = projection?.name;
  const value = name?.en ?? name?.hi;
  if (value === undefined || value === null || value.trim().length === 0) return null;
  return value;
}

function payloadFromPass(pass: EventPassRow): EventPassPayload {
  const parts = pass.qrPayload.split(".");
  const payloadPart = parts[1];
  if (payloadPart === undefined || payloadPart.length === 0) {
    throw new AppError("INVALID_EVENT_PASS", 422);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw new AppError("INVALID_EVENT_PASS", 422);
  }
  const result = EventPassPayloadSchema.safeParse(parsed);
  if (!result.success) throw new AppError("INVALID_EVENT_PASS", 422);
  return result.data;
}

function eventUpdatedMessage(eventId: string) {
  return {
    topic: "EVENT" as const,
    subjectId: eventId,
    title: { en: "Event updated", hi: "कार्यक्रम अपडेट हुआ" },
    body: { en: "Event details have changed.", hi: "कार्यक्रम का विवरण बदल गया है।" },
    data: { eventId },
  };
}

function eventPassResponsePass(pass: EventPassRow, event: EventRow): PassView {
  return { ...pass, event };
}

function eventStatusFor(now: Date, startsAt: Date, endsAt: Date): EventStatusType {
  if (endsAt.getTime() <= now.getTime()) throw new AppError("EVENT_NOT_ACTIVE", 409);
  return startsAt.getTime() <= now.getTime() ? "ONGOING" : "UPCOMING";
}

export class EventsService {
  readonly db: EventsDatabase;
  readonly clock: Clock;
  readonly jobs: JobRuntime;
  readonly register: EventsRegisterPortType;
  readonly notifications: EventsNotificationsPort;
  readonly officer: EventsOfficerPortType;
  readonly signingKeys: EventPassKeyPortType;

  constructor(deps: EventsServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.jobs = deps.jobs;
    this.register = deps.register;
    this.notifications = deps.notifications;
    this.officer = deps.officer;
    this.signingKeys = deps.signingKeys;

    this.register.onMemberErased(async (tx, memberId) => {
      await this.revokePassesForMember(tx, memberId, "MEMBER_ERASED");
    });
    this.register.onMemberArchived(async (tx, memberId) => {
      await this.revokePassesForMember(tx, memberId, "MEMBER_ARCHIVED");
    });
  }

  async createEvent(actor: EventActor, input: CreateEventValues): Promise<EventView> {
    if (!hasRole(actor, "ORGANISER") && !hasRole(actor, "OPERATOR")) {
      throw new AppError("NOT_ORGANISER", 403);
    }
    if (input.endsAt.getTime() <= input.startsAt.getTime()) {
      throw new AppError("VALIDATION_FAILED", 400);
    }
    const now = this.clock.now();
    const event: EventView = await this.db.event.create({
      data: {
        id: uuidv7(),
        title: input.title,
        titleHi: input.titleHi ?? null,
        description: input.description ?? null,
        descriptionHi: input.descriptionHi ?? null,
        venue: input.venue,
        venueCity: input.venueCity,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        createdBy: actor.memberId,
        status: eventStatusFor(now, input.startsAt, input.endsAt),
        createdAt: now,
      },
    });
    await this.scheduleLifecycle(event);
    return event;
  }

  async listEvents(_viewerMemberId: string, cursor = 0, limit = 20): Promise<EventPage> {
    const offset = cursor < 0 || !Number.isInteger(cursor) ? 0 : cursor;
    const take = Math.min(Math.max(limit, 1), 50) + 1;
    const rows = await this.db.event.findMany({
      where: { status: { in: ["UPCOMING", "ONGOING"] } },
      orderBy: { startsAt: "asc" },
      take,
      skip: offset,
    });
    const hasMore = rows.length > take - 1;
    const items = hasMore ? rows.slice(0, take - 1) : rows;
    return {
      items,
      nextCursor: hasMore ? offset + items.length : null,
    };
  }

  async getEvent(
    _viewerMemberId: string,
    eventId: string,
    includePassCount = false,
  ): Promise<EventView> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    if (!includePassCount) return event;
    const passCount = await this.db.eventPass.count({ where: { eventId } });
    return { ...event, passCount };
  }

  async updateEvent(actor: EventActor, eventId: string, input: PatchEventValues): Promise<EventView> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    requireEventManager(actor, event);
    if (!isActiveEvent(event.status)) throw new AppError("EVENT_NOT_ACTIVE", 409);

    const startsAt = input.startsAt ?? event.startsAt;
    const endsAt = input.endsAt ?? event.endsAt;
    if (endsAt.getTime() <= startsAt.getTime()) throw new AppError("VALIDATION_FAILED", 400);
    const changesTimes = input.startsAt !== undefined || input.endsAt !== undefined;
    if (changesTimes && event.status !== "UPCOMING") {
      throw new AppError("EVENT_NOT_EDITABLE", 409);
    }
    if (endsAt.getTime() <= this.clock.now().getTime()) throw new AppError("EVENT_NOT_ACTIVE", 409);

    const activePasses = await this.db.eventPass.findMany({
      where: { eventId, status: "ACTIVE" },
    });
    const endsAtChanged = endsAt.getTime() !== event.endsAt.getTime();
    const signingKey = endsAtChanged && activePasses.length > 0
      ? await this.signingKeys.getSigningKey()
      : null;
    const projections = activePasses.length === 0
      ? new Map<string, MemberProjection>()
      : await this.register.project(event.createdBy, activePasses.map((pass) => pass.memberId));

    const updated = await this.db.$transaction(async (tx) => {
      const current = await tx.event.findUnique({ where: { id: eventId } });
      if (current === null) eventNotFound();
      const data: Record<string, unknown> = {};
      if (input.title !== undefined) data.title = input.title;
      if (input.titleHi !== undefined) data.titleHi = input.titleHi;
      if (input.description !== undefined) data.description = input.description;
      if (input.descriptionHi !== undefined) data.descriptionHi = input.descriptionHi;
      if (input.venue !== undefined) data.venue = input.venue;
      if (input.venueCity !== undefined) data.venueCity = input.venueCity;
      if (input.startsAt !== undefined) data.startsAt = input.startsAt;
      if (input.endsAt !== undefined) data.endsAt = input.endsAt;
      const saved = await tx.event.update({ where: { id: eventId }, data });

      if (endsAtChanged && signingKey !== null) {
        for (const pass of activePasses) {
          const oldPayload = payloadFromPass(pass);
          const name = displayName(projections.get(pass.memberId)) || oldPayload.n;
          const payload: EventPassPayload = {
            p: pass.id,
            e: eventId,
            m: pass.memberId,
            h: pass.isHead,
            c: pass.isHead ? pass.minorsCount : 0,
            n: name,
            x: toEpochSeconds(endsAt),
          };
          await tx.eventPass.update({
            where: { id: pass.id },
            data: { qrPayload: signEventPass(payload, signingKey) },
          });
        }
      }
      return saved;
    });

    if (activePasses.length > 0) {
      await this.notifications.enqueue(
        [...new Set(activePasses.map((pass) => pass.memberId))],
        eventUpdatedMessage(eventId),
      );
    }
    if (input.startsAt !== undefined || input.endsAt !== undefined) {
      await this.scheduleLifecycle(updated);
    }
    return updated;
  }

  async cancelEvent(actor: EventActor, eventId: string): Promise<EventView> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    requireEventManager(actor, event);
    if (event.status === "CANCELLED") return event;
    if (!isActiveEvent(event.status)) throw new AppError("EVENT_NOT_ACTIVE", 409);

    const now = this.clock.now();
    if (event.endsAt.getTime() <= this.clock.now().getTime()) throw new AppError("EVENT_NOT_ACTIVE", 409);
    const activePasses = await this.db.eventPass.findMany({ where: { eventId, status: "ACTIVE" } });
    const cancelled = await this.db.$transaction(async (tx) => {
      const saved = await tx.event.update({
        where: { id: eventId },
        data: { status: "CANCELLED" },
      });
      await tx.eventPass.updateMany({
        where: { eventId, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now, revokedReason: "EVENT_CANCELLED" },
      });
      return saved;
    });
    if (activePasses.length > 0) {
      await this.notifications.enqueue(
        [...new Set(activePasses.map((pass) => pass.memberId))],
        eventUpdatedMessage(eventId),
      );
    }
    return cancelled;
  }

  async claimPass(
    memberId: string,
    eventId: string,
    minorsCount: number,
  ): Promise<PassView> {
    if (!(await this.register.isActiveMember(memberId))) {
      throw new AppError("MEMBER_NOT_FOUND", 404);
    }
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    if (!isActiveEvent(event.status) || event.endsAt.getTime() <= this.clock.now().getTime()) {
      throw new AppError("EVENT_NOT_ACTIVE", 409);
    }
    const family = await this.register.familyOf(memberId);
    if (family === null) throw new AppError("MEMBER_NOT_FOUND", 404);
    const isHead = await this.register.isHeadOf(memberId);
    const projection = (await this.register.project(memberId, [memberId])).get(memberId);
    const name = displayName(projection);
    if (name === null) throw new AppError("MEMBER_NOT_FOUND", 404);
    const count = isHead ? minorsCount : 0;
    const signingKey = await this.signingKeys.getSigningKey();
    const passId = uuidv7();
    const payload: EventPassPayload = {
      p: passId,
      e: eventId,
      m: memberId,
      h: isHead,
      c: count,
      n: name,
      x: toEpochSeconds(event.endsAt),
    };

    try {
      const pass = await this.db.$transaction(async (tx) => {
        const existing = await tx.eventPass.findFirst({ where: { eventId, memberId } });
        if (existing !== null) throw new AppError("PASS_ALREADY_EXISTS", 409);
        return tx.eventPass.create({
          data: {
            id: passId,
            eventId,
            memberId,
            familyId: family.familyId,
            isHead,
            minorsCount: count,
            status: "ACTIVE",
            qrPayload: signEventPass(payload, signingKey),
            issuedAt: this.clock.now(),
            revokedAt: null,
            revokedReason: null,
          },
        });
      });
      return eventPassResponsePass(pass, event);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isUniqueViolation(error)) throw new AppError("PASS_ALREADY_EXISTS", 409);
      throw error;
    }
  }

  async getMyPass(memberId: string, eventId: string): Promise<PassView | null> {
    const pass = await this.db.eventPass.findFirst({ where: { eventId, memberId } });
    if (pass === null) return null;
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    return eventPassResponsePass(pass, event);
  }

  async cancelMyPass(memberId: string, eventId: string): Promise<void> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    if (event.endsAt.getTime() <= this.clock.now().getTime() || event.status === "ENDED") {
      throw new AppError("EVENT_NOT_ACTIVE", 409);
    }
    const pass = await this.db.eventPass.findFirst({ where: { eventId, memberId } });
    if (pass === null) passNotFound();
    if (pass.status === "REVOKED") return;
    await this.db.eventPass.update({
      where: { id: pass.id },
      data: { status: "REVOKED", revokedAt: this.clock.now(), revokedReason: "MEMBER_CANCELLED" },
    });
  }

  async listMyPasses(memberId: string): Promise<readonly PassView[]> {
    const passes = await this.db.eventPass.findMany({
      where: { memberId, status: "ACTIVE" },
      orderBy: { issuedAt: "desc" },
    });
    const events = await Promise.all(passes.map((pass) => this.db.event.findUnique({ where: { id: pass.eventId } })));
    return passes.flatMap((pass, index) => {
      const event = events[index];
      return event === null || event === undefined ? [] : [eventPassResponsePass(pass, event)];
    });
  }

  async listPasses(actor: EventActor, eventId: string): Promise<PassPage> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    requireEventManager(actor, event);
    const passes = await this.db.eventPass.findMany({
      where: { eventId },
      orderBy: { issuedAt: "asc" },
    });
    const projections = await this.register.project(actor.memberId, passes.map((pass) => pass.memberId));
    const items = passes.map((pass) => {
      const member = projections.get(pass.memberId);
      return {
        ...eventPassResponsePass(pass, event),
        ...(member === undefined ? {} : { member }),
      };
    });
    return { items, nextCursor: null };
  }

  async registerGateDevice(
    actor: EventActor,
    eventId: string,
    label: string,
  ): Promise<GateDeviceRegistration> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    requireEventManager(actor, event);
    if (!isActiveEvent(event.status) || event.endsAt.getTime() <= this.clock.now().getTime()) {
      throw new AppError("EVENT_NOT_ACTIVE", 409);
    }
    const gateDevice = await this.db.gateDevice.create({
      data: {
        id: uuidv7(),
        eventId,
        label,
        registeredBy: actor.memberId,
        registeredAt: this.clock.now(),
      },
    });
    return { gateDevice, manifest: await this.gateManifest(actor, eventId) };
  }

  async gateManifest(actor: EventActor, eventId: string): Promise<GateManifest> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    requireEventManager(actor, event);
    const [publicKeys, passCount, revokedPasses] = await Promise.all([
      this.signingKeys.getVerificationKeys(),
      this.db.eventPass.count({ where: { eventId } }),
      this.db.eventPass.findMany({ where: { eventId, status: "REVOKED" } }),
    ]);
    return {
      eventId,
      endsAtEpoch: toEpochSeconds(event.endsAt),
      publicKeys,
      passCount,
      revokedPassIds: revokedPasses.map((pass) => pass.id),
      generatedAt: this.clock.now(),
    };
  }

  async syncAdmissions(
    actor: EventActor,
    eventId: string,
    gateDeviceId: string,
    scans: readonly SyncScan[],
  ): Promise<SyncAdmissionsResult> {
    requireOrganiser(actor);
    const gate = await this.db.gateDevice.findUnique({ where: { id: gateDeviceId } });
    if (gate === null || gate.eventId !== eventId || gate.registeredBy !== actor.memberId) {
      throw new AppError("GATE_DEVICE_NOT_FOR_EVENT", 403);
    }
    const passIds = [...new Set(scans.map((scan) => scan.passId))];
    for (const passId of passIds) {
      const pass = await this.db.eventPass.findUnique({ where: { id: passId } });
      if (pass === null || pass.eventId !== eventId) passNotFound();
    }

    let synced = 0;
    await this.db.$transaction(async (tx) => {
      for (const scan of scans) {
        try {
          await tx.admission.create({
            data: {
              id: uuidv7(),
              passId: scan.passId,
              gateDeviceId,
              scannedAt: scan.scannedAt,
              scannedOffline: true,
            },
          });
          synced += 1;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
    });

    const duplicates: DuplicateAdmission[] = [];
    for (const passId of passIds) {
      const admissions = await this.db.admission.findMany({
        where: { passId },
        orderBy: { scannedAt: "asc" },
      });
      const gateIds = new Set(admissions.map((admission) => admission.gateDeviceId));
      if (gateIds.size > 1) {
        duplicates.push({
          passId,
          admissions: admissions.map((admission) => ({
            gateDeviceId: admission.gateDeviceId,
            scannedAt: admission.scannedAt,
          })),
        });
      }
    }
    return { synced, duplicates };
  }

  async listAdmissions(actor: EventActor, eventId: string, cursor = 0, limit = 50): Promise<AdmissionPage> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null) eventNotFound();
    requireEventManager(actor, event);
    const passes = await this.db.eventPass.findMany({ where: { eventId } });
    const rows = (await Promise.all(
      passes.map((pass) => this.db.admission.findMany({ where: { passId: pass.id }, orderBy: { scannedAt: "asc" } })),
    )).flat().sort((left, right) => left.scannedAt.getTime() - right.scannedAt.getTime());
    const offset = cursor < 0 || !Number.isInteger(cursor) ? 0 : cursor;
    const take = Math.min(Math.max(limit, 1), 100);
    const page = rows.slice(offset, offset + take + 1);
    const hasMore = page.length > take;
    const selected = hasMore ? page.slice(0, take) : page;
    const byPass = new Map<string, readonly AdmissionRow[]>();
    for (const row of rows) {
      const existing = byPass.get(row.passId) ?? [];
      byPass.set(row.passId, [...existing, row]);
    }
    const items = selected.map((row) => ({
      ...row,
      duplicate: new Set((byPass.get(row.passId) ?? []).map((item) => item.gateDeviceId)).size > 1,
    }));
    return { items, nextCursor: hasMore ? offset + items.length : null };
  }

  async verifyPass(qrPayload: string, input: VerifyPassInput = {}): Promise<PassVerificationResult> {
    const keys = await this.signingKeys.getVerificationKeys();
    return verifyEventPass(qrPayload, keys, input);
  }

  async revokePass(
    passId: string,
    actor: { readonly memberId: string },
    reason: string,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const pass = await tx.eventPass.findUnique({ where: { id: passId } });
      if (pass === null) passNotFound();
      if (pass.status === "REVOKED") return;
      await tx.eventPass.update({
        where: { id: passId },
        data: { status: "REVOKED", revokedAt: this.clock.now(), revokedReason: "OFFICER" },
      });
      await this.officer.write(tx, {
        action: "PASS_REVOKED",
        subjectType: "EVENT_PASS",
        subjectId: passId,
        actor: { kind: "OFFICER", id: actor.memberId },
        reason,
      });
    });
  }

  async revokePassesForMember(
    tx: EventsTxClient,
    memberId: string,
    reason: string,
  ): Promise<void> {
    await tx.eventPass.updateMany({
      where: { memberId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: this.clock.now(), revokedReason: reason },
    });
  }

  async startEvent(eventId: string): Promise<void> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null || event.status !== "UPCOMING") return;
    const now = this.clock.now();
    if (now.getTime() < event.startsAt.getTime()) return;
    if (now.getTime() >= event.endsAt.getTime()) {
      await this.endEvent(eventId);
      return;
    }
    await this.db.event.update({ where: { id: eventId }, data: { status: "ONGOING" } });
  }

  async endEvent(eventId: string): Promise<void> {
    const event = await this.db.event.findUnique({ where: { id: eventId } });
    if (event === null || event.status === "ENDED" || event.status === "CANCELLED") return;
    const now = this.clock.now();
    if (now.getTime() < event.endsAt.getTime()) return;
    await this.db.$transaction(async (tx) => {
      await tx.event.update({ where: { id: eventId }, data: { status: "ENDED" } });
      await tx.eventPass.updateMany({
        where: { eventId, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now, revokedReason: "EVENT_ENDED" },
      });
    });
  }

  private async scheduleLifecycle(event: EventRow): Promise<void> {
    await this.jobs.send(JOB_NAMES.startEvent, { eventId: event.id }, { startAfter: event.startsAt });
    await this.jobs.send(JOB_NAMES.endEvent, { eventId: event.id }, { startAfter: event.endsAt });
  }
}
