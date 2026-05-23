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
const { Pool }   = require('pg');
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
app.use(express.json({ limit: '25mb' }));
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
app.get('/login.html',     (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/auth-guard.js',  (req, res) => res.sendFile(path.join(__dirname, 'VectraArchLegacyAuthGuard.js')));

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
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_families (
            id              SERIAL PRIMARY KEY,
            family_name     TEXT NOT NULL,
            admin_username  TEXT NOT NULL,
            currency        TEXT NOT NULL DEFAULT 'ZAR',
            timezone        TEXT NOT NULL DEFAULT 'Africa/Johannesburg',
            member_count    INT NOT NULL DEFAULT 1,
            enabled_modules TEXT NOT NULL DEFAULT 'fin,cal,bud,gym,eat,cyc',
            created_at      TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_families_admin ON vectraarchlegacy_families(admin_username)`,
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_family_members (
            id            SERIAL PRIMARY KEY,
            family_id     INT NOT NULL,
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
        `CREATE INDEX IF NOT EXISTS idx_fam_members_fid ON vectraarchlegacy_family_members(family_id)`,
        `CREATE TABLE IF NOT EXISTS vectraarchlegacy_module_access (
            id              SERIAL PRIMARY KEY,
            family_id       INT NOT NULL,
            owner_username  TEXT NOT NULL,
            member_id       INT NOT NULL,
            module          TEXT NOT NULL,
            enabled         BOOLEAN NOT NULL DEFAULT TRUE,
            UNIQUE(family_id, owner_username, member_id, module)
        )`,
        `CREATE INDEX IF NOT EXISTS idx_mod_access_owner ON vectraarchlegacy_module_access(family_id, owner_username)`,
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
    return {
        username:         row.username,
        firstName:        row.first_name        || '',
        lastName:         row.last_name         || '',
        displayName:      row.display_name      || row.username,
        bio:              row.bio               || '',
        pronouns:         row.pronouns          || '',
        profilePicUrl:    row.profile_pic_url   || (row.gender === 'Female' ? '/images/female.jpg' : '/images/male.jpg'),
        email:            row.email             || '',
        phone:            row.phone             || '',
        address:          row.address           || '',
        eventColor:       row.event_color       || '#2dd4bf',
        isAdmin:          !!row.is_admin,
        gender:           row.gender            || '',
        telegram_chat_id: row.telegram_chat_id  || '',
        theme:            row.theme             || 'dark',
        activityStatus:   !!row.activity_status,
        lastActive:       row.last_active       || '',
        dateOfBirth:      row.date_of_birth     || '',
        accentColor:      row.accent_color      || '#00ff41',
        role:             row.role              || 'individual',
        heightCm:         row.height_cm         || null,
        weightKg:         row.weight_kg         || null,
        authProvider:     row.auth_provider     || 'password',
        hasGoogle:        !!row.google_id,
        twoFactorEnabled: !!row.twofa_secret,
    };
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

async function sendEmailNotification(email, subject, message) {
    try {
        await transporter.sendMail({ from: process.env.EMAIL_USER, to: email, subject, text: message });
    } catch (e) { console.error('Email error:', e.message); }
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

// ── AUTH ──────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required.' });
    try {
        const row = await dbQuery('SELECT * FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        if (!row.password_hash) {
            return res.status(401).json({ success: false, message: 'This account uses Google sign-in. Please continue with Google.' });
        }
        const match = await bcrypt.compare(password, row.password_hash);
        if (!match) return res.status(401).json({ success: false, message: 'Authentication failed: Incorrect password.' });
        await dbRun('UPDATE vectraarchlegacy_users SET last_active = $1 WHERE username = $2', [new Date().toISOString(), username]);
        await logTransaction(username, 'LOGIN', 'users', null, username);
        if (row.twofa_secret) return res.json({ success: true, requires2FA: true, username });
        res.json({ success: true, ...mapUser(row) });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error during login.', error: e.message });
    }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const rows = await dbAll(
            'SELECT username, first_name AS "firstName", last_name AS "lastName", display_name AS "displayName", is_admin AS "isAdmin", activity_status AS "activityStatus", last_active AS "lastActive" FROM vectraarchlegacy_users'
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching users.', error: e.message });
    }
});

app.post('/api/add-user', requireAdmin, async (req, res) => {
    const { username, password, firstName, lastName, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required.' });
    try {
        const existing = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (existing) return res.status(400).json({ success: false, message: 'User already exists.' });
        const hash = await bcrypt.hash(password, 10);
        await dbRun(
            'INSERT INTO vectraarchlegacy_users (username, password_hash, first_name, last_name, display_name, is_admin) VALUES ($1,$2,$3,$4,$5,0)',
            [username, hash, firstName || null, lastName || null, displayName || username]
        );
        await logTransaction(username, 'CREATE', 'users', null, req.adminUsername);
        sendTelegramMessage(GROUP_CHAT_ID, `New user added: ${username} by ${req.adminUsername}`);
        res.json({ success: true, message: 'User added successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error adding user.', error: e.message });
    }
});

app.delete('/api/delete-user/:username', requireAdmin, async (req, res) => {
    const { username } = req.params;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const row = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        await dbRun('DELETE FROM vectraarchlegacy_users WHERE username = $1', [username]);
        await logTransaction(username, 'DELETE_USER', 'users', null, req.adminUsername);
        sendTelegramMessage(GROUP_CHAT_ID, `User ${username} deleted by ${req.adminUsername}`);
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
        res.json({ success: true, message: 'Password updated successfully!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Server error updating password.', error: e.message });
    }
});

app.delete('/api/account', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password required.' });
    try {
        const row = await dbQuery('SELECT password_hash FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        const match = await bcrypt.compare(password, row.password_hash);
        if (!match) return res.status(401).json({ success: false, message: 'Incorrect password.' });
        await dbRun('DELETE FROM vectraarchlegacy_users WHERE username = $1', [username]);
        await logTransaction(username, 'DELETE_ACCOUNT', 'users', null, username);
        sendTelegramMessage(GROUP_CHAT_ID, `User ${username} deleted their account`);
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
        const row = await dbQuery('SELECT * FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, ...mapUser(row) });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching profile.', error: e.message });
    }
});

app.post('/api/profile-pictures', async (req, res) => {
    const { username, firstName, lastName, profilePicUrl, email, phone, address,
            eventColor, accentColor, gender, telegram_chat_id, displayName, bio, pronouns,
            theme, activityStatus, dob, weight, height, role } = req.body;
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
                email=$4, phone=$5, address=$6,
                event_color=$7, gender=$8, telegram_chat_id=$9, display_name=$10,
                bio=$11, pronouns=$12, theme=$13, activity_status=$14, last_active=$15,
                date_of_birth=$16, height_cm=$17, weight_kg=$18, accent_color=$19, role=$20
            WHERE username=$21`,
            [firstName||null, lastName||null, profilePicUrl||null, email||null, phone||null, address||null,
             resolvedAccent, gender||null, telegram_chat_id||null, displayName||username,
             bio||null, pronouns||null, theme||'dark', activityStatus?1:0, new Date().toISOString(),
             dob||null,
             height ? parseFloat(height) : null,
             weight ? parseFloat(weight) : null,
             resolvedAccent,
             role||null,
             username]
        );
        await logTransaction(username, 'UPDATE_PROFILE', 'users', null, username);
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
    const { viewer, adminUsername } = req.query;
    try {
        let rows;
        if (adminUsername) {
            const admin = await dbQuery('SELECT is_admin FROM vectraarchlegacy_users WHERE username = $1', [adminUsername]);
            if (admin && admin.is_admin) {
                rows = await dbAll('SELECT viewer, target FROM vectraarchlegacy_access');
            } else {
                if (!viewer) return res.status(400).json({ success: false, message: 'Viewer required if not admin.' });
                rows = await dbAll('SELECT viewer, target FROM vectraarchlegacy_access WHERE viewer = $1', [viewer]);
            }
        } else {
            if (!viewer) return res.status(400).json({ success: false, message: 'Viewer or adminUsername required.' });
            rows = await dbAll('SELECT viewer, target FROM vectraarchlegacy_access WHERE viewer = $1', [viewer]);
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
// Set (upsert) one module's sharing state: owner shares module with partner
app.post('/api/partner-sharing', async (req, res) => {
    const { owner, partner, module, enabled } = req.body;
    if (!owner || !partner || !module) return res.status(400).json({ success: false, message: 'owner, partner, module required.' });
    if (owner === partner) return res.status(400).json({ success: false, message: 'Cannot share with yourself.' });
    try {
        await dbRun(
            `INSERT INTO vectraarchlegacy_partner_sharing (owner, partner, module, enabled)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (owner, partner, module) DO UPDATE SET enabled = $4`,
            [owner, partner, module, !!enabled]
        );
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
        // Who has granted me full access (they appear as target when I am viewer)
        const accessRows = await dbAll(
            'SELECT target FROM vectraarchlegacy_access WHERE viewer = $1', [username]
        );
        // Explicit per-module config set by each owner for me
        const moduleRows = await dbAll(
            'SELECT owner, module, enabled FROM vectraarchlegacy_partner_sharing WHERE partner = $1', [username]
        );
        const explicit = {};
        moduleRows.forEach(r => {
            if (!explicit[r.owner]) explicit[r.owner] = {};
            explicit[r.owner][r.module] = r.enabled;
        });
        const sharedWithMe = {};
        accessRows.forEach(r => {
            const owner = r.target;
            if (explicit[owner] && Object.keys(explicit[owner]).length > 0) {
                sharedWithMe[owner] = explicit[owner];
            } else {
                // No explicit config yet — backward-compatible default: all modules on
                sharedWithMe[owner] = Object.fromEntries(ALL_MODULES.map(m => [m, true]));
            }
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

// ── FINANCIAL ─────────────────────────────────────────────────────────────────
app.get('/api/financial', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    try {
        const rows = await dbAll("SELECT id, username, category, amount, type, TO_CHAR(date, 'YYYY-MM-DD') AS date FROM vectraarchlegacy_financial WHERE username = $1", [user]);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching financial items.', error: e.message });
    }
});

app.post('/api/financial', async (req, res) => {
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

app.put('/api/financial/:id', async (req, res) => {
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

app.delete('/api/financial/:id', async (req, res) => {
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

app.get('/api/budget', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
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

app.post('/api/budget', async (req, res) => {
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

app.put('/api/budget/:id', async (req, res) => {
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
app.get('/api/calendar', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    try {
        const rows = await dbAll(
            "SELECT id, username AS user, title, TO_CHAR(date, 'YYYY-MM-DD HH24:MI:SS') AS date, is_financial AS financial, type, amount, event_color AS \"eventColor\" FROM vectraarchlegacy_calendar WHERE username = $1",
            [user]
        );
        res.json(rows);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching calendar.', error: e.message });
    }
});

app.post('/api/calendar', async (req, res) => {
    const { user, title, date, financial, type, amount, eventColor, finType } = req.body;
    if (!user || !title || !date) return res.status(400).json({ success: false, message: 'User, title, and date required.' });
    try {
        const isFinancial = !!(financial && amount && parseFloat(amount) > 0);
        const calType = isFinancial ? (finType || type || 'income') : (type || null);
        const r = await dbRun(
            'INSERT INTO vectraarchlegacy_calendar (username,title,date,is_financial,type,amount,event_color) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
            [user, title, date, isFinancial ? 1 : 0, calType, amount || null, eventColor || null]
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
        const rows = await dbAll('SELECT category, exercise_value AS value, exercise_label AS label FROM legacy_gym_options ORDER BY id ASC');
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

app.get('/api/gymworkout', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    try {
        const rows = await dbAll('SELECT id, username AS user, day, exercise, sets, reps, weight, date FROM vectraarchlegacy_gymworkout WHERE username = $1', [user]);
        res.json(rows);
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error fetching gym workouts.', error: e.message });
    }
});

app.post('/api/gymworkout', async (req, res) => {
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

app.put('/api/gymworkout/:id', async (req, res) => {
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
        const rows = await dbAll('SELECT category, meal_value AS value, meal_label AS label, calories FROM legacy_meal_templates ORDER BY id ASC');
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

app.get('/api/mealplan', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
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

app.post('/api/mealplan', async (req, res) => {
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
app.get('/api/period', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
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

app.post('/api/period', async (req, res) => {
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
app.post('/api/import-statement', async (req, res) => {
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
        const row = await dbQuery('SELECT * FROM vectraarchlegacy_users WHERE username = $1', [username]);
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
                let user = await dbQuery('SELECT * FROM vectraarchlegacy_users WHERE google_id = $1', [googleUser.id]);

                // 2. Existing user by email (auto-link Google to their account)
                if (!user) {
                    user = await dbQuery('SELECT * FROM vectraarchlegacy_users WHERE LOWER(email) = $1', [email]);
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
                             email, google_id, auth_provider, is_admin, event_color, theme, accent_color)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,'google',$8,'#2dd4bf','dark','#00ff41')`,
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

                    user = await dbQuery('SELECT * FROM vectraarchlegacy_users WHERE username = $1', [username]);
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

                return res.send(renderHandoffPage({ success: true, ...mapUser(user) }, '/app.html'));
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
        const row = await dbQuery('SELECT * FROM vectraarchlegacy_users WHERE username = $1', [pending.username]);
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
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        return { sent: false, reason: 'Email not configured (EMAIL_USER/EMAIL_PASS missing).' };
    }
    try {
        const { subject, text, html } = buildInviteEmail(invite, inviter);
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: invite.email,
            subject, text, html,
        });
        return { sent: true };
    } catch (e) {
        console.error('[invite] email send failed:', e.message);
        return { sent: false, reason: e.message };
    }
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
    const clean = username.toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (clean !== username.toLowerCase()) return res.json({ available: false, reason: 'invalid' });
    try {
        const row = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [clean]);
        res.json({ available: !row });
    } catch (e) {
        res.status(500).json({ available: false });
    }
});

app.post('/api/setup', async (req, res) => {
    const { profile, family, members, moduleAccess, enabledModules } = req.body;

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
                 role, height_cm, weight_kg, is_admin, event_color, theme)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,'#2dd4bf','dark')`,
            [username, hash,
             profile.firstName || null, profile.lastName || null, displayName,
             profile.email || null, profile.cellNumber || null,
             profile.gender || null, profile.dateOfBirth || null,
             profile.accentColor || '#00ff41',
             profile.role || 'individual',
             profile.heightCm ? parseFloat(profile.heightCm) : null,
             profile.weightKg ? parseFloat(profile.weightKg) : null]
        );

        let familyId = null;
        if (profile.role !== 'individual' && family?.familyName) {
            const famRes = await client.query(`
                INSERT INTO vectraarchlegacy_families
                    (family_name, admin_username, currency, timezone, member_count, enabled_modules)
                VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
                [family.familyName, username,
                 family.currency || 'ZAR',
                 family.timezone || 'Africa/Johannesburg',
                 family.memberCount || 1,
                 Array.isArray(enabledModules) ? enabledModules.join(',') : 'fin,cal,bud,gym,eat,cyc']
            );
            familyId = famRes.rows[0].id;
        } else if (enabledModules?.length > 0) {
            // Individual — store a solo family record for module prefs
            const famRes = await client.query(`
                INSERT INTO vectraarchlegacy_families
                    (family_name, admin_username, currency, timezone, member_count, enabled_modules)
                VALUES ($1,$2,$3,$4,1,$5) RETURNING id`,
                [displayName + "'s Hub", username,
                 family?.currency || 'ZAR',
                 family?.timezone || 'Africa/Johannesburg',
                 enabledModules.join(',')]
            );
            familyId = famRes.rows[0].id;
        }

        const memberIdMap = {};
        if (familyId && Array.isArray(members) && members.length > 0) {
            for (let i = 0; i < members.length; i++) {
                const m = members[i];
                const token = require('crypto').randomBytes(24).toString('hex');
                const memRes = await client.query(`
                    INSERT INTO vectraarchlegacy_family_members
                        (family_id, member_type, name, sex, date_of_birth,
                         accent_color, invite_email, invite_cell, invite_sent, invite_token)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
                    [familyId, m.type || 'other', m.name || 'Member',
                     m.sex || null, m.dateOfBirth || null,
                     m.accentColor || '#00ff41',
                     m.inviteEmail || null, m.inviteCell || null,
                     !!(m.sendInvite && m.inviteEmail), token]
                );
                memberIdMap[i] = memRes.rows[0].id;
            }
        }

        if (familyId && moduleAccess && Object.keys(moduleAccess).length > 0) {
            for (const [idxStr, mods] of Object.entries(moduleAccess)) {
                const idx = parseInt(idxStr, 10);
                const memberId = memberIdMap[idx];
                if (!memberId) continue;
                for (const [mod, enabled] of Object.entries(mods)) {
                    await client.query(`
                        INSERT INTO vectraarchlegacy_module_access
                            (family_id, owner_username, member_id, module, enabled)
                        VALUES ($1,$2,$3,$4,$5)
                        ON CONFLICT (family_id, owner_username, member_id, module)
                        DO UPDATE SET enabled = EXCLUDED.enabled`,
                        [familyId, username, memberId, mod, !!enabled]
                    );
                }
            }
        }

        await client.query('COMMIT');
        await logTransaction(username, 'SETUP_COMPLETE', 'users', null, username);

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