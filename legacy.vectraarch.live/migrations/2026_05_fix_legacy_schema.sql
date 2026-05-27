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

-- ── 3. Calendar end-date (optional event duration) ───────────────────────────
ALTER TABLE vectraarchlegacy_calendar
    ADD COLUMN IF NOT EXISTS end_date TIMESTAMP;

-- ── 4. Calendar date → TIMESTAMP so events can store their time, not just day
--      Idempotent: only runs if the column is still DATE.
DO $$
BEGIN
    IF (SELECT data_type FROM information_schema.columns
        WHERE table_name='vectraarchlegacy_calendar' AND column_name='date') = 'date' THEN
        ALTER TABLE vectraarchlegacy_calendar ALTER COLUMN date TYPE TIMESTAMP USING date::timestamp;
    END IF;
END $$;

-- ── 5. Cleanup: drop dead / duplicate columns and orphan tables ──────────────
--    These were left over from earlier iterations of the schema. None of the
--    application code reads or writes them; details below per item.
--
--    dob / weight / height      — superseded by date_of_birth / weight_kg / height_cm
--    forge_user_id              — identity bridging moved to VectraArchAPI.identity_links
--    bio, pronouns, theme,
--      activity_status, address — backend used to write them but no UI ever
--                                  surfaced them and the frontend never sends them
--    vectraarchlegacy_gymprogram(_exercise)
--                               — orphan tables, never wired into routes or UI

-- Drop the self-referential FK + its partial index before dropping the column
ALTER TABLE vectraarchlegacy_users DROP CONSTRAINT IF EXISTS vectraarchlegacy_users_forge_user_id_fkey;
DROP INDEX IF EXISTS idx_val_users_forge_id;

ALTER TABLE vectraarchlegacy_users
    DROP COLUMN IF EXISTS dob,
    DROP COLUMN IF EXISTS weight,
    DROP COLUMN IF EXISTS height,
    DROP COLUMN IF EXISTS forge_user_id,
    DROP COLUMN IF EXISTS bio,
    DROP COLUMN IF EXISTS pronouns,
    DROP COLUMN IF EXISTS theme,
    DROP COLUMN IF EXISTS activity_status,
    DROP COLUMN IF EXISTS address;

DROP TABLE IF EXISTS vectraarchlegacy_gymprogram_exercise;
DROP TABLE IF EXISTS vectraarchlegacy_gymprogram;

-- ── 6. Naming alignment: legacy_* tables → vectraarchlegacy_* convention ─────
--      Idempotent: only rename if the old name still exists. Ownership is also
--      transferred so the app user can ALTER them in future ensureSchema() runs.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename='legacy_gym_options' AND schemaname='public') THEN
        ALTER TABLE legacy_gym_options RENAME TO vectraarchlegacy_gym_options;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename='legacy_meal_templates' AND schemaname='public') THEN
        ALTER TABLE legacy_meal_templates RENAME TO vectraarchlegacy_meal_templates;
    END IF;
END $$;
ALTER TABLE IF EXISTS vectraarchlegacy_gym_options    OWNER TO "VectraArchLegacy";
ALTER TABLE IF EXISTS vectraarchlegacy_meal_templates OWNER TO "VectraArchLegacy";

-- ── 7. Family-based access architecture ──────────────────────────────────────
--    Add family_id to users so every account is jailed to a family. Family
--    membership becomes the SOURCE OF TRUTH for who-can-see-whom; the access
--    table is auto-populated by syncFamilyAccess() in app code, marked with
--    source='family' so future changes don't clobber manual cross-family
--    grants (source='manual').

ALTER TABLE vectraarchlegacy_users
    ADD COLUMN IF NOT EXISTS family_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_family_id ON vectraarchlegacy_users(family_id);

-- Source column on access table so we can tell auto (family) rows apart from
-- manually-granted rows. Existing rows are treated as manual.
ALTER TABLE vectraarchlegacy_access
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- Make (viewer,target) unique so ON CONFLICT INSERTs from app code work
-- predictably. Wrap in a DO block so re-runs don't error if it already exists.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'vectraarchlegacy_access'::regclass
          AND contype = 'u'
          AND conname  = 'vectraarchlegacy_access_uniq'
    ) THEN
        -- De-dupe first in case anything slipped through without a constraint
        DELETE FROM vectraarchlegacy_access a USING vectraarchlegacy_access b
        WHERE a.ctid < b.ctid AND a.viewer = b.viewer AND a.target = b.target;
        ALTER TABLE vectraarchlegacy_access
            ADD CONSTRAINT vectraarchlegacy_access_uniq UNIQUE (viewer, target);
    END IF;
END $$;

-- Backfill: every user without a family gets a solo family. Admin can then
-- merge / move users into shared families via the Conduit UI.
INSERT INTO vectraarchlegacy_families (family_name, admin_username, currency, timezone, member_count, enabled_modules)
SELECT
    COALESCE(NULLIF(u.display_name, ''), u.username) || ' Hub' AS family_name,
    u.username,
    'ZAR',
    'Africa/Johannesburg',
    1,
    'fin,cal,bud,gym,eat,cyc'
FROM vectraarchlegacy_users u
WHERE u.family_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM vectraarchlegacy_families f WHERE f.admin_username = u.username);

-- Link each user to their (solo) family.
UPDATE vectraarchlegacy_users u
SET family_id = (
    SELECT id FROM vectraarchlegacy_families f
    WHERE f.admin_username = u.username
    ORDER BY id ASC
    LIMIT 1
)
WHERE u.family_id IS NULL;

-- FK on family_id (deferred to here so the backfill could run on a still-empty column).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vectraarchlegacy_users_family_fk'
    ) THEN
        ALTER TABLE vectraarchlegacy_users
            ADD CONSTRAINT vectraarchlegacy_users_family_fk
            FOREIGN KEY (family_id) REFERENCES vectraarchlegacy_families(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Ensure pairwise access rows for every family that has multiple members.
-- (Marks them source='family' so a future family change can rebuild cleanly.)
INSERT INTO vectraarchlegacy_access (viewer, target, source)
SELECT a.username, b.username, 'family'
FROM vectraarchlegacy_users a, vectraarchlegacy_users b
WHERE a.family_id = b.family_id
  AND a.family_id IS NOT NULL
  AND a.username <> b.username
ON CONFLICT (viewer, target) DO NOTHING;

-- ── 8. Sanity report so you can see what we ended up with ────────────────────
\d+ vectraarchlegacy_users
\d+ vectraarchlegacy_calendar
