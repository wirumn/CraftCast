// ==UserScript==
// @name         Dashboard <-> Local Bridge
// @namespace    https://github.com/wirumn/CraftCast
// @version      1.3.0
// @description  Two-way sync between a local WebSocket app (127.0.0.1:8014) and a reactive web dashboard.
// @author       you
// @match        https://thiria.com/expert/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    wsUrl:            'ws://127.0.0.1:8014',
    conditionSelect:  'select[x-bind-value="condition$"]',
    listContainer:    '#instruction-list',
    listItem:         ':scope > *',
    sendDebounceMs:   120,
    suppressOutboundMs: 400,
    reconnect: { baseDelayMs: 1000, maxDelayMs: 30000, factor: 2, jitterRatio: 0.25 },
    heartbeat: { intervalMs: 15000, timeoutMs: 30000 },
  };

  const log = (...a) => console.debug('[bridge]', ...a);

  let socket = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let manualClose = false;
  let heartbeatTimer = null;
  let lastPongAt = 0;
  let pendingAction = null;
  let lastSentAction = null;
  let lastProcessedStep = null;
  let suppressUntil = 0;
  let suppressTimer = null;

  function computeBackoff() {
    const { baseDelayMs, maxDelayMs, factor, jitterRatio } = CONFIG.reconnect;
    const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, reconnectAttempts));
    const jitter = raw * jitterRatio * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(raw + jitter));
  }

  function connect() {
    clearTimeout(reconnectTimer);
    setStatus('reconnecting', 'Connecting…');
    try { socket = new WebSocket(CONFIG.wsUrl); } catch (e) { log('construct failed', e); scheduleReconnect(); return; }

    socket.addEventListener('open', () => {
      reconnectAttempts = 0;
      setStatus('connected', 'Connected');
      log('connected');
      startHeartbeat();
      if (pendingAction !== null && pendingAction !== lastSentAction) sendAction(pendingAction);
    });

    socket.addEventListener('message', (ev) => handleIncoming(ev.data));
    socket.addEventListener('close', () => { log('closed'); stopHeartbeat(); manualClose ? setStatus('disconnected', 'Disconnected') : scheduleReconnect(); });
    socket.addEventListener('error', () => { try { socket.close(); } catch (_) {} });
  }

  function scheduleReconnect() {
    const delay = computeBackoff();
    reconnectAttempts++;
    setStatus('reconnecting', `Reconnecting [Attempt ${reconnectAttempts}]`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function sendAction(name) {
    pendingAction = name;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify({ next_action: name })); lastSentAction = name; log('sent next_action', name); } catch (e) {}
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > CONFIG.heartbeat.timeoutMs) { try { socket.close(); } catch (_) {} return; }
      try { socket.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
    }, CONFIG.heartbeat.intervalMs);
  }
  function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

  const nativeSelectValueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

  function setReactiveValue(el, value) {
    suppressUntil = Date.now() + CONFIG.suppressOutboundMs;
    if (el.tagName === 'INPUT' && nativeInputValueSetter) { nativeInputValueSetter.call(el, value); }
    else if (nativeSelectValueSetter) { nativeSelectValueSetter.call(el, value); }
    else { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setInputByLabel(labelText, value) {
    if (!value) return;
    const labels = Array.from(document.querySelectorAll('label, .label'));
    const labelTextLower = labelText.toLowerCase();
    const label = labels.find(l => {
      const text = l.textContent.trim().toLowerCase();
      return text === labelTextLower || (labelTextLower.length > 5 && text.startsWith(labelTextLower.substring(0, 6)));
    });
    if (!label) return;
    const container = label.closest('.labelrow, .simplerow');
    if (!container) return;
    const input = container.querySelector('input');
    if (!input || input.value == value) return;
    setReactiveValue(input, value);
    log('auto-updated', labelText, 'to', value);
  }

  function handleIncoming(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (typeof msg !== 'object' || msg === null) return;
    if (msg.type === 'pong') { lastPongAt = Date.now(); return; }

    // Auto-update character stats
    if (msg.craftsmanship) setInputByLabel('craftsmanship', msg.craftsmanship);
    if (msg.control) setInputByLabel('control', msg.control);
    if (msg.cp) setInputByLabel('cp', msg.cp);

    // Auto-update recipe stats
    if (msg.difficulty) setInputByLabel('progress', msg.difficulty);
    if (msg.durability) setInputByLabel('durability', msg.durability);
    if (msg.maxQuality) setInputByLabel('quality', msg.maxQuality);

    if (typeof msg.condition !== 'string') return;
    const step = (typeof msg.step === 'number' && Number.isFinite(msg.step)) ? msg.step : null;

    // Auto-click Start button if we haven't started the solver yet
    const startBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Start');
    if (startBtn && step !== null && step > 0) {
        startBtn.click();
        log('auto-clicked Start button');
        // Re-process this message in 500ms once the solver screen loads
        setTimeout(() => handleIncoming(raw), 500);
        return;
    }
    
    let advanced = false;
    if (step !== null && lastProcessedStep !== null && step > lastProcessedStep) {
        advanced = true;
    }

    if (step !== null && step === lastProcessedStep) return;

    const select = document.querySelector(CONFIG.conditionSelect);
    if (!select) return;
    
    if (step !== null) lastProcessedStep = step;

    setReactiveValue(select, msg.condition);
    log('applied condition', msg.condition, 'step', step);

    if (advanced) {
      setTimeout(() => {
        const btns = Array.from(document.querySelectorAll('button, label')).filter(b => b.textContent.includes('Success'));
        if (btns.length > 0) {
          const btn = btns[btns.length - 1]; // The active step is always the last one on the page
          btn.click();
          log('auto-clicked success');
        }
      }, 50);
    }
  }

  let observer = null;
  let sendTimer = null;

  function attachObserver(container) {
    const evaluate = () => {
      const now = Date.now();
      if (now < suppressUntil) { clearTimeout(suppressTimer); suppressTimer = setTimeout(evaluate, suppressUntil - now + 10); return; }
      const item = CONFIG.listItem ? container.querySelector(CONFIG.listItem) : container.firstElementChild;
      const text = item ? item.textContent.trim() : null;
      if (text && text !== lastSentAction) sendAction(text);
    };
    observer = new MutationObserver(() => { clearTimeout(sendTimer); sendTimer = setTimeout(evaluate, CONFIG.sendDebounceMs); });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    evaluate();
  }

  function waitForContainer() {
    const existing = document.querySelector(CONFIG.listContainer);
    if (existing) { attachObserver(existing); return; }
    const bootstrap = new MutationObserver(() => {
      const el = document.querySelector(CONFIG.listContainer);
      if (el) { bootstrap.disconnect(); attachObserver(el); }
    });
    bootstrap.observe(document.documentElement, { childList: true, subtree: true });
  }

  let statusEl = null;
  let currentStatus = { state: 'reconnecting', text: 'Connecting…' };
  const STATUS_DOT = { connected: '#2ecc71', reconnecting: '#f39c12', disconnected: '#e74c3c' };

  function ensureIndicator() {
    if (statusEl || !document.body) return;
    statusEl = document.createElement('div');
    statusEl.id = '__bridge_status__';
    Object.assign(statusEl.style, { position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647', font: '12px/1.4 system-ui', padding: '6px 10px', borderRadius: '6px', background: 'rgba(20,20,20,0.85)', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px', pointerEvents: 'none', userSelect: 'none' });
    const dot = document.createElement('span'); dot.className = 'dot';
    Object.assign(dot.style, { width: '9px', height: '9px', borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' });
    const label = document.createElement('span'); label.className = 'label';
    statusEl.append(dot, label); document.body.appendChild(statusEl);
    renderStatus();
  }

  function renderStatus() {
    if (!statusEl) return;
    statusEl.querySelector('.dot').style.background = STATUS_DOT[currentStatus.state] || STATUS_DOT.disconnected;
    statusEl.querySelector('.label').textContent = currentStatus.text;
  }

  function setStatus(state, text) { currentStatus = { state, text: text || state }; renderStatus(); }

  window.addEventListener('beforeunload', () => { manualClose = true; clearTimeout(reconnectTimer); stopHeartbeat(); if (socket) try { socket.close(); } catch (_) {} if (observer) observer.disconnect(); });
  connect();
  function onReady() { ensureIndicator(); waitForContainer(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady); else onReady();
})();
