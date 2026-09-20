import type { PincodePlace } from "../../adapters/ports.js";

export interface BloodSosFallbackPlace {
  readonly city: string;
  readonly cityKey: string;
  readonly district: string | null;
  readonly state: string;
  readonly pincode: string;
}

export interface BloodSosResolvedPlace {
  readonly city: string;
  readonly cityKey: string;
  readonly district: string | null;
  readonly state: string;
  readonly source: "PINCODE" | "REQUESTER";
}

function cleanPlace(
  place: PincodePlace | BloodSosFallbackPlace | null,
): BloodSosResolvedPlace | null {
  if (place === null) return null;
  if (place.city.trim().length === 0 || place.cityKey.trim().length === 0) return null;
  if (place.state.trim().length === 0) return null;
  return {
    city: place.city.trim(),
    cityKey: place.cityKey.trim(),
    district: place.district?.trim() || null,
    state: place.state.trim(),
    source: "PINCODE",
  };
}

export function chooseBloodSosPlace(
  directoryPlace: PincodePlace | null,
  requesterPlace: BloodSosFallbackPlace | null,
): BloodSosResolvedPlace | null {
  const directory = cleanPlace(directoryPlace);
  if (directory !== null) return directory;
  if (requesterPlace === null || requesterPlace.pincode.trim().length === 0) return null;
  const fallback = cleanPlace(requesterPlace);
  return fallback === null ? null : { ...fallback, source: "REQUESTER" };
}
