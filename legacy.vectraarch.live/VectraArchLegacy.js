'use strict';
/**
 * VectraArch Legacy — server.js
 * Rewritten: sqlite3 → pg (VectraArchLegacy database)
 * Column mapping: user→username, firstName→first_name, etc.
 * API contract unchanged — frontend requires no modifications.
 */

const express    = require('express');
const path       = require('path');
const { Pool }   = require('pg');
const bcrypt     = require('bcrypt');
const cors       = require('cors');
const https      = require('https');
const http       = require('http');
const fs         = require('fs');
const nodemailer = require('nodemailer');
const { authenticator } = require('otplib');
const QRCode     = require('qrcode');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const app  = express();
const PORT = 3300;
const HOST = '127.0.0.1';

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
    if (req.url === '/legacy' || req.url.startsWith('/legacy/')) {
        req.url = req.url.slice('/legacy'.length) || '/';
    }
    next();
});
app.use('/images', express.static(path.join(__dirname, 'images')));
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

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
    const { username, firstName, lastName, profilePicUrl, email, phone, address, eventColor, gender, telegram_chat_id, displayName, bio, pronouns, theme, activityStatus } = req.body;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    if (firstName && firstName.length > 50) return res.status(400).json({ success: false, message: 'First name must be 50 characters or less.' });
    if (lastName  && lastName.length  > 50) return res.status(400).json({ success: false, message: 'Last name must be 50 characters or less.' });
    try {
        const exists = await dbQuery('SELECT username FROM vectraarchlegacy_users WHERE username = $1', [username]);
        if (!exists) return res.status(404).json({ success: false, message: 'User not found.' });
        await dbRun(`
            UPDATE vectraarchlegacy_users SET
                first_name=$1, last_name=$2, profile_pic_url=$3, email=$4, phone=$5, address=$6,
                event_color=$7, gender=$8, telegram_chat_id=$9, display_name=$10,
                bio=$11, pronouns=$12, theme=$13, activity_status=$14, last_active=$15
            WHERE username=$16`,
            [firstName||null, lastName||null, profilePicUrl||null, email||null, phone||null, address||null,
             eventColor||'#2dd4bf', gender||null, telegram_chat_id||null, displayName||username,
             bio||null, pronouns||null, theme||'dark', activityStatus?1:0, new Date().toISOString(), username]
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
app.get('/api/budget', async (req, res) => {
    const { user } = req.query;
    if (!user) return res.status(400).json({ success: false, message: 'User required.' });
    try {
        const rows = await dbAll(
            "SELECT id, username AS \"user\", income, expenses, TO_CHAR(date, 'YYYY-MM-DD') AS date, COALESCE(budget_type,'need') AS budget_type FROM vectraarchlegacy_budget WHERE username = $1 ORDER BY date DESC",
            [user]
        );
        const data = rows.map(r => ({
            ...r,
            expenses: Array.isArray(r.expenses) ? r.expenses
                : (typeof r.expenses === 'string' ? JSON.parse(r.expenses || '[]') : []),
        }));
        res.json({ success: true, data });
    } catch (e) {
        console.error('[budget GET]', e.message);
        res.status(500).json({ success: false, message: 'Database error fetching budget.', error: e.message });
    }
});

app.post('/api/budget', async (req, res) => {
    const { user, income, expenses, date, budget_type } = req.body;
    if (!user || !date) return res.status(400).json({ success: false, message: 'User and date required.' });
    let expArr = [];
    try { const raw = expenses || '[]'; expArr = typeof raw === 'string' ? JSON.parse(raw) : raw; if (!Array.isArray(expArr)) expArr = []; } catch { expArr = []; }
    if (expArr.length === 0) return res.status(400).json({ success: false, message: 'At least one expense category required.' });
    const totalPlanned = expArr.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const incomeVal = parseFloat(income) || totalPlanned;
    const budType = budget_type || expArr[0]?.type || 'need';
    const dateVal = String(date).slice(0, 10);
    try {
        // Pass expArr (JS array) directly — pg serialises it into jsonb correctly
        const r = await dbRun(
            'INSERT INTO vectraarchlegacy_budget (username,income,expenses,date,budget_type) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [user, incomeVal, expArr, dateVal, budType]
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
    const { user, income, expenses, date, budget_type } = req.body;
    if (!user || !date) return res.status(400).json({ success: false, message: 'User and date required.' });
    let expArr = [];
    try { const raw = expenses||'[]'; expArr = typeof raw==='string'?JSON.parse(raw):raw; if(!Array.isArray(expArr)) expArr=[]; } catch { expArr=[]; }
    const totalPlanned = expArr.reduce((s,e)=>s+parseFloat(e.amount||0),0);
    const incomeVal = parseFloat(income)||totalPlanned;
    const budType = budget_type || expArr[0]?.type || 'need';
    const dateVal = String(date).slice(0, 10);
    try {
        const row = await dbQuery('SELECT id FROM vectraarchlegacy_budget WHERE id=$1 AND username=$2', [id, user]);
        if (!row) return res.status(404).json({ success: false, message: 'Budget not found.' });
        // Pass expArr directly — pg handles jsonb serialisation
        await dbTransaction([
            { sql: 'UPDATE vectraarchlegacy_budget SET income=$1,expenses=$2,date=$3,budget_type=$4 WHERE id=$5', params:[incomeVal,expArr,dateVal,budType,id] },
            { sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)', params:[user,'UPDATE','budget',id,user,new Date().toISOString()] }
        ]);
        res.json({ success: true, message: 'Budget updated!' });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Database error: ' + e.message });
    }
});

app.delete('/api/budget/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, username FROM vectraarchlegacy_budget WHERE id=$1', [id]);
        if (!row) return res.status(404).json({ success: false, message: 'Budget not found.' });
        await dbTransaction([
            { sql: 'DELETE FROM vectraarchlegacy_budget WHERE id=$1', params: [id] },
            { sql: 'INSERT INTO vectraarchlegacy_transaction_history (username,action,table_name,record_id,modified_by,modified_at) VALUES ($1,$2,$3,$4,$5,$6)', params: [row.username,'DELETE','budget',id,row.username,new Date().toISOString()] }
        ]);
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

app.listen(PORT, HOST, () => console.log('VectraArch Legacy online · port ' + PORT));