import {
  PgBoss,
  type ScheduleOptions,
  type SendOptions,
  type WorkOptions,
} from "pg-boss";

export interface JobSendOptions {
  readonly startAfter?: Date | string;
  readonly retryLimit?: number;
  readonly retryBackoff?: boolean;
}

export type JobHandler = (payload: unknown) => Promise<void> | void;

export interface JobSchedule {
  readonly cron: string;
  readonly timezone?: string;
  readonly key?: string;
  readonly data?: object | null;
  readonly options?: Omit<ScheduleOptions, "key" | "tz">;
}

export interface WorkerRegistration {
  readonly name: string;
  readonly handler: JobHandler;
  readonly options?: WorkOptions;
  readonly schedule?: JobSchedule;
}

export interface RecurringJobSchedule extends JobSchedule {
  readonly name: string;
}

export interface JobRuntime {
  readonly enabled: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady(): Promise<boolean>;
  send(name: string, payload: unknown, options?: JobSendOptions): Promise<string | null>;
  registerWorker(registration: WorkerRegistration): Promise<void>;
  schedule?(
    name: string,
    cron: string,
    data?: object | null,
    options?: ScheduleOptions,
  ): Promise<void>;
}

class PgBossRuntime implements JobRuntime {
  private started = false;
  // pg-boss v12 rejects send/work/schedule on a queue that hasn't been
  // created. create_queue is idempotent, so each name is ensured once per
  // process on first use.
  private readonly ensuredQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly boss: PgBoss,
    readonly enabled: boolean,
  ) {}

  async start(): Promise<void> {
    if (!this.enabled || this.started) return;
    await this.boss.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop();
    this.started = false;
    this.ensuredQueues.clear();
  }

  private ensureQueue(name: string): Promise<void> {
    let ensured = this.ensuredQueues.get(name);
    if (ensured === undefined) {
      ensured = this.boss.createQueue(name).catch((error: unknown) => {
        this.ensuredQueues.delete(name);
        throw error;
      });
      this.ensuredQueues.set(name, ensured);
    }
    return ensured;
  }

  isReady(): Promise<boolean> {
    return Promise.resolve(!this.enabled || this.started);
  }

  async send(
    name: string,
    payload: unknown,
    options?: JobSendOptions,
  ): Promise<string | null> {
    if (!this.enabled || !this.started) {
      throw new Error("The job runtime is not started");
    }
    if (
      payload !== null &&
      payload !== undefined &&
      typeof payload !== "object"
    ) {
      throw new TypeError("Job payload must be an object or null");
    }
    const sendOptions: SendOptions = {
      ...options,
      retryLimit: options?.retryLimit ?? 5,
      retryBackoff: options?.retryBackoff ?? true,
    };
    await this.ensureQueue(name);
    return this.boss.send(name, payload, sendOptions);
  }

  async registerWorker(registration: WorkerRegistration): Promise<void> {
    if (!this.enabled || !this.started) {
      throw new Error("The job runtime is not started");
    }
    const options: WorkOptions = registration.options ?? {};
    await this.ensureQueue(registration.name);
    await this.boss.work(
      registration.name,
      options,
      async (jobs) => {
        for (const job of jobs) await registration.handler(job.data);
      },
    );
  }

  async schedule(
    name: string,
    cron: string,
    data?: object | null,
    options?: ScheduleOptions,
  ): Promise<void> {
    if (!this.enabled || !this.started) {
      throw new Error("The job runtime is not started");
    }
    await this.ensureQueue(name);
    await this.boss.schedule(name, cron, data, options);
  }
}

export interface JobRuntimeOptions {
  readonly connectionString: string;
  readonly enabled?: boolean;
  readonly onError?: (error: Error) => void;
}

export function createJobRuntime(options: JobRuntimeOptions): JobRuntime {
  const boss = new PgBoss(options.connectionString);
  // PgBoss is an EventEmitter; an "error" event with no listener would crash
  // the process.
  boss.on("error", options.onError ?? (() => undefined));
  return new PgBossRuntime(boss, options.enabled ?? true);
}

export const createPgBoss = createJobRuntime;

export function recurringJobSchedules(
  registrations: readonly WorkerRegistration[],
): readonly RecurringJobSchedule[] {
  const schedules = new Map<string, RecurringJobSchedule>();
  for (const registration of registrations) {
    const schedule = registration.schedule;
    if (schedule === undefined) continue;
    const recurring = { ...schedule, name: registration.name };
    const key = recurring.name;
    const previous = schedules.get(key);
    if (
      previous !== undefined
      && (
        previous.cron !== recurring.cron
        || previous.timezone !== recurring.timezone
        || previous.key !== recurring.key
      )
    ) {
      throw new Error(`Conflicting recurring schedule for ${registration.name}`);
    }
    schedules.set(key, recurring);
  }
  return [...schedules.values()];
}

export async function provisionRecurringSchedules(
  runtime: JobRuntime,
  registrations: readonly WorkerRegistration[],
): Promise<void> {
  if (!runtime.enabled) return;
  if (runtime.schedule === undefined) {
    if (recurringJobSchedules(registrations).length > 0) {
      throw new Error("The job runtime does not support recurring schedules");
    }
    return;
  }
  for (const recurring of recurringJobSchedules(registrations)) {
    await runtime.schedule(
      recurring.name,
      recurring.cron,
      recurring.data ?? null,
      {
        ...recurring.options,
        retryLimit: recurring.options?.retryLimit ?? 5,
        retryBackoff: recurring.options?.retryBackoff ?? true,
        ...(recurring.timezone === undefined ? {} : { tz: recurring.timezone }),
        ...(recurring.key === undefined ? {} : { key: recurring.key }),
      },
    );
  }
}

export async function registerAllWorkers(
  runtime: JobRuntime,
  registrations: readonly WorkerRegistration[],
): Promise<void> {
  if (!runtime.enabled) return;
  for (const registration of registrations) {
    await runtime.registerWorker(registration);
  }
  await provisionRecurringSchedules(runtime, registrations);
}
