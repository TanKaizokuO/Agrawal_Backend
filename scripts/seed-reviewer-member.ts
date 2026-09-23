// Creates the Play Store reviewer account as a founding Member (Head of a new
// Family), mirroring RegisterService.createFamilyWithHead without a
// Registration Payment. Only for the fixed Firebase test number below.
//
// Dry run (default):  node --env-file=.env --import tsx scripts/seed-reviewer-member.ts
// Write:              node --env-file=.env --import tsx scripts/seed-reviewer-member.ts --apply
//
// Uses DATABASE_MIGRATION_URL when set, otherwise DATABASE_URL.
import { v7 as uuidv7 } from "uuid";
import { createPrismaClient } from "../src/db.js";

const REVIEWER = {
  phoneE164: "+919876543210",
  nameEn: "Play Reviewer",
  nameHi: "प्ले रिव्यूअर",
  fatherNameEn: "Demo Account",
  fatherNameHi: "डेमो अकाउंट",
  gender: "MALE",
  dateOfBirth: "1990-01-01",
  bloodGroup: "O_POS",
  addressLine1: "Demo address (Play review account)",
  city: "New Delhi",
  district: "New Delhi",
  state: "DELHI",
  pincode: "110001",
  gotra: "GARG",
} as const;

const apply = process.argv.includes("--apply");
const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_MIGRATION_URL or DATABASE_URL.");

const target = new URL(url);
console.log(`Target: ${target.hostname}${target.pathname} (${apply ? "APPLY" : "dry run"})`);

const db = createPrismaClient(url);
try {
  const existing = await db.member.findUnique({
    where: { phoneE164: REVIEWER.phoneE164 },
    select: { id: true, status: true, link: { select: { family: { select: { publicId: true } } } } },
  });
  if (existing) {
    console.log(
      `Reviewer already a member: ${existing.id} (${existing.status}), family ${existing.link?.family.publicId ?? "none"}. Nothing to do.`,
    );
  } else if (!apply) {
    console.log(`Reviewer ${REVIEWER.phoneE164} is not a member. Re-run with --apply to create it.`);
  } else {
    const result = await db.$transaction(async (tx) => {
      const counter = await tx.familyIdCounter.upsert({
        where: { pincode: REVIEWER.pincode },
        create: { pincode: REVIEWER.pincode, nextSeq: 2 },
        update: { nextSeq: { increment: 1 } },
        select: { nextSeq: true },
      });
      const publicId = `AGR-${REVIEWER.pincode}-${String(counter.nextSeq - 1).padStart(5, "0")}`;
      const memberId = uuidv7();
      const familyId = uuidv7();
      const now = new Date();

      await tx.family.create({
        data: {
          id: familyId,
          publicId,
          gotra: REVIEWER.gotra,
          pincodeSnapshot: REVIEWER.pincode,
          headMemberId: memberId,
          status: "ACTIVE",
          createdAt: now,
        },
      });
      await tx.member.create({
        data: {
          id: memberId,
          phoneE164: REVIEWER.phoneE164,
          status: "ACTIVE",
          nameEn: REVIEWER.nameEn,
          nameHi: REVIEWER.nameHi,
          nameEnSearchKey: REVIEWER.nameEn.toLowerCase(),
          fatherNameEn: REVIEWER.fatherNameEn,
          fatherNameHi: REVIEWER.fatherNameHi,
          fatherNameEnSearchKey: REVIEWER.fatherNameEn.toLowerCase(),
          gender: REVIEWER.gender,
          dateOfBirth: new Date(`${REVIEWER.dateOfBirth}T00:00:00.000Z`),
          bloodGroup: REVIEWER.bloodGroup,
          addressLine1: REVIEWER.addressLine1,
          city: REVIEWER.city,
          cityKey: REVIEWER.city.toLowerCase(),
          district: REVIEWER.district,
          state: REVIEWER.state,
          pincode: REVIEWER.pincode,
          nativePlaceKind: "UNKNOWN",
          consentDirectory: true,
          consentBloodGroup: false,
          consentPhoto: false,
          paymentDisclosureAckAt: now,
          uiLanguage: "en",
          createdAt: now,
        },
      });
      await tx.familyLink.create({
        data: { memberId, familyId, kind: "BIRTH", createdAt: now },
      });
      const consents = [
        ["DIRECTORY", true],
        ["BLOOD_GROUP", false],
        ["PHOTO", false],
        ["PAYMENT_DISCLOSURE_ACK", true],
      ] as const;
      for (const [toggle, value] of consents) {
        await tx.consentEvent.create({
          data: { id: uuidv7(), memberId, toggle, value, source: "REVIEWER_SEED", at: now },
        });
      }
      return { memberId, publicId };
    });
    console.log(`Created reviewer member ${result.memberId} as Head of ${result.publicId}.`);
  }
} finally {
  await db.$disconnect();
}
