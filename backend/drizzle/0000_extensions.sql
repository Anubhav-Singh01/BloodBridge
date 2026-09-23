-- Extensions required by DATABASE.md (section 1 for PostGIS, sections 2.3 and 2.4 for the non-overlap
-- exclusion constraints). Both are documented as supported by Neon. The read-only probe (Batch 3.5)
-- confirms this before anything is applied. gen_random_uuid() is built in from PostgreSQL 13.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;
