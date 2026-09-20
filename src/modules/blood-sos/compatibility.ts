import type { DonorRow } from "../register/index.js";

export type BloodGroup = DonorRow["bloodGroup"];

/**
 * Red-cell donation compatibility, keyed by the group required by a patient.
 * The city tier still sends only the exact group; this matrix is used for the
 * density-floor count and for district/state widening.
 */
export const COMPATIBLE_DONOR_GROUPS: Readonly<Record<BloodGroup, readonly BloodGroup[]>> = {
  A_POS: ["A_POS", "A_NEG", "O_POS", "O_NEG"],
  A_NEG: ["A_NEG", "O_NEG"],
  B_POS: ["B_POS", "B_NEG", "O_POS", "O_NEG"],
  B_NEG: ["B_NEG", "O_NEG"],
  AB_POS: ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"],
  AB_NEG: ["A_NEG", "B_NEG", "AB_NEG", "O_NEG"],
  O_POS: ["O_POS", "O_NEG"],
  O_NEG: ["O_NEG"],
};

export function compatibleDonorGroups(needed: BloodGroup): readonly BloodGroup[] {
  return COMPATIBLE_DONOR_GROUPS[needed];
}

export function isCompatible(needed: BloodGroup, donor: BloodGroup): boolean {
  return COMPATIBLE_DONOR_GROUPS[needed].includes(donor);
}
