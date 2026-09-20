import type { DonorRow } from "../register/index.js";
import { compatibleDonorGroups, isCompatible, type BloodGroup } from "./compatibility.js";

export interface BloodSosMatchingPreference {
  readonly snoozedAt: Date | null;
  readonly snoozeUntil: Date | null;
  readonly lastDonatedOn: Date | null;
}

export interface BloodSosMatchingInput {
  readonly tier: 1 | 2 | 3;
  readonly requesterMemberId: string;
  readonly neededGroup: BloodGroup;
  readonly cityKey: string;
  readonly district: string | null;
  readonly state: string;
  readonly donors: readonly DonorRow[];
  readonly preferences: ReadonlyMap<string, BloodSosMatchingPreference>;
  readonly alreadyAlerted: ReadonlySet<string>;
  readonly dailyCounts: ReadonlyMap<string, number>;
  readonly now: Date;
  readonly today: string;
  readonly cooldownDays: number;
  readonly dailyCap: number;
  readonly densityFloor: number;
}

export interface BloodSosMatch {
  readonly memberId: string;
  readonly bloodGroup: BloodGroup;
  readonly bloodGroupMatch: boolean;
}

const DAY_MS = 86_400_000;

function dateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function donorInCooldown(
  preference: BloodSosMatchingPreference | undefined,
  today: string,
  cooldownDays: number,
): boolean {
  if (preference?.lastDonatedOn === null || preference?.lastDonatedOn === undefined) return false;
  const cutoff = new Date(dateOnly(today).getTime() - cooldownDays * DAY_MS);
  return preference.lastDonatedOn.getTime() > cutoff.getTime();
}

function donorSnoozed(
  preference: BloodSosMatchingPreference | undefined,
  now: Date,
): boolean {
  if (preference?.snoozedAt === null || preference?.snoozedAt === undefined) return false;
  return preference.snoozeUntil === null || preference.snoozeUntil.getTime() > now.getTime();
}

function inTier(
  donor: DonorRow,
  input: BloodSosMatchingInput,
): boolean {
  if (input.tier === 1) return donor.cityKey === input.cityKey;
  if (input.tier === 2) {
    return input.district !== null
      && donor.state === input.state
      && donor.district === input.district;
  }
  return donor.state === input.state;
}

function eligibleDonors(input: BloodSosMatchingInput): DonorRow[] {
  const result: DonorRow[] = [];
  const seen = new Set<string>();
  for (const donor of input.donors) {
    if (seen.has(donor.memberId)) continue;
    seen.add(donor.memberId);
    if (donor.memberId === input.requesterMemberId) continue;
    if (!inTier(donor, input)) continue;
    if (input.alreadyAlerted.has(donor.memberId)) continue;
    const preference = input.preferences.get(donor.memberId);
    if (donorSnoozed(preference, input.now)) continue;
    if (donorInCooldown(preference, input.today, input.cooldownDays)) continue;
    if ((input.dailyCounts.get(donor.memberId) ?? 0) >= input.dailyCap) continue;
    result.push(donor);
  }
  return result;
}

/**
 * Selects the donors for one widening tier. The function is intentionally
 * independent of persistence and notification delivery, so the exact city,
 * compatibility, fallback, cooldown and cap rules have one testable policy.
 */
export function matchBloodSosDonors(input: BloodSosMatchingInput): readonly BloodSosMatch[] {
  const eligible = eligibleDonors(input);
  const compatible = eligible.filter((donor) => isCompatible(input.neededGroup, donor.bloodGroup));
  if (input.tier === 1 && compatible.length < input.densityFloor) {
    return eligible.map((donor) => ({
      memberId: donor.memberId,
      bloodGroup: donor.bloodGroup,
      bloodGroupMatch: false,
    }));
  }

  const acceptedGroups = input.tier === 1
    ? [input.neededGroup]
    : compatibleDonorGroups(input.neededGroup);
  return eligible
    .filter((donor) => acceptedGroups.includes(donor.bloodGroup))
    .map((donor) => ({
      memberId: donor.memberId,
      bloodGroup: donor.bloodGroup,
      bloodGroupMatch: true,
    }));
}

export function mayRespondToAlert(alertAccepted: boolean | null): boolean {
  return alertAccepted === true;
}

export function shouldCreateAlert(existingAlert: boolean): boolean {
  return !existingAlert;
}
