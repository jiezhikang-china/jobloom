(function (bindingName, cleanupKey) {
  if (window.top !== window || location.hostname !== 'www.zhipin.com') return;
  if (window[cleanupKey]) window[cleanupKey]();
  var listeners = [], observer, timer, inputTimer, lastScroll = 0, lastDetail = '', companyReported = false;
  function send(kind) {
    try { window[bindingName](JSON.stringify({ kind: kind, at: performance.timeOrigin + performance.now() })); } catch (_) {}
  }
  function on(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    listeners.push(function () { target.removeEventListener(event, handler, options); });
  }
  function pageKind() {
    var p = location.pathname;
    if (/\/web\/user\/|\/security-check\.html|\/web\/passport\/zp\/security\.html/.test(p)) return 'login';
    if (/^\/gongsi\//.test(p)) return 'company';
    if (/^\/job_detail\//.test(p)) return 'detail';
    if (/^\/web\/geek\/jobs/.test(p)) return 'list';
    return 'other';
  }
  if (pageKind() === 'login') { send('manual_verification'); return; }
  function visible(node) { return node && node.getClientRects().length > 0; }
  function ready() {
    if (pageKind() === 'company') {
      if (!companyReported && document.readyState !== 'loading' && document.body) { companyReported = true; send('company_ready'); }
      return;
    }
    var box = document.querySelector('.job-detail-box, .job-detail .job-detail-section') || (pageKind() === 'detail' ? document.body : null);
    var desc = document.querySelector('.job-detail-box .job-detail-body p.desc, .job-sec-text');
    if (visible(box) && visible(desc) && desc.textContent.trim().length >= 20) {
      var link = box.querySelector('a[href*="/job_detail/"]');
      var marker = (link ? link.getAttribute('href') : location.pathname)
        + ':' + desc.textContent.trim().length + ':' + desc.textContent.trim().slice(0, 40);
      if (marker !== lastDetail) { lastDetail = marker; send('detail_ready'); }
    }
  }
  function clickable(target) { return target && target.closest ? target.closest('a, button, [role="button"], .job-card-box, .expect-item, .not-suitable, .zp-type-item, .ui-select') : null; }
  on(document, 'click', function (event) {
    if (!event.isTrusted || pageKind() === 'other') return;
    var node = clickable(event.target); if (!node) return;
    var anchor = event.target.closest('a[href]');
    var href = anchor ? anchor.getAttribute('href') || '' : '';
    var text = (node.innerText || '').trim();
    if (node.closest('.not-suitable')) return send('feedback');
    if (/^继续沟通$/.test(text)) return send('confirm');
    if (node.closest('.op-btn-chat, .btn-startchat') || /^立即沟通$|^立即申请$/.test(text)) return send('submit');
    if (href.indexOf('/gongsi/') >= 0) return send('company');
    if (node.closest('.expect-item')) return send('source');
    if (node.closest('.job-card-box')) { lastDetail = ''; send('select'); setTimeout(ready, 250); return; }
    send('control');
  }, true);
  on(document, 'scroll', function (event) {
    if (!event.isTrusted || performance.now() - lastScroll < 1000) return;
    lastScroll = performance.now(); send('scroll');
  }, { capture: true, passive: true });
  on(document, 'input', function (event) {
    if (!event.isTrusted || pageKind() !== 'list') return;
    clearTimeout(inputTimer); inputTimer = setTimeout(function () { send('input'); }, 350);
  }, true);
  function entered() {
    if (document.visibilityState !== 'visible') return;
    if (pageKind() === 'company') send('company_ready');
    else if (pageKind() === 'detail' || visible(document.querySelector('.job-detail-box'))) send('detail_visible');
    else if (pageKind() === 'list') send('list');
  }
  on(document, 'visibilitychange', entered);
  on(window, 'popstate', function () { entered(); ready(); });
  on(window, 'pageshow', function () { entered(); ready(); });
  on(window, 'focus', entered);
  observer = new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(ready, 250); });
  observer.observe(document, { childList: true, subtree: true });
  window[cleanupKey] = function () {
    listeners.forEach(function (remove) { remove(); }); observer.disconnect(); clearTimeout(timer); clearTimeout(inputTimer);
    delete window[cleanupKey];
  };
  ready();
})(__BINDING_NAME__, __CLEANUP_KEY__);