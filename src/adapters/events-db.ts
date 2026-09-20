import {
  type EventStatus,
  type PassStatus,
  Prisma,
  type PrismaClient,
} from "../generated/prisma/client.js";
import type {
  AdmissionDelegate,
  AdmissionRow,
  AdmissionWhereInput,
  EventDelegate,
  EventPassDelegate,
  EventPassRow,
  EventPassWhereInput,
  EventRow,
  EventWhereInput,
  EventsDatabase,
  EventsRegisterPort,
  EventsTxClient,
  GateDeviceDelegate,
  GateDeviceRow,
  GateDeviceWhereInput,
} from "../modules/events/index.js";
import type { RegisterService } from "../modules/register/index.js";

function eventStatus(value: unknown): EventStatus {
  if (value === "UPCOMING" || value === "ONGOING" || value === "ENDED" || value === "CANCELLED") return value;
  throw new Error("Invalid event status");
}

function passStatus(value: unknown): PassStatus {
  if (value === "ACTIVE" || value === "REVOKED") return value;
  throw new Error("Invalid pass status");
}

function stringValue(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string") throw new Error(`Event data ${key} must be a string`);
  return value;
}

function dateValue(data: Record<string, unknown>, key: string): Date {
  const value = data[key];
  if (!(value instanceof Date)) throw new Error(`Event data ${key} must be a Date`);
  return value;
}

function boolValue(data: Record<string, unknown>, key: string): boolean {
  const value = data[key];
  if (typeof value !== "boolean") throw new Error(`Event data ${key} must be boolean`);
  return value;
}

function intValue(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Event data ${key} must be an integer`);
  return value;
}

function eventData(data: Record<string, unknown>): Prisma.EventUncheckedCreateInput {
  return {
    id: stringValue(data, "id"),
    title: stringValue(data, "title"),
    titleHi: typeof data.titleHi === "string" ? data.titleHi : null,
    description: typeof data.description === "string" ? data.description : null,
    descriptionHi: typeof data.descriptionHi === "string" ? data.descriptionHi : null,
    venue: stringValue(data, "venue"),
    venueCity: stringValue(data, "venueCity"),
    startsAt: dateValue(data, "startsAt"),
    endsAt: dateValue(data, "endsAt"),
    createdBy: stringValue(data, "createdBy"),
    status: eventStatus(data.status ?? "UPCOMING"),
    ...(data.createdAt instanceof Date ? { createdAt: data.createdAt } : {}),
  };
}

function passData(data: Record<string, unknown>): Prisma.EventPassUncheckedCreateInput {
  return {
    id: stringValue(data, "id"),
    eventId: stringValue(data, "eventId"),
    memberId: stringValue(data, "memberId"),
    familyId: stringValue(data, "familyId"),
    isHead: boolValue(data, "isHead"),
    minorsCount: intValue(data, "minorsCount"),
    qrPayload: stringValue(data, "qrPayload"),
    revokedAt: data.revokedAt instanceof Date ? data.revokedAt : null,
    status: passStatus(data.status ?? "ACTIVE"),
    ...(data.issuedAt instanceof Date ? { issuedAt: data.issuedAt } : {}),
  };
}

function admissionData(data: Record<string, unknown>): Prisma.AdmissionUncheckedCreateInput {
  return {
    id: stringValue(data, "id"),
    passId: stringValue(data, "passId"),
    gateDeviceId: stringValue(data, "gateDeviceId"),
    scannedAt: dateValue(data, "scannedAt"),
    scannedOffline: boolValue(data, "scannedOffline"),
  };
}

function gateData(data: Record<string, unknown>): Prisma.GateDeviceUncheckedCreateInput {
  return {
    id: stringValue(data, "id"),
    eventId: stringValue(data, "eventId"),
    label: stringValue(data, "label"),
    registeredBy: stringValue(data, "registeredBy"),
    ...(data.registeredAt instanceof Date ? { registeredAt: data.registeredAt } : {}),
  };
}

function eventWhere(where?: EventWhereInput): Prisma.EventWhereInput | undefined {
  if (where === undefined) return undefined;
  const result: Prisma.EventWhereInput = {};
  if (where.id !== undefined) {
    result.id = where.id;
  }
  if (where.status !== undefined) {
    if (typeof where.status === "string") {
      result.status = eventStatus(where.status);
    } else {
      result.status = { in: [...where.status.in].map(eventStatus) };
    }
  }
  return result;
}

function passWhere(where?: EventPassWhereInput): Prisma.EventPassWhereInput | undefined {
  if (where === undefined) return undefined;
  const result: Prisma.EventPassWhereInput = {};
  if (where.id !== undefined) {
    result.id = where.id;
  }
  if (where.eventId !== undefined) {
    result.eventId = where.eventId;
  }
  if (where.memberId !== undefined) {
    result.memberId = where.memberId;
  }
  if (where.status !== undefined) {
    if (typeof where.status === "string") {
      result.status = passStatus(where.status);
    } else {
      result.status = { in: [...where.status.in].map(passStatus) };
    }
  }
  return result;
}

function admissionWhere(where?: AdmissionWhereInput): Prisma.AdmissionWhereInput | undefined {
  if (where === undefined) return undefined;
  const result: Prisma.AdmissionWhereInput = {};
  if (where.id !== undefined) result.id = where.id;
  if (where.passId !== undefined) result.passId = where.passId;
  if (where.gateDeviceId !== undefined) result.gateDeviceId = where.gateDeviceId;
  return result;
}

function gateDeviceWhere(where?: GateDeviceWhereInput): Prisma.GateDeviceWhereInput | undefined {
  if (where === undefined) return undefined;
  const result: Prisma.GateDeviceWhereInput = {};
  if (where.id !== undefined) result.id = where.id;
  if (where.eventId !== undefined) result.eventId = where.eventId;
  if (where.registeredBy !== undefined) result.registeredBy = where.registeredBy;
  return result;
}

function eventUpdate(data: Record<string, unknown>): Prisma.EventUncheckedUpdateInput {
  const result: Prisma.EventUncheckedUpdateInput = {};
  if (typeof data.title === "string") result.title = data.title;
  if (typeof data.titleHi === "string") result.titleHi = data.titleHi;
  else if (data.titleHi === null) result.titleHi = null;
  if (typeof data.description === "string") result.description = data.description;
  else if (data.description === null) result.description = null;
  if (typeof data.descriptionHi === "string") result.descriptionHi = data.descriptionHi;
  else if (data.descriptionHi === null) result.descriptionHi = null;
  if (typeof data.venue === "string") result.venue = data.venue;
  if (typeof data.venueCity === "string") result.venueCity = data.venueCity;
  if (data.startsAt instanceof Date) result.startsAt = data.startsAt;
  if (data.endsAt instanceof Date) result.endsAt = data.endsAt;
  if (data.status !== undefined) result.status = eventStatus(data.status);
  return result;
}

function passUpdate(data: Record<string, unknown>): Prisma.EventPassUncheckedUpdateInput {
  const result: Prisma.EventPassUncheckedUpdateInput = {};
  if (typeof data.qrPayload === "string") result.qrPayload = data.qrPayload;
  if (data.status !== undefined) result.status = passStatus(data.status);
  if (data.revokedAt instanceof Date) result.revokedAt = data.revokedAt;
  else if (data.revokedAt === null) result.revokedAt = null;
  if (typeof data.revokedReason === "string") result.revokedReason = data.revokedReason;
  else if (data.revokedReason === null) result.revokedReason = null;
  return result;
}

function passUpdateMany(data: Record<string, unknown>): Prisma.EventPassUncheckedUpdateManyInput {
  const result: Prisma.EventPassUncheckedUpdateManyInput = {};
  if (typeof data.qrPayload === "string") result.qrPayload = data.qrPayload;
  if (data.status !== undefined) result.status = passStatus(data.status);
  if (data.revokedAt instanceof Date) result.revokedAt = data.revokedAt;
  else if (data.revokedAt === null) result.revokedAt = null;
  if (typeof data.revokedReason === "string") result.revokedReason = data.revokedReason;
  else if (data.revokedReason === null) result.revokedReason = null;
  return result;
}

function rowEvent(row: EventRow): EventRow { return row; }
function rowPass(row: EventPassRow): EventPassRow { return row; }
function rowAdmission(row: AdmissionRow): AdmissionRow { return row; }
function rowGate(row: GateDeviceRow): GateDeviceRow { return row; }

export class PrismaEventsTx implements EventsTxClient {
  public readonly processingRecord: Pick<Prisma.TransactionClient, "processingRecord">["processingRecord"];
  public readonly rawTx: Prisma.TransactionClient | undefined;
  public readonly event: EventDelegate;
  public readonly eventPass: EventPassDelegate;
  public readonly admission: AdmissionDelegate;
  public readonly gateDevice: GateDeviceDelegate;

  public constructor(
    private readonly raw: Pick<PrismaClient, "event" | "eventPass" | "admission" | "gateDevice" | "processingRecord">,
    rawTx?: Prisma.TransactionClient,
  ) {
    this.rawTx = rawTx;
    this.processingRecord = raw.processingRecord;
    this.event = {
      create: async ({ data }) => rowEvent(await this.raw.event.create({ data: eventData(data) })),
      findUnique: async ({ where }) => {
        const row = await this.raw.event.findUnique({ where: { id: where.id } });
        return row === null ? null : rowEvent(row);
      },
      findMany: async (args) => {
        const where = eventWhere(args?.where);
        const rows = await this.raw.event.findMany({
          ...(where === undefined ? {} : { where }),
          ...(args?.orderBy === undefined ? {} : { orderBy: args.orderBy }),
          ...(args?.take === undefined ? {} : { take: args.take }),
          ...(args?.skip === undefined ? {} : { skip: args.skip }),
        });
        return rows.map(rowEvent);
      },
      update: async ({ where, data }) => rowEvent(await this.raw.event.update({ where: { id: where.id }, data: eventUpdate(data) })),
      count: async (args) => {
        const where = eventWhere(args?.where);
        return this.raw.event.count({
          ...(where === undefined ? {} : { where }),
        });
      },
    };
    this.eventPass = {
      create: async ({ data }) => rowPass(await this.raw.eventPass.create({ data: passData(data) })),
      findUnique: async ({ where }) => {
        const row = await this.raw.eventPass.findUnique({ where: { id: where.id } });
        return row === null ? null : rowPass(row);
      },
      findFirst: async ({ where }) => {
        const whereInput = passWhere(where);
        const row = await this.raw.eventPass.findFirst({
          ...(whereInput === undefined ? {} : { where: whereInput }),
        });
        return row === null ? null : rowPass(row);
      },
      findMany: async (args) => {
        const where = passWhere(args?.where);
        const rows = await this.raw.eventPass.findMany({
          ...(where === undefined ? {} : { where }),
          ...(args?.orderBy === undefined ? {} : { orderBy: args.orderBy }),
          ...(args?.take === undefined ? {} : { take: args.take }),
          ...(args?.skip === undefined ? {} : { skip: args.skip }),
        });
        return rows.map(rowPass);
      },
      update: async ({ where, data }) => rowPass(await this.raw.eventPass.update({ where: { id: where.id }, data: passUpdate(data) })),
      updateMany: async ({ where, data }) => {
        const whereInput = passWhere(where);
        return this.raw.eventPass.updateMany({
          ...(whereInput === undefined ? {} : { where: whereInput }),
          data: passUpdateMany(data),
        });
      },
      count: async (args) => {
        const where = passWhere(args?.where);
        return this.raw.eventPass.count({
          ...(where === undefined ? {} : { where }),
        });
      },
    };
    this.admission = {
      create: async ({ data }) => rowAdmission(await this.raw.admission.create({ data: admissionData(data) })),
      findMany: async (args) => {
        const where = admissionWhere(args?.where);
        const rows = await this.raw.admission.findMany({
          ...(where === undefined ? {} : { where }),
          ...(args?.orderBy === undefined ? {} : { orderBy: args.orderBy }),
          ...(args?.take === undefined ? {} : { take: args.take }),
          ...(args?.skip === undefined ? {} : { skip: args.skip }),
        });
        return rows.map(rowAdmission);
      },
    };
    this.gateDevice = {
      create: async ({ data }) => rowGate(await this.raw.gateDevice.create({ data: gateData(data) })),
      findUnique: async ({ where }) => {
        const row = await this.raw.gateDevice.findUnique({ where: { id: where.id } });
        return row === null ? null : rowGate(row);
      },
      findFirst: async ({ where }) => {
        const whereInput = gateDeviceWhere(where);
        const row = await this.raw.gateDevice.findFirst({
          ...(whereInput === undefined ? {} : { where: whereInput }),
        });
        return row === null ? null : rowGate(row);
      },
      findMany: async (args) => {
        const where = gateDeviceWhere(args?.where);
        const rows = await this.raw.gateDevice.findMany({
          ...(where === undefined ? {} : { where }),
        });
        return rows.map(rowGate);
      },
    };
  }
}

export class PrismaEventsDatabase implements EventsDatabase {
  public readonly event: EventDelegate;
  public readonly eventPass: EventPassDelegate;
  public readonly admission: AdmissionDelegate;
  public readonly gateDevice: GateDeviceDelegate;

  public constructor(private readonly raw: PrismaClient) {
    const tx = new PrismaEventsTx(this.raw);
    this.event = tx.event;
    this.eventPass = tx.eventPass;
    this.admission = tx.admission;
    this.gateDevice = tx.gateDevice;
  }

  public async $transaction<T>(callback: (tx: EventsTxClient) => Promise<T>): Promise<T> {
    return this.raw.$transaction((tx) => callback(new PrismaEventsTx(tx, tx)));
  }
}

export function createEventsDatabase(raw: PrismaClient): EventsDatabase {
  return new PrismaEventsDatabase(raw);
}

export function createEventsRegisterAdapter(register: RegisterService): EventsRegisterPort {
  return {
    isActiveMember: (memberId) => register.isActiveMember(memberId),
    isHeadOf: (memberId) => register.isHeadOf(memberId),
    familyOf: (memberId) => register.familyOf(memberId),
    project: (viewerMemberId, memberIds) => register.project(viewerMemberId, memberIds),
    onMemberErased: (handler) => {
      register.onMemberErased(async (prismaTx, memberId) => {
        await handler(new PrismaEventsTx(prismaTx, prismaTx), memberId);
      });
    },
    onMemberArchived: (handler) => {
      register.onMemberArchived(async (prismaTx, memberId) => {
        await handler(new PrismaEventsTx(prismaTx, prismaTx), memberId);
      });
    },
  };
}
