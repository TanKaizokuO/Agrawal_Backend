import type { WorkerRegistration } from "../../jobs.js";
import { z } from "zod";
import type { RegisterService } from "./service.js";

export const JOB_NAMES = {
  fillDistrict: "register.fillDistrict",
  purgeRestricted: "register.purgeRestricted",
} as const;

const FillDistrictPayload = z.object({
  memberId: z.uuid(),
  pincode: z.string().regex(/^[1-9]\d{5}$/u),
});

export const JOB_SCHEDULES = {
  purgeRestricted: {
    cron: "0 3 * * *",
    timezone: "Asia/Kolkata",
    key: JOB_NAMES.purgeRestricted,
  },
} as const;

export function createRegisterWorkers(service: RegisterService): readonly WorkerRegistration[] {
  return [
    {
      name: JOB_NAMES.fillDistrict,
      handler: async (payload: unknown) => {
        const { memberId, pincode } = FillDistrictPayload.parse(payload);
        await service.fillDistrict(memberId, pincode);
      },
    },
    {
      name: JOB_NAMES.purgeRestricted,
      schedule: JOB_SCHEDULES.purgeRestricted,
      handler: async () => {
        await service.purgeRestricted();
      },
    },
  ];
}
