import type { NoticesTxClient } from "./db.js";
import type { NotificationTopic as NotificationTopicType } from "../notifications/index.js";

export interface NoticeAuthorProjection {
  readonly memberId: string;
  readonly familyPublicId: string;
  readonly isHead: boolean;
  readonly name?: {
    readonly en?: string | null;
    readonly hi?: string | null;
  };
  readonly gotra?: string;
  readonly city?: string;
  readonly state?: string;
  readonly photoUrl?: string | null;
}

export type ProcessingActor =
  | { readonly kind: "SYSTEM" }
  | { readonly kind: "MEMBER"; readonly id: string }
  | { readonly kind: "OFFICER"; readonly id: string }
  | { readonly kind: "OPERATOR"; readonly id: string };

export interface ProcessingEntry {
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly actor: ProcessingActor;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface NoticesProcessingRecordWriter {
  write(tx: NoticesTxClient, entry: ProcessingEntry): Promise<void>;
}

export interface NoticesRegisterPort {
  isActiveMember(memberId: string): Promise<boolean>;
  familyOf(memberId: string): Promise<{
    readonly familyId: string;
    readonly publicId: string;
    readonly gotra?: string;
    readonly headMemberId?: string | null;
  } | null>;
  adultMembersOfFamily(familyId: string, exceptMemberId?: string): Promise<string[]>;
  archiveMember(
    tx: NoticesTxClient,
    memberId: string,
    confirmedBy: { readonly kind: "MEMBER" | "OFFICER"; readonly memberId?: string; readonly officerId?: string },
  ): Promise<void>;
  project(
    viewerMemberId: string,
    memberIds: readonly string[],
  ): Promise<ReadonlyMap<string, NoticeAuthorProjection>>;
  onMemberErased(handler: (tx: NoticesTxClient, memberId: string) => Promise<void>): void;
  onMemberArchived?(handler: (tx: NoticesTxClient, memberId: string) => Promise<void>): void;
}

export interface NoticesMediaPort {
  urlFor(imageId: string, viewerMemberId: string | null): Promise<string | null>;
}

export interface BusinessCheckoutOrder {
  readonly paymentId: string;
  readonly razorpayOrderId: string;
  readonly keyId: string;
  readonly amountPaise: number;
  readonly currency: "INR";
  readonly prefill: { readonly contact: string };
  readonly alreadyPaid: boolean;
}

export interface NoticesBusinessPort {
  isBoardOpen(): boolean;
  getListingFeePaise(): number | null;
  checkEligibility?(memberId: string): Promise<boolean>;
  createPaymentOrder(input: {
    readonly noticeId: string;
    readonly payerMemberId: string;
    readonly payerPhoneE164: string;
    readonly amountPaise: number;
  }): Promise<BusinessCheckoutOrder>;
  markConsumed(paymentId: string): Promise<void>;
  refund(paymentId: string, reason: "PUBLICATION_FAILED"): Promise<void>;
}

export interface LocalizedText {
  readonly en: string;
  readonly hi: string;
}
export interface NoticePushMessage {
  readonly topic: NotificationTopicType;
  readonly subjectId: string;
  readonly title: LocalizedText;
  readonly body: LocalizedText;
  readonly data: Readonly<Record<string, string>>;
}

export interface NoticesNotificationsPort {
  send(memberIds: readonly string[], message: NoticePushMessage): Promise<void>;
}

export interface NoticesClock {
  now(): Date;
  todayIst(): string;
}

export interface NoticesConfig {
  readonly postingCapPerDay: number;
  readonly reportsThreshold: number;
  readonly suspensionDurationDays: number;
  readonly archivalEscalationDays: number;
  readonly businessListingDurationDays: number;
  readonly blockedWords: readonly string[];
  readonly phoneRegexInText: string;
  readonly businessListingFeePaise?: number | null;
}
