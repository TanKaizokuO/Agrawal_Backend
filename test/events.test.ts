import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FixedClock, type Clock } from "../src/clock.js";
import type { JobRuntime } from "../src/jobs.js";
import {
  deterministicPassPayload,
  EventsService,
  signEventPass,
  verifyEventPass,
  type AdmissionRow,
  type EventPassKeyPort,
  type EventPassRow,
  type EventPassSigningKey,
  type EventPassVerificationKey,
  type EventRole,
  type EventRow,
  type EventsDatabase,
  type EventsNotificationsPort,
  type EventsOfficerPort,
  type EventsRegisterPort,
  type EventsTxClient,
  type GateDeviceRow,
} from "../src/modules/events/index.js";
import type { MemberProjection } from "../src/modules/register/index.js";
const MEMBER_A = "018f4b7c-3a15-7f20-9f2c-0123456789ab";
const MEMBER_B = "018f4b7c-3a15-7f20-9f2c-0123456789ac";
const OTHER_ORGANISER = "018f4b7c-3a15-7f20-9f2c-0123456789ad";

function stringValue(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  if (typeof value !== "string") throw new Error(`Missing string ${key}`);
  return value;
}

function nullableStringValue(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Invalid string ${key}`);
  return value;
}

function dateValue(data: Record<string, unknown>, key: string): Date {
  const value = data[key];
  if (!(value instanceof Date)) throw new Error(`Missing date ${key}`);
  return value;
}

function optionalDateValue(data: Record<string, unknown>, key: string, fallback: Date): Date {
  const value = data[key];
  return value === undefined ? fallback : dateValue(data, key);
}

function booleanValue(data: Record<string, unknown>, key: string): boolean {
  const value = data[key];
  if (typeof value !== "boolean") throw new Error(`Missing boolean ${key}`);
  return value;
}

function numberValue(data: Record<string, unknown>, key: string): number {
  const value = data[key];
  if (typeof value !== "number") throw new Error(`Missing number ${key}`);
  return value;
}

function eventStatus(value: unknown): EventRow["status"] {
  if (value === "UPCOMING" || value === "ONGOING" || value === "ENDED" || value === "CANCELLED") return value;
  throw new Error("Invalid event status");
}

function passStatus(value: unknown): EventPassRow["status"] {
  if (value === "ACTIVE" || value === "REVOKED") return value;
  throw new Error("Invalid pass status");
}

class MemoryEventsDatabase implements EventsDatabase {
  readonly events: EventRow[] = [];
  readonly passes: EventPassRow[] = [];
  readonly admissions: AdmissionRow[] = [];
  readonly gates: GateDeviceRow[] = [];

  readonly event = {
    create: ({ data }: { readonly data: Record<string, unknown> }): Promise<EventRow> => {
      const row: EventRow = {
        id: stringValue(data, "id"),
        title: stringValue(data, "title"),
        titleHi: nullableStringValue(data, "titleHi"),
        description: nullableStringValue(data, "description"),
        descriptionHi: nullableStringValue(data, "descriptionHi"),
        venue: stringValue(data, "venue"),
        venueCity: stringValue(data, "venueCity"),
        startsAt: dateValue(data, "startsAt"),
        endsAt: dateValue(data, "endsAt"),
        createdBy: stringValue(data, "createdBy"),
        status: eventStatus(data.status),
        createdAt: dateValue(data, "createdAt"),
      };
      this.events.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { readonly where: { readonly id: string } }): Promise<EventRow | null> =>
      Promise.resolve(this.events.find((event) => event.id === where.id) ?? null),
    findMany: (args?: { readonly where?: { readonly status?: EventRow["status"] | { readonly in: readonly EventRow["status"][] } }; readonly take?: number; readonly skip?: number }): Promise<readonly EventRow[]> => {
      const where = args?.where;
      const filtered = this.events.filter((event) => {
        if (where?.status === undefined) return true;
        return typeof where.status === "string" ? event.status === where.status : where.status.in.includes(event.status);
      });
      const offset = args?.skip ?? 0;
      return Promise.resolve(filtered.slice(offset, args?.take === undefined ? undefined : offset + args.take));
    },
    update: ({ where, data }: { readonly where: { readonly id: string }; readonly data: Record<string, unknown> }): Promise<EventRow> => {
      const index = this.events.findIndex((event) => event.id === where.id);
      if (index < 0) throw new Error("event missing");
      const current = this.events[index];
      if (current === undefined) throw new Error("event missing");
      const next: EventRow = {
        ...current,
        title: typeof data.title === "string" ? data.title : current.title,
        titleHi: data.titleHi === null || typeof data.titleHi === "string" ? data.titleHi : current.titleHi,
        description: data.description === null || typeof data.description === "string" ? data.description : current.description,
        descriptionHi: data.descriptionHi === null || typeof data.descriptionHi === "string" ? data.descriptionHi : current.descriptionHi,
        venue: typeof data.venue === "string" ? data.venue : current.venue,
        venueCity: typeof data.venueCity === "string" ? data.venueCity : current.venueCity,
        startsAt: optionalDateValue(data, "startsAt", current.startsAt),
        endsAt: optionalDateValue(data, "endsAt", current.endsAt),
        status: data.status === undefined ? current.status : eventStatus(data.status),
      };
      this.events[index] = next;
      return Promise.resolve(next);
    },
    count: ({ where }: { readonly where?: { readonly id?: string } } = {}): Promise<number> =>
      Promise.resolve(where?.id === undefined ? this.events.length : this.events.filter((event) => event.id === where.id).length),
  };

  readonly eventPass = {
    create: ({ data }: { readonly data: Record<string, unknown> }): Promise<EventPassRow> => {
      const row: EventPassRow = {
        id: stringValue(data, "id"),
        eventId: stringValue(data, "eventId"),
        memberId: stringValue(data, "memberId"),
        familyId: stringValue(data, "familyId"),
        isHead: booleanValue(data, "isHead"),
        minorsCount: numberValue(data, "minorsCount"),
        status: passStatus(data.status),
        qrPayload: stringValue(data, "qrPayload"),
        issuedAt: dateValue(data, "issuedAt"),
        revokedAt: data.revokedAt === null ? null : dateValue(data, "revokedAt"),
        revokedReason: nullableStringValue(data, "revokedReason"),
      };
      if (this.passes.some((pass) => pass.eventId === row.eventId && pass.memberId === row.memberId)) {
        const error = new Error("duplicate");
        Object.assign(error, { code: "P2002" });
        throw error;
      }
      this.passes.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { readonly where: { readonly id: string } }): Promise<EventPassRow | null> =>
      Promise.resolve(this.passes.find((pass) => pass.id === where.id) ?? null),
    findFirst: ({ where }: { readonly where: { readonly eventId?: string; readonly memberId?: string; readonly id?: string; readonly status?: EventPassRow["status"] } }): Promise<EventPassRow | null> =>
      Promise.resolve(this.passes.find((pass) =>
        (where.id === undefined || pass.id === where.id) &&
        (where.eventId === undefined || pass.eventId === where.eventId) &&
        (where.memberId === undefined || pass.memberId === where.memberId) &&
        (where.status === undefined || pass.status === where.status),
      ) ?? null),
    findMany: (args?: { readonly where?: { readonly eventId?: string; readonly memberId?: string; readonly status?: EventPassRow["status"] }; readonly orderBy?: Record<string, "asc" | "desc"> }): Promise<readonly EventPassRow[]> => {
      const where = args?.where;
      const rows = this.passes.filter((pass) =>
        (where?.eventId === undefined || pass.eventId === where.eventId) &&
        (where?.memberId === undefined || pass.memberId === where.memberId) &&
        (where?.status === undefined || pass.status === where.status),
      );
      return Promise.resolve(args?.orderBy?.issuedAt === "desc" ? [...rows].reverse() : rows);
    },
    update: ({ where, data }: { readonly where: { readonly id: string }; readonly data: Record<string, unknown> }): Promise<EventPassRow> => {
      const index = this.passes.findIndex((pass) => pass.id === where.id);
      if (index < 0) throw new Error("pass missing");
      const current = this.passes[index];
      if (current === undefined) throw new Error("pass missing");
      const next: EventPassRow = {
        ...current,
        status: data.status === undefined ? current.status : passStatus(data.status),
        qrPayload: typeof data.qrPayload === "string" ? data.qrPayload : current.qrPayload,
        revokedAt: data.revokedAt === undefined ? current.revokedAt : dateValue(data, "revokedAt"),
        revokedReason: data.revokedReason === undefined ? current.revokedReason : nullableStringValue(data, "revokedReason"),
      };
      this.passes[index] = next;
      return Promise.resolve(next);
    },
    updateMany: ({ where, data }: { readonly where: { readonly eventId?: string; readonly memberId?: string; readonly status?: EventPassRow["status"] }; readonly data: Record<string, unknown> }): Promise<{ readonly count: number }> => {
      let count = 0;
      for (let index = 0; index < this.passes.length; index += 1) {
        const current = this.passes[index];
        if (current === undefined) continue;
        if (where.eventId !== undefined && current.eventId !== where.eventId) continue;
        if (where.memberId !== undefined && current.memberId !== where.memberId) continue;
        if (where.status !== undefined && current.status !== where.status) continue;
        this.passes[index] = {
          ...current,
          status: data.status === undefined ? current.status : passStatus(data.status),
          revokedAt: data.revokedAt === undefined ? current.revokedAt : dateValue(data, "revokedAt"),
          revokedReason: data.revokedReason === undefined ? current.revokedReason : nullableStringValue(data, "revokedReason"),
        };
        count += 1;
      }
      return Promise.resolve({ count });
    },
    count: ({ where }: { readonly where?: { readonly eventId?: string; readonly memberId?: string; readonly status?: EventPassRow["status"] } } = {}): Promise<number> =>
      Promise.resolve(this.passes.filter((pass) =>
        (where?.eventId === undefined || pass.eventId === where.eventId) &&
        (where?.memberId === undefined || pass.memberId === where.memberId) &&
        (where?.status === undefined || pass.status === where.status),
      ).length),
  };

  readonly admission = {
    create: ({ data }: { readonly data: Record<string, unknown> }): Promise<AdmissionRow> => {
      const passId = stringValue(data, "passId");
      const gateDeviceId = stringValue(data, "gateDeviceId");
      const scannedAt = dateValue(data, "scannedAt");
      if (this.admissions.some((row) => row.passId === passId && row.gateDeviceId === gateDeviceId && row.scannedAt.getTime() === scannedAt.getTime())) {
        const error = new Error("duplicate");
        Object.assign(error, { code: "P2002" });
        throw error;
      }
      const row: AdmissionRow = {
        id: stringValue(data, "id"),
        passId,
        gateDeviceId,
        scannedAt,
        scannedOffline: data.scannedOffline === true,
      };
      this.admissions.push(row);
      return Promise.resolve(row);
    },
    findMany: (args?: { readonly where?: { readonly passId?: string }; readonly orderBy?: Record<string, "asc" | "desc"> }): Promise<readonly AdmissionRow[]> => {
      const rows = this.admissions.filter((row) => args?.where?.passId === undefined || row.passId === args.where.passId);
      return Promise.resolve(args?.orderBy?.scannedAt === "asc" ? [...rows].sort((left, right) => left.scannedAt.getTime() - right.scannedAt.getTime()) : rows);
    },
  };

  readonly gateDevice = {
    create: ({ data }: { readonly data: Record<string, unknown> }): Promise<GateDeviceRow> => {
      const row: GateDeviceRow = {
        id: stringValue(data, "id"),
        eventId: stringValue(data, "eventId"),
        label: stringValue(data, "label"),
        registeredBy: stringValue(data, "registeredBy"),
        registeredAt: dateValue(data, "registeredAt"),
      };
      this.gates.push(row);
      return Promise.resolve(row);
    },
    findUnique: ({ where }: { readonly where: { readonly id: string } }): Promise<GateDeviceRow | null> =>
      Promise.resolve(this.gates.find((gate) => gate.id === where.id) ?? null),
    findFirst: ({ where }: { readonly where: { readonly id?: string; readonly eventId?: string; readonly registeredBy?: string } }): Promise<GateDeviceRow | null> =>
      Promise.resolve(this.gates.find((gate) =>
        (where.id === undefined || gate.id === where.id) &&
        (where.eventId === undefined || gate.eventId === where.eventId) &&
        (where.registeredBy === undefined || gate.registeredBy === where.registeredBy),
      ) ?? null),
    findMany: (): Promise<readonly GateDeviceRow[]> => Promise.resolve(this.gates),
  };

  $transaction<T>(callback: (tx: EventsTxClient) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

class TestRegister implements EventsRegisterPort {
  readonly active = new Set([MEMBER_A, MEMBER_B]);
  readonly heads = new Set([MEMBER_A]);
  readonly erased: Array<(tx: EventsTxClient, memberId: string) => Promise<void>> = [];
  readonly archived: Array<(tx: EventsTxClient, memberId: string) => Promise<void>> = [];

  isActiveMember(memberId: string): Promise<boolean> { return Promise.resolve(this.active.has(memberId)); }
  isHeadOf(memberId: string): Promise<boolean> { return Promise.resolve(this.heads.has(memberId)); }
  familyOf(memberId: string): Promise<{ familyId: string; publicId: string; gotra: "GARG"; headMemberId: string } | null> {
    if (!this.active.has(memberId)) return Promise.resolve(null);
    return Promise.resolve({ familyId: `family-${memberId}`, publicId: `AGR-492001-00001`, gotra: "GARG", headMemberId: MEMBER_A });
  }
  project(_viewerMemberId: string, memberIds: readonly string[]): Promise<ReadonlyMap<string, MemberProjection>> {
    return Promise.resolve(new Map(memberIds.map((memberId) => [memberId, {
      memberId,
      familyPublicId: "AGR-492001-00001",
      isHead: this.heads.has(memberId),
      name: { en: memberId === MEMBER_A ? "Head Member" : "Member Two", hi: null },
    }])));
  }
  onMemberErased(handler: (tx: EventsTxClient, memberId: string) => Promise<void>): void { this.erased.push(handler); }
  onMemberArchived(handler: (tx: EventsTxClient, memberId: string) => Promise<void>): void { this.archived.push(handler); }
}

class TestJobs implements JobRuntime {
  readonly enabled = true;
  readonly sent: Array<{ name: string; payload: unknown }> = [];
  start(): Promise<void> { return Promise.resolve(); }
  stop(): Promise<void> { return Promise.resolve(); }
  isReady(): Promise<boolean> { return Promise.resolve(true); }
  send(name: string, payload: unknown): Promise<string> {
    this.sent.push({ name, payload });
    return Promise.resolve(`job-${String(this.sent.length)}`);
  }
  registerWorker(): Promise<void> { return Promise.resolve(); }
}

class TestNotifications implements EventsNotificationsPort {
  readonly sent: Array<{ memberIds: readonly string[]; subjectId: string }> = [];
  enqueue(memberIds: readonly string[], message: { readonly subjectId: string }): Promise<string> {
    this.sent.push({ memberIds, subjectId: message.subjectId });
    return Promise.resolve(`notification-${String(this.sent.length)}`);
  }
}

class TestOfficer implements EventsOfficerPort {
  readonly entries: string[] = [];
  write(_tx: EventsTxClient, entry: { readonly subjectId: string }): Promise<void> {
    this.entries.push(entry.subjectId);
    return Promise.resolve();
  }
}

function keys(): { signing: EventPassSigningKey; verification: EventPassVerificationKey } {
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" });
  return { signing: { kid: "1", privateKeyPem }, verification: { kid: "1", publicKeyPem } };
}

function makeService(now = new Date("2026-09-19T10:00:00.000Z")) {
  const database = new MemoryEventsDatabase();
  const register = new TestRegister();
  const jobs = new TestJobs();
  const notifications = new TestNotifications();
  const officer = new TestOfficer();
  const keySet = keys();
  const signingKeys: EventPassKeyPort = {
    getSigningKey(): Promise<EventPassSigningKey> { return Promise.resolve(keySet.signing); },
    getVerificationKeys(): Promise<readonly EventPassVerificationKey[]> { return Promise.resolve([keySet.verification]); },
  };
  const clock: Clock = new FixedClock(now);
  return {
    service: new EventsService({ db: database, clock, jobs, register, notifications, officer, signingKeys }),
    database,
    register,
    jobs,
    notifications,
    keySet,
    clock,
  };
}

function createFutureEvent(service: EventsService, actor: { memberId: string; roles: readonly EventRole[] } = { memberId: MEMBER_A, roles: ["ORGANISER"] }): Promise<EventRow> {
  return service.createEvent(actor, {
    title: "Jayanti",
    venue: "Community Hall",
    venueCity: "Jaipur",
    startsAt: new Date("2026-09-20T10:00:00.000Z"),
    endsAt: new Date("2026-09-20T14:00:00.000Z"),
  });
}

describe("Events pass protocol", () => {
  it("rejects tampering, expiry and manifest revocation", () => {
    const keySet = keys();
    const payload = { p: "pass", e: "event", m: "member", h: true, c: 2, n: "Ramesh", x: 1_728_648_000 } as const;
    const qrPayload = signEventPass(payload, keySet.signing);
    expect(verifyEventPass(qrPayload, [keySet.verification], { now: new Date("2024-10-10T00:00:00.000Z") })).toMatchObject({ valid: true });

    const pieces = qrPayload.split(".");
    const decoded = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(pieces[1] ?? "", "base64url").toString("utf8")));
    if (pieces[0] === undefined || pieces[2] === undefined) throw new Error("Malformed test payload");
    const tampered = `${pieces[0]}.${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}.${pieces[2]}`;
    expect(verifyEventPass(tampered, [keySet.verification])).toEqual({ valid: false, reason: "BAD_SIGNATURE" });
    expect(verifyEventPass(qrPayload, [keySet.verification], { now: new Date("2024-10-11T00:00:00.000Z") })).toEqual({ valid: false, reason: "EXPIRED" });
    expect(verifyEventPass(qrPayload, [keySet.verification], { now: new Date(1_728_648_000 * 1000) })).toEqual({ valid: false, reason: "EXPIRED" });
    expect(verifyEventPass(qrPayload, [keySet.verification], { revokedPassIds: new Set(["pass"]), now: new Date("2024-10-10T00:00:00.000Z") })).toEqual({ valid: false, reason: "REVOKED" });
    expect(deterministicPassPayload(payload)).toContain('"n":"Ramesh"');
  });

  it("re-signs every active pass when endsAt changes", async () => {
    const test = makeService();
    const event = await createFutureEvent(test.service);
    const original = await test.service.claimPass(MEMBER_A, event.id, 2);
    const changed = await test.service.updateEvent(
      { memberId: MEMBER_A, roles: ["ORGANISER"] },
      event.id,
      { endsAt: new Date("2026-09-20T16:00:00.000Z") },
    );
    const pass = await test.service.getMyPass(MEMBER_A, event.id);
    expect(pass?.qrPayload).not.toBe(original.qrPayload);
    expect(changed.endsAt.toISOString()).toBe("2026-09-20T16:00:00.000Z");
    const verified = await test.service.verifyPass(pass?.qrPayload ?? "", { eventId: event.id, now: new Date("2026-09-20T15:00:00.000Z") });
    expect(verified).toMatchObject({ valid: true, payload: { x: 1_789_920_000 } });
    expect(test.notifications.sent.map((entry) => entry.subjectId)).toContain(event.id);
  });

  it("publishes revocations only after a refreshed manifest", async () => {
    const test = makeService();
    const event = await createFutureEvent(test.service);
    const pass = await test.service.claimPass(MEMBER_A, event.id, 0);
    const actor = { memberId: MEMBER_A, roles: ["ORGANISER"] as const };
    const before = await test.service.gateManifest(actor, event.id);
    await test.service.revokePass(pass.id, { memberId: OTHER_ORGANISER }, "abuse");
    const after = await test.service.gateManifest(actor, event.id);
    expect(before.revokedPassIds).not.toContain(pass.id);
    expect(after.revokedPassIds).toContain(pass.id);
    expect(await test.service.verifyPass(pass.qrPayload, { eventId: event.id, revokedPassIds: new Set(before.revokedPassIds), now: new Date("2026-09-19T10:00:00.000Z") })).toMatchObject({ valid: true });
    expect(await test.service.verifyPass(pass.qrPayload, { eventId: event.id, revokedPassIds: new Set(after.revokedPassIds), now: new Date("2026-09-19T10:00:00.000Z") })).toEqual({ valid: false, reason: "REVOKED" });
  });

  it("isolates gate devices by event and makes scan replay idempotent", async () => {
    const test = makeService();
    const actor = { memberId: MEMBER_A, roles: ["ORGANISER"] as const };
    const eventA = await createFutureEvent(test.service, actor);
    const eventB = await test.service.createEvent(actor, {
      title: "Other event",
      venue: "Other Hall",
      venueCity: "Jaipur",
      startsAt: new Date("2026-09-21T10:00:00.000Z"),
      endsAt: new Date("2026-09-21T14:00:00.000Z"),
    });
    const gateA = await test.service.registerGateDevice(actor, eventA.id, "Gate A");
    const gateB = await test.service.registerGateDevice(actor, eventB.id, "Gate B");
    const pass = await test.service.claimPass(MEMBER_A, eventA.id, 0);
    const scannedAt = new Date("2026-09-20T10:01:00.000Z");
    await expect(test.service.syncAdmissions(actor, eventA.id, gateB.gateDevice.id, [{ passId: pass.id, scannedAt }])).rejects.toMatchObject({ code: "GATE_DEVICE_NOT_FOR_EVENT" });
    await expect(test.service.syncAdmissions(actor, eventA.id, gateA.gateDevice.id, [{ passId: pass.id, scannedAt }, { passId: pass.id, scannedAt }])).resolves.toMatchObject({ synced: 1 });
    const secondGate = await test.service.registerGateDevice(actor, eventA.id, "Gate C");
    const duplicate = await test.service.syncAdmissions(actor, eventA.id, secondGate.gateDevice.id, [{ passId: pass.id, scannedAt: new Date(scannedAt.getTime() + 60_000) }]);
    expect(duplicate.duplicates).toHaveLength(1);
    expect(duplicate.duplicates[0]?.passId).toBe(pass.id);
  });

  it("does not count minors on a non-head Member's pass", async () => {
    const test = makeService();
    const event = await createFutureEvent(test.service);
    const pass = await test.service.claimPass(MEMBER_B, event.id, 20);
    expect(pass.isHead).toBe(false);
    expect(pass.minorsCount).toBe(0);
  });
});
