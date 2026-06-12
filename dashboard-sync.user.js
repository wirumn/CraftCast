// ==UserScript==
// @name         Dashboard <-> Local Bridge
// @namespace    https://github.com/wirumn/CraftCast
// @version      3.0.1
// @description  Two-way sync between a local WebSocket app (127.0.0.1:8014) and the Thiria crafting solver.
// @author       you
// @match        https://thiria.com/expert/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Architecture (v3): the plugin is the single source of truth. Every message
 * carries the FULL action history of the current craft — which action the
 * player actually used, the condition rolled afterwards, and success/failure.
 * This script is a stateless-ish RECONCILER: on every message (and on relevant
 * DOM changes) it converges Thiria's step list to that history:
 *
 *   - new session id        -> reset the solver, apply player/recipe config
 *   - history entry i       -> Thiria step row i: fix the action (edit pencil)
 *                              if the player deviated from the suggestion, set
 *                              the rolled condition, click Success/Failure
 *   - newest unfinished row -> scrape "Use X." and send it back as next_action
 *
 * Because reconciliation is idempotent and driven by the full document, a
 * dropped frame, a slow solver, or a reconnect can no longer skip steps or
 * confirm actions the player never performed.
 */

(function () {
  'use strict';

  // ===========================================================================
  // Config
  // ===========================================================================
  const CONFIG = {
    wsUrl: 'ws://127.0.0.1:8014',

    pollIntervalMs: 80,
    pollTimeoutMs: 4000,
    // Expert solves can take a while; give new rows more headroom.
    solverRowTimeoutMs: 12000,
    reconcileDebounceMs: 120,
    repairAttemptsPerRow: 2,

    reconnect: { baseDelayMs: 1000, maxDelayMs: 30000, factor: 2, jitterRatio: 0.25 },
    heartbeat: { intervalMs: 15000, timeoutMs: 30000 },
  };

  // Actions that require a player toggle in Thiria before they appear in the
  // action list at all.
  const MANIPULATION_ACTION = 'manipulation';
  const SPECIALIST_ACTIONS = new Set(['heart and soul', 'careful observation', 'quick innovation']);

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

  let doc = null;                 // latest state document from the plugin
  let appliedSession = -1;        // session whose config/reset has been applied
  const repairAttempts = new Map(); // row index -> repair count for this session

  let reconciling = false;
  let rerunRequested = false;
  let reconcileTimer = null;

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
      // The last send may have died in the closing socket's buffer; forget it
      // so the suggestion is re-sent after reconnecting.
      lastSentAction = null;
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

  function handleIncoming(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'pong') { lastPongAt = Date.now(); return; }
    if (msg.type !== 'state') return;

    doc = msg;
    log(`── state: session=${msg.session} status=${msg.status} step=${msg.current?.step} ` +
        `cond=${msg.current?.condition} history=${(msg.steps || []).length}`);
    scheduleReconcile();
  }

  // ===========================================================================
  // Generic DOM helpers
  // ===========================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = CONFIG.pollTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let value = null;
      try { value = fn(); } catch (_) { /* DOM in flux */ }
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(CONFIG.pollIntervalMs);
    }
  }

  const isShown = (el) => !!el && !el.closest('.hidden');

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
    el.focus();
    if (el.tagName === 'SELECT') {
      if (!selectOption(el, value)) { warn('no option matches', value, 'on', el); return false; }
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input',  { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    el.blur();
    return true;
  }

  /**
   * Select an action by its display name ("Muscle Memory"). Thiria option
   * values are camelCase keys, option text is the display name — match both.
   */
  function setSelectByActionName(select, name) {
    const wanted = name.trim().toLowerCase();
    const wantedKey = wanted.replace(/[^a-z0-9]/g, '');
    const opt = Array.from(select.options).find((o) =>
      o.textContent.trim().toLowerCase() === wanted ||
      o.value.toLowerCase() === wantedKey);
    if (!opt) return false;
    return setReactiveValue(select, opt.value);
  }

  const sameName = (a, b) =>
    (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

  // ===========================================================================
  // Thiria accessors
  // ===========================================================================

  // The Start/Reset button: label is "Start" before the solver runs, "Reset" after.
  function startResetButton() {
    return deepQueryAll('button').find((b) => {
      const t = b.textContent.trim();
      return t === 'Start' || t === 'Reset';
    }) || null;
  }

  // Thiria's x-items stamps each step inside an <x-item-host> wrapper, so the
  // container's children are hosts, not the cm-group rows themselves.
  function stepRows() {
    const container = deepQuery('.stepsContainer');
    if (!container) return [];
    return Array.from(container.children)
      .map((el) => (el.tagName === 'CM-GROUP' ? el : el.querySelector('cm-group')))
      .filter(Boolean);
  }

  function rowIndex(row) {
    const header = row.querySelector('[slot="header"]');
    const m = header && header.textContent.match(/#\s*(\d+)/);
    return m ? parseInt(m[1], 10) : -1;
  }

  function rowByIndex(n) {
    const rows = stepRows();
    return rows.find((r) => rowIndex(r) === n) || rows[n - 1] || null;
  }

  // "Use <span>NAME</span>." — the inner span carries the action name.
  function rowActionName(row) {
    const span = row.querySelector('.steptext .bold span');
    return span ? span.textContent.trim() : '';
  }

  function actionSelect(row) {
    return row.querySelector('select[xu-action-options]') ||
      Array.from(row.querySelectorAll('select'))
        .find((s) => !s.querySelector('option[value="normal"]')) || null;
  }

  function conditionSelect(row) {
    return Array.from(row.querySelectorAll('select'))
      .find((s) => s.querySelector('option[value="normal"]')) || null;
  }

  function resultButton(row, text) {
    return Array.from(row.querySelectorAll('button.result'))
      .find((b) => b.textContent.includes(text)) || null;
  }

  // 'success' | 'failure' | null — Thiria marks the clicked button with a class.
  function rowResult(row) {
    if (resultButton(row, 'Success')?.classList.contains('success')) return 'success';
    if (resultButton(row, 'Failure')?.classList.contains('failure')) return 'failure';
    return null;
  }
  const rowFinished = (row) => rowResult(row) !== null;

  // ===========================================================================
  // Solver configuration (player stats + recipe)
  // ===========================================================================
  function setNamedInput(el, value) {
    if (!el || value === undefined || value === null || value === '' || value === 0) return;
    if (String(el.value) === String(value)) return;
    setReactiveValue(el, value);
    log('config', el.name || el.id, '->', value);
  }

  /**
   * Returns true only when the form existed and the document carried real
   * values — early broadcasts of a session can have zeroed stats while the
   * plugin's addon reads settle, and the page itself may not be built yet.
   * The caller retries until this succeeds.
   */
  function applyConfig(d) {
    const p = d.player || {};
    const r = d.recipe || {};

    // Both the player and item panels label their level input "level";
    // they appear in template order: player first, item second.
    const levels = deepQueryAll('input[name="level"]');
    setNamedInput(levels[0], p.level);
    setNamedInput(deepQuery('input[name="cp"]'), p.cp);
    setNamedInput(deepQuery('input[name="craftsmanship"]'), p.craftsmanship);
    setNamedInput(deepQuery('input[name="control"]'), p.control);

    setNamedInput(levels[1], r.level);
    setNamedInput(deepQuery('input[name="durability"]'), r.durability);
    setNamedInput(deepQuery('input[name="progress"]'), r.progress);
    setNamedInput(deepQuery('input[name="quality"]'), r.quality);

    const rating = deepQuery('select[name="itemRating"]');
    if (rating && r.rating && rating.value !== r.rating) setReactiveValue(rating, r.rating);

    return !!(deepQuery('input[name="craftsmanship"]') && p.craftsmanship > 0 && r.progress > 0);
  }

  /**
   * If the player used Manipulation or a specialist action, the matching
   * Thiria toggle must be "Allowed" or the action won't exist in the action
   * list. The toggles are <select>s with true/false options inside a named
   * wrapper div. Run BEFORE driving rows: changing one recalculates and
   * replaces the active row.
   */
  function applyUnlockToggles(d) {
    const used = (d.steps || []).map((s) => (s.action || '').toLowerCase());
    const ensure = (name) => {
      const wrap = deepQuery(`[name="${name}"]`);
      const sel = wrap && (wrap.tagName === 'SELECT' ? wrap : wrap.querySelector('select'));
      if (sel && sel.value !== 'true') {
        setReactiveValue(sel, 'true');
        log('enabled toggle', name);
      }
    };
    if (used.includes(MANIPULATION_ACTION)) ensure('playerManipulation');
    if (used.some((a) => SPECIALIST_ACTIONS.has(a))) ensure('playerSpecialist');
  }

  // ===========================================================================
  // Reconciler
  // ===========================================================================
  function scheduleReconcile() {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(reconcile, CONFIG.reconcileDebounceMs);
  }

  async function reconcile() {
    if (reconciling) { rerunRequested = true; return; }
    reconciling = true;
    try {
      await reconcileOnce();
    } catch (e) {
      warn('reconcile failed', e);
    } finally {
      reconciling = false;
      if (rerunRequested) { rerunRequested = false; scheduleReconcile(); }
    }
  }

  async function reconcileOnce() {
    const d = doc;
    if (!d) return;

    if (!d.fromStart) {
      // Plugin attached mid-craft: history is incomplete, driving the solver
      // would fabricate steps. Stay hands-off, still surface the suggestion.
      setTargetNote('attached mid-craft — auto-sync off');
      publishSuggestion();
      return;
    }

    // New craft: reset the solver and push fresh config.
    if (d.session !== appliedSession) {
      const btn = startResetButton();
      if (btn && btn.textContent.trim() === 'Reset' && !btn.disabled) {
        btn.click();
        log('reset solver for session', d.session);
        await sleep(CONFIG.pollIntervalMs);
      }
      if (!applyConfig(d)) {
        // Form or data not ready — don't latch, don't start: a later
        // broadcast/mutation re-runs this with complete values.
        setTargetNote('waiting for craft data');
        return;
      }
      appliedSession = d.session;
      repairAttempts.clear();
      lastSentAction = null;
    }
    applyUnlockToggles(d);

    // Make sure the solver is running.
    if (stepRows().length === 0) {
      const startBtn = await waitFor(() => {
        const b = startResetButton();
        return b && b.textContent.trim() === 'Start' && !b.disabled ? b : null;
      });
      if (!startBtn) { setTargetNote('solver not ready'); return; }
      startBtn.click();
      log('auto-clicked Start');
      if (!await waitFor(() => stepRows().length > 0, CONFIG.solverRowTimeoutMs)) {
        setTargetNote('waiting for solver');
        return;
      }
    }

    // Converge Thiria's rows onto the resolved prefix of the history. Re-read
    // `doc` each iteration so newly resolved entries are picked up mid-pass.
    for (let i = 0; ; i++) {
      if (!doc || doc.session !== d.session) return; // superseded by a new craft
      const steps = doc.steps || [];
      if (i >= steps.length) break;

      const entry = steps[i];
      if (entry.success == null || !entry.condition) break; // outcome not observed yet

      const row = await waitFor(() => rowByIndex(i + 1), CONFIG.solverRowTimeoutMs);
      if (!row) { setTargetNote(`waiting for solver (step ${i + 1})`); return; }

      if (rowFinished(row)) {
        if (!rowMatches(row, entry)) await repairRow(row, entry, i + 1);
        continue;
      }

      setTargetNote(`syncing step ${i + 1}`);
      if (!await driveRow(row, entry)) { setTargetNote(`step ${i + 1} stuck — see console`); return; }
    }

    setTargetNote(doc.status === 'complete' ? 'craft complete' : '');
    publishSuggestion();
  }

  /**
   * Complete one Thiria step row from a resolved history entry:
   * correct the action if the player deviated, set the rolled condition,
   * then click Success/Failure.
   */
  async function driveRow(row, entry) {
    // 1. Action: if the player used something other than the suggestion,
    //    enter edit mode (pencil) and pick the real action.
    if (entry.action && !sameName(rowActionName(row), entry.action)) {
      if (!isShown(actionSelect(row))) row.querySelector('.edit')?.click();
      const sel = await waitFor(() => {
        const s = actionSelect(row);
        return s && isShown(s) && !s.disabled ? s : null;
      });
      if (sel) {
        if (!setSelectByActionName(sel, entry.action)) {
          warn(`Thiria has no action named "${entry.action}" — leaving "${rowActionName(row)}"`);
        }
      } else {
        warn('action select never became editable for', entry.action);
      }
    }

    // 2. Condition rolled after the action (hidden for buff-only actions).
    const condSel = conditionSelect(row);
    if (entry.condition && condSel && isShown(condSel) && condSel.value !== entry.condition) {
      const enabled = await waitFor(() => (!condSel.disabled ? condSel : null));
      if (enabled) setReactiveValue(condSel, entry.condition);
      else warn('condition select stayed disabled');
    }

    // 3. Result.
    const wantText = entry.success === false ? 'Failure' : 'Success';
    let btn = await waitFor(() => {
      const b = resultButton(row, wantText);
      return b && isShown(b) && !b.disabled ? b : null;
    });
    if (!btn && wantText === 'Failure') {
      // Shouldn't happen (only fallible actions report failure), but never wedge.
      warn('Failure button unavailable; falling back to Success');
      btn = await waitFor(() => {
        const b = resultButton(row, 'Success');
        return b && !b.disabled ? b : null;
      });
    }
    if (!btn) { warn('result button never enabled'); return false; }

    btn.click();
    log(`clicked ${wantText} on step row #${rowIndex(row)} (${entry.action || 'suggested action'})`);
    // Only report success if the click actually registered; otherwise the
    // caller bails and a later reconcile retries this row.
    return !!(await waitFor(() => rowFinished(row)));
  }

  function rowMatches(row, entry) {
    if (entry.action && !sameName(rowActionName(row), entry.action)) return false;
    const condSel = conditionSelect(row);
    if (entry.condition && condSel && isShown(condSel) && condSel.value !== entry.condition) return false;
    const wantResult = entry.success === false ? 'failure' : 'success';
    return rowResult(row) === wantResult;
  }

  /**
   * A finished row disagrees with what actually happened in game (e.g. it was
   * clicked manually during a disconnect). Re-open it via the pencil and
   * re-drive it; every later row resimulates automatically.
   */
  async function repairRow(row, entry, index) {
    const attempts = repairAttempts.get(index) || 0;
    if (attempts >= CONFIG.repairAttemptsPerRow) {
      setTargetNote(`step ${index} out of sync`);
      return;
    }
    repairAttempts.set(index, attempts + 1);
    warn(`repairing desynced step row #${index}`, {
      have: { action: rowActionName(row), result: rowResult(row) },
      want: entry,
    });
    row.querySelector('.edit')?.click(); // clears the result, enables the selects
    await sleep(CONFIG.pollIntervalMs);
    await driveRow(row, entry);
  }

  // ===========================================================================
  // Outgoing: the newest unfinished row holds the solver's next suggestion
  // ===========================================================================
  function publishSuggestion() {
    const open = stepRows().filter((r) => !rowFinished(r));
    if (!open.length) return;
    const name = rowActionName(open[open.length - 1]);
    if (name && name !== lastSentAction) sendAction(name);
  }

  // ===========================================================================
  // DOM observer — re-reconcile when the solver finishes computing rows
  // ===========================================================================
  let observer = null;
  function attachObserver() {
    observer = new MutationObserver(() => scheduleReconcile());
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleReconcile();
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
  function setTargetNote(note) {
    if (note === targetNote) return;
    targetNote = note || '';
    if (targetNote) log('status:', targetNote); // surface silent waits in the console
    renderStatus();
  }

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
