-- Recovery script — applies ONLY the family-access section that the main
-- migration silently skipped, plus fixes the gymprogram drop that errored
-- because of an orphaned FK on vectraarchlegacy_gymworkout.program_id.
--
-- Idempotent. Safe to run any number of times.
--
--   sudo -u postgres psql -d VectraArchLegacy -f legacy.vectraarch.live/migrations/2026_05_family_access_recovery.sql

\c VectraArchLegacy
\set ON_ERROR_STOP on

-- ── 1. Drop gymworkout's FK to the soon-to-be-gone gymprogram table ──────────
ALTER TABLE vectraarchlegacy_gymworkout
    DROP CONSTRAINT IF EXISTS vectraarchlegacy_gymworkout_program_id_fkey;
-- The program_id column itself can stay (it's just an int with no referent now);
-- if you want it gone too, uncomment:
-- ALTER TABLE vectraarchlegacy_gymworkout DROP COLUMN IF EXISTS program_id;
DROP TABLE IF EXISTS vectraarchlegacy_gymprogram;

-- ── 2. family_id on users ────────────────────────────────────────────────────
ALTER TABLE vectraarchlegacy_users
    ADD COLUMN IF NOT EXISTS family_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_users_family_id ON vectraarchlegacy_users(family_id);

-- ── 3. source column on access (manual vs family-induced) ────────────────────
ALTER TABLE vectraarchlegacy_access
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';

-- ── 4. Unique (viewer,target) on access so ON CONFLICT works in the app ──────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'vectraarchlegacy_access'::regclass
          AND contype  = 'u'
          AND conname  = 'vectraarchlegacy_access_uniq'
    ) THEN
        -- De-dupe first (ctid lets us keep one copy of each pair)
        DELETE FROM vectraarchlegacy_access a USING vectraarchlegacy_access b
        WHERE a.ctid < b.ctid AND a.viewer = b.viewer AND a.target = b.target;
        ALTER TABLE vectraarchlegacy_access
            ADD CONSTRAINT vectraarchlegacy_access_uniq UNIQUE (viewer, target);
    END IF;
END $$;

-- ── 5. Backfill: each orphan user gets a solo family ─────────────────────────
INSERT INTO vectraarchlegacy_families (family_name, admin_username, currency, timezone, member_count, enabled_modules)
SELECT
    COALESCE(NULLIF(u.display_name, ''), u.username) || ' Hub',
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
    ORDER BY id ASC LIMIT 1
)
WHERE u.family_id IS NULL;

-- ── 6. FK on family_id (added after backfill so it never fails) ──────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vectraarchlegacy_users_family_fk') THEN
        ALTER TABLE vectraarchlegacy_users
            ADD CONSTRAINT vectraarchlegacy_users_family_fk
            FOREIGN KEY (family_id) REFERENCES vectraarchlegacy_families(id) ON DELETE SET NULL;
    END IF;
END $$;

-- ── 7. Seed pairwise 'family' access rows for every family with >1 member ────
INSERT INTO vectraarchlegacy_access (viewer, target, source)
SELECT a.username, b.username, 'family'
FROM vectraarchlegacy_users a, vectraarchlegacy_users b
WHERE a.family_id = b.family_id
  AND a.family_id IS NOT NULL
  AND a.username <> b.username
ON CONFLICT (viewer, target) DO NOTHING;

-- ── 8. Verify ────────────────────────────────────────────────────────────────
SELECT 'users with family_id'   AS check_name, COUNT(*) AS n FROM vectraarchlegacy_users   WHERE family_id IS NOT NULL
UNION ALL
SELECT 'families'                                            , COUNT(*)::bigint FROM vectraarchlegacy_families
UNION ALL
SELECT 'access rows (total)'                                 , COUNT(*)::bigint FROM vectraarchlegacy_access
UNION ALL
SELECT 'access rows (family source)'                         , COUNT(*)::bigint FROM vectraarchlegacy_access WHERE source='family';
