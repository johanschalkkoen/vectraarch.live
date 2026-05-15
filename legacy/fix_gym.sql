-- Fix vectraarchlegacy_gymworkout to store comma-separated reps/weight as TEXT
-- Run: psql -U forge_master -d VectraArchLegacy -f fix_gymworkout_columns.sql

ALTER TABLE vectraarchlegacy_gymworkout
    ALTER COLUMN reps   TYPE TEXT USING reps::TEXT,
    ALTER COLUMN weight TYPE TEXT USING weight::TEXT;

-- Drop the old integer checks that would reject '10,8,6'
ALTER TABLE vectraarchlegacy_gymworkout
    DROP CONSTRAINT IF EXISTS vectraarchlegacy_gymworkout_reps_check,
    DROP CONSTRAINT IF EXISTS vectraarchlegacy_gymworkout_weight_check;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'vectraarchlegacy_gymworkout'
ORDER BY ordinal_position;
