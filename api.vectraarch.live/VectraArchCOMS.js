'use strict';

/**
 * VectraArch — Unified Message Proxy
 * Per-app Telegram bots, all messages to same chat ID.
 *
 * Routes:
 *   POST /contact      — vectraarch.live (VectraArch_bot)
 *   POST /bo7-booking  — vectraarch.live/bo7/ (Co7_vectraarch_live_bot)
 *   POST /legacy       — vectraarch.live/legacy/ (Legacy_VectraArch_live_bot)
 *   POST /forge        — vectraarch.live/forge/ (Forge_VectraArch_live_bot)
 */

const http  = require('http');
const https = require('https');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const CHAT_ID      = '8783471876';
const LISTEN_PORT  = 3099;

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
  req.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(); });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Bad JSON' }));
      return;
    }
    handler(payload, res);
  });
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  console.log(`[va-proxy] Listening on 127.0.0.1:${LISTEN_PORT}`);
  console.log(`[va-proxy] Routes: ${Object.keys(ROUTES).join(', ')}`);
});
