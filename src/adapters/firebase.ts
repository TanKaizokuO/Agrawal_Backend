import type { PhoneTokenVerifier, VerifiedPhoneToken } from "./ports.js";

export interface FirebaseDecodedIdToken {
  readonly uid: string;
  readonly phone_number?: string;
  readonly auth_time?: number;
  readonly firebase?: {
    readonly sign_in_provider?: string;
  };
}

export interface FirebaseAuthPort {
  verifyIdToken(idToken: string, checkRevoked: true): Promise<FirebaseDecodedIdToken>;
}

function isValidAuthTime(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * The only Firebase-specific implementation used by Identity. Passing `true`
 * to the Admin SDK is deliberate: a revoked Firebase refresh/session token
 * must not be exchanged for a first-party session.
 */
export class FirebasePhoneTokenVerifier implements PhoneTokenVerifier {
  public constructor(private readonly auth: FirebaseAuthPort) {}

  public async verifyIdToken(
    idToken: string,
    checkRevoked: boolean,
  ): Promise<VerifiedPhoneToken> {
    if (!checkRevoked) {
      throw new Error("Firebase token revocation checking is required");
    }
    const decoded = await this.auth.verifyIdToken(idToken, checkRevoked);
    const provider = decoded.firebase?.sign_in_provider;
    const phoneE164 = decoded.phone_number;
    const authTime = decoded.auth_time;

    if (
      decoded.uid.trim().length === 0 ||
      provider !== "phone" ||
      phoneE164 === undefined ||
      phoneE164.trim().length === 0 ||
      !isValidAuthTime(authTime)
    ) {
      throw new Error("Firebase token is not a verified phone token");
    }

    return {
      uid: decoded.uid,
      phoneE164,
      authTime: new Date(authTime * 1000),
      signInProvider: "phone",
    };
  }
}

export function createFirebasePhoneTokenVerifier(
  auth: FirebaseAuthPort,
): PhoneTokenVerifier {
  return new FirebasePhoneTokenVerifier(auth);
}
