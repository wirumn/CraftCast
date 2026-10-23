// ==UserScript==
// @name         Dashboard <-> Local Bridge
// @namespace    https://github.com/wirumn/CraftCast
// @version      3.3.2
// @description  Reconcile CraftCast history with the Thiria crafting solver.
// @author       you
// @match        https://thiria.com/expert/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const CONFIG = {
    wsUrl: 'ws://127.0.0.1:8014',
    pollMs: 80,
    waitMs: 4000,
    solveMs: 12000,
    debounceMs: 100,
    retryMs: 1000,
    maxFailures: 4,
    pingMs: 15000,
    pongMs: 30000,
    // null preserves the page setting. Use only values known for your character/recipe.
    relic: null,      // 'none' | 'splendorous' (Cosmic 9+)
    actionMode: null, // 'default' | 'all' | 'none' (Stellar actions)
  };

  const SPECIALIST = new Set(['heartandsoul', 'carefulobservation', 'quickinnovation']);

  // Actions Thiria/the game treat as the same slot. A name mismatch between
  // them must not trigger an endless edit/re-drive loop. Daring Touch is the
  // in-game upgrade of Hasty Touch (fires when Expedience is active).
  const ACTION_ALIASES = [['hastytouch', 'daringtouch']];

  // Actions Thiria's solver does not simulate at all. They consume no step row
  // in Thiria, so the reconciler skips them entirely to keep subsequent steps
  // aligned 1:1. (Material Miracle is a cosmic Duty Action condition buff).
  const KNOWN_UNSUPPORTED = new Set(['materialmiracle']);

  const key = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
    .replace(/^wastenotii$/, 'wastenot2');

  function actionsCompatible(a, b) {
    const ka = key(a), kb = key(b);
    if (ka === kb) return true;
    return ACTION_ALIASES.some((g) => g.includes(ka) && g.includes(kb));
  }

  const warn = (...args) => console.warn('[bridge]', ...args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cancelled = Symbol('cancelled');

  let socket = null;
  let reconnectTimer, heartbeatTimer, reconcileTimer;
  let reconnectAttempts = 0, lastPongAt = 0;
  let stopped = false, paused = false, running = false, rerun = false;
  let doc = null, stateKey = '', appliedSession = null, lastSent = '';
  let failures = 0;
  let statusEl, statusLabel, statusToggle, statusDot;
  let connectionNote = 'Connecting…', targetNote = '';
  let rowsDirty = true, cachedRows = [];
  const indexedRows = new Map();
  const inferredSettings = new Map();
  const unsupportedActions = new Set();

  // Observe discovered open roots, including roots on newly inserted hosts.
  // Thiria currently places its controls in light DOM under slotted components.
  const roots = new Set();
  const observer = new MutationObserver((records) => {
    let relevant = false;
    for (const record of records) {
      if (statusEl?.contains(record.target)) continue;
      relevant = true;
      for (const node of record.addedNodes) discoverRoots(node);
    }
    if (relevant) {
      rowsDirty = true;
      pruneRoots();
      schedule();
    }
  });

  const observe = (root) => observer.observe(root, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['class', 'disabled', 'hidden', 'value'],
  });

  let shadowHook = null, previousAttachShadow = null;
  function hookShadowRoots() {
    const original = Element.prototype.attachShadow;
    previousAttachShadow = original;
    shadowHook = function (...args) {
      const root = Reflect.apply(original, this, args);
      if (!stopped && root.mode === 'open') {
        roots.add(root);
        observe(root);
        rowsDirty = true;
        schedule();
      }
      return root;
    };
    Element.prototype.attachShadow = shadowHook;
  }

  function discoverRoots(node) {
    if (node.shadowRoot && !roots.has(node.shadowRoot)) {
      roots.add(node.shadowRoot);
      observe(node.shadowRoot);
      discoverRoots(node.shadowRoot);
    }
    for (const el of node.querySelectorAll?.('*') || []) {
      if (el.shadowRoot) discoverRoots(el);
    }
  }

  function pruneRoots() {
    let removed = false;
    for (const root of roots) {
      if (root !== document && !root.host.isConnected) {
        roots.delete(root);
        removed = true;
      }
    }
    if (removed) {
      observer.disconnect();
      for (const root of roots) observe(root);
    }
  }

  function query(selector, root) {
    if (root) {
      const found = root.querySelector(selector);
      if (found) return found;
      if (root.shadowRoot) {
        const nested = query(selector, root.shadowRoot);
        if (nested) return nested;
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const nested = query(selector, el.shadowRoot);
          if (nested) return nested;
        }
      }
      return null;
    }
    for (const scope of roots) {
      const found = scope.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  function shown(el) {
    if (!el?.isConnected) return false;
    for (let node = el; node; node = node.parentElement || node.getRootNode().host) {
      if (node.hidden || node.classList?.contains('hidden')) return false;
    }
    return true;
  }

  const usable = (el) => shown(el) && !el.disabled;
  const bound = (binding) => query(`[x-bind-value="${binding}"]`);

  // Preserve the compatibility sequence recorded in CraftCast commit 817a871.
  // Ordinary assignment lets element-level setters participate; never bypass
  // them with a native prototype setter. Restore the user's previous focus.
  function setValue(el, value) {
    if (!el || value == null || String(el.value) === String(value)) return !!el;
    const option = el.tagName === 'SELECT' && Array.from(el.options)
      .find((option) => option.value === String(value) && !option.disabled);
    if (el.tagName === 'SELECT' && !option) return false;
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    try {
      el.focus({ preventScroll: true });
      if (option) el.selectedIndex = option.index;
      el.value = String(value);
      rowsDirty = true;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    } finally {
      el.blur();
      if (active?.isConnected && active !== document.body) active.focus?.({ preventScroll: true });
    }
    return String(el.value) === String(value);
  }

  function check(d) {
    if (stopped || paused || doc !== d || socket?.readyState !== WebSocket.OPEN) throw cancelled;
  }

  async function waitFor(read, d, message, timeout = CONFIG.waitMs) {
    const deadline = Date.now() + timeout;
    for (;;) {
      check(d);
      const value = read();
      if (value) return value;
      if (Date.now() >= deadline) throw new Error(message);
      await sleep(CONFIG.pollMs);
    }
  }

  function validState(value) {
    if (!value || value.type !== 'state' || !Number.isSafeInteger(value.session) || value.session < 0 ||
        !['active', 'complete'].includes(value.status) || typeof value.fromStart !== 'boolean' ||
        !Array.isArray(value.steps) || !value.player || !value.recipe) return false;
    return value.steps.every((entry) => entry &&
      (entry.action == null || typeof entry.action === 'string') &&
      (entry.condition == null || typeof entry.condition === 'string') &&
      (entry.success == null || typeof entry.success === 'boolean'));
  }

  function receive(raw) {
    let value;
    try { value = JSON.parse(raw); } catch { return; }
    if (value?.type === 'pong') { lastPongAt = Date.now(); return; }
    if (!validState(value)) return;
    const nextKey = JSON.stringify(value);
    if (stateKey !== nextKey) {
      doc = value;
      stateKey = nextKey;
      failures = 0;
    }
    schedule();
  }

  function connect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    setConnection('Connecting…');
    let ws;
    try { ws = new WebSocket(CONFIG.wsUrl); }
    catch (error) { warn('WebSocket unavailable', error); reconnect(); return; }
    socket = ws;
    ws.addEventListener('open', () => {
      if (socket !== ws || stopped) return;
      reconnectAttempts = 0;
      lastPongAt = Date.now();
      setConnection('Connected');
      heartbeatTimer = setInterval(() => {
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPongAt >= CONFIG.pongMs) { ws.close(); return; }
        try { ws.send('{"type":"ping"}'); } catch { ws.close(); }
      }, CONFIG.pingMs);
    });
    ws.addEventListener('message', (event) => {
      if (socket === ws && !stopped) receive(event.data);
    });
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      clearInterval(heartbeatTimer);
      socket = null;
      doc = null;
      stateKey = '';
      appliedSession = null;
      lastSent = '';
      if (!stopped) reconnect();
    });
    ws.addEventListener('error', () => { if (socket === ws) ws.close(); });
  }

  function reconnect() {
    if (stopped) return;
    const base = Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempts++, 5));
    const delay = Math.min(30000, Math.round(base * (0.75 + Math.random() * 0.5)));
    setConnection('Reconnecting…');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  }

  const startButton = () => query('button[x-event-click="start"]');
  function solverStarted() {
    const started = query('#host')?.context?.started;
    return typeof started === 'boolean' ? started :
      rows().length > 0 || /reset/i.test(startButton()?.textContent || '');
  }

  function rows() {
    if (!rowsDirty) return cachedRows;
    const container = query('.stepsContainer');
    cachedRows = container ? Array.from(container.children)
      .map((el) => el.matches('cm-group') ? el : query('cm-group', el)).filter(Boolean) : [];
    indexedRows.clear();
    for (const row of cachedRows) {
      const label = query('[slot="header"] [x-bind-text-content="index$"]', row);
      const legacy = query('[slot="header"]', row)?.textContent.match(/#\s*(\d+)/);
      const index = label ? Number(label.textContent) : Number(legacy?.[1]);
      if (Number.isSafeInteger(index) && index > 0) indexedRows.set(index, row);
    }
    rowsDirty = false;
    return cachedRows;
  }

  function rowAt(index) { rows(); return indexedRows.get(index) || null; }
  const actionSelect = (row) => query('select[xu-action-options], select[name="stepAction"]', row);
  const conditionSelect = (row) => query('select[x-bind-value="condition$"], select[name="stepCondition"]', row);
  const editButton = (row) => query('[x-event-click="edit"]', row);
  const resultButton = (row, result) => query(`[x-event-click="finish,a=${result}"]`, row);

  function rowResult(row) {
    if (resultButton(row, 'success')?.classList.contains('success')) return 'success';
    if (resultButton(row, 'failure')?.classList.contains('failure')) return 'failure';
    return null;
  }

  function actionOption(select, name) {
    return Array.from(select?.options || []).find((option) => !option.disabled &&
      (key(option.value) === key(name) || key(option.textContent) === key(name)));
  }

  function actionMatches(row, name) {
    const select = actionSelect(row);
    if (!select) return false;
    // Direct match by option value or option text
    const option = actionOption(select, name);
    if (option && select.value === option.value) return true;
    // Check aliased compatibility (Hasty Touch <-> Daring Touch)
    const selectedText = select.selectedOptions[0]?.textContent || '';
    const selectedVal = select.value || '';
    return actionsCompatible(selectedVal, name) || actionsCompatible(selectedText, name);
  }

  function rowMatches(row, entry) {
    if (!row) return false;
    const condition = conditionSelect(row);
    return actionMatches(row, entry.action) &&
      (!shown(condition) || condition.value === entry.condition) &&
      rowResult(row) === (entry.success ? 'success' : 'failure') &&
      !row.classList.contains('error');
  }

  function suggestionName(row) {
    // Current Thiria localizes "Use X." as a single text node. The selected
    // option gives the action itself without scraping translated instructions.
    const select = actionSelect(row);
    if (select?.selectedOptions[0]?.value) {
      return select.selectedOptions[0].textContent.trim();
    }
    // Fallback: scrape from .steptext
    const span = query('.steptext .bold span', row) ||
                 query('.steptext .bold', row) ||
                 query('.steptext span', row);
    if (span) {
      return span.textContent.replace(/^Use\s+/i, '').replace(/\.$/, '').trim();
    }
    return '';
  }

  const STAT_FIELDS = [
    ['player.level$', 'player', 'level', false],
    ['player.cp$', 'player', 'cp', true],
    ['player.craftsmanship$', 'player', 'craftsmanship', false],
    ['player.control$', 'player', 'control', true],
    ['item.level$', 'recipe', 'level', false],
    ['item.durability$', 'recipe', 'durability', false],
    ['item.progress$', 'recipe', 'progress', false],
    ['item.quality$', 'recipe', 'quality', true],
  ];

  function statsReady(d) {
    return STAT_FIELDS.every(([, group, field, allowZero]) =>
      Number.isFinite(d[group][field]) && d[group][field] >= (allowZero ? 0 : 1));
  }

  function formFields() {
    const fields = new Map();
    for (const root of roots) {
      for (const el of root.querySelectorAll('input[x-bind-value], select[x-bind-value]')) {
        fields.set(el.getAttribute('x-bind-value'), el);
      }
    }
    return fields;
  }

  function enforceStats(d, fields) {
    for (const [binding, group, field] of STAT_FIELDS) {
      const input = fields.get(binding);
      if (!input || !setValue(input, d[group][field])) throw new Error(`Waiting for ${binding}`);
    }
  }

  function unlocks(d, fields) {
    const used = new Set(d.steps.map((entry) => key(entry.action)));
    for (const [field, observed] of [
      ['manipulation', used.has('manipulation')],
      ['specialist', [...used].some((action) => SPECIALIST.has(action))],
    ]) {
      const supplied = d.player[field];
      const wanted = observed ? true : supplied;
      if (typeof wanted !== 'boolean') continue;
      const binding = `player.${field}$`;
      const input = fields.get(binding);
      if (!(observed && supplied !== true ? inferSetting(binding, input, wanted) : setValue(input, wanted))) {
        throw new Error(`Waiting for ${field} toggle`);
      }
    }
  }

  function inferSetting(binding, input, value) {
    if (input && String(input.value) !== String(value) && !inferredSettings.has(binding)) {
      inferredSettings.set(binding, { previous: input.value, applied: String(value) });
    }
    return setValue(input, value);
  }

  function restoreInferredSettings(fields) {
    for (const [binding, saved] of inferredSettings) {
      const input = fields.get(binding);
      if (input?.value === saved.applied) setValue(input, saved.previous);
    }
    inferredSettings.clear();
  }

  function preferences(d, fields) {
    const relic = d.player.relic ?? CONFIG.relic;
    if (relic != null && (!['none', 'splendorous'].includes(relic) ||
        !setValue(fields.get('player.relic$'), relic))) throw new Error('Invalid or unavailable Relic setting');
    const suppliedMode = d.recipe.actionMode ?? CONFIG.actionMode;
    if (suppliedMode != null && !['default', 'all', 'none'].includes(suppliedMode)) {
      throw new Error('Invalid Stellar action mode');
    }
    const usedStellar = d.steps.some((entry) => key(entry.action) === 'stellarsteadyhand');
    const mode = usedStellar ? 'all' : suppliedMode;
    const input = fields.get('item.actionMode$');
    if (mode != null && !(usedStellar && suppliedMode !== 'all' ?
        inferSetting('item.actionMode$', input, mode) : setValue(input, mode))) {
      throw new Error('Stellar action mode unavailable');
    }
  }

  async function configure(d) {
    if (!statsReady(d)) throw new Error('Waiting for complete player/recipe data');
    const fields = formFields();
    restoreInferredSettings(fields);
    enforceStats(d, fields);
    unlocks(d, fields);
    preferences(d, fields);
    const rating = fields.get('item.profile$');
    if (!rating) throw new Error('Waiting for recipe rating');
    const exact = ['progressDivider', 'qualityDivider', 'progressModifier', 'qualityModifier']
      .every((field) => Number.isFinite(d.recipe[field]) && d.recipe[field] > 0);
    if (d.recipe.rating && !setValue(rating, d.recipe.rating)) {
      throw new Error(`Unsupported recipe rating: ${d.recipe.rating}`);
    }
    await sleep(CONFIG.pollMs);
    check(d);
    const unknown = query('label[for="itemRating"] [x-class-hidden="item.conditionKnown$"], ' +
      'label[for="itemRating"] [title*="not correspond to a known item"]');
    if (rating.value === 'custom' || shown(unknown)) {
      if (!exact) throw new Error('Exact recipe parameters unavailable');
      if (!setValue(rating, 'custom')) throw new Error('Custom recipe mode unavailable');
      const custom = [
        ['progressDivisor', 'progressDivider'], ['progressLevelAdjustment', 'progressModifier'],
        ['qualityDivisor', 'qualityDivider'], ['qualityLevelAdjustment', 'qualityModifier'],
      ];
      for (const [binding, field] of custom) {
        const input = await waitFor(() => bound(`item.${binding}$`), d, 'Waiting for Custom recipe fields');
        check(d);
        if (!setValue(input, d.recipe[field] / 100)) throw new Error(`Cannot set ${binding}`);
      }
    }
    check(d);
  }

  function schedule(delay = CONFIG.debounceMs) {
    if (stopped) return;
    if (running) { rerun = true; return; }
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(reconcile, delay);
  }

  async function reconcile() {
    reconcileTimer = null;
    if (running || stopped || !doc) return;
    const d = doc;
    if (paused || !d.fromStart) {
      setNote(paused ? 'Paused — manual control' : 'Attached mid-craft — auto-sync off');
      publishManual(d);
      return;
    }
    if (failures >= CONFIG.maxFailures) return;
    running = true;
    rerun = false;
    try {
      await sync(d);
      failures = 0;
    } catch (error) {
      if (error !== cancelled) {
        failures++;
        setNote(`${error.message}${failures >= CONFIG.maxFailures ? ' — Pause/Resume to retry' : ''}`);
        warn(error.message);
      }
    } finally {
      running = false;
      if (doc !== d || rerun || failures > 0) {
        if (failures < CONFIG.maxFailures || doc !== d) schedule(failures ? CONFIG.retryMs : CONFIG.debounceMs);
      }
    }
  }

  async function sync(d) {
    check(d);
    if (d.status === 'complete' && appliedSession !== d.session) { setNote('Craft complete'); return; }
    if (appliedSession !== d.session) {
      if (!statsReady(d)) throw new Error('Waiting for complete player/recipe data');
      const button = await waitFor(() => usable(startButton()) && startButton(), d, 'Solver not ready');
      check(d);
      if (solverStarted()) {
        rowsDirty = true;
        button.click();
        await waitFor(() => rows().length === 0, d, 'Waiting for solver reset');
        await sleep(CONFIG.pollMs);
        check(d);
      }
      await configure(d);
      check(d);
      appliedSession = d.session;
      unsupportedActions.clear();
      lastSent = '';
    } else {
      if (!statsReady(d)) throw new Error('Waiting for complete player/recipe data');
      const fields = formFields();
      enforceStats(d, fields);
      unlocks(d, fields);
      preferences(d, fields);
    }
    if (!rows().length) {
      if (d.status !== 'active') { setNote('Craft complete'); return; }
      const ready = await waitFor(() => {
        if (rows().length || solverStarted()) return true;
        const button = startButton();
        return usable(button) && button;
      }, d, 'Solver not ready');
      check(d);
      if (!rows().length && !solverStarted() && ready !== true && usable(ready)) {
        rowsDirty = true;
        ready.click();
      }
      await waitFor(() => rows().length > 0, d, 'Waiting for solver', CONFIG.solveMs);
    }

    let index = 0;
    for (const entry of d.steps) {
      check(d);
      // Material Miracle is a step-free cosmic Duty Action that forces a Good condition.
      // Thiria has no step row for it. Skipping it keeps subsequent rows aligned 1:1.
      if (entry.action && KNOWN_UNSUPPORTED.has(key(entry.action))) {
        continue;
      }
      if (entry.success == null || !entry.condition) { setNote('Waiting for action outcome'); return; }
      if (!entry.action) throw new Error('Action was not observed — manual sync required');

      index++;
      const row = await waitFor(() => rowAt(index), d, `Waiting for solver (step ${index})`, CONFIG.solveMs);
      check(d);
      if (!rowMatches(row, entry)) await driveRow(index, entry, d);
      check(d);
      if (!rowMatches(rowAt(index), entry) && !unsupportedActions.has(key(entry.action))) {
        throw new Error(`Step ${index} is out of sync`);
      }
    }
    if (d.status !== 'active') { setNote('Craft complete'); return; }

    const noExtraResults = () => {
      rows();
      for (const [number, row] of indexedRows) {
        if (number > index && rowResult(row)) throw new Error('Solver contains extra completed steps — reset it to resync');
      }
    };
    noExtraResults();

    const next = await waitFor(() => {
      const row = rowAt(index + 1);
      return row && !rowResult(row) && !row.classList.contains('error') && suggestionName(row) && row;
    }, d, 'Waiting for next suggestion', CONFIG.solveMs);
    check(d);
    noExtraResults();
    setNote(d.player.relic == null && CONFIG.relic == null ? 'Synced — verify Relic setting' : 'Synced');
    sendSuggestion(suggestionName(next), d, index + 1);
  }

  async function driveRow(index, entry, d) {
    const get = () => rowAt(index);
    let row = get();
    setNote(`Syncing step ${index}`);
    if (rowResult(row) || !actionMatches(row, entry.action)) {
      const select = actionSelect(row);
      if (rowResult(row) || !usable(select)) {
        const edit = editButton(row);
        if (!usable(edit)) throw new Error(`Cannot edit step ${index}`);
        check(d);
        rowsDirty = true;
        edit.click();
      }
      const selectReady = await waitFor(() => {
        row = get();
        const select = row && actionSelect(row);
        return usable(select) && !rowResult(row) && select;
      }, d, `Action selector unavailable (step ${index})`);
      check(d);

      const option = actionOption(selectReady, entry.action);
      if (!option) {
        // If Thiria's solver does not represent this action, accept Thiria's action
        // for this row so the craft keeps flowing without wedging.
        unsupportedActions.add(key(entry.action));
        warn(`Thiria can't represent "${entry.action}" — accepting "${suggestionName(row)}" and continuing; sim may drift.`);
        setNote(`"${entry.action}" unsupported — sim may drift`);
      } else if (!setValue(selectReady, option.value)) {
        throw new Error(`Cannot select ${entry.action}`);
      } else {
        await waitFor(() => {
          row = get();
          const text = row && query('.steptext', row)?.textContent;
          return row && actionMatches(row, entry.action) && text?.includes(option.textContent.trim()) && row;
        }, d, `Action update did not settle (step ${index})`);
        await sleep(CONFIG.pollMs);
        check(d);
      }
    }

    row = get();
    let condition = conditionSelect(row);
    if (shown(condition)) {
      condition = await waitFor(() => {
        const select = conditionSelect(get());
        return usable(select) && select;
      }, d, `Condition selector unavailable (step ${index})`);
      check(d);
      if (!setValue(condition, entry.condition)) throw new Error(`Unsupported condition: ${entry.condition}`);
    }

    const result = entry.success ? 'success' : 'failure';
    const button = await waitFor(() => {
      row = get();
      if (!row || !actionMatches(row, entry.action)) return null;
      const condition = conditionSelect(row);
      if (shown(condition) && condition.value !== entry.condition) return null;
      const button = resultButton(row, result);
      return usable(button) && button;
    }, d, `${result} unavailable for ${entry.action} (step ${index})`);
    check(d);
    rowsDirty = true;
    button.click();
    await waitFor(() => {
      const current = get();
      return current && (rowMatches(current, entry) || unsupportedActions.has(key(entry.action)));
    }, d, `Step ${index} did not confirm correctly`);
  }

  function sendSuggestion(name, d, index) {
    if (!name || doc !== d || d.status !== 'active' || stopped || socket?.readyState !== WebSocket.OPEN) return;
    const id = `${d.session}:${index}:${name}`;
    if (id === lastSent) return;
    try { socket.send(JSON.stringify({ next_action: name })); lastSent = id; }
    catch (error) { warn('Suggestion send failed', error); socket.close(); }
  }

  function publishManual(d) {
    if (d.status !== 'active') return;
    const row = rows().find((row) => !rowResult(row));
    if (row && !row.classList.contains('error')) sendSuggestion(suggestionName(row), d, rows().indexOf(row) + 1);
  }

  function setConnection(note) { connectionNote = note; renderStatus(); }
  function setNote(note) { if (note !== targetNote) { targetNote = note; renderStatus(); } }

  function renderStatus() {
    if (!statusEl) return;
    const label = `${connectionNote}${targetNote ? ` · ${targetNote}` : ''}`;
    if (statusLabel.textContent !== label) statusLabel.textContent = label;
    const toggle = paused ? 'Resume' : 'Pause';
    if (statusToggle.textContent !== toggle) statusToggle.textContent = toggle;
    statusDot.style.background = paused ? '#b88cff' : socket?.readyState === WebSocket.OPEN ? '#2ecc71' : '#f39c12';
  }

  function togglePause() {
    paused = !paused;
    failures = 0;
    lastSent = '';
    setNote(paused ? 'Paused — manual control' : 'Resuming…');
    renderStatus();
    schedule();
  }

  function ready() {
    if (stopped || statusEl) return;
    statusEl = document.createElement('div');
    statusEl.id = '__bridge_status__';
    Object.assign(statusEl.style, {
      position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
      font: '12px/1.4 system-ui,sans-serif', padding: '6px 10px', borderRadius: '6px',
      background: '#141414e6', color: '#fff', display: 'flex', alignItems: 'center', gap: '8px',
      pointerEvents: 'none', userSelect: 'none',
    });
    statusDot = document.createElement('span');
    Object.assign(statusDot.style, { width: '9px', height: '9px', borderRadius: '50%' });
    statusLabel = document.createElement('span');
    statusToggle = document.createElement('button');
    statusToggle.type = 'button';
    Object.assign(statusToggle.style, { pointerEvents: 'auto', cursor: 'pointer', color: '#fff',
      background: 'transparent', border: '1px solid #fff6', borderRadius: '4px', font: 'inherit' });
    statusToggle.addEventListener('click', togglePause);
    statusEl.append(statusDot, statusLabel, statusToggle);
    document.body.append(statusEl);
    renderStatus();
    roots.add(document);
    observe(document);
    discoverRoots(document);
    document.addEventListener('input', (event) => {
      if (!statusEl.contains(event.target)) schedule();
    });
    schedule();
  }

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
      togglePause();
    }
  });

  window.addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(reconcileTimer);
    clearInterval(heartbeatTimer);
    observer.disconnect();
    if (Element.prototype.attachShadow === shadowHook) Element.prototype.attachShadow = previousAttachShadow;
    doc = null;
    stateKey = '';
    appliedSession = null;
    lastSent = '';
    socket?.close();
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !stopped) return;
    stopped = false;
    rowsDirty = true;
    reconcileTimer = null;
    pruneRoots();
    for (const root of roots) observe(root);
    hookShadowRoots();
    connect();
  });

  hookShadowRoots();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
  connect();
})();
