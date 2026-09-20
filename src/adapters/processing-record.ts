import { v7 as uuidv7 } from "uuid";
import type { Clock } from "../clock.js";
import type {
  ProcessingMetadataValue,
  ProcessingRecordWriter,
  ProcessingSubjectType,
} from "../modules/officer/index.js";

export interface ProcessingRecordWriterOptions {
  readonly clock: Clock;
  readonly retentionDays: number;
}

const SUBJECT_TYPE_BY_ACTION: Readonly<Record<string, ProcessingSubjectType>> = {
  MEMBER_ERASED: "MEMBER",
  ERASURE_REQUESTED: "MEMBER",
  FLAG_RESOLVED: "FLAG",
  IMAGE_REMOVED: "IMAGE",
  IMAGE_OVERRIDE_APPROVED: "IMAGE",
  OFFICER_IMAGES_VIEWED: "IMAGE",
  OFFICER_MEMBER_LOOKUP: "MEMBER",
  NOMINEE_READ: "MEMBER",
  REFUND_REQUESTED: "PAYMENT",
  HEAD_SUCCEEDED: "FAMILY",
  FAMILY_ARCHIVED: "FAMILY",
  MEMBER_ARCHIVED: "MEMBER",
  MEMBER_UNARCHIVED: "MEMBER",
  SUSPENSION_LIFTED: "SUSPENSION",
  NOTICE_RESTORED: "NOTICE",
  ARCHIVAL_RESOLVED_BY_OFFICER: "ARCHIVAL_REQUEST",
  ROLE_GRANTED: "MEMBER",
  ROLE_REVOKED: "MEMBER",
  BLOOD_SOS_REPORT_RESOLVED: "BLOOD_SOS",
  PASS_REVOKED: "EVENT_PASS",
};

type ProcessingEntryInput = {
  readonly action: string;
  readonly subjectType?: string;
  readonly subjectId: string;
  readonly actor: { readonly kind: string; readonly id?: string | undefined };
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

function subjectTypeForAction(action: string): string {
  const subjectType = SUBJECT_TYPE_BY_ACTION[action];
  if (subjectType === undefined) throw new Error(`Unknown Processing Record action: ${action}`);
  return subjectType;
}

function metadataValue(value: unknown): ProcessingMetadataValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

function metadataObject(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, ProcessingMetadataValue>> | undefined {
  if (metadata === undefined) return undefined;
  const result: Record<string, ProcessingMetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) result[key] = metadataValue(value);
  return result;
}

interface ProcessingRecordDelegate {
  create(args: { readonly data: Record<string, unknown> }): Promise<unknown>;
}

function hasProcessingRecord(value: unknown): value is { readonly processingRecord: ProcessingRecordDelegate } {
  return typeof value === "object"
    && value !== null
    && "processingRecord" in value
    && typeof value.processingRecord === "object"
    && value.processingRecord !== null
    && "create" in value.processingRecord
    && typeof value.processingRecord.create === "function";
}

export class PrismaProcessingRecordWriter implements ProcessingRecordWriter {
  private readonly clock: Clock;
  private readonly retentionDays: number;

  public constructor(options: ProcessingRecordWriterOptions) {
    this.clock = options.clock;
    this.retentionDays = options.retentionDays;
  }

  public async write(tx: unknown, entry: ProcessingEntryInput): Promise<void> {
    if (!hasProcessingRecord(tx)) throw new Error("Processing Record transaction is unavailable");
    const now = this.clock.now();
    const retainUntil = new Date(now.getTime() + this.retentionDays * 86_400_000);
    const metadata = metadataObject(entry.metadata);
    await tx.processingRecord.create({
      data: {
        id: uuidv7(),
        at: now,
        actorKind: entry.actor.kind,
        ...(entry.actor.kind === "SYSTEM"
          ? { actorId: null }
          : entry.actor.id === undefined
            ? { actorId: null }
            : { actorId: entry.actor.id }),
        action: entry.action,
        subjectType: entry.subjectType ?? subjectTypeForAction(entry.action),
        subjectId: entry.subjectId,
        reason: entry.reason ?? null,
        ...(metadata === undefined ? {} : { metadata }),
        retainUntil,
      },
    });
  }
}

export function createProcessingRecordWriter(
  options: ProcessingRecordWriterOptions,
): PrismaProcessingRecordWriter {
  return new PrismaProcessingRecordWriter(options);
}
