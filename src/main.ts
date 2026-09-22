import type { Server } from "node:http";
import type { PrismaClient } from "./generated/prisma/client.js";
import pino, { type Logger } from "pino";
import type { Express } from "express";
import { createApp, mountRawRazorpayWebhook, type ApiApp } from "./app.js";
import { loadConfig, type Config } from "./config.js";
import { systemClock } from "./clock.js";
import { createPrismaClient } from "./db.js";
import {
  createJobRuntime,
  registerAllWorkers,
  type JobRuntime,
  type WorkerRegistration,
} from "./jobs.js";
import { createRateLimiter, PrismaRateLimitStore } from "./http/rate-limit.js";
import { createIdempotencyStore } from "./adapters/idempotency.js";
import { createHttpWorkers } from "./http/jobs.js";
import {
  createFirebaseAdminPushSender,
  type FirebaseEnvironment,
} from "./adapters/fcm.js";
import {
  createFirebasePhoneVerifier,
  normalizedFirebaseServiceAccountJson,
} from "./adapters/firebase-runtime.js";
import { createImageScreener } from "./adapters/image-screener.js";
import { createObjectStore } from "./adapters/object-store.js";
import { createRazorpayGateway } from "./adapters/razorpay.js";
import { createGoogleRomanizer } from "./adapters/translate.js";
import {
  createNoticesDatabase,
  createNoticesRegisterAdapter,
} from "./adapters/notices-db.js";
import {
  createEventsDatabase,
  createEventsRegisterAdapter,
} from "./adapters/events-db.js";
import { createPostalPincodeDirectory } from "./adapters/postal-pincode.js";
import { createRestrictedStorageMover } from "./adapters/restricted-storage.js";
import { createProcessingRecordWriter } from "./adapters/processing-record.js";
import { createEventPassKeyStore } from "./adapters/event-pass-keys.js";
import { createSessionPurgeDatabase } from "./adapters/identity-maintenance.js";
import { createOfficerMemberLookup } from "./adapters/member-lookup.js";
import {
  createMemberLanguageResolver,
  createOfficerErasureRequests,
} from "./adapters/governance.js";
import {
  IdentityService,
  createIdentityRoutes,
  createIdentityWorkers,
  type IdentityTxClient,
} from "./modules/identity/index.js";
import {
  RegistrationService,
  createRegistrationRoutes,
  createRegistrationWorkers,
  type RegistrationIdentityPort,
  type RegistrationOfficerPort,
} from "./modules/registration/index.js";
import {
  PaymentService,
  createPaymentRoutes,
  createPaymentWorkers,
  createWebhookHandler,
  paymentRouteManifest,
} from "./modules/payments/index.js";
import {
  RegisterService,
  createRegisterRoutes,
  createRegisterWorkers,
  type RegisterSuspensionResolver,
} from "./modules/register/index.js";
import {
  NoticesService,
  createNoticesRoutes,
  createNoticesWorkers,
  createOfficerArchivalAdapter,
  createOfficerReportAdapter,
  createOfficerSuspensionAdapter,
  createRegisterSuspensionResolver,
} from "./modules/notices/index.js";
import {
  MediaService,
  createMediaRoutes,
  createMediaWorkers,
} from "./modules/media/index.js";
import {
  NotificationsService,
  NotificationTopic,
  createNotificationRoutes,
  createNotificationWorkers,
} from "./modules/notifications/index.js";
import {
  OfficerService,
  createOfficerRoutes,
  createOfficerWorkers,
} from "./modules/officer/index.js";
import {
  BloodSosService,
  createBloodSosRoutes,
  createBloodSosWorkers,
  createOfficerBloodSosAdapter,
  registerBloodSosHooks,
} from "./modules/blood-sos/index.js";
import {
  EventsService,
  createEventsRoutes,
  createEventsWorkers,
} from "./modules/events/index.js";
 

const logger = pino();

export interface ApiRuntime {
  readonly app: ApiApp;
  readonly database: PrismaClient;
  readonly jobs: JobRuntime;
  readonly workers: readonly WorkerRegistration[];
  close(): Promise<void>;
}

function requiredConfigText(value: string | undefined, variable: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${variable} is required`);
  }
  return value;
}

function firebaseEnvironment(config: Config): FirebaseEnvironment {
  return config.appEnv;
}

function registrationPort(
  getRegistration: () => RegistrationService | undefined,
): RegistrationIdentityPort {
  return {
    openForPhone: async (tx, phoneE164) => {
      const registration = getRegistration();
      if (registration === undefined) throw new Error("Registration service is not initialized");
      return registration.openForPhone(tx, phoneE164);
    },
  };
}

function identityPort(
  getIdentity: () => IdentityService | undefined,
): { promoteToMember(tx: IdentityTxClient, registrationId: string, memberId: string): Promise<void> } {
  return {
    promoteToMember: async (tx, registrationId, memberId) => {
      const identity = getIdentity();
      if (identity === undefined) throw new Error("Identity service is not initialized");
      await identity.promoteToMember(tx, registrationId, memberId);
    },
  };
}

function registrationOfficerPort(
  getOfficer: () => OfficerService | undefined,
): RegistrationOfficerPort {
  return {
    raiseFlag: async (tx, input) => {
      const officer = getOfficer();
      if (officer === undefined) throw new Error("Officer service is not initialized");
      await officer.raiseFlag(tx, input);
    },
  };
}

function closeServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export function createApiRuntime(
  config: Config,
  runtimeLogger: Logger = logger,
): ApiRuntime {
  const database = createPrismaClient(config.databaseUrl);
  const jobs = createJobRuntime({
    connectionString: config.databaseUrl,
    enabled: config.workersEnabled,
    onError: (error) => {
      runtimeLogger.error({ err: error }, "job runtime error");
    },
  });
  const clock = systemClock;
  const idempotencyStore = createIdempotencyStore(database);
  const rateLimitStore = new PrismaRateLimitStore(database);
  const pincodeDirectory = createPostalPincodeDirectory();
  const rateLimiter = createRateLimiter({ database, clock });
  const objectStore = createObjectStore({ bucket: config.s3Bucket, region: config.awsRegion });
  const paymentGateway = createRazorpayGateway({
    keyId: config.razorpayKeyId,
    keySecret: config.razorpayKeySecret,
  });
  const restrictedStorage = createRestrictedStorageMover();
  const processingRecord = createProcessingRecordWriter({
    clock,
    retentionDays: config.retentionDaysConsentAndLogs,
  });
  const romanizer = createGoogleRomanizer({
    projectId: config.googleCloudProject,
    serviceAccountJson: config.googleApplicationCredentialsJson,
  });
  const imageScreener = config.imageScreeningEnabled
    ? createImageScreener({
      apiUser: requiredConfigText(config.sightengineApiUser, "SIGHTENGINE_API_USER"),
      apiSecret: requiredConfigText(config.sightengineApiSecret, "SIGHTENGINE_API_SECRET"),
    })
    : undefined;
  const firebaseVerifier = createFirebasePhoneVerifier({
    projectId: config.firebaseProjectId,
    serviceAccountJson: config.firebaseServiceAccountJson,
    environment: firebaseEnvironment(config),
  });
  const pushSender = createFirebaseAdminPushSender({
    projectId: config.firebaseProjectId,
    serviceAccountJson: normalizedFirebaseServiceAccountJson(config.firebaseServiceAccountJson),
    environment: firebaseEnvironment(config),
  });
  const deferred: {
    media?: MediaService;
    notices?: NoticesService;
    suspensionResolver?: RegisterSuspensionResolver;
    registration?: RegistrationService;
    officer?: OfficerService;
  } = {};

  const paymentService = new PaymentService({
    db: database,
    gateway: paymentGateway,
    jobs,
    clock,
    config: {
      razorpayKeyId: config.razorpayKeyId,
      razorpayKeySecret: config.razorpayKeySecret,
      razorpayWebhookSecret: config.razorpayWebhookSecret,
      paymentIdentityHmacKey: config.paymentIdentityHmacKey,
    },
    processingRecord,
    restrictedStorage,
    logger: runtimeLogger,
  });

  const registerService = new RegisterService({
    db: database,
    clock,
    config: {
      retentionDaysPayments: config.retentionDaysPayments,
      retentionDaysConsentAndLogs: config.retentionDaysConsentAndLogs,
      mediaUrlTtlSeconds: config.mediaUrlTtlSeconds,
      erasureSelfServiceEnabled: config.erasureSelfServiceEnabled,
    },
    pincodeDirectory,
    objectStore,
    jobs,
    payments: {
      moveToRestricted: (tx, memberId, retainUntil) =>
        paymentService.moveToRestricted(tx, memberId, retainUntil),
      releaseHeadAnchor: (tx, familyId) => paymentService.releaseHeadAnchor(tx, familyId),
    },
    suspensionResolver: async (memberId) => {
      if (deferred.suspensionResolver === undefined) {
        throw new Error("Notices suspension resolver is not initialized");
      }
      return deferred.suspensionResolver.resolveActiveSuspension(memberId);
    },
    media: {
      isVisibleToOthers: (imageId) => {
        if (deferred.media === undefined) {
          throw new Error("Media service is not initialized");
        }
        return deferred.media.isVisibleToOthers(imageId);
      },
      presignUrl: (imageId, ttlSeconds) => {
        if (deferred.media === undefined) {
          throw new Error("Media service is not initialized");
        }
        return deferred.media.presignUrl(imageId, ttlSeconds);
      },
    },
    romanizer,
    processingRecord,
    nomineeReadAuthorizer: {
      isArchivalRequestOpen: async (memberId, archivalRequestId) => {
        if (deferred.notices === undefined) {
          throw new Error("Notices service is not initialized");
        }
        return deferred.notices.isArchivalRequestOpen(memberId, archivalRequestId);
      },
    },
  });

  const mediaService = new MediaService({
    db: database,
    clock,
    config: {
      imageScreeningEnabled: config.imageScreeningEnabled,
      mediaUrlTtlSeconds: config.mediaUrlTtlSeconds,
    },
    objectStore,
    jobs,
    imageScreener,
    processingRecord,
    ownerNotification: {
      postOfficerMessage: (tx, memberId, kind, reason) =>
        registerService.postOfficerMessage(tx, memberId, kind, reason),
    },
  });
  deferred.media = mediaService;

  const identityService = new IdentityService({
    db: database,
    verifier: firebaseVerifier,
    registration: registrationPort(() => {
      if (deferred.registration === undefined) {
        throw new Error("Registration service is not initialized");
      }
      return deferred.registration;
    }),
    register: registerService,
    clock,
    config: {
      sessionTtlWebDays: config.sessionTtlWebDays,
      sessionTtlMobileDays: config.sessionTtlMobileDays,
    },
    rateLimitStore,
    processingRecord,
  });

  const registrationService = new RegistrationService({
    db: database,
    clock,
    config: {
      registrationPaymentPaise: config.registrationPaymentPaise,
      registrationAbandonAfterHours: config.registrationAbandonAfterHours,
      joinRequestExpiryDays: config.joinRequestExpiryDays,
      joinRequestsPendingMaxPerFamily: config.joinRequestsPendingMaxPerFamily,
    },
    register: registerService,
    payments: paymentService,
    identity: identityPort(() => identityService),
    jobs,
    officer: registrationOfficerPort(() => deferred.officer),
  });
  deferred.registration = registrationService;

  const notificationsService = new NotificationsService({
    db: database,
    clock,
    jobs,
    pushSender,
    memberLanguage: createMemberLanguageResolver(database),
    config: { environment: config.appEnv },
  });

  const noticesBusiness = {
    isBoardOpen: () => true,
    getListingFeePaise: () => config.businessListingFeePaise,
    checkEligibility: (memberId: string) => registerService.isActiveMember(memberId),
    createPaymentOrder: async (input: {
      readonly noticeId: string;
      readonly payerMemberId: string;
      readonly payerPhoneE164: string;
      readonly amountPaise: number;
    }) => paymentService.createOrder({
      purpose: "BUSINESS_LISTING",
      subjectId: input.noticeId,
      payerMemberId: input.payerMemberId,
      payerPhoneE164: input.payerPhoneE164,
      amountPaise: input.amountPaise,
    }),
    markConsumed: async (paymentId: string) => {
      await database.$transaction((tx) => paymentService.markConsumed(tx, paymentId));
    },
    refund: async (paymentId: string, reason: "PUBLICATION_FAILED") => {
      await database.$transaction((tx) => paymentService.refund(
        tx,
        paymentId,
        reason,
        { kind: "SYSTEM" },
      ));
    },
  };
  const noticesService = new NoticesService({
    db: createNoticesDatabase(database),
    clock,
    config: {
      postingCapPerDay: config.postingCapPerDay,
      reportsThreshold: config.reportsThreshold,
      suspensionDurationDays: config.suspensionDurationDays,
      archivalEscalationDays: config.archivalEscalationDays,
      businessListingDurationDays: config.businessListingDurationDays,
      blockedWords: config.blockedWords,
      phoneRegexInText: config.phoneRegexInText,
      businessListingFeePaise: config.businessListingFeePaise,
    },
    register: createNoticesRegisterAdapter(registerService),
    media: {
      urlFor: (imageId, viewerMemberId) => mediaService.urlFor(
        imageId,
        viewerMemberId === null ? {} : { memberId: viewerMemberId },
      ),
    },
    business: noticesBusiness,
    notifications: {
      send: async (memberIds, message) => {
        await notificationsService.send(memberIds, {
          topic: NotificationTopic.parse(message.topic),
          subjectId: message.subjectId,
          title: message.title,
          body: message.body,
          data: message.data,
        });
      },
    },
    processingRecord,
  });
  deferred.notices = noticesService;

  const suspensionResolver = createRegisterSuspensionResolver(noticesService);
  deferred.suspensionResolver = suspensionResolver;

  // Services wired above
  registerService.onMemberErased(async (tx, memberId) => {
    await identityService.revokeAllForMember(tx, memberId, "ERASURE");
    await notificationsService.deleteTokensForMember(tx, memberId);
    await mediaService.deleteAllForMember(tx, memberId);
  });
  registerService.onMemberArchived(async (tx, memberId) => {
    await identityService.revokeAllForMember(tx, memberId, "ARCHIVAL");
  });

  const bloodSosService = new BloodSosService({
    db: database,
    clock,
    jobs,
    config: {
      tierIntervalMinutes: config.sosTierIntervalMinutes,
      expiryHours: config.sosExpiryHours,
      densityFloor: config.sosDensityFloor,
      donorCooldownDays: config.donorCooldownDays,
      donorDailyAlertCap: config.donorDailyAlertCap,
    },
    pincodeDirectory,
    register: registerService,
    notifications: notificationsService,
    reports: {
      create: async (input) => {
        const result = await noticesService.reportBloodSos(
          { memberId: input.reporterMemberId },
          input.requestId,
          { reason: input.reason },
        );
        return { id: result.report.id };
      },
    },
    officer: processingRecord,
  });
  registerBloodSosHooks(registerService, bloodSosService);

  const eventsService = new EventsService({
    db: createEventsDatabase(database),
    clock,
    jobs,
    register: createEventsRegisterAdapter(registerService),
    notifications: notificationsService,
    officer: processingRecord,
    signingKeys: createEventPassKeyStore({ keys: config.eventPassSigningKeys }),
  });
  const officerService = new OfficerService({
    db: database,
    clock,
    retentionDaysConsentAndLogs: config.retentionDaysConsentAndLogs,
    register: registerService,
    processingRecord,
    media: mediaService,
    payments: paymentService,
    identity: identityService,
    memberLookup: createOfficerMemberLookup(database),
    erasureRequests: createOfficerErasureRequests(database),
    suspensions: createOfficerSuspensionAdapter(noticesService),
    archivals: createOfficerArchivalAdapter(noticesService),
    reports: createOfficerReportAdapter(noticesService),
    bloodSos: createOfficerBloodSosAdapter(bloodSosService),
  });
  const workers: readonly WorkerRegistration[] = [
    ...createIdentityWorkers({ db: createSessionPurgeDatabase(database), rateLimitStore, clock }),
    ...createHttpWorkers(idempotencyStore, clock),
    ...createRegistrationWorkers(registrationService),
    ...createPaymentWorkers(paymentService),
    ...createMediaWorkers(mediaService),
    ...createNotificationWorkers(notificationsService),
    ...createNoticesWorkers(noticesService),
    ...createRegisterWorkers(registerService),
    ...createOfficerWorkers(officerService),
    ...createBloodSosWorkers(bloodSosService),
    ...createEventsWorkers(eventsService),
  ];

  const mountRoutes = (app: Express): void => {
    app.use(createOfficerRoutes({ service: officerService, rateLimiter }));
    app.use(createIdentityRoutes({ service: identityService }));
    app.use(createRegistrationRoutes({
      service: registrationService,
      idempotencyStore,
      clock,
      rateLimiter,
    }));
    app.use(createPaymentRoutes({ service: paymentService }));
    const registerRouteDeps = {
      service: registerService,
      erasureSelfServiceEnabled: config.erasureSelfServiceEnabled,
      reauthenticate: async (memberId: string, firebaseIdToken: string) => {
        try {
          const verified = await firebaseVerifier.verifyIdToken(firebaseIdToken, true);
          const member = await database.member.findUnique({
            where: { id: memberId },
            select: { phoneE164: true },
          });
          return member?.phoneE164 === verified.phoneE164
            && clock.now().getTime() - verified.authTime.getTime() <= 5 * 60_000;
        } catch {
          return false;
        }
      },
      ...(config.webOrigins[0] === undefined ? {} : { webBaseUrl: config.webOrigins[0] }),
    };
    app.use(createRegisterRoutes(registerRouteDeps));
    app.use(createMediaRoutes({ service: mediaService, rateLimiter }));
    app.use(createNotificationRoutes({ service: notificationsService }));
    app.use(createNoticesRoutes({ service: noticesService, rateLimiter }));
    app.use(createBloodSosRoutes({
      service: bloodSosService,
      idempotency: { store: idempotencyStore, clock },
      rateLimiter,
    }));
    app.use(createEventsRoutes({ service: eventsService, rateLimiter }));
  };

  const app = createApp({
    config,
    database,
    jobs,
    logger: runtimeLogger,
    principalResolver: identityService,
    mountRazorpayWebhook: (target) => {
      mountRawRazorpayWebhook(
        target,
        paymentRouteManifest.receiveWebhook.path,
        createWebhookHandler({ service: paymentService }),
      );
    },
    mountRoutes,
    rawBodyPathPrefixes: [paymentRouteManifest.receiveWebhook.path, "/v1/media/images"],
  });

  let closed = false;
  return {
    app,
    database,
    jobs,
    workers,
    close: async () => {
      if (closed) return;
      closed = true;
      await jobs.stop();
      await database.$disconnect();
    },
  };
}

function listen(app: ApiApp, port: number): Promise<Server> {
  const { promise, resolve, reject } = Promise.withResolvers<Server>();
  const server = app.listen(port);
  server.once("listening", () => {
    resolve(server);
  });
  server.once("error", reject);
  return promise;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = createApiRuntime(config, logger);
  let server: Server | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      try {
        await closeServer(server);
      } finally {
        await runtime.close();
      }
    })();
    return shutdownPromise;
  };

  try {
    await runtime.jobs.start();
    await registerAllWorkers(runtime.jobs, runtime.workers);
    server = await listen(runtime.app, config.port);
    logger.info({ port: config.port }, "API listening");
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
  } catch (error) {
    await runtime.close().catch(() => undefined);
    logger.fatal({ err: error }, "API failed to start");
    throw error;
  }
}

if (process.argv[1]?.endsWith("/main.js") || process.argv[1]?.endsWith("/main.ts")) {
  await main();
}
