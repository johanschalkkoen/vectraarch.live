// VectraArch Legacy — Trial Countdown Banner
// Self-contained, dependency-free. Loaded near the end of <body> on the app
// page. Shows a slim banner only while the account is on its free trial (with a
// days-left countdown) or once the trial has expired. Paid/active accounts and
// admins see nothing. The banner never gates anything — it's purely a nudge;
// the real enforcement is server-side (requirePaid → 402) and the auth guard.
(function () {
  var user;
  try { user = JSON.parse(localStorage.getItem('user') || 'null'); } catch (e) { return; }
  if (!user || !user.username) return;

  function injectStyles() {
    if (document.getElementById('va-trial-style')) return;
    var css = ''
      + '#va-trial-banner{position:fixed;left:0;right:0;bottom:0;z-index:9000;'
      + 'display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;'
      + 'padding:10px 16px;font-family:"DM Mono",monospace;font-size:12px;'
      + 'border-top:1px solid rgba(212,160,23,.35);'
      + 'background:linear-gradient(180deg,rgba(20,17,8,.94),rgba(12,10,6,.98));'
      + 'backdrop-filter:blur(8px);box-shadow:0 -6px 24px rgba(0,0,0,.4);'
      + 'transform:translateY(100%);transition:transform .3s ease;}'
      + '#va-trial-banner.show{transform:translateY(0);}'
      + '#va-trial-banner.expired{border-top-color:rgba(255,107,107,.45);'
      + 'background:linear-gradient(180deg,rgba(28,10,10,.94),rgba(14,8,8,.98));}'
      + '#va-trial-banner .va-tb-dot{width:8px;height:8px;border-radius:50%;'
      + 'background:#d4a017;box-shadow:0 0 8px rgba(212,160,23,.8);flex:none;'
      + 'animation:vaTbPulse 2s infinite;}'
      + '#va-trial-banner.expired .va-tb-dot{background:#ff6b6b;box-shadow:0 0 8px rgba(255,107,107,.8);}'
      + '@keyframes vaTbPulse{0%,100%{opacity:1}50%{opacity:.35}}'
      + '#va-trial-banner .va-tb-text{color:#e8dcc0;letter-spacing:.02em;}'
      + '#va-trial-banner.expired .va-tb-text{color:#ffd0d0;}'
      + '#va-trial-banner .va-tb-text b{color:#fff;font-weight:500;}'
      + '#va-trial-banner .va-tb-cta{font-size:11px;letter-spacing:.08em;text-transform:uppercase;'
      + 'padding:7px 16px;border-radius:5px;border:1px solid #d4a017;color:#d4a017;'
      + 'background:transparent;cursor:pointer;text-decoration:none;transition:background .15s,color .15s;}'
      + '#va-trial-banner .va-tb-cta:hover{background:#d4a017;color:#0a0a0a;}'
      + '#va-trial-banner.expired .va-tb-cta{border-color:#ff6b6b;color:#ff6b6b;}'
      + '#va-trial-banner.expired .va-tb-cta:hover{background:#ff6b6b;color:#0a0a0a;}'
      + '#va-trial-banner .va-tb-x{background:none;border:none;color:#776a4d;font-size:16px;'
      + 'line-height:1;cursor:pointer;padding:4px 6px;flex:none;}'
      + '#va-trial-banner .va-tb-x:hover{color:#d4a017;}'
      + 'body.va-trial-pad{padding-bottom:48px;}';
    var s = document.createElement('style');
    s.id = 'va-trial-style'; s.textContent = css;
    document.head.appendChild(s);
  }

  // Suppress the trial banner for the rest of the day once dismissed. The
  // expired banner is not dismissable — access is locked anyway.
  function dismissedToday() {
    return localStorage.getItem('va_trial_dismissed') === new Date().toISOString().slice(0, 10);
  }

  function render(sub) {
    if (!sub) return;
    if (sub.status === 'active') return;           // paying — no banner
    if (sub.status === 'trial' && dismissedToday()) return;

    injectStyles();
    var expired = sub.status !== 'trial';          // expired / cancelled
    var bar = document.createElement('div');
    bar.id = 'va-trial-banner';
    if (expired) bar.className = 'expired';

    var dot = document.createElement('span'); dot.className = 'va-tb-dot';

    var txt = document.createElement('span'); txt.className = 'va-tb-text';
    if (expired) {
      txt.innerHTML = 'Your free trial has ended — subscribe to keep your data flowing.';
    } else {
      var n = sub.daysLeft;
      txt.innerHTML = 'Free trial · <b>' + n + ' day' + (n === 1 ? '' : 's') + '</b> left. '
        + 'Subscribe before it ends to keep full access.';
    }

    var cta = document.createElement('a');
    cta.className = 'va-tb-cta';
    cta.textContent = expired ? 'Subscribe now' : 'Subscribe';
    cta.href = '/billing.html';

    bar.appendChild(dot);
    bar.appendChild(txt);
    bar.appendChild(cta);

    if (!expired) {
      var x = document.createElement('button');
      x.className = 'va-tb-x'; x.setAttribute('aria-label', 'Dismiss'); x.innerHTML = '&times;';
      x.onclick = function () {
        localStorage.setItem('va_trial_dismissed', new Date().toISOString().slice(0, 10));
        bar.classList.remove('show');
        document.body.classList.remove('va-trial-pad');
        setTimeout(function () { bar.remove(); }, 300);
      };
      bar.appendChild(x);
    }

    document.body.appendChild(bar);
    document.body.classList.add('va-trial-pad');
    // Next frame so the slide-up transition runs.
    requestAnimationFrame(function () { requestAnimationFrame(function () { bar.classList.add('show'); }); });
  }

  function start() {
    fetch('/api/billing/status?user=' + encodeURIComponent(user.username))
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.success) render(d.subscription); })
      .catch(function () { /* silent — banner is non-critical */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
