// ==UserScript==
// @name         Dashboard <-> Local Bridge
// @namespace    https://github.com/wirumn/CraftCast
// @version      1.6.0
// @description  Two-way sync between a local WebSocket app (127.0.0.1:8014) and the Thiria crafting solver.
// @author       you
// @match        https://thiria.com/expert/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ===========================================================================
  // Config — every selector / heuristic / tunable lives here so a Thiria markup
  // change is a one-line fix instead of a hunt through the logic.
  // ===========================================================================
  const CONFIG = {
    wsUrl: 'ws://127.0.0.1:8014',

    // Scraping fallback (standard macro mode).
    listContainerSelectors: '#instruction-list, .instruction-list',

    // Canonical condition option VALUES Thiria uses (lowercase, camelCase for
    // multi-word). A <select> is identified as the condition dropdown when its
    // option values intersect this set — robust against text/label changes and
    // immune to false-matching the action dropdown (which shares no keys).
    conditionKeys: [
      'normal', 'good', 'excellent', 'poor', 'centered', 'sturdy',
      'pliant', 'malleable', 'primed', 'goodOmen', 'robust',
    ],

    // Map plugin condition keys -> Thiria option values where they differ.
    // Thiria option VALUES are lowercase even though their TEXT is Title Case.
    conditionMap: { goodomen: 'goodOmen' },

    // Stat label text -> incoming payload field. (Only fires if the plugin sends them.)
    statFields: {
      craftsmanship: 'craftsmanship',
      control:       'control',
      cp:            'cp',
      progress:      'difficulty',
      durability:    'durability',
      quality:       'maxQuality',
    },

    sendDebounceMs:      120,
    suppressOutboundMs:  400,
    solverStartRetryMs:  500,
    stepActionDelayMs:   500,
    labelSearchMaxDepth: 5,
    labelPrefixLen:      6,
    useFocusBlur:        true, // Thiria's framework intercepts via real focus/blur, NOT a native setter

    reconnect: { baseDelayMs: 1000, maxDelayMs: 30000, factor: 2, jitterRatio: 0.25 },
    heartbeat: { intervalMs: 15000, timeoutMs: 30000 },
  };

  const log  = (...a) => console.debug('[bridge]', ...a);
  const warn = (...a) => console.warn('[bridge]', ...a);

  // ===========================================================================
  // State
  // ===========================================================================
  let socket = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let manualClose = false;
  let heartbeatTimer = null;
  let lastPongAt = 0;

  let pendingAction = null;
  let lastSentAction = null;

  let lastProcessedStep = null;
  let lastProgress = 0;
  let lastQuality = 0;
  let lastCp = 0;
  let stepStartProgress = 0;
  let stepStartQuality = 0;
  let solverStarted = false; // per-craft guard so Start is clicked exactly once

  let suppressUntil = 0;
  let suppressTimer = null;

  const suppressOutbound = () => { suppressUntil = Date.now() + CONFIG.suppressOutboundMs; };

  // ===========================================================================
  // Shadow-DOM-aware queries.
  // Thiria renders its solver inside (open) shadow roots, which plain
  // document.querySelectorAll cannot see into — so element LOOKUP must walk
  // shadow roots, not just rely on composed events crossing the boundary.
  // ===========================================================================
  function deepQueryAll(selector, root = document) {
    const out = [];
    const visit = (node) => {
      if (!node.querySelectorAll) return;
      node.querySelectorAll(selector).forEach((el) => out.push(el));
      node.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
    };
    visit(root);
    return out;
  }
  const deepQuery = (selector, root = document) => deepQueryAll(selector, root)[0] || null;

  // ===========================================================================
  // WebSocket transport
  // ===========================================================================
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
      warn('socket construct failed', e);
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      reconnectAttempts = 0;
      setStatus('connected', 'Connected');
      startHeartbeat();
      if (pendingAction !== null && pendingAction !== lastSentAction) sendAction(pendingAction);
    });
    socket.addEventListener('message', (ev) => handleIncoming(ev.data));
    socket.addEventListener('close', () => {
      stopHeartbeat();
      if (manualClose) setStatus('disconnected', 'Disconnected');
      else scheduleReconnect();
    });
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
    try {
      socket.send(JSON.stringify({ next_action: name }));
      lastSentAction = name;
      log('sent next_action', name);
    } catch (e) {
      warn('send failed', e);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    lastPongAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > CONFIG.heartbeat.timeoutMs) {
        warn('heartbeat timeout — forcing reconnect');
        try { socket.close(); } catch (_) {}
        return;
      }
      try { socket.send(JSON.stringify({ type: 'ping' })); } catch (e) { warn('ping failed', e); }
    }, CONFIG.heartbeat.intervalMs);
  }
  function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

  // ===========================================================================
  // DOM writes (Thiria framework-safe: real focus/blur + bubbling composed events)
  // ===========================================================================
  function selectOption(select, value) {
    const v = String(value);
    const vl = v.toLowerCase();
    const opts = Array.from(select.options);
    let idx = opts.findIndex((o) => o.value === v);
    if (idx === -1) idx = opts.findIndex((o) => o.value.toLowerCase() === vl);
    if (idx === -1) idx = opts.findIndex((o) => o.textContent.trim().toLowerCase() === vl);
    if (idx === -1) return false;
    select.selectedIndex = idx;
    select.value = opts[idx].value;
    return true;
  }

  function setReactiveValue(el, value) {
    suppressOutbound();
    if (CONFIG.useFocusBlur) el.focus();

    if (el.tagName === 'SELECT') {
      if (!selectOption(el, value)) warn('no option matches', value, 'on', el);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    if (CONFIG.useFocusBlur) el.blur();
  }

  // ===========================================================================
  // Thiria element lookups (all shadow-DOM aware)
  // ===========================================================================
  function findButtonsByText(text) {
    return deepQueryAll('button, label').filter((b) => 
      b.textContent.includes(text) && !b.classList.contains('hidden') && !b.closest('.hidden')
    );
  }
  function findButtonByExactText(text) {
    return deepQueryAll('button').find((b) => b.textContent.trim() === text) || null;
  }
  // A condition <select> is one whose option VALUES intersect the canonical
  // condition keys. This distinguishes it from the action <select> (which has
  // 34 unrelated values) and the settings dropdowns, regardless of label text.
  // These selects only exist AFTER the solver is started.
  const conditionKeySet = new Set(CONFIG.conditionKeys.map((k) => k.toLowerCase()));
  function findConditionSelects() {
    return deepQueryAll('select').filter((s) =>
      s.options.length > 0 &&
      Array.from(s.options).some((o) => o.value && conditionKeySet.has(o.value.toLowerCase())));
  }
  // With multiple condition selects present (one per step row), the active one
  // is the next unfilled row — its placeholder ("Select the new condition.") is
  // still selected, i.e. value is empty. Fall back to the last select.
  function findActiveConditionSelect() {
    const selects = findConditionSelects();
    if (!selects.length) return null;
    const unfilled = selects.find((s) => !s.value);
    return unfilled || selects[selects.length - 1];
  }

  function setInputByLabel(labelText, value) {
    if (value === undefined || value === null || value === '') return;
    const target = labelText.toLowerCase();
    const label = deepQueryAll('label, .label').find((l) => {
      const t = l.textContent.trim().toLowerCase();
      return t === target ||
             (target.length > 5 && t.startsWith(target.substring(0, CONFIG.labelPrefixLen)));
    });
    if (!label) return;

    const container = label.closest('.labelrow, .simplerow');
    const input = container?.querySelector('input, select');
    if (!input || String(input.value) === String(value)) return;

    setReactiveValue(input, value);
    log('auto-updated', labelText, '->', value);
  }

  // ===========================================================================
  // Incoming pipeline
  // ===========================================================================
  function handleIncoming(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'pong') { lastPongAt = Date.now(); return; }

    applyStats(msg);

    if (typeof msg.condition !== 'string') return;
    const step = (typeof msg.step === 'number' && Number.isFinite(msg.step)) ? msg.step : null;

    detectCraftReset(step);

    if (step === 1 && lastProcessedStep === null) setInputByLabel('Rating', 'auto');

    if (ensureSolverStarted(raw, step)) return; // Start clicked; reprocess after UI loads

    const advanced = computeAdvanced(msg, step);

    applyCondition(msg, step);
    if (step !== null) lastProcessedStep = step;

    if (advanced) {
      stepStartProgress = lastProgress;
      stepStartQuality = lastQuality;
      scheduleStepAdvanceClick();
    }

    trackState(msg);
  }

  function applyStats(msg) {
    for (const [label, field] of Object.entries(CONFIG.statFields)) {
      if (msg[field] !== undefined) setInputByLabel(label, msg[field]);
    }
  }

  // A step number lower than the last one means a fresh craft started.
  function detectCraftReset(step) {
    if (step === null || lastProcessedStep === null) return;
    if (step < lastProcessedStep) {
      log('new craft detected — resetting per-craft state');
      solverStarted = false;
      lastProcessedStep = null;
      lastProgress = lastQuality = lastCp = 0;
    }
  }

  function ensureSolverStarted(raw, step) {
    if (solverStarted || step === null || step <= 0) return false;
    const startBtn = findButtonByExactText('Start');
    if (!startBtn) return false;

    suppressOutbound();
    startBtn.click();
    solverStarted = true;
    log('auto-clicked Start');
    setTimeout(() => handleIncoming(raw), CONFIG.solverStartRetryMs);
    return true;
  }

  function computeAdvanced(msg, step) {
    if (step === null) return false;
    if (lastProcessedStep === null) return step > 1;
    if (step > lastProcessedStep) return true;
    if (step === lastProcessedStep && typeof msg.cp === 'number' && msg.cp < lastCp) return true;
    return false;
  }

  function applyCondition(msg, step) {
    const select = findActiveConditionSelect();
    if (!select) {
      warn('no condition select found (shadow DOM? markup change?)');
      setTargetNote('solver not found');
      return;
    }
    setTargetNote('');
    const mapped = CONFIG.conditionMap[msg.condition] || msg.condition;
    setReactiveValue(select, mapped);
    log('applied condition', mapped, 'step', step);
  }

  function scheduleStepAdvanceClick() {
    setTimeout(() => {
      const failBtns = findButtonsByText('Failure');
      const successBtns = findButtonsByText('Success');

      let target = null;
      if (failBtns.length > 0 && typeof lastProgress === 'number') {
        const progressed = (lastProgress > stepStartProgress) || (lastQuality > stepStartQuality);
        target = progressed ? successBtns.at(-1) : failBtns.at(-1);
      } else if (successBtns.length > 0) {
        target = successBtns.at(-1);
      }

      if (target) {
        suppressOutbound();
        target.click();
        log('auto-clicked', target.textContent.trim());
      }
    }, CONFIG.stepActionDelayMs);
  }

  function trackState(msg) {
    if (typeof msg.currentProgress === 'number') {
      lastProgress = msg.currentProgress;
      lastQuality = msg.currentQuality;
    }
    if (typeof msg.cp === 'number') lastCp = msg.cp;
  }

  // ===========================================================================
  // Outgoing: scrape the active "Use X" instruction and send it back
  // ===========================================================================
  let observer = null;
  let sendTimer = null;

  function scrapeActiveAction() {
    const anchor = findActiveConditionSelect() || findButtonsByText('Success').at(-1) || null;

    if (anchor) {
      let container = anchor.parentElement;
      for (let i = 0; i < CONFIG.labelSearchMaxDepth && container; i++) {
        if (container.innerText && container.innerText.includes('Use ')) break;
        container = container.parentElement;
      }
      const match = container?.innerText.match(/Use\s+([^.]+)\./);
      if (match) return match[1].trim();
    }

    // Fallback: standard macro list, indexed by current step.
    const list = deepQuery(CONFIG.listContainerSelectors);
    if (list) {
      const items = Array.from(list.children);
      const idx = (lastProcessedStep !== null && lastProcessedStep > 0) ? lastProcessedStep - 1 : 0;
      const match = items[idx]?.innerText.match(/Use\s+([^.\n]+)/);
      if (match) return match[1].trim();
    }
    return null;
  }

  function attachObserver() {
    const evaluate = () => {
      const now = Date.now();
      if (now < suppressUntil) {
        clearTimeout(suppressTimer);
        suppressTimer = setTimeout(evaluate, suppressUntil - now + 10);
        return;
      }
      const text = scrapeActiveAction();
      if (text && text !== lastSentAction) sendAction(text);
    };

    observer = new MutationObserver(() => {
      clearTimeout(sendTimer);
      sendTimer = setTimeout(evaluate, CONFIG.sendDebounceMs);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    evaluate();
  }

  // ===========================================================================
  // Status indicator (connection state + a "target health" note)
  // ===========================================================================
  let statusEl = null;
  let currentStatus = { state: 'reconnecting', text: 'Connecting…' };
  let targetNote = '';
  const STATUS_DOT = { connected: '#2ecc71', reconnecting: '#f39c12', disconnected: '#e74c3c' };

  function ensureIndicator() {
    if (statusEl || !document.body) return;
    statusEl = document.createElement('div');
    statusEl.id = '__bridge_status__';
    Object.assign(statusEl.style, {
      position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
      font: '12px/1.4 system-ui, -apple-system, sans-serif', padding: '6px 10px',
      borderRadius: '6px', background: 'rgba(20,20,20,0.85)', color: '#fff',
      display: 'flex', alignItems: 'center', gap: '8px',
      pointerEvents: 'none', userSelect: 'none', boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
    });
    const dot = document.createElement('span');
    dot.className = 'dot';
    Object.assign(dot.style, { width: '9px', height: '9px', borderRadius: '50%', display: 'inline-block', flex: '0 0 auto' });
    const label = document.createElement('span');
    label.className = 'label';
    statusEl.append(dot, label);
    document.body.appendChild(statusEl);
    renderStatus();
  }
  function renderStatus() {
    if (!statusEl) return;
    statusEl.querySelector('.dot').style.background = STATUS_DOT[currentStatus.state] || STATUS_DOT.disconnected;
    statusEl.querySelector('.label').textContent = currentStatus.text + (targetNote ? ` · ${targetNote}` : '');
  }
  function setStatus(state, text) { currentStatus = { state, text: text || state }; renderStatus(); }
  function setTargetNote(note) { if (note !== targetNote) { targetNote = note || ''; renderStatus(); } }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================
  window.addEventListener('beforeunload', () => {
    manualClose = true;
    clearTimeout(reconnectTimer);
    stopHeartbeat();
    if (socket) { try { socket.close(); } catch (_) {} }
    if (observer) observer.disconnect();
  });

  connect();
  const onReady = () => { ensureIndicator(); attachObserver(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();
