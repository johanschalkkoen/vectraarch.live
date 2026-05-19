// VectraArch — VAL_KOEN Auth Guard Instance
(function () {
  var LOGIN = '/VAL_KOEN/login.html';
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