import { v7 as uuidv7 } from "uuid";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import type { Clock } from "../../clock.js";
import type { PincodeDirectory, PincodePlace } from "../../adapters/ports.js";
import type { JobRuntime } from "../../jobs.js";
import { AppError } from "../../http/errors.js";
import type {
  DonorRow,
  MemberProjection,
} from "../register/index.js";
import type {
  LocalizedPushMessage,
  NotificationsPort,
} from "../notifications/index.js";
import type {
  ProcessingEntry,
  ProcessingRecordWriter,
} from "../officer/index.js";
import type { BloodGroup } from "./compatibility.js";
import { matchBloodSosDonors, mayRespondToAlert, shouldCreateAlert } from "./matching.js";
import {
  chooseBloodSosPlace,
  type BloodSosResolvedPlace,
} from "./places.js";
import type {
  BloodSosCreateInput,
  BloodSosLastDonationInput,
  BloodSosReportInput,
  BloodSosRequestViewBody,
  BloodSosSnoozeInput,
  SosClosedReason,
  SosPlaceSource,
  SosStatus,
} from "./schemas.js";
import { JOB_NAMES } from "./jobs.js";

export type BloodSosTransaction = Prisma.TransactionClient;
export type BloodSosState = DonorRow["state"];

export interface BloodSosRequesterLocation {
  readonly city: string;
  readonly cityKey: string;
  readonly district: string | null;
  readonly state: string;
  readonly pincode: string;
}

export interface BloodSosDonorFilter {
  readonly bloodGroups?: readonly BloodGroup[];
  readonly cityKey?: string;
  readonly district?: string;
  readonly state?: string;
}

/**
 * Register's sanctioned Blood SOS seam. It is deliberately narrower than a
 * Member row: matching receives only consented donor fields and the fallback
 * receives only the requester's validated place.
 */
export interface BloodSosRegisterPort {
  donorCandidates(filter: BloodSosDonorFilter): Promise<readonly DonorRow[]>;
  requesterLocation(memberId: string): Promise<BloodSosRequesterLocation | null>;
  project(
    viewerMemberId: string,
    memberIds: readonly string[],
  ): Promise<ReadonlyMap<string, MemberProjection>>;
  isActiveMember(memberId: string): Promise<boolean>;
}

export interface BloodSosReportPort {
  create(input: {
    readonly requestId: string;
    readonly reporterMemberId: string;
    readonly reason: string;
  }): Promise<{ readonly id: string }>;
}

export interface BloodSosConfig {
  readonly tierIntervalMinutes: number;
  readonly expiryHours: number;
  readonly densityFloor: number;
  readonly donorCooldownDays: number;
  readonly donorDailyAlertCap: number;
}
export interface BloodSosDonorStatus {
  readonly isDonor: boolean;
  readonly snoozeUntil: string | null;
  readonly lastDonatedOn: string | null;
  readonly eligibleFrom: string | null;
}


export const DEFAULT_BLOOD_SOS_CONFIG: BloodSosConfig = {
  tierIntervalMinutes: 30,
  expiryHours: 24,
  densityFloor: 5,
  donorCooldownDays: 90,
  donorDailyAlertCap: 3,
};

export interface BloodSosServiceDeps {
  readonly db: PrismaClient;
  readonly clock: Clock;
  readonly jobs: JobRuntime;
  readonly config: BloodSosConfig;
  readonly pincodeDirectory: PincodeDirectory;
  readonly register: BloodSosRegisterPort;
  readonly notifications: NotificationsPort;
  readonly reports: BloodSosReportPort;
  readonly officer: ProcessingRecordWriter;
}

interface BloodSosRequestRecord {
  readonly id: string;
  readonly requesterMemberId: string;
  readonly status: SosStatus;
  readonly bloodGroup: BloodGroup;
  readonly hospitalName: string;
  readonly hospitalPincode: string;
  readonly hospitalCity: string;
  readonly hospitalCityKey: string;
  readonly hospitalDistrict: string | null;
  readonly hospitalState: string;
  readonly placeSource: SosPlaceSource;
  readonly patientName: string | null;
  readonly unitsNeeded: number | null;
  readonly note: string | null;
  readonly currentTier: number;
  readonly donorReachTotal: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly fulfilledAt: Date | null;
  readonly closedAt: Date | null;
  readonly closedBy: string | null;
  readonly closedReason: string | null;
}


interface EligibleDonor {
  readonly memberId: string;
  readonly bloodGroup: BloodGroup;
  readonly bloodGroupMatch: boolean;
}

interface DonorPreferenceRecord {
  readonly memberId: string;
  readonly snoozedAt: Date | null;
  readonly snoozeUntil: Date | null;
  readonly lastDonatedOn: Date | null;
}

export interface AlertDeliveryRequest {
  readonly id: string;
  readonly hospitalName: string;
  readonly hospitalCity: string;
  readonly bloodGroup: string;
}

const DAY_MS = 86_400_000;
const JOB_RETRY_OPTIONS = { retryLimit: 5, retryBackoff: true } as const;

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateOnlyString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}

function addMinutes(value: Date, minutes: number): Date {
  return new Date(value.getTime() + minutes * 60_000);
}

function addHours(value: Date, hours: number): Date {
  return new Date(value.getTime() + hours * 60 * 60_000);
}

function dateAtEndOfDay(value: string): Date {
  return new Date(`${value}T23:59:59.999Z`);
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  return error.code;
}

function isUniqueViolation(error: unknown): boolean {
  return errorCode(error) === "P2002";
}


function snoozeActive(
  preference: Pick<DonorPreferenceRecord, "snoozedAt" | "snoozeUntil"> | null,
  now: Date,
): boolean {
  if (preference === null || preference.snoozedAt === null) return false;
  return preference.snoozeUntil === null || preference.snoozeUntil.getTime() > now.getTime();
}

function inDonationCooldown(
  preference: Pick<DonorPreferenceRecord, "lastDonatedOn"> | null,
  today: string,
  cooldownDays: number,
): boolean {
  if (preference?.lastDonatedOn === null || preference?.lastDonatedOn === undefined) return false;
  const cutoff = addDays(dateOnly(today), -cooldownDays);
  return preference.lastDonatedOn.getTime() > cutoff.getTime();
}

export function projectDonorForBloodSos(projection: MemberProjection): MemberProjection {
  return {
    memberId: projection.memberId,
    familyPublicId: projection.familyPublicId,
    isHead: projection.isHead,
    ...(projection.name === undefined ? {} : { name: projection.name }),
    ...(projection.gotra === undefined ? {} : { gotra: projection.gotra }),
    ...(projection.city === undefined ? {} : { city: projection.city }),
    ...(projection.state === undefined ? {} : { state: projection.state }),
    ...(projection.photoUrl === undefined ? {} : { photoUrl: projection.photoUrl }),
  };
}

export function alertMessage(request: AlertDeliveryRequest): LocalizedPushMessage {
  return {
    topic: "BLOOD_SOS_ALERT",
    subjectId: request.id,
    title: {
      en: "Blood SOS alert",
      hi: "ब्लड SOS अलर्ट",
    },
    body: {
      en: "A blood request needs help. Open the app for details.",
      hi: "रक्त की आवश्यकता है। विवरण के लिए ऐप खोलें।",
    },
    data: { requestId: request.id },
  };
}

function responseMessage(requestId: string): LocalizedPushMessage {
  return {
    topic: "BLOOD_SOS_RESPONSE",
    subjectId: requestId,
    title: {
      en: "A donor responded",
      hi: "एक डोनर ने जवाब दिया",
    },
    body: {
      en: "A donor has signalled willingness to help with your Blood SOS.",
      hi: "एक डोनर ने आपके ब्लड SOS में मदद की इच्छा जताई है।",
    },
    data: { requestId },
  };
}

function memberIdFromProjection(
  projections: ReadonlyMap<string, MemberProjection>,
  memberId: string,
): MemberProjection {
  const projection = projections.get(memberId);
  if (projection === undefined) throw new AppError("MEMBER_NOT_FOUND", 404);
  return projection;
}

export class BloodSosService {
  private readonly db: PrismaClient;
  private readonly clock: Clock;
  private readonly jobs: JobRuntime;
  private readonly config: BloodSosConfig;
  private readonly pincodeDirectory: PincodeDirectory;
  private readonly register: BloodSosRegisterPort;
  private readonly notifications: NotificationsPort;
  private readonly reports: BloodSosReportPort;
  private readonly officer: ProcessingRecordWriter;

  public constructor(deps: BloodSosServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.jobs = deps.jobs;
    this.config = deps.config;
    this.pincodeDirectory = deps.pincodeDirectory;
    this.register = deps.register;
    this.notifications = deps.notifications;
    this.reports = deps.reports;
    this.officer = deps.officer;
  }

  public async createRequest(
    requesterMemberId: string,
    input: BloodSosCreateInput,
  ): Promise<BloodSosRequestViewBody> {
    if (!(await this.register.isActiveMember(requesterMemberId))) {
      throw new AppError("UNAUTHENTICATED", 401);
    }

    const place = await this.resolveHospitalPlace(requesterMemberId, input.hospitalPincode);
    const now = this.clock.now();
    const requestId = uuidv7();
    const expiresAt = addHours(now, this.config.expiryHours);

    let created: BloodSosRequestRecord;
    try {
      created = await this.db.$transaction(async (tx) => {
        const row = await tx.bloodSosRequest.create({
          data: {
            id: requestId,
            requesterMemberId,
            status: "ACTIVE",
            bloodGroup: input.bloodGroup,
            hospitalName: input.hospitalName,
            hospitalPincode: input.hospitalPincode,
            hospitalCity: place.city,
            hospitalCityKey: place.cityKey,
            hospitalDistrict: place.district,
            hospitalState: place.state,
            placeSource: place.source,
            patientName: input.patientName ?? null,
            unitsNeeded: input.unitsNeeded ?? null,
            note: input.note ?? null,
            currentTier: 1,
            donorReachTotal: 0,
            createdAt: now,
            expiresAt,
          },
        });
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError("SOS_ALREADY_ACTIVE", 409);
      throw error;
    }

    await this.scheduleWidening(created.id, now, expiresAt);
    await this.runTier(created.id, 1);
    return this.getRequest(requesterMemberId, created.id);
  }

  private async resolveHospitalPlace(
    requesterMemberId: string,
    hospitalPincode: string,
  ): Promise<BloodSosResolvedPlace> {
    let lookedUp: PincodePlace | null = null;
    try {
      lookedUp = await this.pincodeDirectory.lookup(hospitalPincode);
    } catch {
      lookedUp = null;
    }
    const directoryPlace = chooseBloodSosPlace(lookedUp, null);
    if (directoryPlace !== null) return directoryPlace;

    const requesterPlace = await this.register.requesterLocation(requesterMemberId);
    const fallbackPlace = chooseBloodSosPlace(null, requesterPlace);
    if (fallbackPlace === null) throw new AppError("SOS_PLACE_UNAVAILABLE", 422);
    return fallbackPlace;
  }

  private async scheduleWidening(
    requestId: string,
    createdAt: Date,
    expiresAt: Date,
  ): Promise<void> {
    const interval = this.config.tierIntervalMinutes;
    await this.jobs.send(
      JOB_NAMES.widenTier2,
      { requestId },
      { startAfter: addMinutes(createdAt, interval), ...JOB_RETRY_OPTIONS },
    );
    await this.jobs.send(
      JOB_NAMES.widenTier3,
      { requestId },
      { startAfter: addMinutes(createdAt, interval * 2), ...JOB_RETRY_OPTIONS },
    );
    await this.jobs.send(
      JOB_NAMES.expire,
      { requestId },
      { startAfter: expiresAt, ...JOB_RETRY_OPTIONS },
    );
  }

  /** Run one place tier. Re-running a tier is safe because alerts are unique. */
  public async runTier(requestId: string, tier: 1 | 2 | 3): Promise<void> {
    const request = await this.db.bloodSosRequest.findUnique({ where: { id: requestId } });
    if (request === null || request.status !== "ACTIVE") return;
    if (this.clock.now().getTime() >= request.expiresAt.getTime()) {
      await this.expire(requestId);
      return;
    }

    if (tier === 2 && request.hospitalDistrict === null) {
      await this.advanceTier(requestId, tier);
      return;
    }

    const candidates = await this.eligibleCandidates(request, tier);
    for (const donor of candidates) {
      try {
        await this.deliverAlert(request, donor, tier, donor.bloodGroupMatch);
      } catch {
        // A single delivery failure must not stop widening or expiry.
      }
    }
    await this.advanceTier(requestId, tier);
  }

  private async eligibleCandidates(
    request: BloodSosRequestRecord,
    tier: 1 | 2 | 3,
  ): Promise<readonly EligibleDonor[]> {
    const filter: BloodSosDonorFilter = tier === 1
      ? { cityKey: request.hospitalCityKey }
      : tier === 2
        ? {
            ...(request.hospitalDistrict === null ? {} : { district: request.hospitalDistrict }),
            state: request.hospitalState,
          }
        : { state: request.hospitalState };
    const rows = await this.register.donorCandidates(filter);
    if (rows.length === 0) return [];

    const memberIds = [...new Set(rows.map((row) => row.memberId))];
    const [alerts, preferences, days] = await Promise.all([
      this.db.bloodSosAlert.findMany({
        where: { requestId: request.id, donorMemberId: { in: memberIds } },
        select: { donorMemberId: true },
      }),
      this.db.donorPreference.findMany({
        where: { memberId: { in: memberIds } },
        select: { memberId: true, snoozedAt: true, snoozeUntil: true, lastDonatedOn: true },
      }),
      this.db.donorAlertDay.findMany({
        where: { memberId: { in: memberIds }, dayIst: dateOnly(this.clock.todayIst()) },
        select: { memberId: true, count: true },
      }),
    ]);

    const matches = matchBloodSosDonors({
      tier,
      requesterMemberId: request.requesterMemberId,
      neededGroup: request.bloodGroup,
      cityKey: request.hospitalCityKey,
      district: request.hospitalDistrict,
      state: request.hospitalState,
      donors: rows,
      preferences: new Map(preferences.map((preference) => [preference.memberId, preference])),
      alreadyAlerted: new Set(alerts.map((alert) => alert.donorMemberId)),
      dailyCounts: new Map(days.map((day) => [day.memberId, day.count])),
      now: this.clock.now(),
      today: this.clock.todayIst(),
      cooldownDays: this.config.donorCooldownDays,
      dailyCap: this.config.donorDailyAlertCap,
      densityFloor: this.config.densityFloor,
    });
    return matches;
  }

  private async deliverAlert(
    request: AlertDeliveryRequest & { readonly id: string },
    donor: EligibleDonor,
    tier: 1 | 2 | 3,
    bloodGroupMatch: boolean,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const lockedRequest = await tx.bloodSosRequest.findUnique({
        where: { id: request.id },
        select: {
          status: true,
          hospitalName: true,
          hospitalCity: true,
          bloodGroup: true,
        },
      });
      if (lockedRequest === null || lockedRequest.status !== "ACTIVE") return;

      const existing = await tx.bloodSosAlert.findUnique({
        where: {
          requestId_donorMemberId: {
            requestId: request.id,
            donorMemberId: donor.memberId,
          },
        },
        select: { id: true },
      });
      if (!shouldCreateAlert(existing !== null)) return;

      const day = this.clock.todayIst();
      await tx.$executeRaw`
        INSERT INTO donor_alert_day (member_id, day_ist, count)
        VALUES (${donor.memberId}, ${day}::date, 0)
        ON CONFLICT (member_id, day_ist) DO NOTHING
      `;
      const dayRows = await tx.$queryRaw<readonly { count: number }[]>`
        SELECT count
          FROM donor_alert_day
         WHERE member_id = ${donor.memberId}
           AND day_ist = ${day}::date
         FOR UPDATE
      `;
      const currentCount = dayRows[0]?.count ?? 0;
      if (currentCount >= this.config.donorDailyAlertCap) return;

      let accepted = false;
      try {
        const delivery = await this.notifications.send(
          [donor.memberId],
          alertMessage({
            id: request.id,
            bloodGroup: lockedRequest.bloodGroup,
            hospitalName: lockedRequest.hospitalName,
            hospitalCity: lockedRequest.hospitalCity,
          }),
        );
        accepted = delivery.get(donor.memberId)?.accepted === true;
      } catch {
        accepted = false;
      }

      await tx.bloodSosAlert.create({
        data: {
          id: uuidv7(),
          requestId: request.id,
          tier,
          donorMemberId: donor.memberId,
          bloodGroupMatch,
          accepted,
          createdAt: this.clock.now(),
        },
      });
      if (!accepted) return;

      await tx.$executeRaw`
        UPDATE donor_alert_day
           SET count = count + 1
         WHERE member_id = ${donor.memberId}
           AND day_ist = ${day}::date
      `;
      await tx.bloodSosRequest.update({
        where: { id: request.id },
        data: { donorReachTotal: { increment: 1 } },
      });
    });
  }

  private async advanceTier(requestId: string, tier: 1 | 2 | 3): Promise<void> {
    await this.db.bloodSosRequest.updateMany({
      where: { id: requestId, status: "ACTIVE", currentTier: { lt: tier } },
      data: { currentTier: tier },
    });
  }

  public async getMine(memberId: string): Promise<{
    readonly active: BloodSosRequestViewBody | null;
    readonly closed: readonly BloodSosRequestViewBody[];
  }> {
    const rows = await this.db.bloodSosRequest.findMany({
      where: { requesterMemberId: memberId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const activeRow = rows.find((row) => row.status === "ACTIVE");
    const closedRows = rows.filter((row) => row.status === "CLOSED");
    return {
      active: activeRow === undefined ? null : await this.toView(memberId, activeRow),
      closed: await Promise.all(closedRows.map((row) => this.toView(memberId, row))),
    };
  }

  public async getRequest(
    viewerMemberId: string,
    requestId: string,
  ): Promise<BloodSosRequestViewBody> {
    const request = await this.db.bloodSosRequest.findUnique({ where: { id: requestId } });
    if (request === null) throw new AppError("SOS_NOT_FOUND", 404);
    return this.toView(viewerMemberId, request);
  }

  private async toView(
    viewerMemberId: string,
    request: BloodSosRequestRecord,
  ): Promise<BloodSosRequestViewBody> {
    const result: BloodSosRequestViewBody = {
      id: request.id,
      status: request.status,
      hospitalName: request.hospitalName,
      hospitalCity: request.hospitalCity,
      placeSource: request.placeSource,
      patientName: request.patientName,
      unitsNeeded: request.unitsNeeded,
      note: request.note,
      currentTier: request.currentTier,
      expiresAt: request.expiresAt.toISOString(),
      createdAt: request.createdAt.toISOString(),
      fulfilledAt: request.fulfilledAt?.toISOString() ?? null,
      closedAt: request.closedAt?.toISOString() ?? null,
      closedReason: request.closedReason,
    };
    if (viewerMemberId !== request.requesterMemberId) return result;

    result.donorReach = request.donorReachTotal;
    const responseRows = await this.db.bloodSosResponse.findMany({
      where: { requestId: request.id },
      orderBy: { createdAt: "asc" },
    });
    const donorIds = responseRows.map((response) => response.donorMemberId);
    const projections = await this.register.project(viewerMemberId, donorIds);
    result.responses = responseRows.flatMap((response) => {
      const projection = projections.get(response.donorMemberId);
      if (projection === undefined) return [];
      return [{
        id: response.id,
        createdAt: response.createdAt.toISOString(),
        donor: projectDonorForBloodSos(projection),
      }];
    });
    return result;
  }

  public async fulfilRequest(
    requesterMemberId: string,
    requestId: string,
  ): Promise<BloodSosRequestViewBody> {
    await this.closeByRequester(requesterMemberId, requestId, "FULFILLED");
    return this.getRequest(requesterMemberId, requestId);
  }

  public async cancelRequest(
    requesterMemberId: string,
    requestId: string,
  ): Promise<BloodSosRequestViewBody> {
    await this.closeByRequester(requesterMemberId, requestId, "CANCELLED");
    return this.getRequest(requesterMemberId, requestId);
  }

  private async closeByRequester(
    requesterMemberId: string,
    requestId: string,
    reason: "FULFILLED" | "CANCELLED",
  ): Promise<void> {
    const now = this.clock.now();
    await this.db.$transaction(async (tx) => {
      const request = await tx.bloodSosRequest.findUnique({ where: { id: requestId } });
      if (request === null) throw new AppError("SOS_NOT_FOUND", 404);
      if (request.requesterMemberId !== requesterMemberId) {
        throw new AppError("SOS_NOT_REQUESTER", 403);
      }
      if (request.status !== "ACTIVE") throw new AppError("SOS_ALREADY_CLOSED", 409);
      await tx.bloodSosRequest.update({
        where: { id: requestId },
        data: {
          status: "CLOSED",
          closedAt: now,
          closedBy: requesterMemberId,
          closedReason: reason,
          ...(reason === "FULFILLED" ? { fulfilledAt: now } : {}),
        },
      });
    });
  }

  public async respond(
    donorMemberId: string,
    requestId: string,
  ): Promise<{ readonly id: string; readonly status: "RESPONDED" }> {
    if (!(await this.register.isActiveMember(donorMemberId))) {
      throw new AppError("UNAUTHENTICATED", 401);
    }
    const responseId = uuidv7();
    const requesterId = await this.db.$transaction(async (tx) => {
      const request = await tx.bloodSosRequest.findUnique({ where: { id: requestId } });
      if (request === null) throw new AppError("SOS_NOT_FOUND", 404);
      if (request.status !== "ACTIVE") throw new AppError("SOS_ALREADY_CLOSED", 409);
      if (request.requesterMemberId === donorMemberId) {
        throw new AppError("SOS_NOT_ALERTED", 403);
      }
      const alert = await tx.bloodSosAlert.findUnique({
        where: {
          requestId_donorMemberId: { requestId, donorMemberId },
        },
        select: { accepted: true },
      });
      if (!mayRespondToAlert(alert?.accepted ?? null)) throw new AppError("SOS_NOT_ALERTED", 403);
      try {
        await tx.bloodSosResponse.create({
          data: {
            id: responseId,
            requestId,
            donorMemberId,
            createdAt: this.clock.now(),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new AppError("SOS_ALREADY_RESPONDED", 409);
        throw error;
      }
      return request.requesterMemberId;
    });

    try {
      await this.notifications.enqueue(
        [requesterId],
        responseMessage(requestId),
      );
    } catch {
      // The persisted response remains authoritative when push delivery fails.
    }
    return { id: responseId, status: "RESPONDED" };
  }

  public async report(
    reporterMemberId: string,
    requestId: string,
    input: BloodSosReportInput,
  ): Promise<{ readonly id: string; readonly status: "REPORTED" }> {
    const request = await this.db.bloodSosRequest.findUnique({
      where: { id: requestId },
      select: { id: true },
    });
    if (request === null) throw new AppError("SOS_NOT_FOUND", 404);
    const report = await this.reports.create({
      requestId,
      reporterMemberId,
      reason: input.reason,
    });
    return { id: report.id, status: "REPORTED" };
  }

  public async snooze(
    memberId: string,
    input: BloodSosSnoozeInput,
  ): Promise<BloodSosDonorStatus> {
    if (!(await this.register.isActiveMember(memberId))) {
      throw new AppError("UNAUTHENTICATED", 401);
    }
    const now = this.clock.now();
    const until = input.until === undefined || input.until === null
      ? null
      : dateAtEndOfDay(input.until);
    if (until !== null && until.getTime() < now.getTime()) {
      throw new AppError("VALIDATION_FAILED", 400);
    }
    await this.db.donorPreference.upsert({
      where: { memberId },
      create: { memberId, snoozedAt: now, snoozeUntil: until },
      update: { snoozedAt: now, snoozeUntil: until },
    });
    return this.donorStatus(memberId);
  }

  public async unsnooze(memberId: string): Promise<BloodSosDonorStatus> {
    await this.db.donorPreference.updateMany({
      where: { memberId },
      data: { snoozedAt: null, snoozeUntil: null },
    });
    return this.donorStatus(memberId);
  }

  public async setLastDonation(
    memberId: string,
    input: BloodSosLastDonationInput,
  ): Promise<BloodSosDonorStatus> {
    if (!(await this.register.isActiveMember(memberId))) {
      throw new AppError("UNAUTHENTICATED", 401);
    }
    const donatedOn = input.donatedOn === null ? null : dateOnly(input.donatedOn);
    if (input.donatedOn !== null && input.donatedOn > this.clock.todayIst()) {
      throw new AppError("VALIDATION_FAILED", 400);
    }
    await this.db.donorPreference.upsert({
      where: { memberId },
      create: { memberId, lastDonatedOn: donatedOn },
      update: { lastDonatedOn: donatedOn },
    });
    return this.donorStatus(memberId);
  }

  public async donorStatus(memberId: string): Promise<BloodSosDonorStatus> {
    const projections = await this.register.project(memberId, [memberId]);
    const self = memberIdFromProjection(projections, memberId);
    const preference = await this.db.donorPreference.findUnique({ where: { memberId } });
    const now = this.clock.now();
    const today = this.clock.todayIst();
    const cooldown = inDonationCooldown(preference, today, this.config.donorCooldownDays);
    const consent = self.consents?.bloodGroupMatching === true;
    const active = await this.register.isActiveMember(memberId);
    const eligibleFrom = preference?.lastDonatedOn === null || preference?.lastDonatedOn === undefined
      ? null
      : dateOnlyString(addDays(preference.lastDonatedOn, this.config.donorCooldownDays));
    return {
      isDonor: active && consent && !snoozeActive(preference, now) && !cooldown,
      snoozeUntil: preference?.snoozeUntil?.toISOString() ?? null,
      lastDonatedOn: preference?.lastDonatedOn === null || preference?.lastDonatedOn === undefined
        ? null
        : dateOnlyString(preference.lastDonatedOn),
      eligibleFrom,
    };
  }

  public async expire(requestId: string): Promise<void> {
    const now = this.clock.now();
    await this.db.bloodSosRequest.updateMany({
      where: { id: requestId, status: "ACTIVE", expiresAt: { lte: now } },
      data: {
        status: "CLOSED",
        closedAt: now,
        closedBy: "SYSTEM",
        closedReason: "EXPIRED",
      },
    });
  }

  public async closeByOfficer(input: {
    readonly bloodSosId: string;
    readonly officerId: string;
    readonly reason: string;
  }): Promise<void> {
    const now = this.clock.now();
    await this.db.$transaction(async (tx) => {
      const request = await tx.bloodSosRequest.findUnique({ where: { id: input.bloodSosId } });
      if (request === null) throw new AppError("SOS_NOT_FOUND", 404);
      if (request.status !== "ACTIVE") throw new AppError("SOS_ALREADY_CLOSED", 409);
      await tx.bloodSosRequest.update({
        where: { id: input.bloodSosId },
        data: {
          status: "CLOSED",
          closedAt: now,
          closedBy: `OFFICER:${input.officerId}`,
          closedReason: "OFFICER",
        },
      });
      const entry: ProcessingEntry = {
        action: "BLOOD_SOS_REPORT_RESOLVED",
        subjectType: "BLOOD_SOS",
        subjectId: input.bloodSosId,
        actor: { kind: "OFFICER", id: input.officerId },
        reason: input.reason,
      };
      await this.officer.write(tx, entry);
    });
  }

  public async cancelForMember(
    tx: BloodSosTransaction,
    memberId: string,
    reason: Extract<SosClosedReason, "MEMBER_ERASED" | "MEMBER_ARCHIVED">,
  ): Promise<void> {
    const ownRequests = await tx.bloodSosRequest.findMany({
      where: { requesterMemberId: memberId },
      select: { id: true },
    });
    const ownRequestIds = ownRequests.map((request) => request.id);
    await tx.bloodSosRequest.updateMany({
      where: { requesterMemberId: memberId, status: "ACTIVE" },
      data: {
        status: "CLOSED",
        closedAt: this.clock.now(),
        closedBy: "SYSTEM",
        closedReason: reason,
      },
    });
    await tx.bloodSosAlert.deleteMany({
      where: {
        OR: [
          { donorMemberId: memberId },
          ...(ownRequestIds.length > 0 ? [{ requestId: { in: ownRequestIds } }] : []),
        ],
      },
    });
    await tx.bloodSosResponse.deleteMany({
      where: {
        OR: [
          { donorMemberId: memberId },
          ...(ownRequestIds.length > 0 ? [{ requestId: { in: ownRequestIds } }] : []),
        ],
      },
    });
    await tx.donorPreference.deleteMany({ where: { memberId } });
  }

  public async onMemberErased(tx: BloodSosTransaction, memberId: string): Promise<void> {
    await this.cancelForMember(tx, memberId, "MEMBER_ERASED");
  }

  public async onMemberArchived(tx: BloodSosTransaction, memberId: string): Promise<void> {
    await this.cancelForMember(tx, memberId, "MEMBER_ARCHIVED");
  }
}
