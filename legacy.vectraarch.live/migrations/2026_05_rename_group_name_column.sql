-- Targeted recovery: rename family_name → group_name on vectraarchlegacy_groups.
-- The full rename migration's DO-block for this didn't apply on your DB for
-- some reason; this script does ONLY that column rename, idempotently.
--
--   sudo -u postgres psql -d VectraArchLegacy -f legacy.vectraarch.live/migrations/2026_05_rename_group_name_column.sql

\c VectraArchLegacy
\set ON_ERROR_STOP on

-- 1. Rename column if it's still called family_name
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='vectraarchlegacy_groups' AND column_name='family_name') THEN
        ALTER TABLE vectraarchlegacy_groups RENAME COLUMN family_name TO group_name;
        RAISE NOTICE 'Renamed family_name → group_name';
    ELSIF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='vectraarchlegacy_groups' AND column_name='group_name') THEN
        RAISE NOTICE 'group_name already present, nothing to do';
    ELSE
        RAISE EXCEPTION 'vectraarchlegacy_groups has neither family_name nor group_name — manual fix required';
    END IF;
END $$;

-- 2. Sanity report
SELECT column_name FROM information_schema.columns
WHERE table_name='vectraarchlegacy_groups' AND table_schema='public'
ORDER BY ordinal_position;
