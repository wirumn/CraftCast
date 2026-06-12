// ==UserScript==
// @name         Dashboard <-> Local Bridge
// @namespace    https://github.com/wirumn/CraftCast
// @version      2.1.0
// @description  Two-way sync between a local WebSocket app (127.0.0.1:8014) and the Thiria crafting solver.
// @author       you
// @match        https://thiria.com/expert/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ===========================================================================
  // Config
  // ===========================================================================
  const CONFIG = {
    wsUrl: 'ws://127.0.0.1:8014',

    listContainerSelectors: '#instruction-list, .instruction-list',

    // Canonical condition option VALUES Thiria uses.
    conditionKeys: [
      'normal', 'good', 'excellent', 'poor', 'centered', 'sturdy',
      'pliant', 'malleable', 'primed', 'goodOmen', 'robust',
    ],

    // Map plugin condition keys -> Thiria option values where they differ.
    conditionMap: { goodomen: 'goodOmen' },

    // Stat label text -> incoming payload field.
    statFields: {
      craftsmanship: 'craftsmanship',
      control:       'control',
      progress:      'difficulty',
      durability:    'durability',
      quality:       'maxQuality',
    },

    sendDebounceMs:      120,
    suppressOutboundMs:  400,
    solverStartRetryMs:  500,

    // Polling config for waiting on Thiria to process condition + enable button
    stepPollIntervalMs:  80,
    stepPollMaxAttempts: 40,   // 80ms * 40 = 3.2s max wait

    labelSearchMaxDepth: 5,
    labelPrefixLen:      6,

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
  let lastCondition = '';
  let stepStartProgress = 0;
  let stepStartQuality = 0;
  let solverStarted = false;

  let suppressUntil = 0;
  let suppressTimer = null;

  // Guard against overlapping step-advance polls
  let stepAdvanceInProgress = false;

  const suppressOutbound = () => { suppressUntil = Date.now() + CONFIG.suppressOutboundMs; };

  // ===========================================================================
  // Shadow-DOM-aware queries
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
  // DOM writes — framework-safe value setting
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
    el.focus();

    if (el.tagName === 'SELECT') {
      if (!selectOption(el, value)) warn('no option matches', value, 'on', el);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.blur();
  }

  // ===========================================================================
  // Thiria element lookups (shadow-DOM aware)
  // ===========================================================================

  // A condition <select> is one whose option VALUES intersect the canonical
  // condition keys — distinguishes it from the action <select> and settings.
  const conditionKeySet = new Set(CONFIG.conditionKeys.map((k) => k.toLowerCase()));

  function isConditionSelect(s) {
    return s.options.length > 0 &&
      Array.from(s.options).some((o) => o.value && conditionKeySet.has(o.value.toLowerCase()));
  }

  function findConditionSelects() {
    return deepQueryAll('select').filter(isConditionSelect);
  }

  /**
   * Find the active (current) condition select.
   *
   * Thiria renders steps in column-reverse, so the LAST condition select in DOM
   * order is the newest step. The active step is the one that hasn't been
   * completed yet — its select either:
   *   (a) has no value (placeholder still selected), OR
   *   (b) has a value but its step row's Success button hasn't been clicked yet
   *
   * We try (a) first, fall back to (b) by taking the last select.
   */
  function findActiveConditionSelect() {
    const selects = findConditionSelects();
    if (!selects.length) return null;

    // Prefer the select with empty value (unfilled step)
    const empty = selects.find((s) => !s.value);
    if (empty) return empty;

    // Fallback: the last select is the newest/active step
    return selects[selects.length - 1];
  }

  /**
   * Find the step container (cm-group) that contains the given element.
   * This scopes button searches to the correct step row.
   */
  function findStepContainer(el) {
    let node = el;
    for (let i = 0; i < 10 && node; i++) {
      if (node.tagName === 'CM-GROUP' || (node.classList && node.classList.contains('stepframe'))) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Find Success/Failure buttons scoped to a specific step container.
   * Falls back to page-wide search if container is null.
   */
  function findStepButtons(container) {
    const scope = container || document;
    const allButtons = container
      ? Array.from(container.querySelectorAll('button, label'))
      : deepQueryAll('button, label');

    const successBtns = allButtons.filter((b) =>
      b.textContent.includes('Success') && !b.classList.contains('hidden') && !b.closest('.hidden')
    );
    const failBtns = allButtons.filter((b) =>
      b.textContent.includes('Failure') && !b.classList.contains('hidden') && !b.closest('.hidden')
    );

    return { successBtns, failBtns };
  }

  function findButtonByExactText(text) {
    return deepQueryAll('button').find((b) => b.textContent.trim() === text) || null;
  }

  function setInputByLabel(labelText, value) {
    if (value === undefined || value === null || value === '') return;
    const target = labelText.toLowerCase();
    const labels = deepQueryAll('label, .label').filter((l) => {
      const t = l.textContent.trim().toLowerCase();
      return t === target ||
             (target.length > 5 && t.startsWith(target.substring(0, CONFIG.labelPrefixLen)));
    });

    for (const label of labels) {
      let input = null;

      if (label.htmlFor) input = document.getElementById(label.htmlFor) || deepQueryAll(`#${label.htmlFor}`)[0];
      if (!input) input = label.querySelector('input, select');
      if (!input) {
        const container = label.closest('.labelrow, .simplerow, .field, .field-row');
        if (container) input = container.querySelector('input, select');
      }
      if (!input && label.nextElementSibling && ['INPUT', 'SELECT'].includes(label.nextElementSibling.tagName)) {
        input = label.nextElementSibling;
      }
      if (!input && label.parentElement) {
        input = label.parentElement.querySelector('input, select');
      }

      if (input) {
        if (String(input.value) === String(value)) return;
        setReactiveValue(input, value);
        log('auto-updated', labelText, '->', value);
        return;
      }
    }
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

    log(`── incoming step=${step} cond=${msg.condition} prog=${msg.currentProgress} qual=${msg.currentQuality} cp=${msg.cp}`);

    detectCraftReset(step);

    if (step === 1 && lastProcessedStep === null) setInputByLabel('Rating', 'auto');

    if (ensureSolverStarted(raw, step)) return;

    const advanced = computeAdvanced(msg, step);
    log(`   advanced=${advanced} lastProcessedStep=${lastProcessedStep}`);

    // Track progress BEFORE we update lastProcessedStep, so we can compare
    // the previous step's end state with this step's start state
    if (advanced) {
      stepStartProgress = lastProgress;
      stepStartQuality = lastQuality;
    }

    // Update tracking state
    trackState(msg);
    if (step !== null) lastProcessedStep = step;

    // Apply condition to the active step's dropdown, then click Success/Failure
    if (advanced) {
      applyConditionAndAdvance(msg, step);
    } else {
      // Not a step advance — just update condition on current select
      applyCondition(msg, step);
    }
  }

  function applyStats(msg) {
    for (const [label, field] of Object.entries(CONFIG.statFields)) {
      if (msg[field] !== undefined) setInputByLabel(label, msg[field]);
    }
  }

  function detectCraftReset(step) {
    if (step === null || lastProcessedStep === null) return;
    if (step < lastProcessedStep) {
      log('new craft detected — resetting per-craft state');
      solverStarted = false;
      lastProcessedStep = null;
      lastProgress = lastQuality = lastCp = 0;
      lastCondition = '';
      stepAdvanceInProgress = false;

      const resetBtn = findButtonByExactText('Reset') || findButtonByExactText('Start');
      if (resetBtn) {
        suppressOutbound();
        resetBtn.click();
        log('auto-clicked Reset for new craft');
      }
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

    // Check for "free" actions that don't increment step (e.g., Final Appraisal, Heart & Soul)
    if (step === lastProcessedStep) {
      if (typeof msg.cp === 'number' && msg.cp < lastCp) return true; // e.g. Final Appraisal
      if (typeof msg.condition === 'string' && msg.condition !== lastCondition && msg.condition !== 'normal') return true; // e.g. Heart & Soul
    }

    return false;
  }

  function trackState(msg) {
    if (typeof msg.currentProgress === 'number') {
      lastProgress = msg.currentProgress;
      lastQuality = msg.currentQuality;
    }
    if (typeof msg.cp === 'number') lastCp = msg.cp;
    if (typeof msg.condition === 'string') lastCondition = msg.condition;
  }

  // ===========================================================================
  // Core step advance logic — set condition, then poll until we can click
  // ===========================================================================

  /**
   * Apply condition to the active select, then poll until Thiria's framework
   * processes it and enables the Success/Failure button, then click it.
   */
  function applyConditionAndAdvance(msg, step) {
    if (stepAdvanceInProgress) {
      log('   step advance already in progress, skipping');
      return;
    }
    stepAdvanceInProgress = true;

    const mapped = CONFIG.conditionMap[msg.condition] || msg.condition;

    let attempts = 0;
    const poll = () => {
      attempts++;

      // Evaluate if the action succeeded based on progress/quality delta.
      // We do this inside the poll loop to allow FFXIV UI animation to catch up to the step increment.
      const progressed = (lastProgress > stepStartProgress) || (lastQuality > stepStartQuality);

      // Find the active condition select
      const select = findActiveConditionSelect();
      if (!select) {
        if (attempts < CONFIG.stepPollMaxAttempts) {
          setTimeout(poll, CONFIG.stepPollIntervalMs);
          return;
        }
        warn(`   gave up waiting for condition select after ${attempts} attempts`);
        stepAdvanceInProgress = false;
        setTargetNote('no condition select found');
        return;
      }
      setTargetNote('');

      // Set the condition value if not already set
      const currentVal = select.value;
      if (!currentVal || currentVal !== mapped) {
        log(`   setting condition: "${currentVal}" -> "${mapped}" (attempt ${attempts})`);
        setReactiveValue(select, mapped);
      }

      // Find the step container that owns this select
      const container = findStepContainer(select);
      const { successBtns, failBtns } = findStepButtons(container);

      // Determine which button to click
      let targetBtn = null;
      if (failBtns.length > 0) {
        // This step has Success + Failure (e.g., Rapid Synthesis)
        if (progressed) {
          targetBtn = successBtns[successBtns.length - 1];
        } else {
          // It looks like a failure, but FFXIV step increments before UI bars update.
          // Wait at least ~800ms (10 attempts) for Quality/Progress to update from the game.
          if (attempts < 10 && attempts < CONFIG.stepPollMaxAttempts) {
            setTimeout(poll, CONFIG.stepPollIntervalMs);
            return;
          }
          targetBtn = failBtns[failBtns.length - 1];
        }
      } else if (successBtns.length > 0) {
        // This step has only Success (e.g., Final Appraisal, Byregot's Blessing)
        targetBtn = successBtns[successBtns.length - 1];
      }

      if (!targetBtn) {
        if (attempts < CONFIG.stepPollMaxAttempts) {
          setTimeout(poll, CONFIG.stepPollIntervalMs);
          return;
        }
        warn(`   gave up waiting for Success/Failure button after ${attempts} attempts`);
        stepAdvanceInProgress = false;
        return;
      }

      // Check if the button is enabled
      if (targetBtn.disabled) {
        if (attempts < CONFIG.stepPollMaxAttempts) {
          setTimeout(poll, CONFIG.stepPollIntervalMs);
          return;
        }
        warn(`   gave up: button still disabled after ${attempts} attempts`);
        stepAdvanceInProgress = false;
        return;
      }

      // Click it!
      suppressOutbound();
      targetBtn.click();
      log(`   auto-clicked "${targetBtn.textContent.trim()}" for step ${step} (attempt ${attempts})`);
      stepAdvanceInProgress = false;
    };

    // Start polling immediately
    poll();
  }

  /**
   * Apply condition without clicking Success/Failure (for non-advance updates).
   */
  function applyCondition(msg, step) {
    const select = findActiveConditionSelect();
    if (!select) {
      log('   no condition select for non-advance update (normal if solver not started)');
      return;
    }
    const mapped = CONFIG.conditionMap[msg.condition] || msg.condition;
    if (select.value !== mapped) {
      setReactiveValue(select, mapped);
      log('   applied condition', mapped, 'step', step);
    }
  }

  // ===========================================================================
  // Outgoing: scrape the active "Use X" instruction and send it back
  // ===========================================================================
  let observer = null;
  let sendTimer = null;

  function scrapeActiveAction() {
    const anchor = findActiveConditionSelect() ||
      deepQueryAll('button, label').filter(b => b.textContent.includes('Success')).at(-1) ||
      null;

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
  // Status indicator
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
