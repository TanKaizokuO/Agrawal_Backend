import type {
  LocalizedPushMessage,
} from "../notifications/index.js";
import type { MemberProjection } from "../register/index.js";
import type {
  ProcessingActor,
  ProcessingMetadata,
} from "../officer/index.js";
import type { EventsTxClient } from "./db.js";
export interface EventPassSigningKey {
  readonly kid: string;
  /** The key port decrypts this value before returning it to the signer. */
  readonly privateKeyPem: string;
}

export interface EventPassVerificationKey {
  readonly kid: string;
  readonly publicKeyPem: string;
}

/**
 * Key material is deliberately not read from process.env by Events.  The
 * implementation may decrypt KMS/Secrets Manager material on each call.
 */
export interface EventPassKeyPort {
  getSigningKey(): Promise<EventPassSigningKey>;
  getVerificationKeys(): Promise<readonly EventPassVerificationKey[]>;
}

export interface EventsRegisterPort {
  isActiveMember(memberId: string): Promise<boolean>;
  isHeadOf(memberId: string): Promise<boolean>;
  familyOf(memberId: string): Promise<{
    readonly familyId: string;
    readonly publicId: string;
    readonly gotra: string;
    readonly headMemberId: string | null;
  } | null>;
  project(
    viewerMemberId: string,
    memberIds: readonly string[],
  ): Promise<ReadonlyMap<string, MemberProjection>>;
  onMemberErased(handler: (tx: EventsTxClient, memberId: string) => Promise<void>): void;
  onMemberArchived(handler: (tx: EventsTxClient, memberId: string) => Promise<void>): void;
}

export interface EventsOfficerPort {
  write(
    tx: EventsTxClient,
    entry: {
      readonly action: "PASS_REVOKED";
      readonly subjectType: "EVENT_PASS";
      readonly subjectId: string;
      readonly actor: ProcessingActor;
      readonly reason?: string;
      readonly metadata?: ProcessingMetadata;
    },
  ): Promise<void>;
}

export interface EventsNotificationsPort {
  enqueue(
    memberIds: readonly string[],
    message: LocalizedPushMessage,
  ): Promise<string | null>;
}

export interface EventsServicePorts {
  readonly register: EventsRegisterPort;
  readonly notifications: EventsNotificationsPort;
  readonly officer: EventsOfficerPort;
  readonly signingKeys: EventPassKeyPort;
}
