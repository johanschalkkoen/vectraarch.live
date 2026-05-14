const express = require('express');
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const cors = require('cors');
const https = require('https');
const http = require('http');
const fs = require('fs');
const nodemailer = require('nodemailer');
const otplib = require('otplib');

const QRCode = require('qrcode');
// Initialize Express app
const app = express();
app.use(cors());
app.use(express.json());
// Database connection with error handling
const db = new sqlite3.Database('./ourlife.db', (err) => {
    if (err) {
        console.error('Error connecting to SQLite database:', err.message);
        return;
    }
    console.log('Connected to SQLite database.');
    // Define table schemas in a single array for batch creation
    const tables = [
        'CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT NOT NULL, firstName TEXT, lastName TEXT, displayName TEXT, bio TEXT, pronouns TEXT, isAdmin INTEGER DEFAULT 0 CHECK (isAdmin IN (0, 1)), profilePicUrl TEXT, email TEXT, phone TEXT, address TEXT, eventColor TEXT, gender TEXT, telegram_chat_id TEXT, theme TEXT DEFAULT "dark", activityStatus INTEGER DEFAULT 1 CHECK (activityStatus IN (0, 1)), lastActive TEXT)',
        'CREATE TABLE IF NOT EXISTS access (viewer TEXT, target TEXT, PRIMARY KEY (viewer, target), FOREIGN KEY (viewer) REFERENCES users(username) ON DELETE CASCADE, FOREIGN KEY (target) REFERENCES users(username) ON DELETE CASCADE)',
        'CREATE TABLE IF NOT EXISTS financial (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, category TEXT, amount REAL CHECK (amount >= 0), type TEXT CHECK (type IN (\'income\', \'expense\')), date TEXT, FOREIGN KEY (user) REFERENCES users(username) ON DELETE CASCADE)',
        'CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, income REAL CHECK (income >= 0), expenses TEXT, date TEXT, FOREIGN KEY (user) REFERENCES users(username) ON DELETE CASCADE)',
        'CREATE TABLE IF NOT EXISTS period (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, startDate TEXT, endDate TEXT, cycleLength INTEGER CHECK (cycleLength > 0), symptoms TEXT, date TEXT, FOREIGN KEY (user) REFERENCES users(username) ON DELETE CASCADE)',
        'CREATE TABLE IF NOT EXISTS calendar (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, title TEXT, date TEXT, financial INTEGER CHECK (financial IN (0, 1)), type TEXT, amount REAL CHECK (amount >= 0 OR amount IS NULL), eventColor TEXT, FOREIGN KEY (user) REFERENCES users(username) ON DELETE CASCADE)',
        'CREATE TABLE IF NOT EXISTS gymworkout (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, day TEXT, exercise TEXT, sets INTEGER CHECK (sets > 0), reps INTEGER CHECK (reps > 0), weight REAL CHECK (weight >= 0), date TEXT, FOREIGN KEY (user) REFERENCES users(username) ON DELETE CASCADE)',
        'CREATE TABLE IF NOT EXISTS mealplan (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, day TEXT, mealType TEXT, description TEXT, calories INTEGER CHECK (calories >= 0), date TEXT, FOREIGN KEY (user) REFERENCES users(username) ON DELETE CASCADE)',
        'CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, type TEXT CHECK (type IN (\'telegram\', \'email\')), enabled INTEGER DEFAULT 1 CHECK (enabled IN (0, 1)), FOREIGN KEY (user) REFERENCES users(username) ON DELETE CASCADE)',
        'CREATE TABLE IF NOT EXISTS transaction_history (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, action TEXT, tableName TEXT, recordId INTEGER, modifiedBy TEXT, modifiedAt TEXT, FOREIGN KEY (user) REFERENCES users(username) ON DELETE CASCADE)'
    ];
    // Create indexes for performance
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_financial_user_date ON financial(user, date)',
        'CREATE INDEX IF NOT EXISTS idx_budget_user_date ON budget(user, date)',
        'CREATE INDEX IF NOT EXISTS idx_period_user_date ON period(user, date)',
        'CREATE INDEX IF NOT EXISTS idx_calendar_user_date ON calendar(user, date)',
        'CREATE INDEX IF NOT EXISTS idx_gymworkout_user_date ON gymworkout(user, date)',
        'CREATE INDEX IF NOT EXISTS idx_mealplan_user_date ON mealplan(user, date)',
        'CREATE INDEX IF NOT EXISTS idx_access_viewer ON access(viewer)',
        'CREATE INDEX IF NOT EXISTS idx_access_target ON access(target)',
        'CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user)',
        'CREATE INDEX IF NOT EXISTS idx_transaction_history_user ON transaction_history(user)'
    ];
    // Batch table and index creation with promise-based error handling
    db.serialize(async () => {
        try {
            await dbRun('PRAGMA foreign_keys = ON');
            console.log('Foreign keys enabled.');
            for (let i = 0; i < tables.length; i++) {
                await dbRun(tables[i]);
                console.log(`Table ${i + 1} checked/created.`);
            }
            for (let i = 0; i < indexes.length; i++) {
                await dbRun(indexes[i]);
                console.log(`Index ${i + 1} checked/created.`);
            }
            // Migration: Add new columns if not exists
            const rows = await dbAll('PRAGMA table_info(users)');
            const requiredColumns = [
                { name: 'firstName', type: 'TEXT' },
                { name: 'lastName', type: 'TEXT' },
                { name: 'displayName', type: 'TEXT' },
                { name: 'bio', type: 'TEXT' },
                { name: 'pronouns', type: 'TEXT' },
                { name: 'theme', type: 'TEXT', defaultValue: '"dark"' },
                { name: 'activityStatus', type: 'INTEGER', defaultValue: '1', check: 'CHECK (activityStatus IN (0, 1))' },
                { name: 'lastActive', type: 'TEXT' },
                { name: 'telegram_chat_id', type: 'TEXT' }
            ];
            for (const col of requiredColumns) {
                if (!rows.some(row => row.name === col.name)) {
                    const columnDef = `${col.name} ${col.type}${col.defaultValue ? ` DEFAULT ${col.defaultValue}` : ''}${col.check ? ` ${col.check}` : ''}`;
                    await dbRun(`ALTER TABLE users ADD COLUMN ${columnDef}`);
                    console.log(`Added ${col.name} column to users table.`);
                }
            }
            // Migration: Rename 'description' to 'category' if exists
            const financialRows = await dbAll('PRAGMA table_info(financial)');
            const hasCategory = financialRows.some(row => row.name === 'category');
            const hasDescription = financialRows.some(row => row.name === 'description');
            if (hasDescription && !hasCategory) {
                await dbRun('ALTER TABLE financial RENAME COLUMN description TO category');
                console.log('Renamed description to category in financial table.');
            }
        } catch (err) {
            console.error('Error during database initialization:', err.message);
        }
    });
});

// Middleware to check admin access
const requireAdmin = async (req, res, next) => {
    const adminUsername = req.body?.adminUsername || req.query?.adminUsername;
    if (!adminUsername) {
        console.error('No adminUsername provided');
        return res.status(400).json({ success: false, message: 'Admin username required.' });
    }
    try {
        const row = await dbQuery('SELECT isAdmin FROM users WHERE username = ?', [adminUsername]);
        if (!row || !row.isAdmin) {
            console.error('Unauthorized access attempt by:', adminUsername);
            return res.status(403).json({ success: false, message: 'Unauthorized: Admin access required.' });
        }
        req.adminUsername = adminUsername;
        next();
    } catch (error) {
        console.error('Error checking admin access:', error.message);
        res.status(500).json({ success: false, message: 'Server error checking admin access.' });
    }
};

// Reusable query functions
const dbQuery = (query, params) => new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
    });
});
const dbRun = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
        if (err) reject(err);
        else resolve(this);
    });
});
const dbAll = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
    });
});
// Run transaction for atomic operations
const dbTransaction = async (operations) => {
    await dbRun('BEGIN TRANSACTION');
    try {
        const results = await Promise.all(operations);
        await dbRun('COMMIT');
        return results;
    } catch (error) {
        await dbRun('ROLLBACK');
        throw error;
    }
};
// Hardcoded Telegram Bot Token and Group Chat ID
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
// Email configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});
// Function to send Telegram message
function sendTelegramMessage(chatId, message) {
    const data = JSON.stringify({ chat_id: chatId, text: message });
    const options = {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };
    const tgReq = https.request(options, (tgRes) => {
        let responseData = '';
        tgRes.on('data', (chunk) => { responseData += chunk; });
        tgRes.on('end', () => {
            if (tgRes.statusCode !== 200) {
                console.error(`Telegram send failed with status ${tgRes.statusCode}: ${responseData}`);
            } else {
                console.log(`Telegram message sent to ${chatId}: ${message}`);
            }
        });
    });
    tgReq.on('error', (error) => console.error('Telegram send error:', error.message));
    tgReq.write(data);
    tgReq.end();
}
// Function to send Email notification
async function sendEmailNotification(email, subject, message) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: subject,
            text: message
        });
        console.log(`Email sent to ${email}: ${subject}`);
    } catch (error) {
        console.error('Email send error:', error.message);
    }
}
// Function to log transaction history
async function logTransaction(user, action, tableName, recordId, modifiedBy) {
    const modifiedAt = new Date().toISOString();
    try {
        await dbRun(
            'INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
            [user, action, tableName, recordId, modifiedBy, modifiedAt]
        );
        console.log(`Transaction logged: ${action} on ${tableName} for user ${user}`);
    } catch (error) {
        console.error('Error logging transaction:', error.message);
    }
}
// Login endpoint
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        console.error('Login failed: Username or password missing');
        return res.status(400).json({ success: false, message: 'Username and password required.' });
    }
    try {
        const row = await dbQuery('SELECT * FROM users WHERE username = ?', [username]);
        if (!row) {
            console.error('Login failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        const match = await bcrypt.compare(password, row.password);
        if (!match) {
            console.error('Authentication failed for user:', username);
            return res.status(401).json({ success: false, message: 'Authentication failed: Incorrect password.' });
        }
        // Update last active time
        await dbRun('UPDATE users SET lastActive = ? WHERE username = ?', [new Date().toISOString(), username]);
        await logTransaction(username, 'LOGIN', 'users', null, username);
        console.log('Authenticated user:', username);
        // Check if 2FA is enabled
        if (row.twofa_secret) {
            return res.json({ success: true, requires2FA: true, username: row.username });
        }
        res.json({
            success: true,
            username: row.username,
            firstName: row.firstName || '',
            lastName: row.lastName || '',
            displayName: row.displayName || row.username,
            bio: row.bio || '',
            pronouns: row.pronouns || '',
            profilePicUrl: row.profilePicUrl || 'https://placehold.co/50x50/808080/FFFFFF?text=U',
            email: row.email || '',
            phone: row.phone || '',
            address: row.address || '',
            eventColor: row.eventColor || '#2dd4bf',
            isAdmin: !!row.isAdmin,
            gender: row.gender || '',
            telegram_chat_id: row.telegram_chat_id || '',
            theme: row.theme || 'dark',
            activityStatus: !!row.activityStatus,
            lastActive: row.lastActive || ''
        });
    } catch (error) {
        console.error('Error during login:', error.message);
        res.status(500).json({ success: false, message: 'Server error during login.', error: error.message });
    }
});
// Get users endpoint
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const rows = await dbAll('SELECT username, firstName, lastName, displayName, isAdmin, activityStatus, lastActive FROM users', []);
        console.log('Users fetched:', rows);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('Database error fetching users:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching users.', error: error.message });
    }
});
// Add user endpoint
app.post('/api/add-user', requireAdmin, async (req, res) => {
    const { username, password, firstName, lastName, displayName } = req.body;
    if (!username || !password) {
        console.error('Add user failed: Username or password missing');
        return res.status(400).json({ success: false, message: 'Username and password required.' });
    }
    try {
        const existingUser = await dbQuery('SELECT username FROM users WHERE username = ?', [username]);
        if (existingUser) {
            console.error('Add user failed: User already exists:', username);
            return res.status(400).json({ success: false, message: 'User already exists.' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        await dbRun('INSERT INTO users (username, password, firstName, lastName, displayName, isAdmin) VALUES (?, ?, ?, ?, ?, ?)', [username, hashedPassword, firstName || null, lastName || null, displayName || username, 0]);
        await logTransaction(username, 'CREATE', 'users', null, req.adminUsername);
        console.log(`User ${username} added by ${req.adminUsername}`);
        sendTelegramMessage(GROUP_CHAT_ID, `New user added: ${username} by ${req.adminUsername}`);
        res.json({ success: true, message: 'User added successfully!' });
    } catch (error) {
        console.error('Error adding user:', error.message);
        res.status(500).json({ success: false, message: 'Server error adding user.', error: error.message });
    }
});
// Get access list endpoint
app.get('/api/get-access', async (req, res) => {
    const { viewer, adminUsername } = req.query;
    try {
        let rows;
        if (adminUsername) {
            const adminRow = await dbQuery('SELECT isAdmin FROM users WHERE username = ?', [adminUsername]);
            if (adminRow && adminRow.isAdmin) {
                rows = await dbAll('SELECT viewer, target FROM access', []);
            } else {
                if (!viewer) {
                    console.error('Get access failed: Viewer required if not admin');
                    return res.status(400).json({ success: false, message: 'Viewer required if not admin.' });
                }
                rows = await dbAll('SELECT viewer, target FROM access WHERE viewer = ?', [viewer]);
            }
        } else {
            if (!viewer) {
                console.error('Get access failed: Viewer or adminUsername required');
                return res.status(400).json({ success: false, message: 'Viewer or adminUsername required.' });
            }
            rows = await dbAll('SELECT viewer, target FROM access WHERE viewer = ?', [viewer]);
        }
        console.log(`Access list fetched${adminUsername ? ` by ${adminUsername}` : ''}:`, rows);
        res.json({ success: true, accessList: rows });
    } catch (error) {
        console.error('Error fetching access list:', error.message);
        res.status(500).json({ success: false, message: 'Server error fetching access list.', error: error.message });
    }
});
// Grant access endpoint (bidirectional)
app.post('/api/grant-access', requireAdmin, async (req, res) => {
    const { viewer, target } = req.body;
    if (!viewer || !target) {
        console.error('Grant access failed: Viewer or target missing');
        return res.status(400).json({ success: false, message: 'Viewer and target usernames required.' });
    }
    if (viewer === target) {
        console.error('Grant access failed: Cannot share access with self');
        return res.status(400).json({ success: false, message: 'Cannot share access with self.' });
    }
    try {
        const viewerRow = await dbQuery('SELECT username FROM users WHERE username = ?', [viewer]);
        if (!viewerRow) {
            console.error('Grant access failed: Viewer not found:', viewer);
            return res.status(404).json({ success: false, message: 'Viewer not found.' });
        }
        const targetRow = await dbQuery('SELECT username FROM users WHERE username = ?', [target]);
        if (!targetRow) {
            console.error('Grant access failed: Target not found:', target);
            return res.status(404).json({ success: false, message: 'Target not found.' });
        }
        const existingAB = await dbQuery('SELECT viewer, target FROM access WHERE viewer = ? AND target = ?', [viewer, target]);
        const existingBA = await dbQuery('SELECT viewer, target FROM access WHERE viewer = ? AND target = ?', [target, viewer]);
        if (existingAB && existingBA) {
            console.error('Grant access failed: Access already shared between', viewer, 'and', target);
            return res.status(400).json({ success: false, message: 'Access already shared.' });
        }
        await dbTransaction([
            !existingAB ? dbRun('INSERT INTO access (viewer, target) VALUES (?, ?)', [viewer, target]) : Promise.resolve(),
            !existingBA ? dbRun('INSERT INTO access (viewer, target) VALUES (?, ?)', [target, viewer]) : Promise.resolve(),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [viewer, 'GRANT_ACCESS', 'access', null, req.adminUsername, new Date().toISOString()]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [target, 'GRANT_ACCESS', 'access', null, req.adminUsername, new Date().toISOString()])
        ]);
        console.log(`Access shared between ${viewer} and ${target} by ${req.adminUsername}`);
        sendTelegramMessage(GROUP_CHAT_ID, `Access granted between ${viewer} and ${target} by ${req.adminUsername}`);
        res.json({ success: true, message: `Access shared between ${viewer} and ${target}.` });
    } catch (error) {
        console.error('Error sharing access:', error.message);
        res.status(500).json({ success: false, message: 'Server error sharing access.', error: error.message });
    }
});
// Revoke access endpoint (bidirectional)
app.post('/api/revoke-access', requireAdmin, async (req, res) => {
    const { viewer, target } = req.body;
    if (!viewer || !target) {
        console.error('Revoke access failed: Viewer or target missing');
        return res.status(400).json({ success: false, message: 'Viewer and target usernames required.' });
    }
    try {
        const existingAB = await dbQuery('SELECT viewer, target FROM access WHERE viewer = ? AND target = ?', [viewer, target]);
        const existingBA = await dbQuery('SELECT viewer, target FROM access WHERE viewer = ? AND target = ?', [target, viewer]);
        if (!existingAB && !existingBA) {
            console.error('Revoke access failed: No access sharing found');
            return res.status(400).json({ success: false, message: 'No access sharing found.' });
        }
        await dbTransaction([
            existingAB ? dbRun('DELETE FROM access WHERE viewer = ? AND target = ?', [viewer, target]) : Promise.resolve(),
            existingBA ? dbRun('DELETE FROM access WHERE viewer = ? AND target = ?', [target, viewer]) : Promise.resolve(),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [viewer, 'REVOKE_ACCESS', 'access', null, req.adminUsername, new Date().toISOString()]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [target, 'REVOKE_ACCESS', 'access', null, req.adminUsername, new Date().toISOString()])
        ]);
        console.log(`Access sharing revoked between ${viewer} and ${target} by ${req.adminUsername}`);
        sendTelegramMessage(GROUP_CHAT_ID, `Access revoked between ${viewer} and ${target} by ${req.adminUsername}`);
        res.json({ success: true, message: `Access sharing revoked between ${viewer} and ${target}.` });
    } catch (error) {
        console.error('Error revoking access sharing:', error.message);
        res.status(500).json({ success: false, message: 'Server error revoking access sharing.', error: error.message });
    }
});
// Update profile endpoint
app.post('/api/profile-pictures', async (req, res) => {
    const { username, firstName, lastName, profilePicUrl, email, phone, address, eventColor, gender, telegram_chat_id, displayName, bio, pronouns, theme, activityStatus } = req.body;
    if (!username) {
        console.error('Update profile failed: Username missing');
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    console.log('Received profile update request:', req.body);
    try {
        const userExists = await dbQuery('SELECT username FROM users WHERE username = ?', [username]);
        if (!userExists) {
            console.error('Update profile failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        // Validate inputs
        if (firstName && firstName.length > 50) {
            console.error('Update profile failed: First name too long');
            return res.status(400).json({ success: false, message: 'First name must be 50 characters or less.' });
        }
        if (lastName && lastName.length > 50) {
            console.error('Update profile failed: Last name too long');
            return res.status(400).json({ success: false, message: 'Last name must be 50 characters or less.' });
        }
        const result = await dbRun(
            'UPDATE users SET firstName = ?, lastName = ?, profilePicUrl = ?, email = ?, phone = ?, address = ?, eventColor = ?, gender = ?, telegram_chat_id = ?, displayName = ?, bio = ?, pronouns = ?, theme = ?, activityStatus = ?, lastActive = ? WHERE username = ?',
            [firstName || null, lastName || null, profilePicUrl || null, email || null, phone || null, address || null, eventColor || '#2dd4bf', gender || null, telegram_chat_id || null, displayName || username, bio || null, pronouns || null, theme || 'dark', activityStatus ? 1 : 0, new Date().toISOString(), username]
        );
        if (result.changes === 0) {
            console.error('Update profile failed: No rows affected for user:', username);
            return res.status(500).json({ success: false, message: 'Failed to update profile: No changes applied.' });
        }
        await logTransaction(username, 'UPDATE_PROFILE', 'users', null, username);
        // Fetch and return the updated user data
        const updatedUser = await dbQuery(
            'SELECT firstName, lastName, profilePicUrl, email, phone, address, eventColor, gender, telegram_chat_id, displayName, bio, pronouns, theme, activityStatus, lastActive, isAdmin FROM users WHERE username = ?',
            [username]
        );
        console.log('Profile updated successfully:', updatedUser);
        res.json({
            success: true,
            username: username,
            firstName: updatedUser.firstName || '',
            lastName: updatedUser.lastName || '',
            profilePicUrl: updatedUser.profilePicUrl || 'https://placehold.co/50x50/808080/FFFFFF?text=U',
            email: updatedUser.email || '',
            phone: updatedUser.phone || '',
            address: updatedUser.address || '',
            eventColor: updatedUser.eventColor || '#2dd4bf',
            gender: updatedUser.gender || '',
            telegram_chat_id: updatedUser.telegram_chat_id || '',
            displayName: updatedUser.displayName || username,
            bio: updatedUser.bio || '',
            pronouns: updatedUser.pronouns || '',
            theme: updatedUser.theme || 'dark',
            activityStatus: !!updatedUser.activityStatus,
            isAdmin: !!updatedUser.isAdmin,
            lastActive: updatedUser.lastActive || ''
        });
    } catch (error) {
        console.error('Database error updating profile:', error.message);
        res.status(500).json({ success: false, message: 'Database error updating profile.', error: error.message });
    }
});
// Get profile endpoint
app.get('/api/profile-pictures', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        console.error('Get profile failed: Username missing');
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    try {
        const row = await dbQuery('SELECT firstName, lastName, profilePicUrl, email, phone, address, eventColor, isAdmin, gender, telegram_chat_id, displayName, bio, pronouns, theme, activityStatus, lastActive FROM users WHERE username = ?', [username]);
        if (!row) {
            console.error('Get profile failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        console.log('Profile fetched:', row);
        res.json({
            success: true,
            firstName: row.firstName || '',
            lastName: row.lastName || '',
            profilePicUrl: row.profilePicUrl || 'https://placehold.co/50x50/808080/FFFFFF?text=U',
            email: row.email || '',
            phone: row.phone || '',
            address: row.address || '',
            eventColor: row.eventColor || '#2dd4bf',
            isAdmin: !!row.isAdmin,
            gender: row.gender || '',
            telegram_chat_id: row.telegram_chat_id || '',
            displayName: row.displayName || username,
            bio: row.bio || '',
            pronouns: row.pronouns || '',
            theme: row.theme || 'dark',
            activityStatus: !!row.activityStatus,
            lastActive: row.lastActive || ''
        });
    } catch (error) {
        console.error('Database error fetching profile:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching profile.', error: error.message });
    }
});
// Update notification preferences endpoint
app.post('/api/notifications', async (req, res) => {
    const { username, type, enabled } = req.body;
    if (!username || !type || enabled === undefined) {
        console.error('Update notification failed: Missing required fields');
        return res.status(400).json({ success: false, message: 'Username, type, and enabled status required.' });
    }
    if (!['telegram', 'email'].includes(type)) {
        console.error('Update notification failed: Invalid type:', type);
        return res.status(400).json({ success: false, message: 'Invalid notification type.' });
    }
    try {
        const existing = await dbQuery('SELECT id FROM notifications WHERE user = ? AND type = ?', [username, type]);
        if (existing) {
            await dbRun('UPDATE notifications SET enabled = ? WHERE user = ? AND type = ?', [enabled ? 1 : 0, username, type]);
        } else {
            await dbRun('INSERT INTO notifications (user, type, enabled) VALUES (?, ?, ?)', [username, type, enabled ? 1 : 0]);
        }
        await logTransaction(username, 'UPDATE_NOTIFICATION', 'notifications', existing?.id, username);
        console.log(`Notification preference updated: ${type} = ${enabled} for ${username}`);
        res.json({ success: true, message: 'Notification preference updated successfully!' });
    } catch (error) {
        console.error('Database error updating notification preference:', error.message);
        res.status(500).json({ success: false, message: 'Database error updating notification preference.', error: error.message });
    }
});
// Get notification preferences endpoint
app.get('/api/notifications', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        console.error('Get notifications failed: Username missing');
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    try {
        const rows = await dbAll('SELECT type, enabled FROM notifications WHERE user = ?', [username]);
        console.log('Notifications fetched for user:', username, rows);
        res.json({ success: true, notifications: rows });
    } catch (error) {
        console.error('Database error fetching notification preferences:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching notification preferences.', error: error.message });
    }
});
// Get transaction history endpoint
app.get('/api/transaction-history', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        console.error('Get transaction history failed: Username missing');
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    try {
        const rows = await dbAll('SELECT id, action, tableName, recordId, modifiedBy, modifiedAt FROM transaction_history WHERE user = ? ORDER BY modifiedAt DESC', [username]);
        console.log('Transaction history fetched for user:', username, rows);
        res.json({ success: true, transactions: rows });
    } catch (error) {
        console.error('Database error fetching transaction history:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching transaction history.', error: error.message });
    }
});
// Delete account endpoint
app.delete('/api/account', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        console.error('Delete account failed: Username or password missing');
        return res.status(400).json({ success: false, message: 'Username and password required.' });
    }
    try {
        const user = await dbQuery('SELECT password FROM users WHERE username = ?', [username]);
        if (!user) {
            console.error('Delete account failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            console.error('Delete account failed: Incorrect password for user:', username);
            return res.status(401).json({ success: false, message: 'Incorrect password.' });
        }
        await dbRun('DELETE FROM users WHERE username = ?', [username]);
        await logTransaction(username, 'DELETE_ACCOUNT', 'users', null, username);
        console.log(`User ${username} deleted their account`);
        sendTelegramMessage(GROUP_CHAT_ID, `User ${username} deleted their account`);
        res.json({ success: true, message: 'Account deleted successfully!' });
    } catch (error) {
        console.error('Error deleting account:', error.message);
        res.status(500).json({ success: false, message: 'Server error deleting account.', error: error.message });
    }
});
// Get user color endpoint
app.get('/api/user-color', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        console.error('Get user color failed: Username missing');
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    try {
        const row = await dbQuery('SELECT eventColor FROM users WHERE username = ?', [username]);
        if (!row) {
            console.error('Get user color failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        res.json({ success: true, eventColor: row.eventColor || '#2dd4bf' });
    } catch (error) {
        console.error('Database error fetching user color:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching user color.', error: error.message });
    }
});
// Grant admin endpoint
app.post('/api/grant-admin', requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) {
        console.error('Grant admin failed: Username missing');
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    try {
        const row = await dbQuery('SELECT isAdmin FROM users WHERE username = ?', [username]);
        if (!row) {
            console.error('Grant admin failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        if (row.isAdmin) {
            console.error('Grant admin failed: User is already an admin:', username);
            return res.status(400).json({ success: false, message: 'User is already an admin.' });
        }
        await dbRun('UPDATE users SET isAdmin = 1 WHERE username = ?', [username]);
        await logTransaction(username, 'GRANT_ADMIN', 'users', null, req.adminUsername);
        console.log(`Admin access granted for ${username} by ${req.adminUsername}`);
        sendTelegramMessage(GROUP_CHAT_ID, `Admin access granted for ${username} by ${req.adminUsername}`);
        res.json({ success: true, message: `Admin access granted for ${username}!` });
    } catch (error) {
        console.error('Error granting admin access:', error.message);
        res.status(500).json({ success: false, message: 'Server error granting admin access.', error: error.message });
    }
});
// Revoke admin endpoint
app.post('/api/revoke-admin', requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) {
        console.error('Revoke admin failed: Username missing');
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    try {
        const row = await dbQuery('SELECT isAdmin FROM users WHERE username = ?', [username]);
        if (!row) {
            console.error('Revoke admin failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        if (!row.isAdmin) {
            console.error('Revoke admin failed: User is not an admin:', username);
            return res.status(400).json({ success: false, message: 'User is not an admin.' });
        }
        await dbRun('UPDATE users SET isAdmin = 0 WHERE username = ?', [username]);
        await logTransaction(username, 'REVOKE_ADMIN', 'users', null, req.adminUsername);
        console.log(`Admin access revoked for ${username} by ${req.adminUsername}`);
        sendTelegramMessage(GROUP_CHAT_ID, `Admin access revoked for ${username} by ${req.adminUsername}`);
        res.json({ success: true, message: `Admin access revoked for ${username}!` });
    } catch (error) {
        console.error('Error revoking admin access:', error.message);
        res.status(500).json({ success: false, message: 'Server error revoking admin access.', error: error.message });
    }
});
// Admin update password endpoint
app.post('/api/admin-update-password', requireAdmin, async (req, res) => {
    const { username, newPassword } = req.body;
    if (!username || !newPassword) {
        console.error('Admin update password failed: Username or new password missing');
        return res.status(400).json({ success: false, message: 'Username and new password required.' });
    }
    try {
        const row = await dbQuery('SELECT username FROM users WHERE username = ?', [username]);
        if (!row) {
            console.error('Admin update password failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbRun('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, username]);
        await logTransaction(username, 'UPDATE_PASSWORD', 'users', null, req.adminUsername);
        console.log(`Password updated for ${username} by ${req.adminUsername}`);
        sendTelegramMessage(GROUP_CHAT_ID, `Password updated for ${username} by ${req.adminUsername}`);
        res.json({ success: true, message: `Password updated for ${username}!` });
    } catch (error) {
        console.error('Error updating password:', error.message);
        res.status(500).json({ success: false, message: 'Server error updating password.', error: error.message });
    }
});
// User update password endpoint
app.post('/api/update-password', async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    if (!username || !currentPassword || !newPassword) {
        console.error('Update password failed: Missing required fields');
        return res.status(400).json({ success: false, message: 'Username, current password, and new password required.' });
    }
    try {
        const user = await dbQuery('SELECT password FROM users WHERE username = ?', [username]);
        if (!user) {
            console.error('Update password failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        const match = await bcrypt.compare(currentPassword, user.password);
        if (!match) {
            console.error('Update password failed: Incorrect current password for user:', username);
            return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
        }
        if (newPassword.length < 6) {
            console.error('Update password failed: New password too short');
            return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
        }
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await dbRun('UPDATE users SET password = ? WHERE username = ?', [hashedPassword, username]);
        await logTransaction(username, 'UPDATE_PASSWORD', 'users', null, username);
        console.log(`Password updated for user: ${username}`);
        res.json({ success: true, message: 'Password updated successfully!' });
    } catch (error) {
        console.error('Error updating password:', error.message);
        res.status(500).json({ success: false, message: 'Server error updating password.', error: error.message });
    }
});
// Delete user endpoint
app.delete('/api/delete-user/:username', requireAdmin, async (req, res) => {
    const { username } = req.params;
    if (!username) {
        console.error('Delete user failed: Username missing');
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    try {
        const row = await dbQuery('SELECT username FROM users WHERE username = ?', [username]);
        if (!row) {
            console.error('Delete user failed: User not found:', username);
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        await dbRun('DELETE FROM users WHERE username = ?', [username]);
        await logTransaction(username, 'DELETE_USER', 'users', null, req.adminUsername);
        console.log(`User ${username} deleted by ${req.adminUsername}`);
        sendTelegramMessage(GROUP_CHAT_ID, `User ${username} deleted by ${req.adminUsername}`);
        res.json({ success: true, message: 'User deleted successfully!' });
    } catch (error) {
        console.error('Error deleting user:', error.message);
        res.status(500).json({ success: false, message: 'Server error deleting user.', error: error.message });
    }
});
// Financial data endpoints
app.get('/api/financial', async (req, res) => {
    const { user } = req.query;
    if (!user) {
        console.error('Get financial failed: User missing');
        return res.status(400).json({ success: false, message: 'User required.' });
    }
    try {
        const rows = await dbAll('SELECT * FROM financial WHERE user = ?', [user]);
        console.log('Financial items fetched for user:', user, rows);
        res.json(rows);
    } catch (error) {
        console.error('Database error fetching financial items:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching financial items.', error: error.message });
    }
});
app.post('/api/financial', async (req, res) => {
    const { user, category, amount, type, date } = req.body;
    if (!user || !category || !amount || !type || !date) {
        console.error('Add financial failed: Missing fields');
        return res.status(400).json({ success: false, message: 'All fields required.' });
    }
    if (!['income', 'expense'].includes(type)) {
        console.error('Add financial failed: Invalid type:', type);
        return res.status(400).json({ success: false, message: 'Invalid type: must be "income" or "expense".' });
    }
    if (isNaN(amount) || amount < 0) {
        console.error('Add financial failed: Invalid amount:', amount);
        return res.status(400).json({ success: false, message: 'Amount must be a non-negative number.' });
    }
    try {
        const financialResult = await dbRun('INSERT INTO financial (user, category, amount, type, date) VALUES (?, ?, ?, ?, ?)', [user, category, amount, type, date]);
        const calendarResult = await dbRun('INSERT INTO calendar (user, title, date, financial, type, amount, eventColor) VALUES (?, ?, ?, ?, ?, ?, ?)',
                  [user, `${category} (${type})`, date, 1, type, amount, req.body.eventColor || '#2dd4bf']);
        await logTransaction(user, 'CREATE', 'financial', financialResult.lastID, user);
        const userData = await dbQuery('SELECT telegram_chat_id, email FROM users WHERE username = ?', [user]);
        const notifications = await dbAll('SELECT type, enabled FROM notifications WHERE user = ?', [user]);
        const message = `New financial transaction added: ${category} (${type}) - ${amount} on ${date}`;
        if (notifications.some(n => n.type === 'telegram' && n.enabled) && userData.telegram_chat_id) {
            sendTelegramMessage(userData.telegram_chat_id, message);
        }
        if (notifications.some(n => n.type === 'email' && n.enabled) && userData.email) {
            await sendEmailNotification(userData.email, 'New Financial Transaction', message);
        }
        res.json({ success: true, message: 'Financial item added successfully!' });
    } catch (error) {
        console.error('Database error adding financial item:', error.message);
        res.status(500).json({ success: false, message: 'Database error adding financial item.', error: error.message });
    }
});
app.put('/api/financial/:id', async (req, res) => {
    const { id } = req.params;
    const { user, category, amount, type, date } = req.body;
    if (!user || !category || !amount || !type || !date) {
        console.error('Update financial failed: Missing fields');
        return res.status(400).json({ success: false, message: 'All fields required.' });
    }
    if (!['income', 'expense'].includes(type)) {
        console.error('Update financial failed: Invalid type:', type);
        return res.status(400).json({ success: false, message: 'Invalid type: must be "income" or "expense".' });
    }
    if (isNaN(amount) || amount < 0) {
        console.error('Update financial failed: Invalid amount:', amount);
        return res.status(400).json({ success: false, message: 'Amount must be a non-negative number.' });
    }
    try {
        const row = await dbQuery('SELECT id FROM financial WHERE id = ? AND user = ?', [id, user]);
        if (!row) {
            console.error('Update financial failed: Item not found or not owned by user:', id, user);
            return res.status(404).json({ success: false, message: 'Financial item not found or not owned by user.' });
        }
        await dbTransaction([
            dbRun('UPDATE financial SET category = ?, amount = ?, type = ?, date = ? WHERE id = ?', [category, amount, type, date, id]),
            dbRun('UPDATE calendar SET title = ?, date = ?, type = ?, amount = ? WHERE financial = 1 AND user = ? AND amount = (SELECT amount FROM financial WHERE id = ?)',
                  [`${category} (${type})`, date, type, amount, user, id]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [user, 'UPDATE', 'financial', id, user, new Date().toISOString()])
        ]);
        const userData = await dbQuery('SELECT telegram_chat_id, email FROM users WHERE username = ?', [user]);
        const notifications = await dbAll('SELECT type, enabled FROM notifications WHERE user = ?', [user]);
        const message = `Financial transaction updated: ${category} (${type}) - ${amount} on ${date}`;
        if (notifications.some(n => n.type === 'telegram' && n.enabled) && userData.telegram_chat_id) {
            sendTelegramMessage(userData.telegram_chat_id, message);
        }
        if (notifications.some(n => n.type === 'email' && n.enabled) && userData.email) {
            await sendEmailNotification(userData.email, 'Financial Transaction Updated', message);
        }
        res.json({ success: true, message: 'Financial item updated successfully!' });
    } catch (error) {
        console.error('Database error updating financial item:', error.message);
        res.status(500).json({ success: false, message: 'Database error updating financial item.', error: error.message });
    }
});
app.delete('/api/financial/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, user, amount, type, date, category FROM financial WHERE id = ?', [id]);
        if (!row) {
            console.error('Delete financial failed: Item not found:', id);
            return res.status(404).json({ success: false, message: 'Financial item not found.' });
        }
        await dbTransaction([
            dbRun('DELETE FROM financial WHERE id = ?', [id]),
            dbRun('DELETE FROM calendar WHERE financial = 1 AND user = ? AND amount = ? AND type = ? AND date = ?',
                  [row.user, row.amount, row.type, row.date]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [row.user, 'DELETE', 'financial', id, row.user, new Date().toISOString()])
        ]);
        const userData = await dbQuery('SELECT telegram_chat_id, email FROM users WHERE username = ?', [row.user]);
        const notifications = await dbAll('SELECT type, enabled FROM notifications WHERE user = ?', [row.user]);
        const message = `Financial transaction deleted: ${row.category} (${row.type}) - ${row.amount} on ${row.date}`;
        if (notifications.some(n => n.type === 'telegram' && n.enabled) && userData.telegram_chat_id) {
            sendTelegramMessage(userData.telegram_chat_id, message);
        }
        if (notifications.some(n => n.type === 'email' && n.enabled) && userData.email) {
            await sendEmailNotification(userData.email, 'Financial Transaction Deleted', message);
        }
        res.json({ success: true, message: 'Financial item deleted successfully!' });
    } catch (error) {
        console.error('Database error deleting financial item:', error.message);
        res.status(500).json({ success: false, message: 'Database error deleting financial item.', error: error.message });
    }
});
// Budget data endpoints
app.get('/api/budget', async (req, res) => {
    const { user } = req.query;
    if (!user) {
        console.error('Get budget failed: User missing');
        return res.status(400).json({ success: false, message: 'User required.' });
    }
    try {
        const rows = await dbAll('SELECT * FROM budget WHERE user = ?', [user]);
        res.json(rows);
    } catch (error) {
        console.error('Database error fetching budget items:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching budget items.', error: error.message });
    }
});
app.post('/api/budget', async (req, res) => {
    const { user, income, expenses, date } = req.body;
    if (!user || !income || !expenses || !date) {
        console.error('Add budget failed: Missing fields');
        return res.status(400).json({ success: false, message: 'All fields required.' });
    }
    if (isNaN(income) || income < 0) {
        console.error('Add budget failed: Invalid income:', income);
        return res.status(400).json({ success: false, message: 'Income must be a non-negative number.' });
    }
    try {
        JSON.parse(expenses); // Validate JSON
    } catch (error) {
        console.error('Add budget failed: Invalid expenses JSON');
        return res.status(400).json({ success: false, message: 'Invalid expenses JSON format.' });
    }
    try {
        const result = await dbRun('INSERT INTO budget (user, income, expenses, date) VALUES (?, ?, ?, ?)', [user, income, expenses, date]);
        await logTransaction(user, 'CREATE', 'budget', result.lastID, user);
        res.json({ success: true, message: 'Budget item added successfully!' });
    } catch (error) {
        console.error('Database error adding budget item:', error.message);
        res.status(500).json({ success: false, message: 'Database error adding budget item.', error: error.message });
    }
});
app.put('/api/budget/:id', async (req, res) => {
    const { id } = req.params;
    const { user, income, expenses, date } = req.body;
    if (!user || !income || !expenses || !date) {
        console.error('Update budget failed: Missing fields');
        return res.status(400).json({ success: false, message: 'All fields required.' });
    }
    if (isNaN(income) || income < 0) {
        console.error('Update budget failed: Invalid income:', income);
        return res.status(400).json({ success: false, message: 'Income must be a non-negative number.' });
    }
    try {
        JSON.parse(expenses); // Validate JSON
    } catch (error) {
        console.error('Update budget failed: Invalid expenses JSON');
        return res.status(400).json({ success: false, message: 'Invalid expenses JSON format.' });
    }
    try {
        const row = await dbQuery('SELECT id FROM budget WHERE id = ? AND user = ?', [id, user]);
        if (!row) {
            console.error('Update budget failed: Budget not found or not owned by user:', id, user);
            return res.status(404).json({ success: false, message: 'Budget not found or not owned by user.' });
        }
        await dbTransaction([
            dbRun('UPDATE budget SET income = ?, expenses = ?, date = ? WHERE id = ?', [income, expenses, date, id]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [user, 'UPDATE', 'budget', id, user, new Date().toISOString()])
        ]);
        res.json({ success: true, message: 'Budget item updated successfully!' });
    } catch (error) {
        console.error('Database error updating budget item:', error.message);
        res.status(500).json({ success: false, message: 'Database error updating budget item.', error: error.message });
    }
});
app.delete('/api/budget/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, user FROM budget WHERE id = ?', [id]);
        if (!row) {
            console.error('Delete budget failed: Budget not found:', id);
            return res.status(404).json({ success: false, message: 'Budget not found.' });
        }
        await dbTransaction([
            dbRun('DELETE FROM budget WHERE id = ?', [id]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [row.user, 'DELETE', 'budget', id, row.user, new Date().toISOString()])
        ]);
        res.json({ success: true, message: 'Budget item deleted successfully!' });
    } catch (error) {
        console.error('Database error deleting budget item:', error.message);
        res.status(500).json({ success: false, message: 'Database error deleting budget item.', error: error.message });
    }
});
// Period data endpoints
app.get('/api/period', async (req, res) => {
    const { user } = req.query;
    if (!user) {
        console.error('Get period failed: User missing');
        return res.status(400).json({ success: false, message: 'User required.' });
    }
    try {
        const rows = await dbAll('SELECT * FROM period WHERE user = ?', [user]);
        res.json(rows);
    } catch (error) {
        console.error('Database error fetching period items:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching period items.', error: error.message });
    }
});
app.post('/api/period', async (req, res) => {
    const { user, startDate, endDate, cycleLength, symptoms, date } = req.body;
    if (!user || !startDate || !cycleLength || !date) {
        console.error('Add period failed: Required fields missing');
        return res.status(400).json({ success: false, message: 'Required fields missing.' });
    }
    try {
        const result = await dbRun('INSERT INTO period (user, startDate, endDate, cycleLength, symptoms, date) VALUES (?, ?, ?, ?, ?, ?)',
                    [user, startDate, endDate, cycleLength, symptoms, date]);
        await logTransaction(user, 'CREATE', 'period', result.lastID, user);
        res.json({ success: true, message: 'Period cycle added successfully!' });
    } catch (error) {
        console.error('Database error adding period cycle:', error.message);
        res.status(500).json({ success: false, message: 'Database error adding period cycle.', error: error.message });
    }
});
app.delete('/api/period/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, user FROM period WHERE id = ?', [id]);
        if (!row) {
            console.error('Delete period failed: Period cycle not found:', id);
            return res.status(404).json({ success: false, message: 'Period cycle not found.' });
        }
        await dbTransaction([
            dbRun('DELETE FROM period WHERE id = ?', [id]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [row.user, 'DELETE', 'period', id, row.user, new Date().toISOString()])
        ]);
        res.json({ success: true, message: 'Period cycle deleted successfully!' });
    } catch (error) {
        console.error('Database error deleting period cycle:', error.message);
        res.status(500).json({ success: false, message: 'Database error deleting period cycle.', error: error.message });
    }
});
// Calendar endpoints
app.get('/api/calendar', async (req, res) => {
    const { user } = req.query;
    if (!user) {
        console.error('Get calendar failed: User missing');
        return res.status(400).json({ success: false, message: 'User required.' });
    }
    try {
        const rows = await dbAll('SELECT * FROM calendar WHERE user = ?', [user]);
        res.json(rows);
    } catch (error) {
        console.error('Database error fetching calendar events:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching calendar events.', error: error.message });
    }
});
app.post('/api/calendar', async (req, res) => {
    const { user, title, date, financial, type, amount, eventColor } = req.body;
    if (!user || !title || !date) {
        console.error('Add calendar failed: Missing required fields');
        return res.status(400).json({ success: false, message: 'User, title, and date required.' });
    }
    try {
        const result = await dbRun('INSERT INTO calendar (user, title, date, financial, type, amount, eventColor) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [user, title, date, financial, type, amount, eventColor]);
        await logTransaction(user, 'CREATE', 'calendar', result.lastID, user);
        const userData = await dbQuery('SELECT telegram_chat_id, email FROM users WHERE username = ?', [user]);
        const notifications = await dbAll('SELECT type, enabled FROM notifications WHERE user = ?', [user]);
        const message = `New event added: ${title} on ${date}`;
        if (notifications.some(n => n.type === 'telegram' && n.enabled) && userData.telegram_chat_id) {
            sendTelegramMessage(userData.telegram_chat_id, message);
        }
        if (notifications.some(n => n.type === 'email' && n.enabled) && userData.email) {
            await sendEmailNotification(userData.email, 'New Calendar Event', message);
        }
        res.json({ success: true, message: 'Calendar event added successfully!' });
    } catch (error) {
        console.error('Database error adding calendar event:', error.message);
        res.status(500).json({ success: false, message: 'Database error adding calendar event.', error: error.message });
    }
});
app.delete('/api/calendar/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, user FROM calendar WHERE id = ?', [id]);
        if (!row) {
            console.error('Delete calendar failed: Event not found:', id);
            return res.status(404).json({ success: false, message: 'Calendar event not found.' });
        }
        await dbTransaction([
            dbRun('DELETE FROM calendar WHERE id = ?', [id]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [row.user, 'DELETE', 'calendar', id, row.user, new Date().toISOString()])
        ]);
        res.json({ success: true, message: 'Calendar event deleted successfully!' });
    } catch (error) {
        console.error('Database error deleting calendar event:', error.message);
        res.status(500).json({ success: false, message: 'Database error deleting calendar event.', error: error.message });
    }
});
// Gym workout endpoints
app.get('/api/gymworkout', async (req, res) => {
    const { user } = req.query;
    if (!user) {
        console.error('Get gymworkout failed: User missing');
        return res.status(400).json({ success: false, message: 'User required.' });
    }
    try {
        const rows = await dbAll('SELECT * FROM gymworkout WHERE user = ?', [user]);
        res.json(rows);
    } catch (error) {
        console.error('Database error fetching gym workouts:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching gym workouts.', error: error.message });
    }
});
app.post('/api/gymworkout', async (req, res) => {
    const { user, day, exercise, sets, reps, weight, date } = req.body;
    if (!user || !day || !exercise || !sets || !reps || !weight || !date) {
        console.error('Add gymworkout failed: Missing fields');
        return res.status(400).json({ success: false, message: 'All fields required.' });
    }
    try {
        const result = await dbRun('INSERT INTO gymworkout (user, day, exercise, sets, reps, weight, date) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [user, day, exercise, sets, reps, weight, date]);
        await logTransaction(user, 'CREATE', 'gymworkout', result.lastID, user);
        res.json({ success: true, message: 'Gym workout added successfully!' });
    } catch (error) {
        console.error('Database error adding gym workout:', error.message);
        res.status(500).json({ success: false, message: 'Database error adding gym workout.', error: error.message });
    }
});
app.delete('/api/gymworkout/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, user FROM gymworkout WHERE id = ?', [id]);
        if (!row) {
            console.error('Delete gymworkout failed: Workout not found:', id);
            return res.status(404).json({ success: false, message: 'Gym workout not found.' });
        }
        await dbTransaction([
            dbRun('DELETE FROM gymworkout WHERE id = ?', [id]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [row.user, 'DELETE', 'gymworkout', id, row.user, new Date().toISOString()])
        ]);
        res.json({ success: true, message: 'Gym workout deleted successfully!' });
    } catch (error) {
        console.error('Database error deleting gym workout:', error.message);
        res.status(500).json({ success: false, message: 'Database error deleting gym workout.', error: error.message });
    }
});
// Meal plan endpoints
app.get('/api/mealplan', async (req, res) => {
    const { user } = req.query;
    if (!user) {
        console.error('Get mealplan failed: User missing');
        return res.status(400).json({ success: false, message: 'User required.' });
    }
    try {
        const rows = await dbAll('SELECT * FROM mealplan WHERE user = ?', [user]);
        res.json(rows);
    } catch (error) {
        console.error('Database error fetching meal plans:', error.message);
        res.status(500).json({ success: false, message: 'Database error fetching meal plans.', error: error.message });
    }
});
app.post('/api/mealplan', async (req, res) => {
    const { user, day, mealType, description, calories, date } = req.body;
    if (!user || !day || !mealType || !description || !calories || !date) {
        console.error('Add mealplan failed: Missing fields');
        return res.status(400).json({ success: false, message: 'All fields required.' });
    }
    try {
        const result = await dbRun('INSERT INTO mealplan (user, day, mealType, description, calories, date) VALUES (?, ?, ?, ?, ?, ?)',
                    [user, day, mealType, description, calories, date]);
        await logTransaction(user, 'CREATE', 'mealplan', result.lastID, user);
        res.json({ success: true, message: 'Meal plan added successfully!' });
    } catch (error) {
        console.error('Database error adding meal plan:', error.message);
        res.status(500).json({ success: false, message: 'Database error adding meal plan.', error: error.message });
    }
});
app.delete('/api/mealplan/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const row = await dbQuery('SELECT id, user FROM mealplan WHERE id = ?', [id]);
        if (!row) {
            console.error('Delete mealplan failed: Meal plan not found:', id);
            return res.status(404).json({ success: false, message: 'Meal plan not found.' });
        }
        await dbTransaction([
            dbRun('DELETE FROM mealplan WHERE id = ?', [id]),
            dbRun('INSERT INTO transaction_history (user, action, tableName, recordId, modifiedBy, modifiedAt) VALUES (?, ?, ?, ?, ?, ?)',
                  [row.user, 'DELETE', 'mealplan', id, row.user, new Date().toISOString()])
        ]);
        res.json({ success: true, message: 'Meal plan deleted successfully!' });
    } catch (error) {
        console.error('Database error deleting meal plan:', error.message);
        res.status(500).json({ success: false, message: 'Database error deleting meal plan.', error: error.message });
    }
});
// Import statement endpoint
app.post('/api/import-statement', async (req, res) => {
    const { user, text } = req.body;
    if (!user || !text) {
        console.error('Import statement failed: User or text missing');
        return res.status(400).json({ success: false, message: 'User and text required.' });
    }
    try {
        // Clean and parse the text
        const lines = text.split('\n').map(l => l.trim()).filter(l => l && !['1 Discovery Place', 'Discovery Bank Limited', 'FSP number', 'Date', 'Description', 'Debit', 'Credit', 'Balance', '<PAGE', 'Total pages', 'Account holder', 'From', 'Account type', 'Account number'].some(start => l.startsWith(start)));
        const transactions = [];
        let i = 0;
        while (i < lines.length) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(lines[i])) {
                const date = lines[i];
                i++;
                if (i >= lines.length) break;
                const description = lines[i];
                i++;
                if (i >= lines.length) break;
                let line = lines[i];
                let amount = 0;
                let balance = 0;
                let balanceStr = '';
                if (line.endsWith('-')) {
                    amount = 0;
                    balanceStr = line.replace('R ', '').replace(/,/g, '').trim();
                    balance = -parseFloat(balanceStr.slice(0, -1));
                } else {
                    amount = parseFloat(line.replace('R ', '').replace(/,/g, '').split(' ')[0].trim());
                    i++;
                    if (i >= lines.length) break;
                    balanceStr = lines[i].replace('R ', '').replace(/,/g, '').trim();
                    balance = balanceStr.endsWith('-') ? -parseFloat(balanceStr.slice(0, -1)) : parseFloat(balanceStr);
                }
                transactions.push({ date, description, amount, balance });
                i++;
            } else {
                i++;
            }
        }
        // Determine type (income/expense) based on balance change
        let previousBalance = null;
        for (let tx of transactions) {
            if (previousBalance === null) {
                tx.type = tx.amount > 0 ? 'expense' : 'unknown';
                previousBalance = tx.balance;
            } else {
                const debitBalance = previousBalance - tx.amount;
                const creditBalance = previousBalance + tx.amount;
                if (Math.abs(debitBalance - tx.balance) < 0.01) {
                    tx.type = 'expense';
                } else if (Math.abs(creditBalance - tx.balance) < 0.01) {
                    tx.type = 'income';
                } else {
                    tx.type = 'unknown';
                }
                previousBalance = tx.balance;
            }
        }
        // Filter valid transactions
        transactions = transactions.filter(tx => tx.amount > 0 && tx.type !== 'unknown');
        // Categorize based on keywords
        const categoryKeywords = {
            'Food & Dining': ['CAFE', 'GALITOS', 'MILKY LANE', 'KAUAI', 'BILTONG', 'OLA', 'FAT CAKE', 'VENDING', 'STOETBUL', 'COMPADRE', 'PABLOS', 'KFC', 'UBER EATS', 'BK', 'MR PANDA', 'WIESEHOF', 'LADY JANE', 'VIDA E CAFFE', 'VUSE', 'HOME ESSENTIALS', 'VAPE', 'SLINGS SHOTS', 'MANCAVE', 'IK *TLC', 'RA CELLULAR', 'KHALIFA CELL', 'HPY*E AND D CELL', 'THE LOCAL CHOICE PHARMA', 'DISCHEM', 'FREI ONE DIGITAL', 'VIRGIN ACT', 'HPY*CELL TEC', 'HPY*EDEN TECH', 'THE CRAZY STORE', 'SAFARI TUINSENTR', 'AE WAPADRAND', 'AE NORWOOD', 'VPS*GIGGIE', 'ACSA JIA JHB', 'CC FRESH', 'BRUCHES BILTONG', 'BELLAS BILTONG', 'THE VAPE GURUS', 'UBER EATS JOHANNESBURG', 'WIESEHOF COFFEE SHOP ALBE', 'MR PANDA. BOKSBURG', 'BK NEW MARKET DT U MA', 'YOCO *THE 33 COLLECT', 'GENESIS', 'NETCASH'],
            'Fuel & Transport': ['ENGEN', 'SHELL', 'UBER', 'PACE CAR RENTAL', 'KARABO PARKING', 'PARKVIEW SHOPPING CENTRE'],
            'Groceries': ['SUPERSPAR', 'CHECKERS', 'PNP CLT', 'KINGS MEAT', 'WOOLWORTHS', 'S2S*SOUTHSUPERMARKET', 'S2S*SAVOYCAFEALBERTON'],
            'Shopping': ['AMAZON SELLER', 'MRPRICE', 'CASH CONVERTERS', 'NEWLAND ACCESSORIES', 'ADVANCE MENLYN PARK', 'PADSTAL', 'L A E CONSTANTIA', 'HOKAAI GIFT ACRES', 'SJIEK AND UNIQU', 'EASTRAND TRADERS SQUA', 'JACKIES ENTERPRISE', 'CLICKS', 'HPY*EXCELLECT VAPE CLU', 'MRPRICES 10766 GLENFAI', 'THE CRAZY STORE NEW RED', 'YOCO *RIETVLEI ZOO F'],
            'Transfers & Payments': ['PAYSHAP', 'REMAX', 'IPDA', 'GENESIS', 'NETCASH', 'DIAMATRIX CC'],
            'Fees': ['TXN DECLINED FEE', 'MONTHLY ACCOUNT FEE', 'EXCESS INTEREST CHARGED', 'VITALITY MONEY PREMIUM', 'INTL PAYMENT FEE', 'PAYSHAP PAYMENT FEE'],
            'Utilities & Bills': ['PREPAID DATA PURCHASE', 'PREPAID AIRTIME PURCHASE', 'APPLE.COM/BILL', 'DLOCAL *MICROSOFT ULTI', 'DIGITALOCEAN.COM', 'XAI LLC'],
            'Entertainment & Leisure': ['SHIELD EXPRESS REDRUTH', 'VIRGIN ACT', 'YOCO *RIETVLEI ZOO F'],
            'Other': ['DECLINED DOM CARD PURCH', 'DECLINED INT CARD PURCH', 'INTEREST EARNED', 'MILES TRANSFER TO CASH']
        };
        for (let tx of transactions) {
            tx.category = 'Other';
            const descUpper = tx.description.toUpperCase();
            for (let cat in categoryKeywords) {
                if (categoryKeywords[cat].some(k => descUpper.includes(k))) {
                    tx.category = cat;
                    break;
                }
            }
        }
        // Insert into database with transaction
        let count = 0;
        await dbRun('BEGIN TRANSACTION');
        try {
            for (let tx of transactions) {
                const financialResult = await dbRun('INSERT INTO financial (user, category, amount, type, date) VALUES (?, ?, ?, ?, ?)', [user, tx.category, tx.amount, tx.type, tx.date + ' 00:00:00']);
                await dbRun('INSERT INTO calendar (user, title, date, financial, type, amount, eventColor) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [user, `${tx.category} (${tx.type})`, tx.date + ' 00:00:00', 1, tx.type, tx.amount, '#2dd4bf']);
                await logTransaction(user, 'CREATE', 'financial', financialResult.lastID, user);
                count++;
            }
            await dbRun('COMMIT');
        } catch (error) {
            await dbRun('ROLLBACK');
            console.error('Error importing statement:', error.message);
            return res.status(500).json({ success: false, message: 'Server error importing statement.', error: error.message });
        }
        console.log(`Imported ${count} transactions for user ${user}`);
        res.json({ success: true, message: 'Statement imported successfully!', count });
    } catch (error) {
        console.error('Error importing statement:', error.message);
        res.status(500).json({ success: false, message: 'Server error importing statement.', error: error.message });
    }
});


// ── 2FA ENDPOINTS ─────────────────────────────────────────────────────────────

// Get 2FA status for a user
app.get('/api/2fa/status', async (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
    try {
        const row = await dbQuery('SELECT twofa_secret FROM users WHERE username = ?', [username]);
        if (!row) return res.status(404).json({ success: false, message: 'User not found.' });
        res.json({ success: true, enabled: !!row.twofa_secret });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error.', error: error.message });
    }
});

// Verify 2FA token during login
app.post('/api/verify-2fa', async (req, res) => {
    const { username, token } = req.body;
    if (!username || !token) {
        return res.status(400).json({ success: false, message: 'Username and token required.' });
    }
    try {
        const row = await dbQuery('SELECT * FROM users WHERE username = ?', [username]);
        if (!row || !row.twofa_secret) {
            return res.status(400).json({ success: false, message: '2FA not configured for this user.' });
        }
        const valid = otplib.verify({ token, secret: row.twofa_secret });
        if (!valid) {
            return res.status(401).json({ success: false, message: 'Invalid authentication code.' });
        }
        res.json({
            success: true,
            username: row.username,
            firstName: row.firstName || '',
            lastName: row.lastName || '',
            displayName: row.displayName || row.username,
            bio: row.bio || '',
            pronouns: row.pronouns || '',
            profilePicUrl: row.profilePicUrl || 'https://placehold.co/50x50/808080/FFFFFF?text=U',
            email: row.email || '',
            phone: row.phone || '',
            address: row.address || '',
            eventColor: row.eventColor || '#2dd4bf',
            isAdmin: !!row.isAdmin,
            gender: row.gender || '',
            telegram_chat_id: row.telegram_chat_id || '',
            theme: row.theme || 'dark',
            activityStatus: !!row.activityStatus,
            lastActive: row.lastActive || ''
        });
    } catch (error) {
        console.error('Error verifying 2FA:', error.message);
        res.status(500).json({ success: false, message: 'Server error verifying 2FA.', error: error.message });
    }
});

// Generate 2FA setup (QR code + secret)
app.get('/api/2fa/setup', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    try {
        const row = await dbQuery('SELECT twofa_secret FROM users WHERE username = ?', [username]);
        if (!row) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        if (row.twofa_secret) {
            return res.status(400).json({ success: false, message: '2FA already configured.' });
        }
        const secret = otplib.generateSecret();
        const otpauth = otplib.generateURI({ secret, label: username, issuer: 'VectraArch Legacy' });
        const qrCode = await QRCode.toDataURL(otpauth);
        // Store temp secret in memory (will be confirmed on POST)
        res.json({ success: true, secret, qrCode });
    } catch (error) {
        console.error('Error generating 2FA setup:', error.message);
        res.status(500).json({ success: false, message: 'Server error generating 2FA setup.', error: error.message });
    }
});

// Confirm and enable 2FA
app.post('/api/2fa/setup', async (req, res) => {
    const { username, secret, token } = req.body;
    if (!username || !secret || !token) {
        return res.status(400).json({ success: false, message: 'Username, secret, and token required.' });
    }
    try {
        const valid = otplib.verify({ token, secret });
        if (!valid) {
            return res.status(401).json({ success: false, message: 'Invalid code. Please try again.' });
        }
        await dbRun('UPDATE users SET twofa_secret = ? WHERE username = ?', [secret, username]);
        res.json({ success: true, message: '2FA enabled successfully.' });
    } catch (error) {
        console.error('Error enabling 2FA:', error.message);
        res.status(500).json({ success: false, message: 'Server error enabling 2FA.', error: error.message });
    }
});

// Disable 2FA
app.post('/api/2fa/disable', async (req, res) => {
    const { username, token } = req.body;
    if (!username || !token) {
        return res.status(400).json({ success: false, message: 'Username and token required.' });
    }
    try {
        const row = await dbQuery('SELECT twofa_secret FROM users WHERE username = ?', [username]);
        if (!row || !row.twofa_secret) {
            return res.status(400).json({ success: false, message: '2FA not configured.' });
        }
        const valid = otplib.verify({ token, secret: row.twofa_secret });
        if (!valid) {
            return res.status(401).json({ success: false, message: 'Invalid code.' });
        }
        await dbRun('UPDATE users SET twofa_secret = NULL WHERE username = ?', [username]);
        res.json({ success: true, message: '2FA disabled successfully.' });
    } catch (error) {
        console.error('Error disabling 2FA:', error.message);
        res.status(500).json({ success: false, message: 'Server error disabling 2FA.', error: error.message });
    }
});

// Admin reset 2FA for a user
app.post('/api/2fa/reset', requireAdmin, async (req, res) => {
    const { username } = req.body;
    if (!username) {
        return res.status(400).json({ success: false, message: 'Username required.' });
    }
    try {
        await dbRun('UPDATE users SET twofa_secret = NULL WHERE username = ?', [username]);
        res.json({ success: true, message: `2FA reset for ${username}.` });
    } catch (error) {
        console.error('Error resetting 2FA:', error.message);
        res.status(500).json({ success: false, message: 'Server error resetting 2FA.', error: error.message });
    }
});

// HTTPS server setup
const httpsOptions = {
	key: fs.readFileSync('/etc/letsencrypt/live/vectraarch.live/privkey.pem'),
cert: fs.readFileSync('/etc/letsencrypt/live/vectraarch.live/fullchain.pem')
};
const httpsServer = https.createServer(httpsOptions, app);
httpsServer.listen(8443, () => console.log('HTTPS Server running on port 8443'));
// HTTP redirect to HTTPS
const httpServer = http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
});
httpServer.listen(1000, () => console.log('HTTP Server running on port 1000 and redirecting to HTTPS'));
