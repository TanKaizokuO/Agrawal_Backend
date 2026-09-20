-- Database capabilities required by the API but not represented in base.prisma.
-- This file is safe to run more than once as part of environment provisioning.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "citext";

-- Application-role creation, passwords, and grants are intentionally not embedded
-- here. Role identifiers and credentials are environment-specific; deployment
-- provisioning must supply them through its own parameterized, least-privilege
-- grant step instead of committing secrets or a production role name.
