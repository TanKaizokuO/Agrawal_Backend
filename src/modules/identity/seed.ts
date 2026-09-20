import { AppError } from "../../http/errors.js";
import type { IdentityRole } from "./db.js";
import type {
  IdentityService,
  RegisterIdentityPort,
} from "./service.js";
const PHONE_E164 = /^\+91[6-9]\d{9}$/u;
const VALID_ROLES: Record<IdentityRole, true> = {
  OFFICER: true,
  OPERATOR: true,
  ORGANISER: true,
};

function isIdentityRole(value: string | undefined): value is IdentityRole {
  return value !== undefined && Object.hasOwn(VALID_ROLES, value);
}

export interface RoleSeedInput {
  readonly phoneE164: string;
  readonly roles: readonly IdentityRole[];
}

function validation(message: string, path: string): AppError {
  return new AppError("VALIDATION_FAILED", 400, {
    issues: [{ path: [path], message }],
  });
}

export function parseRoleSeedArguments(argv: readonly string[]): RoleSeedInput {
  let phoneE164: string | undefined;
  const roles: IdentityRole[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--phone") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw validation("--phone requires an E.164 phone number.", "phoneE164");
      }
      phoneE164 = value;
      index += 1;
      continue;
    }
    if (argument === "--role") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || !isIdentityRole(value)) {
        throw validation("--role must be OFFICER, OPERATOR, or ORGANISER.", "role");
      }
      roles.push(value);
      index += 1;
      continue;
    }
    throw validation(`Unknown argument: ${String(argument)}`, "arguments");
  }

  if (phoneE164 === undefined || !PHONE_E164.test(phoneE164)) {
    throw validation("--phone must be an Indian E.164 phone number.", "phoneE164");
  }
  if (roles.length === 0) {
    throw validation("At least one --role is required.", "role");
  }

  return { phoneE164, roles };
}

export async function seedRolesForPhone(
  deps: {
    readonly service: IdentityService;
    readonly register: Pick<RegisterIdentityPort, "memberPrincipalForPhone">;
  },
  input: RoleSeedInput,
): Promise<{ readonly memberId: string; readonly roles: readonly IdentityRole[] }> {
  const member = await deps.register.memberPrincipalForPhone(input.phoneE164);
  if (member === null || member.status !== "ACTIVE") {
    throw new AppError("FORBIDDEN", 403);
  }
  await deps.service.withTransaction((tx) =>
    deps.service.seedInitialRoles(tx, member.memberId, input.roles),
  );
  return { memberId: member.memberId, roles: input.roles };
}
