import { z } from "zod";
import type { WorkerRegistration } from "../../jobs.js";
import { JOB_NAMES, EventsService } from "./service.js";

const EventJobPayload = z.object({ eventId: z.uuid() }).strict();

export function createEventsWorkers(service: EventsService): readonly WorkerRegistration[] {
  return [
    {
      name: JOB_NAMES.startEvent,
      handler: async (payload: unknown) => {
        const { eventId } = EventJobPayload.parse(payload);
        await service.startEvent(eventId);
      },
    },
    {
      name: JOB_NAMES.endEvent,
      handler: async (payload: unknown) => {
        const { eventId } = EventJobPayload.parse(payload);
        await service.endEvent(eventId);
      },
    },
  ];
}
