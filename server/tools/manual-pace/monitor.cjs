'use strict';
const WebSocket = require('../../node_modules/ws');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
class CDP {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = [];
    socket.on('message', raw => {
      let value; try { value = JSON.parse(String(raw)); } catch { return; }
      if (value.id) {
        const p = this.pending.get(value.id); if (!p) return;
        this.pending.delete(value.id); clearTimeout(p.timer);
        if (value.error) p.reject(new Error(value.error.message)); else p.resolve(value.result || {});
      } else for (const listener of this.listeners) listener(value);
    });
    socket.on('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('浏览器连接已关闭')); }
      this.pending.clear();
    });
    socket.on('error', () => {});
  }
  static async connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('连接浏览器超时')); }, 4000);
      socket.once('open', () => { clearTimeout(timer); resolve(new CDP(socket)); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('无法连接浏览器')); });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('浏览器读取超时：' + method)); }, 4000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  close() { this.socket.close(); }
}
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(1800) });
  if (!response.ok) throw new Error('本机浏览器连接不可用');
  return response.json();
}
function allowedPage(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'www.zhipin.com'; } catch { return false; }
}
function pageKind(url) {
  if (!allowedPage(url)) return 'other';
  const p = new URL(url).pathname;
  if (/\/web\/user\/|\/security-check\.html|\/web\/passport\/zp\/security\.html/.test(p)) return 'login';
  if (/^\/gongsi\//.test(p)) return 'company';
  if (/^\/job_detail\//.test(p)) return 'detail';
  if (/^\/web\/geek\/chat/.test(p)) return 'chat';
  if (/^\/web\/geek\/jobs/.test(p)) return 'list';
  return 'other';
}
class DomMonitor {
  constructor({ onEvent, onState, onVerification, readyTimeoutMs = 8000 }) {
    this.readyTimeoutMs = readyTimeoutMs; this.onEvent = onEvent; this.onState = onState; this.onVerification = onVerification;
    this.pages = new Map(); this.active = false; this.connected = false; this.lastError = '';
    this.binding = '__boss_pace_' + randomBytes(8).toString('hex');
    this.cleanup = this.binding + '_cleanup'; this.world = this.binding + '_world';
    this.source = fs.readFileSync(path.join(__dirname, 'observer.js'), 'utf8')
      .replace('__BINDING_NAME__', JSON.stringify(this.binding)).replace('__CLEANUP_KEY__', JSON.stringify(this.cleanup));
  }
  state() {
    return { connected: this.connected, observingPages: [...this.pages.values()].filter(s => s.ready).length,
      observerError: this.lastError, verificationRequired: this.verificationRequired || false };
  }
  report(reason = '') { this.onState?.(this.state(), reason); }
  async start(port, identity) {
    await this.stop(); this.active = true; this.port = port; this.identity = identity;
    this.lastError = ''; this.verificationRequired = false;
    try {
      const version = await json('http://127.0.0.1:' + port + '/json/version');
      if (new URL(version.webSocketDebuggerUrl).pathname !== identity) throw new Error('浏览器实例已变化，请重新连接');
      this.browser = await CDP.connect(version.webSocketDebuggerUrl); this.connected = true;
      this.browser.listeners.push(event => {
        if (!this.active) return;
        if (['Target.targetInfoChanged', 'Target.targetCreated'].includes(event.method)) {
          const info = event.params.targetInfo;
          void this.attach({ ...info, id: info.targetId });
        }
      });
      this.browser.socket.on('close', () => {
        if (!this.active) return;
        this.connected = false; this.report('BOSS 浏览器连接已关闭');
      });
      await this.browser.send('Target.setDiscoverTargets', { discover: true });
      await this.discover();
      // Target discovery can start an installation before /json/list arrives.
      await Promise.allSettled([...this.pages.values()].map(slot => slot.install));
      if (!this.state().observingPages) throw new Error(this.lastError || '尚未在 BOSS 页面装好 DOM 监听，请确认页面已打开');
      if (this.verificationRequired) throw new Error('当前为登录或验证页面，请先在 Chrome 中人工处理后重新开始');
      this.interval = setInterval(() => { void this.discover(); }, 2000);
      this.report(); return this.state();
    } catch (error) { await this.stop(); this.lastError = error.message; this.report(); throw error; }
  }
  async discover() {
    if (!this.active || this.discovering) return;
    this.discovering = true;
    try {
      const version = await json('http://127.0.0.1:' + this.port + '/json/version');
      if (new URL(version.webSocketDebuggerUrl).pathname !== this.identity) throw new Error('浏览器实例已变化');
      const tabs = await json('http://127.0.0.1:' + this.port + '/json/list');
      this.connected = true;
      await Promise.allSettled(tabs.map(tab => this.attach(tab)));
      this.report();
    } catch (error) {
      this.connected = false; this.lastError = error.message; this.report('BOSS 浏览器已断开');
    } finally { this.discovering = false; }
  }
  attach(tab) {
    if (!this.active || tab.type !== 'page' || !allowedPage(tab.url)) return Promise.resolve();
    const existing = this.pages.get(tab.id);
    if (existing) return existing.install;
    const slot = { cdp: null, contextId: null, ready: false, script: null, mainFrame: null };
    this.pages.set(tab.id, slot);
    slot.install = this.install(tab, slot);
    return slot.install;
  }
  async install(tab, slot) {
    try {
      const cdp = await CDP.connect(tab.webSocketDebuggerUrl || 'ws://127.0.0.1:' + this.port + '/devtools/page/' + tab.id);
      slot.cdp = cdp;
      if (!this.active) { cdp.close(); return; }
      cdp.listeners.push(event => {
        if (!this.active) return;
        const p = event.params || {};
        if (event.method === 'Runtime.bindingCalled' && p.name === this.binding) {
          let value; try { value = JSON.parse(p.payload); } catch { return; }
          if (!value || typeof value !== 'object') return;
          if (value.kind === 'observer_ready') {
            slot.contextId = p.executionContextId; slot.ready = true; this.lastError = ''; this.report(); return;
          }
          if (p.executionContextId !== slot.contextId) return;
          if (value.kind === 'manual_verification') {
            this.verificationRequired = true; this.onVerification?.(); return;
          }
          this.onEvent?.(value);
        }
        const navigated = event.method === 'Page.frameNavigated' && !p.frame.parentId;
        const within = event.method === 'Page.navigatedWithinDocument' && p.frameId === slot.mainFrame;
        if (navigated || within) {
          if (navigated) {
            slot.mainFrame = p.frame.id; slot.ready = false; slot.contextId = null; this.report();
            if (slot.script && allowedPage(p.frame.url)) void this.bindContext(slot).catch(error => {
              this.lastError = error.message; this.report('DOM 监听重新连接失败');
            });
          }
          const url = navigated ? p.frame.url : p.url;
          if (!allowedPage(url)) return;
          this.onEvent?.({ kind: 'navigate', at: Date.now(), page: pageKind(url), action: 'navigation' });
          if (pageKind(url) === 'login') { this.verificationRequired = true; this.onVerification?.(); }
        }
      });
      cdp.socket.on('close', () => {
        if (this.pages.get(tab.id) === slot) {
          this.pages.delete(tab.id);
          if (this.active) this.report(this.state().observingPages ? '' : '已关闭最后一个受监控的 BOSS 页面');
        }
      });
      // Binding events work without Runtime.enable. Do not subscribe to or serialize site console objects.
      await cdp.send('Page.enable');
      slot.mainFrame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
      slot.script = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: this.source, worldName: this.world })).identifier;
      await this.bindContext(slot);

      // The target URL may already say BOSS while its initial document is still blank.
      // Keep the new-document script installed and wait for its actual ready handshake.
      const deadline = Date.now() + this.readyTimeoutMs;
      while (this.active && !slot.ready && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (!slot.ready) throw new Error('DOM 监听器未返回就绪确认，请等待 BOSS 页面加载后重试');
      this.report();
    } catch (error) {
      this.lastError = error.message;
      // Remove partial installations before allowing a retry.
      if (slot.script) await slot.cdp?.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: slot.script }).catch(() => {});
      slot.cdp?.close();
      if (this.pages.get(tab.id) === slot) this.pages.delete(tab.id);
      this.report();
    }
  }
  bindContext(slot) {
    slot.rebind = true;
    if (slot.binding) return slot.binding;
    slot.binding = (async () => {
      const deadline = Date.now() + this.readyTimeoutMs;
      while (this.active && slot.rebind && slot.cdp.socket.readyState === WebSocket.OPEN) {
        if (Date.now() > deadline) throw new Error('页面切换期间 DOM 监听连接超时');
        slot.rebind = false;
        try {
          slot.contextId = (await slot.cdp.send('Page.createIsolatedWorld', { frameId: slot.mainFrame, worldName: this.world })).executionContextId;
          // Bind only our isolated context; Runtime.enable would also subscribe to site console objects.
          await slot.cdp.send('Runtime.addBinding', { name: this.binding, executionContextId: slot.contextId });
          const result = await slot.cdp.send('Runtime.evaluate', { expression: this.source, contextId: slot.contextId, returnByValue: true });
          if (result.exceptionDetails) throw new Error('DOM 监听脚本安装失败');
        } catch (error) {
          if (!/context.*(?:destroyed|not found)|Cannot find context/i.test(error.message)) throw error;
          slot.rebind = true; await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    })().finally(() => { slot.binding = null; });
    return slot.binding;
  }
  async stop() {
    this.active = false; clearInterval(this.interval); this.interval = null;
    const slots = [...this.pages.values()]; this.pages.clear();
    await Promise.allSettled(slots.map(async slot => {
      await slot.install; await slot.binding?.catch(() => {});
      if (!slot.cdp) return;
      if (slot.contextId) await slot.cdp.send('Runtime.evaluate', {
        expression: 'window[' + JSON.stringify(this.cleanup) + ']?.()', contextId: slot.contextId,
      }).catch(() => {});
      if (slot.script) await slot.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: slot.script }).catch(() => {});
      await slot.cdp.send('Runtime.removeBinding', { name: this.binding }).catch(() => {});
      slot.cdp.close();
    }));
    this.browser?.close(); this.browser = null; this.connected = false; this.report();
  }
}
module.exports = { DomMonitor, CDP, json, allowedPage, pageKind };
