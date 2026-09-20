-- ---------------------------------------------------------------------------
-- Notices module — raw SQL protections and specialized indexes.
-- Run after the Prisma schema has created notice, business_listing_meta,
-- archival_request, report, and suspension.
-- ---------------------------------------------------------------------------

-- At most one unresolved Archival Request per deceased Member.
-- Statuses 'OPEN' and 'ESCALATED' represent in-flight requests.
-- A second request can be created only after a prior request has been 'REFUTED'.
CREATE UNIQUE INDEX IF NOT EXISTS archival_request_one_open
  ON archival_request (deceased_member_id)
  WHERE status IN ('OPEN', 'ESCALATED');

-- GIN trigram index for Business Listing name search on notice.title.
-- "pg_trgm" extension is created in register.sql.
CREATE INDEX IF NOT EXISTS notice_title_trgm_idx
  ON notice USING gin (title gin_trgm_ops);

-- Category and city search index on business_listing_meta.
CREATE INDEX IF NOT EXISTS business_listing_meta_category_city_key_idx
  ON business_listing_meta (category, business_city_key);

-- Fast lookup of active suspensions (not yet lifted).
CREATE INDEX IF NOT EXISTS suspension_active_idx
  ON suspension (member_id, ends_at)
  WHERE lifted_at IS NULL;
