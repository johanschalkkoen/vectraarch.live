-- VectraArch Legacy — Paygate (PayFast subscriptions)
--
-- Why this exists:
--   The app's ensureSchema() adds these columns/tables idempotently on boot, but
--   if vectraarchlegacy_users is owned by a different postgres role than the app's
--   connecting role, those ALTERs silently fail (see 2026_05_fix_legacy_schema.sql).
--   Running this as the table owner guarantees the paygate columns exist.
--
-- What it does:
--   - Adds subscription state to vectraarchlegacy_users. Existing rows default to
--     'trial' with trial_started_at = NOW(), i.e. every current user gets a fresh
--     TRIAL_DAYS window from the moment this runs.
--   - Creates the PayFast ITN audit table vectraarchlegacy_payments.
--
-- How to run:
--   sudo -u postgres psql -d VectraArchLegacy -f migrations/2026_05_paygate_subscriptions.sql
--
-- Idempotent — safe to re-run.

\c VectraArchLegacy

ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS subscription_status     TEXT DEFAULT 'trial';
ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS trial_started_at        TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS subscription_plan       TEXT;
ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;
ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS pf_token                TEXT;

-- Backfill any pre-existing rows that somehow have NULLs (e.g. column added before
-- a default was set) so nobody is accidentally locked out on day one.
UPDATE vectraarchlegacy_users
   SET subscription_status = COALESCE(subscription_status, 'trial'),
       trial_started_at    = COALESCE(trial_started_at, NOW());

CREATE TABLE IF NOT EXISTS vectraarchlegacy_payments (
    id              SERIAL PRIMARY KEY,
    username        TEXT,
    m_payment_id    TEXT,
    pf_payment_id   TEXT,
    plan            TEXT,
    amount_gross    NUMERIC,
    payment_status  TEXT,
    pf_token        TEXT,
    raw             JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_username ON vectraarchlegacy_payments(username);
CREATE INDEX IF NOT EXISTS idx_payments_pf_pid   ON vectraarchlegacy_payments(pf_payment_id);
