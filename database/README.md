# database/

Reserved for future database-related artifacts, for example seed data and SQL notes.

Phase 2 created nothing here beyond this file: no schema, no migrations and no seed data, and nothing in Phase 2 connected to the Neon database. [DATABASE.md](../DATABASE.md) is the source of truth for the database design.

Phase 3's actual database artifacts ended up under [`backend/`](../backend/) instead of here: migrations in `backend/drizzle/`, seed data in `backend/src/db/seed/`, and the guarded migration/seed/probe scripts in `backend/scripts/`. This directory remains unused.
