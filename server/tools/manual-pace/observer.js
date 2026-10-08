(function (bindingName, cleanupKey) {
  if (window.top !== window || location.hostname !== 'www.zhipin.com') return;
  var pendingKey = bindingName + '_pending';
  var listeners = [], observer, timer, lastScroll = -Infinity, lastDetail = '', companyReported = false;
  function pageKind() {
    var p = location.pathname;
    if (/\/web\/user\/|\/security-check\.html|\/web\/passport\/zp\/security\.html/.test(p)) return 'login';
    if (/^\/gongsi\//.test(p)) return 'company';
    if (/^\/job_detail\//.test(p)) return 'detail';
    if (/^\/web\/geek\/chat/.test(p)) return 'chat';
    if (/^\/web\/geek\/jobs/.test(p)) return 'list';
    return 'other';
  }
  // Only structural tags/classes leave the page. No text, href, input value or ID.
  function targetOf(node) {
    if (node === document || node === window) return 'document';
    if (!node || !node.tagName) return '';
    var classes = Array.from(node.classList || []).filter(function (c) {
      return /^[A-Za-z_-][A-Za-z0-9_-]{0,39}$/.test(c);
    }).slice(0, 3);
    return node.tagName.toLowerCase() + (classes.length ? '.' + classes.join('.') : '');
  }
  function send(kind, node, action, event) {
    var stamp = event && event.timeStamp;
    var at = Number.isFinite(stamp) && stamp > 0 ? (stamp > 1e12 ? stamp : performance.timeOrigin + stamp)
      : performance.timeOrigin + performance.now();
    var payload = JSON.stringify({ kind: kind, at: at, target: targetOf(node), page: pageKind(), action: action || 'ready' });
    try {
      if (typeof window[bindingName] === 'function') window[bindingName](payload);
      else {
        var pending = window[pendingKey] || (window[pendingKey] = []);
        if (pending.length < 1000) pending.push(payload);
      }
    } catch (_) {}
  }
  function flush() {
    if (typeof window[bindingName] !== 'function') return;
    var pending = window[pendingKey] || [];
    pending.splice(0).forEach(function (payload) { window[bindingName](payload); });
    delete window[pendingKey];
  }
  if (window[cleanupKey]) { flush(); send('observer_ready'); return; }
  function on(target, event, handler, options) {
    target.addEventListener(event, handler, options);
    listeners.push(function () { target.removeEventListener(event, handler, options); });
  }
  window[cleanupKey] = function () {
    listeners.forEach(function (remove) { remove(); });
    if (observer) observer.disconnect(); clearTimeout(timer);
    delete window[cleanupKey]; delete window[pendingKey];
  };
  send('observer_ready');
  if (pageKind() === 'login') { send('manual_verification'); return; }
  function visible(node) { return node && node.getClientRects().length > 0; }
  function ready() {
    if (pageKind() === 'login') { send('manual_verification'); return; }
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
      if (marker !== lastDetail) { lastDetail = marker; send('detail_ready', box); }
    }
  }
  on(document, 'click', function (event) {
    if (!event.isTrusted || pageKind() === 'login') return;
    var raw = event.target && event.target.nodeType === 1 ? event.target : event.target.parentElement;
    if (!raw || !raw.closest) return;
    var node = raw.closest('a, button, [role="button"], .job-card-box, .expect-item, .not-suitable, .zp-type-item, .ui-select') || raw;
    var anchor = raw.closest('a[href]');
    var href = anchor ? anchor.getAttribute('href') || '' : '';
    var text = (node.innerText || '').trim(), kind = 'click';
    if (raw.closest('.not-suitable')) kind = 'feedback';
    else if (/^继续沟通$/.test(text)) kind = 'confirm';
    else if (raw.closest('.op-btn-chat, .btn-startchat') || /^立即沟通$|^立即申请$/.test(text)) kind = 'submit';
    else if (href.indexOf('/gongsi/') >= 0) kind = 'company';
    else if (raw.closest('.expect-item')) kind = 'source';
    else if (raw.closest('.job-card-box')) { lastDetail = ''; kind = 'select'; }
    send(kind, node, 'click', event);
    if (kind === 'select') { clearTimeout(timer); timer = setTimeout(ready, 250); }
  }, true);
  on(document, 'scroll', function (event) {
    if (!event.isTrusted || pageKind() === 'login' || performance.now() - lastScroll < 180) return;
    lastScroll = performance.now(); send('scroll', event.target, 'scroll', event);
  }, { capture: true, passive: true });
  on(document, 'input', function (event) {
    if (event.isTrusted && pageKind() !== 'login') send('input', event.target, 'input', event);
  }, true);
  on(document, 'focusin', function (event) {
    if (event.isTrusted && pageKind() !== 'login') send('focus', event.target, 'focus', event);
  }, true);
  function entered() {
    if (document.visibilityState !== 'visible' || pageKind() === 'login') return;
    if (pageKind() === 'company') send('company_ready', null, 'focus');
    else if (pageKind() === 'detail' || visible(document.querySelector('.job-detail-box'))) send('detail_visible', null, 'focus');
    else if (pageKind() === 'list') send('list', null, 'focus');
  }
  on(document, 'visibilitychange', entered);
  on(window, 'popstate', function () { entered(); ready(); });
  on(window, 'pageshow', function () { entered(); ready(); });
  on(window, 'focus', entered);
  observer = new MutationObserver(function () { clearTimeout(timer); timer = setTimeout(ready, 250); });
  observer.observe(document, { childList: true, subtree: true });
  ready();
})(__BINDING_NAME__, __CLEANUP_KEY__);
