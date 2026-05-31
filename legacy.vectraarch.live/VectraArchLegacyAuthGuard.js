// VectraArch Legacy — Auth Guard
// Include as the FIRST script in every Legacy page <head>.
// Redirects to login.html immediately if no valid session exists, and to
// billing.html if the account's trial/subscription has lapsed (the paygate).
// Runs before React, before Babel, before any CDN loads.
//
// Session format: localStorage 'user' key holds the full login response
// object, which contains at minimum { username, success: true }.
// No separate token — username presence is the auth signal.
(function () {
  var LOGIN   = '/login.html';
  var BILLING = '/billing.html';
  var path = window.location.pathname;
  // Pages that must remain reachable while locked out.
  if (path.endsWith('login.html') || path.endsWith('billing.html') || path.indexOf('/billing') === 0) return;

  var user;
  try {
    var raw = localStorage.getItem('user');
    if (!raw) { window.location.replace(LOGIN); return; }
    user = JSON.parse(raw);
    if (!user || !user.username || user.success === false) {
      localStorage.removeItem('user');
      window.location.replace(LOGIN);
      return;
    }
  } catch (e) {
    localStorage.removeItem('user');
    window.location.replace(LOGIN);
    return;
  }

  // Paygate: verify the account still has an active entitlement. We re-check
  // with the server (the cached copy can be stale) and redirect to the paywall
  // if the trial/subscription has lapsed. Admins are never gated server-side,
  // so they'll always come back active. Fail-open on network errors so a blip
  // doesn't lock a paying user out of their own data.
  try {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/billing/status?user=' + encodeURIComponent(user.username), false);
    xhr.send(null);
    if (xhr.status === 200) {
      var data = JSON.parse(xhr.responseText);
      if (data && data.success && data.subscription && data.subscription.active === false) {
        window.location.replace(BILLING);
      }
    }
  } catch (e) { /* fail open */ }
})();
