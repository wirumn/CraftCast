// ==UserScript==
// @name         Dashboard <-> Local Bridge
// @namespace    https://github.com/yourname/overlay-tool
// @version      1.2.0
// @description  Two-way sync between a local WebSocket app (127.0.0.1:8014) and a reactive web dashboard.
// @author       you
// @match        https://your-dashboard.example.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ---- Config --------------------------------------------------------------
  // Adjust the three selectors to match your dashboard's DOM.
  const CONFIG = {
    wsUrl:            'ws://127.0.0.1:8014',
    conditionSelect:  'select[x-bind-value="condition$"]',
    listContainer:    '#instruction-list', // element whose children are the list items
    listItem:         ':scope > *',         // "top item" = first match inside the container
    sendDebounceMs:   120,
    suppressOutboundMs: 400,                 // ignore scrapes triggered by our own inbound write
    reconnect: {
      baseDelayMs: 1000,
      maxDelayMs:  30000,
      factor:      2,
      jitterRatio: 0.25,
    },
    heartbeat: {
      intervalMs: 15000, // send {"type":"ping"} this often
      timeoutMs:  30000, // no pong within this window => force reconnect
    },
  };

  const log = (...a) => console.debug('[bridge]', ...a);

  // ---- WebSocket manager ---------------------------------------------------
  let socket = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let manualClose = false;

  // Heartbeat state.
  let heartbeatTimer = null;
  let lastPongAt = 0;

  // Most-recent scraped value; lets a reconnect flush the latest state.
  let pendingAction = null;
  let lastSentAction = null;

  // Step-aware guard: last 'step' we actually acted on.
  let lastProcessedStep = null;

  // Echo guard: suppress outbound scrapes until this timestamp.
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
    try {
      socket = new WebSocket(CONFIG.wsUrl);
    } catch (e) {
      log('construct failed', e);
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      reconnectAttempts = 0;
      setStatus('connected', 'Connected');
      log('connected');
      startHeartbeat();
      if (pendingAction !== null && pendingAction !== lastSentAction) {
        sendAction(pendingAction); // flush state that changed while offline
      }
    });

    socket.addEventListener('message', (ev) => handleIncoming(ev.data));

    socket.addEventListener('close', () => {
      log('closed');
      stopHeartbeat();
      if (manualClose) {
        setStatus('disconnected', 'Disconnected');
      } else {
        scheduleReconnect();
      }
    });

    // 'error' is always followed by 'close'; let close drive the reconnect.
    socket.addEventListener('error', () => {
      try { socket.close(); } catch (_) {}
    });
  }

  function scheduleReconnect() {
    const delay = computeBackoff();
    reconnectAttempts++;
    setStatus('reconnecting', `Reconnecting [Attempt ${reconnectAttempts}]`);
    log(`reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  function sendAction(name) {
    pendingAction = name;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ next_action: name }));
      lastSentAction = name;
      log('sent next_action', name);
    } catch (e) {
      log('send failed', e);
    }
  }

  // ---- Heartbeat -----------------------------------------------------------
  // The browser WebSocket API cannot emit protocol ping frames, so this is an
  // application-level ping/pong. A missing pong is the only reliable signal of
  // a silently half-open socket (sleep, NIC switch, etc.).
  function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > CONFIG.heartbeat.timeoutMs) {
        log('heartbeat timeout — forcing reconnect');
        try { socket.close(); } catch (_) {} // close handler triggers reconnect
        return;
      }
      try { socket.send(JSON.stringify({ type: 'ping' })); }
      catch (e) { log('ping send failed', e); }
    }, CONFIG.heartbeat.intervalMs);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  // ---- Incoming: drive the reactive dropdown (step-aware) ------------------
  // Grab the prototype setter so we update the DOM even if the framework
  // installed its own value accessor on the element.
  const nativeSelectValueSetter =
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;

  function setReactiveSelectValue(select, value) {
    // Open the echo-suppression window before mutating, so the observer
    // callback our own write may trigger is ignored.
    suppressUntil = Date.now() + CONFIG.suppressOutboundMs;

    if (nativeSelectValueSetter) {
      nativeSelectValueSetter.call(select, value);
    } else {
      select.value = value;
    }
    select.dispatchEvent(new Event('input',  { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function handleIncoming(raw) {
    let msg;
    try { msg = JSON.parse(raw); }
    catch (_) { log('non-JSON message ignored'); return; }

    if (typeof msg !== 'object' || msg === null) return;

    // Heartbeat reply: refresh liveness and stop.
    if (msg.type === 'pong') { lastPongAt = Date.now(); return; }

    if (typeof msg.condition !== 'string') return;

    const step = (typeof msg.step === 'number' && Number.isFinite(msg.step)) ? msg.step : null;

    // Step-aware guard: ignore repeated broadcasts of the same step.
    if (step !== null && step === lastProcessedStep) {
      log('duplicate step', step, 'ignored');
      return;
    }

    const select = document.querySelector(CONFIG.conditionSelect);
    if (!select) { log('condition select not found'); return; }

    // Record the step even if the value is unchanged, so we don't re-check it.
    if (step !== null) lastProcessedStep = step;

    if (select.value === msg.condition) {
      log('condition already', msg.condition, '— step advanced, no DOM change');
      return;
    }

    setReactiveSelectValue(select, msg.condition);
    log('applied condition', msg.condition, 'step', step);
  }

  // ---- Outgoing: watch the list, scrape the top item -----------------------
  let observer = null;
  let sendTimer = null;

  function topItemText(container) {
    const item = CONFIG.listItem
      ? container.querySelector(CONFIG.listItem)
      : container.firstElementChild;
    return item ? item.textContent.trim() : null;
  }

  function attachObserver(container) {
    const evaluate = () => {
      // Echo guard: if we just wrote to the DOM, skip — but re-check once the
      // window closes so a genuine change during it isn't lost.
      const now = Date.now();
      if (now < suppressUntil) {
        clearTimeout(suppressTimer);
        suppressTimer = setTimeout(evaluate, suppressUntil - now + 10);
        return;
      }
      const text = topItemText(container);
      if (text && text !== lastSentAction) sendAction(text);
    };

    observer = new MutationObserver(() => {
      clearTimeout(sendTimer);
      sendTimer = setTimeout(evaluate, CONFIG.sendDebounceMs);
    });

    observer.observe(container, { childList: true, subtree: true, characterData: true });
    evaluate(); // capture the initial top item
    log('observer attached');
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

  // ---- Visual status indicator ---------------------------------------------
  let statusEl = null;
  let currentStatus = { state: 'reconnecting', text: 'Connecting…' };

  const STATUS_DOT = {
    connected:    '#2ecc71',
    reconnecting: '#f39c12',
    disconnected: '#e74c3c',
  };

  function ensureIndicator() {
    if (statusEl || !document.body) return;

    statusEl = document.createElement('div');
    statusEl.id = '__bridge_status__';
    Object.assign(statusEl.style, {
      position: 'fixed', right: '12px', bottom: '12px',
      zIndex: '2147483647',
      font: '12px/1.4 system-ui, -apple-system, sans-serif',
      padding: '6px 10px', borderRadius: '6px',
      background: 'rgba(20,20,20,0.85)', color: '#fff',
      display: 'flex', alignItems: 'center', gap: '8px',
      pointerEvents: 'none', userSelect: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    });

    const dot = document.createElement('span');
    dot.className = 'dot';
    Object.assign(dot.style, {
      width: '9px', height: '9px', borderRadius: '50%',
      display: 'inline-block', flex: '0 0 auto',
    });

    const label = document.createElement('span');
    label.className = 'label';

    statusEl.append(dot, label);
    document.body.appendChild(statusEl);
    renderStatus();
  }

  function renderStatus() {
    if (!statusEl) return;
    statusEl.querySelector('.dot').style.background =
      STATUS_DOT[currentStatus.state] || STATUS_DOT.disconnected;
    statusEl.querySelector('.label').textContent = currentStatus.text;
  }

  function setStatus(state, text) {
    currentStatus = { state, text: text || state };
    renderStatus();
  }

  // ---- Lifecycle -----------------------------------------------------------
  window.addEventListener('beforeunload', () => {
    manualClose = true;
    clearTimeout(reconnectTimer);
    stopHeartbeat();
    if (socket)   { try { socket.close(); } catch (_) {} }
    if (observer) observer.disconnect();
  });

  connect();

  function onReady() {
    ensureIndicator();
    waitForContainer();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();
