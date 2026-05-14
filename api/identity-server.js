'use strict';
/**
 * VectraArch Identity Bridge
 * ──────────────────────────
 * Resolves the fragmentation boundary between:
 *   VectraArchLegacy  (username TEXT PK)
 *   VectraArchForge   (id TEXT PK — Google profile ID or m_ prefixed)
 *
 * Port : 3200 (internal, nginx proxies /api at vectraarch.live/api/)
 * DB   : VectraArchAPI (forge_master)
 *
 * All endpoints are internal — not exposed publicly without nginx auth.
 * Services authenticate with a shared API key in the X-API-Key header.
 */

require('dotenv').config({ path: '/var/www/vectraarch.live/forge/.env' });

const express = require('express');
const { Pool } = require('pg');

const app  = express();
const PORT = 3200;
const HOST = '127.0.0.1';
const BASE = '/api';

// ── API KEY AUTH ──────────────────────────────────────────────────────────────
// Set IDENTITY_API_KEY in your .env  — any long random string.
// All services calling this API must send:  X-API-Key: <value>
const API_KEY = process.env.IDENTITY_API_KEY;

if (!API_KEY) {
    console.error('[identity] IDENTITY_API_KEY not set in .env — server will refuse all requests.');
}

function requireKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ success: false, message: 'Unauthorized.' });
    }
    next();
}

// ── DATABASE POOLS ────────────────────────────────────────────────────────────
const apiPool = new Pool({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST || 'localhost',
    database: 'VectraArchAPI',
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT || '5432'),
});

// Cross-verify against Forge users (read-only) so we can validate forge_user_id exists
const forgePool = new Pool({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST || 'localhost',
    database: 'VectraArchForge',
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT || '5432'),
});

// Cross-verify against Legacy users (read-only) so we can validate legacy_username exists
const legacyPool = new Pool({
    user:     process.env.DB_USER,
    host:     process.env.DB_HOST || 'localhost',
    database: 'VectraArchLegacy',
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT || '5432'),
});

// ── DB SETUP ──────────────────────────────────────────────────────────────────
async function setupDB() {
    await apiPool.query(`
        CREATE TABLE IF NOT EXISTS identity_links (
            id              SERIAL PRIMARY KEY,
            legacy_username TEXT        NOT NULL UNIQUE,
            forge_user_id   TEXT        NOT NULL UNIQUE,
            linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            linked_by       TEXT,
            notes           TEXT
        )
    `);

    await apiPool.query(`
        CREATE INDEX IF NOT EXISTS idx_identity_legacy
            ON identity_links(legacy_username)
    `);

    await apiPool.query(`
        CREATE INDEX IF NOT EXISTS idx_identity_forge
            ON identity_links(forge_user_id)
    `);

    await apiPool.query(`
        CREATE TABLE IF NOT EXISTS identity_audit (
            id          SERIAL PRIMARY KEY,
            action      TEXT        NOT NULL,  -- LINK | UNLINK
            legacy_username TEXT,
            forge_user_id   TEXT,
            performed_by    TEXT,
            performed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            detail          TEXT
        )
    `);

    console.log('[identity] DB ready');
}

async function audit(action, legacy_username, forge_user_id, performed_by, detail) {
    try {
        await apiPool.query(
            'INSERT INTO identity_audit (action,legacy_username,forge_user_id,performed_by,detail) VALUES ($1,$2,$3,$4,$5)',
            [action, legacy_username || null, forge_user_id || null, performed_by || null, detail || null]
        );
    } catch (e) {
        console.error('[identity] audit write failed:', e.message);
    }
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());

// ── ROUTES ────────────────────────────────────────────────────────────────────

/**
 * POST /api/identity/link
 * Body: { legacy_username, forge_user_id, linked_by? }
 *
 * Links a Legacy username to a Forge user ID.
 * Validates both users exist in their respective databases before linking.
 * Idempotent — re-posting the same pair returns success without error.
 */
app.post(BASE + '/identity/link', requireKey, async (req, res) => {
    const { legacy_username, forge_user_id, linked_by, notes } = req.body;

    if (!legacy_username || !forge_user_id) {
        return res.status(400).json({ success: false, message: 'legacy_username and forge_user_id required.' });
    }

    try {
        // Validate Legacy user exists
        const legacyUser = await legacyPool.query(
            'SELECT username FROM vectraarchlegacy_users WHERE username = $1',
            [legacy_username]
        );
        if (!legacyUser.rows[0]) {
            return res.status(404).json({ success: false, message: `Legacy user '${legacy_username}' not found.` });
        }

        // Validate Forge user exists
        const forgeUser = await forgePool.query(
            'SELECT id, name FROM users WHERE id = $1',
            [forge_user_id]
        );
        if (!forgeUser.rows[0]) {
            return res.status(404).json({ success: false, message: `Forge user '${forge_user_id}' not found.` });
        }

        // Check for conflicting links
        const existingLegacy = await apiPool.query(
            'SELECT forge_user_id FROM identity_links WHERE legacy_username = $1',
            [legacy_username]
        );
        if (existingLegacy.rows[0] && existingLegacy.rows[0].forge_user_id !== forge_user_id) {
            return res.status(409).json({
                success: false,
                message: `Legacy user '${legacy_username}' is already linked to a different Forge account.`,
                existing_forge_user_id: existingLegacy.rows[0].forge_user_id
            });
        }

        const existingForge = await apiPool.query(
            'SELECT legacy_username FROM identity_links WHERE forge_user_id = $1',
            [forge_user_id]
        );
        if (existingForge.rows[0] && existingForge.rows[0].legacy_username !== legacy_username) {
            return res.status(409).json({
                success: false,
                message: `Forge user '${forge_user_id}' is already linked to a different Legacy account.`,
                existing_legacy_username: existingForge.rows[0].legacy_username
            });
        }

        // Upsert the link
        const r = await apiPool.query(`
            INSERT INTO identity_links (legacy_username, forge_user_id, linked_by, notes)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (legacy_username) DO UPDATE
                SET forge_user_id = EXCLUDED.forge_user_id,
                    linked_at     = NOW(),
                    linked_by     = EXCLUDED.linked_by,
                    notes         = EXCLUDED.notes
            RETURNING *
        `, [legacy_username, forge_user_id, linked_by || null, notes || null]);

        await audit('LINK', legacy_username, forge_user_id, linked_by, `Forge name: ${forgeUser.rows[0].name}`);

        console.log(`[identity] Linked: ${legacy_username} ↔ ${forge_user_id} (by ${linked_by || 'unknown'})`);
        res.json({
            success: true,
            message: `Identity linked: ${legacy_username} ↔ ${forge_user_id}`,
            link: r.rows[0]
        });

    } catch (e) {
        console.error('[identity] Link error:', e.message);
        res.status(500).json({ success: false, message: 'Server error creating link.', error: e.message });
    }
});

/**
 * DELETE /api/identity/link
 * Body: { legacy_username?, forge_user_id?, unlinked_by? }
 *
 * Removes a link. Accepts either identifier.
 */
app.delete(BASE + '/identity/link', requireKey, async (req, res) => {
    const { legacy_username, forge_user_id, unlinked_by } = req.body;

    if (!legacy_username && !forge_user_id) {
        return res.status(400).json({ success: false, message: 'legacy_username or forge_user_id required.' });
    }

    try {
        let row;
        if (legacy_username) {
            const r = await apiPool.query('SELECT * FROM identity_links WHERE legacy_username = $1', [legacy_username]);
            row = r.rows[0];
        } else {
            const r = await apiPool.query('SELECT * FROM identity_links WHERE forge_user_id = $1', [forge_user_id]);
            row = r.rows[0];
        }

        if (!row) {
            return res.status(404).json({ success: false, message: 'Link not found.' });
        }

        await apiPool.query('DELETE FROM identity_links WHERE id = $1', [row.id]);
        await audit('UNLINK', row.legacy_username, row.forge_user_id, unlinked_by, null);

        console.log(`[identity] Unlinked: ${row.legacy_username} ↔ ${row.forge_user_id} (by ${unlinked_by || 'unknown'})`);
        res.json({
            success: true,
            message: `Identity unlinked: ${row.legacy_username} ↔ ${row.forge_user_id}`,
            removed: row
        });

    } catch (e) {
        console.error('[identity] Unlink error:', e.message);
        res.status(500).json({ success: false, message: 'Server error removing link.', error: e.message });
    }
});

/**
 * GET /api/identity/resolve?legacy_username=x
 * GET /api/identity/resolve?forge_user_id=x
 *
 * Resolves either identifier to the full link record.
 * Returns 404 if not linked — not an error, just unlnked.
 */
app.get(BASE + '/identity/resolve', requireKey, async (req, res) => {
    const { legacy_username, forge_user_id } = req.query;

    if (!legacy_username && !forge_user_id) {
        return res.status(400).json({ success: false, message: 'legacy_username or forge_user_id required.' });
    }

    try {
        let link;
        if (legacy_username) {
            const r = await apiPool.query('SELECT * FROM identity_links WHERE legacy_username = $1', [legacy_username]);
            link = r.rows[0];
        } else {
            const r = await apiPool.query('SELECT * FROM identity_links WHERE forge_user_id = $1', [forge_user_id]);
            link = r.rows[0];
        }

        if (!link) {
            return res.status(404).json({ success: false, linked: false, message: 'No identity link found.' });
        }

        // Optionally enrich with names from both systems
        let forgeName = null, legacyDisplayName = null;
        try {
            const fr = await forgePool.query('SELECT name FROM users WHERE id = $1', [link.forge_user_id]);
            forgeName = fr.rows[0]?.name || null;
        } catch { /* non-fatal */ }
        try {
            const lr = await legacyPool.query('SELECT display_name FROM vectraarchlegacy_users WHERE username = $1', [link.legacy_username]);
            legacyDisplayName = lr.rows[0]?.display_name || null;
        } catch { /* non-fatal */ }

        res.json({
            success: true,
            linked: true,
            link: {
                ...link,
                forge_name:          forgeName,
                legacy_display_name: legacyDisplayName
            }
        });

    } catch (e) {
        console.error('[identity] Resolve error:', e.message);
        res.status(500).json({ success: false, message: 'Server error resolving identity.', error: e.message });
    }
});

/**
 * GET /api/identity/links
 * Query: ?page=1&limit=50
 *
 * Lists all identity links with enriched names. Admin use only.
 */
app.get(BASE + '/identity/links', requireKey, async (req, res) => {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    try {
        const countRes = await apiPool.query('SELECT COUNT(*) AS n FROM identity_links');
        const total = parseInt(countRes.rows[0].n);

        const rows = await apiPool.query(
            'SELECT * FROM identity_links ORDER BY linked_at DESC LIMIT $1 OFFSET $2',
            [limit, offset]
        );

        res.json({
            success: true,
            total,
            page,
            limit,
            links: rows.rows
        });

    } catch (e) {
        console.error('[identity] List error:', e.message);
        res.status(500).json({ success: false, message: 'Server error listing links.', error: e.message });
    }
});

/**
 * GET /api/identity/audit
 * Query: ?page=1&limit=50
 *
 * Returns the audit log of all link/unlink operations.
 */
app.get(BASE + '/identity/audit', requireKey, async (req, res) => {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = (page - 1) * limit;

    try {
        const countRes = await apiPool.query('SELECT COUNT(*) AS n FROM identity_audit');
        const total = parseInt(countRes.rows[0].n);

        const rows = await apiPool.query(
            'SELECT * FROM identity_audit ORDER BY performed_at DESC LIMIT $1 OFFSET $2',
            [limit, offset]
        );

        res.json({ success: true, total, page, limit, audit: rows.rows });

    } catch (e) {
        console.error('[identity] Audit error:', e.message);
        res.status(500).json({ success: false, message: 'Server error fetching audit log.', error: e.message });
    }
});

/**
 * GET /api/identity/health
 * No auth required — used by monitoring and nginx health checks.
 */
app.get(BASE + '/identity/health', (req, res) => {
    res.json({ success: true, service: 'VectraArchIdentity', port: PORT });
});

// ── START ─────────────────────────────────────────────────────────────────────
setupDB()
    .then(() => {
        app.listen(PORT, HOST, () => {
            console.log(`[identity] VectraArch Identity Bridge running on ${HOST}:${PORT}`);
        });
    })
    .catch(e => {
        console.error('[identity] Failed to start:', e.message);
        process.exit(1);
    });
