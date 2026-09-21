const SVG = 'http://www.w3.org/2000/svg';
const ROLES = ['customer', 'employee', 'supplier', 'reseller'];
const ROLE_LABELS = { customer: 'Customer', employee: 'Employee', supplier: 'Supplier', reseller: 'Reseller' };
const STOPPED = new Set(['completed', 'complete', 'failed', 'cancelled', 'interrupted', 'paused']);
const RUN_EVENTS = {
  run_queued: 'queued', run_preparing: 'preparing', run_started: 'running',
  run_aggregating: 'aggregating', run_completed: 'completed', run_failed: 'failed',
  run_cancelled: 'cancelled', run_interrupted: 'interrupted', run_paused: 'paused',
};
const ACTION_LABELS = {
  purchase: 'Purchase chosen', add_item: 'Extra item chosen', substitute: 'Substitution chosen',
  place_order: 'Order chosen', defer: 'Deferred', abandon: 'Left without buying',
  no_action: 'No action', request_capacity: 'Requested capacity',
  request_replenishment: 'Requested replenishment', escalate: 'Escalated an issue',
  fulfill_replenishment: 'Scheduled replenishment', decline: 'Declined replenishment',
};
const asArray = value => Array.isArray(value) ? value : [];
const asText = value => typeof value === 'string' ? value : '';
const validRound = (value, steps) => Number.isInteger(value) && value > 0 && value <= steps;
const keyFor = (scenarioId, round, actorId) => JSON.stringify([scenarioId, round, actorId]);
const dollars = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);

function eventList(run, events) {
  if (!run) return [];
  const unique = new Map();
  for (const event of [...asArray(run.events), ...asArray(events)]) {
    if (!event || (event.runId && run.runId && event.runId !== run.runId)) continue;
    if (!Number.isInteger(event.sequence) || event.sequence < 1) continue;
    unique.set(event.sequence, event);
  }
  return [...unique.values()].sort((a, b) => a.sequence - b.sequence);
}

function committedStatus(record, ledger) {
  const action = record.action;
  const related = ledger.filter(event => event.actorId === record.actorId && event.round === record.round
    && (!asArray(record.eventIds).length || record.eventIds.includes(event.eventId)));
  const purchase = related.find(event => event.type === 'purchase');
  const blocked = related.find(event => ['stockout', 'capacity_unavailable'].includes(event.type));
  let label = ACTION_LABELS[action.type] || 'Decision committed';
  let state = action.type === 'no_action' ? 'neutral' : 'committed';
  const facts = [];
  if (blocked && ['purchase', 'add_item', 'substitute', 'place_order'].includes(action.type)) {
    label = blocked.type === 'stockout' ? 'Not purchased · out of stock' : 'Not purchased · capacity';
    state = 'constrained';
  } else if (purchase) {
    label = { add_item: 'Added an item', substitute: 'Purchased a substitute', place_order: 'Placed an order' }[action.type] || 'Purchased';
    if (Number.isFinite(purchase.totalChargeCents)) facts.push(`${dollars(purchase.totalChargeCents)} total charged`);
    const items = asArray(purchase.items);
    if (items.length && items.every(item => Number.isInteger(item.quantity))) {
      const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
      facts.push(`${quantity} ${quantity === 1 ? 'item' : 'items'}`);
    }
  }
  const parameters = action.parameters || {};
  if (action.type === 'request_capacity' && Number.isInteger(parameters.additionalOrders)) {
    facts.push(`${parameters.additionalOrders} extra order ${parameters.additionalOrders === 1 ? 'slot' : 'slots'} requested`);
  }
  if (['request_replenishment', 'fulfill_replenishment'].includes(action.type) && Number.isInteger(parameters.quantity)) {
    facts.push(`${parameters.quantity} ${parameters.quantity === 1 ? 'unit' : 'units'}`);
  }
  const scheduled = related.find(event => ['capacity_scheduled', 'replenishment_scheduled'].includes(event.type));
  if (Number.isInteger(scheduled?.arrivalRound)) facts.push(`Scheduled for round ${scheduled.arrivalRound}`);
  return { state, label, active: false, committed: true, explanation: asText(action.explanation), facts, record };
}

function actorStatus({ actor, run, runStatus, record, ledger, event, scenarioId, round }) {
  const base = { actorId: actor.id, scenarioId, round, active: false, committed: false, explanation: '', facts: [], record: null };
  if (record?.action) return { ...base, ...committedStatus(record, ledger), note: 'Simulated decision · committed to the saved round' };
  if (!run) return { ...base, state: 'idle', label: 'Ready to simulate', note: 'Prepared sample record. No model response or decision yet.' };
  const type = event?.type, data = event?.data || {};
  const responseReady = type === 'actor_completed' && data.validated === true;
  const actorCancelled = type === 'actor_cancelled' || String(data.error?.code || '').toLowerCase() === 'cancelled';
  if (STOPPED.has(runStatus)) {
    const stoppedLabel = { completed: 'Run completed', complete: 'Run completed', failed: 'Run failed',
      cancelled: 'Run cancelled', interrupted: 'Run interrupted', paused: 'Run paused' }[runStatus];
    const label = responseReady ? 'Response ready · not committed' : actorCancelled ? 'Cancelled · not committed'
      : type === 'actor_failed' ? 'Response failed'
        : runStatus === 'cancelled' ? 'Cancelled · not committed' : 'No committed decision';
    return { ...base, state: responseReady ? 'ready' : actorCancelled || runStatus === 'cancelled' ? 'cancelled' : type === 'actor_failed' ? 'failed' : 'idle',
      label, note: `${stoppedLabel}. No decision was committed for this person in this round.` };
  }
  if (responseReady) return { ...base, state: 'ready', label: 'Response ready', note: 'Validated response. Waiting for the whole round to commit; this is not a saved decision yet.' };
  if (type === 'actor_failed' || actorCancelled) return { ...base, state: actorCancelled ? 'cancelled' : 'failed',
    label: actorCancelled ? 'Response cancelled' : 'Response failed', note: asText(data.error?.message) || 'No decision has been committed.' };
  if (type === 'actor_started' || type === 'attempt_started') return { ...base, state: 'running', label: 'Considering the option', active: true,
    note: 'A persisted runtime event confirms a model request is in progress. No decision yet.' };
  if (type === 'actor_retrying') return { ...base, state: 'retrying', label: 'Retry pending', active: true,
    note: 'The runtime recorded a retry. No decision has been committed.' };
  if (type === 'attempt_completed') return { ...base, state: 'ready', label: 'Response received',
    note: 'The request finished. Waiting for actor validation and round commit.' };
  if (type === 'attempt_failed') return { ...base, state: 'failed', label: 'Attempt failed',
    note: 'The recorded attempt failed. A retry or final run status may follow; no decision is committed.' };
  return { ...base, state: 'idle', label: 'Waiting for turn', note: 'No response or committed decision for this person in the selected round.' };
}

/** Derive the view solely from persisted snapshots and sequenced runtime events. */
export function derivePeopleGraphState({ bundle, run = null, events = [], selection } = {}) {
  bundle ||= run?.manifest;
  const actors = asArray(bundle?.inputs?.actors).filter(actor => typeof actor?.id === 'string');
  const scenarios = asArray(bundle?.definition?.scenarios).filter(scenario => typeof scenario?.scenarioId === 'string');
  const scenarioIds = new Set(scenarios.map(scenario => scenario.scenarioId));
  const steps = Math.max(1, Math.min(6, Number(bundle?.definition?.horizon?.steps) || 1));
  const history = eventList(run, events), records = new Map(), ledgers = new Map(), latest = new Map();
  let runStatus = run?.status || 'preview';
  const watermark = Math.max(0, ...asArray(run?.events).map(event => Number(event.sequence) || 0));
  let cursor = { scenarioId: scenarios[0]?.scenarioId || null, round: 1 };
  const addRecords = (scenarioId, actions, ledger, round) => {
    if (!scenarioIds.has(scenarioId)) return;
    for (const record of asArray(actions)) {
      if (validRound(record.round, steps) && (!round || record.round === round) && (!record.scenarioId || record.scenarioId === scenarioId)) {
        records.set(keyFor(scenarioId, record.round, record.actorId), record);
      }
    }
    const all = ledgers.get(scenarioId) || new Map();
    for (const event of asArray(ledger)) {
      if ((!event.scenarioId || event.scenarioId === scenarioId) && (!round || event.round === round)) {
        all.set(event.eventId || keyFor(event.type, event.round, event.actorId), event);
      }
    }
    ledgers.set(scenarioId, all);
  };
  for (const scenario of scenarios) {
    const result = asArray(run?.results).find(item => item.scenarioId === scenario.scenarioId);
    if (!result) continue;
    addRecords(result.scenarioId, result.actions, result.ledgerEvents);
    const completed = Math.max(Number(result.completedRounds) || 0, ...asArray(result.actions).map(record => Number(record.round) || 0));
    if (validRound(completed, steps)) cursor = { scenarioId: result.scenarioId, round: completed };
  }
  let eventCursor = null;
  for (const event of history) {
    if (RUN_EVENTS[event.type] && (!STOPPED.has(runStatus) || (runStatus === 'paused' && STOPPED.has(RUN_EVENTS[event.type])))
      && (event.sequence > watermark || STOPPED.has(RUN_EVENTS[event.type]))) {
      runStatus = RUN_EVENTS[event.type];
    }
    const data = event.data || {}, scenarioId = event.scenarioId || data.scenarioId;
    if (!scenarioIds.has(scenarioId)) continue;
    if (event.type === 'scenario_started') eventCursor = { scenarioId, round: 1 };
    if (!validRound(data.round, steps)) continue;
    eventCursor = { scenarioId, round: data.round };
    if (data.actorId && /^(actor_(started|completed|failed|cancelled|retrying)|attempt_(started|completed|failed))$/.test(event.type)) {
      latest.set(keyFor(scenarioId, data.round, data.actorId), event);
    }
    // actor_completed is only validation. Only this atomic event publishes actions.
    if (event.type === 'round_committed') addRecords(scenarioId, data.actions, data.events, data.round);
  }
  const progress = value => scenarios.findIndex(scenario => scenario.scenarioId === value.scenarioId) * steps + value.round;
  if (eventCursor && progress(eventCursor) >= progress(cursor)) cursor = eventCursor;
  const selected = {
    scenarioId: scenarioIds.has(selection?.scenarioId) ? selection.scenarioId : cursor.scenarioId,
    round: validRound(selection?.round, steps) ? selection.round : cursor.round,
  };
  const counts = {}, numbers = {};
  const nodes = actors.map(actor => {
    const role = asText(actor.role) || 'person';
    numbers[role] = (numbers[role] || 0) + 1;
    const key = keyFor(selected.scenarioId, selected.round, actor.id);
    const status = actorStatus({ actor, run, runStatus, record: records.get(key),
      ledger: [...(ledgers.get(selected.scenarioId)?.values() || [])], event: latest.get(key), ...selected });
    counts[status.state] = (counts[status.state] || 0) + 1;
    return { ...status, statusLabel: status.label, role, label: `${ROLE_LABELS[role] || 'Person'} ${numbers[role]}`,
      sourceLabel: asText(actor.label) || actor.id, actor };
  });
  return { nodes, scenarios, steps, selected, cursor, runStatus, counts,
    committed: nodes.filter(node => node.committed).length, active: nodes.filter(node => node.active).length };
}

function graphTopology(bundle, actors) {
  const nodes = new Map(actors.map(actor => [actor.id, { ...actor, actor: true }]));
  for (const node of asArray(bundle?.inputs?.graph?.nodes)) {
    if (typeof node?.id === 'string' && !nodes.has(node.id)) nodes.set(node.id, { ...node, actor: false });
  }
  const endpoint = value => typeof value === 'string' ? value : value?.id;
  const edges = asArray(bundle?.inputs?.graph?.edges).map((edge, index) => ({
    id: asText(edge.id) || `edge-${index}`,
    from: endpoint(edge.from ?? edge.source ?? edge.sourceId),
    to: endpoint(edge.to ?? edge.target ?? edge.targetId),
    label: asText(edge.label) || asText(edge.type) || 'Modeled relationship',
  })).filter(edge => nodes.has(edge.from) && nodes.has(edge.to));
  return { nodes: [...nodes.values()], edges };
}

let instanceSequence = 0;

export function createPeopleGraph(root, { onInspect } = {}) {
  if (!root?.ownerDocument) throw new TypeError('createPeopleGraph requires a DOM root element.');
  const doc = root.ownerDocument, win = doc.defaultView, id = `people-graph-${++instanceSequence}`;
  const controller = new win.AbortController(), listeners = { signal: controller.signal };
  const html = (tag, className, text) => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const svg = (tag, attributes = {}) => {
    const element = doc.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  };
  const text = (element, value) => { if (element.textContent !== String(value)) element.textContent = String(value); };
  const button = (className, label) => {
    const element = html('button', className, label);
    element.type = 'button';
    return element;
  };
  const controls = html('div', 'pg-controls');
  const scenarios = html('div', 'pg-scenarios');
  scenarios.setAttribute('role', 'group'); scenarios.setAttribute('aria-label', 'Simulation option');
  const follow = button('pg-follow', 'Follow live');
  follow.setAttribute('aria-pressed', 'true');
  controls.append(scenarios, follow);
  const timeline = html('div', 'pg-timeline'), rounds = html('div', 'pg-rounds');
  rounds.setAttribute('role', 'group'); rounds.setAttribute('aria-label', 'Simulation round');
  const summary = html('span', 'pg-summary');
  summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
  timeline.append(rounds, summary);
  const stage = html('div', 'pg-stage'), viewport = html('div', 'pg-viewport');
  const canvas = svg('svg', { class: 'pg-canvas', role: 'group', 'aria-label': 'Simulated people, grouped by role' });
  const groupsLayer = svg('g', { class: 'pg-groups', 'aria-hidden': 'true' });
  const edgesLayer = svg('g', { class: 'pg-edges' }), nodesLayer = svg('g', { class: 'pg-nodes' });
  canvas.append(groupsLayer, edgesLayer, nodesLayer); viewport.append(canvas);
  const empty = html('div', 'pg-empty');
  empty.append(html('span', 'pg-empty-mark', '◌'), html('strong', '', 'Your people, in perspective'),
    html('p', '', 'Describe your options to prepare the sample panel. Live decisions will appear here when you run it.'));
  const popup = html('section', 'pg-popup');
  popup.id = `${id}-detail`; popup.hidden = true; popup.setAttribute('aria-label', 'Person and saved decision');
  const popupTop = html('div', 'pg-popup-top'), popupRole = html('span', 'pg-popup-role');
  const dismiss = button('pg-popup-close', '×');
  dismiss.setAttribute('aria-label', 'Close person detail');
  popupTop.append(popupRole, dismiss);
  const popupTitle = html('h3', 'pg-popup-title'), source = html('p', 'pg-popup-source');
  const context = html('p', 'pg-popup-context'), status = html('p', 'pg-popup-status');
  const facts = html('p', 'pg-popup-facts'), explanationLabel = html('span', 'pg-explanation-label', 'Generated explanation');
  const explanation = html('p', 'pg-popup-explanation'), note = html('p', 'pg-popup-note');
  const inspect = button('pg-inspect', 'View decision details ↗');
  popup.append(popupTop, popupTitle, source, context, status, facts, explanationLabel, explanation, note, inspect);
  stage.append(viewport, empty, popup);
  const footer = html('div', 'pg-footer'), legend = html('div', 'pg-legend');
  for (const [state, label] of [['idle', 'Waiting'], ['running', 'In progress'], ['ready', 'Response ready'], ['committed', 'Committed'], ['neutral', 'No action']]) {
    const item = html('span', 'pg-legend-item', label); item.dataset.state = state; legend.append(item);
  }
  const connectionNote = html('p', 'pg-connection-note');
  footer.append(legend, connectionNote);
  root.classList.add('people-graph'); root.replaceChildren(controls, timeline, stage, footer);
  const actorElements = new Map(), hubElements = new Map(), edgeElements = new Map(), groupElements = new Map();
  const scenarioButtons = new Map(), roundButtons = new Map();
  let input = {}, model = derivePeopleGraphState(), topology = { nodes: [], edges: [] };
  let followLive = true, selected = null, pinned = null, hovered = null, focused = null, shown = null;
  let dismissed = null, hideTimer, resizeFrame, destroyed = false, identity = null, topologyKey = '';
  let positions = new Map();

  function setFollowing(value) {
    followLive = value;
    follow.setAttribute('aria-pressed', String(value));
    follow.title = value ? 'Live selection follows persisted scenario and round events' : 'Resume following the current scenario and round';
    text(follow, value ? 'Following live' : 'Follow live');
  }

  function closePopup() {
    dismissed = shown; pinned = null; hovered = null;
    popup.hidden = true;
    for (const element of actorElements.values()) {
      element.node.removeAttribute('aria-describedby');
      element.node.setAttribute('aria-expanded', 'false');
      element.node.dataset.pinned = 'false';
    }
    shown = null;
  }

  function positionPopup() {
    if (popup.hidden || !shown) return;
    const anchor = actorElements.get(shown)?.node;
    if (!anchor) return;
    const bounds = stage.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
    popup.style.maxHeight = '';
    const width = popup.offsetWidth, gap = 10;
    let left = rect.right - bounds.left + gap;
    let top = rect.top - bounds.top - 8;
    if (left + width > bounds.width - 8) {
      left = rect.left - bounds.left - width - gap;
      if (left < 8) {
        const below = bounds.height - (rect.bottom - bounds.top) - gap - 8;
        const above = rect.top - bounds.top - gap - 8;
        const placeBelow = below >= 160 || below >= above;
        const available = Math.max(120, placeBelow ? below : above);
        popup.style.maxHeight = `${Math.min(bounds.height - 16, available)}px`;
        top = placeBelow ? rect.bottom - bounds.top + gap : rect.top - bounds.top - gap - popup.offsetHeight;
      }
    }
    left = Math.max(8, Math.min(left, bounds.width - width - 8));
    top = Math.max(8, Math.min(top, bounds.height - popup.offsetHeight - 8));
    popup.style.left = `${left}px`; popup.style.top = `${top}px`;
  }

  function updatePopup(preferredActor) {
    const holdingPopup = !popup.hidden && (popup.matches(':hover') || popup.contains(doc.activeElement));
    const actorId = pinned || preferredActor || hovered || (holdingPopup ? shown : focused);
    const data = model.nodes.find(node => node.actorId === actorId);
    if (!data || dismissed === actorId) { if (shown) closePopup(); return; }
    shown = actorId; popup.hidden = false;
    popup.dataset.role = ROLES.includes(data.role) ? data.role : 'person';
    popup.dataset.state = data.state;
    text(popupRole, `${ROLE_LABELS[data.role] || 'Person'} · ${data.actor.profileMode === 'synthetic' ? 'test fixture' : 'sample record'}`);
    text(popupTitle, data.label); text(source, data.sourceLabel);
    const scenario = model.scenarios.find(item => item.scenarioId === model.selected.scenarioId);
    text(context, `${scenario?.label || 'Prepared option'} · Round ${model.selected.round}`);
    text(status, data.statusLabel); text(facts, data.facts.join(' · ')); facts.hidden = !data.facts.length;
    explanationLabel.hidden = explanation.hidden = !data.explanation;
    text(explanation, data.explanation.length > 300 ? `${data.explanation.slice(0, 297)}…` : data.explanation);
    text(note, data.note);
    inspect.hidden = typeof onInspect !== 'function';
    for (const [key, element] of actorElements) {
      element.node.dataset.pinned = String(key === pinned);
      element.node.setAttribute('aria-expanded', String(key === actorId));
      if (key === actorId) element.node.setAttribute('aria-describedby', popup.id);
      else element.node.removeAttribute('aria-describedby');
    }
    positionPopup();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (destroyed || popup.matches(':hover') || popup.contains(doc.activeElement)) return;
      updatePopup();
      if (!pinned && !hovered && !focused) closePopup();
    }, 180);
  }

  function buildActor(data) {
    const node = svg('g', { class: 'pg-node', role: 'button', tabindex: 0, 'data-actor-id': data.actorId,
      'aria-controls': popup.id, 'aria-expanded': 'false' });
    const hit = svg('rect', { class: 'pg-node-hit', x: -28, y: -28, width: 56, height: 56, 'aria-hidden': 'true' });
    const halo = svg('circle', { class: 'pg-node-halo', r: 28, 'aria-hidden': 'true' });
    const face = svg('circle', { class: 'pg-node-face', r: 22, 'aria-hidden': 'true' });
    const head = svg('circle', { class: 'pg-person-head', cy: -6, r: 5.6, 'aria-hidden': 'true' });
    const shoulders = svg('path', { class: 'pg-person-body', d: 'M-11 12C-11 1 11 1 11 12Z', 'aria-hidden': 'true' });
    const badge = svg('circle', { class: 'pg-node-badge', cx: 17, cy: 16, r: 7, 'aria-hidden': 'true' });
    const badgeMark = svg('text', { class: 'pg-node-badge-mark', x: 17, y: 19.5, 'text-anchor': 'middle', 'aria-hidden': 'true' });
    const label = svg('text', { class: 'pg-node-label', y: 42, 'text-anchor': 'middle', 'aria-hidden': 'true' });
    node.append(hit, halo, face, head, shoulders, badge, badgeMark, label);
    nodesLayer.append(node);
    return { node, label, badgeMark };
  }

  function syncControls() {
    const scenarioIds = new Set(model.scenarios.map(item => item.scenarioId));
    for (const [key, element] of scenarioButtons) if (!scenarioIds.has(key)) { element.remove(); scenarioButtons.delete(key); }
    let option = 0;
    model.scenarios.forEach(scenario => {
      let element = scenarioButtons.get(scenario.scenarioId);
      const fallback = scenario.isBaseline ? 'Baseline' : `Option ${String.fromCharCode(65 + option++)}`;
      const shortLabel = /^Option [A-Z]$/i.test(scenario.label) ? scenario.label : fallback;
      if (!element) {
        element = button('pg-scenario', '');
        element.dataset.scenarioId = scenario.scenarioId;
        element.append(html('span', 'pg-scenario-name'), html('span', 'pg-scenario-label'));
        scenarioButtons.set(scenario.scenarioId, element); scenarios.append(element);
      }
      text(element.firstElementChild, shortLabel);
      text(element.lastElementChild, scenario.label === shortLabel ? '' : asText(scenario.label));
      element.lastElementChild.hidden = !element.lastElementChild.textContent;
      element.setAttribute('aria-pressed', String(model.selected.scenarioId === scenario.scenarioId));
      element.title = asText(scenario.label) || shortLabel;
    });
    for (const [round, element] of roundButtons) if (round > model.steps) { element.remove(); roundButtons.delete(round); }
    for (let round = 1; round <= model.steps; round++) {
      let element = roundButtons.get(round);
      if (!element) {
        element = button('pg-round', `Round ${round}`); element.dataset.round = String(round);
        roundButtons.set(round, element); rounds.append(element);
      }
      element.setAttribute('aria-pressed', String(model.selected.round === round));
    }
    controls.hidden = timeline.hidden = !model.scenarios.length;
    follow.disabled = !input.run;
    text(follow, STOPPED.has(model.runStatus)
      ? followLive ? 'Latest round' : 'Go to latest round'
      : input.run && followLive ? 'Following live' : 'Follow live');
    const completion = model.nodes.length ? `${model.committed}/${model.nodes.length} committed` : 'No panel';
    const stoppedLabel = { completed: 'Complete', complete: 'Complete', cancelled: 'Cancelled', failed: 'Failed', paused: 'Paused', interrupted: 'Interrupted' }[model.runStatus];
    text(summary, !input.run ? 'Prepared · no decisions yet' : `${completion}${model.active ? ` · ${model.active} in progress` : ''}${stoppedLabel ? ` · ${stoppedLabel}` : ''}`);
    summary.dataset.live = String(Boolean(model.active));
  }

  function layout() {
    if (destroyed) return;
    if (!topology.nodes.length) {
      for (const element of groupElements.values()) element.node.remove();
      groupElements.clear();
      return;
    }
    const width = Math.max(260, Math.round(viewport.clientWidth || root.clientWidth || 760));
    const minHeight = Math.max(350, viewport.clientHeight || 390);
    const groups = [...new Set([...ROLES, ...topology.nodes.map(node => node.actor ? node.role || 'person' : 'model')])]
      .map(role => ({ role, nodes: topology.nodes.filter(node => (node.actor ? node.role || 'person' : 'model') === role) }))
      .filter(group => group.nodes.length);
    const wide = width >= 660, gap = 12, inset = 14;
    const customer = groups.find(group => group.role === 'customer'), others = groups.filter(group => group !== customer);
    let height = minHeight, y = inset;
    const boxes = [];
    const columnsFor = (count, boxWidth) => Math.max(1, Math.min(Math.ceil(Math.sqrt(count)), Math.floor((boxWidth - 28) / 88)));
    const groupHeight = (group, boxWidth) => {
      const columns = columnsFor(group.nodes.length, boxWidth);
      return 34 + Math.ceil(group.nodes.length / columns) * 78;
    };
    if (wide && customer && others.length) {
      const leftWidth = Math.floor((width - inset * 2 - gap) * 0.60), rightWidth = width - inset * 2 - gap - leftWidth;
      const rightHeights = others.map(group => groupHeight(group, rightWidth));
      height = Math.max(minHeight, groupHeight(customer, leftWidth) + inset * 2, rightHeights.reduce((a, b) => a + b, 0) + gap * (others.length - 1) + inset * 2);
      boxes.push({ ...customer, x: inset, y: inset, width: leftWidth, height: height - inset * 2 });
      others.forEach((group, index) => {
        boxes.push({ ...group, x: inset + leftWidth + gap, y, width: rightWidth, height: rightHeights[index] });
        y += rightHeights[index] + gap;
      });
    } else {
      for (const group of groups) {
        const boxHeight = groupHeight(group, width - inset * 2);
        boxes.push({ ...group, x: inset, y, width: width - inset * 2, height: boxHeight });
        y += boxHeight + gap;
      }
      height = Math.max(minHeight, y - gap + inset);
    }
    canvas.setAttribute('viewBox', `0 0 ${width} ${height}`);
    canvas.style.height = `${height}px`;
    positions = new Map();
    const roles = new Set(boxes.map(box => box.role));
    for (const [role, element] of groupElements) if (!roles.has(role)) { element.node.remove(); groupElements.delete(role); }
    for (const box of boxes) {
      let group = groupElements.get(box.role);
      if (!group) {
        const node = svg('g', { class: 'pg-cluster', 'data-role': ROLES.includes(box.role) ? box.role : 'person' });
        const background = svg('rect', { rx: 24 }), label = svg('text', { class: 'pg-cluster-label' });
        node.append(background, label); groupsLayer.append(node);
        group = { node, background, label }; groupElements.set(box.role, group);
      }
      for (const key of ['x', 'y', 'width', 'height']) group.background.setAttribute(key, box[key]);
      group.label.setAttribute('x', box.x + 18); group.label.setAttribute('y', box.y + 26);
      text(group.label, `${box.role === 'model' ? 'Modeled entities' : `${ROLE_LABELS[box.role] || 'Person'}${box.nodes.length === 1 ? '' : 's'}`} · ${box.nodes.length}`);
      const columns = columnsFor(box.nodes.length, box.width);
      const rows = Math.ceil(box.nodes.length / columns);
      const rowHeight = (box.height - 34) / rows;
      box.nodes.forEach((node, index) => {
        const row = Math.floor(index / columns), rowCount = Math.min(columns, box.nodes.length - row * columns);
        const x = box.x + box.width / 2 + (index % columns - (rowCount - 1) / 2) * Math.min(104, (box.width - 28) / columns);
        const py = box.y + 34 + rowHeight * row + rowHeight / 2 - 8;
        positions.set(node.id, { x, y: py });
        const element = node.actor ? actorElements.get(node.id)?.node : hubElements.get(node.id);
        element?.setAttribute('transform', `translate(${x},${py})`);
      });
    }
    for (const edge of topology.edges) {
      const from = positions.get(edge.from), to = positions.get(edge.to), element = edgeElements.get(edge.id);
      if (!from || !to || !element) continue;
      element.setAttribute('d', `M${from.x},${from.y} Q${(from.x + to.x) / 2},${Math.min(from.y, to.y) - 24} ${to.x},${to.y}`);
    }
    positionPopup();
  }

  function render() {
    if (destroyed) return;
    model = derivePeopleGraphState({ ...input, selection: followLive ? undefined : selected });
    selected = { ...model.selected };
    syncControls();
    const actorIds = new Set(model.nodes.map(node => node.actorId));
    for (const [key, element] of actorElements) if (!actorIds.has(key)) { element.node.remove(); actorElements.delete(key); }
    for (const data of model.nodes) {
      let element = actorElements.get(data.actorId);
      if (!element) { element = buildActor(data); actorElements.set(data.actorId, element); }
      element.node.dataset.role = ROLES.includes(data.role) ? data.role : 'person';
      element.node.dataset.state = data.state; element.node.dataset.active = String(data.active);
      text(element.label, data.label);
      const scenario = model.scenarios.find(item => item.scenarioId === model.selected.scenarioId);
      element.node.setAttribute('aria-label', `${data.label}. ${data.sourceLabel}. ${data.statusLabel}. ${scenario?.label || 'Prepared option'}, round ${model.selected.round}. Press Enter to pin details.`);
      text(element.badgeMark, data.committed ? data.state === 'neutral' ? '−' : data.state === 'constrained' ? '!' : '✓'
        : data.state === 'failed' || data.state === 'cancelled' ? '×' : data.state === 'ready' ? '·' : '');
    }
    empty.hidden = Boolean(model.nodes.length);
    legend.hidden = !model.nodes.length;
    const bundle = input.bundle || input.run?.manifest;
    const nextTopology = graphTopology(bundle, model.nodes.map(node => node.actor));
    const nextKey = JSON.stringify([nextTopology.nodes.map(node => [node.id, node.role, node.actor, node.label]), nextTopology.edges]);
    if (nextKey !== topologyKey) {
      topology = nextTopology; topologyKey = nextKey;
      for (const element of hubElements.values()) element.remove();
      hubElements.clear();
      for (const node of topology.nodes.filter(node => !node.actor)) {
        const element = svg('g', { class: 'pg-hub', role: 'img', 'aria-label': asText(node.label) || node.id });
        element.append(svg('rect', { x: -23, y: -23, width: 46, height: 46, rx: 15 }));
        const label = svg('text', { y: 42, 'text-anchor': 'middle' }); label.textContent = asText(node.label) || node.id;
        const mark = svg('text', { y: 6, 'text-anchor': 'middle', 'aria-hidden': 'true' }); mark.textContent = '◇';
        element.append(mark, label); hubElements.set(node.id, element); nodesLayer.append(element);
      }
      for (const element of edgeElements.values()) element.remove();
      edgeElements.clear();
      for (const edge of topology.edges) {
        const path = svg('path', { class: 'pg-edge', role: 'img', 'aria-label': edge.label });
        const title = svg('title'); title.textContent = edge.label; path.append(title);
        edgesLayer.append(path); edgeElements.set(edge.id, path);
      }
      layout();
    }
    text(connectionNote, topology.edges.length
      ? 'Connections represent modeled operational relationships, not social influence.'
      : 'Grouped by role. This saved model has no relationship edges; no connections or social influence are inferred.');
    updatePopup();
  }

  root.addEventListener('click', event => {
    const target = event.target.closest('button, [data-actor-id]');
    if (!target || !root.contains(target)) return;
    if (target === follow) {
      setFollowing(!followLive); if (followLive) { pinned = null; dismissed = null; } render();
    } else if (target.dataset.scenarioId) {
      selected = { ...model.selected, scenarioId: target.dataset.scenarioId }; setFollowing(false); render();
    } else if (target.dataset.round) {
      selected = { ...model.selected, round: Number(target.dataset.round) }; setFollowing(false); render();
    } else if (target === dismiss) {
      const actorId = shown, anchor = actorElements.get(shown)?.node, inPopup = popup.contains(doc.activeElement);
      closePopup();
      if (inPopup) { focused = actorId; anchor?.focus({ preventScroll: true }); }
    } else if (target === inspect && shown) {
      onInspect?.(shown, { ...model.selected });
    } else if (target.dataset.actorId) {
      const actorId = target.dataset.actorId;
      if (pinned === actorId) closePopup();
      else { pinned = actorId; dismissed = null; setFollowing(false); updatePopup(); }
    }
  }, listeners);
  root.addEventListener('keydown', event => {
    const node = event.target.closest('[data-actor-id]');
    if (node && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); node.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    }
  }, listeners);
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !popup.hidden) {
      event.preventDefault();
      const actorId = shown, anchor = actorElements.get(shown)?.node, inPopup = popup.contains(doc.activeElement);
      closePopup(); if (inPopup) { focused = actorId; anchor?.focus({ preventScroll: true }); }
    }
  }, listeners);
  root.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const node = event.target.closest('[data-actor-id]');
    if (node && !node.contains(event.relatedTarget)) {
      hovered = node.dataset.actorId; dismissed = null; clearTimeout(hideTimer); updatePopup();
    }
    if (popup.contains(event.target)) clearTimeout(hideTimer);
  }, listeners);
  root.addEventListener('pointerout', event => {
    const node = event.target.closest('[data-actor-id]');
    if (node && !node.contains(event.relatedTarget)) { hovered = null; scheduleHide(); }
    if (popup.contains(event.target) && !popup.contains(event.relatedTarget)) scheduleHide();
  }, listeners);
  root.addEventListener('focusin', event => {
    const node = event.target.closest('[data-actor-id]');
    if (node) {
      if (focused !== node.dataset.actorId) dismissed = null;
      focused = node.dataset.actorId; updatePopup(focused);
    }
  }, listeners);
  root.addEventListener('focusout', event => {
    const node = event.target.closest('[data-actor-id]');
    if (node && !popup.contains(event.relatedTarget)) { focused = null; scheduleHide(); }
    if (popup.contains(event.target) && !popup.contains(event.relatedTarget) && !event.relatedTarget?.closest('[data-actor-id]')) {
      focused = null; scheduleHide();
    }
  }, listeners);
  viewport.addEventListener('scroll', positionPopup, { ...listeners, passive: true });
  const resize = () => {
    win.cancelAnimationFrame(resizeFrame);
    resizeFrame = win.requestAnimationFrame(() => { layout(); positionPopup(); });
  };
  const observer = win.ResizeObserver ? new win.ResizeObserver(resize) : null;
  observer?.observe(viewport);
  win.addEventListener('resize', resize, listeners);
  setFollowing(true);
  render();
  return {
    update(value = {}) {
      if (destroyed) return;
      const bundle = value.bundle || value.run?.manifest;
      const nextIdentity = JSON.stringify([bundle?.definition?.experimentId, bundle?.definition?.version, value.run?.runId || null]);
      if (identity !== null && identity !== nextIdentity) {
        closePopup(); focused = null; dismissed = null; selected = null; setFollowing(true);
      }
      identity = nextIdentity; input = value; render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true; controller.abort(); observer?.disconnect();
      clearTimeout(hideTimer); win.cancelAnimationFrame(resizeFrame);
      root.replaceChildren(); root.classList.remove('people-graph');
      for (const map of [actorElements, hubElements, edgeElements, groupElements, scenarioButtons, roundButtons, positions]) map.clear();
      input = {}; topology = { nodes: [], edges: [] }; model = derivePeopleGraphState();
    },
  };
}
