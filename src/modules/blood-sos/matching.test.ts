import { describe, expect, it } from "vitest";
import type { DonorRow, MemberProjection } from "../register/index.js";
import {
  chooseBloodSosPlace,
  matchBloodSosDonors,
  mayRespondToAlert,
  projectDonorForBloodSos,
  shouldCreateAlert,
  type BloodSosMatchingInput,
} from "./index.js";
import { alertMessage } from "./service.js";

const NOW = new Date("2026-09-19T10:00:00.000Z");
const STATE = "MADHYA_PRADESH";
function donor(
  memberId: string,
  bloodGroup: DonorRow["bloodGroup"],
  cityKey: string,
  district: string | null = "INDORE",
  state: DonorRow["state"] = STATE,
): DonorRow {
  return { memberId, bloodGroup, cityKey, district, state };
}

function matchingInput(
  overrides: Partial<BloodSosMatchingInput> = {},
): BloodSosMatchingInput {
  return {
    tier: 1,
    requesterMemberId: "requester",
    neededGroup: "A_POS",
    cityKey: "indore",
    district: "INDORE",
    state: STATE,
    donors: [],
    preferences: new Map(),
    alreadyAlerted: new Set(),
    dailyCounts: new Map(),
    now: NOW,
    today: "2026-09-19",
    cooldownDays: 90,
    dailyCap: 3,
    densityFloor: 5,
    ...overrides,
  };
}

describe("Blood SOS matching policy", () => {
  it("keeps the immediate tier city-exact and blood-group exact", () => {
    const result = matchBloodSosDonors(matchingInput({
      donors: [
        donor("exact", "A_POS", "indore"),
        donor("compatible", "O_NEG", "indore"),
        donor("other-city", "A_POS", "bhopal"),
      ],
      densityFloor: 2,
    }));

    expect(result.map((item) => item.memberId)).toEqual(["exact"]);
    expect(result[0]?.bloodGroupMatch).toBe(true);
  });

  it("widens by district and state while retaining clinical compatibility", () => {
    const result = matchBloodSosDonors(matchingInput({
      tier: 2,
      neededGroup: "A_POS",
      donors: [
        donor("district-compatible", "O_NEG", "ujjain", "INDORE", STATE),
        donor("district-wrong-group", "B_POS", "ujjain", "INDORE", STATE),
        donor("same-district-other-state", "O_NEG", "ujjain", "INDORE", "GUJARAT"),
        donor("other-district", "O_NEG", "dewas", "DEWAS", STATE),
      ],
    }));

    expect(result.map((item) => item.memberId)).toEqual(["district-compatible"]);
    expect(result[0]?.bloodGroupMatch).toBe(true);
  });

  it("uses the density fallback only in the city", () => {
    const result = matchBloodSosDonors(matchingInput({
      donors: [
        donor("city-exact", "A_POS", "indore"),
        donor("city-other-group", "B_POS", "indore"),
        donor("city-compatible", "O_NEG", "indore"),
        donor("district-compatible", "O_NEG", "ujjain", "INDORE", STATE),
        donor("state-compatible", "O_NEG", "bhopal", "BHOPAL", STATE),
      ],
      densityFloor: 5,
    }));

    expect(result.map((item) => item.memberId)).toEqual([
      "city-exact",
      "city-other-group",
      "city-compatible",
    ]);
    expect(result.every((item) => !item.bloodGroupMatch)).toBe(true);
  });

  it("excludes cooling-down and capped donors, including from fallback", () => {
    const result = matchBloodSosDonors(matchingInput({
      donors: [
        donor("cooling", "B_POS", "indore"),
        donor("capped", "B_POS", "indore"),
        donor("eligible", "B_POS", "indore"),
      ],
      preferences: new Map([
        ["cooling", { snoozedAt: null, snoozeUntil: null, lastDonatedOn: new Date("2026-08-20T00:00:00.000Z") }],
      ]),
      dailyCounts: new Map([["capped", 3]]),
      densityFloor: 5,
    }));

    expect(result.map((item) => item.memberId)).toEqual(["eligible"]);
  });

  it("allows a donor after the configured cooldown has elapsed", () => {
    const result = matchBloodSosDonors(matchingInput({
      donors: [donor("eligible", "A_POS", "indore")],
      preferences: new Map([
        ["eligible", { snoozedAt: null, snoozeUntil: null, lastDonatedOn: new Date("2026-06-19T00:00:00.000Z") }],
      ]),
      densityFloor: 1,
    }));

    expect(result.map((item) => item.memberId)).toEqual(["eligible"]);
  });

  it("does not select a donor again when a replay already has an alert", () => {
    const result = matchBloodSosDonors(matchingInput({
      donors: [donor("already-alerted", "A_POS", "indore")],
      alreadyAlerted: new Set(["already-alerted"]),
      densityFloor: 1,
    }));

    expect(result).toEqual([]);
    expect(shouldCreateAlert(true)).toBe(false);
    expect(shouldCreateAlert(false)).toBe(true);
  });
});

describe("Blood SOS safety seams", () => {
  it("uses requester place only when pincode lookup has no place", () => {
    const place = chooseBloodSosPlace(null, {
      city: " Indore ",
      cityKey: "indore",
      district: "INDORE",
      state: STATE,
      pincode: "452001",
    });

    expect(place).toEqual({
      city: "Indore",
      cityKey: "indore",
      district: "INDORE",
      state: STATE,
      source: "REQUESTER",
    });
  });

  it("requires an accepted alert before a donor can respond", () => {
    expect(mayRespondToAlert(true)).toBe(true);
    expect(mayRespondToAlert(false)).toBe(false);
    expect(mayRespondToAlert(null)).toBe(false);
  });

  it("projects only privacy-safe donor fields", () => {
    const projection: MemberProjection = {
      memberId: "donor",
      familyPublicId: "AGR-452001-00001",
      isHead: false,
      name: { en: "Donor", hi: null },
      gotra: "GOYAL",
      city: "Indore",
      state: STATE,
      phoneE164: "+919876543210",
      bloodGroup: "O_NEG",
      address: { line1: "private", line2: null, pincode: "452001", district: "INDORE" },
    };

    const serialized = JSON.stringify(projectDonorForBloodSos(projection));
    expect(serialized).not.toContain("phoneE164");
    expect(serialized).not.toContain("bloodGroup");
    expect(serialized).not.toContain("address");
    expect(serialized).toContain("Indore");
  });

  it("keeps blood SOS push data opaque so clients fetch authorized request details", () => {
    const message = alertMessage({
      id: "00000000-0000-4000-8000-000000000001",
      hospitalName: "City Hospital",
      hospitalCity: "Indore",
      bloodGroup: "O_NEG",
    });

    expect(message.topic).toBe("BLOOD_SOS_ALERT");
    expect(message.data).toEqual({
      requestId: "00000000-0000-4000-8000-000000000001",
    });
    expect(message.data).not.toHaveProperty("bloodGroup");
    expect(message.data).not.toHaveProperty("hospitalName");
    expect(message.data).not.toHaveProperty("hospitalCity");
    expect(message.data).not.toHaveProperty("donorMemberId");
  });
});
