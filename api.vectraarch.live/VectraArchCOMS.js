'use strict';

/**
 * VectraArch — Unified Communications Proxy (COMS)
 * The single outbound comms hub. Per-app Telegram bots + Nuntly transactional
 * email. Holds the credentials so callers (e.g. VectraArch Legacy) never need
 * the Nuntly API key directly.
 *
 * Routes:
 *   POST /contact      — vectraarch.live (VectraArch_bot)
 *   POST /bo7-booking  — vectraarch.live/bo7/ (Co7_vectraarch_live_bot)
 *   POST /legacy       — vectraarch.live/legacy/ (Legacy_VectraArch_live_bot)
 *   POST /forge        — vectraarch.live/forge/ (Forge_VectraArch_live_bot)
 *   POST /email/send   — transactional email via Nuntly (internal, localhost)
 */

const http  = require('http');
const https = require('https');
const path  = require('path');
try { require('dotenv').config({ path: path.join(__dirname, '.env') }); } catch { /* dotenv optional */ }

// ── CONFIG ───────────────────────────────────────────────────────────────────
const CHAT_ID      = '8783471876';
const LISTEN_PORT  = 3099;
const MAX_BODY     = 262144; // 256 KB — email HTML can be sizeable

// Nuntly transactional email. Endpoint/auth/payload per nuntly.com OpenAPI:
//   POST https://api.nuntly.com/emails  ·  Authorization: Bearer <key>
//   body { from, to:[...], subject, text?, html? }  ·  202 { data:{ id } }
const NUNTLY_API_KEY    = process.env.NUNTLY_API_KEY    || '';
const NUNTLY_API_URL    = process.env.NUNTLY_API_URL    || 'https://api.nuntly.com/emails';
const NUNTLY_FROM       = process.env.NUNTLY_FROM       || 'VectraArch Legacy <noreply@vectraarch.live>';
// Optional shared secret. COMS only listens on 127.0.0.1, but if set, callers
// must present it via the x-coms-secret header (defense in depth).
const COMS_EMAIL_SECRET = process.env.COMS_EMAIL_SECRET || '';
// Optional audit address: every outbound email is silently BCC'd here so an
// admin keeps a copy of all user-facing mail. Comma-separated list supported.
const COMS_AUDIT_BCC    = (process.env.COMS_AUDIT_BCC || '').split(',').map(s => s.trim()).filter(Boolean);

const BOTS = {
  main:   '8767176406:AAEMhPAuQw5dFPEMcLEru1ZkqFT5ijk8YCk',  // VectraArch_bot
  bo7:    '8678383201:AAG1yCt_hRSEu6qvABGfKQHQM7TphDnp-uk',  // Co7_vectraarch_live_bot
  legacy: '8602057141:AAGS6TkOsOBqtLy6ay9_2jqDJzqSeZSR00c',  // Legacy_VectraArch_live_bot
  forge:  '8811566946:AAGz7HZMYIxtS1nAc_XhCvF-IFWaNoXMnj0',  // Forge_VectraArch_live_bot
};

const ALLOWED_ORIGINS = [
  'https://vectraarch.live',
  'https://vectraarch.live/bo7',
  'https://vectraarch.live/legacy',
  'https://vectraarch.live/forge',
];
// ─────────────────────────────────────────────────────────────────────────────

function sendTelegram(botToken, text, res) {
  const url  = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = JSON.stringify({ chat_id: CHAT_ID, text });
  const req  = https.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, tgRes => {
    let data = '';
    tgRes.on('data', c => data += c);
    tgRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        res.writeHead(json.ok ? 200 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: json.ok, error: json.description || null }));
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Telegram parse error' }));
      }
    });
  });
  req.on('error', err => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: err.message }));
  });
  req.write(body);
  req.end();
}

// ── NUNTLY EMAIL ───────────────────────────────────────────────────────────
function sendNuntlyEmail({ to, subject, text, html, from, replyTo, cc, bcc, idempotencyKey }) {
  return new Promise(resolve => {
    if (!NUNTLY_API_KEY) return resolve({ ok: false, error: 'NUNTLY_API_KEY not configured' });
    const recipients = Array.isArray(to) ? to : [to];
    const payload = {
      from:    from || NUNTLY_FROM,
      to:      recipients,
      subject,
      ...(text    ? { text }    : {}),
      ...(html    ? { html }    : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(cc      ? { cc:  Array.isArray(cc)  ? cc  : [cc]  } : {}),
      ...(bcc     ? { bcc: Array.isArray(bcc) ? bcc : [bcc] } : {}),
    };
    const body = JSON.stringify(payload);
    let u;
    try { u = new URL(NUNTLY_API_URL); } catch { return resolve({ ok: false, error: 'Bad NUNTLY_API_URL' }); }
    const headers = {
      'Authorization': `Bearer ${NUNTLY_API_KEY}`,
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const req = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      port:     u.port || 443,
      method:   'POST',
      headers,
    }, r => {
      let data = '';
      r.on('data', c => data += c);
      r.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch { /* non-JSON */ }
        if (r.statusCode >= 200 && r.statusCode < 300) {
          resolve({ ok: true, id: json?.data?.id || json?.id || null, status: r.statusCode });
        } else {
          resolve({ ok: false, status: r.statusCode, error: json?.error?.message || json?.message || data || `HTTP ${r.statusCode}` });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'Nuntly request timed out' }); });
    req.write(body);
    req.end();
  });
}

async function handleEmail(payload, res, req) {
  if (COMS_EMAIL_SECRET && (req.headers['x-coms-secret'] || '') !== COMS_EMAIL_SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }
  const { to, subject, text, html, from, replyTo, cc, bcc, idempotencyKey } = payload;
  if (!to || !subject || (!text && !html)) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Missing required fields: to, subject, and text or html' }));
    return;
  }
  // Always BCC the audit address(es) so an admin keeps a copy of every email.
  const bccList = [...(bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : []), ...COMS_AUDIT_BCC];
  const result = await sendNuntlyEmail({ to, subject, text, html, from, replyTo, cc, bcc: bccList.length ? bccList : undefined, idempotencyKey });
  res.writeHead(result.ok ? 200 : 502, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

function handleContact(payload, res) {
  const { fname, lname, email, phone, subject, message } = payload;
  if (!fname || !lname || !email || !phone) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Missing required fields' }));
    return;
  }
  const text = [
    '📡 VectraArch · New Message',
    '',
    `Name:    ${fname} ${lname}`,
    `Email:   ${email}`,
    `Phone:   ${phone}`,
    subject ? `Subject: ${subject}` : null,
    message ? `\n${message}` : null,
  ].filter(l => l !== null).join('\n');
  sendTelegram(BOTS.main, text, res);
}

function handleBo7Booking(payload, res) {
  const { fname, lname, email, phone, gamertag, pkg, availability, message } = payload;
  if (!fname || !lname || !email || !phone || !pkg) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Missing required fields' }));
    return;
  }
  const text = [
    '🐺 Bo7 Coaching · ZenithB_Actual',
    '',
    `Name:         ${fname} ${lname}`,
    `Email:        ${email}`,
    `Phone:        ${phone}`,
    gamertag     ? `Xbox GT:      ${gamertag}`     : null,
    `Package:      ${pkg}`,
    availability ? `Availability: ${availability}` : null,
    message      ? `\nNotes:\n${message}`           : null,
  ].filter(l => l !== null).join('\n');
  sendTelegram(BOTS.bo7, text, res);
}

function handleLegacy(payload, res) {
  const { fname, lname, email, phone, subject, message } = payload;
  if (!fname || !lname || !email || !phone) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Missing required fields' }));
    return;
  }
  const text = [
    '🏛 VectraArch Legacy · New Message',
    '',
    `Name:    ${fname} ${lname}`,
    `Email:   ${email}`,
    `Phone:   ${phone}`,
    subject ? `Subject: ${subject}` : null,
    message ? `\n${message}` : null,
  ].filter(l => l !== null).join('\n');
  sendTelegram(BOTS.legacy, text, res);
}

function handleForge(payload, res) {
  const { fname, lname, email, phone, subject, message } = payload;
  if (!fname || !lname || !email || !phone) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Missing required fields' }));
    return;
  }
  const text = [
    '⚒ VectraArch Forge · New Message',
    '',
    `Name:    ${fname} ${lname}`,
    `Email:   ${email}`,
    `Phone:   ${phone}`,
    subject ? `Subject: ${subject}` : null,
    message ? `\n${message}` : null,
  ].filter(l => l !== null).join('\n');
  sendTelegram(BOTS.forge, text, res);
}

const ROUTES = {
  '/contact':     handleContact,
  '/bo7-booking': handleBo7Booking,
  '/legacy':      handleLegacy,
  '/forge':       handleForge,
  '/email/send':  handleEmail,
};

const server = http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const handler = ROUTES[req.url];
  if (req.method !== 'POST' || !handler) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > MAX_BODY) req.destroy(); });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Bad JSON' }));
      return;
    }
    handler(payload, res, req);
  });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[va-proxy] Listening on 127.0.0.1:${LISTEN_PORT}`);
  console.log(`[va-proxy] Routes: ${Object.keys(ROUTES).join(', ')}`);
  console.log(`[va-proxy] Nuntly email: ${NUNTLY_API_KEY ? 'configured' : 'NOT configured (set NUNTLY_API_KEY)'}`);
});
