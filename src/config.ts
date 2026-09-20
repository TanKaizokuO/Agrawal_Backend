import { z } from "zod";

const requiredText = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1),
);

const positiveInteger = z.preprocess(
  (value) => {
    if (typeof value === "string" && value.trim() !== "") {
      return Number(value);
    }
    return value;
  },
  z.number().int().positive(),
);

const nonNegativeInteger = z.preprocess(
  (value) => {
    if (typeof value === "string" && value.trim() !== "") {
      return Number(value);
    }
    return value;
  },
  z.number().int().nonnegative(),
);

const booleanValue = z.preprocess(
  (value) => {
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
    return value;
  },
  z.boolean(),
);

const jsonText = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  },
  z.unknown(),
);

const eventPassSigningKey = z.object({
  kid: requiredText,
  privateKeyPem: requiredText,
});

const eventPassSigningKeys = jsonText.pipe(z.array(eventPassSigningKey));

const paymentIdentityHmacKey = requiredText.superRefine((value, context) => {
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 32) {
      context.addIssue({
        code: "custom",
        message: "must be base64 encoding of exactly 32 bytes",
      });
    }
  } catch {
    context.addIssue({ code: "custom", message: "must be valid base64" });
  }
});

export const configSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("production"),
  appEnv: z.enum(["local", "staging", "production"]),
  port: positiveInteger.default(3000),
  databaseUrl: requiredText,
  databaseMigrationUrl: requiredText,
  webOrigins: z
    .preprocess(
      (value) =>
        value === undefined ? "https://register.example.in" : value,
      z.string().min(1),
    )
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
  sessionTtlWebDays: positiveInteger.default(30),
  sessionTtlMobileDays: positiveInteger.default(90),
  firebaseProjectId: requiredText,
  firebaseServiceAccountJson: requiredText,
  razorpayKeyId: requiredText,
  razorpayKeySecret: requiredText,
  razorpayWebhookSecret: requiredText,
  registrationPaymentPaise: positiveInteger.default(100),
  businessListingFeePaise: positiveInteger.default(4900),
  paymentIdentityHmacKey,
  s3Bucket: requiredText,
  awsRegion: requiredText.default("ap-south-1"),
  mediaUrlTtlSeconds: positiveInteger.default(3600),
  googleCloudProject: requiredText,
  googleApplicationCredentialsJson: requiredText,
  imageScreeningEnabled: booleanValue.default(false),
  erasureSelfServiceEnabled: booleanValue.default(false),
  sightengineApiUser: requiredText.optional(),
  sightengineApiSecret: requiredText.optional(),
  eventPassSigningKeys,
  retentionDaysPayments: positiveInteger.default(365),
  retentionDaysConsentAndLogs: positiveInteger.default(365),
  registrationAbandonAfterHours: positiveInteger.default(24),
  joinRequestExpiryDays: positiveInteger.default(14),
  joinRequestsPendingMaxPerFamily: positiveInteger.default(10),
  postingCapPerDay: positiveInteger.default(3),
  reportsThreshold: positiveInteger.default(5),
  suspensionDurationDays: positiveInteger.default(7),
  archivalEscalationDays: positiveInteger.default(7),
  businessListingDurationDays: positiveInteger.default(180),
  blockedWords: jsonText.pipe(z.array(z.string().trim().min(1))).default([]),
  phoneRegexInText: requiredText.default("(?:\\+91[\\s-]?)?[6-9]\\d{9}"),
  sosTierIntervalMinutes: positiveInteger.default(30),
  sosExpiryHours: positiveInteger.default(24),
  sosDensityFloor: nonNegativeInteger.default(5),
  donorCooldownDays: nonNegativeInteger.default(90),
  donorDailyAlertCap: nonNegativeInteger.default(3),
  workersEnabled: booleanValue.default(true),
});

export type Config = z.output<typeof configSchema>;

export interface ConfigIssue {
  readonly variable: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const message = issues
      .map((issue) => `${issue.variable}: ${issue.message}`)
      .join("\n");
    super(`Invalid configuration:\n${message}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const ENV_NAME_BY_FIELD: Record<string, string> = {
  nodeEnv: "NODE_ENV",
  appEnv: "APP_ENV",
  port: "PORT",
  databaseUrl: "DATABASE_URL",
  databaseMigrationUrl: "DATABASE_MIGRATION_URL",
  webOrigins: "WEB_ORIGINS",
  sessionTtlWebDays: "SESSION_TTL_WEB_DAYS",
  sessionTtlMobileDays: "SESSION_TTL_MOBILE_DAYS",
  firebaseProjectId: "FIREBASE_PROJECT_ID",
  firebaseServiceAccountJson: "FIREBASE_SERVICE_ACCOUNT_JSON",
  razorpayKeyId: "RAZORPAY_KEY_ID",
  razorpayKeySecret: "RAZORPAY_KEY_SECRET",
  razorpayWebhookSecret: "RAZORPAY_WEBHOOK_SECRET",
  registrationPaymentPaise: "REGISTRATION_PAYMENT_PAISE",
  businessListingFeePaise: "BUSINESS_LISTING_FEE_PAISE",
  paymentIdentityHmacKey: "PAYMENT_IDENTITY_HMAC_KEY",
  s3Bucket: "S3_BUCKET",
  awsRegion: "AWS_REGION",
  mediaUrlTtlSeconds: "MEDIA_URL_TTL_SECONDS",
  googleCloudProject: "GOOGLE_CLOUD_PROJECT",
  googleApplicationCredentialsJson: "GOOGLE_APPLICATION_CREDENTIALS_JSON",
  imageScreeningEnabled: "IMAGE_SCREENING_ENABLED",
  erasureSelfServiceEnabled: "ERASURE_SELF_SERVICE",
  sightengineApiUser: "SIGHTENGINE_API_USER",
  sightengineApiSecret: "SIGHTENGINE_API_SECRET",
  eventPassSigningKeys: "EVENT_PASS_SIGNING_KEYS",
  retentionDaysConsentAndLogs: "RETENTION_DAYS_CONSENT_AND_LOGS",
  registrationAbandonAfterHours: "REGISTRATION_ABANDON_AFTER_HOURS",
  joinRequestExpiryDays: "JOIN_REQUEST_EXPIRY_DAYS",
  joinRequestsPendingMaxPerFamily: "JOIN_REQUESTS_PENDING_MAX_PER_FAMILY",
  postingCapPerDay: "POSTING_CAP_PER_DAY",
  reportsThreshold: "REPORTS_THRESHOLD",
  suspensionDurationDays: "SUSPENSION_DURATION_DAYS",
  archivalEscalationDays: "ARCHIVAL_ESCALATION_DAYS",
  businessListingDurationDays: "BUSINESS_LISTING_DURATION_DAYS",
  blockedWords: "BLOCKED_WORDS",
  phoneRegexInText: "PHONE_REGEX_IN_TEXT",
  sosTierIntervalMinutes: "SOS_TIER_INTERVAL_MINUTES",
  sosExpiryHours: "SOS_EXPIRY_HOURS",
  sosDensityFloor: "SOS_DENSITY_FLOOR",
  donorCooldownDays: "DONOR_COOLDOWN_DAYS",
  donorDailyAlertCap: "DONOR_DAILY_ALERT_CAP",
  workersEnabled: "WORKERS_ENABLED",
};

function toRecord(environment: NodeJS.ProcessEnv): Record<string, unknown> {
  return {
    nodeEnv: environment.NODE_ENV,
    appEnv: environment.APP_ENV,
    port: environment.PORT,
    databaseUrl: environment.DATABASE_URL,
    databaseMigrationUrl: environment.DATABASE_MIGRATION_URL,
    webOrigins: environment.WEB_ORIGINS,
    sessionTtlWebDays: environment.SESSION_TTL_WEB_DAYS,
    sessionTtlMobileDays: environment.SESSION_TTL_MOBILE_DAYS,
    firebaseProjectId: environment.FIREBASE_PROJECT_ID,
    firebaseServiceAccountJson: environment.FIREBASE_SERVICE_ACCOUNT_JSON,
    razorpayKeyId: environment.RAZORPAY_KEY_ID,
    razorpayKeySecret: environment.RAZORPAY_KEY_SECRET,
    razorpayWebhookSecret: environment.RAZORPAY_WEBHOOK_SECRET,
    registrationPaymentPaise: environment.REGISTRATION_PAYMENT_PAISE,
    businessListingFeePaise: environment.BUSINESS_LISTING_FEE_PAISE,
    paymentIdentityHmacKey: environment.PAYMENT_IDENTITY_HMAC_KEY,
    s3Bucket: environment.S3_BUCKET,
    awsRegion: environment.AWS_REGION,
    mediaUrlTtlSeconds: environment.MEDIA_URL_TTL_SECONDS,
    googleCloudProject: environment.GOOGLE_CLOUD_PROJECT,
    googleApplicationCredentialsJson: environment.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    imageScreeningEnabled: environment.IMAGE_SCREENING_ENABLED,
    erasureSelfServiceEnabled: environment.ERASURE_SELF_SERVICE,
    sightengineApiUser: environment.SIGHTENGINE_API_USER,
    sightengineApiSecret: environment.SIGHTENGINE_API_SECRET,
    eventPassSigningKeys: environment.EVENT_PASS_SIGNING_KEYS,
    retentionDaysConsentAndLogs: environment.RETENTION_DAYS_CONSENT_AND_LOGS,
    registrationAbandonAfterHours: environment.REGISTRATION_ABANDON_AFTER_HOURS,
    joinRequestExpiryDays: environment.JOIN_REQUEST_EXPIRY_DAYS,
    joinRequestsPendingMaxPerFamily: environment.JOIN_REQUESTS_PENDING_MAX_PER_FAMILY,
    postingCapPerDay: environment.POSTING_CAP_PER_DAY,
    reportsThreshold: environment.REPORTS_THRESHOLD,
    suspensionDurationDays: environment.SUSPENSION_DURATION_DAYS,
    archivalEscalationDays: environment.ARCHIVAL_ESCALATION_DAYS,
    businessListingDurationDays: environment.BUSINESS_LISTING_DURATION_DAYS,
    blockedWords: environment.BLOCKED_WORDS,
    phoneRegexInText: environment.PHONE_REGEX_IN_TEXT,
    sosTierIntervalMinutes: environment.SOS_TIER_INTERVAL_MINUTES,
    sosExpiryHours: environment.SOS_EXPIRY_HOURS,
    sosDensityFloor: environment.SOS_DENSITY_FLOOR,
    donorCooldownDays: environment.DONOR_COOLDOWN_DAYS,
    donorDailyAlertCap: environment.DONOR_DAILY_ALERT_CAP,
    workersEnabled: environment.WORKERS_ENABLED,
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(toRecord(environment));
  const issues: ConfigIssue[] = parsed.success
    ? []
    : parsed.error.issues.map((issue) => {
        const field = issue.path[0]?.toString() ?? "configuration";
        return {
          variable: ENV_NAME_BY_FIELD[field] ?? field,
          message: issue.message,
        };
      });

  const screeningEnabled =
    parsed.success
      ? parsed.data.imageScreeningEnabled
      : environment.IMAGE_SCREENING_ENABLED?.toLowerCase() === "true";
  if (screeningEnabled) {
    const sightengineUser = environment.SIGHTENGINE_API_USER?.trim();
    if (sightengineUser === undefined || sightengineUser === "") {
      issues.push({
        variable: "SIGHTENGINE_API_USER",
        message: "is required when IMAGE_SCREENING_ENABLED=true",
      });
    }
    const sightengineSecret = environment.SIGHTENGINE_API_SECRET?.trim();
    if (sightengineSecret === undefined || sightengineSecret === "") {
      issues.push({
        variable: "SIGHTENGINE_API_SECRET",
        message: "is required when IMAGE_SCREENING_ENABLED=true",
      });
    }
  }

  if (!parsed.success) {
    throw new ConfigError(issues);
  }
  if (issues.length > 0) {
    throw new ConfigError(issues);
  }
  return parsed.data;
}
