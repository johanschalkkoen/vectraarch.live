// VectraArch Legacy — Auth Guard
// Include as the FIRST script in every Legacy page <head>.
// Redirects to login.html immediately if no valid session exists.
// Runs before React, before Babel, before any CDN loads.
//
// Session format: localStorage 'user' key holds the full login response
// object, which contains at minimum { username, success: true }.
// No separate token — username presence is the auth signal.
(function () {
  var LOGIN = '/login.html';
  if (window.location.pathname.endsWith('login.html')) return;
  try {
    var raw = localStorage.getItem('user');
    if (!raw) { window.location.replace(LOGIN); return; }
    var user = JSON.parse(raw);
    if (!user || !user.username || user.success === false) {
      localStorage.removeItem('user');
      window.location.replace(LOGIN);
    }
  } catch (e) {
    localStorage.removeItem('user');
    window.location.replace(LOGIN);
  }
})();