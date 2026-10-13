/* Demo-store glue: resolves the site key (?w=wk_… persisted in localStorage), injects the
   real embed snippet, and wires a small SDK console. Not part of the widget bundle. */
(function () {
  var params = new URLSearchParams(location.search);
  // Only local API origins are accepted so a crafted link cannot load a foreign script.
  var LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
  var api = params.get('api') || localStorage.getItem('demo:api') || 'http://localhost:4000';
  if (!LOCAL.test(api)) api = 'http://localhost:4000';
  var key = params.get('w');
  try {
    if (key) localStorage.setItem('demo:siteKey', key);
    else key = localStorage.getItem('demo:siteKey');
    if (params.get('api')) localStorage.setItem('demo:api', api);
  } catch (e) {}

  function bar() {
    var el = document.createElement('div');
    el.className = 'demo-bar';
    el.innerHTML =
      '<strong>Demo store</strong>' +
      '<span>This page embeds the chat widget from <code></code>.</span>' +
      '<label>Site key <input placeholder="wk_…" aria-label="Site key" /></label>' +
      '<button type="button">Use key</button>';
    el.querySelector('code').textContent = api + '/widget/loader.js';
    var input = el.querySelector('input');
    input.value = key || '';
    el.querySelector('button').addEventListener('click', function () {
      var v = input.value.trim();
      if (!v) return;
      try {
        localStorage.setItem('demo:siteKey', v);
      } catch (e) {}
      location.search = '?w=' + encodeURIComponent(v);
    });
    document.body.insertBefore(el, document.body.firstChild);
  }

  function log(line) {
    var pre = document.getElementById('sdk-log');
    if (!pre) return;
    pre.textContent = '[' + new Date().toLocaleTimeString() + '] ' + line + '\n' + pre.textContent;
  }

  document.addEventListener('DOMContentLoaded', function () {
    bar();
    if (!key) {
      log('No site key yet — paste one above (create a website in the dashboard first).');
      return;
    }
    var s = document.createElement('script');
    s.async = true;
    s.src = api + '/widget/loader.js';
    s.setAttribute('data-site-key', key);
    document.head.appendChild(s);

    var events = ['ready', 'opened', 'closed', 'availability.changed', 'connection.changed', 'identity.changed', 'chat.requested', 'chat.started', 'message.received', 'unread.changed', 'chat.ended', 'rating.changed', 'invitation.displayed', 'invitation.accepted', 'offline.submitted', 'error'];
    events.forEach(function (name) {
      window.Talkivio('on', name, function (payload) {
        log(name + ' ' + JSON.stringify(payload));
      });
    });

    document.querySelectorAll('[data-sdk]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cmd = btn.getAttribute('data-sdk');
        var arg = btn.getAttribute('data-arg');
        var result = arg ? window.Talkivio(cmd, JSON.parse(arg)) : window.Talkivio(cmd);
        if (result && typeof result.then === 'function') {
          result.then(
            function (r) {
              log(cmd + ' → ' + JSON.stringify(r));
            },
            function (e) {
              log(cmd + ' ✗ ' + (e && e.code ? e.code : e));
            },
          );
        } else {
          log(cmd + ' → ' + JSON.stringify(result));
        }
      });
    });
  });
})();
