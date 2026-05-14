require('dotenv').config();
const express = require('express'),
      path = require('path'),
      passport = require('passport'),
      session = require('express-session'),
      GoogleStrategy = require('passport-google-oauth20').Strategy,
      { Pool } = require('pg'),
      multer = require('multer'),
      fs = require('fs'),
      { authenticator } = require('otplib'),
      qrcode = require('qrcode'),
      { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx'),
      PDFDocument = require('pdfkit'),
      Epub = require('epub-gen-memory').default;

const app = express(), PORT = 3000, HOST = '127.0.0.1';
const BASE = '/forge'; // All internal redirects use this prefix

const PRESS_ROOT = '/var/www/vectraarch.live/press';

// --- FILE UPLOAD ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => { cb(null, Date.now() + path.extname(file.originalname)); }
});
const upload = multer({ storage });

const pool = new Pool({
    user: process.env.DB_USER, host: process.env.DB_HOST,
    database: process.env.DB_NAME, password: process.env.DB_PASSWORD, port: process.env.DB_PORT
});

app.set('trust proxy', 1);
app.use((req, res, next) => {
  // Strip /forge prefix so routes work as-is
  if (req.url.startsWith('/forge')) {
    req.url = req.url.slice('/forge'.length) || '/';
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false,
    cookie: { secure: true, sameSite: 'lax', maxAge: 86400000 }
}));
app.use(passport.initialize());
app.use(passport.session());
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

const getCurrentID = (req) => req.session.manualUser || (req.user ? req.user.id : null);

const isAdmin = async (req) => {
    const id = getCurrentID(req);
    if (!id) return false;
    try {
        const r = await pool.query('SELECT role FROM users WHERE id = $1', [id]);
        return r.rows[0]?.role === 'admin';
    } catch { return false; }
};

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL
}, async (at, rt, profile, done) => {
    const now = new Date().toLocaleString('en-ZA');
    await pool.query(
        `INSERT INTO users (id, name, email, type, role, status, logins, last_login)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7)
         ON CONFLICT (id) DO UPDATE SET logins=users.logins+1, last_login=$7`,
        [profile.id, profile.displayName, profile.emails[0].value, 'Google', 'user', 'enabled', now]
    );
    return done(null, profile);
}));

passport.serializeUser((u, d) => d(null, u));
passport.deserializeUser((o, d) => d(null, o));

const isAuth = (req, res, n) => {
    if (req.isAuthenticated() || req.session.manualLogin) {
        if (req.session.needs2FA) return res.redirect(BASE + '/auth/2fa');
        return n();
    }
    res.redirect('https://vectraarch.live/foundation/');
};

// ── MAIN ROUTE ────────────────────────────────────────────────────────────
app.get('/', isAuth, async (req, res) => {
    try {
        const uid = getCurrentID(req);
        const root = await isAdmin(req);
        const userCheck = await pool.query(
            'SELECT (twofa_secret IS NOT NULL) as has_2fa, type, name FROM users WHERE id=$1', [uid]
        );
        const is2FAEnabled = userCheck.rows[0]?.has_2fa || false;
        const userName = userCheck.rows[0]?.name || 'User';

        let booksQuery = `
            SELECT b.*, b.published,
                   CASE WHEN u.type='Manual' THEN '[Internal]' ELSE u.email END as owner_email,
                   u.type as owner_type
            FROM books b JOIN users u ON b.owner_id=u.id`;
        let params = [];
        if (!root) { booksQuery += ' WHERE b.owner_id=$1'; params.push(uid); }
        const books = await pool.query(booksQuery + ' ORDER BY b.title ASC', params);

        const users = root
            ? await pool.query(`SELECT id,name,type,role,status,logins,last_login,
                                (twofa_secret IS NOT NULL) as twofa_enabled,
                                CASE WHEN type='Manual' THEN COALESCE(email, '[No email]') ELSE email END as display_email
                                FROM users ORDER BY last_login DESC NULLS LAST`)
            : { rows: [] };

        res.render('library', {
            books: books.rows, users: users.rows,
            isAdmin: root, is2FAEnabled, userName, userId: uid
        });
    } catch (e) { console.error(e); res.status(500).send('System Error'); }
});

// ── PUBLISH / UNPUBLISH PER BOOK ──────────────────────────────────────────

// Shared: verify the requesting user owns this book (or is admin)
async function canModifyBook(req, bookId) {
    const uid = getCurrentID(req);
    const root = await isAdmin(req);
    if (root) return true;
    const r = await pool.query('SELECT owner_id FROM books WHERE id=$1', [bookId]);
    return r.rows[0]?.owner_id === uid;
}

// Rebuild the entire press index from all published books grouped by author
async function rebuildPressIndex() {
    const result = await pool.query(`
        SELECT b.id, b.title, b.cover_url, b.published,
               u.id as author_id, u.name as author_name, u.type as owner_type,
               (
                 SELECT content FROM entries
                 WHERE book_id = b.id AND category = 'manuscript'
                 ORDER BY id ASC LIMIT 1
               ) as preview_raw
        FROM books b
        JOIN users u ON b.owner_id = u.id
        WHERE b.published = true
        ORDER BY u.name ASC, b.title ASC
    `);

    const books = result.rows;

    // Group by author
    const authorsMap = new Map();
    for (const book of books) {
        if (!authorsMap.has(book.author_id)) {
            authorsMap.set(book.author_id, { name: book.author_name, books: [] });
        }
        // Generate ~300 word preview from first manuscript entry
        const raw = book.preview_raw || '';
        const words = raw.trim().split(/\s+/).filter(w => w.length > 0);
        const preview = words.slice(0, 300).join(' ') + (words.length > 300 ? '…' : '');
        authorsMap.get(book.author_id).books.push({ ...book, preview });
    }

    const authors = [...authorsMap.values()];
    const publishedAt = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
    const totalVolumes = books.length;

    const html = buildPressIndex(authors, totalVolumes, publishedAt);
    fs.mkdirSync(PRESS_ROOT, { recursive: true });
    fs.writeFileSync(path.join(PRESS_ROOT, 'index.html'), html, 'utf8');
}

// Publish a single book
app.post('/book/:id/publish', isAuth, async (req, res) => {
    if (!await canModifyBook(req, req.params.id)) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    try {
        await pool.query('UPDATE books SET published=true WHERE id=$1', [req.params.id]);
        await rebuildPressIndex();
        res.json({ ok: true, published: true });
    } catch (e) {
        console.error('Publish error:', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// Unpublish a single book
app.post('/book/:id/unpublish', isAuth, async (req, res) => {
    if (!await canModifyBook(req, req.params.id)) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    try {
        await pool.query('UPDATE books SET published=false WHERE id=$1', [req.params.id]);
        await rebuildPressIndex();
        res.json({ ok: true, published: false });
    } catch (e) {
        console.error('Unpublish error:', e);
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── PRESS PAGE BUILDER ────────────────────────────────────────────────────

function escHtml(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const COVER_GRADIENTS = [
    'linear-gradient(160deg,#0a1a0a 0%,#001a08 60%,#002210 100%)',
    'linear-gradient(135deg,#080d12 0%,#0a1520 60%,#061018 100%)',
    'linear-gradient(150deg,#12080a 0%,#1a0808 60%,#100005 100%)',
    'linear-gradient(140deg,#0d0d08 0%,#181508 60%,#120f00 100%)',
    'linear-gradient(160deg,#080a12 0%,#06091a 60%,#030718 100%)',
    'linear-gradient(130deg,#0a0a0a 0%,#141414 60%,#0d0d0d 100%)',
    'linear-gradient(155deg,#080f0a 0%,#0a1a0d 60%,#051208 100%)',
    'linear-gradient(145deg,#0f0808 0%,#1a0a08 60%,#120500 100%)',
];

const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X',
               'XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX'];

const GOOGLE_ICON = `<svg style="width:11px;height:11px;" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;

function buildBookCard(book, index) {
    let coverUrl = (book.cover_url || '').trim();
    if (coverUrl.startsWith('/uploads/')) coverUrl = 'https://vectraarch.live/forge' + coverUrl;
    const gradient = COVER_GRADIENTS[index % COVER_GRADIENTS.length];
    const roman = ROMAN[index] || String(index + 1);
    const vol = String(index + 1).padStart(2, '0');
    const coverImg = coverUrl
        ? `<img src="${escHtml(coverUrl)}" alt="${escHtml(book.title)}" onerror="this.style.display='none'" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0.65;">`
        : '';
    return `
      <div class="book-card" data-title="${escHtml(book.title)}">
        <div class="book-cover" style="background:${gradient};">
          <div class="cover-grid-lines"></div>
          ${coverImg}
          <div class="book-cover-inner">
            <div class="cover-corner">${roman}</div>
          </div>
          <div class="cover-accent-line"></div>
        </div>
        <div class="book-info">
          <div class="book-title">${escHtml(book.title)}</div>
          <div class="book-footer">
            <span class="book-year">2026</span>
            <span class="book-status status-published">Published</span>
          </div>
        </div>
        ${book.preview ? `
        <div class="book-preview">
          <div class="preview-label">§ Preview</div>
          <div class="preview-text">${escHtml(book.preview)}</div>
          <button class="preview-toggle" onclick="this.closest('.book-card').classList.toggle('preview-open');this.textContent=this.closest('.book-card').classList.contains('preview-open')?'Close ↑':'Read excerpt ↓'">Read excerpt ↓</button>
        </div>` : ''}
      </div>`;
}

function buildAuthorSection(author, authorIndex) {
    const cards = author.books.map((b, i) => buildBookCard(b, i)).join('\n');
    const count = author.books.length;
    const num = String(authorIndex + 1).padStart(2, '0');
    return `
  <div class="author-section reveal">
    <div class="author-header">
      <div class="author-header-left">
        <span class="author-number">${num}</span>
        <div class="author-name-block">
          <span class="author-label">§ Author</span>
          <h2 class="author-name">${escHtml(author.name)}</h2>
        </div>
      </div>
      <div class="author-header-right">
        <span class="author-count">${count} volume${count !== 1 ? 's' : ''}</span>
      </div>
    </div>
    <div class="book-grid">
      ${cards}
    </div>
  </div>`;
}

function buildPressIndex(authors, totalVolumes, publishedAt) {
    const authorSections = authors.length > 0
        ? authors.map((a, i) => buildAuthorSection(a, i)).join('\n')
        : `<div class="empty-state">
             <div class="empty-title">No Published Volumes</div>
             <div class="empty-sub">§ Authors publish their books from Book Forge</div>
           </div>`;

    const authorCount = authors.length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Press — Vectra Arch</title>
  <meta name="description" content="The publishing catalogue of Vectra Arch Press."/>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Mono:ital,wght@0,300;0,400;0,500;1,300&family=Barlow:wght@300;400;500;600&family=Barlow+Condensed:wght@300;400;500;700;800&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    :root{--bg:#0a0a08;--bg2:#111110;--bg3:#191917;--border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.14);--text:#e8e4d8;--text-muted:rgba(232,228,216,0.45);--text-dim:rgba(232,228,216,0.22);--accent:#00ff41;--accent2:#00b32c;--red:#b84040;}
    html{scroll-behavior:smooth;}
    body{background:var(--bg);color:var(--text);font-family:'Barlow',sans-serif;font-weight:300;font-size:16px;line-height:1.6;overflow-x:hidden;cursor:crosshair;}
    body::before{content:'';position:fixed;inset:0;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E");opacity:0.4;pointer-events:none;z-index:0;}
    .grid-bg{position:fixed;inset:0;background-image:linear-gradient(var(--border) 1px,transparent 1px),linear-gradient(90deg,var(--border) 1px,transparent 1px);background-size:80px 80px;pointer-events:none;z-index:0;}
    .accent-lines{position:fixed;top:0;right:0;width:50%;height:100%;pointer-events:none;overflow:hidden;z-index:0;}
    .accent-lines svg{width:100%;height:100%;}

    /* NAV */
    nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 40px;height:60px;border-bottom:1px solid var(--border);background:rgba(10,10,8,0.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}
    .nav-logo{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:15px;letter-spacing:0.22em;text-transform:uppercase;color:var(--text);text-decoration:none;}
    .nav-logo span{color:var(--accent);}
    .nav-links{display:flex;gap:32px;list-style:none;}
    .nav-links a{font-family:'DM Mono',monospace;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-muted);text-decoration:none;transition:color 0.2s;}
    .nav-links a:hover{color:var(--text);}
    .nav-status{display:flex;align-items:center;gap:8px;font-family:'DM Mono',monospace;font-size:10px;color:var(--text-dim);letter-spacing:0.1em;}
    .nav-status::before{content:'';display:block;width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 6px var(--accent);}

    /* HERO */
    .hero{position:relative;z-index:1;padding:140px 40px 80px;border-bottom:1px solid var(--border);}
    .hero-label{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.28em;text-transform:uppercase;color:var(--accent);margin-bottom:24px;}
    .hero-title{font-family:'Bebas Neue',sans-serif;font-size:clamp(72px,10vw,140px);line-height:0.9;letter-spacing:0.02em;color:var(--text);margin-bottom:32px;}
    .hero-title em{font-style:normal;color:transparent;-webkit-text-stroke:1px rgba(0,255,65,0.3);display:block;}
    .hero-desc{font-family:'Barlow Condensed',sans-serif;font-weight:300;font-size:17px;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-muted);max-width:560px;line-height:1.5;}
    .hero-meta{display:flex;align-items:center;gap:40px;margin-top:48px;padding-top:32px;border-top:1px solid var(--border);}
    .meta-item{display:flex;flex-direction:column;gap:4px;}
    .meta-value{font-family:'Bebas Neue',sans-serif;font-size:32px;color:var(--text);letter-spacing:0.04em;line-height:1;}
    .meta-label{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.18em;color:var(--text-dim);text-transform:uppercase;}
    .meta-div{width:1px;height:40px;background:var(--border2);}

    /* TOOLBAR */
    .toolbar{position:relative;z-index:1;padding:20px 40px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:16px;background:rgba(10,10,8,0.6);}
    .search-wrap{position:relative;flex:1;min-width:200px;max-width:340px;}
    .search-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-family:'DM Mono',monospace;font-size:12px;color:var(--accent2);pointer-events:none;}
    .search-input{width:100%;background:var(--bg2);border:1px solid var(--border2);color:var(--text);font-family:'DM Mono',monospace;font-size:12px;letter-spacing:0.08em;padding:10px 14px 10px 36px;outline:none;transition:border-color 0.2s;}
    .search-input::placeholder{color:var(--text-dim);}
    .search-input:focus{border-color:var(--accent2);}
    .toolbar-count{font-family:'DM Mono',monospace;font-size:10px;color:var(--text-dim);letter-spacing:0.12em;margin-left:auto;}
    .toolbar-count span{color:var(--accent);}
    .published-stamp{font-family:'DM Mono',monospace;font-size:9px;color:var(--text-dim);letter-spacing:0.15em;}

    /* CATALOG */
    .catalog-wrap{position:relative;z-index:1;padding:64px 40px 100px;}

    /* AUTHOR SECTION */
    .author-section{margin-bottom:80px;}
    .author-header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:32px;padding-bottom:20px;border-bottom:1px solid var(--border2);}
    .author-header-left{display:flex;align-items:center;gap:24px;}
    .author-number{font-family:'Bebas Neue',sans-serif;font-size:3.5rem;line-height:1;color:var(--text-dim);letter-spacing:0.04em;}
    .author-name-block{display:flex;flex-direction:column;gap:4px;}
    .author-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.25em;text-transform:uppercase;color:var(--accent);}
    .author-name{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:2.2rem;letter-spacing:0.04em;text-transform:uppercase;color:var(--text);}
    .author-count{font-family:'DM Mono',monospace;font-size:10px;color:var(--text-dim);letter-spacing:0.15em;text-transform:uppercase;}

    /* BOOK GRID */
    .book-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:1px;background:var(--border);}
    .book-card{background:var(--bg);position:relative;overflow:hidden;cursor:crosshair;transition:background 0.25s;}
    .book-card:hover{background:var(--bg2);}
    .book-cover{width:100%;aspect-ratio:2/3;position:relative;overflow:hidden;}
    .book-cover-inner{width:100%;height:100%;display:flex;align-items:flex-end;padding:20px 16px;position:relative;}
    .cover-grid-lines{position:absolute;inset:0;background-image:linear-gradient(rgba(0,255,65,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,65,0.04) 1px,transparent 1px);background-size:24px 24px;}
    .cover-title-block{position:relative;z-index:1;}
    .cover-studio-tag{font-family:'DM Mono',monospace;font-size:8px;letter-spacing:0.2em;text-transform:uppercase;color:var(--accent);margin-bottom:6px;opacity:0.8;}
    .cover-book-title{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:18px;line-height:1.1;color:var(--text);text-transform:uppercase;letter-spacing:0.04em;}
    .cover-accent-line{position:absolute;bottom:0;left:0;right:0;height:2px;background:var(--accent);transform:scaleX(0);transform-origin:left;transition:transform 0.4s cubic-bezier(0.16,1,0.3,1);}
    .book-card:hover .cover-accent-line{transform:scaleX(1);}
    .cover-corner{position:absolute;top:16px;right:16px;font-family:'Bebas Neue',sans-serif;font-size:40px;line-height:1;color:rgba(0,255,65,0.06);}
    .book-info{padding:18px 20px 20px;border-top:1px solid var(--border);}
    .book-title{font-family:'Barlow Condensed',sans-serif;font-weight:600;font-size:14px;letter-spacing:0.03em;text-transform:uppercase;color:var(--text);margin-bottom:10px;line-height:1.2;}
    .book-footer{display:flex;align-items:center;justify-content:space-between;}
    .book-year{font-family:'DM Mono',monospace;font-size:10px;color:var(--text-dim);letter-spacing:0.1em;}
    .book-status{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.12em;padding:3px 10px;text-transform:uppercase;}
    .status-published{color:var(--accent);border:1px solid rgba(0,255,65,0.2);background:rgba(0,255,65,0.04);}
    .book-preview{padding:0 20px;max-height:0;overflow:hidden;transition:max-height 0.4s ease,padding 0.3s ease;}
    .book-card.preview-open .book-preview{max-height:400px;padding:16px 20px 20px;}
    .preview-label{font-family:'DM Mono',monospace;font-size:8px;letter-spacing:0.25em;text-transform:uppercase;color:var(--accent2);margin-bottom:10px;}
    .preview-text{font-size:13px;font-weight:300;color:var(--text-muted);line-height:1.75;border-left:2px solid var(--border2);padding-left:14px;}
    .preview-toggle{margin-top:14px;font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:var(--text-dim);background:transparent;border:1px solid var(--border);padding:6px 14px;cursor:crosshair;transition:border-color 0.2s,color 0.2s;display:block;width:100%;}
    .preview-toggle:hover{border-color:var(--accent2);color:var(--accent2);}

    /* EMPTY STATE */
    .empty-state{padding:100px 0;text-align:center;}
    .empty-title{font-family:'Bebas Neue',sans-serif;font-size:56px;color:var(--text-dim);letter-spacing:0.04em;margin-bottom:12px;}
    .empty-sub{font-family:'DM Mono',monospace;font-size:11px;color:var(--text-dim);letter-spacing:0.18em;}

    /* REVEAL */
    .reveal{opacity:0;transform:translateY(20px);transition:opacity 0.6s ease,transform 0.6s ease;}
    .reveal.visible{opacity:1;transform:none;}

    /* FOOTER */
    footer{position:relative;z-index:1;border-top:1px solid var(--border);padding:48px 40px;display:flex;align-items:center;justify-content:space-between;}
    .footer-logo{font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:13px;letter-spacing:0.25em;text-transform:uppercase;color:var(--text-dim);}
    .footer-links{display:flex;gap:32px;list-style:none;}
    .footer-links a{font-family:'DM Mono',monospace;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:var(--text-dim);text-decoration:none;transition:color 0.2s;}
    .footer-links a:hover{color:var(--text-muted);}
    .footer-meta{font-family:'DM Mono',monospace;font-size:10px;color:var(--text-dim);letter-spacing:0.1em;}

    /* RESPONSIVE */
    @media(max-width:900px){
      nav{padding:0 20px;}.nav-links{display:none;}
      .hero{padding:120px 20px 60px;}.toolbar{padding:16px 20px;}
      .catalog-wrap{padding:40px 20px 80px;}
      .book-grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));}
      footer{flex-direction:column;gap:24px;align-items:flex-start;padding:40px 20px;}
    }
    @media(pointer:fine){body,a,button{cursor:crosshair;}}
  </style>
</head>
<body>
<div class="grid-bg"></div>
<div class="accent-lines" aria-hidden="true">
  <svg viewBox="0 0 600 900" fill="none" preserveAspectRatio="xMaxYMid slice">
    <line x1="580" y1="0" x2="20" y2="900" stroke="rgba(0,255,65,0.07)" stroke-width="1"/>
    <line x1="540" y1="0" x2="0" y2="760" stroke="rgba(0,255,65,0.05)" stroke-width="0.5"/>
    <line x1="600" y1="200" x2="100" y2="900" stroke="rgba(0,255,65,0.04)" stroke-width="1"/>
    <rect x="460" y="80" width="100" height="1" fill="rgba(0,255,65,0.15)"/>
    <rect x="480" y="120" width="60" height="1" fill="rgba(0,255,65,0.1)"/>
    <rect x="500" y="160" width="40" height="1" fill="rgba(0,255,65,0.07)"/>
    <circle cx="540" cy="180" r="60" stroke="rgba(0,255,65,0.04)" stroke-width="1" fill="none"/>
    <circle cx="540" cy="180" r="90" stroke="rgba(0,255,65,0.025)" stroke-width="0.5" fill="none"/>
    <circle cx="540" cy="180" r="130" stroke="rgba(0,255,65,0.015)" stroke-width="0.5" fill="none"/>
  </svg>
</div>

<nav>
  <a href="https://vectraarch.live" class="nav-logo">Vectra<span>&nbsp;</span>Arch</a>
  <ul class="nav-links">
    <li><a href="#catalog">Catalogue</a></li>
    <li><a href="https://vectraarch.live#studios">All Studios</a></li>
  </ul>
  <div class="nav-status">PRESS · 08 / 08 · 2026</div>
</nav>

<section class="hero">
  <p class="hero-label">§ Studio 08 · Publishing · Narrative · External Voice</p>
  <h1 class="hero-title">
    Press
    <em>Catalogue</em>
  </h1>
  <p class="hero-desc">
    The public publishing arm of Vectra Arch. Volumes forged in Book Forge and released by their authors.
  </p>
  <div class="hero-meta">
    <div class="meta-item">
      <span class="meta-value">${String(totalVolumes).padStart(2,'0')}</span>
      <span class="meta-label">Published Volumes</span>
    </div>
    <div class="meta-div"></div>
    <div class="meta-item">
      <span class="meta-value">${String(authorCount).padStart(2,'0')}</span>
      <span class="meta-label">Authors</span>
    </div>
    <div class="meta-div"></div>
    <div class="meta-item">
      <span class="meta-value">2026</span>
      <span class="meta-label">Season</span>
    </div>
  </div>
</section>

<div class="toolbar" id="catalog">
  <div class="search-wrap">
    <span class="search-icon">⌕</span>
    <input class="search-input" type="text" id="search" placeholder="Search catalogue..." autocomplete="off"/>
  </div>
  <span class="toolbar-count"><span id="visible-count">${totalVolumes}</span> volumes</span>
  <span class="published-stamp">Updated · ${escHtml(publishedAt)}</span>
</div>

<div class="catalog-wrap">
  ${authorSections}
</div>

<footer>
  <div class="footer-logo">Vectra Arch · Press</div>
  <ul class="footer-links">
    <li><a href="#catalog">Catalogue</a></li>
    <li><a href="https://vectraarch.live#studios">All Studios</a></li>
    <li><a href="https://vectraarch.live/forge/">Book Forge</a></li>
  </ul>
  <div class="footer-meta">Self-hosted on Linux · 2026</div>
</footer>

<script>
  const obs = new IntersectionObserver(entries => {
    entries.forEach((e,i) => {
      if(e.isIntersecting){ setTimeout(()=>e.target.classList.add('visible'),i*80); obs.unobserve(e.target); }
    });
  },{threshold:0.05});
  document.querySelectorAll('.reveal').forEach(el=>obs.observe(el));

  document.getElementById('search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    let vis = 0;
    document.querySelectorAll('.book-card').forEach(card => {
      const match = !q || (card.dataset.title||'').toLowerCase().includes(q);
      card.style.display = match ? '' : 'none';
      if(match) vis++;
    });
    // Hide author sections that have no visible books
    document.querySelectorAll('.author-section').forEach(section => {
      const anyVisible = [...section.querySelectorAll('.book-card')].some(c => c.style.display !== 'none');
      section.style.display = anyVisible ? '' : 'none';
    });
    document.getElementById('visible-count').textContent = vis;
  });
</script>
</body>
</html>`;
}


// ── EXPORT ROUTES ─────────────────────────────────────────────────────────

async function getBookWithEntries(bookId) {
    const book = await pool.query('SELECT * FROM books WHERE id=$1', [bookId]);
    const entries = await pool.query(
        "SELECT * FROM entries WHERE book_id=$1 AND category='manuscript' ORDER BY id ASC",
        [bookId]
    );
    return { book: book.rows[0], entries: entries.rows };
}

// WORD (.docx)
app.get('/book/:id/export/docx', isAuth, async (req, res) => {
    if (!await canModifyBook(req, req.params.id)) return res.status(403).send('Forbidden');
    try {
        const { book, entries } = await getBookWithEntries(req.params.id);
        const children = [
            new Paragraph({
                text: book.title,
                heading: HeadingLevel.TITLE,
                alignment: AlignmentType.CENTER,
                spacing: { after: 400 }
            })
        ];
        entries.forEach((entry, i) => {
            children.push(new Paragraph({
                text: entry.title || `Chapter ${i + 1}`,
                heading: HeadingLevel.HEADING_1,
                spacing: { before: 400, after: 200 }
            }));
            const paras = (entry.content || '').split(/\n\n+/).filter(p => p.trim());
            paras.forEach(para => {
                children.push(new Paragraph({
                    children: [new TextRun({ text: para.trim(), size: 24, font: 'Georgia' })],
                    spacing: { after: 200 },
                    indent: { firstLine: 720 }
                }));
            });
        });
        const doc = new Document({ sections: [{ children }] });
        const buffer = await Packer.toBuffer(doc);
        const filename = book.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.docx"`);
        res.send(buffer);
    } catch (e) { console.error('Export DOCX error:', e); res.status(500).send('Export failed'); }
});

// PDF
app.get('/book/:id/export/pdf', isAuth, async (req, res) => {
    if (!await canModifyBook(req, req.params.id)) return res.status(403).send('Forbidden');
    try {
        const { book, entries } = await getBookWithEntries(req.params.id);
        const doc = new PDFDocument({ margin: 72, size: 'A4' });
        const filename = book.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
        doc.pipe(res);
        // Title page
        doc.fontSize(28).font('Helvetica-Bold').text(book.title, { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(11).font('Helvetica').fillColor('#666666').text('Exported from Book Forge · vectraarch.live', { align: 'center' });
        doc.fillColor('#000000');
        entries.forEach((entry, i) => {
            doc.addPage();
            doc.fontSize(16).font('Helvetica-Bold').text(entry.title || `Chapter ${i + 1}`);
            doc.moveDown(0.8);
            doc.fontSize(11).font('Helvetica').lineGap(4);
            const paras = (entry.content || '').split(/\n\n+/).filter(p => p.trim());
            paras.forEach(para => {
                doc.text(para.trim(), { align: 'justify', indent: 24 });
                doc.moveDown(0.6);
            });
        });
        doc.end();
    } catch (e) { console.error('Export PDF error:', e); res.status(500).send('Export failed'); }
});

// EPUB
app.get('/book/:id/export/epub', isAuth, async (req, res) => {
    if (!await canModifyBook(req, req.params.id)) return res.status(403).send('Forbidden');
    try {
        const { book, entries } = await getBookWithEntries(req.params.id);
        const chapters = entries.map((entry, i) => ({
            title: entry.title || `Chapter ${i + 1}`,
            content: '<div>' + (entry.content || '')
                .split(/\n\n+/).filter(p => p.trim())
                .map(p => `<p style="text-indent:1.5em;margin:0 0 0.8em 0">${p.trim()}</p>`)
                .join('') + '</div>'
        }));
        const options = {
            title: book.title,
            author: 'Vectra Arch Press',
            publisher: 'Vectra Arch Press',
            cover: book.cover_url || undefined,
            content: chapters,
            css: 'body{font-family:Georgia,serif;font-size:1em;line-height:1.7;}h1{font-size:1.4em;margin:1em 0;}p{margin:0 0 0.8em;}'
        };
        const epubBuffer = await Epub(options, chapters);
        const filename = book.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        res.setHeader('Content-Type', 'application/epub+zip');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.epub"`);
        res.send(epubBuffer);
    } catch (e) { console.error('Export EPUB error:', e); res.status(500).send('Export failed'); }
});

// MARKDOWN
app.get('/book/:id/export/md', isAuth, async (req, res) => {
    if (!await canModifyBook(req, req.params.id)) return res.status(403).send('Forbidden');
    try {
        const { book, entries } = await getBookWithEntries(req.params.id);
        let md = `# ${book.title}\n\n---\n\n*Exported from Book Forge · Vectra Arch*\n\n---\n\n`;
        entries.forEach((entry, i) => {
            md += `## ${entry.title || `Chapter ${i + 1}`}\n\n`;
            md += (entry.content || '').trim() + '\n\n---\n\n';
        });
        const filename = book.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        res.setHeader('Content-Type', 'text/markdown');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.md"`);
        res.send(md);
    } catch (e) { console.error('Export MD error:', e); res.status(500).send('Export failed'); }
});

// TXT (plain text — widest compatibility)
app.get('/book/:id/export/txt', isAuth, async (req, res) => {
    if (!await canModifyBook(req, req.params.id)) return res.status(403).send('Forbidden');
    try {
        const { book, entries } = await getBookWithEntries(req.params.id);
        const divider = '='.repeat(60);
        let txt = `${book.title.toUpperCase()}\n${divider}\nExported from Book Forge · Vectra Arch\n${divider}\n\n`;
        entries.forEach((entry, i) => {
            txt += `\n${'-'.repeat(40)}\n${entry.title || `Chapter ${i + 1}`}\n${'-'.repeat(40)}\n\n`;
            txt += (entry.content || '').trim() + '\n\n';
        });
        const filename = book.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
        res.send(txt);
    } catch (e) { console.error('Export TXT error:', e); res.status(500).send('Export failed'); }
});

// ── 2FA ───────────────────────────────────────────────────────────────────

app.get('/auth/2fa/setup', isAuth, async (req, res) => {
    const uid = getCurrentID(req);
    const u = await pool.query('SELECT twofa_secret FROM users WHERE id=$1', [uid]);
    if (u.rows[0].twofa_secret) return res.redirect(BASE + '/');
    const secret = authenticator.generateSecret();
    const qr = await qrcode.toDataURL(authenticator.keyuri(uid, 'BookForge', secret));
    req.session.tempSecret = secret;
    res.render('2fa_setup', { qr, secret });
});

app.post('/auth/2fa/setup', isAuth, async (req, res) => {
    if (!req.session.tempSecret) return res.redirect(BASE + '/');
    if (authenticator.check(req.body.token, req.session.tempSecret)) {
        await pool.query('UPDATE users SET twofa_secret=$1 WHERE id=$2', [req.session.tempSecret, getCurrentID(req)]);
        delete req.session.tempSecret;
        res.redirect(BASE + '/');
    } else { res.redirect('https://vectraarch.live/foundation/'); }
});

app.get('/auth/2fa', (req, res) => {
    if (!req.session.needs2FA) return res.redirect(BASE + '/');
    res.render('2fa_verify', { error: null });
});

app.post('/auth/2fa', async (req, res) => {
    const uid = getCurrentID(req);
    if (!uid) { req.session.destroy(); return res.redirect(BASE + '/'); }
    const u = await pool.query('SELECT twofa_secret FROM users WHERE id=$1', [uid]);
    const secret = u.rows[0]?.twofa_secret;
    if (typeof secret !== 'string' || !secret) { delete req.session.needs2FA; return res.redirect(BASE + '/'); }
    try {
        if (authenticator.check(req.body.token, secret)) { delete req.session.needs2FA; res.redirect(BASE + '/'); }
        else { res.render('2fa_verify', { error: 'Invalid Resonance Code' }); }
    } catch { delete req.session.needs2FA; res.redirect(BASE + '/'); }
});



// ── ADMIN ─────────────────────────────────────────────────────────────────







// ── AUTH ──────────────────────────────────────────────────────────────────

app.post('/auth/manual', async (req, res) => {
    const u = await pool.query('SELECT * FROM users WHERE LOWER(name)=LOWER($1) AND password=$2', [req.body.cid, req.body.ak]);
    if (u.rows[0]?.status === 'enabled') {
        req.session.manualLogin = true; req.session.manualUser = u.rows[0].id;
        if (u.rows[0].twofa_secret) req.session.needs2FA = true;
        else delete req.session.needs2FA;
        await pool.query('UPDATE users SET logins=logins+1, last_login=$1 WHERE id=$2',
            [new Date().toLocaleString('en-ZA'), u.rows[0].id]);
        return res.redirect(BASE + '/');
    }
    res.redirect('https://vectraarch.live/foundation/');
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: BASE + '/' }), (req, res) => {
    pool.query('SELECT twofa_secret FROM users WHERE id=$1', [req.user.id]).then(r => {
        if (r.rows[0]?.twofa_secret) req.session.needs2FA = true;
        else delete req.session.needs2FA;
        res.redirect(BASE + '/');
    });
});
app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('https://vectraarch.live/foundation/'); });

// ── BOOKS ─────────────────────────────────────────────────────────────────

app.get('/book/:id', isAuth, async (req, res) => {
    const book = await pool.query('SELECT * FROM books WHERE id=$1', [req.params.id]);
    const entries = await pool.query('SELECT * FROM entries WHERE book_id=$1 ORDER BY id ASC', [req.params.id]);
    const data = { title: book.rows[0].title, manuscript:[], characters:[], factions:[], geography:[], research:[], science:[], world_rules:[], items:[], timeline:[] };
    let manuscriptWords = 0;
    entries.rows.forEach(e => {
        const count = e.content ? e.content.trim().split(/\s+/).filter(w=>w.length>0).length : 0;
        if (e.category==='manuscript') manuscriptWords += count;
        if (data[e.category]) data[e.category].push({ ...e, wordCount: count });
    });
    res.render('index', { data, bookId: req.params.id, manuscriptWords });
});

app.post('/book/:id/add', isAuth, async (req, res) => {
    await pool.query('INSERT INTO entries (id,book_id,category,title,content) VALUES ($1,$2,$3,$4,$5)',
        ['e_'+Date.now(), req.params.id, req.body.category, req.body.title, req.body.content]);
    res.redirect(BASE + '/book/' + req.params.id);
});

app.post('/create-book', isAuth, upload.single('coverFile'), async (req, res) => {
    let finalUrl = req.body.coverUrl || null;
    if (req.file) finalUrl = '/uploads/' + req.file.filename;
    await pool.query('INSERT INTO books (id,title,owner_id,cover_url) VALUES ($1,$2,$3,$4)',
        ['b_'+Date.now(), req.body.bookName, getCurrentID(req), finalUrl]);
    res.redirect(BASE + '/');
});

app.post('/book/edit/:id', isAuth, upload.single('coverFile'), async (req, res) => {
    let finalUrl = req.body.coverUrl;
    if (req.file) finalUrl = '/uploads/' + req.file.filename;
    if (finalUrl) await pool.query('UPDATE books SET title=$1,cover_url=$2 WHERE id=$3', [req.body.bookName, finalUrl, req.params.id]);
    else await pool.query('UPDATE books SET title=$1 WHERE id=$2', [req.body.bookName, req.params.id]);
    res.redirect(BASE + '/');
});

app.post('/book/delete/:id', isAuth, async (req, res) => {
    await pool.query('DELETE FROM entries WHERE book_id=$1', [req.params.id]);
    await pool.query('DELETE FROM books WHERE id=$1', [req.params.id]);
    res.redirect(BASE + '/');
});

app.post('/book/:id/edit/:category/:entryId', isAuth, async (req, res) => {
    await pool.query('UPDATE entries SET title=$1,content=$2 WHERE id=$3 AND book_id=$4',
        [req.body.title, req.body.content, req.params.entryId, req.params.id]);
    res.redirect(BASE + '/book/' + req.params.id);
});

app.post('/book/:id/delete/:category/:entryId', isAuth, async (req, res) => {
    await pool.query('DELETE FROM entries WHERE id=$1 AND book_id=$2', [req.params.entryId, req.params.id]);
    res.redirect(BASE + '/book/' + req.params.id);
});

app.listen(PORT, HOST, () => console.log('Book Forge Hub Online'));
