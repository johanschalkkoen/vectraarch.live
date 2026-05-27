-- Rename family → group across the Legacy schema. Idempotent: each step only
-- runs if the old name still exists, so this is safe to re-run.
--
--   sudo -u postgres psql -d VectraArchLegacy -f legacy.vectraarch.live/migrations/2026_05_rename_family_to_group.sql

\c VectraArchLegacy
\set ON_ERROR_STOP on

-- ── Tables ──────────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename='vectraarchlegacy_families' AND schemaname='public') THEN
        ALTER TABLE vectraarchlegacy_families RENAME TO vectraarchlegacy_groups;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename='vectraarchlegacy_family_members' AND schemaname='public') THEN
        ALTER TABLE vectraarchlegacy_family_members RENAME TO vectraarchlegacy_group_members;
    END IF;
END $$;

-- ── Column on users: family_id → group_id ──────────────────────────────────
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='vectraarchlegacy_users' AND column_name='family_id') THEN
        ALTER TABLE vectraarchlegacy_users RENAME COLUMN family_id TO group_id;
    END IF;
END $$;

-- ── Column on group_members: family_id → group_id ──────────────────────────
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='vectraarchlegacy_group_members' AND column_name='family_id') THEN
        ALTER TABLE vectraarchlegacy_group_members RENAME COLUMN family_id TO group_id;
    END IF;
END $$;

-- ── Column on module_access: family_id → group_id ──────────────────────────
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='vectraarchlegacy_module_access' AND column_name='family_id') THEN
        ALTER TABLE vectraarchlegacy_module_access RENAME COLUMN family_id TO group_id;
    END IF;
END $$;

-- ── FK constraint name ────────────────────────────────────────────────────
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vectraarchlegacy_users_family_fk') THEN
        ALTER TABLE vectraarchlegacy_users RENAME CONSTRAINT vectraarchlegacy_users_family_fk TO vectraarchlegacy_users_group_fk;
    END IF;
END $$;

-- ── Indexes ────────────────────────────────────────────────────────────────
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_users_family_id') THEN
        ALTER INDEX idx_users_family_id RENAME TO idx_users_group_id;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_families_admin') THEN
        ALTER INDEX idx_families_admin RENAME TO idx_groups_admin;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_fam_members_fid') THEN
        ALTER INDEX idx_fam_members_fid RENAME TO idx_group_members_gid;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_mod_access_owner') THEN
        ALTER INDEX idx_mod_access_owner RENAME TO idx_mod_access_owner;
    END IF;
END $$;

-- ── Column on groups: rename family_name → group_name for parity ──────────
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name='vectraarchlegacy_groups' AND column_name='family_name') THEN
        ALTER TABLE vectraarchlegacy_groups RENAME COLUMN family_name TO group_name;
    END IF;
END $$;

-- ── Update access source values: 'family' → 'group' for parity ─────────────
UPDATE vectraarchlegacy_access SET source = 'group' WHERE source = 'family';

-- ── Verify ─────────────────────────────────────────────────────────────────
SELECT 'tables matching vectraarchlegacy_groups*' AS check_name,
       string_agg(tablename, ', ' ORDER BY tablename) AS result
FROM pg_tables WHERE tablename LIKE 'vectraarchlegacy_group%' AND schemaname='public'
UNION ALL
SELECT 'family_id columns left (should be 0)', COUNT(*)::text
FROM information_schema.columns WHERE column_name='family_id' AND table_schema='public';
