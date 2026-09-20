export interface Clock {
  now(): Date;
  todayIst(): string;
}

const IST_TIME_ZONE = "Asia/Kolkata";
export function dateFromEpochMilliseconds(milliseconds: number): Date {
  return new Date(milliseconds);
}

export function addMilliseconds(value: Date, milliseconds: number): Date {
  return dateFromEpochMilliseconds(value.getTime() + milliseconds);
}


export function dateToIstDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("Unable to calculate the IST calendar date");
  }
  return `${year}-${month}-${day}`;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  todayIst(): string {
    return dateToIstDate(this.now());
  }
}

export class FixedClock implements Clock {
  private current: Date;

  constructor(initial: Date) {
    this.current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  todayIst(): string {
    return dateToIstDate(this.current);
  }

  set(value: Date): void {
    this.current = new Date(value.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export const systemClock: Clock = new SystemClock();
