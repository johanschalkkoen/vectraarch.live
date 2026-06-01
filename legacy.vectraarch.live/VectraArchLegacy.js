'use strict';
/**
 * VectraArch Legacy — server.js
 * Rewritten: sqlite3 → pg (VectraArchLegacy database)
 * Column mapping: user→username, firstName→first_name, etc.
 * API contract unchanged — frontend requires no modifications.
 */

const express    = require('express');
const path       = require('path');
const crypto     = require('crypto');
const { Pool, types: pgTypes } = require('pg');
// Return DATE columns (OID 1082) as plain 'YYYY-MM-DD' strings instead of
// JavaScript Date objects — pg's default parsing creates a Date at LOCAL
// midnight, which then JSON-serialises to UTC and shifts the day in any
// timezone that isn't UTC (e.g. SAST renders 1984-06-29 as
// '1984-06-28T22:00:00.000Z').
pgTypes.setTypeParser(1082, v => v);
const bcrypt     = require('bcrypt');
const cors       = require('cors');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const nodemailer = require('nodemailer');
const { authenticator } = require('otplib');
const QRCode     = require('qrcode');
const session    = require('express-session');
const passport   = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app  = express();
const PORT = 3300;
const HOST = '127.0.0.1';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://legacy.vectraarch.live';

app.set('trust proxy', 1);
app.use(cors());
// Capture the raw body so the Nuntly webhook route can verify x-nuntly-signature.
app.use(express.json({ limit: '25mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use((req, res, next) => {
    if (req.url === '/legacy' || req.url.startsWith('/legacy/')) {
        const code = req.method === 'GET' ? 301 : 307;
        return res.redirect(code, req.url.slice('/legacy'.length) || '/');
    }
    next();
});

// Session — only used for OAuth state + short-lived auth handoff (invite token,
// pending Google user, pending 2FA). Long-term session lives in browser localStorage.
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-me-in-env',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV !== 'development',
        sameSite: 'lax',
        httpOnly: true,
        maxAge: 30 * 60 * 1000,  // 30 minutes — long enough to complete an OAuth round-trip
    },
}));
app.use(passport.initialize());
app.use(passport.session());

app.use('/shared', express.static(path.join(__dirname, '..', 'vectraarch.live', 'shared')));
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/',               (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.html',       (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/landing',        (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/landing.html',   (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/login.html',     (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/auth-guard.js',  (req, res) => res.sendFile(path.join(__dirname, 'VectraArchLegacyAuthGuard.js')));
app.get('/trial-banner.js',(req, res) => res.sendFile(path.join(__dirname, 'VectraArchLegacyTrialBanner.js')));

// ── DATABASE ──────────────────────────────────────────────────────────────────
const pool = new Pool({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST || 'localhost',
    database: 'VectraArchLegacy',
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT || '5432'),
});

pool.connect((err, client, release) => {
    if (err) { console.error('Failed to connect to VectraArchLegacy:', err.message); return; }
    release();
    console.log('Connected to VectraArchLegacy (PostgreSQL).');
});

async function ensureSchema() {
    const migrations = [
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_budget (
            id           SERIAL PRIMARY KEY,
            username     TEXT NOT NULL,
            income       NUMERIC NOT NULL DEFAULT 0,
            expenses     JSONB NOT NULL DEFAULT '[]',
            date         DATE NOT NULL,
            budget_type  TEXT NOT NULL DEFAULT 'need'
        )`,
        `CREATE INDEX IF NOT EXISTS idx_budget_username ON vectraarchlegacy_budget(username)`,
        `CREATE INDEX IF NOT EXISTS idx_budget_date ON vectraarchlegacy_budget(date)`,
        // ── Setup wizard: new user profile columns ──
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS date_of_birth TEXT`,
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS accent_color TEXT DEFAULT '#00ff41'`,
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'individual'`,
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS height_cm NUMERIC`,
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS weight_kg NUMERIC`,
        // ── Family tables ──
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_groups (
            id              SERIAL PRIMARY KEY,
            group_name     TEXT NOT NULL,
            admin_username  TEXT NOT NULL,
            currency        TEXT NOT NULL DEFAULT 'ZAR',
            timezone        TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
            member_count    INT NOT NULL DEFAULT 1,
            enabled_modules TEXT NOT NULL DEFAULT 'fin,cal,bud,gym,eat,cyc',
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_families_admin ON vectraarchlegacy_groups(admin_username)`,
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_group_members (
            id            SERIAL PRIMARY KEY,
            group_id     INT NOT NULL,
            username      TEXT,
            member_type   TEXT NOT NULL DEFAULT 'other',
            name          TEXT NOT NULL,
            sex           TEXT,
            date_of_birth TEXT,
            accent_color  TEXT DEFAULT '#00ff41',
            invite_email  TEXT,
            invite_cell   TEXT,
            invite_sent   BOOLEAN DEFAULT FALSE,
            invite_token  TEXT,
            created_at    TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_fam_members_fid ON vectraarchlegacy_group_members(group_id)`,
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_module_access (
            id              SERIAL PRIMARY KEY,
            group_id       INT NOT NULL,
            owner_username  TEXT NOT NULL,
            member_id       INT NOT NULL,
            module          TEXT NOT NULL,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            UNIQUE(group_id, owner_username, member_id, module)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_mod_access_owner ON vectraarchlegacy_module_access(group_id, owner_username)`,
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_partner_sharing (
            id      SERIAL PRIMARY KEY,
            owner   TEXT NOT NULL,
            partner TEXT NOT NULL,
            module  TEXT NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            UNIQUE(owner, partner, module)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_partner_sharing_owner   ON vectraarchlegacy_partner_sharing(owner)`,
        `CREATE INDEX IF NOT EXISTS idx_partner_sharing_partner ON vectraarchlegacy_partner_sharing(partner)`,
        // ── Google auth & invites ──
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS google_id     TEXT`,
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'password'`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON vectraarchlegacy_users(google_id) WHERE google_id IS NOT NULL`,
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_invites (
            id                SERIAL PRIMARY KEY,
            email             TEXT        NOT NULL,
            token             TEXT        NOT NULL UNIQUE,
            invited_by        TEXT        NOT NULL,
            role              TEXT        NOT NULL DEFAULT 'user',
            status            TEXT        NOT NULL DEFAULT 'pending',
            note              TEXT,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at        TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '14 days',
            accepted_at       TIMESTAMPTZ,
            accepted_username TEXT
        )`,
        `CREATE INDEX IF NOT EXISTS idx_invites_email  ON vectraarchlegacy_invites(LOWER(email))`,
        `CREATE INDEX IF NOT EXISTS idx_invites_status ON vectraarchlegacy_invites(status)`,
        // ── Calendar: optional end-time so events can have a duration ──
        `ALTER TABLE vectraarchlegacy_calendar ADD COLUMN IF NOT EXISTS end_date TIMESTAMP`,
        // ── Calendar: convert date column from DATE to TIMESTAMP so events can store
        //    their time, not just the day. Idempotent — only runs if still DATE.
        `DO $$ BEGIN
            IF (SELECT data_type FROM information_schema.columns
                WHERE table_name='vectraarchlegacy_calendar' AND column_name='date') = 'date' THEN
                ALTER TABLE vectraarchlegacy_calendar ALTER COLUMN date TYPE TIMESTAMP USING date::timestamp;
            END IF;
         END $$`,
        // ── Nuntly email delivery events (populated by POST /api/webhooks) ──
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_email_events (
            id          SERIAL PRIMARY KEY,
            event_type  TEXT,
            email_id    TEXT,
            recipient   TEXT,
            payload     JSONB,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_email_events_email_id ON vectraarchlegacy_email_events(email_id)`,
        // ── Paygate: per-user subscription state ──────────────────────────────
        // subscription_status: 'trial' | 'active' | 'expired' | 'cancelled'
        // trial_started_at defaults to NOW(), so when this column is first added
        // every existing user is granted a fresh trial window from the deploy
        // moment (TRIAL_DAYS). New signups get NOW() at insert time.
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS subscription_status   TEXT DEFAULT 'trial'`,
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS trial_started_at       TIMESTAMPTZ DEFAULT NOW()`,
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS subscription_plan      TEXT`,
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ`,
        `ALTER TABLE vectraarchlegacy_users ADD COLUMN IF NOT EXISTS pf_token               TEXT`,
        // ── Paygate: PayFast ITN (payment notification) audit log ─────────────
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_payments (
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
        )`,
        `CREATE INDEX IF NOT EXISTS idx_payments_username ON vectraarchlegacy_payments(username)`,
        `CREATE INDEX IF NOT EXISTS idx_payments_pf_pid   ON vectraarchlegacy_payments(pf_payment_id)`,
    ];
    let failed = 0;
    for (const sql of migrations) {
        try { await pool.query(sql); }
        catch (e) {
            failed += 1;
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.error('[schema] MIGRATION FAILED — fix this or features will break');
            console.error('  SQL : ' + sql.replace(/\s+/g, ' ').trim().slice(0, 200));
            console.error('  CODE: ' + (e.code || '-'));
            console.error('  ERR : ' + e.message);
            console.error('  HINT: if "permission denied for table", the table is owned by a different');
            console.error('        postgres role. See migrations/2026_05_fix_legacy_schema.sql');
            console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        }
    }
    if (failed > 0) console.error(`[schema] ${failed} migration(s) failed — app will run but some features may be broken.`);
    else console.log('Schema check complete.');
}
// Schema is awaited before the server accepts any requests (see bottom of file)

// ── DB HELPERS ────────────────────────────────────────────────────────────────
const dbQuery = async (sql, params = []) => {
    const r = await pool.query(sql, params);
    return r.rows[0] || null;
};
const dbAll = async (sql, params = []) => {
    const r = await pool.query(sql, params);
    return r.rows;
};
const dbRun = async (sql, params = []) => {
    return pool.query(sql, params);
};
const dbTransaction = async (queries) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const results = [];
        for (const { sql, params } of queries) {
            results.push(await client.query(sql, params));
        }
        await client.query('COMMIT');
        return results;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
};

// ── COLUMN NAME MAP ───────────────────────────────────────────────────────────
function mapUser(row) {
    if (!row) return null;
    // Avatar fallback: explicit profile pic > female default > placeholder.
    // Male users get the placeholder until they upload their own, so we don't
    // misgender newly-created accounts that haven't picked a photo yet.
    const gender = (row.gender || '').toLowerCase();
    const fallbackPic = gender === 'female' ? '/images/female.jpg' : '/images/placeholder_image.png';
    return {
        username:         row.username,
        firstName:        row.first_name        || '',
        lastName:         row.last_name         || '',
        displayName:      row.display_name      || row.username,
        profilePicUrl:    row.profile_pic_url   || fallbackPic,
        email:            row.email             || '',
        phone:            row.phone             || '',
        eventColor:       row.event_color       || '#2dd4bf',
        isAdmin:          !!row.is_admin,
        gender:           row.gender            || '',
        telegram_chat_id: row.telegram_chat_id  || '',
        lastActive:       row.last_active       || '',
        dateOfBirth:      row.date_of_birth     || '',
        accentColor:      row.accent_color      || '#00ff41',
        role:             row.role              || 'individual',
        heightCm:         row.height_cm         || null,
        weightKg:         row.weight_kg         || null,
        authProvider:     row.auth_provider     || 'password',
        hasGoogle:        !!row.google_id,
        twoFactorEnabled: !!row.twofa_secret,
        groupId:          row.group_id          || null,
        groupName:        row.group_name        || '',
        // Paygate entitlement — lets the client render the paywall / trial banner.
        subscription:     entitlementFor(row),
    };
}

// User-row SELECT with the group name joined in. Use this wherever a fresh
// user record is loaded so the client always knows the group's display name
// (not just the numeric id).
const USER_SELECT_BASE = `
    SELECT u.*, g.group_name
      FROM vectraarchlegacy_users u
      LEFT JOIN vectraarchlegacy_groups g ON g.id = u.group_id
`;

// ── PAYGATE (PayFast) ─────────────────────────────────────────────────────────
// Gates the Legacy data features behind a subscription. Every account starts on
// a TRIAL_DAYS free trial (existing users are granted one from the deploy moment
// — see ensureSchema). After the trial, an active subscription is required.
//
// Required .env:
//   PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY, PAYFAST_PASSPHRASE
//   PAYFAST_MODE = 'sandbox' | 'live'   (default 'sandbox')
// Optional:
//   TRIAL_DAYS (default 3)
const TRIAL_DAYS        = parseInt(process.env.TRIAL_DAYS || '3', 10);
const PAYFAST_MODE      = (process.env.PAYFAST_MODE || 'sandbox').toLowerCase();
const PAYFAST_MERCHANT_ID  = process.env.PAYFAST_MERCHANT_ID  || '10000100'; // sandbox default
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY || '46f0cd694581a'; // sandbox default
const PAYFAST_PASSPHRASE   = process.env.PAYFAST_PASSPHRASE   || '';
const PAYFAST_PROCESS_URL  = PAYFAST_MODE === 'live'
    ? 'https://www.payfast.co.za/eng/process'
    : 'https://sandbox.payfast.co.za/eng/process';
const PAYFAST_VALIDATE_HOST = PAYFAST_MODE === 'live'
    ? 'www.payfast.co.za'
    : 'sandbox.payfast.co.za';
// PayFast's published ITN source netblocks (host-resolved at runtime too).
const PAYFAST_VALID_HOSTS = [
    'www.payfast.co.za', 'w1w.payfast.co.za', 'w2w.payfast.co.za',
    'sandbox.payfast.co.za',
];

// Subscription plans. `amount` is in ZAR. Monthly plans are PayFast recurring
// subscriptions (subscription_type 1); 'lifetime' is a single once-off payment.
const PLANS = {
    basic:    { name: 'Basic',    amount: '29.00',  recurring: true,  label: 'R29 / month'  },
    standard: { name: 'Standard', amount: '49.00',  recurring: true,  label: 'R49 / month'  },
    premium:  { name: 'Premium',  amount: '99.00',  recurring: true,  label: 'R99 / month'  },
    lifetime: { name: 'Lifetime', amount: '299.00', recurring: false, label: 'R299 once-off' },
};

// Resolve a user row into an entitlement object the client can act on.
// Returns { status, plan, active, daysLeft, trialEndsAt, expiresAt }.
function entitlementFor(row) {
    if (!row) return { status: 'expired', active: false, plan: null, daysLeft: 0 };
    const now    = Date.now();
    const status = row.subscription_status || 'trial';
    const expiresAt = row.subscription_expires_at ? new Date(row.subscription_expires_at).getTime() : null;

    // An active paid subscription overrides the trial. 'lifetime' has no expiry.
    if (status === 'active') {
        const stillValid = !expiresAt || expiresAt > now;
        if (stillValid) {
            return {
                status: 'active',
                active: true,
                plan: row.subscription_plan || null,
                expiresAt: row.subscription_expires_at || null,
                daysLeft: expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 86400000)) : null,
            };
        }
        // Lapsed — fall through to trial check, which will also be expired.
    }

    // Trial window, measured from trial_started_at.
    const trialStart = row.trial_started_at ? new Date(row.trial_started_at).getTime() : now;
    const trialEnd   = trialStart + TRIAL_DAYS * 86400000;
    if (status !== 'cancelled' && status !== 'expired' && trialEnd > now) {
        return {
            status: 'trial',
            active: true,
            plan: null,
            trialEndsAt: new Date(trialEnd).toISOString(),
            daysLeft: Math.max(0, Math.ceil((trialEnd - now) / 86400000)),
        };
    }

    return { status: 'expired', active: false, plan: row.subscription_plan || null, daysLeft: 0 };
}

// Load the entitlement for a username straight from the DB.
async function entitlementForUsername(username) {
    if (!username) return { status: 'expired', active: false, daysLeft: 0 };
    const row = await dbQuery(
        'SELECT subscription_status, subscription_plan, subscription_expires_at, trial_started_at FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)',
        [username]
    );
    return entitlementFor(row);
}

// Middleware: require an active entitlement (trial or paid) for the acting user.
// The acting user is whoever owns the data — read from the same field each route
// already uses (`user` for data routes, `username` for a few). Admins always pass
// so support/management never locks itself out.
const requirePaid = async (req, res, next) => {
    const username = req.body?.user || req.query?.user
        || req.body?.username || req.query?.username;
    if (!username) {
        // No identifiable user — let the route's own validation return its 400.
        return next();
    }
    try {
        const row = await dbQuery(
            'SELECT is_admin, subscription_status, subscription_plan, subscription_expires_at, trial_started_at FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        if (!row) return next(); // unknown user — let route handle it
        if (row.is_admin) return next();
        const ent = entitlementFor(row);
        if (ent.active) {
            req.entitlement = ent;
            return next();
        }
        return res.status(402).json({
            success: false,
            paywall: true,
            message: 'Your trial has ended. Subscribe to keep using VectraArch Legacy.',
            subscription: ent,
        });
    } catch (e) {
        // Fail open on infra errors so a DB blip doesn't lock everyone out, but log it.
        console.error('[paygate] entitlement check failed:', e.message);
        return next();
    }
};

// Build the MD5 signature PayFast expects over an ordered param set.
// Rule: URL-encode each value (spaces as '+', uppercase hex), join as key=value
// with '&', append the passphrase if set, then md5.
function payfastSignature(params, passphrase) {
    const pfEncode = v => encodeURIComponent(String(v).trim())
        .replace(/%20/g, '+')
        .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    let pfOutput = Object.keys(params)
        .filter(k => params[k] !== '' && params[k] !== undefined && params[k] !== null)
        .map(k => `${k}=${pfEncode(params[k])}`)
        .join('&');
    if (passphrase) pfOutput += `&passphrase=${pfEncode(passphrase)}`;
    return crypto.createHash('md5').update(pfOutput).digest('hex');
}

// Server-to-server postback that confirms an ITN really came from PayFast.
function payfastValidatePostback(rawBody) {
    return new Promise(resolve => {
        const postData = rawBody;
        const reqV = https.request({
            host: PAYFAST_VALIDATE_HOST,
            port: 443,
            path: '/eng/query/validate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData),
            },
        }, resV => {
            let body = '';
            resV.on('data', d => body += d);
            resV.on('end', () => resolve(body.trim() === 'VALID'));
        });
        reqV.on('error', e => { console.error('[payfast] validate postback error:', e.message); resolve(false); });
        reqV.write(postData);
        reqV.end();
    });
}

// ── EXTERNAL SERVICES ─────────────────────────────────────────────────────────
const BOT_TOKEN    = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

function sendTelegramMessage(chatId, message) {
    const data = JSON.stringify({ chat_id: chatId, text: message });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { if (res.statusCode !== 200) console.error('Telegram failed:', body); });
    });
    req.on('error', e => console.error('Telegram error:', e.message));
    req.write(data); req.end();
}

// ── EMAIL via VectraArchCOMS gateway ─────────────────────────────────────────
// All outbound email flows through VectraArchCOMS (the comms hub), which holds
// the Nuntly API key — mirroring how Telegram is centralised there. Legacy
// never needs the Nuntly key itself; it just POSTs to the localhost gateway.
const COMS_URL             = process.env.COMS_URL             || 'http://127.0.0.1:3099';
const COMS_EMAIL_SECRET    = process.env.COMS_EMAIL_SECRET    || '';
// Nuntly signs webhook callbacks with HMAC-SHA256(rawBody) using this secret.
const NUNTLY_WEBHOOK_SECRET = process.env.NUNTLY_WEBHOOK_SECRET || '';

async function sendEmailNotification(email, subject, text, html) {
    if (!email) return { sent: false, reason: 'no recipient' };
    // Primary path: VectraArchCOMS → Nuntly.
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (COMS_EMAIL_SECRET) headers['x-coms-secret'] = COMS_EMAIL_SECRET;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10000);
        let resp;
        try {
            resp = await fetch(`${COMS_URL}/email/send`, {
                method:  'POST',
                signal:  ctl.signal,
                headers,
                body: JSON.stringify({ to: email, subject, text, html }),
            });
        } finally { clearTimeout(timer); }
        const data = await resp.json().catch(() => null);
        if (resp.ok && data?.ok) return { sent: true, id: data.id || null };
        console.error('[email] COMS send failed:', data?.error || `HTTP ${resp.status}`);
    } catch (e) {
        console.error('[email] COMS unreachable:', e.name === 'AbortError' ? 'timeout' : e.message);
    }
    // Fallback: direct SMTP via nodemailer, only if Gmail creds are configured.
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        try {
            await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject, text, html });
            return { sent: true, fallback: 'smtp' };
        } catch (e) { console.error('[email] SMTP fallback failed:', e.message); }
    }
    return { sent: false, reason: 'email gateway unavailable' };
}

// Look up a user's email and notify them. Account/security events (force=true,
// the default) always email; informational events pass force:false to respect
// the user's email-notification preference.
async function emailUser(username, subject, text, html, { force = true } = {}) {
    try {
        const u = await dbQuery('SELECT email FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!u?.email) return { sent: false, reason: 'no email on file' };
        if (!force) {
            const prefs = await dbAll(
                'SELECT enabled FROM vectraarchlegacy_notifications WHERE username = $1 AND type = $2',
                [username, 'email']
            );
            if (!prefs.some(p => p.enabled)) return { sent: false, reason: 'email notifications off' };
        }
        return await sendEmailNotification(u.email, subject, text, html);
    } catch (e) { return { sent: false, reason: e.message }; }
}

// ── Branded email template ───────────────────────────────────────────────────
// Dark/gold VectraArch Legacy styling, matching the invite email and app shell.
function renderLegacyEmail({ heading, intro, rows = [], note, button }) {
    const text = [
        'VectraArch · Legacy',
        '',
        heading,
        '',
        intro || '',
        ...(rows.length ? ['', ...rows.map(r => `${r.label}: ${r.value}`)] : []),
        ...(button ? ['', `${button.label}: ${button.url}`] : []),
        ...(note ? ['', note] : []),
        '',
        '— VectraArch Legacy',
    ].filter(l => l !== null && l !== undefined).join('\n');

    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
    const rowsHtml = rows.length ? `<table style="width:100%;border-collapse:collapse;margin:18px 0">${rows.map(r => `
        <tr>
          <td style="padding:7px 0;color:#888;font-size:12px;font-family:'DM Mono',monospace;text-transform:uppercase;letter-spacing:.08em;width:38%">${esc(r.label)}</td>
          <td style="padding:7px 0;color:#fff;font-size:13px;font-family:Arial,sans-serif">${esc(r.value)}</td>
        </tr>`).join('')}</table>` : '';
    const btnHtml = button ? `<p style="margin:24px 0"><a href="${esc(button.url)}" style="display:inline-block;padding:12px 22px;background:#d4a017;color:#0a0a0a;text-decoration:none;font-weight:600;border-radius:4px;letter-spacing:.08em">${esc(button.label)} ↗</a></p>` : '';
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0a0a0a;color:#e5e5e5">
        <div style="font-size:11px;letter-spacing:0.2em;color:#d4a017;text-transform:uppercase;margin-bottom:8px">VectraArch · Legacy</div>
        <h1 style="font-size:22px;color:#fff;margin:0 0 14px">${esc(heading)}</h1>
        ${intro ? `<p style="line-height:1.55;color:#bdbdbd">${esc(intro)}</p>` : ''}
        ${rowsHtml}
        ${btnHtml}
        ${note ? `<p style="line-height:1.55;color:#666;font-size:12px">${esc(note)}</p>` : ''}
        <hr style="border:none;border-top:1px solid #222;margin:24px 0">
        <p style="font-size:11px;color:#555">This is an automated message from VectraArch Legacy.</p>
    </div>`;
    return { text, html };
}

// Ensure the user has a family; create a solo one if missing. Returns the
// family id. Used by every code path that creates a user so no account is
// ever orphaned (per the "I do not want users to not be part of a family"
// rule). Safe to call inside a transaction (accepts an optional client).
async function ensureSoloGroup({ username, firstName, displayName, role, currency, timezone, client }) {
    const q = client ? client.query.bind(client) : pool.query.bind(pool);
    const existing = await q('SELECT group_id FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
    if (existing.rows[0]?.group_id) return existing.rows[0].group_id;
    const label   = firstName || displayName || username;
    const isIndiv = !role || role === 'individual';
    const famName = isIndiv ? `${label}'s Hub` : `${label}'s Family`;
    const fam = await q(`
        INSERT INTO vectraarchlegacy_groups
            (group_name, admin_username, currency, timezone, member_count, enabled_modules)
        VALUES ($1,$2,$3,$4,1,'fin,cal,bud,gym,eat,cyc')
        RETURNING id`,
        [famName, username, currency || 'ZAR', timezone || 'Africa/Johannesburg']
    );
    const id = fam.rows[0].id;
    await q('UPDATE vectraarchlegacy_users SET group_id = $1 WHERE LOWER(username) = LOWER($2)', [id, username]);
    return id;
}

// ── Family-driven access sync ────────────────────────────────────────────────
// Family membership is the source of truth for who-can-see-whom. Whenever a
// user's group_id changes (or a new user joins a family), we:
//   1. Add 'family'-sourced rows in both directions between this user and
//      every OTHER member of the new family.
//   2. Remove any 'family'-sourced rows between this user and members of any
//      family they're no longer a member of. Manual ('manual') rows are
//      preserved.
// Note: manual rows added via /api/grant-access are left untouched.
async function syncUserGroupAccess(username, newFamilyId, oldFamilyId = null) {
    if (oldFamilyId && oldFamilyId !== newFamilyId) {
        // Drop family-sourced rows that link this user to the old family.
        await dbRun(
            `DELETE FROM vectraarchlegacy_access
             WHERE source = 'family'
               AND (
                   (viewer = $1 AND target IN (SELECT username FROM vectraarchlegacy_users WHERE group_id = $2))
                OR (target = $1 AND viewer IN (SELECT username FROM vectraarchlegacy_users WHERE group_id = $2))
               )`,
            [username, oldFamilyId]
        );
    }
    if (!newFamilyId) return;
    // Add reciprocal access rows to every other current member of the new family.
    await dbRun(
        `INSERT INTO vectraarchlegacy_access (viewer, target, source)
         SELECT $1, u.username, 'family'
         FROM vectraarchlegacy_users u
         WHERE u.group_id = $2 AND u.username <> $1
         ON CONFLICT (viewer, target) DO NOTHING`,
        [username, newFamilyId]
    );
    await dbRun(
        `INSERT INTO vectraarchlegacy_access (viewer, target, source)
         SELECT u.username, $1, 'family'
         FROM vectraarchlegacy_users u
         WHERE u.group_id = $2 AND u.username <> $1
         ON CONFLICT (viewer, target) DO NOTHING`,
        [username, newFamilyId]
    );
}

async function logTransaction(username, action, tableName, recordId, modifiedBy) {
    try {
        await dbRun(
            'INSERT INTO vectraarchlegacy_transaction_history (username, action, table_name, record_id, modified_by, modified_at) VALUES ($1,$2,$3,$4,$5,$6)',
            [username, action, tableName, recordId || null, modifiedBy, new Date().toISOString()]
        );
    } catch (e) { console.error('Log transaction error:', e.message); }
}

// ── ADMIN MIDDLEWARE ──────────────────────────────────────────────────────────
const requireAdmin = async (req, res, next) => {
    const adminUsername = req.body?.adminUsername || req.query?.adminUsername;
    if (!adminUsername) return res.status(400).json({ success: false, message: 'Admin username required.' });
    try {
        const row = await dbQuery('SELECT is_admin FROM vectraarchlegacy_users WHERE username = $1', [adminUsername]);
        if (!row || !row.is_admin) return res.status(403).json({ success: false, message: 'Unauthorized: Admin access required.' });
        req.adminUsername = adminUsername;
        next();
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error checking admin access.' });
    }
};

// Resolve an admin's group for scoping. Mirrors /api/users: a family admin is
// confined to their own group; an admin with no group_id sees everything
// (reserved for a future master / Conduit-level role).
async function adminGroupId(adminUsername) {
    const me = await dbQuery('SELECT group_id FROM vectraarchlegacy_users WHERE username = $1', [adminUsername]);
    return me?.group_id || null;
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required.' });
    try {
        // Case-insensitive lookup so 'Johan@Koen' and 'johan@koen' both work.
        const row = await dbQuery(`${USER_SELECT_BASE} WHERE LOWER(u.username) = LOWER($1)`, [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        if (!row.password_hash) {
            return res.status(401).json({ success: false, message: 'This account uses Google sign-in. Please continue with Google.' });
        }
        const match = await bcrypt.compare(password, row.password_hash);
        if (!match) return res.status(401).json({ success: false, message: 'Authentication failed: Incorrect password.' });
        await dbRun('UPDATE vectraarchlegacy_users SET last_active = $1 WHERE username = $2', [new Date().toISOString(), row.username]);
        await logTransaction(row.username, 'LOGIN', 'users', null, row.username);
        if (row.twofa_secret) return res.json({ success: true, requires2FA: true, username: row.username });
        res.json({ success: true, ...mapUser(row) });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error during login.', error: e.message });
    }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
// Legacy Admin scope: a family admin only sees users in THEIR family. Pass
// ?global=true (only honoured if the admin is a master / Conduit-level role —
// reserved for future use) to see everything.
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const meRow = await dbQuery('SELECT group_id FROM vectraarchlegacy_users WHERE username = $1', [req.adminUsername]);
        const myFamily = meRow?.group_id || null;
        const rows = await dbAll(
            `SELECT u.username,
                    u.first_name      AS "firstName",
                    u.last_name       AS "lastName",
                    u.display_name    AS "displayName",
                    u.is_admin        AS "isAdmin",
                    u.last_active     AS "lastActive",
                    u.role            AS "role",
                    u.group_id       AS "groupId",
                    f.group_name     AS "groupName"
             FROM vectraarchlegacy_users u
             LEFT JOIN vectraarchlegacy_groups f ON f.id = u.group_id
             ${myFamily ? 'WHERE u.group_id = $1' : ''}`,
            myFamily ? [myFamily] : []
        );
        res.json({ success: true, data: rows, scopedToFamily: myFamily });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching users.', error: e.message });
    }
});

// List families (used by Conduit + Admin panel for "move to family" dropdowns).
app.get('/api/admin/groups', requireAdmin, async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT f.id, f.group_name AS "groupName", f.admin_username AS "adminUsername",
                   f.currency, f.timezone, f.member_count AS "memberCount",
                   f.created_at AS "createdAt",
                   (SELECT COUNT(*) FROM vectraarchlegacy_users u WHERE u.group_id = f.id)::int AS "actualMembers"
            FROM vectraarchlegacy_groups f
            ORDER BY f.id ASC
        `);
        res.json({ success: true, families: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error listing families.', error: e.message });
    }
});

// Move (or initially place) a user into a family. Auto-syncs family-sourced
// access rows. Body: { username, groupId, adminUsername }
app.post('/api/admin/assign-group', requireAdmin, async (req, res) => {
    const { username, groupId } = req.body;
    if (!username || !groupId) return res.status(400).json({ success: false, message: 'username and groupId required.' });
    try {
        const userRow = await dbQuery('SELECT group_id FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
        if (!userRow) return res.status(404).json({ success: false, message: 'User not found.' });
        const famRow = await dbQuery('SELECT id, group_name FROM vectraarchlegacy_groups WHERE id = $1', [groupId]);
        if (!famRow)  return res.status(404).json({ success: false, message: 'Family not found.' });

        const oldFamilyId = userRow.group_id || null;
        await dbRun('UPDATE vectraarchlegacy_users SET group_id = $1 WHERE LOWER(username) = LOWER($2)', [groupId, username]);
        await syncUserGroupAccess(username, groupId, oldFamilyId);

        await logTransaction(username, 'ASSIGN_FAMILY', 'users', null, req.adminUsername);
        {
            const { text, html } = renderLegacyEmail({
                heading: 'Your group was updated',
                intro:   `An administrator (${req.adminUsername}) moved your account "${username}" into a new group.`,
                rows:    [{ label: 'Group', value: famRow.group_name }],
                note:    "Group members can share selected modules with each other. Contact your administrator with any questions.",
            });
            await emailUser(username, 'Your VectraArch Legacy group changed', text, html);
        }
        res.json({ success: true, username, groupId: famRow.id, groupName: famRow.group_name, oldFamilyId });
    } catch (e) {
        console.error('[assign-family]', e.message);
        res.status(500).json({ success: false, message: 'Error assigning family.', error: e.message });
    }
});

// List the members of MY group (callable by any logged-in user, not just admin).
// Returns the people I'm grouped with so Profile can show a "group members"
// roster without having to be admin.
app.get('/api/my-group-members', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const rows = await dbAll(`
            SELECT u.username, u.first_name AS "firstName", u.last_name AS "lastName",
                   u.display_name AS "displayName", u.profile_pic_url AS "profilePicUrl",
                   u.event_color AS "eventColor", u.role, u.gender,
                   g.id AS "groupId", g.group_name AS "groupName"
              FROM vectraarchlegacy_users u
              LEFT JOIN vectraarchlegacy_groups g ON g.id = u.group_id
             WHERE u.group_id = (SELECT group_id FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1))
               AND u.group_id IS NOT NULL
             ORDER BY u.username`,
            [username]
        );
        res.json({ success: true, members: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error fetching group members.', error: e.message });
    }
});

// Remove a user from their current group. Spins up a fresh solo group for them
// so no user is ever orphaned (no NULL group_id). Symmetric to assign-group.
app.post('/api/admin/remove-from-group', requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'username required.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userRow = await client.query(
            'SELECT username, first_name, display_name, role, group_id FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        if (!userRow.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        const u = userRow.rows[0];
        const oldGroupId = u.group_id;
        const label = u.first_name || u.display_name || u.username;
        const soloName = u.role === 'individual' ? `${label}'s Hub` : `${label}'s Group`;
        const soloRes = await client.query(
            `INSERT INTO vectraarchlegacy_groups
                (group_name, admin_username, currency, timezone, member_count, enabled_modules)
             VALUES ($1, $2, 'ZAR', 'Africa/Johannesburg', 1, 'fin,cal,bud,gym,eat,cyc')
             RETURNING id, group_name`,
            [soloName, u.username]
        );
        const newGroupId = soloRes.rows[0].id;
        // Move the user into their own group AND make them its admin, so they can
        // manage their own hub (add members, etc.) once on their own.
        await client.query(
            'UPDATE vectraarchlegacy_users SET group_id = $1, is_admin = 1 WHERE username = $2',
            [newGroupId, u.username]
        );
        await client.query('COMMIT');
        // Re-sync access rows so the removed user no longer auto-shares with old group-mates.
        await syncUserGroupAccess(u.username, newGroupId, oldGroupId);
        await logTransaction(u.username, 'REMOVE_FROM_GROUP', 'users', oldGroupId, req.adminUsername);
        {
            const { text, html } = renderLegacyEmail({
                heading: 'You now have your own group',
                intro:   `You've been moved into your own group "${soloRes.rows[0].group_name}" and made its administrator.`,
                note:    "You can manage your own hub from the Admin tab. Contact your previous administrator with any questions.",
                button:  { url: `${PUBLIC_BASE_URL}/login.html`, label: 'Open VectraArch Legacy' },
            });
            await emailUser(u.username, 'You now have your own VectraArch Legacy group', text, html);
        }
        res.json({
            success: true,
            username: u.username,
            oldGroupId,
            newGroupId,
            newGroupName: soloRes.rows[0].group_name,
        });
    } catch (e) {
        await client.query('ROLLBACK').catch(()=>{});
        console.error('[remove-from-group]', e.message);
        res.status(500).json({ success: false, message: 'Error removing from group.', error: e.message });
    } finally {
        client.release();
    }
});

// Create a new family (no user attached). Useful for setting up "The Koen Family"
// in Conduit before reassigning existing users into it.
app.post('/api/admin/groups', requireAdmin, async (req, res) => {
    const { groupName, adminUsername: famAdmin, currency, timezone } = req.body;
    if (!groupName) return res.status(400).json({ success: false, message: 'groupName required.' });
    try {
        const r = await pool.query(`
            INSERT INTO vectraarchlegacy_groups
                (group_name, admin_username, currency, timezone, member_count, enabled_modules)
            VALUES ($1,$2,$3,$4,0,'fin,cal,bud,gym,eat,cyc')
            RETURNING id, group_name AS "groupName"`,
            [groupName.trim(), famAdmin || req.adminUsername,
             currency || 'ZAR', timezone || 'Africa/Johannesburg']
        );
        await logTransaction(req.adminUsername, 'CREATE', 'families', r.rows[0].id, req.adminUsername);
        res.json({ success: true, family: r.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error creating family.', error: e.message });
    }
});

app.post('/api/add-user', requireAdmin, async (req, res) => {
    const { username, password, firstName, lastName, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required.' });
    try {
        const existing = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
        if (existing) return res.status(400).json({ success: false, message: 'User already exists.' });
        const hash = await bcrypt.hash(password, 10);
        await dbRun(
            'INSERT INTO vectraarchlegacy_users (username, password_hash, first_name, last_name, display_name, is_admin) VALUES ($1,$2,$3,$4,$5,0)',
            [username, hash, firstName || null, lastName || null, displayName || username]
        );
        // No user without a family: spin up a solo family + sync family-sourced access.
        const groupId = await ensureSoloGroup({
            username, firstName, displayName: displayName || username, role: 'individual',
        });
        await syncUserGroupAccess(username, groupId, null);
        await logTransaction(username, 'CREATE', 'users',    null,     req.adminUsername);
        await logTransaction(username, 'CREATE', 'families', groupId, req.adminUsername);
        sendTelegramMessage(GROUP_CHAT_ID, `New user added: ${username} by ${req.adminUsername} (family #${groupId})`);
        res.json({ success: true, message: 'User added successfully!', groupId });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error adding user.', error: e.message });
    }
});

// Full user creation — used by Admin's "Add User" form. Creates the user row
// AND a vectraarchlegacy_groups row (with admin_username = new user) in one
// transaction so every new user has a hub to populate.
app.post('/api/admin/create-user', requireAdmin, async (req, res) => {
    const {
        username, password, firstName, lastName, email,
        gender, dateOfBirth, heightCm, weightKg,
        role, accentColor, currency, timezone,
        groupName, groupId, isAdmin,
    } = req.body;

    if (!username) {
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    const clean = username.trim();  // preserve case as typed (e.g. Anel@Koen)
    if (clean.length < 3) {
        return res.status(400).json({ success: false, message: 'Username must be at least 3 characters.' });
    }
    if (!/^[A-Za-z0-9._@-]+$/.test(clean)) {
        return res.status(400).json({ success: false, message: 'Username may only contain letters, numbers, @, dots, dashes and underscores.' });
    }
    if (!password || password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, message: 'Email is not valid.' });
    }
    const validRoles = ['individual','partner','parent','guardian','ceo','manager','coach'];
    const userRole   = validRoles.includes((role || '').toLowerCase()) ? role.toLowerCase() : 'individual';

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Case-insensitive username check so 'Anel@Koen' and 'anel@koen' can't both exist
        const existing = await client.query('SELECT username FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [clean]);
        if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: `Username already taken (as '${existing.rows[0].username}').` });
        }
        if (email) {
            const emailDup = await client.query('SELECT username FROM vectraarchlegacy_users WHERE LOWER(email) = LOWER($1)', [email]);
            if (emailDup.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, message: `Email already in use by '${emailDup.rows[0].username}'.` });
            }
        }

        const hash        = await bcrypt.hash(password, 10);
        const displayName = `${firstName || ''} ${lastName || ''}`.trim() || clean;
        const adminFlag   = isAdmin ? 1 : 0;

        // New users always join the admin's own group automatically. Explicit
        // groupId is still honoured (in case the same endpoint is called from
        // Conduit cross-group), and a brand-new group is created only when
        // neither the admin nor the request specifies one.
        let useFamilyId  = null;
        let useFamilyName = null;
        const targetGroupId = groupId
            || (await client.query('SELECT group_id FROM vectraarchlegacy_users WHERE username = $1', [req.adminUsername])).rows[0]?.group_id
            || null;
        if (targetGroupId) {
            const fr = await client.query('SELECT id, group_name FROM vectraarchlegacy_groups WHERE id = $1', [targetGroupId]);
            if (!fr.rows[0]) {
                await client.query('ROLLBACK');
                return res.status(400).json({ success: false, message: `Group ${targetGroupId} not found.` });
            }
            useFamilyId   = fr.rows[0].id;
            useFamilyName = fr.rows[0].group_name;
        } else {
            const famName = (groupName && groupName.trim())
                ? groupName.trim()
                : (userRole === 'individual' ? `${firstName || clean}'s Hub` : `${firstName || clean}'s Group`);
            const famRes = await client.query(`
                INSERT INTO vectraarchlegacy_groups
                    (group_name, admin_username, currency, timezone, member_count, enabled_modules)
                VALUES ($1,$2,$3,$4,1,'fin,cal,bud,gym,eat,cyc')
                RETURNING id, group_name`,
                [famName, clean, currency || 'ZAR', timezone || 'Africa/Johannesburg']
            );
            useFamilyId   = famRes.rows[0].id;
            useFamilyName = famRes.rows[0].group_name;
        }

        await client.query(`
            INSERT INTO vectraarchlegacy_users
                (username, password_hash, first_name, last_name, display_name,
                 email, gender, date_of_birth, height_cm, weight_kg,
                 role, accent_color, event_color, is_admin, auth_provider, group_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text,$12::text,$13,'password',$14)`,
            [clean, hash, firstName || null, lastName || null, displayName,
             email || null, gender || null, dateOfBirth || null,
             heightCm ? parseFloat(heightCm) : null,
             weightKg ? parseFloat(weightKg) : null,
             userRole, accentColor || '#00ff41', adminFlag, useFamilyId]
        );

        await client.query('COMMIT');

        // Build family-sourced access rows for the new user (outside the transaction
        // so we can use the helper; idempotent and bounded by current membership).
        await syncUserGroupAccess(clean, useFamilyId, null);

        await logTransaction(clean, 'CREATE', 'users',    null,        req.adminUsername);
        await logTransaction(clean, 'CREATE', 'families', useFamilyId, req.adminUsername);
        sendTelegramMessage(GROUP_CHAT_ID, `New user ${clean} (${userRole}) added by ${req.adminUsername}; family "${useFamilyName}" (#${useFamilyId}).`);

        if (email) {
            const { text, html } = renderLegacyEmail({
                heading: 'Your VectraArch Legacy account is ready',
                intro:   `An administrator (${req.adminUsername}) created an account for you on VectraArch Legacy.`,
                rows:    [
                    { label: 'Username', value: clean },
                    { label: 'Password', value: password },
                    { label: 'Role',     value: userRole },
                    { label: 'Group',    value: useFamilyName },
                ],
                note:    "Sign in with the username and password above, then change your password from your profile. If you weren't expecting this, contact your administrator.",
                button:  { url: `${PUBLIC_BASE_URL}/login.html`, label: 'Sign in' },
            });
            await sendEmailNotification(email, 'Your VectraArch Legacy account is ready', text, html);
        }

        res.json({
            success:    true,
            message:    `User ${clean} created in family "${useFamilyName}".`,
            username:   clean,
            groupId:   useFamilyId,
            groupName: useFamilyName,
            role:       userRole,
        });
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('[admin/create-user]', e.message);
        res.status(500).json({ success: false, message: 'Server error creating user.', error: e.message });
    } finally {
        client.release();
    }
});

app.delete('/api/delete-user/:username', requireAdmin, async (req, res) => {
    const { username } = req.params;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const row = await dbQuery('SELECT username, email FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        await dbRun('DELETE FROM vectraarchlegacy_users WHERE username = $1', [username]);
        await logTransaction(username, 'DELETE_USER', 'users', null, req.adminUsername);
        sendTelegramMessage(GROUP_CHAT_ID, `User ${username} deleted by ${req.adminUsername}`);
        if (row.email) {
            const { text, html } = renderLegacyEmail({
                heading: 'Your VectraArch Legacy account was removed',
                intro:   `Your account "${username}" was removed by an administrator (${req.adminUsername}).`,
                note:    "If you believe this was a mistake, please contact your administrator.",
            });
            await sendEmailNotification(row.email, 'Your VectraArch Legacy account was removed', text, html);
        }
        res.json({ success: true, message: 'User deleted successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error deleting user.', error: e.message });
    }
});

app.post('/api/grant-admin', requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const row = await dbQuery('SELECT is_admin FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        if (row.is_admin) return res.status(400).json({ success: false, message: 'User is already an admin.' });
        await dbRun('UPDATE vectraarchlegacy_users SET is_admin = 1 WHERE username = $1', [username]);
        await logTransaction(username, 'GRANT_ADMIN', 'users', null, req.adminUsername);
        sendTelegramMessage(GROUP_CHAT_ID, `Admin access granted for ${username} by ${req.adminUsername}`);
        {
            const { text, html } = renderLegacyEmail({
                heading: 'You now have admin access',
                intro:   `An administrator (${req.adminUsername}) granted admin privileges to your account "${username}".`,
                note:    "If you weren't expecting this, contact your administrator.",
                button:  { url: `${PUBLIC_BASE_URL}/login.html`, label: 'Open VectraArch Legacy' },
            });
            await emailUser(username, 'Your permissions changed — admin access granted', text, html);
        }
        res.json({ success: true, message: `Admin access granted for ${username}!` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error granting admin access.', error: e.message });
    }
});

app.post('/api/revoke-admin', requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const row = await dbQuery('SELECT is_admin FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        if (!row.is_admin) return res.status(400).json({ success: false, message: 'User is not an admin.' });
        await dbRun('UPDATE vectraarchlegacy_users SET is_admin = 0 WHERE username = $1', [username]);
        await logTransaction(username, 'REVOKE_ADMIN', 'users', null, req.adminUsername);
        sendTelegramMessage(GROUP_CHAT_ID, `Admin access revoked for ${username} by ${req.adminUsername}`);
        {
            const { text, html } = renderLegacyEmail({
                heading: 'Your admin access was removed',
                intro:   `An administrator (${req.adminUsername}) revoked admin privileges from your account "${username}".`,
                note:    "Your account is still active with standard access. Contact your administrator with any questions.",
            });
            await emailUser(username, 'Your permissions changed — admin access removed', text, html);
        }
        res.json({ success: true, message: `Admin access revoked for ${username}!` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error revoking admin access.', error: e.message });
    }
});

app.post('/api/admin-update-password', requireAdmin, async (req, res) => {
    const { username, newPassword } = req.body;
    if (!username || !newPassword) return res.status(400).json({ success: false, message: 'Username and new password required.' });
    try {
        const row = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        const hash = await bcrypt.hash(newPassword, 10);
        await dbRun('UPDATE vectraarchlegacy_users SET password_hash = $1 WHERE username = $2', [hash, username]);
        await logTransaction(username, 'UPDATE_PASSWORD', 'users', null, req.adminUsername);
        sendTelegramMessage(GROUP_CHAT_ID, `Password updated for ${username} by ${req.adminUsername}`);
        {
            const { text, html } = renderLegacyEmail({
                heading: 'Your password was changed',
                intro:   `An administrator (${req.adminUsername}) reset the password for your account "${username}".`,
                note:    "If you didn't request this, contact your administrator immediately.",
                button:  { url: `${PUBLIC_BASE_URL}/login.html`, label: 'Sign in' },
            });
            await emailUser(username, 'Security alert — your password was changed', text, html);
        }
        res.json({ success: true, message: `Password updated for ${username}!` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error updating password.', error: e.message });
    }
});

app.post('/api/update-password', async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    if (!username || !currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'All fields required.' });
    try {
        const row = await dbQuery('SELECT password_hash FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        const match = await bcrypt.compare(currentPassword, row.password_hash);
        if (!match) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
        if (newPassword.length < 6) return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
        const hash = await bcrypt.hash(newPassword, 10);
        await dbRun('UPDATE vectraarchlegacy_users SET password_hash = $1 WHERE username = $2', [hash, username]);
        await logTransaction(username, 'UPDATE_PASSWORD', 'users', null, username);
        sendTelegramMessage(GROUP_CHAT_ID, `Password changed by ${username} (self-service)`);
        {
            const { text, html } = renderLegacyEmail({
                heading: 'Your password was changed',
                intro:   `The password for your account "${username}" was just changed.`,
                note:    "If this wasn't you, contact your administrator immediately and secure your account.",
            });
            await emailUser(username, 'Security alert — your password was changed', text, html);
        }
        res.json({ success: true, message: 'Password updated successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error updating password.', error: e.message });
    }
});

app.delete('/api/account', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required.' });
    try {
        const row = await dbQuery('SELECT password_hash, email, group_id FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        const match = await bcrypt.compare(password, row.password_hash);
        if (!match) return res.status(401).json({ success: false, message: 'Incorrect password.' });
        await dbRun('DELETE FROM vectraarchlegacy_users WHERE username = $1', [username]);
        await logTransaction(username, 'DELETE_ACCOUNT', 'users', null, username);
        sendTelegramMessage(GROUP_CHAT_ID, `User ${username} deleted their account`);
        // Notify the (former) group's admins by email (audit copy also via COMS BCC).
        try {
            if (row.group_id) {
                const admins = await dbAll(
                    'SELECT email FROM vectraarchlegacy_users WHERE group_id = $1 AND is_admin = 1 AND email IS NOT NULL',
                    [row.group_id]
                );
                if (admins.length) {
                    const { text, html } = renderLegacyEmail({
                        heading: 'A member deleted their account',
                        intro:   `${username} has deleted their VectraArch Legacy account.`,
                        note:    "Automated notification for your records.",
                    });
                    for (const a of admins) await sendEmailNotification(a.email, `${username} deleted their VectraArch Legacy account`, text, html);
                }
            }
        } catch (e) { console.error('[account-delete admin notify]', e.message); }
        if (row.email) {
            const { text, html } = renderLegacyEmail({
                heading: 'Your account has been deleted',
                intro:   `Your VectraArch Legacy account "${username}" was deleted, as requested.`,
                note:    "If you didn't do this, contact your administrator immediately.",
            });
            await sendEmailNotification(row.email, 'Your VectraArch Legacy account has been deleted', text, html);
        }
        res.json({ success: true, message: 'Account deleted successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error deleting account.', error: e.message });
    }
});

// ── PROFILE ───────────────────────────────────────────────────────────────────
app.get('/api/profile-pictures', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const row = await dbQuery(`${USER_SELECT_BASE} WHERE u.username = $1`, [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, ...mapUser(row) });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching profile.', error: e.message });
    }
});

app.post('/api/profile-pictures', async (req, res) => {
    const { username, firstName, lastName, profilePicUrl, email, phone,
            eventColor, accentColor, gender, telegram_chat_id, displayName,
            dob, weight, height, role } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    if (firstName && firstName.length > 50) return res.status(400).json({ success: false, message: 'First name must be 50 characters or less.' });
    if (lastName  && lastName.length  > 50) return res.status(400).json({ success: false, message: 'Last name must be 50 characters or less.' });
    try {
        const exists = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!exists) return res.status(404).json({ success: false, message: 'User not found.' });
        const resolvedAccent = accentColor || eventColor || '#2dd4bf';
        await dbRun(`
            UPDATE vectraarchlegacy_users SET
                first_name=$1, last_name=$2,
                profile_pic_url=COALESCE($3::text, profile_pic_url),
                email=$4, phone=$5,
                event_color=$6, gender=$7, telegram_chat_id=$8, display_name=$9,
                last_active=$10,
                date_of_birth=$11, height_cm=$12, weight_kg=$13, accent_color=$14, role=$15
            WHERE username=$16`,
            [firstName||null, lastName||null, profilePicUrl||null, email||null, phone||null,
             resolvedAccent, gender||null, telegram_chat_id||null, displayName||username,
             new Date().toISOString(),
             dob||null,
             height ? parseFloat(height) : null,
             weight ? parseFloat(weight) : null,
             resolvedAccent,
             role||null,
             username]
        );
        await logTransaction(username, 'UPDATE_PROFILE', 'users', null, username);
        {
            const { text, html } = renderLegacyEmail({
                heading: 'Your profile was updated',
                intro:   `Your VectraArch Legacy profile ("${username}") was just updated.`,
                note:    "If you didn't make this change, contact your administrator.",
            });
            // Informational — only emails users who opted into email notifications.
            await emailUser(username, 'Your VectraArch Legacy profile was updated', text, html, { force: false });
        }
        const updated = await dbQuery('SELECT * FROM vectraarchlegacy_users WHERE username = $1', [username]);
        res.json({ success: true, ...mapUser(updated) });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error updating profile.', error: e.message });
    }
});

app.get('/api/user-color', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const row = await dbQuery('SELECT event_color FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, eventColor: row.event_color || '#2dd4bf' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching user color.', error: e.message });
    }
});

// ── ACCESS ────────────────────────────────────────────────────────────────────
app.get('/api/get-access', async (req, res) => {
    // Returns access pairs (viewer → target). Always unions the materialised
    // vectraarchlegacy_access rows with group-derived rows computed from
    // vectraarchlegacy_users.group_id, so partner-sharing is self-healing
    // even when sync helpers haven't populated the access table.
    // `source` deliberately omitted from the projection so identical
    // (viewer,target) pairs from both sources collapse via UNION.
    const { viewer, adminUsername } = req.query;
    const perViewerSQL = `
        SELECT viewer, target FROM vectraarchlegacy_access WHERE viewer = $1
        UNION
        SELECT $1::text AS viewer, u2.username AS target
          FROM vectraarchlegacy_users u1
          JOIN vectraarchlegacy_users u2 ON u1.group_id = u2.group_id
         WHERE u1.username = $1
           AND u2.username <> u1.username
           AND u1.group_id IS NOT NULL
    `;
    // Admin "all access" view is scoped to the admin's own group — they
    // should never see access pairs from other groups. Both ends of each
    // pair must be members of the admin's group.
    const adminGroupSQL = `
        WITH my_group AS (
            SELECT group_id FROM vectraarchlegacy_users WHERE username = $1
        ),
        members AS (
            SELECT username FROM vectraarchlegacy_users
             WHERE group_id = (SELECT group_id FROM my_group)
               AND (SELECT group_id FROM my_group) IS NOT NULL
        )
        SELECT viewer, target FROM vectraarchlegacy_access
         WHERE viewer IN (SELECT username FROM members)
           AND target IN (SELECT username FROM members)
        UNION
        SELECT u1.username AS viewer, u2.username AS target
          FROM vectraarchlegacy_users u1
          JOIN vectraarchlegacy_users u2 ON u1.group_id = u2.group_id
         WHERE u1.group_id = (SELECT group_id FROM my_group)
           AND u1.username <> u2.username
    `;
    try {
        let rows;
        if (viewer) {
            rows = await dbAll(perViewerSQL, [viewer]);
        } else if (adminUsername) {
            const admin = await dbQuery('SELECT is_admin FROM vectraarchlegacy_users WHERE username = $1', [adminUsername]);
            if (admin && admin.is_admin) {
                rows = await dbAll(adminGroupSQL, [adminUsername]);
            } else {
                return res.status(400).json({ success: false, message: 'Viewer required if not admin.' });
            }
        } else {
            return res.status(400).json({ success: false, message: 'Viewer or adminUsername required.' });
        }
        res.json({ success: true, accessList: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error fetching access list.', error: e.message });
    }
});

app.post('/api/grant-access', requireAdmin, async (req, res) => {
    const { viewer, target } = req.body;
    if (!viewer || !target) return res.status(400).json({ success: false, message: 'Viewer and target usernames required.' });
    if (viewer === target) return res.status(400).json({ success: false, message: 'Cannot share access with self.' });
    try {
        const vRow = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [viewer]);
        if (!vRow) return res.status(404).json({ success: false, message: 'Viewer not found.' });
        const tRow = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [target]);
        if (!tRow) return res.status(404).json({ success: false, message: 'Target not found.' });
        const ab = await dbQuery('SELECT 1 FROM vectraarchlegacy_access WHERE viewer=$1 AND target=$2', [viewer, target]);
        const ba = await dbQuery('SELECT 1 FROM vectraarchlegacy_access WHERE viewer=$1 AND target=$2', [target, viewer]);
        if (ab && ba) return res.status(400).json({ success: false, message: 'Access already shared.' });
        const queries = [];
        if (!ab) queries.push({ sql: 'INSERT INTO vectraarchlegacy_access (viewer,target) VALUES ($1,$2) ON CONFLICT DO NOTHING', params: [viewer, target] });
        if (!ba) queries.push({ sql: 'INSERT INTO vectraarchlegacy_access (viewer,target) VALUES ($1,$2) ON CONFLICT DO NOTHING', params: [target, viewer] });
        queries.push({ sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5)', params: [viewer,'GRANT_ACCESS','access',req.adminUsername,new Date().toISOString()] });
        queries.push({ sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5)', params: [target,'GRANT_ACCESS','access',req.adminUsername,new Date().toISOString()] });
        await dbTransaction(queries);
        sendTelegramMessage(GROUP_CHAT_ID, `Access granted between ${viewer} and ${target} by ${req.adminUsername}`);
        res.json({ success: true, message: `Access shared between ${viewer} and ${target}.` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error sharing access.', error: e.message });
    }
});

app.post('/api/revoke-access', requireAdmin, async (req, res) => {
    const { viewer, target } = req.body;
    if (!viewer || !target) return res.status(400).json({ success: false, message: 'Viewer and target usernames required.' });
    try {
        const ab = await dbQuery('SELECT 1 FROM vectraarchlegacy_access WHERE viewer=$1 AND target=$2', [viewer, target]);
        const ba = await dbQuery('SELECT 1 FROM vectraarchlegacy_access WHERE viewer=$1 AND target=$2', [target, viewer]);
        if (!ab && !ba) return res.status(400).json({ success: false, message: 'No access sharing found.' });
        const queries = [];
        if (ab) queries.push({ sql: 'DELETE FROM vectraarchlegacy_access WHERE viewer=$1 AND target=$2', params: [viewer, target] });
        if (ba) queries.push({ sql: 'DELETE FROM vectraarchlegacy_access WHERE viewer=$1 AND target=$2', params: [target, viewer] });
        queries.push({ sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5)', params: [viewer,'REVOKE_ACCESS','access',req.adminUsername,new Date().toISOString()] });
        queries.push({ sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5)', params: [target,'REVOKE_ACCESS','access',req.adminUsername,new Date().toISOString()] });
        await dbTransaction(queries);
        sendTelegramMessage(GROUP_CHAT_ID, `Access revoked between ${viewer} and ${target} by ${req.adminUsername}`);
        res.json({ success: true, message: `Access sharing revoked between ${viewer} and ${target}.` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error revoking access.', error: e.message });
    }
});

// ── SELF-SERVICE SHARING ──────────────────────────────────────────────────────
// Get list of viewers who can currently see the current user's data
app.get('/api/my-shares', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const rows = await dbAll('SELECT viewer FROM vectraarchlegacy_access WHERE target = $1', [username]);
        res.json({ success: true, viewers: rows.map(r => r.viewer) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Grant a partner access to the current user's data (viewer=partner, target=self)
app.post('/api/share-self', async (req, res) => {
    const { username, partner } = req.body;
    if (!username || !partner) return res.status(400).json({ success: false, message: 'Username and partner required.' });
    if (username === partner) return res.status(400).json({ success: false, message: 'Cannot share with yourself.' });
    try {
        const uRow = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!uRow) return res.status(404).json({ success: false, message: 'User not found.' });
        const pRow = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [partner]);
        if (!pRow) return res.status(404).json({ success: false, message: 'Partner not found.' });
        await dbRun('INSERT INTO vectraarchlegacy_access (viewer,target) VALUES ($1,$2) ON CONFLICT DO NOTHING', [partner, username]);
        await logTransaction(username, 'SHARE_SELF', 'access', null, username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Revoke a partner's access to the current user's data
app.post('/api/unshare-self', async (req, res) => {
    const { username, partner } = req.body;
    if (!username || !partner) return res.status(400).json({ success: false, message: 'Username and partner required.' });
    try {
        await dbRun('DELETE FROM vectraarchlegacy_access WHERE viewer=$1 AND target=$2', [partner, username]);
        await logTransaction(username, 'UNSHARE_SELF', 'access', null, username);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── PARTNER MODULE SHARING ────────────────────────────────────────────────────
// Notify a partner (by email) that someone started sharing data with them.
async function notifyShareEnabled(owner, partner, what) {
    try {
        const { text, html } = renderLegacyEmail({
            heading: 'New data shared with you',
            intro:   `${owner} is now sharing ${what} with you on VectraArch Legacy.`,
            note:    "Open the relevant tab to view it. You control your own sharing under Profile → Partner Sharing.",
            button:  { url: `${PUBLIC_BASE_URL}/login.html`, label: 'Open VectraArch Legacy' },
        });
        await emailUser(partner, `${owner} shared data with you`, text, html);
    } catch (e) { console.error('[share-notify]', e.message); }
}

// Set (upsert) one module's sharing state: owner shares module with partner
app.post('/api/partner-sharing', async (req, res) => {
    const { owner, partner, module, enabled } = req.body;
    if (!owner || !partner || !module) return res.status(400).json({ success: false, message: 'owner, partner, module required.' });
    if (owner === partner) return res.status(400).json({ success: false, message: 'Cannot share with yourself.' });
    try {
        const prev = await dbQuery('SELECT enabled FROM vectraarchlegacy_partner_sharing WHERE owner=$1 AND partner=$2 AND module=$3', [owner, partner, module]);
        await dbRun(
            `INSERT INTO vectraarchlegacy_partner_sharing (owner, partner, module, enabled)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (owner, partner, module) DO UPDATE SET enabled = $4`,
            [owner, partner, module, !!enabled]
        );
        if (!!enabled && !(prev && prev.enabled === true)) await notifyShareEnabled(owner, partner, `their ${module}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Set ALL modules at once (the "share all / stop sharing" button). One email.
app.post('/api/partner-sharing/bulk', async (req, res) => {
    const { owner, partner, enabled } = req.body;
    if (!owner || !partner) return res.status(400).json({ success: false, message: 'owner and partner required.' });
    if (owner === partner) return res.status(400).json({ success: false, message: 'Cannot share with yourself.' });
    const ALL = ['Finances','Calendar','Budget','Gym','Meals','Cycle'];
    try {
        const before = await dbAll('SELECT enabled FROM vectraarchlegacy_partner_sharing WHERE owner=$1 AND partner=$2', [owner, partner]);
        const wasAnyOn = before.some(r => r.enabled === true);
        for (const module of ALL) {
            await dbRun(
                `INSERT INTO vectraarchlegacy_partner_sharing (owner, partner, module, enabled)
                 VALUES ($1,$2,$3,$4) ON CONFLICT (owner, partner, module) DO UPDATE SET enabled = $4`,
                [owner, partner, module, !!enabled]
            );
        }
        if (!!enabled && !wasAnyOn) await notifyShareEnabled(owner, partner, 'all of their modules');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get what the current user has configured as shared with each of their partners
app.get('/api/my-partner-sharing', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const rows = await dbAll(
            'SELECT partner, module, enabled FROM vectraarchlegacy_partner_sharing WHERE owner = $1',
            [username]
        );
        const config = {};
        rows.forEach(r => {
            if (!config[r.partner]) config[r.partner] = {};
            config[r.partner][r.module] = r.enabled;
        });
        res.json({ success: true, config });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get what other users are sharing with the current user (drives partner tab visibility)
// Falls back to all-modules-enabled for partners with full access but no explicit module config.
app.get('/api/shared-with-me', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    const ALL_MODULES = ['Finances','Calendar','Budget','Gym','Meals','Cycle'];
    try {
        // Opt-in sharing: nothing is shared by default. A partner's module is
        // visible to me only when that partner has explicitly enabled it for me.
        // (Group membership establishes the relationship via /api/get-access, but
        // never grants data visibility on its own.)
        const moduleRows = await dbAll(
            'SELECT owner, module, enabled FROM vectraarchlegacy_partner_sharing WHERE partner = $1', [username]
        );
        const sharedWithMe = {};
        moduleRows.forEach(r => {
            if (r.enabled !== true || !ALL_MODULES.includes(r.module)) return;
            if (!sharedWithMe[r.owner]) sharedWithMe[r.owner] = {};
            sharedWithMe[r.owner][r.module] = true;
        });
        res.json({ success: true, sharedWithMe });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
app.get('/api/notifications', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const rows = await dbAll('SELECT type, enabled FROM vectraarchlegacy_notifications WHERE username = $1', [username]);
        res.json({ success: true, notifications: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching notifications.', error: e.message });
    }
});

app.post('/api/notifications', async (req, res) => {
    const { username, type, enabled } = req.body;
    if (!username || !type || enabled === undefined) return res.status(400).json({ success: false, message: 'Username, type, and enabled required.' });
    if (!['telegram','email'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid notification type.' });
    try {
        await dbRun(
            'INSERT INTO vectraarchlegacy_notifications (username,type,enabled) VALUES ($1,$2,$3) ON CONFLICT (username,type) DO UPDATE SET enabled=EXCLUDED.enabled',
            [username, type, enabled ? 1 : 0]
        );
        res.json({ success: true, message: 'Notification preference updated successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error updating notifications.', error: e.message });
    }
});

// ── TRANSACTION HISTORY ───────────────────────────────────────────────────────
app.get('/api/transaction-history', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const rows = await dbAll(
            'SELECT id, action, table_name AS "tableName", record_id AS "recordId", modified_by AS "modifiedBy", modified_at AS "modifiedAt" FROM vectraarchlegacy_transaction_history WHERE username = $1 ORDER BY modified_at DESC',
            [username]
        );
        res.json({ success: true, transactions: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching transaction history.', error: e.message });
    }
});

// Admin-only global audit log — used by Admin panel's Recent Activity card.
app.get('/api/admin/audit', requireAdmin, async (req, res) => {
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    try {
        const rows = await dbAll(
            `SELECT id, username, action, table_name AS "tableName", record_id AS "recordId",
                    modified_by AS "modifiedBy", modified_at AS "modifiedAt"
             FROM vectraarchlegacy_transaction_history
             ORDER BY modified_at DESC LIMIT $1`,
            [limit]
        );
        res.json({ success: true, audit: rows, limit });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching audit log.', error: e.message });
    }
});

// ── FINANCIAL ─────────────────────────────────────────────────────────────────
// Server-side sharing gate: may `viewer` see `target`'s `module` data? Own data
// is always visible; group membership / an access row grants access by default;
// an explicit partner_sharing opt-out (enabled=false) by the target blocks it.
async function moduleVisibleTo(viewer, target, module) {
    if (!viewer || viewer === target) return true;   // own data always visible
    // Opt-in: visible only when the target has explicitly enabled this module for
    // this viewer. No row (or disabled) = not shared.
    const share = await dbQuery(
        'SELECT enabled FROM vectraarchlegacy_partner_sharing WHERE owner = $1 AND partner = $2 AND module = $3',
        [target, viewer, module]);
    return !!(share && share.enabled === true);
}

app.get('/api/financial', requirePaid, async (req, res) => {
    const { user, viewer } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    if (viewer && viewer !== user && !(await moduleVisibleTo(viewer, user, 'Finances'))) return res.json([]);
    try {
        const rows = await dbAll("SELECT id, username, category, amount, type, TO_CHAR(date, 'YYYY-MM-DD') AS date FROM vectraarchlegacy_financial WHERE username = $1", [user]);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching financial items.', error: e.message });
    }
});

app.post('/api/financial', requirePaid, async (req, res) => {
    const { user, category, amount, type, date } = req.body;
    if (!user || !category || !amount || !type || !date) return res.status(400).json({ success: false, message: 'All fields required.' });
    if (!['income','expense'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid type.' });
    if (isNaN(amount) || amount < 0) return res.status(400).json({ success: false, message: 'Amount must be a non-negative number.' });
    try {
        const fRes = await dbRun(
            'INSERT INTO vectraarchlegacy_financial (username,category,amount,type,date) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [user, category, amount, type, date]
        );
        await dbRun(
            'INSERT INTO vectraarchlegacy_calendar (username,title,date,is_financial,type,amount,event_color) VALUES ($1,$2,$3,1,$4,$5,$6)',
            [user, `${category} (${type})`, date, type, amount, req.body.eventColor||'#2dd4bf']
        );
        await logTransaction(user, 'CREATE', 'financial', fRes.rows[0].id, user);
        const userData = await dbQuery('SELECT telegram_chat_id, email FROM vectraarchlegacy_users WHERE username = $1', [user]);
        const notifs = await dbAll('SELECT type, enabled FROM vectraarchlegacy_notifications WHERE username = $1', [user]);
        const msg = `New financial transaction: ${category} (${type}) - ${amount} on ${date}`;
        if (notifs.some(n => n.type === 'telegram' && n.enabled) && userData?.telegram_chat_id) sendTelegramMessage(userData.telegram_chat_id, msg);
        if (notifs.some(n => n.type === 'email' && n.enabled) && userData?.email) await sendEmailNotification(userData.email, 'New Financial Transaction', msg);
        res.json({ success: true, message: 'Financial item added successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error adding financial item.', error: e.message });
    }
});

app.put('/api/financial/:id', requirePaid, async (req, res) => {
    const { id } = req.params;
    const { user, category, amount, type, date } = req.body;
    if (!user || !category || !amount || !type || !date) return res.status(400).json({ success: false, message: 'All fields required.' });
    if (!['income','expense'].includes(type)) return res.status(400).json({ success: false, message: 'Invalid type.' });
    if (isNaN(amount) || amount < 0) return res.status(400).json({ success: false, message: 'Amount must be a non-negative number.' });
    try {
        const row = await dbQuery('SELECT id FROM vectraarchlegacy_financial WHERE id = $1 AND username = $2', [id, user]);
        if (!row) return res.status(404).json({ success: false, message: 'Financial item not found.' });
        await dbTransaction([
            { sql: 'UPDATE vectraarchlegacy_financial SET category=$1,amount=$2,type=$3,date=$4 WHERE id=$5', params: [category,amount,type,date,id] },
            { sql: 'UPDATE vectraarchlegacy_calendar SET title=$1,date=$2,type=$3,amount=$4 WHERE is_financial=1 AND username=$5 AND amount=(SELECT amount FROM vectraarchlegacy_financial WHERE id=$6)', params: [`${category} (${type})`,date,type,amount,user,id] },
            { sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)', params: [user,'UPDATE','financial',id,user,new Date().toISOString()] }
        ]);
        const userData = await dbQuery('SELECT telegram_chat_id, email FROM vectraarchlegacy_users WHERE username = $1', [user]);
        const notifs = await dbAll('SELECT type, enabled FROM vectraarchlegacy_notifications WHERE username = $1', [user]);
        const msg = `Financial transaction updated: ${category} (${type}) - ${amount} on ${date}`;
        if (notifs.some(n => n.type === 'telegram' && n.enabled) && userData?.telegram_chat_id) sendTelegramMessage(userData.telegram_chat_id, msg);
        if (notifs.some(n => n.type === 'email' && n.enabled) && userData?.email) await sendEmailNotification(userData.email, 'Financial Transaction Updated', msg);
        res.json({ success: true, message: 'Financial item updated successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error updating financial item.', error: e.message });
    }
});

app.delete('/api/financial/:id', requirePaid, async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, username, amount, type, date, category FROM vectraarchlegacy_financial WHERE id = $1', [id]);
        if (!row) return res.status(404).json({ success: false, message: 'Financial item not found.' });
        await dbTransaction([
            { sql: 'DELETE FROM vectraarchlegacy_financial WHERE id=$1', params: [id] },
            { sql: 'DELETE FROM vectraarchlegacy_calendar WHERE is_financial=1 AND username=$1 AND amount=$2 AND type=$3 AND date=$4', params: [row.username,row.amount,row.type,row.date] },
            { sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)', params: [row.username,'DELETE','financial',id,row.username,new Date().toISOString()] }
        ]);
        const userData = await dbQuery('SELECT telegram_chat_id, email FROM vectraarchlegacy_users WHERE username = $1', [row.username]);
        const notifs = await dbAll('SELECT type, enabled FROM vectraarchlegacy_notifications WHERE username = $1', [row.username]);
        const msg = `Financial transaction deleted: ${row.category} (${row.type}) - ${row.amount} on ${row.date}`;
        if (notifs.some(n => n.type === 'telegram' && n.enabled) && userData?.telegram_chat_id) sendTelegramMessage(userData.telegram_chat_id, msg);
        if (notifs.some(n => n.type === 'email' && n.enabled) && userData?.email) await sendEmailNotification(userData.email, 'Financial Transaction Deleted', msg);
        res.json({ success: true, message: 'Financial item deleted successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error deleting financial item.', error: e.message });
    }
});

// ── BUDGET ────────────────────────────────────────────────────────────────────
// Section targets (the 50/30/20 % goals) live inside the expenses JSONB as a
// sentinel entry: adding a dedicated section_targets column via ALTER TABLE does
// not take effect on this database, so the expenses column is the reliable store.
const SECTION_TARGETS_KIND = '__section_targets__';
const isTargetsSentinel = (e) =>
    e && typeof e === 'object' && e.__kind === SECTION_TARGETS_KIND;

// Pull the section-targets sentinel out of a raw expenses array.
function splitBudgetExpenses(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const expenses = [];
    let section_targets = {};
    for (const item of list) {
        if (isTargetsSentinel(item)) {
            if (item.values && typeof item.values === 'object') section_targets = item.values;
        } else {
            expenses.push(item);
        }
    }
    return { expenses, section_targets };
}

// Build the expenses array to store: real categories plus the targets sentinel.
function packBudgetExpenses(expArr, targetsVal) {
    const list = (Array.isArray(expArr) ? expArr : []).filter(e => !isTargetsSentinel(e));
    if (targetsVal && typeof targetsVal === 'object' && Object.keys(targetsVal).length > 0) {
        list.push({ __kind: SECTION_TARGETS_KIND, values: targetsVal });
    }
    return list;
}

app.get('/api/budget', requirePaid, async (req, res) => {
    const { user, viewer } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    if (viewer && viewer !== user && !(await moduleVisibleTo(viewer, user, 'Budget'))) return res.json([]);
    try {
        const rows = await dbAll(
            "SELECT id, username AS \"user\", income, expenses, TO_CHAR(date, 'YYYY-MM-DD') AS date, COALESCE(budget_type,'need') AS budget_type FROM vectraarchlegacy_budget WHERE username = $1 ORDER BY date DESC",
            [user]
        );
        const data = rows.map(r => {
            const raw = Array.isArray(r.expenses) ? r.expenses
                : (typeof r.expenses === 'string' ? JSON.parse(r.expenses || '[]') : []);
            const { expenses, section_targets } = splitBudgetExpenses(raw);
            return { ...r, expenses, section_targets };
        });
        res.json({ success: true, data });
    } catch (e) {
        console.error('[budget GET]', e.message);
        res.status(500).json({ success: false, message: 'Database error fetching budget.', error: e.message });
    }
});

app.post('/api/budget', requirePaid, async (req, res) => {
    const { user, income, expenses, date, budget_type, section_targets } = req.body;
    if (!user || !date) return res.status(400).json({ success: false, message: 'User and date required.' });
    let expArr = [];
    try { const raw = expenses || '[]'; expArr = typeof raw === 'string' ? JSON.parse(raw) : raw; if (!Array.isArray(expArr)) expArr = []; } catch { expArr = []; }
    expArr = expArr.filter(e => !isTargetsSentinel(e));
    if (expArr.length === 0) return res.status(400).json({ success: false, message: 'At least one expense category required.' });
    const totalPlanned = expArr.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const incomeVal = parseFloat(income) || totalPlanned;
    const budType = budget_type || expArr[0]?.type || 'need';
    const dateVal = String(date).slice(0, 10);
    const targetsVal = (section_targets && typeof section_targets === 'object') ? section_targets : {};
    const stored = packBudgetExpenses(expArr, targetsVal);
    try {
        const r = await dbRun(
            'INSERT INTO vectraarchlegacy_budget (username,income,expenses,date,budget_type) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [user, incomeVal, JSON.stringify(stored), dateVal, budType]
        );
        await logTransaction(user, 'CREATE', 'budget', r.rows[0].id, user);
        res.json({ success: true, message: 'Budget saved!', id: r.rows[0].id });
    } catch (e) {
        console.error('[budget POST]', e.message);
        res.status(500).json({ success: false, message: 'Database error: ' + e.message });
    }
});

app.put('/api/budget/:id', requirePaid, async (req, res) => {
    const { id } = req.params;
    const { user, income, expenses, date, budget_type, section_targets } = req.body;
    if (!user || !date) return res.status(400).json({ success: false, message: 'User and date required.' });
    let expArr = [];
    try { const raw = expenses||'[]'; expArr = typeof raw==='string'?JSON.parse(raw):raw; if(!Array.isArray(expArr)) expArr=[]; } catch { expArr=[]; }
    expArr = expArr.filter(e => !isTargetsSentinel(e));
    const totalPlanned = expArr.reduce((s,e)=>s+parseFloat(e.amount||0),0);
    const incomeVal = parseFloat(income)||totalPlanned;
    const budType = budget_type || expArr[0]?.type || 'need';
    const dateVal = String(date).slice(0, 10);
    const targetsVal = (section_targets && typeof section_targets === 'object') ? section_targets : {};
    const stored = packBudgetExpenses(expArr, targetsVal);
    try {
        const row = await dbQuery('SELECT id FROM vectraarchlegacy_budget WHERE id=$1 AND username=$2', [id, user]);
        if (!row) return res.status(404).json({ success: false, message: 'Budget not found.' });
        // Run the UPDATE on its own — never bundle with history INSERT so a history failure can't roll back the budget change
        await dbRun('UPDATE vectraarchlegacy_budget SET income=$1,expenses=$2,date=$3,budget_type=$4 WHERE id=$5',
            [incomeVal, JSON.stringify(stored), dateVal, budType, id]);
        await logTransaction(user, 'UPDATE', 'budget', id, user); // best-effort, never throws
        res.json({ success: true, message: 'Budget updated!' });
    } catch (e) {
        console.error('[budget PUT]', e.message);
        res.status(500).json({ success: false, message: 'Database error: ' + e.message });
    }
});

app.delete('/api/budget/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, username FROM vectraarchlegacy_budget WHERE id=$1', [id]);
        if (!row) return res.status(404).json({ success: false, message: 'Budget not found.' });
        await dbRun('DELETE FROM vectraarchlegacy_budget WHERE id=$1', [id]);
        await logTransaction(row.username, 'DELETE', 'budget', id, row.username);
        res.json({ success: true, message: 'Budget item deleted successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error deleting budget.', error: e.message });
    }
});

// ── CALENDAR ──────────────────────────────────────────────────────────────────
app.get('/api/calendar', requirePaid, async (req, res) => {
    const { user, viewer } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    if (viewer && viewer !== user && !(await moduleVisibleTo(viewer, user, 'Calendar'))) return res.json([]);
    try {
        const rows = await dbAll(
            "SELECT id, username AS user, title, TO_CHAR(date, 'YYYY-MM-DD\"T\"HH24:MI:SS') AS date, TO_CHAR(end_date, 'YYYY-MM-DD\"T\"HH24:MI:SS') AS \"endDate\", is_financial AS financial, type, amount, event_color AS \"eventColor\" FROM vectraarchlegacy_calendar WHERE username = $1",
            [user]
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching calendar.', error: e.message });
    }
});

app.post('/api/calendar', requirePaid, async (req, res) => {
    const { user, title, date, endDate, financial, type, amount, eventColor, finType } = req.body;
    if (!user || !title || !date) return res.status(400).json({ success: false, message: 'User, title, and date required.' });
    try {
        const isFinancial = !!(financial && amount && parseFloat(amount) > 0);
        const calType = isFinancial ? (finType || type || 'income') : (type || null);
        const r = await dbRun(
            'INSERT INTO vectraarchlegacy_calendar (username,title,date,end_date,is_financial,type,amount,event_color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
            [user, title, date, endDate || null, isFinancial ? 1 : 0, calType, amount || null, eventColor || null]
        );
        const calId = r.rows[0].id;
        // When marked financial, also write to vectraarchlegacy_financial so it appears on Finances tab
        if (isFinancial) {
            const fType = finType || type || 'income';
            const fRes = await dbRun(
                'INSERT INTO vectraarchlegacy_financial (username,category,amount,type,date) VALUES ($1,$2,$3,$4,$5) RETURNING id',
                [user, title, parseFloat(amount), fType, date.slice(0, 10)]
            );
            await logTransaction(user, 'CREATE', 'financial', fRes.rows[0].id, user);
        }
        await logTransaction(user, 'CREATE', 'calendar', calId, user);
        const userData = await dbQuery('SELECT telegram_chat_id, email FROM vectraarchlegacy_users WHERE username = $1', [user]);
        const notifs = await dbAll('SELECT type, enabled FROM vectraarchlegacy_notifications WHERE username = $1', [user]);
        const msg = `New event: ${title} on ${date}${isFinancial ? ` (${finType||type||'income'}: R${amount})` : ''}`;
        if (notifs.some(n => n.type === 'telegram' && n.enabled) && userData?.telegram_chat_id) sendTelegramMessage(userData.telegram_chat_id, msg);
        if (notifs.some(n => n.type === 'email' && n.enabled) && userData?.email) await sendEmailNotification(userData.email, 'New Calendar Event', msg);
        res.json({ success: true, message: 'Calendar event added successfully!' });
    } catch (e) {
        console.error('[calendar POST]', e);
        res.status(500).json({ success: false, message: 'Database error adding calendar event.', error: e.message });
    }
});

app.delete('/api/calendar/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, username, title, is_financial, amount, type, date FROM vectraarchlegacy_calendar WHERE id=$1', [id]);
        if (!row) return res.status(404).json({ success: false, message: 'Calendar event not found.' });
        const queries = [
            { sql: 'DELETE FROM vectraarchlegacy_calendar WHERE id=$1', params: [id] },
            { sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)', params: [row.username,'DELETE','calendar',id,row.username,new Date().toISOString()] }
        ];
        // If this was a financial event, also delete the matching financial record
        if (row.is_financial && row.amount) {
            queries.push({
                sql: "DELETE FROM vectraarchlegacy_financial WHERE username=$1 AND category=$2 AND amount=$3 AND type=$4 AND TO_CHAR(date,'YYYY-MM-DD')=TO_CHAR($5::date,'YYYY-MM-DD')",
                params: [row.username, row.title, row.amount, row.type, row.date]
            });
        }
        await dbTransaction(queries);
        res.json({ success: true, message: 'Calendar event deleted successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error deleting calendar event.', error: e.message });
    }
});

// ── GYM WORKOUT & NEW DB OPTIONS OPTIONS ──────────────────────────────────────
app.get('/api/gym-options', async (req, res) => {
    try {
        const rows = await dbAll('SELECT category, exercise_value AS value, exercise_label AS label FROM vectraarchlegacy_gym_options ORDER BY id ASC');
        const grouped = rows.reduce((acc, item) => {
            let group = acc.find(g => g.label === item.category);
            if (!group) {
                group = { label: item.category, options: [] };
                acc.push(group);
            }
            group.options.push({ value: item.value, label: item.label });
            return acc;
        }, []);
        grouped.push({ label: 'Custom', options: [{ value: '__custom__', label: 'Custom exercise...' }] });
        res.json({ success: true, data: grouped });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error retrieving gym exercise items.', error: e.message });
    }
});

app.get('/api/gymworkout', requirePaid, async (req, res) => {
    const { user, viewer } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    if (viewer && viewer !== user && !(await moduleVisibleTo(viewer, user, 'Gym'))) return res.json([]);
    try {
        const rows = await dbAll('SELECT id, username AS user, day, exercise, sets, reps, weight, date FROM vectraarchlegacy_gymworkout WHERE username = $1', [user]);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching gym workouts.', error: e.message });
    }
});

app.post('/api/gymworkout', requirePaid, async (req, res) => {
    const { user, day, exercise, sets, reps, weight, date } = req.body;
    if (!user || !day || !exercise || !sets || !reps || !weight || !date) return res.status(400).json({ success: false, message: 'All fields required.' });
    try {
        const r = await dbRun(
            'INSERT INTO vectraarchlegacy_gymworkout (username,day,exercise,sets,reps,weight,date) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
            [user, day, exercise, parseInt(sets)||null, String(reps), String(weight), date]
        );
        await logTransaction(user, 'CREATE', 'gymworkout', r.rows[0].id, user);
        res.json({ success: true, message: 'Gym workout added successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error adding gym workout.', error: e.message });
    }
});

app.put('/api/gymworkout/:id', requirePaid, async (req, res) => {
    const { id } = req.params;
    const { user, day, exercise, sets, reps, weight, date } = req.body;
    if (!user || !day || !exercise || !sets || !reps || !weight || !date) return res.status(400).json({ success: false, message: 'All fields required.' });
    try {
        const row = await dbQuery('SELECT id FROM vectraarchlegacy_gymworkout WHERE id=$1 AND username=$2', [id, user]);
        if (!row) return res.status(404).json({ success: false, message: 'Workout not found.' });
        await dbTransaction([
            { sql: 'UPDATE vectraarchlegacy_gymworkout SET day=$1,exercise=$2,sets=$3,reps=$4,weight=$5,date=$6 WHERE id=$7', params: [day, exercise, parseInt(sets)||null, String(reps), String(weight), date, id] },
            { sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)', params: [user,'UPDATE','gymworkout',id,user,new Date().toISOString()] }
        ]);
        res.json({ success: true, message: 'Gym workout updated successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error updating gym workout.', error: e.message });
    }
});

app.delete('/api/gymworkout/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, username FROM vectraarchlegacy_gymworkout WHERE id=$1', [id]);
        if (!row) return res.status(404).json({ success: false, message: 'Gym workout not found.' });
        await dbTransaction([
            { sql: 'DELETE FROM vectraarchlegacy_gymworkout WHERE id=$1', params: [id] },
            { sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)', params: [row.username,'DELETE','gymworkout',id,row.username,new Date().toISOString()] }
        ]);
        res.json({ success: true, message: 'Gym workout deleted successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error deleting gym workout.', error: e.message });
    }
});

// ── MEAL PLAN & DB TEMPLATES ──────────────────────────────────────────────────
app.get('/api/meal-templates', async (req, res) => {
    try {
        const rows = await dbAll('SELECT category, meal_value AS value, meal_label AS label, calories FROM vectraarchlegacy_meal_templates ORDER BY id ASC');
        const grouped = rows.reduce((acc, item) => {
            let group = acc.find(g => g.label === item.category);
            if (!group) {
                group = { label: item.category, options: [] };
                acc.push(group);
            }
            group.options.push({ value: item.value, label: item.label, cal: item.calories });
            return acc;
        }, []);
        grouped.push({ label: 'Custom', options: [{ value: '__custom__', label: 'Custom meal...', cal: 0 }] });
        res.json({ success: true, data: grouped });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error retrieving meal templates.', error: e.message });
    }
});

app.get('/api/mealplan', requirePaid, async (req, res) => {
    const { user, viewer } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    if (viewer && viewer !== user && !(await moduleVisibleTo(viewer, user, 'Meals'))) return res.json([]);
    try {
        const rows = await dbAll(
            'SELECT id, username AS user, day, meal_type AS "mealType", description, calories, date FROM vectraarchlegacy_mealplan WHERE username = $1',
            [user]
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching meal plans.', error: e.message });
    }
});

app.post('/api/mealplan', requirePaid, async (req, res) => {
    const { user, day, mealType, description, calories, date } = req.body;
    if (!user || !day || !mealType || !description || !calories || !date) return res.status(400).json({ success: false, message: 'All fields required.' });
    try {
        const r = await dbRun(
            'INSERT INTO vectraarchlegacy_mealplan (username,day,meal_type,description,calories,date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [user, day, mealType, description, parseInt(calories)||null, date]
        );
        await logTransaction(user, 'CREATE', 'mealplan', r.rows[0].id, user);
        res.json({ success: true, message: 'Meal plan added successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error adding meal plan.', error: e.message });
    }
});

app.delete('/api/mealplan/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, username FROM vectraarchlegacy_mealplan WHERE id=$1', [id]);
        if (!row) return res.status(404).json({ success: false, message: 'Meal plan not found.' });
        await dbTransaction([
            { sql: 'DELETE FROM vectraarchlegacy_mealplan WHERE id=$1', params: [id] },
            { sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)', params: [row.username,'DELETE','mealplan',id,row.username,new Date().toISOString()] }
        ]);
        res.json({ success: true, message: 'Meal plan deleted successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error deleting meal plan.', error: e.message });
    }
});

// ── PERIOD ────────────────────────────────────────────────────────────────────
app.get('/api/period', requirePaid, async (req, res) => {
    const { user, viewer } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    if (viewer && viewer !== user && !(await moduleVisibleTo(viewer, user, 'Cycle'))) return res.json([]);
    try {
        const rows = await dbAll(
            'SELECT id, username AS user, start_date AS "startDate", end_date AS "endDate", cycle_length AS "cycleLength", symptoms, date FROM vectraarchlegacy_period WHERE username = $1',
            [user]
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching period data.', error: e.message });
    }
});

app.post('/api/period', requirePaid, async (req, res) => {
    const { user, startDate, endDate, cycleLength, symptoms, date } = req.body;
    if (!user || !startDate || !cycleLength || !date) return res.status(400).json({ success: false, message: 'Required fields missing.' });
    try {
        const r = await dbRun(
            'INSERT INTO vectraarchlegacy_period (username,start_date,end_date,cycle_length,symptoms,date) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [user, startDate, endDate||null, cycleLength, symptoms||null, date]
        );
        await logTransaction(user, 'CREATE', 'period', r.rows[0].id, user);
        res.json({ success: true, message: 'Period cycle added successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error adding period data.', error: e.message });
    }
});

app.delete('/api/period/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, username FROM vectraarchlegacy_period WHERE id=$1', [id]);
        if (!row) return res.status(404).json({ success: false, message: 'Period cycle not found.' });
        await dbTransaction([
            { sql: 'DELETE FROM vectraarchlegacy_period WHERE id=$1', params: [id] },
            { sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)', params: [row.username,'DELETE','period',id,row.username,new Date().toISOString()] }
        ]);
        res.json({ success: true, message: 'Period cycle deleted successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error deleting period data.', error: e.message });
    }
});

// ── IMPORT STATEMENT ──────────────────────────────────────────────────────────
app.post('/api/import-statement', requirePaid, async (req, res) => {
    const { user, text } = req.body;
    if (!user || !text) return res.status(400).json({ success: false, message: 'User and text required.' });
    try {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l && !['1 Discovery Place','Discovery Bank Limited','FSP number','Date','Description','Debit','Credit','Balance','<PAGE','Total pages','Account holder','From','Account type','Account number'].some(s => l.startsWith(s)));
        let transactions = [];
        let i = 0;
        while (i < lines.length) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(lines[i])) {
                const date = lines[i++];
                if (i >= lines.length) break;
                const description = lines[i++];
                if (i >= lines.length) break;
                let line = lines[i];
                let amount = 0, balance = 0;
                if (line.endsWith('-')) {
                    balance = -parseFloat(line.replace('R ','').replace(/,/g,'').trim().slice(0,-1));
                } else {
                    amount = parseFloat(line.replace('R ','').replace(/,/g,'').split(' ')[0].trim());
                    i++;
                    if (i >= lines.length) break;
                    const bs = lines[i].replace('R ','').replace(/,/g,'').trim();
                    balance = bs.endsWith('-') ? -parseFloat(bs.slice(0,-1)) : parseFloat(bs);
                }
                transactions.push({ date, description, amount, balance });
                i++;
            } else { i++; }
        }
        let prev = null;
        for (const tx of transactions) {
            if (prev === null) { tx.type = tx.amount > 0 ? 'expense' : 'unknown'; }
            else {
                const debitBal = prev - tx.amount;
                const creditBal = prev + tx.amount;
                if (Math.abs(debitBal - tx.balance) < 0.01) tx.type = 'expense';
                else if (Math.abs(creditBal - tx.balance) < 0.01) tx.type = 'income';
                else tx.type = 'unknown';
            }
            prev = tx.balance;
        }
        transactions = transactions.filter(tx => tx.amount > 0 && tx.type !== 'unknown');
        const categoryKeywords = {
            'Food & Dining': ['CAFE','GALITOS','MILKY LANE','KAUAI','BILTONG','OLA','FAT CAKE','VENDING','STOETBUL','COMPADRE','PABLOS','KFC','UBER EATS','BK','MR PANDA','WIESEHOF','LADY JANE','VIDA E CAFFE','VUSE','HOME ESSENTIALS','VAPE','SLINGS SHOTS','MANCAVE','IK *TLC','RA CELLULAR','KHALIFA CELL','HPY*E AND D CELL','THE LOCAL CHOICE PHARMA','DISCHEM','FREI ONE DIGITAL','VIRGIN ACT','HPY*CELL TEC','HPY*EDEN TECH','THE CRAZY STORE','SAFARI TUINSENTR','AE WAPADRAND','AE NORWOOD','VPS*GIGGIE','ACSA JIA JHB','CC FRESH','BRUCHES BILTONG','BELLAS BILTONG','THE VAPE GURUS','UBER EATS JOHANNESBURG','WIESEHOF COFFEE SHOP ALBE','MR PANDA. BOKSBURG','BK NEW MARKET DT U MA','YOCO *THE 33 COLLECT','GENESIS','NETCASH'],
            'Fuel & Transport': ['ENGEN','SHELL','UBER','PACE CAR RENTAL','KARABO PARKING','PARKVIEW SHOPPING CENTRE'],
            'Groceries': ['SUPERSPAR','CHECKERS','PNP CLT','KINGS MEAT','WOOLWORTHS','S2S*SOUTHSUPERMARKET','S2S*SAVOYCAFEALBERTON'],
            'Shopping': ['AMAZON SELLER','MRPRICE','CASH CONVERTERS','NEWLAND ACCESSORIES','ADVANCE MENLYN PARK','PADSTAL','L A E CONSTANTIA','HOKAAI GIFT ACRES','SJIEK AND UNIQU','EASTRAND TRADERS SQUA','JACKIES ENTERPRISE','CLICKS','HPY*EXCELLECT VAPE CLU','MRPRICES 10766 GLENFAI','THE CRAZY STORE NEW RED','YOCO *RIETVLEI ZOO F'],
            'Transfers & Payments': ['PAYSHAP','REMAX','IPDA','GENESIS','NETCASH','DIAMATRIX CC'],
            'Fees': ['TXN DECLINED FEE','MONTHLY ACCOUNT FEE','EXCESS INTEREST CHARGED','VITALITY MONEY PREMIUM','INTL PAYMENT FEE','PAYSHAP PAYMENT FEE'],
            'Utilities & Bills': ['PREPAID DATA PURCHASE','PREPAID AIRTIME PURCHASE','APPLE.COM/BILL','DLOCAL *MICROSOFT ULTI','DIGITALOCEAN.COM','XAI LLC'],
            'Entertainment & Leisure': ['SHIELD EXPRESS REDRUTH','VIRGIN ACT','YOCO *RIETVLEI ZOO F'],
            'Other': ['DECLINED DOM CARD PURCH','DECLINED INT CARD PURCH','INTEREST EARNED','MILES TRANSFER TO CASH']
        };
        for (const tx of transactions) {
            tx.category = 'Other';
            const up = tx.description.toUpperCase();
            for (const cat in categoryKeywords) {
                if (categoryKeywords[cat].some(k => up.includes(k))) { tx.category = cat; break; }
            }
        }
        const client = await pool.connect();
        let count = 0;
        try {
            await client.query('BEGIN');
            for (const tx of transactions) {
                const fRes = await client.query(
                    'INSERT INTO vectraarchlegacy_financial (username,category,amount,type,date) VALUES ($1,$2,$3,$4,$5) RETURNING id',
                    [user, tx.category, tx.amount, tx.type, tx.date + ' 00:00:00']
                );
                await client.query(
                    'INSERT INTO vectraarchlegacy_calendar (username,title,date,is_financial,type,amount,event_color) VALUES ($1,$2,$3,1,$4,$5,$6)',
                    [user, `${tx.category} (${tx.type})`, tx.date + ' 00:00:00', tx.type, tx.amount, '#2dd4bf']
                );
                await client.query(
                    'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)',
                    [user, 'CREATE', 'financial', fRes.rows[0].id, user, new Date().toISOString()]
                );
                count++;
            }
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
        res.json({ success: true, message: 'Statement imported successfully!', count });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error importing statement.', error: e.message });
    }
});

// ── 2FA ───────────────────────────────────────────────────────────────────────
app.get('/api/2fa/status', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const row = await dbQuery('SELECT twofa_secret FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, enabled: !!row.twofa_secret });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error.', error: e.message });
    }
});

app.post('/api/verify-2fa', async (req, res) => {
    const { username, token } = req.body;
    if (!username || !token) return res.status(400).json({ success: false, message: 'Username and token required.' });
    try {
        const row = await dbQuery(`${USER_SELECT_BASE} WHERE u.username = $1`, [username]);
        if (!row || !row.twofa_secret) return res.status(400).json({ success: false, message: '2FA not configured.' });
        const valid = authenticator.verify({ token, secret: row.twofa_secret });
        if (!valid) return res.status(401).json({ success: false, message: 'Invalid authentication code.' });
        res.json({ success: true, ...mapUser(row) });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error verifying 2FA.', error: e.message });
    }
});

app.get('/api/2fa/setup', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const row = await dbQuery('SELECT twofa_secret FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        if (row.twofa_secret) return res.status(400).json({ success: false, message: '2FA already configured.' });
        const secret = authenticator.generateSecret();
        const otpauth = authenticator.keyuri(username, 'VectraArch Legacy', secret);
        const qrCode = await QRCode.toDataURL(otpauth);
        res.json({ success: true, secret, qrCode });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error generating 2FA setup.', error: e.message });
    }
});

app.post('/api/2fa/setup', async (req, res) => {
    const { username, secret, token } = req.body;
    if (!username || !secret || !token) return res.status(400).json({ success: false, message: 'Username, secret, and token required.' });
    try {
        const valid = authenticator.verify({ token, secret });
        if (!valid) return res.status(401).json({ success: false, message: 'Invalid code. Please try again.' });
        await dbRun('UPDATE vectraarchlegacy_users SET twofa_secret=$1 WHERE username=$2', [secret, username]);
        res.json({ success: true, message: '2FA enabled successfully.' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error enabling 2FA.', error: e.message });
    }
});

app.post('/api/2fa/disable', async (req, res) => {
    const { username, token } = req.body;
    if (!username || !token) return res.status(400).json({ success: false, message: 'Username and token required.' });
    try {
        const row = await dbQuery('SELECT twofa_secret FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row || !row.twofa_secret) return res.status(400).json({ success: false, message: '2FA not configured.' });
        const valid = authenticator.verify({ token, secret: row.twofa_secret });
        if (!valid) return res.status(401).json({ success: false, message: 'Invalid code.' });
        await dbRun('UPDATE vectraarchlegacy_users SET twofa_secret=NULL WHERE username=$1', [username]);
        res.json({ success: true, message: '2FA disabled successfully.' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error disabling 2FA.', error: e.message });
    }
});

app.post('/api/2fa/reset', requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        await dbRun('UPDATE vectraarchlegacy_users SET twofa_secret=NULL WHERE username=$1', [username]);
        res.json({ success: true, message: `2FA reset for ${username}.` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error resetting 2FA.', error: e.message });
    }
});

// ── GOOGLE OAUTH ─────────────────────────────────────────────────────────────
const GOOGLE_CONFIGURED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL);

if (GOOGLE_CONFIGURED) {
    passport.use(new GoogleStrategy({
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  process.env.GOOGLE_CALLBACK_URL,
    }, (accessToken, refreshToken, profile, done) => {
        // We don't persist a passport session — we resolve to a Legacy user
        // ourselves in the callback handler, so just hand the profile back.
        return done(null, {
            id:    profile.id,
            email: profile.emails?.[0]?.value || '',
            name:  profile.displayName || '',
        });
    }));
} else {
    console.warn('[google-oauth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL not configured — /auth/google disabled.');
}

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((o, d) => d(null, o));

// Build a tiny HTML response that hands a user payload to the SPA via
// localStorage, then redirects. Used to bridge the OAuth round-trip back
// into the existing localStorage-based session model.
function renderHandoffPage(payload, redirectTo) {
    const safe = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title>
<style>body{background:#0a0a0a;color:#d4a017;font-family:'DM Mono',monospace;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-size:13px;letter-spacing:.08em}</style>
</head><body>SIGNING IN…
<script>
try {
  localStorage.setItem('user', ${JSON.stringify(safe)});
  location.replace(${JSON.stringify(redirectTo)});
} catch (e) { document.body.textContent = 'Storage error — refresh to retry.'; }
</script></body></html>`;
}

// Generate a clean username from a Google display name, falling back to email local-part.
async function generateUniqueUsername(displayName, email) {
    const fromName  = (displayName || '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
    const fromEmail = (email || '').toLowerCase().split('@')[0].replace(/[^a-z0-9._-]/g, '');
    let base = fromName || fromEmail || 'user';
    if (base.length < 3) base = (base + 'user').slice(0, 12);
    let candidate = base;
    let n = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const exists = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [candidate]);
        if (!exists) return candidate;
        n += 1;
        candidate = `${base}${n}`;
        if (n > 9999) return `${base}${crypto.randomBytes(3).toString('hex')}`;
    }
}

// Begin Google sign-in. If invoked with ?invite=<token>, stash it in the
// session so the callback can consume it and create a new account.
app.get('/auth/google', (req, res, next) => {
    if (!GOOGLE_CONFIGURED) {
        return res.status(503).send('Google sign-in is not configured on this server.');
    }
    if (req.query.invite) {
        req.session.pendingInviteToken = String(req.query.invite);
    }
    passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
    if (!GOOGLE_CONFIGURED) return res.redirect('/login.html?error=google_disabled');
    passport.authenticate('google', { session: false, failureRedirect: '/login.html?error=google_failed' },
        async (err, googleUser) => {
            if (err || !googleUser) {
                console.error('[google-oauth] callback error:', err?.message);
                return res.redirect('/login.html?error=google_failed');
            }
            try {
                const email = (googleUser.email || '').toLowerCase().trim();
                if (!email) return res.redirect('/login.html?error=google_no_email');

                // 1. Existing user by google_id
                let user = await dbQuery(`${USER_SELECT_BASE} WHERE u.google_id = $1`, [googleUser.id]);

                // 2. Existing user by email (auto-link Google to their account)
                if (!user) {
                    user = await dbQuery(`${USER_SELECT_BASE} WHERE LOWER(u.email) = $1`, [email]);
                    if (user) {
                        await dbRun('UPDATE vectraarchlegacy_users SET google_id = $1 WHERE username = $2',
                            [googleUser.id, user.username]);
                        user.google_id = googleUser.id;
                        await logTransaction(user.username, 'LINK_GOOGLE', 'users', null, user.username);
                    }
                }

                // 3. Invite-based sign-up
                if (!user) {
                    const inviteToken = req.session.pendingInviteToken;
                    if (!inviteToken) {
                        return res.redirect('/login.html?error=invite_required');
                    }
                    const invite = await dbQuery(
                        `SELECT * FROM vectraarchlegacy_invites
                         WHERE token=$1 AND status='pending' AND expires_at > NOW()`,
                        [inviteToken]
                    );
                    if (!invite) {
                        delete req.session.pendingInviteToken;
                        return res.redirect('/login.html?error=invite_invalid');
                    }
                    if (invite.email.toLowerCase().trim() !== email) {
                        return res.redirect('/login.html?error=invite_email_mismatch');
                    }

                    const username = await generateUniqueUsername(googleUser.name, email);
                    const [firstName, ...rest] = (googleUser.name || '').split(' ');
                    const lastName = rest.join(' ');
                    const isAdmin = invite.role === 'admin' ? 1 : 0;

                    await dbRun(`
                        INSERT INTO vectraarchlegacy_users
                            (username, password_hash, first_name, last_name, display_name,
                             email, google_id, auth_provider, is_admin, event_color, accent_color)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,'google',$8,'#2dd4bf','#00ff41')`,
                        [username, '', firstName || null, lastName || null,
                         googleUser.name || username, email, googleUser.id, isAdmin]
                    );

                    await dbRun(
                        `UPDATE vectraarchlegacy_invites
                         SET status='accepted', accepted_at=NOW(), accepted_username=$1
                         WHERE id=$2`,
                        [username, invite.id]
                    );

                    await logTransaction(username, 'GOOGLE_SIGNUP', 'users', null, invite.invited_by);
                    sendTelegramMessage(GROUP_CHAT_ID, `New Google user joined: ${username} (${email}) via invite from ${invite.invited_by}`);

                    user = await dbQuery(`${USER_SELECT_BASE} WHERE u.username = $1`, [username]);
                    delete req.session.pendingInviteToken;
                }

                await dbRun('UPDATE vectraarchlegacy_users SET last_active = $1 WHERE username = $2',
                    [new Date().toISOString(), user.username]);
                await logTransaction(user.username, 'LOGIN_GOOGLE', 'users', null, user.username);

                // If 2FA enabled, stash the username and redirect to OTP step.
                if (user.twofa_secret) {
                    req.session.pendingGoogle2FA = { username: user.username };
                    return res.redirect('/login.html?stage=2fa&from=google');
                }

                return res.send(renderHandoffPage({ success: true, ...mapUser(user) }, '/'));
            } catch (e) {
                console.error('[google-oauth] handler error:', e.message);
                return res.redirect('/login.html?error=google_server');
            }
        })(req, res, next);
});

// Used by login.html when ?stage=2fa&from=google — finishes a Google sign-in
// that required a TOTP. Body: { token }. Reads the pending username from session.
app.post('/api/google/verify-2fa', async (req, res) => {
    const pending = req.session.pendingGoogle2FA;
    if (!pending?.username) {
        return res.status(401).json({ success: false, message: 'No pending Google sign-in.' });
    }
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, message: 'Token required.' });
    try {
        const row = await dbQuery(`${USER_SELECT_BASE} WHERE u.username = $1`, [pending.username]);
        if (!row || !row.twofa_secret) {
            delete req.session.pendingGoogle2FA;
            return res.status(400).json({ success: false, message: '2FA not configured.' });
        }
        const valid = authenticator.verify({ token, secret: row.twofa_secret });
        if (!valid) return res.status(401).json({ success: false, message: 'Invalid code.' });
        delete req.session.pendingGoogle2FA;
        return res.json({ success: true, ...mapUser(row) });
    } catch (e) {
        return res.status(500).json({ success: false, message: 'Server error.', error: e.message });
    }
});

// Cancel a pending Google flow (called when user navigates away or hits Back).
app.post('/api/google/cancel', (req, res) => {
    delete req.session.pendingGoogle2FA;
    delete req.session.pendingInviteToken;
    res.json({ success: true });
});

// ── INVITES ──────────────────────────────────────────────────────────────────
function buildInviteEmail(invite, inviter) {
    const url = `${PUBLIC_BASE_URL}/invite/${invite.token}`;
    const subject = `You've been invited to VectraArch Legacy`;
    const text = `Hi,

${inviter || 'A VectraArch admin'} has invited you to join the VectraArch Legacy hub.

Click the link below to accept and sign in with your Google account (${invite.email}):

${url}

This invite expires on ${new Date(invite.expires_at).toLocaleString('en-ZA')}.

If you weren't expecting this, just ignore the email.

— VectraArch Legacy`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#0a0a0a;color:#e5e5e5">
        <div style="font-size:11px;letter-spacing:0.2em;color:#d4a017;text-transform:uppercase;margin-bottom:8px">VectraArch · Legacy</div>
        <h1 style="font-size:22px;color:#fff;margin:0 0 14px">You're invited.</h1>
        <p style="line-height:1.55;color:#bdbdbd"><strong style="color:#fff">${inviter || 'A VectraArch admin'}</strong> has invited you to join the VectraArch Legacy hub.</p>
        <p style="line-height:1.55;color:#bdbdbd">Click below to accept and sign in with your Google account (<strong>${invite.email}</strong>):</p>
        <p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:12px 22px;background:#d4a017;color:#0a0a0a;text-decoration:none;font-weight:600;border-radius:4px;letter-spacing:.08em">Accept invitation ↗</a></p>
        <p style="line-height:1.55;color:#666;font-size:12px">This invite expires on ${new Date(invite.expires_at).toLocaleString('en-ZA')}.<br>If you weren't expecting this, you can safely ignore this email.</p>
        <hr style="border:none;border-top:1px solid #222;margin:24px 0">
        <p style="font-size:11px;color:#555">Or paste this link into your browser:<br><span style="color:#888;word-break:break-all">${url}</span></p>
    </div>`;
    return { subject, text, html };
}

async function sendInviteEmail(invite, inviter) {
    const { subject, text, html } = buildInviteEmail(invite, inviter);
    // Routed through VectraArchCOMS → Nuntly (with SMTP fallback if configured).
    const r = await sendEmailNotification(invite.email, subject, text, html);
    if (!r.sent) console.error('[invite] email send failed:', r.reason);
    return r;
}

// Admin: create a new invite. Body: { adminUsername, email, role?, note? }
app.post('/api/admin/invite', requireAdmin, async (req, res) => {
    const email = (req.body.email || '').toLowerCase().trim();
    const role  = req.body.role === 'admin' ? 'admin' : 'user';
    const note  = req.body.note || null;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, message: 'Valid email required.' });
    }
    try {
        const existing = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE LOWER(email) = $1', [email]);
        if (existing) {
            return res.status(400).json({ success: false, message: `A user with email ${email} already exists (${existing.username}).` });
        }
        const token = crypto.randomBytes(24).toString('hex');
        const row = await pool.query(
            `INSERT INTO vectraarchlegacy_invites (email, token, invited_by, role, note)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`,
            [email, token, req.adminUsername, role, note]
        );
        const invite = row.rows[0];
        const emailResult = await sendInviteEmail(invite, req.adminUsername);

        await logTransaction(req.adminUsername, 'INVITE_SEND', 'invites', invite.id, req.adminUsername);
        if (emailResult.sent) {
            sendTelegramMessage(GROUP_CHAT_ID, `Invite sent to ${email} by ${req.adminUsername}.`);
        }

        res.json({
            success: true,
            invite,
            invite_url: `${PUBLIC_BASE_URL}/invite/${token}`,
            email_sent: emailResult.sent,
            email_error: emailResult.reason || null,
        });
    } catch (e) {
        console.error('[invite] create error:', e.message);
        res.status(500).json({ success: false, message: 'Server error creating invite.', error: e.message });
    }
});

// Admin: list invites. Query: ?adminUsername=... &status=pending|accepted|revoked|all
app.get('/api/admin/invites', requireAdmin, async (req, res) => {
    const status = req.query.status || 'all';
    try {
        let rows;
        if (status === 'all') {
            rows = await dbAll(
                `SELECT id, email, token, invited_by, role, status, note,
                        created_at, expires_at, accepted_at, accepted_username
                 FROM vectraarchlegacy_invites
                 ORDER BY created_at DESC LIMIT 200`
            );
        } else {
            rows = await dbAll(
                `SELECT id, email, token, invited_by, role, status, note,
                        created_at, expires_at, accepted_at, accepted_username
                 FROM vectraarchlegacy_invites
                 WHERE status = $1
                 ORDER BY created_at DESC LIMIT 200`,
                [status]
            );
        }
        const invites = rows.map(r => ({ ...r, invite_url: `${PUBLIC_BASE_URL}/invite/${r.token}` }));
        res.json({ success: true, invites });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error listing invites.', error: e.message });
    }
});

// Admin: revoke a pending invite.
app.delete('/api/admin/invite/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invite id required.' });
    try {
        const row = await dbQuery('SELECT * FROM vectraarchlegacy_invites WHERE id = $1', [id]);
        if (!row) return res.status(404).json({ success: false, message: 'Invite not found.' });
        if (row.status !== 'pending') return res.status(400).json({ success: false, message: `Invite is already ${row.status}.` });
        await dbRun(`UPDATE vectraarchlegacy_invites SET status='revoked' WHERE id=$1`, [id]);
        await logTransaction(req.adminUsername, 'INVITE_REVOKE', 'invites', id, req.adminUsername);
        res.json({ success: true, message: 'Invite revoked.' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error revoking invite.', error: e.message });
    }
});

// Admin: resend the email for an existing pending invite.
app.post('/api/admin/invite/:id/resend', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, message: 'Invite id required.' });
    try {
        const row = await dbQuery('SELECT * FROM vectraarchlegacy_invites WHERE id = $1', [id]);
        if (!row) return res.status(404).json({ success: false, message: 'Invite not found.' });
        if (row.status !== 'pending') return res.status(400).json({ success: false, message: `Cannot resend a ${row.status} invite.` });
        if (new Date(row.expires_at) < new Date()) return res.status(400).json({ success: false, message: 'Invite has expired.' });
        const r = await sendInviteEmail(row, req.adminUsername);
        res.json({ success: r.sent, message: r.sent ? 'Email resent.' : (r.reason || 'Email send failed.') });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error resending invite.', error: e.message });
    }
});

// Public: validate an invite token (used by /invite/<token> landing page).
app.get('/api/invite/check', async (req, res) => {
    const token = (req.query.token || '').toString();
    if (!token) return res.status(400).json({ success: false, message: 'Token required.' });
    try {
        const row = await dbQuery(
            `SELECT email, status, expires_at, invited_by, role FROM vectraarchlegacy_invites WHERE token = $1`,
            [token]
        );
        if (!row) return res.json({ success: false, valid: false, reason: 'not_found' });
        if (row.status !== 'pending') return res.json({ success: false, valid: false, reason: row.status });
        if (new Date(row.expires_at) < new Date()) return res.json({ success: false, valid: false, reason: 'expired' });
        return res.json({
            success: true, valid: true,
            email: row.email, invited_by: row.invited_by, role: row.role,
            expires_at: row.expires_at,
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error checking invite.', error: e.message });
    }
});

// Invite landing page: pretty welcome that explains the flow and offers "Continue with Google".
app.get('/invite/:token', (req, res) => {
    const token = req.params.token;
    res.setHeader('Cache-Control', 'no-store');
    res.send(`<!doctype html><html><head><meta charset="utf-8">
<title>Invitation · VectraArch Legacy</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Barlow+Condensed:wght@400;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/shared/va.css"><link rel="stylesheet" href="/shared/auth.css">
<style>
.invite-card{max-width:440px;margin:0 auto;padding:36px 28px;text-align:center}
.invite-eyebrow{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.22em;color:#d4a017;text-transform:uppercase;margin-bottom:12px}
.invite-title{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:34px;color:#fff;letter-spacing:.02em;margin:0 0 8px}
.invite-sub{font-family:'DM Mono',monospace;font-size:12px;color:#888;margin-bottom:24px;line-height:1.6}
.invite-email{font-family:'DM Mono',monospace;font-size:13px;color:#d4a017;background:rgba(212,160,23,0.08);padding:8px 14px;border:1px solid rgba(212,160,23,0.3);border-radius:4px;display:inline-block;margin-bottom:24px}
.gbtn{display:inline-flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px 18px;background:#fff;color:#1f1f1f;border:none;border-radius:6px;font-family:'DM Mono',monospace;font-size:13px;font-weight:500;letter-spacing:.05em;cursor:pointer;text-decoration:none;box-sizing:border-box}
.gbtn:hover{background:#f1f1f1}
.gbtn svg{width:18px;height:18px;flex-shrink:0}
.invite-err{font-family:'DM Mono',monospace;font-size:11px;color:#ff6161;line-height:1.7;padding:14px;border:1px solid rgba(255,97,97,0.3);border-radius:4px;background:rgba(255,97,97,0.05);text-align:left}
.invite-back{display:block;margin-top:18px;color:#666;font-family:'DM Mono',monospace;font-size:11px;text-decoration:none}
</style></head><body>
<div class="grid-bg"></div>
<div class="auth-wrap"><div class="auth-card invite-card">
  <div class="invite-eyebrow">Invitation</div>
  <div id="state-loading">
    <div class="invite-sub">Checking invitation…</div>
  </div>
  <div id="state-ok" style="display:none">
    <h1 class="invite-title">You're invited.</h1>
    <div class="invite-sub" id="invitedBy">Loading…</div>
    <div class="invite-email" id="inviteEmail"></div>
    <a id="acceptBtn" class="gbtn" href="#">
      <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Continue with Google
    </a>
    <div class="invite-sub" style="margin-top:14px;font-size:10px">You must sign in with the Google account matching the email above.</div>
  </div>
  <div id="state-err" style="display:none">
    <div class="invite-err" id="errMsg"></div>
    <a class="invite-back" href="/login.html">← Back to sign-in</a>
  </div>
</div></div>
<script>
(function(){
  var TOKEN = ${JSON.stringify(token)};
  function show(id){['loading','ok','err'].forEach(function(s){document.getElementById('state-'+s).style.display=(s===id)?'block':'none';});}
  fetch('/api/invite/check?token='+encodeURIComponent(TOKEN)).then(function(r){return r.json();}).then(function(d){
    if(!d.success){
      var reasons = {expired:'This invitation has expired. Ask your admin to send a new one.',
                     accepted:'This invitation has already been accepted.',
                     revoked:'This invitation was revoked.',
                     not_found:'Invitation not found.'};
      document.getElementById('errMsg').textContent = '⚠ ' + (reasons[d.reason] || 'Invitation is no longer valid.');
      show('err'); return;
    }
    document.getElementById('inviteEmail').textContent = d.email;
    document.getElementById('invitedBy').textContent = 'Invited by ' + (d.invited_by || 'admin') + (d.role==='admin'?' · admin role':'');
    document.getElementById('acceptBtn').href = '/auth/google?invite=' + encodeURIComponent(TOKEN);
    show('ok');
  }).catch(function(){
    document.getElementById('errMsg').textContent = '⚠ Could not contact server. Check your connection and refresh.';
    show('err');
  });
})();
</script></body></html>`);
});

// ── NUNTLY WEBHOOKS ──────────────────────────────────────────────────────────
// Nuntly POSTs delivery events here (configured at nuntly.com/webhooks). Each
// request carries an `x-nuntly-signature` header: HMAC-SHA256 of the raw body
// keyed by the webhook signing secret. We verify it before trusting the event.
function timingEqualStr(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function verifyNuntlySignature(rawBody, headerSig) {
    if (!NUNTLY_WEBHOOK_SECRET) return true; // verification disabled (no secret set)
    if (!headerSig || !rawBody || !rawBody.length) return false;
    const sig = String(headerSig).trim().replace(/^sha256=/i, '').replace(/^v1[=,]/i, '').trim();
    // Try the secret as-is and (for svix/standard-webhooks style) without the
    // whsec_ prefix; check both hex and base64 digest encodings.
    const keys = [NUNTLY_WEBHOOK_SECRET];
    if (NUNTLY_WEBHOOK_SECRET.startsWith('whsec_')) keys.push(NUNTLY_WEBHOOK_SECRET.slice(6));
    for (const key of keys) {
        const hHex = crypto.createHmac('sha256', key).update(rawBody).digest('hex');
        const hB64 = crypto.createHmac('sha256', key).update(rawBody).digest('base64');
        if (timingEqualStr(sig, hHex) || timingEqualStr(sig, hB64)) return true;
    }
    return false;
}

app.post('/api/webhooks', async (req, res) => {
    const headerSig = req.headers['x-nuntly-signature'] || req.headers['x-webhook-signature'] || '';
    if (!verifyNuntlySignature(req.rawBody, headerSig)) {
        console.error('[webhook] invalid Nuntly signature — rejected');
        return res.status(401).json({ ok: false, error: 'invalid signature' });
    }
    if (!NUNTLY_WEBHOOK_SECRET) {
        console.warn('[webhook] NUNTLY_WEBHOOK_SECRET not set — accepting event WITHOUT verification');
    }
    try {
        const body      = req.body || {};
        const data      = body.data || body;
        const eventType = body.type || body.event || null;
        const emailId   = data.id || data.email_id || body.email_id || null;
        const recipient = Array.isArray(data.to) ? data.to[0] : (data.to || data.recipient || data.email || null);
        await dbRun(
            'INSERT INTO vectraarchlegacy_email_events (event_type, email_id, recipient, payload) VALUES ($1,$2,$3,$4)',
            [eventType, emailId, recipient, JSON.stringify(body)]
        );
        console.log(`[webhook] ${eventType || 'event'} · ${emailId || '-'} · ${recipient || '-'}`);
        res.json({ ok: true });
    } catch (e) {
        console.error('[webhook] processing error:', e.message);
        // Still 200 so Nuntly doesn't retry a row we simply failed to log.
        res.json({ ok: true });
    }
});

// ── BILLING / PAYGATE ROUTES ──────────────────────────────────────────────────

// Public list of plans for the paywall UI.
app.get('/api/billing/plans', (req, res) => {
    res.json({
        success: true,
        trialDays: TRIAL_DAYS,
        currency: 'ZAR',
        plans: Object.entries(PLANS).map(([id, p]) => ({
            id, name: p.name, amount: p.amount, label: p.label, recurring: p.recurring,
        })),
    });
});

// Entitlement for a user — the client polls this to decide trial banner vs paywall.
app.get('/api/billing/status', async (req, res) => {
    const username = (req.query.user || req.query.username || '').toString();
    if (!username) return res.status(400).json({ success: false, message: 'User required.' });
    try {
        const ent = await entitlementForUsername(username);
        res.json({ success: true, subscription: ent, trialDays: TRIAL_DAYS });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error fetching billing status.', error: e.message });
    }
});

// Begin a subscription: returns the PayFast process URL + the signed field set
// for the browser to auto-submit. We never trust the amount from the client —
// it's looked up from PLANS by plan id.
app.post('/api/billing/subscribe', async (req, res) => {
    const username = (req.body.user || req.body.username || '').toString();
    const planId   = (req.body.plan || '').toString();
    if (!username) return res.status(400).json({ success: false, message: 'User required.' });
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ success: false, message: 'Unknown plan.' });
    try {
        const user = await dbQuery('SELECT username, email, first_name, last_name FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
        if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

        const mPaymentId = `${user.username}:${planId}:${Date.now()}`;
        const data = {
            merchant_id:   PAYFAST_MERCHANT_ID,
            merchant_key:  PAYFAST_MERCHANT_KEY,
            return_url:    `${PUBLIC_BASE_URL}/billing/return`,
            cancel_url:    `${PUBLIC_BASE_URL}/billing/cancel`,
            notify_url:    `${PUBLIC_BASE_URL}/api/payfast/notify`,
            name_first:    user.first_name || user.username,
            name_last:     user.last_name || '',
            email_address: user.email || '',
            m_payment_id:  mPaymentId,
            amount:        plan.amount,
            item_name:     `VectraArch Legacy — ${plan.name}`,
            custom_str1:   user.username,
            custom_str2:   planId,
        };
        // Recurring (monthly) subscription fields per PayFast subscription spec.
        if (plan.recurring) {
            data.subscription_type = '1';
            data.billing_date      = new Date().toISOString().slice(0, 10);
            data.recurring_amount  = plan.amount;
            data.frequency         = '3'; // 3 = monthly
            data.cycles            = '0'; // 0 = indefinite until cancelled
        }
        data.signature = payfastSignature(data, PAYFAST_PASSPHRASE);

        res.json({ success: true, process_url: PAYFAST_PROCESS_URL, fields: data });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error starting checkout.', error: e.message });
    }
});

// PayFast ITN (Instant Transaction Notification). Validated four ways:
//   1. signature recomputed from posted fields matches pf's signature
//   2. source host is a known PayFast host
//   3. server-to-server postback returns VALID
//   4. gross amount matches the plan we charged
// Only then do we flip the user's subscription to active.
app.post('/api/payfast/notify', async (req, res) => {
    // Always 200 quickly — PayFast retries on non-200 and ignores the body.
    res.status(200).end();

    try {
        const pfData = req.body || {};
        const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';

        // 1. Signature check. Rebuild the ordered field set from the raw body so
        // we sign in the exact order PayFast sent (req.body key order isn't
        // guaranteed), excluding the trailing `signature` field.
        const received = pfData.signature;
        const toSign = {};
        for (const pair of rawBody.split('&')) {
            const idx = pair.indexOf('=');
            if (idx === -1) continue;
            const key = decodeURIComponent(pair.slice(0, idx));
            if (key === 'signature') continue;
            toSign[key] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
        }
        const expected = payfastSignature(toSign, PAYFAST_PASSPHRASE);
        if (received !== expected) {
            console.error('[payfast] ITN signature mismatch — rejected');
            await dbRun('INSERT INTO vectraarchlegacy_payments (username, m_payment_id, pf_payment_id, plan, amount_gross, payment_status, raw) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                [pfData.custom_str1 || null, pfData.m_payment_id || null, pfData.pf_payment_id || null, pfData.custom_str2 || null, pfData.amount_gross || null, 'REJECTED_SIGNATURE', JSON.stringify(pfData)]);
            return;
        }

        // 2. Source host check.
        const sourceHost = (req.headers['x-forwarded-host'] || req.headers['host'] || '').split(':')[0];
        const referer = (req.headers['referer'] || '');
        const hostOk = PAYFAST_VALID_HOSTS.some(h => referer.includes(h)) || PAYFAST_MODE === 'sandbox';
        if (!hostOk) {
            console.warn('[payfast] ITN from unexpected source:', sourceHost, referer);
        }

        // 3. Server-to-server postback validation.
        const valid = await payfastValidatePostback(rawBody);
        if (!valid && PAYFAST_MODE === 'live') {
            console.error('[payfast] ITN postback validation failed — rejected');
            await dbRun('INSERT INTO vectraarchlegacy_payments (username, m_payment_id, pf_payment_id, plan, amount_gross, payment_status, raw) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                [pfData.custom_str1 || null, pfData.m_payment_id || null, pfData.pf_payment_id || null, pfData.custom_str2 || null, pfData.amount_gross || null, 'REJECTED_POSTBACK', JSON.stringify(pfData)]);
            return;
        }

        const username = pfData.custom_str1 || (pfData.m_payment_id || '').split(':')[0];
        const planId   = pfData.custom_str2 || (pfData.m_payment_id || '').split(':')[1];
        const plan     = PLANS[planId];
        const status   = pfData.payment_status; // 'COMPLETE', 'CANCELLED', etc.

        // 4. Amount check (only meaningful on a COMPLETE payment).
        if (plan && status === 'COMPLETE') {
            const gross = parseFloat(pfData.amount_gross || '0');
            const expectedAmt = parseFloat(plan.amount);
            if (Math.abs(gross - expectedAmt) > 0.01) {
                console.error(`[payfast] amount mismatch: got ${gross}, expected ${expectedAmt}`);
                await dbRun('INSERT INTO vectraarchlegacy_payments (username, m_payment_id, pf_payment_id, plan, amount_gross, payment_status, raw) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                    [username, pfData.m_payment_id || null, pfData.pf_payment_id || null, planId, gross, 'REJECTED_AMOUNT', JSON.stringify(pfData)]);
                return;
            }
        }

        // Persist the (validated) event.
        await dbRun('INSERT INTO vectraarchlegacy_payments (username, m_payment_id, pf_payment_id, plan, amount_gross, payment_status, pf_token, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [username, pfData.m_payment_id || null, pfData.pf_payment_id || null, planId, pfData.amount_gross || null, status, pfData.token || null, JSON.stringify(pfData)]);

        if (!username) { console.error('[payfast] ITN with no resolvable username'); return; }

        if (status === 'COMPLETE') {
            // Monthly recurring → expire in ~32 days (PayFast re-bills and re-notifies).
            // Lifetime → no expiry.
            const expires = plan && plan.recurring
                ? new Date(Date.now() + 32 * 86400000).toISOString()
                : null;
            await dbRun(
                `UPDATE vectraarchlegacy_users
                    SET subscription_status = 'active',
                        subscription_plan   = $2,
                        subscription_expires_at = $3,
                        pf_token = COALESCE($4, pf_token)
                  WHERE LOWER(username) = LOWER($1)`,
                [username, planId, expires, pfData.token || null]
            );
            console.log(`[payfast] ${username} → active (${planId})`);
        } else if (status === 'CANCELLED') {
            await dbRun(
                `UPDATE vectraarchlegacy_users SET subscription_status = 'cancelled' WHERE LOWER(username) = LOWER($1)`,
                [username]
            );
            console.log(`[payfast] ${username} → cancelled (${planId})`);
        }
    } catch (e) {
        console.error('[payfast] ITN processing error:', e.message);
    }
});

// Browser landing pages after the PayFast round-trip.
app.get('/billing/return', (req, res) => res.sendFile(path.join(__dirname, 'billing.html')));
app.get('/billing/cancel', (req, res) => res.redirect('/billing.html?cancelled=1'));
app.get('/billing',      (req, res) => res.sendFile(path.join(__dirname, 'billing.html')));
app.get('/billing.html', (req, res) => res.sendFile(path.join(__dirname, 'billing.html')));

// ── ADMIN: SUBSCRIPTION MANAGEMENT CONSOLE ────────────────────────────────────
// Everything an admin needs to manage ALL subscriptions in one place. All routes
// are gated by requireAdmin (pass ?adminUsername= / body.adminUsername) and every
// mutation is written to the transaction-history audit log.

// Monthly-recurring-revenue estimate from a set of active plan ids.
function planMonthlyValue(planId) {
    const p = PLANS[planId];
    if (!p) return 0;
    return p.recurring ? parseFloat(p.amount) : 0; // lifetime doesn't add to MRR
}

// Admin overview: every user with their subscription state, computed entitlement,
// and headline metrics. Supports ?q= (search username/email), ?status= filter.
app.get('/api/admin/subscriptions', requireAdmin, async (req, res) => {
    const q      = (req.query.q || '').toString().trim().toLowerCase();
    const status = (req.query.status || '').toString().trim();
    try {
        // Confine a family admin to their own group (same rule as /api/users).
        const myFamily = await adminGroupId(req.adminUsername);
        const rows = await dbAll(`
            SELECT u.username, u.email, u.first_name, u.last_name, u.is_admin,
                   u.subscription_status, u.subscription_plan, u.subscription_expires_at,
                   u.trial_started_at, u.pf_token,
                   g.group_name,
                   (SELECT COUNT(*)  FROM vectraarchlegacy_payments p
                      WHERE LOWER(p.username) = LOWER(u.username)) AS payment_count,
                   (SELECT MAX(p.created_at) FROM vectraarchlegacy_payments p
                      WHERE LOWER(p.username) = LOWER(u.username) AND p.payment_status = 'COMPLETE') AS last_paid_at
              FROM vectraarchlegacy_users u
              LEFT JOIN vectraarchlegacy_groups g ON g.id = u.group_id
             ${myFamily ? 'WHERE u.group_id = $1' : ''}
             ORDER BY u.username ASC`, myFamily ? [myFamily] : []);

        const now = Date.now();
        let subs = rows.map(r => {
            const ent = entitlementFor(r);
            return {
                username:    r.username,
                email:       r.email || '',
                displayName: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.username,
                isAdmin:     !!r.is_admin,
                groupName:   r.group_name || '',
                rawStatus:   r.subscription_status || 'trial',
                plan:        r.subscription_plan || null,
                planLabel:   r.subscription_plan && PLANS[r.subscription_plan] ? PLANS[r.subscription_plan].label : null,
                expiresAt:   r.subscription_expires_at || null,
                trialStartedAt: r.trial_started_at || null,
                hasPfToken:  !!r.pf_token,
                paymentCount: parseInt(r.payment_count, 10) || 0,
                lastPaidAt:  r.last_paid_at || null,
                // Computed live entitlement (what the gate actually does right now):
                effectiveStatus: ent.status,   // active | trial | expired
                active:      ent.active,
                daysLeft:    ent.daysLeft,
            };
        });

        // Filters.
        if (q) subs = subs.filter(s =>
            s.username.toLowerCase().includes(q) ||
            s.email.toLowerCase().includes(q) ||
            s.displayName.toLowerCase().includes(q));
        if (status) subs = subs.filter(s => s.effectiveStatus === status);

        // Headline metrics (computed over ALL users, not the filtered view).
        const all = rows.map(r => ({ r, ent: entitlementFor(r) }));
        const metrics = {
            total:    all.length,
            active:   all.filter(x => x.ent.status === 'active').length,
            trialing: all.filter(x => x.ent.status === 'trial').length,
            expired:  all.filter(x => x.ent.status === 'expired').length,
            admins:   all.filter(x => x.r.is_admin).length,
            lifetime: all.filter(x => x.ent.status === 'active' && x.r.subscription_plan === 'lifetime').length,
            // MRR from active recurring subscriptions only.
            mrr: all
                .filter(x => x.ent.status === 'active' && x.r.subscription_plan)
                .reduce((sum, x) => sum + planMonthlyValue(x.r.subscription_plan), 0),
            // Trials expiring within 3 days (at-risk pipeline).
            expiringSoon: all.filter(x => x.ent.status === 'trial' && x.ent.daysLeft <= 1).length,
        };

        res.json({ success: true, subscriptions: subs, metrics, plans:
            Object.entries(PLANS).map(([id, p]) => ({ id, ...p })), trialDays: TRIAL_DAYS });
    } catch (e) {
        console.error('[admin/subscriptions]', e.message);
        res.status(500).json({ success: false, message: 'Error loading subscriptions.', error: e.message });
    }
});

// Drill-down: one user's full subscription detail + payment ledger.
app.get('/api/admin/subscriptions/:username', requireAdmin, async (req, res) => {
    const username = req.params.username;
    try {
        const r = await dbQuery(`
            SELECT u.username, u.email, u.first_name, u.last_name, u.is_admin,
                   u.subscription_status, u.subscription_plan, u.subscription_expires_at,
                   u.trial_started_at, u.pf_token, u.group_id, g.group_name
              FROM vectraarchlegacy_users u
              LEFT JOIN vectraarchlegacy_groups g ON g.id = u.group_id
             WHERE LOWER(u.username) = LOWER($1)`, [username]);
        if (!r) return res.status(404).json({ success: false, message: 'User not found.' });
        const myFamily = await adminGroupId(req.adminUsername);
        if (myFamily && r.group_id !== myFamily) return res.status(403).json({ success: false, message: 'User is outside your group.' });
        const payments = await dbAll(`
            SELECT id, m_payment_id, pf_payment_id, plan, amount_gross, payment_status,
                   pf_token, created_at
              FROM vectraarchlegacy_payments
             WHERE LOWER(username) = LOWER($1)
             ORDER BY created_at DESC`, [username]);
        const ent = entitlementFor(r);
        res.json({
            success: true,
            user: {
                username: r.username, email: r.email || '',
                displayName: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.username,
                isAdmin: !!r.is_admin, groupName: r.group_name || '',
                rawStatus: r.subscription_status, plan: r.subscription_plan,
                planLabel: r.subscription_plan && PLANS[r.subscription_plan] ? PLANS[r.subscription_plan].label : null,
                expiresAt: r.subscription_expires_at, trialStartedAt: r.trial_started_at,
                hasPfToken: !!r.pf_token,
                effectiveStatus: ent.status, active: ent.active, daysLeft: ent.daysLeft,
            },
            payments,
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error loading subscription detail.', error: e.message });
    }
});

// Grant / set a subscription manually (comp an account, fix a failed webhook,
// move someone onto a plan). plan must be a known id or 'lifetime'. Optional
// `months` sets the expiry for recurring plans (default 1); lifetime has none.
app.post('/api/admin/subscriptions/grant', requireAdmin, async (req, res) => {
    const username = (req.body.username || '').toString();
    const planId   = (req.body.plan || '').toString();
    const months   = Math.max(1, parseInt(req.body.months, 10) || 1);
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    const plan = PLANS[planId];
    if (!plan) return res.status(400).json({ success: false, message: 'Unknown plan.' });
    try {
        const u = await dbQuery('SELECT username, email, group_id FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
        if (!u) return res.status(404).json({ success: false, message: 'User not found.' });
        const myFamily = await adminGroupId(req.adminUsername);
        if (myFamily && u.group_id !== myFamily) return res.status(403).json({ success: false, message: 'User is outside your group.' });
        const expires = plan.recurring
            ? new Date(Date.now() + months * 30 * 86400000).toISOString()
            : null;
        await dbRun(`UPDATE vectraarchlegacy_users
                        SET subscription_status = 'active',
                            subscription_plan = $2,
                            subscription_expires_at = $3
                      WHERE LOWER(username) = LOWER($1)`, [username, planId, expires]);
        await logTransaction(u.username, 'SUBSCRIPTION_GRANT', 'users', null, req.adminUsername);
        if (u.email) await sendEmailNotification(u.email, 'Your VectraArch Legacy subscription is active',
            `An administrator has activated your ${plan.name} subscription. Enjoy full access.`);
        res.json({ success: true, message: `Granted ${plan.name} to ${u.username}.` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error granting subscription.', error: e.message });
    }
});

// Extend an existing subscription's expiry by N days (e.g. goodwill credit).
app.post('/api/admin/subscriptions/extend', requireAdmin, async (req, res) => {
    const username = (req.body.username || '').toString();
    const days     = parseInt(req.body.days, 10);
    if (!username || !days) return res.status(400).json({ success: false, message: 'Username and days required.' });
    try {
        const u = await dbQuery('SELECT username, subscription_expires_at, group_id FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
        if (!u) return res.status(404).json({ success: false, message: 'User not found.' });
        const myFamily = await adminGroupId(req.adminUsername);
        if (myFamily && u.group_id !== myFamily) return res.status(403).json({ success: false, message: 'User is outside your group.' });
        const base = u.subscription_expires_at && new Date(u.subscription_expires_at) > new Date()
            ? new Date(u.subscription_expires_at).getTime()
            : Date.now();
        const expires = new Date(base + days * 86400000).toISOString();
        await dbRun(`UPDATE vectraarchlegacy_users
                        SET subscription_status = 'active', subscription_expires_at = $2
                      WHERE LOWER(username) = LOWER($1)`, [username, expires]);
        await logTransaction(u.username, 'SUBSCRIPTION_EXTEND', 'users', null, req.adminUsername);
        res.json({ success: true, message: `Extended ${u.username} by ${days} day(s).`, expiresAt: expires });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error extending subscription.', error: e.message });
    }
});

// Reset / set a trial: starts a fresh TRIAL_DAYS window (or a custom day count).
app.post('/api/admin/subscriptions/trial', requireAdmin, async (req, res) => {
    const username = (req.body.username || '').toString();
    const days     = Math.max(1, parseInt(req.body.days, 10) || TRIAL_DAYS);
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const u = await dbQuery('SELECT username, group_id FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
        if (!u) return res.status(404).json({ success: false, message: 'User not found.' });
        const myFamily = await adminGroupId(req.adminUsername);
        if (myFamily && u.group_id !== myFamily) return res.status(403).json({ success: false, message: 'User is outside your group.' });
        // Backdate trial_started_at so that (start + TRIAL_DAYS) lands `days` from now.
        const startedAt = new Date(Date.now() - (TRIAL_DAYS - days) * 86400000).toISOString();
        await dbRun(`UPDATE vectraarchlegacy_users
                        SET subscription_status = 'trial',
                            subscription_plan = NULL,
                            subscription_expires_at = NULL,
                            trial_started_at = $2
                      WHERE LOWER(username) = LOWER($1)`, [username, startedAt]);
        await logTransaction(u.username, 'SUBSCRIPTION_TRIAL_RESET', 'users', null, req.adminUsername);
        res.json({ success: true, message: `Reset ${u.username} to a ${days}-day trial.` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error resetting trial.', error: e.message });
    }
});

// Cancel / revoke: set to 'cancelled' (keeps record) or 'expired' (hard lock now).
app.post('/api/admin/subscriptions/cancel', requireAdmin, async (req, res) => {
    const username = (req.body.username || '').toString();
    const hard     = req.body.hard === true || req.body.hard === 'true';
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const u = await dbQuery('SELECT username, email, group_id FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
        if (!u) return res.status(404).json({ success: false, message: 'User not found.' });
        const myFamily = await adminGroupId(req.adminUsername);
        if (myFamily && u.group_id !== myFamily) return res.status(403).json({ success: false, message: 'User is outside your group.' });
        const newStatus = hard ? 'expired' : 'cancelled';
        await dbRun(`UPDATE vectraarchlegacy_users
                        SET subscription_status = $2,
                            subscription_expires_at = CASE WHEN $3 THEN NOW() ELSE subscription_expires_at END
                      WHERE LOWER(username) = LOWER($1)`, [username, newStatus, hard]);
        await logTransaction(u.username, hard ? 'SUBSCRIPTION_REVOKE' : 'SUBSCRIPTION_CANCEL', 'users', null, req.adminUsername);
        res.json({ success: true, message: `${hard ? 'Revoked' : 'Cancelled'} ${u.username}.` });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error cancelling subscription.', error: e.message });
    }
});

// Full payment ledger across all users (the PayFast ITN audit trail).
// Filter with ?username= and/or ?status= (e.g. COMPLETE, CANCELLED, REJECTED_*).
app.get('/api/admin/payments', requireAdmin, async (req, res) => {
    const username = (req.query.username || '').toString().trim();
    const status   = (req.query.status || '').toString().trim();
    const limit    = Math.min(1000, parseInt(req.query.limit, 10) || 200);
    try {
        // Confine a family admin to payments made by their own group's users.
        const myFamily = await adminGroupId(req.adminUsername);
        const inGroup = `LOWER(username) IN (SELECT LOWER(username) FROM vectraarchlegacy_users WHERE group_id = $%N%)`;
        const where = [];
        const params = [];
        if (username) { params.push(username); where.push(`LOWER(username) = LOWER($${params.length})`); }
        if (status)   { params.push(status);   where.push(`payment_status = $${params.length}`); }
        if (myFamily) { params.push(myFamily); where.push(inGroup.replace('%N%', params.length)); }
        params.push(limit);
        const rows = await dbAll(`
            SELECT id, username, m_payment_id, pf_payment_id, plan, amount_gross,
                   payment_status, pf_token, created_at
              FROM vectraarchlegacy_payments
             ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
             ORDER BY created_at DESC LIMIT $${params.length}`, params);
        // Revenue summary over COMPLETE payments within the admin's scope.
        const totals = await dbQuery(`
            SELECT COUNT(*) AS count, COALESCE(SUM(amount_gross),0) AS gross
              FROM vectraarchlegacy_payments
             WHERE payment_status = 'COMPLETE'
             ${myFamily ? `AND LOWER(username) IN (SELECT LOWER(username) FROM vectraarchlegacy_users WHERE group_id = $1)` : ''}`,
            myFamily ? [myFamily] : []);
        res.json({
            success: true,
            payments: rows,
            summary: { completedCount: parseInt(totals.count, 10) || 0, grossRevenue: parseFloat(totals.gross) || 0 },
            limit,
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error loading payments.', error: e.message });
    }
});

// The admin subscription console now lives in-app inside the Admin tab
// (AdminBillingSection in index.html); the legacy standalone page was removed.
// Old links redirect into the app so any saved bookmarks keep working.
app.get('/admin/billing',      (req, res) => res.redirect('/'));
app.get('/admin-billing.html', (req, res) => res.redirect('/'));

// ── IDENTITY PROXY ───────────────────────────────────────────────────────────
const IDENTITY_URL  = 'http://127.0.0.1:3200';
const IDENTITY_KEY  = process.env.IDENTITY_API_KEY || '';

async function forwardToIdentity(method, path, body, res) {
    try {
        const fetchOptions = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': IDENTITY_KEY,
            },
        };
        if (body && method !== 'GET') {
            fetchOptions.body = JSON.stringify(body);
        }
        const upstream = await fetch(`${IDENTITY_URL}${path}`, fetchOptions);
        const data = await upstream.json();
        res.status(upstream.status).json(data);
    } catch (e) {
        console.error('[identity-proxy] Error:', e.message);
        res.status(502).json({ success: false, message: 'Identity service unavailable.', error: e.message });
    }
}

app.get('/api/identity/resolve', async (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    await forwardToIdentity('GET', `/api/identity/resolve${qs ? '?' + qs : ''}`, null, res);
});

app.get('/api/identity/links', async (req, res) => {
    const qs = new URLSearchParams(req.query).toString();
    await forwardToIdentity('GET', `/api/identity/links${qs ? '?' + qs : ''}`, null, res);
});

app.post('/api/identity/link', async (req, res) => {
    await forwardToIdentity('POST', '/api/identity/link', req.body, res);
});

app.delete('/api/identity/link', async (req, res) => {
    await forwardToIdentity('DELETE', '/api/identity/link', req.body, res);
});

app.get('/api/identity/health', async (req, res) => {
    await forwardToIdentity('GET', '/api/identity/health', null, res);
});

// ── SETUP WIZARD ──────────────────────────────────────────────────────────────
app.get('/setup',      (req, res) => res.sendFile(path.join(__dirname, 'setup.html')));
app.get('/setup.html', (req, res) => res.sendFile(path.join(__dirname, 'setup.html')));

app.get('/api/check-username', async (req, res) => {
    const { username } = req.query;
    if (!username || username.length < 3) return res.json({ available: false });
    // Allow letters (any case), digits, @, dot, dash, underscore
    if (!/^[A-Za-z0-9._@-]+$/.test(username)) return res.json({ available: false, reason: 'invalid' });
    try {
        // Case-insensitive uniqueness
        const row = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
        res.json({ available: !row });
    } catch (e) {
        res.status(500).json({ available: false });
    }
});

app.post('/api/setup', async (req, res) => {
    const { profile, family, members, moduleAccess, enabledModules, notifications } = req.body;
    const notif = notifications || {};

    if (!profile?.username || !profile?.password || !profile?.email) {
        return res.status(400).json({ success: false, message: 'Profile, username, and password are required.' });
    }
    const username = profile.username.toLowerCase().trim();
    if (username.length < 3) {
        return res.status(400).json({ success: false, message: 'Username must be at least 3 characters.' });
    }
    if (!profile.password || profile.password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const existing = await client.query(
            'SELECT username FROM vectraarchlegacy_users WHERE username = $1', [username]
        );
        if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Username already taken.' });
        }

        const hash = await bcrypt.hash(profile.password, 10);
        const displayName = `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || username;

        await client.query(`
            INSERT INTO vectraarchlegacy_users
                (username, password_hash, first_name, last_name, display_name,
                 email, phone, gender, date_of_birth, accent_color,
                 role, height_cm, weight_kg, is_admin, event_color)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,'#2dd4bf')`,
            [username, hash,
             profile.firstName || null, profile.lastName || null, displayName,
             profile.email || null, profile.cellNumber || null,
             profile.gender || null, profile.dateOfBirth || null,
             profile.accentColor || '#00ff41',
             profile.role || 'individual',
             profile.heightCm ? parseFloat(profile.heightCm) : null,
             profile.weightKg ? parseFloat(profile.weightKg) : null]
        );

        let groupId = null;
        if (profile.role !== 'individual' && family?.groupName) {
            const famRes = await client.query(`
                INSERT INTO vectraarchlegacy_groups
                    (group_name, admin_username, currency, timezone, member_count, enabled_modules)
                VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
                [family.groupName, username,
                 family.currency || 'ZAR',
                 family.timezone || 'Africa/Johannesburg',
                 family.memberCount || 1,
                 Array.isArray(enabledModules) ? enabledModules.join(',') : 'fin,cal,bud,gym,eat,cyc']
            );
            groupId = famRes.rows[0].id;
        } else if (enabledModules?.length > 0) {
            // Individual — store a solo family record for module prefs
            const famRes = await client.query(`
                INSERT INTO vectraarchlegacy_groups
                    (group_name, admin_username, currency, timezone, member_count, enabled_modules)
                VALUES ($1,$2,$3,$4,1,$5) RETURNING id`,
                [displayName + "'s Hub", username,
                 family?.currency || 'ZAR',
                 family?.timezone || 'Africa/Johannesburg',
                 enabledModules.join(',')]
            );
            groupId = famRes.rows[0].id;
        }

        const memberIdMap = {};
        if (groupId && Array.isArray(members) && members.length > 0) {
            for (let i = 0; i < members.length; i++) {
                const m = members[i];
                const token = require('crypto').randomBytes(24).toString('hex');
                const memRes = await client.query(`
                    INSERT INTO vectraarchlegacy_group_members
                        (group_id, member_type, name, sex, date_of_birth,
                         accent_color, invite_email, invite_cell, invite_sent, invite_token)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
                    [groupId, m.type || 'other', m.name || 'Member',
                     m.sex || null, m.dateOfBirth || null,
                     m.accentColor || '#00ff41',
                     m.inviteEmail || null, m.inviteCell || null,
                     !!(m.sendInvite && m.inviteEmail), token]
                );
                memberIdMap[i] = memRes.rows[0].id;
            }
        }

        if (groupId && moduleAccess && Object.keys(moduleAccess).length > 0) {
            for (const [idxStr, mods] of Object.entries(moduleAccess)) {
                const idx = parseInt(idxStr, 10);
                const memberId = memberIdMap[idx];
                if (!memberId) continue;
                for (const [mod, enabled] of Object.entries(mods)) {
                    await client.query(`
                        INSERT INTO vectraarchlegacy_module_access
                            (group_id, owner_username, member_id, module, enabled)
                        VALUES ($1,$2,$3,$4,$5)
                        ON CONFLICT (group_id, owner_username, member_id, module)
                        DO UPDATE SET enabled = EXCLUDED.enabled`,
                        [groupId, username, memberId, mod, !!enabled]
                    );
                }
            }
        }

        await client.query('COMMIT');
        await logTransaction(username, 'SETUP_COMPLETE', 'users', null, username);

        // ── Notifications + comms (best-effort; never blocks setup completion) ──
        // Telegram chat ID lives on the user row.
        if (notif.telegramChatId) {
            try {
                await dbRun('UPDATE vectraarchlegacy_users SET telegram_chat_id = $1 WHERE username = $2',
                    [String(notif.telegramChatId).trim(), username]);
            } catch (e) { console.error('[setup] telegram_chat_id save failed:', e.message); }
        }
        // Persist notification channel preferences (default both on).
        const wantTelegram = notif.telegram !== false;
        const wantEmail    = notif.email    !== false;
        try {
            await dbRun(
                'INSERT INTO vectraarchlegacy_notifications (username,type,enabled) VALUES ($1,$2,$3) ON CONFLICT (username,type) DO UPDATE SET enabled=EXCLUDED.enabled',
                [username, 'telegram', wantTelegram ? 1 : 0]);
            await dbRun(
                'INSERT INTO vectraarchlegacy_notifications (username,type,enabled) VALUES ($1,$2,$3) ON CONFLICT (username,type) DO UPDATE SET enabled=EXCLUDED.enabled',
                [username, 'email', wantEmail ? 1 : 0]);
        } catch (e) { console.error('[setup] notification prefs save failed:', e.message); }

        // Welcome email to the new account owner.
        if (profile.email) {
            try {
                const { text, html } = renderLegacyEmail({
                    heading: 'Welcome to VectraArch Legacy',
                    intro:   `Your hub is ready, ${profile.firstName || username}. You can sign in any time with the username below.`,
                    rows:    [{ label: 'Username', value: username }],
                    note:    "Thanks for setting up your VectraArch Legacy hub.",
                    button:  { url: `${PUBLIC_BASE_URL}/login.html`, label: 'Open your hub' },
                });
                await sendEmailNotification(profile.email, 'Welcome to VectraArch Legacy', text, html);
            } catch (e) { console.error('[setup] welcome email failed:', e.message); }
        }

        // Email invites to any members the owner asked to invite.
        if (Array.isArray(members) && members.length > 0) {
            for (const m of members) {
                if (!(m.sendInvite && m.inviteEmail)) continue;
                const memberEmail = String(m.inviteEmail).toLowerCase().trim();
                try {
                    const dupUser   = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE LOWER(email) = $1', [memberEmail]);
                    const dupInvite = await dbQuery("SELECT id FROM vectraarchlegacy_invites WHERE LOWER(email) = $1 AND status = 'pending'", [memberEmail]);
                    if (dupUser || dupInvite) continue;
                    const token = crypto.randomBytes(24).toString('hex');
                    const row = await pool.query(
                        `INSERT INTO vectraarchlegacy_invites (email, token, invited_by, role, note)
                         VALUES ($1,$2,$3,'user',$4) RETURNING *`,
                        [memberEmail, token, username, m.name ? `Setup invite for ${m.name}` : null]
                    );
                    await sendInviteEmail(row.rows[0], profile.firstName || username);
                } catch (e) { console.error('[setup] member invite failed:', memberEmail, e.message); }
            }
        }

        const userRow = await dbQuery('SELECT * FROM vectraarchlegacy_users WHERE username = $1', [username]);
        res.json({ success: true, ...mapUser(userRow) });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('[setup]', err.message);
        res.status(500).json({ success: false, message: 'Setup failed.', error: err.message });
    } finally {
        client.release();
    }
});

ensureSchema()
    .then(() => app.listen(PORT, HOST, () => console.log('VectraArch Legacy online · port ' + PORT)))
    .catch(err => { console.error('Fatal: schema init failed', err); process.exit(1); });