'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

/**
 * Conduit Hub — VectraArch Automation, Social & Site Manager
 * Port: 3100 (internal, nginx proxies /conduit)
 * DB:   bookforge (forge_master) — same DB as VectraArchForge
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const pm2 = require('pm2');

const express  = require('express');
const session  = require('express-session');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { Pool } = require('pg');
const { verify, generateSecret, generateURI } = require('otplib');
const qrcode   = require('qrcode');

const app  = express();
const PORT = 3100;
const HOST = '127.0.0.1';
const BASE = '';

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN   || '8767176406:AAEMhPAuQw5dFPEMcLEru1ZkqFT5ijk8YCk';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8783471876';
const PRESS_URL        = 'https://vectraarch.live/press';
const FORGE_URL        = 'https://vectraarch.live/forge';
const FOUNDATION_URL   = 'https://forge.vectraarch.live/';
const WWW_ROOT         = '/var/www/vectraarch.live';

// ── DATABASE ──────────────────────────────────────────────────────────────────
const H = process.env.DB_HOST || 'localhost';
const P = parseInt(process.env.DB_PORT || '5432');

const pool = new Pool({       // VectraArchConduit — own DB (admin users, conduit_log)
  user: process.env.DB_USER, host: H, database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: P,
});
const forgePool = new Pool({  // VectraArchForge — forge users, books
  user: process.env.FORGE_DB_USER, host: H, database: process.env.FORGE_DB_NAME, password: process.env.FORGE_DB_PASSWORD, port: P,
});
const apiPool = new Pool({    // VectraArchAPI — API keys, tokens
  user: process.env.API_DB_USER, host: H, database: process.env.API_DB_NAME, password: process.env.API_DB_PASSWORD, port: P,
});
const legacyPool = new Pool({ // VectraArchLegacy — legacy users, keys
  user: process.env.LEGACY_DB_USER, host: H, database: process.env.LEGACY_DB_NAME, password: process.env.LEGACY_DB_PASSWORD, port: P,
});

// ── LEGACY SUBSCRIPTIONS ──────────────────────────────────────────────────────
// Conduit owns the full Legacy subscription-management surface (the same console
// that lives behind /api/admin/subscriptions in VectraArchLegacy.js). Keep PLANS,
// TRIAL_DAYS and entitlementFor() in lock-step with that app — they decide what
// the paygate actually does. Conduit writes straight to the Legacy DB.
const LEGACY_TRIAL_DAYS = parseInt(process.env.LEGACY_TRIAL_DAYS || process.env.TRIAL_DAYS || '3', 10);
const LEGACY_PLANS = {
  basic:    { name: 'Basic',    amount: '29.00',  recurring: true,  label: 'R29 / month'  },
  standard: { name: 'Standard', amount: '49.00',  recurring: true,  label: 'R49 / month'  },
  premium:  { name: 'Premium',  amount: '99.00',  recurring: true,  label: 'R99 / month'  },
  lifetime: { name: 'Lifetime', amount: '299.00', recurring: false, label: 'R299 once-off' },
};

// Resolve a Legacy user row into the live entitlement the paygate enforces.
// Mirror of entitlementFor() in VectraArchLegacy.js.
function legacyEntitlementFor(row) {
  if (!row) return { status: 'expired', active: false, plan: null, daysLeft: 0 };
  const now    = Date.now();
  const status = row.subscription_status || 'trial';
  const expiresAt = row.subscription_expires_at ? new Date(row.subscription_expires_at).getTime() : null;

  if (status === 'active') {
    const stillValid = !expiresAt || expiresAt > now;
    if (stillValid) {
      return {
        status: 'active', active: true,
        plan: row.subscription_plan || null,
        expiresAt: row.subscription_expires_at || null,
        daysLeft: expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 86400000)) : null,
      };
    }
  }

  const trialStart = row.trial_started_at ? new Date(row.trial_started_at).getTime() : now;
  const trialEnd   = trialStart + LEGACY_TRIAL_DAYS * 86400000;
  if (status !== 'cancelled' && status !== 'expired' && trialEnd > now) {
    return {
      status: 'trial', active: true, plan: null,
      trialEndsAt: new Date(trialEnd).toISOString(),
      daysLeft: Math.max(0, Math.ceil((trialEnd - now) / 86400000)),
    };
  }

  return { status: 'expired', active: false, plan: row.subscription_plan || null, daysLeft: 0 };
}

// MRR contribution of an active plan (recurring only; lifetime adds nothing).
function legacyPlanMonthlyValue(planId) {
  const p = LEGACY_PLANS[planId];
  if (!p) return 0;
  return p.recurring ? parseFloat(p.amount) : 0;
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret:            process.env.SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie:            { secure: true, sameSite: 'lax', maxAge: 86400000 },
}));

// ── AUTH GUARD ────────────────────────────────────────────────────────────────
function isAuth(req, res, next) {
  if (!req.session.conduitUser) return res.redirect('/login');
  if (req.session.needs2FA)     return res.redirect('/auth/2fa');
  next();
}

// ── DB SETUP ──────────────────────────────────────────────────────────────────
async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      password     TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'admin',
      status       TEXT NOT NULL DEFAULT 'enabled',
      twofa_secret TEXT,
      logins       INTEGER NOT NULL DEFAULT 0,
      last_login   TEXT,
      created      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'enabled',
      ADD COLUMN IF NOT EXISTS logins INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_login TEXT
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conduit_log (
      id      SERIAL PRIMARY KEY,
      event   TEXT NOT NULL,
      payload TEXT,
      status  TEXT NOT NULL DEFAULT 'ok',
      created TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('[conduit] DB ready');
}

// ── SITE & APP DISCOVERY ─────────────────────────────────────────────────────
// Conduit lives next to every other app on /var/www, so we can scan the
// filesystem instead of maintaining a hand-curated list of sites/endpoints.
//
//   /var/www/forge.vectraarch.live/   ← subdomain Node app
//   /var/www/legacy.vectraarch.live/  ← subdomain Node app
//   /var/www/vectraarch.live/bo7/     ← static subdir on the main site
//   /var/www/vectraarch.live/press/   ← static subdir
//
// Anything we discover is cross-referenced with pm2 (for Node apps) and
// optionally enriched from SITE_META (label, purpose, num) below.

const STATIC_ROOT = '/var/www/vectraarch.live';   // host of /bo7, /press, /foundation, etc.
const SITES_ROOT  = '/var/www';                    // host of *.vectraarch.live subdomains

// Optional human-friendly metadata. Discovered sites without an entry here
// fall back to their directory name as the label.
const SITE_META = {
  '':           { label:'Home',         num:'—',     purpose:'Central hub · personal brand · studio map' },
  'fabric':     { label:'Fabric',       num:'01/08', purpose:'Technical infrastructure portfolio' },
  'conduit':    { label:'Conduit',      num:'02/08', purpose:'Automation & social hub · VectraArchConduit' },
  'forge':      { label:'Book Forge',   num:'03/08', purpose:'Writing management app · VectraArchForge' },
  'keystone':   { label:'Keystone',     num:'04/08', purpose:'Constellation architecture documentation' },
  'kinetic':    { label:'Kinetic',      num:'05/08', purpose:'Visual portfolio · sculpture · gaming' },
  'volition':   { label:'Volition',     num:'06/08', purpose:"Builder's log · process journal" },
  'foundation': { label:'Foundation',   num:'07/08', purpose:'Central auth hub · yellow warning zone' },
  'press':      { label:'Press',        num:'08/08', purpose:'Auto-generated by VectraArchForge on publish' },
  'bo7':        { label:'Bo7',          num:'—',     purpose:'CoD coaching platform · ZenithB_Actual' },
  'legacy':     { label:'Legacy',       num:'—',     purpose:'Lifestyle app · VectraArchLegacy' },
  'api':        { label:'Identity API', num:'—',     purpose:'VectraArch Identity Bridge · :3200' },
};

// Node app source files we parse for live API route discovery. Keyed by the
// pm2 process name so the API table can be enriched with online/offline status.
const APP_SOURCES = {
  'VectraArchForge':    '/var/www/forge.vectraarch.live/VectraArchForge.js',
  'VectraArchConduit':  '/var/www/conduit.vectraarch.live/VectraArchConduit.js',
  'VectraArchLegacy':   '/var/www/legacy.vectraarch.live/VectraArchLegacy.js',
  'VectraArchIdentity': '/var/www/api.vectraarch.live/VectraArchIdentity.js',
  'VectraArchCOMS':     '/var/www/api.vectraarch.live/VectraArchCOMS.js',
};

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }
function safeReaddir(p) { try { return fs.readdirSync(p, { withFileTypes:true }); } catch { return []; } }

function classifyDir(dir) {
  // Returns 'node' if a package.json with a main entry exists, 'static' if an
  // index.html exists, or null otherwise.
  const hasPkg   = !!safeStat(path.join(dir, 'package.json'));
  const hasIndex = !!safeStat(path.join(dir, 'index.html'));
  if (hasPkg)   return 'node';
  if (hasIndex) return 'static';
  return null;
}

function newestMtime(dir, exts=['.js','.html','.css']) {
  // Walk one level deep to find the most-recently-touched relevant file.
  let newest = 0;
  for (const ent of safeReaddir(dir)) {
    if (ent.isDirectory()) continue;
    if (!exts.some(x => ent.name.endsWith(x))) continue;
    const st = safeStat(path.join(dir, ent.name));
    if (st && st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return newest || null;
}

function discoverSites() {
  const out = [];

  // Subdomain apps: /var/www/<subdomain>.vectraarch.live/
  for (const ent of safeReaddir(SITES_ROOT)) {
    if (!ent.isDirectory()) continue;
    if (!ent.name.endsWith('.vectraarch.live')) continue;
    if (ent.name === 'vectraarch.live') continue;  // main static site, handled below
    const sub  = ent.name.replace(/\.vectraarch\.live$/, '');
    const dir  = path.join(SITES_ROOT, ent.name);
    const type = classifyDir(dir);
    if (!type) continue;
    const meta = SITE_META[sub] || {};
    const mt   = newestMtime(dir) || safeStat(dir)?.mtimeMs;
    out.push({
      subdomain: sub,
      url:       `https://${ent.name}/`,
      pathLabel: `${ent.name}/`,
      label:     meta.label   || sub.replace(/^./, c=>c.toUpperCase()),
      num:       meta.num     || '—',
      type:      type === 'node' ? 'node' : 'static',
      purpose:   meta.purpose || '—',
      lastModified: mt ? new Date(mt).toLocaleString('en-ZA') : '—',
      sortKey:   mt || 0,
    });
  }

  // Static subdirs of the main site: /var/www/vectraarch.live/<sub>/
  // Also include the main site itself (the root index.html).
  const rootStat = safeStat(path.join(STATIC_ROOT, 'index.html'));
  if (rootStat) {
    out.push({
      subdomain: '',
      url:       'https://vectraarch.live/',
      pathLabel: 'vectraarch.live/',
      label:     SITE_META[''].label,
      num:       SITE_META[''].num,
      type:      'static',
      purpose:   SITE_META[''].purpose,
      lastModified: new Date(rootStat.mtimeMs).toLocaleString('en-ZA'),
      sortKey:   rootStat.mtimeMs,
    });
  }
  for (const ent of safeReaddir(STATIC_ROOT)) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.') || ent.name === 'shared') continue;  // skip shared/, .git/, .pm2/
    const dir  = path.join(STATIC_ROOT, ent.name);
    const type = classifyDir(dir);
    if (!type) continue;
    const meta = SITE_META[ent.name] || {};
    const mt   = newestMtime(dir) || safeStat(dir)?.mtimeMs;
    out.push({
      subdomain: ent.name,
      url:       `https://vectraarch.live/${ent.name}/`,
      pathLabel: `vectraarch.live/${ent.name}/`,
      label:     meta.label   || ent.name.replace(/^./, c=>c.toUpperCase()),
      num:       meta.num     || '—',
      type:      type === 'node' ? 'node' : 'static',
      purpose:   meta.purpose || '—',
      lastModified: mt ? new Date(mt).toLocaleString('en-ZA') : '—',
      sortKey:   mt || 0,
    });
  }

  // Newest first
  out.sort((a,b)=> b.sortKey - a.sortKey);
  return out;
}

// Strip JS line + block comments so route-discovery doesn't match example
// code we may write inside documentation comments.
function stripJsComments(src) {
  // Order matters: block comments first, then line comments.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');  // skip "//" inside strings/URLs heuristically
}

function discoverApiRoutes() {
  // Parses each app's source for HTTP route registrations.
  //
  // Express style (Forge / Conduit / Legacy / Identity):
  //     app.get/post/put/delete/patch('path', ...)
  //     app.method(BASE + 'path', ...)        // BASE resolved from the file
  //
  // Bare-http style (COMS):
  //     const ROUTES = { '/path': handler, ... }   // all POST
  //
  const ROUTE_RE   = /\bapp\.(get|post|put|delete|patch)\s*\(\s*(?:(BASE)\s*\+\s*)?['"`]([^'"`]+)['"`]/g;
  const BASE_RE    = /\bconst\s+BASE\s*=\s*['"`]([^'"`]*)['"`]/;
  const ROUTES_TBL = /\bconst\s+ROUTES\s*=\s*\{([\s\S]*?)\}/;
  const TBL_ENTRY  = /['"`]([^'"`]+)['"`]\s*:/g;
  const grouped    = {};

  for (const [appName, srcPath] of Object.entries(APP_SOURCES)) {
    let raw;
    try { raw = fs.readFileSync(srcPath, 'utf8'); }
    catch { grouped[appName] = []; continue; }
    const src       = stripJsComments(raw);
    const baseMatch = src.match(BASE_RE);
    const base      = baseMatch ? baseMatch[1] : '';
    const routes    = [];
    const seen      = new Set();

    // Express routes
    let m;
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src))) {
      const method = m[1].toUpperCase();
      const full   = (m[2] ? base : '') + m[3];
      const key    = method + ' ' + full;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ method, path: full });
    }

    // bare-http ROUTES table (assumes POST, matches COMS style)
    if (routes.length === 0) {
      const tbl = src.match(ROUTES_TBL);
      if (tbl) {
        let e;
        TBL_ENTRY.lastIndex = 0;
        while ((e = TBL_ENTRY.exec(tbl[1]))) {
          const full = e[1];
          if (!full.startsWith('/')) continue;
          const key = 'POST ' + full;
          if (seen.has(key)) continue;
          seen.add(key);
          routes.push({ method:'POST', path: full });
        }
      }
    }

    // Stable sort: GET > POST > PUT > DELETE > PATCH, then alphabetical
    const ORD = { GET:0, POST:1, PUT:2, DELETE:3, PATCH:4 };
    routes.sort((a,b)=> (ORD[a.method]-ORD[b.method]) || a.path.localeCompare(b.path));
    grouped[appName] = routes;
  }

  return grouped;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function postTelegram(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text });
    const req = https.request(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{resolve(JSON.parse(d));}catch{reject(new Error('Parse'));} }); }
    );
    req.on('error', reject); req.write(body); req.end();
  });
}

// (Legacy siteIndexPath / siteLastModified helpers removed — Observatory now
// uses discoverSites() which scans the filesystem directly and reports the
// newest-mtime across each site's source files.)

// ── DATABASE DISCOVERY ───────────────────────────────────────────────────────
// One entry per pg database the conduit has credentials for. Each pool was
// created at module load (see top of file). We query pg_tables + columns +
// pg_class for each on demand.
const DB_REGISTRY = [
  { label:'VectraArchConduit', pool: pool,       purpose:'Conduit admin users & event log'         },
  { label:'VectraArchForge',   pool: forgePool,  purpose:'Forge users, books, entries'             },
  { label:'VectraArchAPI',     pool: apiPool,    purpose:'Identity links (Legacy ↔ Forge), audit'  },
  { label:'VectraArchLegacy',  pool: legacyPool, purpose:'Legacy lifestyle app: users, finances, calendar, etc.' },
];

async function discoverDatabases() {
  return Promise.all(DB_REGISTRY.map(async d => {
    try {
      const r = await d.pool.query(`
        SELECT
          t.schemaname                                AS schema,
          t.tablename                                 AS name,
          t.tableowner                                AS owner,
          pg_total_relation_size(quote_ident(t.schemaname) || '.' || quote_ident(t.tablename))
                                                      AS bytes,
          c.reltuples::bigint                         AS rows,
          (
            SELECT json_agg(json_build_object(
                     'name', column_name,
                     'type', data_type,
                     'nullable', is_nullable
                   ) ORDER BY ordinal_position)
            FROM information_schema.columns col
            WHERE col.table_schema = t.schemaname AND col.table_name = t.tablename
          )                                           AS columns
        FROM pg_tables t
        JOIN pg_class c ON c.relname = t.tablename
          AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.schemaname)
        WHERE t.schemaname NOT IN ('pg_catalog','information_schema')
        ORDER BY t.schemaname, t.tablename
      `);
      // Aggregates for the summary header
      const totalBytes = r.rows.reduce((s,t)=> s + (parseInt(t.bytes,10) || 0), 0);
      const totalRows  = r.rows.reduce((s,t)=> s + Math.max(0, parseInt(t.rows,10) || 0), 0);
      const totalCols  = r.rows.reduce((s,t)=> s + (t.columns?.length || 0), 0);
      // Group by schema for rendering
      const bySchema = {};
      r.rows.forEach(t => { (bySchema[t.schema] ||= []).push(t); });
      return { label:d.label, db:d.label, purpose:d.purpose, ok:true,
               tables:r.rows, bySchema, totalBytes, totalRows, totalCols };
    } catch (e) {
      return { label:d.label, db:d.label, purpose:d.purpose, ok:false,
               error:e.message, tables:[], bySchema:{}, totalBytes:0, totalRows:0, totalCols:0 };
    }
  }));
}

function fmtBytes(b) {
  if (b == null || b === 0) return '—';
  if (b < 1024)         return b + ' b';
  if (b < 1024*1024)    return Math.round(b/1024) + ' kb';
  if (b < 1024*1024*1024) return (b/1024/1024).toFixed(1) + ' mb';
  return (b/1024/1024/1024).toFixed(2) + ' gb';
}
function fmtRows(n) {
  if (n == null || n < 0) return '—';
  if (n < 1000)  return String(Math.round(n));
  if (n < 1e6)   return (n/1000).toFixed(n<10000?1:0) + 'k';
  if (n < 1e9)   return (n/1e6).toFixed(2) + 'm';
  return (n/1e9).toFixed(2) + 'b';
}

// ── PM2 ───────────────────────────────────────────────────────────────────────
function getPM2List() {
  return new Promise((resolve) => {
    pm2.connect(true, err => {
      if (err) return resolve([]);
      pm2.list((err, list) => {
        pm2.disconnect();
        if (err) return resolve([]);
        resolve(list.map(p => ({
          name:     p.name,
          status:   p.pm2_env.status,
          pid:      p.pid,
          uptime:   p.pm2_env.pm_uptime ? Math.floor((Date.now() - p.pm2_env.pm_uptime) / 1000) : 0,
          restarts: p.pm2_env.restart_time,
          memory:   p.monit ? Math.round(p.monit.memory / 1024 / 1024) : 0,
          cpu:      p.monit ? p.monit.cpu : 0,
        })));
      });
    });
  });
}

function formatUptime(s) {
  if (s < 60)    return s + 's';
  if (s < 3600)  return Math.floor(s/60) + 'm';
  if (s < 86400) return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
  return Math.floor(s/86400) + 'd ' + Math.floor((s%86400)/3600) + 'h';
}

// ── FONTS & CSS ───────────────────────────────────────────────────────────────
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:wght@0,300;0,400;0,500&family=Barlow+Condensed:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>`;

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#0a0a08;--bg2:#111110;--bg3:#191917;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.14);
  --text:#e8e4d8;--muted:rgba(232,228,216,0.5);--dim:rgba(232,228,216,0.22);
  --accent:#00ff41;--accent2:#00b32c;--red:#b84040;--warn:#d4a800;
  --auth-accent:#d4a017;--auth-accent2:#b8880f;--auth-accent3:#f0c040;
  --auth-glow-dim:rgba(212,160,23,0.06);
  --auth-border:rgba(212,160,23,0.35);--auth-border2:rgba(212,160,23,0.18);
}
html{scroll-behavior:smooth;}
body{background:var(--bg);color:var(--text);font-family:'DM Mono',monospace;font-size:13px;line-height:1.7;overflow-x:hidden;}
body::before{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E");opacity:0.4;pointer-events:none;z-index:0;}
.grid-bg{position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:80px 80px;pointer-events:none;z-index:0;}
.accent-lines{position:fixed;top:0;right:0;width:50%;height:100%;pointer-events:none;overflow:hidden;z-index:0;}
.accent-lines svg{width:100%;height:100%;}
nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 32px;height:56px;border-bottom:1px solid var(--border);background:rgba(10,10,8,0.92);backdrop-filter:blur(12px);}
.nav-logo{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:14px;letter-spacing:0.22em;text-transform:uppercase;color:var(--text);text-decoration:none;}
.nav-logo span{color:var(--accent);}
.nav-tabs{display:flex;align-items:center;}
.nav-tab{font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--dim);text-decoration:none;padding:0 16px;height:56px;display:flex;align-items:center;border-bottom:2px solid transparent;transition:color 0.2s,border-color 0.2s;}
.nav-tab:hover{color:var(--muted);}
.nav-tab.active{color:var(--accent);border-bottom-color:var(--accent);}
.nav-right{display:flex;align-items:center;gap:16px;}
.nav-status{display:flex;align-items:center;gap:7px;font-size:10px;letter-spacing:0.1em;color:var(--dim);}
.nav-status::before{content:'';display:block;width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent);}
.nav-link{font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--dim);text-decoration:none;transition:color 0.2s;}
.nav-link:hover{color:var(--muted);}
.wrap{position:relative;z-index:1;padding:80px 32px 60px;max-width:1200px;margin:0 auto;}
.page-title{font-family:'Bebas Neue',sans-serif;font-size:56px;line-height:0.9;color:var(--text);letter-spacing:0.02em;margin-bottom:6px;}
.page-sub{font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:var(--dim);margin-bottom:40px;}
.stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);margin-bottom:40px;}
.stat-cell{background:var(--bg2);padding:24px 20px;}
.stat-num{font-family:'Bebas Neue',sans-serif;font-size:2.4rem;line-height:1;color:var(--accent);margin-bottom:4px;}
.stat-num.r{color:var(--red);}
.stat-label{font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:var(--dim);}
.section{margin-bottom:40px;}
.section-hdr{display:flex;align-items:baseline;gap:16px;margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid var(--border);}
.sh-num{font-size:10px;letter-spacing:0.2em;color:var(--dim);}
.sh-title{font-family:'Barlow Condensed',sans-serif;font-size:11px;font-weight:500;letter-spacing:0.28em;text-transform:uppercase;color:var(--muted);}
.sh-line{flex:1;height:1px;background:var(--border);}
table{width:100%;border-collapse:collapse;background:var(--bg2);}
th{font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:var(--dim);padding:12px 16px;text-align:left;border-bottom:1px solid var(--border2);}
td{padding:14px 16px;border-bottom:1px solid var(--border);color:var(--muted);font-size:12px;vertical-align:middle;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:var(--bg3);}
.badge{display:inline-block;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;padding:3px 10px;border:1px solid;}
.badge.ok{color:var(--accent);border-color:rgba(0,255,65,0.25);background:rgba(0,255,65,0.05);}
.badge.err{color:var(--red);border-color:rgba(184,64,64,0.25);background:rgba(184,64,64,0.05);}
.badge.info{color:var(--muted);border-color:var(--border2);}
.badge.warn{color:#d4a800;border-color:rgba(212,168,0,0.25);background:rgba(212,168,0,0.05);}
.btn{display:inline-flex;align-items:center;gap:8px;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:var(--text);background:none;border:1px solid var(--border2);padding:8px 16px;cursor:pointer;transition:border-color 0.2s,color 0.2s;text-decoration:none;}
.btn:hover{border-color:var(--accent);color:var(--accent);}
.btn.primary{background:var(--accent);color:#0a0a08;border-color:var(--accent);}
.btn.primary:hover{background:var(--accent2);border-color:var(--accent2);color:#fff;}
.btn.danger{border-color:rgba(184,64,64,0.4);color:var(--red);}
.btn.danger:hover{border-color:var(--red);background:rgba(184,64,64,0.06);}
.alert{padding:12px 16px;border:1px solid;font-size:11px;letter-spacing:0.08em;margin-bottom:20px;}
.alert.ok{color:var(--accent);border-color:rgba(0,255,65,0.25);background:rgba(0,255,65,0.05);}
.alert.err{color:var(--red);border-color:rgba(184,64,64,0.25);background:rgba(184,64,64,0.05);}
.form-wrap{background:var(--bg2);border:1px solid var(--border2);padding:32px;}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 32px;}
.form-group{display:flex;flex-direction:column;gap:6px;margin-bottom:24px;}
.form-group.full{grid-column:1/-1;}
.form-label{font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:var(--dim);}
.form-label .req{color:var(--red);}
.form-input,.form-select,.form-textarea{background:var(--bg);border:1px solid var(--border2);color:var(--text);font-family:'DM Mono',monospace;font-size:12px;letter-spacing:0.06em;padding:10px 14px;outline:none;transition:border-color 0.2s;width:100%;}
.form-input:focus,.form-select:focus,.form-textarea:focus{border-color:var(--accent);}
.form-input::placeholder,.form-textarea::placeholder{color:var(--dim);}
.form-textarea{resize:vertical;min-height:80px;}
.form-select{cursor:pointer;-webkit-appearance:none;}
.form-hint{font-size:9px;letter-spacing:0.1em;color:var(--dim);margin-top:4px;}
.form-section{margin-bottom:32px;padding-bottom:32px;border-bottom:1px solid var(--border);}
.form-section:last-of-type{border-bottom:none;}
.form-section-title{font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:var(--muted);margin-bottom:20px;}
.form-actions{display:flex;gap:12px;padding-top:20px;border-top:1px solid var(--border);}
.narrative-block{background:var(--bg3);border:1px solid var(--border);padding:20px;margin-bottom:12px;}
.narrative-block-title{font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:var(--accent2);margin-bottom:14px;}
.code-block{background:var(--bg3);border:1px solid var(--border2);padding:20px 24px;font-family:'DM Mono',monospace;font-size:12px;color:var(--accent);letter-spacing:0.06em;line-height:2;white-space:pre;overflow-x:auto;}
/* ── AUTH PAGES (yellow warning zone) ── */
.auth-wrap{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;position:relative;z-index:1;}
.auth-card{width:100%;max-width:440px;border:1px solid var(--auth-border);background:var(--bg2);padding:48px 40px 40px;position:relative;}
.auth-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:var(--auth-accent);}
.auth-eyebrow{font-family:'Barlow Condensed',sans-serif;font-size:9px;letter-spacing:0.28em;text-transform:uppercase;color:var(--auth-accent);margin-bottom:16px;}
.auth-title{font-family:'Bebas Neue',sans-serif;font-size:56px;line-height:0.9;color:var(--text);margin-bottom:4px;}
.auth-sub{font-family:'Barlow Condensed',sans-serif;font-weight:300;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);margin-bottom:32px;}
.auth-warning{display:flex;align-items:center;gap:10px;border:1px solid var(--auth-border2);background:var(--auth-glow-dim);padding:10px 14px;margin-bottom:28px;}
.auth-warning-dot{width:6px;height:6px;border-radius:50%;background:var(--auth-accent);box-shadow:0 0 6px var(--auth-accent);flex-shrink:0;animation:pulse-warn 2s ease-in-out infinite;}
@keyframes pulse-warn{0%,100%{opacity:1;box-shadow:0 0 6px var(--auth-accent);}50%{opacity:0.6;box-shadow:0 0 14px var(--auth-accent3);}}
.auth-warning-text{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.16em;text-transform:uppercase;color:var(--auth-accent);}
.auth-field{display:flex;flex-direction:column;gap:6px;margin-bottom:20px;}
.auth-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:var(--dim);}
.auth-input{background:transparent;border:none;border-bottom:1px solid var(--border2);padding:10px 0;font-family:'DM Mono',monospace;font-size:13px;color:var(--text);outline:none;transition:border-color 0.2s;width:100%;}
.auth-input::placeholder{color:var(--dim);}
.auth-input:focus{border-bottom-color:var(--auth-accent);}
.auth-input-code{font-size:28px;letter-spacing:0.35em;text-align:center;}
.auth-submit{width:100%;background:var(--auth-accent);color:#0a0a08;border:none;font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;padding:14px 20px;cursor:pointer;transition:background 0.2s;margin-top:8px;}
.auth-submit:hover{background:var(--auth-accent3);color:#0a0a08;}
.auth-error{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.14em;color:var(--red);border:1px solid rgba(184,64,64,0.3);padding:10px 14px;margin-top:16px;}
.auth-back{display:block;text-align:center;margin-top:24px;font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.14em;color:var(--dim);text-decoration:none;transition:color 0.2s;}
.auth-back:hover{color:var(--auth-accent);}
.auth-qr-frame{text-align:center;margin-bottom:20px;background:#fff;padding:16px;display:inline-block;width:100%;box-sizing:border-box;}
.auth-qr-frame img{width:160px;height:160px;display:block;margin:0 auto;}
.auth-secret{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.18em;color:var(--auth-accent);text-align:center;margin-bottom:24px;border:1px solid var(--auth-border2);padding:10px 14px;background:var(--auth-glow-dim);word-break:break-all;}
.auth-secret-label{display:block;font-size:8px;letter-spacing:0.2em;color:var(--dim);margin-bottom:6px;text-transform:uppercase;}
@media(max-width:768px){.stat-row{grid-template-columns:1fr 1fr;}.wrap{padding:72px 20px 40px;}.form-grid{grid-template-columns:1fr;}.auth-card{padding:36px 24px 32px;}.auth-wrap{padding:40px 20px;}}
`;

const AUTH_SVG = `<div class="accent-lines" aria-hidden="true">
  <svg viewBox="0 0 600 900" fill="none" preserveAspectRatio="xMaxYMid slice">
    <line x1="580" y1="0" x2="20" y2="900" stroke="rgba(212,160,23,0.07)" stroke-width="1"/>
    <line x1="540" y1="0" x2="0" y2="760" stroke="rgba(212,160,23,0.05)" stroke-width="0.5"/>
    <circle cx="540" cy="180" r="60"  stroke="rgba(212,160,23,0.06)"  stroke-width="1"   fill="none"/>
    <circle cx="540" cy="180" r="90"  stroke="rgba(212,160,23,0.04)"  stroke-width="0.5" fill="none"/>
    <circle cx="540" cy="180" r="130" stroke="rgba(212,160,23,0.025)" stroke-width="0.5" fill="none"/>
  </svg>
</div>`;

// ── LAYOUT (dashboard — green accent) ─────────────────────────────────────────
function layout(title, activeTab, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${esc(title)} · Conduit</title>${FONTS}<style>${CSS}</style></head><body>
<div class="grid-bg"></div>
<nav>
  <a href="${BASE}/" class="nav-logo">Vectra<span>&nbsp;</span>Arch · Conduit</a>
  <div class="nav-tabs">
    <a href="${BASE}/"      class="nav-tab ${activeTab==='dashboard'?'active':''}">Dashboard</a>
    <a href="${BASE}/sites" class="nav-tab ${activeTab==='sites'?'active':''}">Observatory</a>
    <a href="${BASE}/users" class="nav-tab ${activeTab==='users'?'active':''}">Users</a>
  </div>
  <div class="nav-right">
    <div class="nav-status">HUB · LIVE</div>
    <a href="${FORGE_URL}" class="nav-link" target="_blank">Forge ↗</a>
    <a href="${BASE}/logout" class="nav-link">Logout</a>
  </div>
</nav>
<div class="wrap">${body}</div>
</body></html>`;
}

// ── AUTH PAGE FUNCTIONS (yellow warning zone) ─────────────────────────────────
function loginPage(err) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Conduit · Access</title>${FONTS}<style>${CSS}</style></head><body>
<div class="grid-bg"></div>${AUTH_SVG}
<div class="auth-wrap">
  <div class="auth-card">
    <div class="auth-eyebrow">§ Vectra Arch · Conduit Hub</div>
    <div class="auth-title">Access</div>
    <div class="auth-sub">Automation &amp; Social Hub · Authorised Entry Only</div>
    <div class="auth-warning"><div class="auth-warning-dot"></div><span class="auth-warning-text">Restricted · Authorised Personnel Only</span></div>
    <form method="POST" action="${BASE}/login">
      <div class="auth-field"><label class="auth-label">Username</label><input class="auth-input" name="cid" type="text" placeholder="username" autocomplete="username" required autofocus/></div>
      <div class="auth-field"><label class="auth-label">Key</label><input class="auth-input" name="ak" type="password" placeholder="········" autocomplete="current-password" required/></div>
      <button class="auth-submit" type="submit">Authenticate ↗</button>
      ${err?`<div class="auth-error">⚠ ${esc(err)}</div>`:''}
    </form>
    <a href="${FOUNDATION_URL}" class="auth-back">← Back to Forge</a>
  </div>
</div></body></html>`;
}

function twoFAVerifyPage(err) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>2FA · Conduit</title>${FONTS}<style>${CSS}</style></head><body>
<div class="grid-bg"></div>${AUTH_SVG}
<div class="auth-wrap">
  <div class="auth-card">
    <div class="auth-eyebrow">§ Vectra Arch · Conduit · 2FA</div>
    <div class="auth-title">Verify</div>
    <div class="auth-sub">vectraarch.live/conduit · Identity Confirmation</div>
    <div class="auth-warning"><div class="auth-warning-dot"></div><span class="auth-warning-text">2FA Required · Authorised Access Only</span></div>
    ${err?`<div class="auth-error">⚠ ${esc(err)}</div>`:''}
    <form method="POST" action="${BASE}/auth/2fa">
      <div class="auth-field"><label class="auth-label">Authentication Code</label><input class="auth-input auth-input-code" name="token" type="text" placeholder="000000" maxlength="6" autocomplete="one-time-code" required autofocus/></div>
      <button class="auth-submit" type="submit">Verify ↗</button>
    </form>
    <a href="${FOUNDATION_URL}" class="auth-back">← Back to Forge</a>
  </div>
</div></body></html>`;
}

async function twoFASetupPage(qr, secret, err) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Setup 2FA · Conduit</title>${FONTS}<style>${CSS}</style></head><body>
<div class="grid-bg"></div>${AUTH_SVG}
<div class="auth-wrap">
  <div class="auth-card">
    <div class="auth-eyebrow">§ Vectra Arch · Conduit · Security</div>
    <div class="auth-title">Enable 2FA</div>
    <div class="auth-sub">vectraarch.live/conduit · Link Your Authenticator</div>
    <div class="auth-warning"><div class="auth-warning-dot"></div><span class="auth-warning-text">Security Setup · Keep This Key Private</span></div>
    ${qr?`<div class="auth-qr-frame"><img src="${qr}" alt="QR Code"/></div>`:''}
    <div class="auth-secret"><span class="auth-secret-label">Manual key — enter in your authenticator app</span>${esc(secret||'')}</div>
    ${err?`<div class="auth-error">⚠ ${esc(err)}</div>`:''}
    <form method="POST" action="${BASE}/auth/2fa/setup">
      <div class="auth-field"><label class="auth-label">Confirm Code</label><input class="auth-input auth-input-code" name="token" type="text" placeholder="000000" maxlength="6" autocomplete="one-time-code" required autofocus/></div>
      <button class="auth-submit" type="submit">Activate 2FA ↗</button>
    </form>
    <a href="${BASE}/" class="auth-back">← Cancel</a>
  </div>
</div></body></html>`;
}

// ── AUTH ROUTES ───────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.conduitUser) return res.redirect('/');
  res.send(loginPage());
});

app.post(BASE + '/login', async (req, res) => {
  const { cid, ak } = req.body;
  try {
    const r = await pool.query(
      `SELECT * FROM public.users WHERE LOWER(name)=LOWER($1) AND password=$2 AND role='admin' AND status='enabled'`,
      [cid||'', ak||'']
    );
    if (r.rows[0]?.status === 'enabled') {
      req.session.conduitUser = { id: r.rows[0].id, name: r.rows[0].name };
      await pool.query('UPDATE users SET logins=logins+1, last_login=$1 WHERE id=$2',
        [new Date().toLocaleString('en-ZA'), r.rows[0].id]);
      if (r.rows[0].twofa_secret) {
        req.session.needs2FA = true;
        return res.redirect(BASE + '/auth/2fa');
      }
      return res.redirect(BASE + '/');
    }
    res.send(loginPage('Invalid credentials'));
  } catch (e) {
    console.error('[conduit] Login error:', e);
    res.send(loginPage('System error — try again'));
  }
});

app.get(BASE + '/logout', (req, res) => {
  req.session.destroy();
  res.redirect(FOUNDATION_URL);
});

// ── 2FA ROUTES ────────────────────────────────────────────────────────────────
app.get(BASE + '/auth/2fa', (req, res) => {
  if (!req.session.conduitUser) return res.redirect('/login');
  if (!req.session.needs2FA)    return res.redirect('/');
  res.send(twoFAVerifyPage());
});

app.post(BASE + '/auth/2fa', async (req, res) => {
  if (!req.session.conduitUser) return res.redirect('/login');
  const u = await pool.query('SELECT twofa_secret FROM users WHERE id=$1', [req.session.conduitUser.id]);
  const secret = u.rows[0]?.twofa_secret;
  if (!secret) { delete req.session.needs2FA; return res.redirect(BASE + '/'); }
  try {
    if (verify({ token: req.body.token||'', secret })) {
      delete req.session.needs2FA;
      return res.redirect(BASE + '/');
    }
    res.send(twoFAVerifyPage('Invalid code — try again'));
  } catch { delete req.session.needs2FA; res.redirect(BASE + '/'); }
});

app.get(BASE + '/auth/2fa/setup', isAuth, async (req, res) => {
  const u = await pool.query('SELECT twofa_secret FROM users WHERE id=$1', [req.session.conduitUser.id]);
  if (u.rows[0]?.twofa_secret) return res.redirect(BASE + '/');
  const secret = generateSecret();
  req.session.tempSecret = secret;
  const qr = await qrcode.toDataURL(generateURI({ secret, label: req.session.conduitUser.id, issuer: 'ConduitHub' }));
  res.send(await twoFASetupPage(qr, secret));
});

app.post(BASE + '/auth/2fa/setup', isAuth, async (req, res) => {
  if (!req.session.tempSecret) return res.redirect(BASE + '/');
  if (verify({ token: req.body.token||'', secret: req.session.tempSecret })) {
    await pool.query('UPDATE users SET twofa_secret=$1 WHERE id=$2', [req.session.tempSecret, req.session.conduitUser.id]);
    delete req.session.tempSecret;
    req.session.flash = { type:'ok', msg:'✓ Two-factor authentication enabled' };
    return res.redirect(BASE + '/');
  }
  const qr = await qrcode.toDataURL(generateURI({ secret: req.session.tempSecret, label: req.session.conduitUser.id, issuer: 'ConduitHub' }));
  res.send(await twoFASetupPage(qr, req.session.tempSecret, 'Invalid code — try again'));
});

app.post(BASE + '/auth/2fa/disable', isAuth, async (req, res) => {
  await pool.query('UPDATE users SET twofa_secret=NULL WHERE id=$1', [req.session.conduitUser.id]);
  req.session.flash = { type:'ok', msg:'✓ Two-factor authentication disabled' };
  res.redirect(BASE + '/');
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get(BASE + '/', isAuth, async (req, res) => {
  const flash = req.session.flash; delete req.session.flash;

  // Check 2FA status for current user
  const userRow  = await pool.query('SELECT twofa_secret FROM users WHERE id=$1', [req.session.conduitUser.id]);
  const has2FA   = !!userRow.rows[0]?.twofa_secret;

  // All published books with author name (from VectraArchForge)
  const books = await forgePool.query(`
    SELECT b.id, b.title, u.name AS author_name
    FROM books b
    JOIN users u ON b.owner_id = u.id
    WHERE b.published = true
    ORDER BY u.name ASC, b.title ASC
  `);

  // Last announcement per book (from VectraArchConduit log)
  const announcements = await pool.query(
    `SELECT payload, MAX(created) AS last_announced FROM conduit_log
     WHERE event='announcement' GROUP BY payload`
  );
  const announcedMap = {};
  announcements.rows.forEach(r => { announcedMap[r.payload] = r.last_announced; });
  books.rows.forEach(b => { b.last_announced = announcedMap[b.id] || null; });

  // Last 20 log events
  const logs = await pool.query(
    'SELECT id,event,payload,status,created FROM conduit_log ORDER BY created DESC LIMIT 20'
  );

  const bookRows = books.rows.map(b => `
    <tr>
      <td style="color:var(--text)">${esc(b.title)}</td>
      <td>${esc(b.author_name)}</td>
      <td><span class="badge ok">Published</span></td>
      <td style="font-size:10px;color:var(--dim)">${b.last_announced ? new Date(b.last_announced).toLocaleString('en-ZA') : '—'}</td>
      <td>
        <form method="POST" action="${BASE}/announce" style="display:inline;">
          <input type="hidden" name="book_id"     value="${esc(b.id)}"/>
          <input type="hidden" name="book_title"  value="${esc(b.title)}"/>
          <input type="hidden" name="author_name" value="${esc(b.author_name)}"/>
          <button class="btn" type="submit">Post ↗</button>
        </form>
      </td>
    </tr>`).join('');

  const logRows = logs.rows.map(l => `
    <tr>
      <td style="font-size:10px;">${new Date(l.created).toLocaleString('en-ZA')}</td>
      <td><span class="badge ${l.status==='ok'?'ok':'err'}">${esc(l.event)}</span></td>
      <td style="font-size:11px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(l.payload||'')}</td>
      <td><span class="badge ${l.status==='ok'?'ok':'err'}">${esc(l.status)}</span></td>
    </tr>`).join('');

  const body = `
    <div class="page-title">Conduit</div>
    <div class="page-sub">§ Automation &amp; Social Hub · bookforge DB · VectraArch</div>
    ${flash?`<div class="alert ${flash.type}">${esc(flash.msg)}</div>`:''}

    <div class="stat-row">
      <div class="stat-cell"><div class="stat-num">${books.rows.length}</div><div class="stat-label">Published Volumes</div></div>
      <div class="stat-cell"><div class="stat-num">${logs.rows.filter(l=>l.event==='announcement').length}</div><div class="stat-label">Announcements Sent</div></div>
      <div class="stat-cell"><div class="stat-num">${logs.rows.filter(l=>l.status==='ok').length}</div><div class="stat-label">Successful Events</div></div>
      <div class="stat-cell"><div class="stat-num r">${logs.rows.filter(l=>l.status==='err').length}</div><div class="stat-label">Failed Events</div></div>
    </div>

    <div class="section">
      <div class="section-hdr"><span class="sh-num">00</span><span class="sh-title">Your Account · Two-Factor Authentication</span><div class="sh-line"></div></div>
      <div style="background:var(--bg2);border:1px solid var(--border2);padding:24px 28px;display:flex;align-items:center;justify-content:space-between;gap:20px;">
        <div>
          <div style="font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:15px;letter-spacing:0.06em;text-transform:uppercase;color:var(--text);margin-bottom:6px;">
            2FA: <span style="color:${has2FA?'var(--accent)':'var(--red)'};">${has2FA?'Enabled':'Disabled'}</span>
          </div>
          <div style="font-size:11px;color:var(--dim);letter-spacing:0.08em;">
            ${has2FA?'Your account is protected with two-factor authentication.':'Enable 2FA for an additional layer of security.'}
          </div>
        </div>
        <div>${has2FA
          ? `<form method="POST" action="${BASE}/auth/2fa/disable" data-confirm="Disable two-factor authentication on this account?"><button class="btn danger" type="submit">Disable 2FA</button></form>`
          : `<a href="${BASE}/auth/2fa/setup" class="btn primary">Enable 2FA ↗</a>`}
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-hdr"><span class="sh-num">01</span><span class="sh-title">Published Volumes · Post Announcement</span><div class="sh-line"></div></div>
      ${books.rows.length === 0
        ? '<div style="padding:32px;background:var(--bg2);color:var(--dim);text-align:center;letter-spacing:0.1em;">No published volumes in bookforge</div>'
        : `<table><thead><tr><th>Title</th><th>Author</th><th>Status</th><th>Last Announced</th><th>Action</th></tr></thead><tbody>${bookRows}</tbody></table>`}
    </div>

    <div class="section">
      <div class="section-hdr">
        <span class="sh-num">02</span><span class="sh-title">Trigger Log · Last 20 Events</span><div class="sh-line"></div>
        <form method="POST" action="${BASE}/log/clear" data-confirm="Permanently delete all event log entries?" style="margin-left:auto;">
          <button class="btn danger" type="submit">Clear Log</button>
        </form>
      </div>
      ${logs.rows.length === 0
        ? '<div style="padding:32px;background:var(--bg2);color:var(--dim);text-align:center;letter-spacing:0.1em;">No events logged yet</div>'
        : `<table><thead><tr><th>Time</th><th>Event</th><th>Payload</th><th>Status</th></tr></thead><tbody>${logRows}</tbody></table>`}
    </div>`;

  res.send(layout('Dashboard', 'dashboard', body));
});

// ── ANNOUNCE ──────────────────────────────────────────────────────────────────
app.post(BASE + '/announce', isAuth, async (req, res) => {
  const { book_id, book_title, author_name } = req.body;
  const text = `📖 New Publication · Vectra Arch Press\n\n"${book_title}"\nby ${author_name}\n\nRead it now → ${PRESS_URL}`;
  try {
    const tgRes = await postTelegram(text);
    await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
      ['announcement', `book_id:${book_id} title:${book_title} author:${author_name}`, tgRes.ok?'ok':'err']);
    req.session.flash = { type:'ok', msg:`✓ Announcement posted for "${book_title}"` };
  } catch (e) {
    await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
      ['announcement', `book_id:${book_id} ERROR:${e.message}`, 'err']);
    req.session.flash = { type:'err', msg:`✗ Failed: ${e.message}` };
  }
  res.redirect(BASE + '/');
});

app.post(BASE + '/log/clear', isAuth, async (req, res) => {
  await pool.query('DELETE FROM conduit_log');
  req.session.flash = { type:'ok', msg:'✓ Log cleared' };
  res.redirect(BASE + '/');
});

// ── OBSERVATORY ───────────────────────────────────────────────────────────────
app.get(BASE + '/sites', isAuth, async (req, res) => {
  const flash    = req.session.flash; delete req.session.flash;
  const [pm2List, dbs] = await Promise.all([
    getPM2List(),
    discoverDatabases(),                     // live pg introspection
  ]);
  const sites    = discoverSites();          // live filesystem scan
  const apiByApp = discoverApiRoutes();      // live source-file parse
  const apiTotal = Object.values(apiByApp).reduce((s,r)=>s+r.length, 0);
  const dbTotalTables  = dbs.reduce((s,d)=>s+d.tables.length, 0);
  const dbTotalBytes   = dbs.reduce((s,d)=>s+d.totalBytes, 0);

  // Quick lookup: pm2 name -> online?
  const pm2Status = Object.fromEntries(pm2List.map(p => [p.name, p.status]));

  const pm2Rows = pm2List.map(p => `
    <tr>
      <td style="color:var(--text);font-weight:500">${esc(p.name)}</td>
      <td><span class="badge ${p.status==='online'?'ok':'err'}">${esc(p.status)}</span></td>
      <td style="font-size:10px;color:var(--dim)">${p.pid||'—'}</td>
      <td style="font-size:10px;color:var(--dim)">${p.status==='online'?formatUptime(p.uptime):'—'}</td>
      <td style="font-size:10px;color:var(--dim)">${p.restarts}</td>
      <td style="font-size:10px;color:${p.memory>200?'var(--red)':'var(--muted)'}">${p.memory} mb</td>
      <td style="font-size:10px;color:var(--dim)">${p.cpu}%</td>
    </tr>`).join('');

  const siteRows = sites.map(s => {
    const typeBadge = s.type==='static'
      ? `<span class="badge ok">Static</span>`
      : `<span class="badge info">Node.js</span>`;
    return `<tr>
      <td><a href="${esc(s.url)}" target="_blank" style="color:var(--accent);text-decoration:none;">${esc(s.pathLabel)} ↗</a></td>
      <td style="color:var(--text)">${esc(s.label)}</td>
      <td>${typeBadge}</td>
      <td style="color:var(--dim);font-size:11px;">${esc(s.purpose)}</td>
      <td style="font-size:10px;color:var(--dim)">${esc(s.lastModified)}</td>
    </tr>`;
  }).join('');

  const apiSections = Object.entries(apiByApp).map(([appName, endpoints]) => {
    const status = pm2Status[appName];
    const statusBadge = status==='online'
      ? `<span class="badge ok" style="font-size:8px;margin-left:8px;">${esc(status)}</span>`
      : status
      ? `<span class="badge err" style="font-size:8px;margin-left:8px;">${esc(status)}</span>`
      : `<span class="badge warn" style="font-size:8px;margin-left:8px;">not in pm2</span>`;
    const tableRows = endpoints.length
      ? endpoints.map(e=>`<tr>
          <td><span class="badge ${e.method==='GET'?'ok':e.method==='DELETE'?'err':'info'}" style="font-size:8px;">${esc(e.method)}</span></td>
          <td style="font-family:'DM Mono',monospace;font-size:11px;color:var(--text)">${esc(e.path)}</td>
        </tr>`).join('')
      : `<tr><td colspan="2" style="padding:14px;color:var(--dim);font-size:10px;text-align:center;letter-spacing:0.1em">SOURCE NOT FOUND OR NO ROUTES</td></tr>`;
    return `
      <div style="margin-bottom:28px;">
        <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--accent2);margin-bottom:10px;display:flex;align-items:center;">
          ${esc(appName)} ${statusBadge}
          <span style="margin-left:auto;color:var(--dim);font-size:9px;letter-spacing:0.14em;">${endpoints.length} ENDPOINTS</span>
        </div>
        <table><thead><tr><th style="width:80px">Method</th><th>Path</th></tr></thead><tbody>
          ${tableRows}
        </tbody></table>
      </div>`;
  }).join('');

  // ── Databases section ──
  const dbSections = dbs.map(d => {
    if (!d.ok) {
      return `
        <div style="margin-bottom:28px;">
          <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--accent2);margin-bottom:8px;display:flex;align-items:center;">
            ${esc(d.label)}
            <span class="badge err" style="font-size:8px;margin-left:8px;">connect failed</span>
          </div>
          <div style="padding:14px;background:var(--bg2);border:1px solid var(--red);border-radius:4px;color:var(--red);font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.04em;">
            ${esc(d.error)}
          </div>
        </div>`;
    }
    if (d.tables.length === 0) {
      return `
        <div style="margin-bottom:28px;">
          <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--accent2);margin-bottom:8px;">
            ${esc(d.label)}
            <span style="color:var(--dim);margin-left:8px;font-size:9px;">— no tables visible to this role</span>
          </div>
        </div>`;
    }
    const schemaSections = Object.entries(d.bySchema).map(([schema, tables]) => `
      <div style="margin-bottom:12px;">
        <div style="font-size:9px;letter-spacing:0.14em;color:var(--dim);margin-bottom:6px;">SCHEMA · ${esc(schema)}</div>
        <table><thead><tr>
          <th style="width:32%">Table</th>
          <th style="width:80px">Rows</th>
          <th style="width:80px">Size</th>
          <th style="width:90px">Owner</th>
          <th>Columns</th>
        </tr></thead><tbody>
          ${tables.map(t => {
            const cols = (t.columns || []).map(c => {
              const type = (c.type || '').replace(/ without time zone$/, '').replace(/ with time zone$/, 'tz');
              return `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;margin:2px;border-radius:3px;background:var(--bg3);border:1px solid var(--border);font-size:9px;font-family:'DM Mono',monospace;">
                <span style="color:var(--text)">${esc(c.name)}</span>
                <span style="color:var(--dim);font-size:8px;">${esc(type)}</span>
              </span>`;
            }).join('');
            return `<tr>
              <td style="color:var(--text);font-family:'DM Mono',monospace;font-size:11px;vertical-align:top;padding-top:8px;">${esc(t.name)}</td>
              <td style="font-size:10px;color:var(--dim);vertical-align:top;padding-top:8px;">${fmtRows(t.rows)}</td>
              <td style="font-size:10px;color:var(--dim);vertical-align:top;padding-top:8px;">${fmtBytes(parseInt(t.bytes,10))}</td>
              <td style="font-size:9px;color:var(--dim);vertical-align:top;padding-top:8px;">${esc(t.owner||'')}</td>
              <td style="vertical-align:top;padding:4px 8px;">${cols || '<span style="color:var(--dim);font-size:9px;">no columns</span>'}</td>
            </tr>`;
          }).join('')}
        </tbody></table>
      </div>`).join('');
    return `
      <div style="margin-bottom:32px;">
        <div style="display:flex;align-items:baseline;margin-bottom:10px;gap:8px;">
          <div style="font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--accent2);">${esc(d.label)}</div>
          <div style="color:var(--dim);font-size:9px;letter-spacing:0.1em;">${esc(d.purpose)}</div>
          <div style="margin-left:auto;color:var(--dim);font-size:9px;letter-spacing:0.14em;">
            ${d.tables.length} TABLES · ${d.totalCols} COLS · ${fmtBytes(d.totalBytes)} · ~${fmtRows(d.totalRows)} ROWS
          </div>
        </div>
        ${schemaSections}
      </div>`;
  }).join('');

  const body = `
    <div class="page-title">Observatory</div>
    <div class="page-sub">§ Constellation Map · ${sites.length} Sites · ${apiTotal} Endpoints · ${dbTotalTables} Tables · live</div>
    ${flash?`<div class="alert ${flash.type}">${esc(flash.msg)}</div>`:''}

    <div class="section">
      <div class="section-hdr"><span class="sh-num">01</span><span class="sh-title">PM2 Processes · Live Status</span><div class="sh-line"></div></div>
      ${pm2List.length===0
        ? '<div style="padding:24px;background:var(--bg2);color:var(--dim);text-align:center;letter-spacing:0.1em;font-size:10px;">PM2 data unavailable</div>'
        : `<table><thead><tr><th>Name</th><th>Status</th><th>PID</th><th>Uptime</th><th>Restarts</th><th>Memory</th><th>CPU</th></tr></thead><tbody>${pm2Rows}</tbody></table>`}
    </div>

    <div class="section">
      <div class="section-hdr"><span class="sh-num">02</span><span class="sh-title">Constellation · ${sites.length} Sites</span><div class="sh-line"></div></div>
      <table><thead><tr><th>URL</th><th>Label</th><th>Type</th><th>Purpose</th><th>Last Modified</th></tr></thead><tbody>${siteRows}</tbody></table>
    </div>

    <div class="section">
      <div class="section-hdr"><span class="sh-num">03</span><span class="sh-title">API Registry · ${apiTotal} Endpoints · parsed from source</span><div class="sh-line"></div></div>
      ${apiSections}
    </div>

    <div class="section">
      <div class="section-hdr"><span class="sh-num">04</span><span class="sh-title">Databases · ${dbs.length} DBs · ${dbTotalTables} Tables · ${fmtBytes(dbTotalBytes)}</span><div class="sh-line"></div></div>
      ${dbSections}
    </div>`;

  res.send(layout('Observatory', 'sites', body));
});

// ── USERS ─────────────────────────────────────────────────────────────────────
app.get(BASE + '/users', isAuth, async (req, res) => {
  const flash = req.session.flash; delete req.session.flash;

  // ── Forge users ──
  const result = await forgePool.query(`
    SELECT id, name, type, role, status, logins, last_login,
           (twofa_secret IS NOT NULL) AS twofa_enabled,
           CASE WHEN type='Manual' THEN COALESCE(email,'[No email set]') ELSE email END AS display_email
    FROM users ORDER BY last_login DESC NULLS LAST
  `);
  const users = result.rows;

  // ── Legacy users + access list + families ──
  // NB: vectraarchlegacy_users no longer carries activity_status / bio / pronouns /
  // theme / address / forge_user_id (dropped in the cleanup migration). Keep this
  // SELECT to only the columns the Conduit page actually renders.
  let legacyUsers = [], accessList = [], legacyGroups = [];
  try {
    const lr = await legacyPool.query(`
      SELECT u.username, u.first_name, u.last_name, u.display_name, u.email, u.is_admin,
             u.role, u.last_active, u.group_id,
             u.subscription_status, u.subscription_plan, u.subscription_expires_at,
             u.trial_started_at, (u.pf_token IS NOT NULL) AS has_pf_token,
             f.group_name,
             (u.twofa_secret IS NOT NULL) AS twofa_enabled,
             (u.google_id    IS NOT NULL) AS google_linked
      FROM vectraarchlegacy_users u
      LEFT JOIN vectraarchlegacy_groups f ON f.id = u.group_id
      ORDER BY u.last_active DESC NULLS LAST
    `);
    legacyUsers = lr.rows;
    // Payment aggregates are best-effort — a missing table / privilege must not
    // take down the whole user list, so they live in their own try/catch.
    try {
      const pr = await legacyPool.query(`
        SELECT LOWER(username) AS uname, COUNT(*)::int AS payment_count,
               MAX(created_at) FILTER (WHERE payment_status = 'COMPLETE') AS last_paid_at
          FROM vectraarchlegacy_payments GROUP BY LOWER(username)`);
      const pmap = new Map(pr.rows.map(r => [r.uname, r]));
      legacyUsers.forEach(u => {
        const p = pmap.get(u.username.toLowerCase());
        u.payment_count = p ? p.payment_count : 0;
        u.last_paid_at  = p ? p.last_paid_at  : null;
      });
    } catch (e) { console.error('[conduit] Legacy payments aggregate error:', e.message); }
    const ar = await legacyPool.query("SELECT viewer, target, source FROM vectraarchlegacy_access ORDER BY source DESC, viewer");
    accessList = ar.rows;
    const fr = await legacyPool.query(`
      SELECT id, group_name, admin_username,
             (SELECT COUNT(*) FROM vectraarchlegacy_users WHERE group_id = f.id)::int AS member_count
      FROM vectraarchlegacy_groups f ORDER BY id ASC
    `);
    legacyGroups = fr.rows;
  } catch(e) { console.error('[conduit] Legacy DB error:', e.message); }

  const usernames = legacyUsers.map(u => u.username);

  // ── Legacy subscription state (live entitlement per user) ──
  // Decorate every legacy user with the entitlement the paygate actually
  // enforces, then derive headline metrics for the Subscriptions console.
  legacyUsers.forEach(u => { u.ent = legacyEntitlementFor(u); });
  const subMetrics = {
    total:    legacyUsers.length,
    active:   legacyUsers.filter(u => u.ent.status === 'active').length,
    trialing: legacyUsers.filter(u => u.ent.status === 'trial').length,
    expired:  legacyUsers.filter(u => u.ent.status === 'expired').length,
    lifetime: legacyUsers.filter(u => u.ent.status === 'active' && u.subscription_plan === 'lifetime').length,
    mrr: legacyUsers
      .filter(u => u.ent.status === 'active' && u.subscription_plan)
      .reduce((sum, u) => sum + legacyPlanMonthlyValue(u.subscription_plan), 0),
    expiringSoon: legacyUsers.filter(u => u.ent.status === 'trial' && u.ent.daysLeft <= 1).length,
  };
  // Render a status badge for a user's live entitlement.
  const subBadge = (u) => {
    const e = u.ent;
    const cls = e.status === 'active' ? 'ok' : (e.status === 'trial' ? 'warn' : 'err');
    const planLabel = u.subscription_plan && LEGACY_PLANS[u.subscription_plan]
      ? LEGACY_PLANS[u.subscription_plan].label : null;
    const detail = e.status === 'active'
      ? (u.subscription_plan === 'lifetime' ? 'lifetime'
         : (e.daysLeft != null ? `${e.daysLeft}d left` : 'active'))
      : (e.status === 'trial' ? `trial · ${e.daysLeft}d` : (u.subscription_status || 'expired'));
    return `<span class="badge ${cls}" style="font-size:8px;">${esc(e.status)}</span>
      <div style="font-size:9px;color:var(--dim);margin-top:3px;">${esc(detail)}</div>
      ${planLabel?`<div style="font-size:9px;color:var(--dim);">${esc(planLabel)}</div>`:''}`;
  };

  // ── Forge rows ──
  const forgeRows = users.map(u => `
    <tr>
      <td>
        <div style="color:var(--text);font-size:12px;">${esc(u.name)}</div>
        <div style="color:var(--dim);font-size:10px;">${esc(u.display_email)}</div>
        <div style="color:var(--dim);font-size:9px;letter-spacing:0.1em;margin-top:2px;">${esc(u.id)}</div>
      </td>
      <td><span class="badge ${u.type==='Google'?'ok':'info'}">${esc(u.type)}</span></td>
      <td><span class="badge ${u.role==='admin'?'warn':'info'}">${esc(u.role)}</span></td>
      <td><span class="badge ${u.status==='enabled'?'ok':'err'}">${esc(u.status)}</span></td>
      <td style="font-size:10px;color:var(--dim)">${u.logins||0}</td>
      <td style="font-size:10px;color:var(--dim)">${u.last_login||'—'}</td>
      <td><span class="badge ${u.twofa_enabled?'ok':'info'}">${u.twofa_enabled?'On':'Off'}</span></td>
      <td style="white-space:nowrap;">
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn" onclick="toggleEdit('forge_${esc(u.id)}')" type="button">Edit</button>
          ${u.twofa_enabled?`<form method="POST" action="${BASE}/users/reset-2fa/${encodeURIComponent(u.id)}" data-confirm="Reset two-factor for ${esc(u.name)}? They'll have to enrol again." style="display:inline;">
            <button class="btn" type="submit">2FA ✕</button></form>`:''}
          <form method="POST" action="${BASE}/users/toggle/${encodeURIComponent(u.id)}" style="display:inline;">
            <input type="hidden" name="status" value="${u.status==='enabled'?'disabled':'enabled'}"/>
            <button class="btn ${u.status==='enabled'?'danger':''}" type="submit">${u.status==='enabled'?'Disable':'Enable'}</button>
          </form>
          ${u.id!==req.session.conduitUser.id?`<form method="POST" action="${BASE}/users/delete/${encodeURIComponent(u.id)}" data-confirm="Permanently delete Forge user '${esc(u.name)}' and all their books? This cannot be undone." style="display:inline;">
            <button class="btn danger" type="submit">Delete</button></form>`
          :'<span style="font-size:9px;color:var(--dim);padding:8px 0;">(you)</span>'}
        </div>
        <div id="edit-forge_${esc(u.id)}" style="display:none;margin-top:12px;background:var(--bg3);border:1px solid var(--border2);padding:16px;">
          <form method="POST" action="${BASE}/users/edit/${encodeURIComponent(u.id)}">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
              <div><div class="form-label" style="margin-bottom:4px;">Name</div>
                <input class="form-input" name="name" value="${esc(u.name)}" required/></div>
              <div><div class="form-label" style="margin-bottom:4px;">Role</div>
                <select class="form-select" name="role">
                  <option value="user" ${u.role==='user'?'selected':''}>User</option>
                  <option value="admin" ${u.role==='admin'?'selected':''}>Admin</option>
                </select></div>
              ${u.type==='Manual'?`
              <div><div class="form-label" style="margin-bottom:4px;">Email</div>
                <input class="form-input" name="email" type="email" value="${esc(u.display_email==='[No email set]'?'':u.display_email)}"/></div>
              <div><div class="form-label" style="margin-bottom:4px;">New Password</div>
                <input class="form-input" name="password" type="password" placeholder="leave blank to keep"/></div>`
              :'<div></div><div></div>'}
            </div>
            <div style="display:flex;gap:8px;">
              <button class="btn primary" type="submit">Save</button>
              <button class="btn" type="button" onclick="toggleEdit('forge_${esc(u.id)}')">Cancel</button>
            </div>
          </form>
        </div>
      </td>
    </tr>`).join('');

  // ── Legacy rows ──
  const legacyRows = legacyUsers.map(u => `
    <tr>
      <td>
        <div style="color:var(--text);font-size:12px;font-weight:600;">${esc(u.username)}</div>
        ${u.first_name||u.last_name?`<div style="color:var(--dim);font-size:10px;">${esc([u.first_name,u.last_name].filter(Boolean).join(' '))}</div>`:''}
        ${u.display_name&&u.display_name!==u.username?`<div style="color:var(--dim);font-size:9px;letter-spacing:0.05em;">${esc(u.display_name)}</div>`:''}
      </td>
      <td style="font-size:11px;color:var(--dim)">${esc(u.email||'—')}</td>
      <td><span class="badge ${u.is_admin?'warn':'info'}">${u.is_admin?'Admin':'User'}</span></td>
      <td>
        ${u.role?`<span class="badge info" style="font-size:8px;">${esc(u.role.toUpperCase())}</span>`:''}
        ${u.google_linked?`<span class="badge ok" style="font-size:8px;margin-left:4px;">Google</span>`:''}
      </td>
      <td>
        ${u.group_name
          ? `<div style="font-size:11px;color:var(--text)">${esc(u.group_name)}</div>
             <div style="font-size:9px;color:var(--dim)">#${u.group_id}</div>`
          : '<span class="badge err" style="font-size:8px;">no group</span>'}
        <form method="POST" action="${BASE}/users/legacy/move-group/${encodeURIComponent(u.username)}" style="display:flex;gap:4px;margin-top:6px;align-items:center;">
          <select name="groupId" class="form-input" style="font-size:10px;padding:3px 6px;height:auto;width:auto;flex:1;">
            ${legacyGroups.map(f=>`<option value="${f.id}" ${f.id===u.group_id?'selected':''}>${esc(f.group_name)} (${f.member_count})</option>`).join('')}
          </select>
          <button class="btn" type="submit" style="font-size:9px;padding:3px 8px;">Move</button>
        </form>
      </td>
      <td style="white-space:nowrap;">
        ${subBadge(u)}
        ${u.payment_count?`<div style="font-size:9px;color:var(--dim);">${u.payment_count} pmt${u.payment_count===1?'':'s'}</div>`:''}
        <div style="display:flex;gap:4px;margin-top:6px;align-items:center;">
          <form method="POST" action="${BASE}/users/legacy/sub/extend" style="display:flex;gap:3px;align-items:center;">
            <input type="hidden" name="username" value="${esc(u.username)}"/>
            <input name="days" type="number" min="1" value="30" class="form-input" style="font-size:9px;padding:3px 5px;height:auto;width:48px;"/>
            <button class="btn" type="submit" style="font-size:9px;padding:3px 8px;">Extend</button>
          </form>
          <form method="POST" action="${BASE}/users/legacy/sub/cancel" data-confirm="End '${esc(u.username)}' subscription now? Their access is revoked immediately." style="display:inline;">
            <input type="hidden" name="username" value="${esc(u.username)}"/>
            <input type="hidden" name="hard" value="true"/>
            <button class="btn danger" type="submit" style="font-size:9px;padding:3px 8px;">End</button>
          </form>
        </div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:6px;">
          <span class="badge ${u.twofa_enabled?'ok':'info'}">${u.twofa_enabled?'ON':'OFF'}</span>
          ${u.twofa_enabled?`<form method="POST" action="${BASE}/users/legacy/toggle-2fa/${encodeURIComponent(u.username)}" data-confirm="Disable two-factor authentication for '${esc(u.username)}'? They will be able to sign in with just their password." style="display:inline;">
            <input type="hidden" name="action" value="disable"/>
            <button class="btn" style="padding:3px 8px;font-size:9px;" type="submit">Disable</button>
          </form>`:'<span style="font-size:9px;color:var(--dim);">—</span>'}
        </div>
      </td>
      <td style="font-size:10px;color:var(--dim)">${u.last_active?new Date(u.last_active).toLocaleString('en-ZA'):'—'}</td>
      <td style="white-space:nowrap;">
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <button class="btn" onclick="toggleEdit('leg_${esc(u.username)}')" type="button">Edit</button>
          ${u.is_admin
            ? `<form method="POST" action="${BASE}/users/legacy/set-admin/${encodeURIComponent(u.username)}" data-confirm="Remove system-admin privileges from '${esc(u.username)}'?" style="display:inline;">
                <input type="hidden" name="isAdmin" value="0"/>
                <button class="btn warn" type="submit" style="font-size:9px;padding:4px 10px;">− Admin</button>
               </form>`
            : `<form method="POST" action="${BASE}/users/legacy/set-admin/${encodeURIComponent(u.username)}" style="display:inline;">
                <input type="hidden" name="isAdmin" value="1"/>
                <button class="btn" type="submit" style="font-size:9px;padding:4px 10px;border-color:var(--warn);color:var(--warn);">+ Admin</button>
               </form>`}
          <form method="POST" action="${BASE}/users/legacy/delete/${encodeURIComponent(u.username)}" data-confirm="Permanently delete Legacy user '${esc(u.username)}' and ALL their finance / calendar / gym / meal data? This cannot be undone." style="display:inline;">
            <button class="btn danger" type="submit">Delete</button>
          </form>
        </div>
        <div id="edit-leg_${esc(u.username)}" style="display:none;margin-top:12px;background:var(--bg3);border:1px solid var(--border2);padding:16px;">
          <form method="POST" action="${BASE}/users/legacy/edit/${encodeURIComponent(u.username)}">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
              <div><div class="form-label" style="margin-bottom:4px;">First Name</div>
                <input class="form-input" name="firstName" value="${esc(u.first_name||'')}" placeholder="First name"/></div>
              <div><div class="form-label" style="margin-bottom:4px;">Last Name</div>
                <input class="form-input" name="lastName" value="${esc(u.last_name||'')}" placeholder="Last name"/></div>
              <div><div class="form-label" style="margin-bottom:4px;">Email</div>
                <input class="form-input" name="email" type="email" value="${esc(u.email||'')}" placeholder="email@address.com"/></div>
              <div><div class="form-label" style="margin-bottom:4px;">New Password</div>
                <input class="form-input" name="password" type="password" placeholder="leave blank to keep"/></div>
              <div><div class="form-label" style="margin-bottom:4px;">System</div>
                <select class="form-select" name="isAdmin">
                  <option value="0" ${(!u.is_admin||u.is_admin===0||u.is_admin==='0')?'selected':''}>User</option>
                  <option value="1" ${(u.is_admin&&u.is_admin!==0&&u.is_admin!=='0')?'selected':''}>Admin</option>
                </select></div>
              <div><div class="form-label" style="margin-bottom:4px;">Role</div>
                <select class="form-select" name="role">
                  ${['individual','partner','parent','guardian','ceo','manager','coach'].map(r=>
                    `<option value="${r}" ${(u.role||'individual')===r?'selected':''}>${r.charAt(0).toUpperCase()+r.slice(1)}</option>`
                  ).join('')}
                </select></div>
            </div>
            <div style="display:flex;gap:8px;">
              <button class="btn primary" type="submit">Save Changes</button>
              <button class="btn" type="button" onclick="toggleEdit('leg_${esc(u.username)}')">Cancel</button>
            </div>
          </form>
        </div>
      </td>
    </tr>`).join('');

  // ── Access pairs ──
  // 'group'-sourced rows are derived from group membership — managed by the
  // Move dropdown above, not editable here (revoke is blocked server-side).
  // 'manual' rows are the only ones an admin grants/revokes by hand here.
  const groupAccess = accessList.filter(a => a.source === 'group');
  const manualAccess = accessList.filter(a => a.source !== 'group');
  const renderAccessRow = (a) => {
    const isGroup = a.source === 'group';
    return `
    <tr>
      <td style="color:var(--text);font-size:11px;">${esc(a.viewer)}</td>
      <td style="color:var(--dim);font-size:12px;">→</td>
      <td style="color:var(--text);font-size:11px;">${esc(a.target)}</td>
      <td><span class="badge ${isGroup?'ok':'info'}" style="font-size:8px;">${isGroup?'group':'manual'}</span></td>
      <td>
        ${isGroup
          ? '<span style="color:var(--dim);font-size:9px;letter-spacing:0.1em;">via Move</span>'
          : `<form method="POST" action="${BASE}/users/legacy/revoke-access" style="display:inline;">
               <input type="hidden" name="viewer" value="${esc(a.viewer)}"/>
               <input type="hidden" name="target" value="${esc(a.target)}"/>
               <button class="btn danger" style="padding:3px 10px;font-size:9px;" type="submit">Revoke</button>
             </form>`}
      </td>
    </tr>`;
  };
  const accessRows = accessList.map(renderAccessRow).join('');

  const usernameOpts = usernames.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');

  const body = `
    <div class="page-title">Users</div>
    <div class="page-sub">§ Forge + Legacy · User Management</div>
    ${flash?`<div class="alert ${flash.type}">${esc(flash.msg)}</div>`:''}

    <div class="stat-row">
      <div class="stat-cell"><div class="stat-num">${users.length}</div><div class="stat-label">Forge Users</div></div>
      <div class="stat-cell"><div class="stat-num">${users.filter(u=>u.role==='admin').length}</div><div class="stat-label">Forge Admins</div></div>
      <div class="stat-cell"><div class="stat-num">${legacyUsers.length}</div><div class="stat-label">Legacy Users</div></div>
      <div class="stat-cell"><div class="stat-num">${legacyUsers.filter(u=>u.is_admin).length}</div><div class="stat-label">Legacy Admins</div></div>
      <div class="stat-cell"><div class="stat-num">${accessList.length}</div><div class="stat-label">Partner Links</div></div>
    </div>

    <!-- ── ADD FORGE USER ── -->
    <div class="section">
      <div class="section-hdr"><span class="sh-num">01</span><span class="sh-title">Add Forge User · bookforge.users</span><div class="sh-line"></div></div>
      <div class="form-wrap" style="padding:24px 32px;">
        <form method="POST" action="${BASE}/users/add">
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr auto;gap:12px;align-items:end;">
            <div class="form-group" style="margin:0;"><label class="form-label">Name <span class="req">*</span></label>
              <input class="form-input" name="name" placeholder="username" required/></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Email</label>
              <input class="form-input" name="email" type="email" placeholder="optional"/></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Password <span class="req">*</span></label>
              <input class="form-input" name="password" type="password" required/></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Role</label>
              <select class="form-select" name="role">
                <option value="user">User</option><option value="admin">Admin</option>
              </select></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Status</label>
              <select class="form-select" name="status">
                <option value="enabled">Enabled</option><option value="disabled">Disabled</option>
              </select></div>
            <button class="btn primary" type="submit" style="padding:10px 20px;">Add ↗</button>
          </div>
        </form>
      </div>
    </div>

    <!-- ── ADD LEGACY USER ── -->
    <div class="section">
      <div class="section-hdr"><span class="sh-num">02</span><span class="sh-title">Add Legacy User · VectraArchLegacy</span><div class="sh-line"></div></div>
      <div class="form-wrap" style="padding:24px 32px;">
        <form method="POST" action="${BASE}/users/legacy/add">
          <div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:12px;align-items:end;margin-bottom:12px;">
            <div class="form-group" style="margin:0;"><label class="form-label">Username <span class="req">*</span></label>
              <input class="form-input" name="username" placeholder="Anel@Koen" required/></div>
            <div class="form-group" style="margin:0;"><label class="form-label">First Name</label>
              <input class="form-input" name="firstName" placeholder="First"/></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Last Name</label>
              <input class="form-input" name="lastName" placeholder="Last"/></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Email</label>
              <input class="form-input" name="email" type="email" placeholder="optional"/></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Password <span class="req">*</span></label>
              <input class="form-input" name="password" type="password" required/></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:12px;align-items:end;">
            <div class="form-group" style="margin:0;"><label class="form-label">Role</label>
              <select class="form-select" name="role">
                <option value="individual">Individual</option>
                <option value="partner">Partner</option>
                <option value="parent">Parent</option>
                <option value="guardian">Guardian</option>
                <option value="ceo">CEO</option>
                <option value="manager">Manager</option>
                <option value="coach">Coach</option>
              </select></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Group</label>
              <select class="form-select" name="groupId">
                <option value="">— Auto-create solo group —</option>
                ${legacyGroups.map(f=>`<option value="${f.id}">${esc(f.group_name)} (${f.member_count})</option>`).join('')}
              </select></div>
            <div class="form-group" style="margin:0;"><label class="form-label">System</label>
              <select class="form-select" name="isAdmin">
                <option value="0">User</option><option value="1">Admin</option>
              </select></div>
            <div class="form-group" style="margin:0;"><label class="form-label">Accent</label>
              <input class="form-input" type="color" name="accentColor" value="#00ff41" style="height:40px;padding:4px;"/></div>
            <button class="btn primary" type="submit" style="padding:10px 20px;">Add ↗</button>
          </div>
        </form>
      </div>
    </div>

    <!-- ── LEGACY FAMILIES ── -->
    <div class="section">
      <div class="section-hdr"><span class="sh-num">02b</span><span class="sh-title">Legacy Families · ${legacyGroups.length} Groups</span><div class="sh-line"></div></div>
      <div class="form-wrap" style="padding:24px 32px;">
        <table style="margin-bottom:18px;">
          <thead><tr><th style="width:40px">#</th><th>Name</th><th>Primary Admin</th><th>Currency</th><th>Members</th><th>Actions</th></tr></thead>
          <tbody>${legacyGroups.map(f=>`
            <tr>
              <td style="font-size:10px;color:var(--dim);">${f.id}</td>
              <td style="color:var(--text);font-weight:500;">${esc(f.group_name)}</td>
              <td style="font-size:11px;color:var(--dim);">${esc(f.admin_username||'—')}</td>
              <td style="font-size:10px;color:var(--dim);">${esc(f.currency||'—')}</td>
              <td><span class="badge ${f.member_count>0?'ok':'info'}">${f.member_count} ${f.member_count===1?'member':'members'}</span></td>
              <td style="white-space:nowrap;">
                <div style="display:flex;gap:6px;align-items:center;">
                  <button class="btn" onclick="toggleEdit('fam_${f.id}')" type="button" style="font-size:9px;padding:4px 10px;">Edit</button>
                  ${f.member_count > 0
                    ? `<button class="btn" disabled title="Move all members out before deleting" style="font-size:9px;padding:4px 10px;opacity:0.4;cursor:not-allowed;">Delete</button>`
                    : `<form method="POST" action="${BASE}/users/legacy/group/delete/${f.id}" data-confirm="Delete group ${esc(f.group_name)}? This cannot be undone." style="display:inline;">
                        <button class="btn danger" type="submit" style="font-size:9px;padding:4px 10px;">Delete</button>
                      </form>`}
                </div>
                <div id="edit-fam_${f.id}" style="display:none;margin-top:10px;background:var(--bg3);border:1px solid var(--border2);padding:12px;text-align:left;">
                  <form method="POST" action="${BASE}/users/legacy/group/edit/${f.id}">
                    <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;margin-bottom:10px;">
                      <div><div class="form-label" style="margin-bottom:4px;">Group Name</div>
                        <input class="form-input" name="groupName" value="${esc(f.group_name)}" required/></div>
                      <div><div class="form-label" style="margin-bottom:4px;">Primary Admin</div>
                        <input class="form-input" name="adminUsername" value="${esc(f.admin_username||'')}" placeholder="username"/></div>
                      <div><div class="form-label" style="margin-bottom:4px;">Currency</div>
                        <select class="form-select" name="currency">
                          ${['ZAR','USD','EUR','GBP','NGN','KES'].map(c=>`<option value="${c}" ${f.currency===c?'selected':''}>${c}</option>`).join('')}
                        </select></div>
                      <div><div class="form-label" style="margin-bottom:4px;">Timezone</div>
                        <input class="form-input" name="timezone" value="${esc(f.timezone||'Africa/Johannesburg')}"/></div>
                    </div>
                    <div style="display:flex;gap:8px;">
                      <button class="btn primary" type="submit" style="font-size:10px;">Save</button>
                      <button class="btn" type="button" onclick="toggleEdit('fam_${f.id}')" style="font-size:10px;">Cancel</button>
                    </div>
                  </form>
                </div>
              </td>
            </tr>`).join('')||'<tr><td colspan="6" style="text-align:center;padding:20px;color:var(--dim);">No families yet</td></tr>'}
          </tbody>
        </table>
        <form method="POST" action="${BASE}/users/legacy/group/create" style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:12px;align-items:end;">
          <div class="form-group" style="margin:0;"><label class="form-label">New group name</label>
            <input class="form-input" name="groupName" placeholder="The Koen Group" required/></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Primary admin (optional)</label>
            <input class="form-input" name="adminUsername" placeholder="Johan@Koen"/></div>
          <div class="form-group" style="margin:0;"><label class="form-label">Currency</label>
            <select class="form-select" name="currency">
              ${['ZAR','USD','EUR','GBP','NGN','KES'].map(c=>`<option value="${c}" ${c==='ZAR'?'selected':''}>${c}</option>`).join('')}
            </select></div>
          <button class="btn primary" type="submit" style="padding:10px 20px;">+ Group</button>
        </form>
      </div>
    </div>

    <!-- ── FORGE USERS TABLE ── -->
    <div class="section">
      <div class="section-hdr"><span class="sh-num">03</span><span class="sh-title">Forge Users · ${users.length} Accounts</span><div class="sh-line"></div></div>
      <table>
        <thead><tr><th>Name / Email / ID</th><th>Type</th><th>Role</th><th>Status</th><th>Logins</th><th>Last Login</th><th>2FA</th><th>Actions</th></tr></thead>
        <tbody>${forgeRows}</tbody>
      </table>
    </div>

    <!-- ── LEGACY USERS TABLE ── -->
    <div class="section">
      <div class="section-hdr"><span class="sh-num">04</span><span class="sh-title">Legacy Users · VectraArchLegacy · ${legacyUsers.length} Accounts</span><div class="sh-line"></div></div>
      ${legacyUsers.length===0
        ? '<div style="padding:24px;background:var(--bg2);color:var(--dim);text-align:center;letter-spacing:0.1em;font-size:10px;">No Legacy users found</div>'
        : `<table>
            <thead><tr><th>Username / Name</th><th>Email</th><th>System</th><th>Role / Auth</th><th>Group</th><th>Subscription</th><th>2FA</th><th>Last Active</th><th>Actions</th></tr></thead>
            <tbody>${legacyRows}</tbody>
           </table>`}
    </div>

    <!-- ── LEGACY SUBSCRIPTIONS CONSOLE ── -->
    <div class="section">
      <div class="section-hdr"><span class="sh-num">04b</span><span class="sh-title">Legacy Subscriptions · VectraArchLegacy · Paygate Console</span><div class="sh-line"></div></div>
      <div class="form-wrap" style="padding:20px 32px 24px;">
        <div class="stat-row" style="margin-bottom:20px;">
          <div class="stat-cell"><div class="stat-num">${subMetrics.active}</div><div class="stat-label">Active</div></div>
          <div class="stat-cell"><div class="stat-num">${subMetrics.trialing}</div><div class="stat-label">On Trial</div></div>
          <div class="stat-cell"><div class="stat-num">${subMetrics.expired}</div><div class="stat-label">Expired</div></div>
          <div class="stat-cell"><div class="stat-num">${subMetrics.lifetime}</div><div class="stat-label">Lifetime</div></div>
          <div class="stat-cell"><div class="stat-num">R${subMetrics.mrr.toFixed(0)}</div><div class="stat-label">MRR</div></div>
          <div class="stat-cell"><div class="stat-num">${subMetrics.expiringSoon}</div><div class="stat-label">Expiring ≤1d</div></div>
        </div>
        <div style="color:var(--dim);font-size:10px;line-height:1.6;margin-bottom:16px;letter-spacing:0.04em;">
          Full subscription management for every Legacy account, written straight to the Legacy DB — the same surface as the in-app admin
          console. <strong>Grant</strong> comps a plan, <strong>Extend</strong> pushes the expiry out by N days, <strong>Reset trial</strong>
          starts a fresh ${LEGACY_TRIAL_DAYS}-day window, <strong>Cancel</strong> stops renewal (keeps access until expiry) and
          <strong>End</strong> revokes access immediately. Trial length: ${LEGACY_TRIAL_DAYS} days.
        </div>
        ${legacyUsers.length===0
          ? '<div style="padding:24px;background:var(--bg2);color:var(--dim);text-align:center;letter-spacing:0.1em;font-size:10px;">No Legacy users found</div>'
          : `<table>
              <thead><tr><th>User</th><th>Status</th><th>Plan</th><th>Expires</th><th>Payments</th><th>Manage</th></tr></thead>
              <tbody>${legacyUsers.map(u=>`
                <tr>
                  <td>
                    <div style="color:var(--text);font-size:12px;font-weight:600;">${esc(u.username)}</div>
                    ${u.email?`<div style="color:var(--dim);font-size:10px;">${esc(u.email)}</div>`:''}
                    ${u.is_admin?'<span class="badge warn" style="font-size:8px;">admin</span>':''}
                  </td>
                  <td>${subBadge(u)}</td>
                  <td style="font-size:10px;color:var(--dim);">${u.subscription_plan&&LEGACY_PLANS[u.subscription_plan]?esc(LEGACY_PLANS[u.subscription_plan].label):'—'}</td>
                  <td style="font-size:10px;color:var(--dim);">${u.subscription_expires_at?new Date(u.subscription_expires_at).toLocaleDateString('en-ZA'):'—'}</td>
                  <td style="font-size:10px;color:var(--dim);">
                    ${u.payment_count||0}
                    ${u.last_paid_at?`<div style="font-size:9px;">${new Date(u.last_paid_at).toLocaleDateString('en-ZA')}</div>`:''}
                  </td>
                  <td style="white-space:nowrap;">
                    <button class="btn" onclick="toggleEdit('sub_${esc(u.username)}')" type="button" style="font-size:9px;padding:4px 10px;">Manage</button>
                    <div id="edit-sub_${esc(u.username)}" style="display:none;margin-top:10px;background:var(--bg3);border:1px solid var(--border2);padding:14px;text-align:left;min-width:360px;">
                      <div class="form-label" style="margin-bottom:6px;font-size:9px;letter-spacing:0.15em;">GRANT / SET PLAN</div>
                      <form method="POST" action="${BASE}/users/legacy/sub/grant" style="display:flex;gap:6px;align-items:end;margin-bottom:12px;">
                        <input type="hidden" name="username" value="${esc(u.username)}"/>
                        <div><div class="form-label" style="margin-bottom:4px;">Plan</div>
                          <select name="plan" class="form-select" style="font-size:10px;">
                            ${Object.entries(LEGACY_PLANS).map(([id,p])=>`<option value="${id}" ${u.subscription_plan===id?'selected':''}>${esc(p.name)} · ${esc(p.label)}</option>`).join('')}
                          </select></div>
                        <div><div class="form-label" style="margin-bottom:4px;">Months</div>
                          <input name="months" type="number" min="1" value="1" class="form-input" style="font-size:10px;width:60px;"/></div>
                        <button class="btn primary" type="submit" style="font-size:10px;">Grant</button>
                      </form>
                      <div class="form-label" style="margin-bottom:6px;font-size:9px;letter-spacing:0.15em;">EXTEND · RESET · STOP</div>
                      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:end;">
                        <form method="POST" action="${BASE}/users/legacy/sub/extend" style="display:flex;gap:4px;align-items:end;">
                          <input type="hidden" name="username" value="${esc(u.username)}"/>
                          <div><div class="form-label" style="margin-bottom:4px;">Days</div>
                            <input name="days" type="number" min="1" value="30" class="form-input" style="font-size:10px;width:60px;"/></div>
                          <button class="btn" type="submit" style="font-size:10px;">Extend</button>
                        </form>
                        <form method="POST" action="${BASE}/users/legacy/sub/trial" style="display:flex;gap:4px;align-items:end;">
                          <input type="hidden" name="username" value="${esc(u.username)}"/>
                          <div><div class="form-label" style="margin-bottom:4px;">Trial days</div>
                            <input name="days" type="number" min="1" value="${LEGACY_TRIAL_DAYS}" class="form-input" style="font-size:10px;width:60px;"/></div>
                          <button class="btn" type="submit" style="font-size:10px;">Reset trial</button>
                        </form>
                        <form method="POST" action="${BASE}/users/legacy/sub/cancel" data-confirm="Cancel renewal for '${esc(u.username)}'? They keep access until the current expiry." style="display:inline;">
                          <input type="hidden" name="username" value="${esc(u.username)}"/>
                          <button class="btn warn" type="submit" style="font-size:10px;">Cancel</button>
                        </form>
                        <form method="POST" action="${BASE}/users/legacy/sub/cancel" data-confirm="End '${esc(u.username)}' subscription now? Access is revoked immediately." style="display:inline;">
                          <input type="hidden" name="username" value="${esc(u.username)}"/>
                          <input type="hidden" name="hard" value="true"/>
                          <button class="btn danger" type="submit" style="font-size:10px;">End now</button>
                        </form>
                      </div>
                    </div>
                  </td>
                </tr>`).join('')}</tbody>
             </table>`}
      </div>
    </div>

    <!-- ── PARTNER SHARING / ACCESS LINKS ── -->
    <div class="section">
      <div class="section-hdr"><span class="sh-num">05</span><span class="sh-title">Partner Sharing · Access Links · ${manualAccess.length} manual · ${groupAccess.length} auto</span><div class="sh-line"></div></div>
      <div class="form-wrap" style="padding:20px 32px 24px;">
        <div style="color:var(--dim);font-size:10px;line-height:1.6;margin-bottom:16px;letter-spacing:0.04em;">
          Most partner sharing is now driven by group membership — every member of a group can see every other member automatically (rows tagged
          <span class="badge ok" style="font-size:8px;">group</span>). Use this section only for one-off cross-group grants
          (rows tagged <span class="badge info" style="font-size:8px;">manual</span>). To change group rows, use the Move dropdown in the user table above.
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
          <div>
            <div class="form-label" style="margin-bottom:12px;font-size:10px;letter-spacing:0.15em;">GRANT MANUAL ACCESS (cross-group)</div>
            <form method="POST" action="${BASE}/users/legacy/grant-access">
              <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end;">
                <div><div class="form-label" style="margin-bottom:4px;">Viewer</div>
                  <select class="form-select" name="viewer"><option value="">— Select —</option>${usernameOpts}</select></div>
                <div><div class="form-label" style="margin-bottom:4px;">Can see →</div>
                  <select class="form-select" name="target"><option value="">— Select —</option>${usernameOpts}</select></div>
                <button class="btn primary" type="submit" style="padding:10px 16px;">Grant ↗</button>
              </div>
            </form>
          </div>
          <div>
            <div class="form-label" style="margin-bottom:12px;font-size:10px;letter-spacing:0.15em;">CURRENT LINKS · ${manualAccess.length} manual + ${groupAccess.length} auto</div>
            ${accessList.length===0
              ? '<div style="color:var(--dim);font-size:10px;padding:8px 0;">No partner links configured.</div>'
              : `<table style="width:100%;">
                  <thead><tr><th>Viewer</th><th></th><th>Target</th><th>Source</th><th>Action</th></tr></thead>
                  <tbody>${accessRows}</tbody>
                 </table>`}
          </div>
        </div>
      </div>
    </div>

    <script>
      // ── Inline-edit toggles ──────────────────────────────────────────────
      function toggleEdit(id){var el=document.getElementById('edit-'+id);if(el)el.style.display=el.style.display==='none'?'block':'none';}

      // ── Collapsible sections: every .section can be opened/closed and the
      //    open/closed state survives across reloads via localStorage. The
      //    .section-hdr stays visible; .section-body underneath is toggled.
      //    The header gets a clear hover state + an obvious chevron button on
      //    the right so it actually looks clickable.
      (function(){
        var KEY = 'conduit.sectionState.v1';
        var state; try { state = JSON.parse(localStorage.getItem(KEY)||'{}'); } catch { state = {}; }
        function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
        function sectionKey(sec) {
          var t = sec.querySelector('.sh-title');
          var n = sec.querySelector('.sh-num');
          return ((n?n.textContent:'') + ' ' + (t?t.textContent:'')).trim().slice(0,80);
        }
        // Inject the styles we need (hover + chevron button look)
        var css = document.createElement('style');
        css.textContent = ''
          + '.section-hdr.clickable{cursor:pointer;user-select:none;transition:background 0.15s,border-color 0.15s;border-radius:3px;padding:6px 8px;margin-left:-8px;margin-right:-8px;}'
          + '.section-hdr.clickable:hover{background:rgba(255,255,255,0.04);}'
          + '.section-hdr.clickable .section-chev{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:4px;border:1px solid var(--border2);background:var(--bg3);color:var(--accent);font-size:11px;transition:transform 0.2s,background 0.15s,border-color 0.15s;}'
          + '.section-hdr.clickable:hover .section-chev{background:var(--bg2);border-color:var(--accent);}'
          + '.section-hdr.clickable .section-chev.collapsed{transform:rotate(-90deg);}'
          + '.section.collapsed .section-hdr{margin-bottom:0;border-bottom-color:transparent;opacity:0.85;}';
        document.head.appendChild(css);
        document.querySelectorAll('.section').forEach(function(sec){
          var hdr = sec.querySelector('.section-hdr');
          if (!hdr) return;
          // Wrap everything after the header in a .section-body if not already
          var body = sec.querySelector('.section-body');
          if (!body) {
            body = document.createElement('div');
            body.className = 'section-body';
            var n; while ((n = hdr.nextSibling)) body.appendChild(n);
            sec.appendChild(body);
          }
          // Chevron indicator — visible "button" on the right edge of the header
          var chev = document.createElement('span');
          chev.className = 'section-chev';
          chev.textContent = '▾';
          chev.setAttribute('aria-label', 'Toggle section');
          hdr.classList.add('clickable');
          hdr.appendChild(chev);
          var k = sectionKey(sec);
          var collapsed = !!state[k];
          function apply() {
            body.style.display = collapsed ? 'none' : '';
            if (collapsed) { chev.classList.add('collapsed'); sec.classList.add('collapsed'); }
            else            { chev.classList.remove('collapsed'); sec.classList.remove('collapsed'); }
          }
          apply();
          hdr.addEventListener('click', function(e){
            // Don't toggle if the click was on a form / input / button inside the header
            if (e.target.closest('form, input, select, textarea, button, a')) return;
            collapsed = !collapsed;
            state[k] = collapsed;
            save();
            apply();
          });
        });
      })();

      // ── Styled confirm modal — replaces native window.confirm() for any
      //    form with [data-confirm="message"]. Submission is held until the
      //    user clicks the Confirm button in the overlay.
      (function(){
        function buildModal(msg, onConfirm) {
          var overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(2px);';
          var sheet = document.createElement('div');
          sheet.style.cssText = 'background:var(--bg2);border:1px solid var(--border2);padding:28px 32px;max-width:420px;width:calc(100% - 40px);text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.5);';
          sheet.innerHTML = ''
            + '<div style="font-size:28px;margin-bottom:14px;">⚠️</div>'
            + '<div style="font-family:Barlow Condensed,sans-serif;font-weight:700;font-size:18px;letter-spacing:0.04em;color:var(--text);margin-bottom:8px;text-transform:uppercase;">Confirm</div>'
            + '<div style="font-family:DM Mono,monospace;font-size:11px;letter-spacing:0.04em;color:var(--dim);line-height:1.7;margin-bottom:24px;"></div>'
            + '<div style="display:flex;gap:10px;">'
              + '<button data-act="cancel" class="btn" style="flex:1;padding:12px;letter-spacing:0.14em;">Cancel</button>'
              + '<button data-act="ok" class="btn danger" style="flex:1;padding:12px;letter-spacing:0.14em;">Confirm</button>'
            + '</div>';
          sheet.querySelector('div:nth-child(3)').textContent = msg;
          overlay.appendChild(sheet);
          document.body.appendChild(overlay);
          function close() { try { document.body.removeChild(overlay); } catch {} }
          sheet.querySelector('[data-act=cancel]').onclick = close;
          sheet.querySelector('[data-act=ok]').onclick = function(){ close(); onConfirm(); };
          overlay.addEventListener('click', function(e){ if (e.target === overlay) close(); });
          document.addEventListener('keydown', function esc(e){ if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
        }
        document.addEventListener('submit', function(e){
          var f = e.target;
          var msg = f.getAttribute && f.getAttribute('data-confirm');
          if (!msg || f.dataset.__conduitConfirmed === '1') return;
          e.preventDefault();
          buildModal(msg, function(){ f.dataset.__conduitConfirmed = '1'; f.submit(); });
        }, true);
      })();
    </script>`;

  res.send(layout('Users', 'users', body));
});

// ── USER ACTION ROUTES ────────────────────────────────────────────────────────
app.post(BASE + '/users/add', isAuth, async (req, res) => {
  const { name, email, password, role, status } = req.body;
  if (!name||!password) {
    req.session.flash = { type:'err', msg:'Name and password required' };
    return res.redirect(BASE + '/users');
  }
  const newId        = 'm_' + Date.now();
  const cleanRole    = role === 'admin' ? 'admin' : 'user';
  const cleanStatus  = status === 'disabled' ? 'disabled' : 'enabled';
  await forgePool.query(
    'INSERT INTO users (id,name,email,password,type,role,status,logins) VALUES ($1,$2,$3,$4,$5,$6,$7,0)',
    [newId, name, email||null, password, 'Manual', cleanRole, cleanStatus]
  );
  await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
    ['user_add', `name:${name} role:${cleanRole} status:${cleanStatus}`, 'ok']);
  req.session.flash = { type:'ok', msg:`✓ User "${name}" created in bookforge (${cleanRole}, ${cleanStatus})` };
  res.redirect(BASE + '/users');
});

app.post(BASE + '/users/edit/:id', isAuth, async (req, res) => {
  const uid = req.params.id;
  const { name, role, email, password } = req.body;
  if (!name) { req.session.flash={type:'err',msg:'Name required'}; return res.redirect(BASE+'/users'); }
  await forgePool.query('UPDATE users SET name=$1,role=$2 WHERE id=$3',
    [name, role==='admin'?'admin':'user', uid]);
  if (email !== undefined) {
    await forgePool.query("UPDATE users SET email=$1 WHERE id=$2 AND type='Manual'", [email||null, uid]);
  }
  if (password && password.trim()) {
    await forgePool.query("UPDATE users SET password=$1 WHERE id=$2 AND type='Manual'", [password.trim(), uid]);
  }
  await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
    ['user_edit', `id:${uid} name:${name}`, 'ok']);
  req.session.flash = { type:'ok', msg:`✓ User "${name}" updated` };
  res.redirect(BASE + '/users');
});

app.post(BASE + '/users/toggle/:id', isAuth, async (req, res) => {
  const uid    = req.params.id;
  const status = req.body.status === 'disabled' ? 'disabled' : 'enabled';
  await forgePool.query('UPDATE users SET status=$1 WHERE id=$2', [status, uid]);
  await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
    ['user_toggle', `id:${uid} status:${status}`, 'ok']);
  req.session.flash = { type:'ok', msg:`✓ User ${status}` };
  res.redirect(BASE + '/users');
});

app.post(BASE + '/users/reset-2fa/:id', isAuth, async (req, res) => {
  await forgePool.query('UPDATE users SET twofa_secret=NULL WHERE id=$1', [req.params.id]);
  await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
    ['user_reset_2fa', `id:${req.params.id}`, 'ok']);
  req.session.flash = { type:'ok', msg:'✓ 2FA reset' };
  res.redirect(BASE + '/users');
});

app.post(BASE + '/users/delete/:id', isAuth, async (req, res) => {
  const uid = req.params.id;
  if (uid === req.session.conduitUser.id) {
    req.session.flash = { type:'err', msg:'Cannot delete your own account' };
    return res.redirect(BASE + '/users');
  }
  const u = await forgePool.query('SELECT name FROM users WHERE id=$1', [uid]);
  const name = u.rows[0]?.name || uid;
  await forgePool.query('DELETE FROM users WHERE id=$1', [uid]);
  await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
    ['user_delete', `id:${uid} name:${name}`, 'ok']);
  req.session.flash = { type:'ok', msg:`✓ User "${name}" deleted from bookforge` };
  res.redirect(BASE + '/users');
});


// ── LEGACY USER MANAGEMENT ROUTES ────────────────────────────────────────────

// POST: Set/unset admin for a Legacy user (quick toggle)
// Move a Legacy user into a different group. Auto-syncs group-sourced access rows
// so every member of the target group becomes mutually visible to the user, and
// group-sourced rows linking to the old group are removed.
app.post(BASE + '/users/legacy/move-group/:username', isAuth, async (req, res) => {
  const { username } = req.params;
  const groupId = parseInt(req.body.groupId, 10);
  if (!groupId) {
    req.session.flash = { type:'err', msg:'groupId required.' };
    return res.redirect(BASE + '/users');
  }
  try {
    // Read old group before update
    const userRow = await legacyPool.query(
      'SELECT group_id FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]
    );
    if (userRow.rowCount === 0) {
      req.session.flash = { type:'err', msg:`User "${username}" not found.` };
      return res.redirect(BASE + '/users');
    }
    const famRow = await legacyPool.query(
      'SELECT id, group_name FROM vectraarchlegacy_groups WHERE id = $1', [groupId]
    );
    if (famRow.rowCount === 0) {
      req.session.flash = { type:'err', msg:`Group #${groupId} not found.` };
      return res.redirect(BASE + '/users');
    }
    const oldGroupId = userRow.rows[0].group_id || null;
    if (oldGroupId === groupId) {
      req.session.flash = { type:'ok', msg:`User is already in "${famRow.rows[0].group_name}".` };
      return res.redirect(BASE + '/users');
    }
    // Update + sync access rows in one client/transaction so a mid-flight crash
    // doesn't leave the access table out of sync with group membership.
    const client = await legacyPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE vectraarchlegacy_users SET group_id = $1 WHERE LOWER(username) = LOWER($2)', [groupId, username]);
      if (oldGroupId) {
        await client.query(`
          DELETE FROM vectraarchlegacy_access
          WHERE source = 'group'
            AND ((viewer = $1 AND target IN (SELECT username FROM vectraarchlegacy_users WHERE group_id = $2))
              OR (target = $1 AND viewer IN (SELECT username FROM vectraarchlegacy_users WHERE group_id = $2)))`,
          [username, oldGroupId]);
      }
      await client.query(`
        INSERT INTO vectraarchlegacy_access (viewer, target, source)
        SELECT $1, u.username, 'group' FROM vectraarchlegacy_users u
        WHERE u.group_id = $2 AND u.username <> $1
        ON CONFLICT (viewer, target) DO NOTHING`, [username, groupId]);
      await client.query(`
        INSERT INTO vectraarchlegacy_access (viewer, target, source)
        SELECT u.username, $1, 'group' FROM vectraarchlegacy_users u
        WHERE u.group_id = $2 AND u.username <> $1
        ON CONFLICT (viewer, target) DO NOTHING`, [username, groupId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK'); throw e;
    } finally { client.release(); }
    try {
      await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
        ['legacy_move_group', `username:${username} group:${groupId}`, 'ok']);
    } catch {}
    req.session.flash = { type:'ok', msg:`✓ "${username}" moved to "${famRow.rows[0].group_name}"` };
  } catch (e) {
    console.error('[conduit] move-group ERROR:', e.message);
    req.session.flash = { type:'err', msg:`DB Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// Create a new Legacy group.
app.post(BASE + '/users/legacy/group/create', isAuth, async (req, res) => {
  const { groupName, adminUsername, currency } = req.body;
  if (!groupName || !groupName.trim()) {
    req.session.flash = { type:'err', msg:'Group name required.' };
    return res.redirect(BASE + '/users');
  }
  const cleanCurrency = ['ZAR','USD','EUR','GBP','NGN','KES'].includes(currency) ? currency : 'ZAR';
  try {
    const r = await legacyPool.query(`
      INSERT INTO vectraarchlegacy_groups
        (group_name, admin_username, currency, timezone, member_count, enabled_modules)
      VALUES ($1, $2, $3, 'Africa/Johannesburg', 0, 'fin,cal,bud,gym,eat,cyc')
      RETURNING id, group_name`,
      [groupName.trim(), adminUsername || 'admin', cleanCurrency]
    );
    req.session.flash = { type:'ok', msg:`✓ Group "${r.rows[0].group_name}" created (#${r.rows[0].id})` };
  } catch (e) {
    console.error('[conduit] group create ERROR:', e.message);
    req.session.flash = { type:'err', msg:`DB Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// POST: Edit an existing group's metadata.
app.post(BASE + '/users/legacy/group/edit/:id', isAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) {
    req.session.flash = { type:'err', msg:'Invalid group id.' };
    return res.redirect(BASE + '/users');
  }
  const { groupName, adminUsername, currency, timezone } = req.body;
  if (!groupName || !groupName.trim()) {
    req.session.flash = { type:'err', msg:'Group name required.' };
    return res.redirect(BASE + '/users');
  }
  const cleanCurrency = ['ZAR','USD','EUR','GBP','NGN','KES'].includes(currency) ? currency : 'ZAR';
  try {
    const r = await legacyPool.query(`
      UPDATE vectraarchlegacy_groups
      SET group_name = $1, admin_username = $2, currency = $3, timezone = $4
      WHERE id = $5
      RETURNING group_name`,
      [groupName.trim(), adminUsername || null, cleanCurrency, timezone || 'Africa/Johannesburg', id]
    );
    if (r.rowCount === 0) {
      req.session.flash = { type:'err', msg:`Group #${id} not found.` };
    } else {
      await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
        ['legacy_group_edit', `id:${id} name:${groupName}`, 'ok']);
      req.session.flash = { type:'ok', msg:`✓ Group #${id} "${r.rows[0].group_name}" updated.` };
    }
  } catch (e) {
    console.error('[conduit] group edit ERROR:', e.message);
    req.session.flash = { type:'err', msg:`DB Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// POST: Delete an empty group. Refuses if the group still has members
// (admin must move them out via the Group dropdown first).
app.post(BASE + '/users/legacy/group/delete/:id', isAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) {
    req.session.flash = { type:'err', msg:'Invalid group id.' };
    return res.redirect(BASE + '/users');
  }
  try {
    const mr = await legacyPool.query(
      'SELECT COUNT(*)::int AS n FROM vectraarchlegacy_users WHERE group_id = $1', [id]
    );
    if (mr.rows[0].n > 0) {
      req.session.flash = { type:'err',
        msg:`⚠ Cannot delete group #${id} — ${mr.rows[0].n} member${mr.rows[0].n===1?'':'s'} still assigned. Move them to another group first.` };
      return res.redirect(BASE + '/users');
    }
    const r = await legacyPool.query(
      'DELETE FROM vectraarchlegacy_groups WHERE id = $1 RETURNING group_name', [id]
    );
    if (r.rowCount === 0) {
      req.session.flash = { type:'err', msg:`Group #${id} not found.` };
    } else {
      await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
        ['legacy_group_delete', `id:${id} name:${r.rows[0].group_name}`, 'ok']);
      req.session.flash = { type:'ok', msg:`✓ Group #${id} "${r.rows[0].group_name}" deleted.` };
    }
  } catch (e) {
    console.error('[conduit] group delete ERROR:', e.message);
    req.session.flash = { type:'err', msg:`DB Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

app.post(BASE + '/users/legacy/set-admin/:username', isAuth, async (req, res) => {
  const { username } = req.params;
  const rawVal   = req.body.isAdmin;
  const adminFlag = (rawVal === '1' || rawVal === 1 || rawVal === true) ? 1 : 0;
  console.log(`[conduit] set-admin: user="${username}" raw="${rawVal}" flag=${adminFlag}`);
  try {
    // Use explicit integer cast to avoid type issues with the pg driver
    const result = await legacyPool.query(
      'UPDATE vectraarchlegacy_users SET is_admin=$1::integer WHERE username=$2 RETURNING username, is_admin',
      [adminFlag, username]
    );
    if (result.rowCount === 0) {
      console.warn(`[conduit] set-admin: no rows updated for username="${username}"`);
      req.session.flash = { type:'err', msg:`User "${username}" not found in Legacy DB` };
    } else {
      console.log(`[conduit] set-admin: updated ${result.rowCount} row(s) — is_admin=${result.rows[0]?.is_admin}`);
      try {
        await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
          ['legacy_set_admin', `username:${username} admin:${adminFlag}`, 'ok']);
      } catch {}
      req.session.flash = { type:'ok', msg:`✓ Admin ${adminFlag ? 'granted to' : 'revoked from'} "${username}"` };
    }
  } catch(e) {
    console.error(`[conduit] set-admin ERROR: ${e.message}`, e);
    req.session.flash = { type:'err', msg:`DB Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});


// POST: Add a new Legacy user. Preserves the username's case (Anel@Koen),
// honours role / group / system-admin / accent inputs, and auto-creates a
// solo group if no existing group was picked.
app.post(BASE + '/users/legacy/add', isAuth, async (req, res) => {
  const { username, firstName, lastName, email, password, isAdmin, role, groupId, accentColor } = req.body;
  if (!username || !password) {
    req.session.flash = { type:'err', msg:'Username and password are required.' };
    return res.redirect(BASE + '/users');
  }
  const cleanUser = username.trim();
  if (!/^[A-Za-z0-9._@-]+$/.test(cleanUser) || cleanUser.length < 3) {
    req.session.flash = { type:'err', msg:'Username must be 3+ chars and only letters / digits / . _ @ -' };
    return res.redirect(BASE + '/users');
  }
  const validRoles = ['individual','partner','parent','guardian','ceo','manager','coach'];
  const cleanRole  = validRoles.includes((role||'').toLowerCase()) ? role.toLowerCase() : 'individual';
  const targetFam  = groupId ? parseInt(groupId, 10) : null;
  const accent     = /^#[0-9A-Fa-f]{6}$/.test(accentColor||'') ? accentColor : '#00ff41';

  const client = await legacyPool.connect();
  try {
    await client.query('BEGIN');
    const bcrypt      = require('bcrypt');
    const hash        = await bcrypt.hash(password, 10);
    const displayName = (firstName && lastName) ? `${firstName} ${lastName}` : cleanUser;
    const adminFlag   = (isAdmin==='1'||isAdmin===true||isAdmin===1) ? 1 : 0;

    // Find or create the target group BEFORE inserting the user, so group_id
    // can be set on the INSERT.
    let useGroupId   = null;
    let useGroupName = null;
    if (targetFam) {
      const fr = await client.query('SELECT id, group_name FROM vectraarchlegacy_groups WHERE id = $1', [targetFam]);
      if (!fr.rows[0]) {
        await client.query('ROLLBACK');
        req.session.flash = { type:'err', msg:`Group #${targetFam} not found.` };
        return res.redirect(BASE + '/users');
      }
      useGroupId   = fr.rows[0].id;
      useGroupName = fr.rows[0].group_name;
    } else {
      const famLabel = firstName || displayName || cleanUser;
      const famName  = cleanRole === 'individual' ? `${famLabel}'s Hub` : `${famLabel}'s Group`;
      const famRes = await client.query(`
        INSERT INTO vectraarchlegacy_groups
          (group_name, admin_username, currency, timezone, member_count, enabled_modules)
        VALUES ($1, $2, 'ZAR', 'Africa/Johannesburg', 1, 'fin,cal,bud,gym,eat,cyc')
        RETURNING id, group_name`,
        [famName, cleanUser]
      );
      useGroupId   = famRes.rows[0].id;
      useGroupName = famRes.rows[0].group_name;
    }

    await client.query(
      `INSERT INTO vectraarchlegacy_users
         (username, password_hash, first_name, last_name, display_name, email,
          is_admin, group_id, auth_provider, role, accent_color, event_color)
       VALUES ($1,$2,$3,$4,$5,$6,$7::integer,$8,'password',$9,$10::text,$10::text)`,
      [cleanUser, hash, firstName||null, lastName||null, displayName, email||null,
       adminFlag, useGroupId, cleanRole, accent]
    );

    // Auto-link this user to every other current member of the group.
    await client.query(`
      INSERT INTO vectraarchlegacy_access (viewer, target, source)
      SELECT $1, u.username, 'group' FROM vectraarchlegacy_users u
      WHERE u.group_id = $2 AND u.username <> $1
      ON CONFLICT (viewer, target) DO NOTHING`, [cleanUser, useGroupId]);
    await client.query(`
      INSERT INTO vectraarchlegacy_access (viewer, target, source)
      SELECT u.username, $1, 'group' FROM vectraarchlegacy_users u
      WHERE u.group_id = $2 AND u.username <> $1
      ON CONFLICT (viewer, target) DO NOTHING`, [cleanUser, useGroupId]);

    await client.query('COMMIT');
    await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
      ['legacy_user_add', `username:${cleanUser} role:${cleanRole} group:${useGroupId}`, 'ok']);
    req.session.flash = { type:'ok',
      msg:`✓ "${cleanUser}" created · ${cleanRole.toUpperCase()} · group "${useGroupName}" (#${useGroupId})` };
  } catch(e) {
    try { await client.query('ROLLBACK'); } catch {}
    req.session.flash = { type:'err', msg:`Error: ${e.message}` };
  } finally {
    client.release();
  }
  res.redirect(BASE + '/users');
});

// POST: Edit Legacy user fields. Supports updating role in addition to the
// previous fields. Group is changed via /users/legacy/move-group (separate
// dropdown), not here, so group-access stays in sync.
app.post(BASE + '/users/legacy/edit/:username', isAuth, async (req, res) => {
  const { username } = req.params;
  const { firstName, lastName, email, isAdmin, password, role } = req.body;
  try {
    const displayName = (firstName&&lastName)?`${firstName} ${lastName}`:username;
    const adminFlag = (isAdmin==='1'||isAdmin===true||isAdmin===1) ? 1 : 0;
    const validRoles = ['individual','partner','parent','guardian','ceo','manager','coach'];
    const cleanRole = validRoles.includes((role||'').toLowerCase()) ? role.toLowerCase() : null;
    await legacyPool.query(
      `UPDATE vectraarchlegacy_users SET
         first_name = $1, last_name = $2, display_name = $3,
         email = $4, is_admin = $5::integer,
         role = COALESCE($6, role)
       WHERE username = $7`,
      [firstName||null, lastName||null, displayName, email||null, adminFlag, cleanRole, username]
    );
    if (password && password.trim()) {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash(password.trim(), 10);
      await legacyPool.query('UPDATE vectraarchlegacy_users SET password_hash=$1 WHERE username=$2', [hash, username]);
    }
    await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
      ['legacy_user_edit', `username:${username} role:${cleanRole||'(unchanged)'}`, 'ok']);
    req.session.flash = { type:'ok', msg:`✓ Legacy user "${username}" updated` };
  } catch(e) {
    req.session.flash = { type:'err', msg:`Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// POST: Delete Legacy user
app.post(BASE + '/users/legacy/delete/:username', isAuth, async (req, res) => {
  const { username } = req.params;
  try {
    await legacyPool.query('DELETE FROM vectraarchlegacy_users WHERE username=$1', [username]);
    await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
      ['legacy_user_delete', `username:${username}`, 'ok']);
    req.session.flash = { type:'ok', msg:`✓ Legacy user "${username}" deleted` };
  } catch(e) {
    req.session.flash = { type:'err', msg:`Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// POST: Toggle Legacy user 2FA (reset secret = disable)
app.post(BASE + '/users/legacy/toggle-2fa/:username', isAuth, async (req, res) => {
  const { username } = req.params;
  const { action } = req.body; // 'disable'
  try {
    if (action === 'disable') {
      await legacyPool.query('UPDATE vectraarchlegacy_users SET twofa_secret=NULL WHERE username=$1', [username]);
      req.session.flash = { type:'ok', msg:`✓ 2FA disabled for "${username}"` };
    }
  } catch(e) {
    req.session.flash = { type:'err', msg:`Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// POST: Grant Legacy access (partner sharing)
// POST: Grant a MANUAL cross-group link. Group-induced rows are auto-managed
// by group membership; this endpoint only writes source='manual'.
app.post(BASE + '/users/legacy/grant-access', isAuth, async (req, res) => {
  const { viewer, target } = req.body;
  if (!viewer || !target || viewer === target) {
    req.session.flash = { type:'err', msg:'Viewer and target must be different users.' };
    return res.redirect(BASE + '/users');
  }
  try {
    await legacyPool.query(
      "INSERT INTO vectraarchlegacy_access (viewer,target,source) VALUES ($1,$2,'manual') ON CONFLICT (viewer,target) DO NOTHING",
      [viewer, target]
    );
    req.session.flash = { type:'ok', msg:`✓ Manual access granted: ${viewer} → ${target}` };
  } catch(e) {
    req.session.flash = { type:'err', msg:`Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// POST: Revoke a Legacy access pair. Refuses to delete group-source rows so
// auto-managed visibility can only be changed via the user's Group dropdown.
app.post(BASE + '/users/legacy/revoke-access', isAuth, async (req, res) => {
  const { viewer, target } = req.body;
  try {
    const r = await legacyPool.query(
      "DELETE FROM vectraarchlegacy_access WHERE viewer=$1 AND target=$2 AND source <> 'group'",
      [viewer, target]
    );
    if (r.rowCount === 0) {
      req.session.flash = { type:'err', msg:`⚠ ${viewer} → ${target} is a group-managed link. Move the user out of the group to remove it.` };
    } else {
      req.session.flash = { type:'ok', msg:`✓ Manual access revoked: ${viewer} → ${target}` };
    }
  } catch(e) {
    req.session.flash = { type:'err', msg:`Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// ── LEGACY SUBSCRIPTION MANAGEMENT ROUTES ─────────────────────────────────────
// Conduit's mirror of the VectraArchLegacy admin-subscription console. Every
// mutation writes straight to the Legacy DB and is journaled to conduit_log.
// (Legacy also writes vectraarchlegacy transaction history via its own app; the
// raw column writes here are intentionally the same as that app performs.)

// Small audit helper — never let a logging failure break the mutation.
async function logSub(event, payload) {
  try {
    await pool.query('INSERT INTO conduit_log (event,payload,status) VALUES ($1,$2,$3)',
      [event, payload, 'ok']);
  } catch {}
}

// POST: Grant / set a subscription plan manually (comp, fix a failed webhook).
app.post(BASE + '/users/legacy/sub/grant', isAuth, async (req, res) => {
  const username = (req.body.username || '').toString();
  const planId   = (req.body.plan || '').toString();
  const months   = Math.max(1, parseInt(req.body.months, 10) || 1);
  const plan = LEGACY_PLANS[planId];
  if (!username || !plan) {
    req.session.flash = { type:'err', msg:'Username and a valid plan are required.' };
    return res.redirect(BASE + '/users');
  }
  try {
    const u = await legacyPool.query('SELECT username FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
    if (u.rowCount === 0) {
      req.session.flash = { type:'err', msg:`User "${username}" not found in Legacy DB.` };
      return res.redirect(BASE + '/users');
    }
    const expires = plan.recurring
      ? new Date(Date.now() + months * 30 * 86400000).toISOString()
      : null;
    await legacyPool.query(
      `UPDATE vectraarchlegacy_users
          SET subscription_status = 'active', subscription_plan = $2, subscription_expires_at = $3
        WHERE LOWER(username) = LOWER($1)`, [username, planId, expires]);
    await logSub('legacy_sub_grant', `username:${username} plan:${planId} months:${months}`);
    req.session.flash = { type:'ok', msg:`✓ Granted ${plan.name} to "${u.rows[0].username}".` };
  } catch (e) {
    console.error('[conduit] sub/grant ERROR:', e.message);
    req.session.flash = { type:'err', msg:`DB Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// POST: Extend an existing subscription's expiry by N days (goodwill credit).
app.post(BASE + '/users/legacy/sub/extend', isAuth, async (req, res) => {
  const username = (req.body.username || '').toString();
  const days     = parseInt(req.body.days, 10);
  if (!username || !days || days < 1) {
    req.session.flash = { type:'err', msg:'Username and a positive day count are required.' };
    return res.redirect(BASE + '/users');
  }
  try {
    const u = await legacyPool.query('SELECT username, subscription_expires_at FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
    if (u.rowCount === 0) {
      req.session.flash = { type:'err', msg:`User "${username}" not found in Legacy DB.` };
      return res.redirect(BASE + '/users');
    }
    // Extend from the current expiry if it's in the future, otherwise from now.
    const cur = u.rows[0].subscription_expires_at;
    const base = cur && new Date(cur) > new Date() ? new Date(cur).getTime() : Date.now();
    const expires = new Date(base + days * 86400000).toISOString();
    await legacyPool.query(
      `UPDATE vectraarchlegacy_users
          SET subscription_status = 'active', subscription_expires_at = $2
        WHERE LOWER(username) = LOWER($1)`, [username, expires]);
    await logSub('legacy_sub_extend', `username:${username} days:${days}`);
    req.session.flash = { type:'ok', msg:`✓ Extended "${u.rows[0].username}" by ${days} day(s) — now expires ${new Date(expires).toLocaleDateString('en-ZA')}.` };
  } catch (e) {
    console.error('[conduit] sub/extend ERROR:', e.message);
    req.session.flash = { type:'err', msg:`DB Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// POST: Reset / set a trial — starts a fresh window of N days (default TRIAL_DAYS).
app.post(BASE + '/users/legacy/sub/trial', isAuth, async (req, res) => {
  const username = (req.body.username || '').toString();
  const days     = Math.max(1, parseInt(req.body.days, 10) || LEGACY_TRIAL_DAYS);
  if (!username) {
    req.session.flash = { type:'err', msg:'Username required.' };
    return res.redirect(BASE + '/users');
  }
  try {
    const u = await legacyPool.query('SELECT username FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
    if (u.rowCount === 0) {
      req.session.flash = { type:'err', msg:`User "${username}" not found in Legacy DB.` };
      return res.redirect(BASE + '/users');
    }
    // Backdate trial_started_at so (start + TRIAL_DAYS) lands `days` from now.
    const startedAt = new Date(Date.now() - (LEGACY_TRIAL_DAYS - days) * 86400000).toISOString();
    await legacyPool.query(
      `UPDATE vectraarchlegacy_users
          SET subscription_status = 'trial', subscription_plan = NULL,
              subscription_expires_at = NULL, trial_started_at = $2
        WHERE LOWER(username) = LOWER($1)`, [username, startedAt]);
    await logSub('legacy_sub_trial', `username:${username} days:${days}`);
    req.session.flash = { type:'ok', msg:`✓ Reset "${u.rows[0].username}" to a ${days}-day trial.` };
  } catch (e) {
    console.error('[conduit] sub/trial ERROR:', e.message);
    req.session.flash = { type:'err', msg:`DB Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// POST: Cancel (stop renewal, keep access until expiry) or End/revoke now (hard).
app.post(BASE + '/users/legacy/sub/cancel', isAuth, async (req, res) => {
  const username = (req.body.username || '').toString();
  const hard     = req.body.hard === true || req.body.hard === 'true';
  if (!username) {
    req.session.flash = { type:'err', msg:'Username required.' };
    return res.redirect(BASE + '/users');
  }
  try {
    const u = await legacyPool.query('SELECT username FROM vectraarchlegacy_users WHERE LOWER(username) = LOWER($1)', [username]);
    if (u.rowCount === 0) {
      req.session.flash = { type:'err', msg:`User "${username}" not found in Legacy DB.` };
      return res.redirect(BASE + '/users');
    }
    const newStatus = hard ? 'expired' : 'cancelled';
    await legacyPool.query(
      `UPDATE vectraarchlegacy_users
          SET subscription_status = $2,
              subscription_expires_at = CASE WHEN $3 THEN NOW() ELSE subscription_expires_at END
        WHERE LOWER(username) = LOWER($1)`, [username, newStatus, hard]);
    await logSub(hard ? 'legacy_sub_revoke' : 'legacy_sub_cancel', `username:${username}`);
    req.session.flash = { type:'ok', msg:`✓ ${hard ? 'Ended' : 'Cancelled'} subscription for "${u.rows[0].username}".` };
  } catch (e) {
    console.error('[conduit] sub/cancel ERROR:', e.message);
    req.session.flash = { type:'err', msg:`DB Error: ${e.message}` };
  }
  res.redirect(BASE + '/users');
});

// ── START ─────────────────────────────────────────────────────────────────────
// Ensure legacyPool write access on startup
async function checkLegacyAccess() {
  try {
    await legacyPool.query('SELECT 1');
    console.log('[conduit] legacyPool: connection OK');
    // Quick write test
    const t = await legacyPool.query("SELECT has_table_privilege($1,'vectraarchlegacy_users','UPDATE') AS can_update", ['forge_master']);
    console.log(`[conduit] legacyPool write access: ${t.rows[0]?.can_update}`);
    if (!t.rows[0]?.can_update) {
      console.warn('[conduit] WARNING: forge_master cannot UPDATE vectraarchlegacy_users — run GRANT UPDATE ON vectraarchlegacy_users TO forge_master;');
    }
  } catch(e) {
    console.error('[conduit] legacyPool check failed:', e.message);
  }
}

setupDB().then(() => {
  checkLegacyAccess();
  app.listen(PORT, HOST, () => {
    console.log(`[conduit] VectraArchConduit listening on ${HOST}:${PORT}`);
    console.log(`[conduit] Database: bookforge (${process.env.DB_USER}@${process.env.DB_HOST||'localhost'})`);
    console.log(`[conduit] Routes: ${BASE}/, ${BASE}/sites, ${BASE}/users, ${BASE}/login, ${BASE}/auth/2fa`);
  });
}).catch(e => { console.error('[conduit] DB setup failed:', e); process.exit(1); });