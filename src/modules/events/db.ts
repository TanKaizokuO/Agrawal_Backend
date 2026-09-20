export type EventStatusType = "UPCOMING" | "ONGOING" | "ENDED" | "CANCELLED";
export type PassStatusType = "ACTIVE" | "REVOKED";

export interface EventRow {
  readonly id: string;
  readonly title: string;
  readonly titleHi: string | null;
  readonly description: string | null;
  readonly descriptionHi: string | null;
  readonly venue: string;
  readonly venueCity: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly createdBy: string;
  readonly status: EventStatusType;
  readonly createdAt: Date;
}

export interface EventPassRow {
  readonly id: string;
  readonly eventId: string;
  readonly memberId: string;
  readonly familyId: string;
  readonly isHead: boolean;
  readonly minorsCount: number;
  readonly status: PassStatusType;
  readonly qrPayload: string;
  readonly issuedAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

export interface AdmissionRow {
  readonly id: string;
  readonly passId: string;
  readonly gateDeviceId: string;
  readonly scannedAt: Date;
  readonly scannedOffline: boolean;
}

export interface GateDeviceRow {
  readonly id: string;
  readonly eventId: string;
  readonly label: string;
  readonly registeredBy: string;
  readonly registeredAt: Date;
}

export interface EventWhereInput {
  readonly id?: string;
  readonly status?: EventStatusType | { readonly in: readonly EventStatusType[] };
}

export interface EventPassWhereInput {
  readonly id?: string;
  readonly eventId?: string;
  readonly memberId?: string;
  readonly status?: PassStatusType | { readonly in: readonly PassStatusType[] };
}

export interface AdmissionWhereInput {
  readonly id?: string;
  readonly passId?: string;
  readonly gateDeviceId?: string;
}

export interface GateDeviceWhereInput {
  readonly id?: string;
  readonly eventId?: string;
  readonly registeredBy?: string;
}

export interface EventDelegate {
  create(args: { readonly data: Record<string, unknown> }): Promise<EventRow>;
  findUnique(args: { readonly where: { readonly id: string } }): Promise<EventRow | null>;
  findMany(args?: {
    readonly where?: EventWhereInput;
    readonly orderBy?: Record<string, "asc" | "desc">;
    readonly take?: number;
    readonly skip?: number;
  }): Promise<readonly EventRow[]>;
  update(args: {
    readonly where: { readonly id: string };
    readonly data: Record<string, unknown>;
  }): Promise<EventRow>;
  count(args?: { readonly where?: EventWhereInput }): Promise<number>;
}

export interface EventPassDelegate {
  create(args: { readonly data: Record<string, unknown> }): Promise<EventPassRow>;
  findUnique(args: { readonly where: { readonly id: string } }): Promise<EventPassRow | null>;
  findFirst(args: { readonly where: EventPassWhereInput }): Promise<EventPassRow | null>;
  findMany(args?: {
    readonly where?: EventPassWhereInput;
    readonly orderBy?: Record<string, "asc" | "desc">;
    readonly take?: number;
    readonly skip?: number;
  }): Promise<readonly EventPassRow[]>;
  update(args: {
    readonly where: { readonly id: string };
    readonly data: Record<string, unknown>;
  }): Promise<EventPassRow>;
  updateMany(args: {
    readonly where: EventPassWhereInput;
    readonly data: Record<string, unknown>;
  }): Promise<{ readonly count: number }>;
  count(args?: { readonly where?: EventPassWhereInput }): Promise<number>;
}

export interface AdmissionDelegate {
  create(args: { readonly data: Record<string, unknown> }): Promise<AdmissionRow>;
  findMany(args?: {
    readonly where?: AdmissionWhereInput;
    readonly orderBy?: Record<string, "asc" | "desc">;
    readonly take?: number;
    readonly skip?: number;
  }): Promise<readonly AdmissionRow[]>;
}

export interface GateDeviceDelegate {
  create(args: { readonly data: Record<string, unknown> }): Promise<GateDeviceRow>;
  findUnique(args: { readonly where: { readonly id: string } }): Promise<GateDeviceRow | null>;
  findFirst(args: { readonly where: GateDeviceWhereInput }): Promise<GateDeviceRow | null>;
  findMany(args?: {
    readonly where?: GateDeviceWhereInput;
    readonly orderBy?: Record<string, "asc" | "desc">;
  }): Promise<readonly GateDeviceRow[]>;
}

export interface EventsTxClient {
  readonly event: EventDelegate;
  readonly eventPass: EventPassDelegate;
  readonly admission: AdmissionDelegate;
  readonly gateDevice: GateDeviceDelegate;
}

/**
 * The Events service talks to this narrow Prisma-compatible seam.  Keeping
 * the delegates here means tests can use an in-memory adapter and prevents
 * other modules from selecting the event tables directly.
 */
export interface EventsDatabase extends EventsTxClient {
  $transaction<T>(callback: (tx: EventsTxClient) => Promise<T>): Promise<T>;
}
