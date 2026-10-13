/* Minimal pushState router for the SPA demo page (query-string routes so reloads work). */
(function () {
  var views = {
    overview: ['Overview', 'Welcome back! You have 1 order on its way.'],
    orders: ['Orders', '#1042 · Stoneware mug set · Shipped · arriving Thursday'],
    returns: ['Returns', 'Start a return within 30 days of delivery. Need help? Ask in the chat.'],
    settings: ['Settings', 'Email preferences, addresses and payment methods.'],
  };
  function render() {
    var v = new URLSearchParams(location.search).get('view') || 'overview';
    var data = views[v] || views.overview;
    document.title = data[0] + ' — Northwind Goods (demo)';
    document.getElementById('spa-title').textContent = 'Your account · ' + data[0];
    document.getElementById('spa-view').textContent = data[1];
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-view]');
    if (!btn) return;
    var params = new URLSearchParams(location.search);
    params.set('view', btn.getAttribute('data-view'));
    history.pushState({}, '', location.pathname + '?' + params.toString());
    render();
  });
  window.addEventListener('popstate', render);
  render();
})();
