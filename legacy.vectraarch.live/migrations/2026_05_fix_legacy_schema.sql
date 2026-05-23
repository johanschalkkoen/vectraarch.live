-- Fix VectraArchLegacy schema.
--
-- Why this exists:
--   Many vectraarchlegacy_* tables are owned by the postgres role `forge_master`,
--   but the Node app connects as `VectraArchLegacy` (see legacy.vectraarch.live/.env).
--   The app's ensureSchema() does idempotent ALTER TABLE migrations on startup, but
--   they fail with `permission denied for table` because the connecting role isn't
--   the owner — and the errors are swallowed (logged to stderr only). The result is
--   that columns the app expects (twofa_secret, google_id, auth_provider, etc.)
--   silently never get created, and every save / 2FA call then 500s.
--
-- How to run:
--   sudo -u postgres psql -d VectraArchLegacy -f migrations/2026_05_fix_legacy_schema.sql
--
-- The script is idempotent — safe to re-run.

\c VectraArchLegacy

-- ── 1. Re-own every legacy table to the app's connecting role ─────────────────
-- After this, ensureSchema()'s ALTERs will actually take effect on future boots.
ALTER TABLE IF EXISTS vectraarchlegacy_access              OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_budget              OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_calendar            OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_financial           OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_gymworkout          OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_mealplan            OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_notifications       OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_period              OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_transaction_history OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_users               OWNER TO "VectraArchLegacy";
-- The next group is already owned correctly but listing for completeness:
ALTER TABLE IF EXISTS vectraarchlegacy_families            OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_family_members      OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_module_access       OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_partner_sharing     OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_invites             OWNER TO "VectraArchLegacy";

-- ── 2. Add every column the app expects on vectraarchlegacy_users ────────────
-- Idempotent: IF NOT EXISTS skips any that are already there.
ALTER TABLE vectraarchlegacy_users
    ADD COLUMN IF NOT EXISTS first_name       TEXT,
    ADD COLUMN IF NOT EXISTS last_name        TEXT,
    ADD COLUMN IF NOT EXISTS display_name     TEXT,
    ADD COLUMN IF NOT EXISTS email            TEXT,
    ADD COLUMN IF NOT EXISTS phone            TEXT,
    ADD COLUMN IF NOT EXISTS address          TEXT,
    ADD COLUMN IF NOT EXISTS bio              TEXT,
    ADD COLUMN IF NOT EXISTS pronouns         TEXT,
    ADD COLUMN IF NOT EXISTS gender           TEXT,
    ADD COLUMN IF NOT EXISTS profile_pic_url  TEXT,
    ADD COLUMN IF NOT EXISTS event_color      TEXT DEFAULT '#2dd4bf',
    ADD COLUMN IF NOT EXISTS accent_color     TEXT DEFAULT '#00ff41',
    ADD COLUMN IF NOT EXISTS theme            TEXT DEFAULT 'dark',
    ADD COLUMN IF NOT EXISTS role             TEXT DEFAULT 'individual',
    ADD COLUMN IF NOT EXISTS date_of_birth    TEXT,
    ADD COLUMN IF NOT EXISTS height_cm        NUMERIC,
    ADD COLUMN IF NOT EXISTS weight_kg        NUMERIC,
    ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT,
    ADD COLUMN IF NOT EXISTS activity_status  INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_active      TEXT,
    ADD COLUMN IF NOT EXISTS is_admin         INTEGER DEFAULT 0,
    ADD COLUMN IF NOT EXISTS password_hash    TEXT,
    ADD COLUMN IF NOT EXISTS twofa_secret     TEXT,
    ADD COLUMN IF NOT EXISTS google_id        TEXT,
    ADD COLUMN IF NOT EXISTS auth_provider    TEXT DEFAULT 'password';

-- Partial unique index on google_id — only enforced when a user has one set.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id
    ON vectraarchlegacy_users(google_id) WHERE google_id IS NOT NULL;

-- ── 3. Sanity report so you can see what we ended up with ────────────────────
\d+ vectraarchlegacy_users
