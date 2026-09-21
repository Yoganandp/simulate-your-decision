const $ = (id) => document.getElementById(id);
const SELECTED_RUN_KEY = 'copilot-simulations.selected-run.v1';
const PENDING_START_KEY = 'copilot-simulations.pending-start.v1';
const TERMINAL = new Set(['completed', 'complete', 'failed', 'cancelled', 'interrupted', 'paused']);
const MONEY_METRICS = new Set(['productRevenue', 'shippingRevenue', 'costOfGoodsSold', 'shippingCost', 'incrementalLaborCost', 'contribution']);
const METRICS = [
  ['contribution', 'Panel contribution'],
  ['productRevenue', 'Product revenue'],
  ['shippingRevenue', 'Shipping revenue'],
  ['costOfGoodsSold', 'Cost of goods sold'],
  ['shippingCost', 'Shipping cost'],
  ['incrementalLaborCost', 'Incremental labor cost'],
  ['purchases', 'Purchases'],
  ['abandonments', 'Abandonments'],
  ['deferrals', 'Deferrals'],
  ['extraItems', 'Extra items'],
  ['stockouts', 'Stockouts'],
  ['repeatPurchases', 'Repeat purchases'],
  ['abandonmentRate', 'Abandonment rate'],
];
const SAMPLE = 'Should AdventureWorks raise the free-shipping threshold from $50 to $75 or $100, keeping a $7.95 shipping fee below the threshold? Compare simulated panel contribution over three shopping cycles and review abandonment and stockouts.';
const ASSUMPTION_FIELDS = [
  { key: 'fulfillmentCostPerOrderCents', label: 'Fulfillment cost per order ($)', money: true, nullable: true },
  { key: 'incrementalLaborRateCentsPerHour', label: 'Incremental labor per hour ($)', money: true, nullable: true },
  { key: 'resellerBudgetCents', label: 'Reseller budget for horizon ($)', money: true },
  { key: 'customerBudgetMultiplierBps', label: 'Customer budget (% of scheduled baskets)', percent: true, min: 10, max: 1000 },
  { key: 'stockPerProductUnits', label: 'Starting stock per product (units)', min: 0, max: 10000 },
  { key: 'panelCapacityPerCycle', label: 'Panel order capacity per cycle', min: 0, max: 200 },
  { key: 'employeeMaxAdditionalCapacity', label: 'Extra order slots per employee', min: 0, max: 20 },
  { key: 'laborMinutesPerCapacityUnit', label: 'Labor minutes per extra slot', min: 1, max: 480 },
  { key: 'supplierCapacityUnits', label: 'Supplier capacity per cycle (units)', min: 1, max: 1000 },
  { key: 'supplierLeadTimeCycles', label: 'Supply lead time (cycles)', min: 1, max: 3 },
  { key: 'resellerMaxUnitsPerOrder', label: 'Reseller maximum units per order', min: 1, max: 20 },
];
const state = {
  bundle: null, saved: false, dirty: false, busy: false, provider: null,
  policies: [], assumptionValues: {}, otherConstraints: [], run: null, eventSource: null,
  events: new Map(), cursor: 0, pollTimer: null, refreshTimer: null,
  runEpoch: 0, refreshPromise: null, section: 'prepare-section', replay: false,
  pendingStart: readLocal(PENDING_START_KEY), revisionOptions: [], sample: false, storageUnavailable: false,
};
let sessionToken;
let tokenRequest;
let lastInteraction = performance.now();
let lastTimingTick = performance.now();
const activeTime = { editing: 0, review: 0, export: 0 };
let activeStage = 'editing';

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}

function button(text, handler, className = 'button secondary') {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', () => void safely(handler));
  return element;
}

function list(items, parent, render = (value) => node('li', readable(value))) {
  const ul = node('ul');
  for (const item of items || []) ul.append(render(item));
  parent.append(ul);
}

function readable(value) {
  if (value === undefined || value === null) return 'Unknown';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function pretty(value) {
  return node('pre', readable(value));
}

function keyValues(entries) {
  const dl = node('dl', null, 'key-values');
  for (const [key, value] of entries) dl.append(node('dt', key), node('dd', readable(value)));
  return dl;
}

function dateTime(value) {
  if (!value) return 'Not supplied';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}

function dollars(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Unknown';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) / 100);
}

function centsInput(value, label, nullable = false) {
  if (String(value).trim() === '' && nullable) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) throw new Error(`${label}: enter a nonnegative US dollar amount with at most two decimal places${nullable ? ', or leave blank for unknown' : ''}.`);
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents)) throw new Error(`${label} is too large.`);
  return cents;
}

function numeric(id) {
  const element = $(id);
  if (!element.checkValidity()) throw new Error(`${element.labels?.[0]?.textContent?.trim() || id}: enter a valid value.`);
  const value = Number(element.value);
  if (!Number.isFinite(value)) throw new Error(`Invalid number in ${id}.`);
  return value;
}

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function writeLocal(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    state.storageUnavailable = true;
    notify('Browser storage is unavailable. Server results remain saved; use History to reconnect after refreshing.');
    return false;
  }
}

function notify(message) {
  $('notice').textContent = message && state.storageUnavailable
    ? `${message} Browser persistence is unavailable; use History to restore server results and download brief edits before leaving.`
    : message;
  $('notice').hidden = !message;
}

function reportError(error) {
  $('error').textContent = error?.message || String(error);
  $('error').hidden = false;
}

async function safely(action) {
  $('error').hidden = true;
  try { return await action(); } catch (error) { reportError(error); return undefined; }
}

async function api(path, body, options = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    if (!sessionToken) {
      tokenRequest ||= fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error('Could not establish the local session. Refresh the page and try again.');
          const session = await response.json();
          if (!session.token) throw new Error('The server did not supply a session token.');
          return session.token;
        }).finally(() => { tokenRequest = null; });
      sessionToken = await tokenRequest;
    }
    headers['Content-Type'] = 'application/json';
    headers['X-Simulation-Token'] = sessionToken;
  }
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store', headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...options,
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`The server returned a non-JSON response (${response.status}); the request outcome is unverified. If starting a run, recover using the same request key rather than creating another request.`); }
  if (!response.ok) {
    if (response.status === 403) sessionToken = null;
    const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.message;
    const error = new Error(detail || `Request failed (${response.status}).`);
    error.code = payload.error?.code || payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function busy(action) {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  try { return await action(); }
  finally { state.busy = false; updateControls(); }
}

function currentModel() {
  return state.saved ? state.bundle?.definition.runConfig.model : $('model-id').value.trim();
}

function providerReady(status = state.provider) {
  const model = currentModel();
  const provider = state.bundle?.definition.runConfig.provider || 'copilot';
  return Boolean(model && status?.ready === true && status.requestedModel === model &&
    status.provider === provider && status.modelResolution !== 'mismatch');
}

function markDirty() {
  if (state.saved) return;
  state.dirty = Boolean(state.bundle);
  $('review-confirm').checked = false;
  updateControls();
}

function updateControls() {
  const frozen = state.saved;
  document.querySelectorAll('[data-draft]').forEach((element) => { element.disabled = frozen || state.busy; });
  $('sample-button').disabled = frozen || state.busy;
  $('prepare-button').disabled = frozen || state.busy;
  $('prepare-button').textContent = state.busy ? 'Working…' : state.dirty ? 'Reprepare changes →' : 'Prepare experiment →';
  $('reprepare-button').hidden = !state.dirty;
  $('reprepare-button').disabled = state.busy;
  $('add-option').disabled = frozen || state.busy || state.policies.filter((policy) => !policy.isBaseline).length >= 2;
  $('save-button').hidden = frozen;
  $('save-button').disabled = !state.bundle || !state.bundle.definition.runConfig.model || state.dirty || !$('review-confirm').checked || state.busy;
  $('review-confirm').disabled = frozen || state.busy || state.dirty;
  $('start-button').disabled = !frozen || state.busy || !providerReady() || (state.run && !TERMINAL.has(state.run.status));
  $('start-button').hidden = !frozen;
  $('preflight-button').disabled = state.busy;
  $('preflight-button').textContent = 'Verify model';
  $('guardrail-max-abandonment').disabled = frozen || state.busy || !$('guardrail-enabled').checked;
  $('draft-state').textContent = frozen ? `Saved · version ${state.bundle.definition.version}` : state.dirty ? 'Reprepare required' : 'Unsaved draft';
  $('save-hint').textContent = frozen
    ? providerReady() ? 'Saved version is immutable. Starting makes fresh model calls; viewing and replay do not.' : 'Verify this version’s explicit model before starting. Saving alone does not make model calls.'
    : state.dirty ? 'Reprepare this draft and review it before saving.' : !state.bundle?.definition.runConfig.model ? 'Enter an exact model ID in Experiment setup, then reprepare before saving. No default model will be chosen.' : 'Save a reviewed, immutable version before starting.';
  document.querySelectorAll('[data-option-remove]').forEach((element) => {
    element.disabled = frozen || state.busy || state.policies.filter((item) => !item.isBaseline).length <= 1;
  });
  if (state.pendingStart && state.bundle && state.pendingStart.experimentId === state.bundle.definition.experimentId && state.pendingStart.version === state.bundle.definition.version) {
    $('start-button').textContent = 'Recover start · same request key';
  } else $('start-button').textContent = state.run ? 'Start a fresh simulation' : 'Start simulation';
  $('cancel-button').disabled = !state.run || TERMINAL.has(state.run.status) || state.busy || state.run.status === 'cancelling';
  $('revision-button').disabled = !frozen || state.busy;
  $('replay-button').disabled = !canCreateBrief() || state.busy;
  $('brief-button').disabled = !canCreateBrief() || state.busy;
  $('new-experiment').disabled = state.busy;
  document.querySelector('[data-section="run-section"]').disabled = !state.run;
  document.querySelector('[data-section="compare-section"]').disabled = !state.run;
}

function showSection(id) {
  if (id !== 'prepare-section' && !state.run) return;
  tickTiming();
  state.section = id;
  activeStage = id === 'prepare-section' ? state.saved ? 'review' : 'editing' : id === 'compare-section' ? 'review' : null;
  for (const section of ['prepare-section', 'run-section', 'compare-section']) $(section).hidden = section !== id;
  document.querySelectorAll('[data-section]').forEach((element) => {
    if (element.dataset.section === id) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
  });
  if (id === 'compare-section') renderComparison();
}

function getDraftInput() {
  const input = {
    decisionText: $('decision-text').value.trim(),
    title: $('experiment-title').value.trim() || undefined,
    customerCount: numeric('customer-count'), employeeCount: numeric('employee-count'),
    supplierCount: numeric('supplier-count'), resellerCount: numeric('reseller-count'),
    cycles: numeric('cycle-count'), seed: $('panel-seed').value,
    runConfig: {
      provider: 'copilot', model: $('model-id').value.trim() || null,
      concurrency: numeric('concurrency'), attemptCap: numeric('attempt-cap'),
      deadlineMs: numeric('deadline-minutes') * 60000, callTimeoutMs: numeric('call-timeout') * 1000,
      repetitions: 1,
    },
  };
  if (!input.decisionText) throw new Error('Describe the shipping-policy decision before preparing.');
  const [metricId, direction] = $('objective-choice').value.split(':');
  input.objective = { metricId, direction };
  input.constraints = [...state.otherConstraints];
  if ($('guardrail-enabled').checked) {
    input.constraints.push({
      metricId: 'abandonmentRate', comparator: '<=',
      threshold: numeric('guardrail-max-abandonment') / 100, severity: 'hard',
    });
  }
  if (state.bundle) {
    const baseline = state.policies.find((policy) => policy.isBaseline);
    const normalizedBaseline = readPolicy(baseline);
    input.baseline = { thresholdCents: normalizedBaseline.thresholdCents, shippingFeeCents: normalizedBaseline.shippingFeeCents };
    input.options = state.policies.filter((policy) => !policy.isBaseline).map(readPolicy);
    input.assumptions = readAssumptionInputs();
  } else if (state.sample) {
    input.baseline = { thresholdCents: 5000, shippingFeeCents: 795 };
    input.options = [
      { label: '$75 threshold', thresholdCents: 7500, shippingFeeCents: 795 },
      { label: '$100 threshold', thresholdCents: 10000, shippingFeeCents: 795 },
    ];
  }
  if (input.options) {
    const scenarioCount = input.options.length + 1;
    const requestedActions = (input.customerCount + input.employeeCount + input.supplierCount + input.resellerCount) * input.cycles * scenarioCount;
    if (input.runConfig.attemptCap < requestedActions + 1) throw new Error(`The hard budget must allow the planned ${requestedActions} actor actions plus a startup preflight attempt. Raise it to at least ${requestedActions + 1}, or reduce the panel or cycles.`);
  }
  return input;
}

function readPolicy(policy) {
  return {
    label: policy.label,
    thresholdCents: centsInput(policy.threshold, `${policy.label} threshold`),
    shippingFeeCents: centsInput(policy.fee, `${policy.label} shipping fee`),
    existingCustomerThresholdCents: centsInput(policy.existingThreshold, `${policy.label} existing-customer threshold`, true),
  };
}

async function prepareDraft() {
  if (state.saved) return;
  if (!$('experiment-form').reportValidity()) return;
  const input = getDraftInput();
  await busy(async () => {
    const bundle = await api('/api/experiments/draft', input);
    state.bundle = bundle;
    state.saved = false;
    state.dirty = false;
    renderBundle();
    notify('Draft prepared. Review normalized policies, actual panel coverage and every synthetic assumption. No simulation has started.');
    $('draft-review').scrollIntoView({ behavior: 'instant', block: 'start' });
  });
}

function renderMessages(id, items, heading) {
  const element = $(id);
  element.replaceChildren();
  element.hidden = !items?.length;
  if (items?.length) {
    element.append(node('strong', heading));
    list(items, element);
  }
}

function policyFromScenario(scenario) {
  return {
    scenarioId: scenario.scenarioId, label: scenario.label, isBaseline: scenario.isBaseline,
    threshold: (scenario.policy.thresholdCents / 100).toFixed(2),
    fee: (scenario.policy.shippingFeeCents / 100).toFixed(2),
    existingThreshold: scenario.policy.existingCustomerThresholdCents == null ? '' : (scenario.policy.existingCustomerThresholdCents / 100).toFixed(2),
  };
}

function renderBundle() {
  const { definition, inputs } = state.bundle;
  $('draft-review').hidden = false;
  document.body.classList.add('has-draft');
  $('decision-text').value = definition.decisionText;
  $('experiment-title').value = definition.title;
  $('panel-seed').value = definition.seed;
  $('cycle-count').value = definition.horizon.steps;
  const runConfig = definition.runConfig;
  $('model-id').value = runConfig.model || '';
  if (!providerReady()) {
    state.provider = null;
    $('provider-status').className = 'provider-status';
    $('provider-status').textContent = runConfig.model ? `Requested model: ${runConfig.model}. Not verified in this browser session; resolved identity is not asserted. Use Verify model before starting fresh inference.` : 'No model configured. Enter an exact model ID, reprepare, and verify before starting.';
  }
  $('concurrency').value = runConfig.concurrency;
  $('attempt-cap').value = runConfig.attemptCap;
  $('deadline-minutes').value = runConfig.deadlineMs / 60000;
  $('call-timeout').value = runConfig.callTimeoutMs / 1000;
  state.policies = definition.scenarios.map(policyFromScenario);
  renderPolicies();
  renderMessages('draft-questions', state.bundle.questions, 'Clarifications to review');
  renderMessages('draft-warnings', state.bundle.warnings, 'Preparation warnings');
  const objectiveChoice = `${definition.objective.metricId}:${definition.objective.direction}`;
  if (![...$('objective-choice').options].some((option) => option.value === objectiveChoice)) {
    const option = node('option', `${definition.objective.direction} ${METRICS.find(([id]) => id === definition.objective.metricId)?.[1] || definition.objective.metricId}`);
    option.value = objectiveChoice;
    $('objective-choice').append(option);
  }
  $('objective-choice').value = objectiveChoice;
  const objectiveLabel = METRICS.find(([id]) => id === definition.objective.metricId)?.[1] || definition.objective.metricId;
  $('objective-summary').textContent = `${definition.objective.direction === 'maximize' ? 'Maximize' : 'Minimize'} ${objectiveLabel.toLowerCase()}.`;
  $('objective-explanation').textContent = definition.metricDefinitions.find((metric) => metric.metricId === definition.objective.metricId)?.formula || 'Calculated from committed events for this unweighted simulated panel.';
  const editableGuard = definition.constraints.find((constraint) => constraint.metricId === 'abandonmentRate' && constraint.comparator === '<=' && constraint.severity === 'hard');
  $('guardrail-enabled').checked = Boolean(editableGuard);
  $('guardrail-max-abandonment').value = editableGuard ? Number((editableGuard.threshold * 100).toFixed(6)) : 20;
  state.otherConstraints = definition.constraints.filter((constraint) => constraint !== editableGuard);
  $('objective-details').replaceChildren(keyValues([
    ['Metric', definition.objective.metricId],
    ['Direction', definition.objective.direction],
    ['Scope', definition.objective.scope],
  ]));
  $('constraint-details').replaceChildren(node('h3', 'Declared guardrails'));
  if (definition.constraints?.length) {
    for (const constraint of definition.constraints) {
      if (constraint.metricId === 'abandonmentRate' && constraint.comparator === '<=') {
        $('constraint-details').append(node('p', `Abandonment rate ≤ ${Number((constraint.threshold * 100).toFixed(6))}% of scheduled customer opportunities · ${constraint.severity} guardrail. Saved ratio: ${constraint.threshold}.`, 'hint'));
      } else $('constraint-details').append(pretty(constraint));
    }
  } else $('constraint-details').append(node('p', 'No guardrails declared. Do not interpret an unconstrained result as an approved business policy.', 'hint'));
  $('horizon-details').replaceChildren(
    node('strong', `${definition.horizon.steps} shopping cycles · not annualized`),
    node('p', definition.horizon.interpretation),
    node('p', 'One repetition per option. These are simulated opportunities, not elapsed calendar years.', 'hint'),
  );
  const counts = inputs.actors.reduce((all, actor) => { all[actor.role] = (all[actor.role] || 0) + 1; return all; }, {});
  if (state.saved) {
    $('customer-count').value = counts.customer || 0;
    $('employee-count').value = counts.employee || 0;
    $('supplier-count').value = counts.supplier || 0;
    $('reseller-count').value = counts.reseller || 0;
  }
  $('source-summary').replaceChildren(keyValues([
    ['Source', inputs.snapshot.sourceType],
    ['Snapshot date (source)', inputs.snapshot.asOf || definition.asOf || 'Not supplied'],
    ['Actual panel', `${counts.customer || 0} customers · ${counts.employee || 0} employees · ${counts.supplier || 0} suppliers · ${counts.reseller || 0} resellers`],
    ['Panel basis', 'Unweighted sample records; no population extrapolation'],
  ]));
  $('source-details').replaceChildren(
    node('h4', 'Source entity counts'), pretty(inputs.snapshot.entityCounts),
    node('h4', 'Coverage & missing data'), pretty(inputs.snapshot.coverage),
    node('h4', 'Frozen comparison inputs'),
    keyValues([
      ['Snapshot', inputs.snapshot.snapshotId], ['Snapshot hash', inputs.snapshot.hash],
      ['Population', inputs.populationId], ['Population hash', inputs.populationHash],
      ['Graph', inputs.graph.graphId], ['Graph hash', inputs.graph.hash],
      ['Initial state', inputs.initialStateId], ['Initial state hash', inputs.initialStateHash],
      ['External conditions hash', inputs.externalEventsHash], ['Units', inputs.snapshot.units],
    ]),
  );
  renderAssumptions();
  $('metric-definitions').replaceChildren();
  for (const definitionRecord of definition.metricDefinitions || []) $('metric-definitions').append(pretty(definitionRecord));
  const planned = state.bundle.estimate?.plannedActions ?? inputs.actors.length * definition.scenarios.length * definition.horizon.steps;
  $('estimate').replaceChildren(node('strong', `${planned} planned actions`), node('p', `${definition.scenarios.length} scenarios × ${inputs.actors.length} actors × ${definition.horizon.steps} cycles`), node('p', `${runConfig.attemptCap} hard maximum attempts (including run preflight)`), node('p', `Deadline: ${runConfig.deadlineMs / 60000} minutes · ${runConfig.concurrency} concurrent calls`), node('p', 'No measured completion-time estimate is available.'));
  $('review-confirm').checked = state.saved;
  $('lineage').replaceChildren(keyValues([
    ['Experiment', `${definition.experimentId} · version ${definition.version}`],
    ['Parent', definition.parentVersion == null ? 'Original experiment' : `${definition.parentExperimentId || definition.experimentId} · version ${definition.parentVersion}`],
    ['Comparison design', 'Frozen inputs; a revised version freshly simulates the baseline and each option'],
  ]));
  renderActors();
  updateControls();
}

function policyField(card, labelText, value, handler, { nullable = false, editable = true, text = false } = {}) {
  const label = node('label', labelText);
  const input = node('input');
  input.type = text ? 'text' : 'number';
  if (!text) { input.min = '0'; input.step = '0.01'; input.inputMode = 'decimal'; }
  else input.maxLength = 100;
  input.value = value;
  input.required = !nullable;
  if (nullable) input.placeholder = 'None (use general threshold)';
  if (editable) input.dataset.draft = '';
  input.addEventListener('input', () => handler(input.value));
  label.append(input);
  card.append(label);
  return input;
}

function renderPolicies() {
  $('policy-options').replaceChildren();
  state.policies.forEach((policy, index) => {
    const card = node('article', null, `policy-card${policy.isBaseline ? ' baseline' : ''}`);
    card.append(node('h4', policy.isBaseline ? 'BASELINE · reviewed assumption' : `OPTION ${index} · reviewed assumption`));
    const edit = (key) => (value) => { policy[key] = value; markDirty(); };
    const name = policyField(card, 'Name', policy.label, edit('label'), { text: true });
    if (policy.isBaseline) name.readOnly = true;
    policyField(card, 'Free-shipping threshold ($)', policy.threshold, edit('threshold'));
    policyField(card, 'Fee below threshold ($)', policy.fee, edit('fee'));
    if (!policy.isBaseline) {
      policyField(card, 'Existing-customer threshold ($, optional)', policy.existingThreshold, edit('existingThreshold'), { nullable: true });
      const remove = button('Remove option', () => {
        state.policies.splice(index, 1);
        renderPolicies();
        markDirty();
      }, 'button subtle remove-option');
      remove.disabled = state.saved || state.busy || state.policies.filter((item) => !item.isBaseline).length <= 1;
      remove.dataset.optionRemove = '';
      card.append(remove);
    } else card.append(node('p', 'The baseline is freshly simulated under the same conditions.', 'caption'));
    $('policy-options').append(card);
  });
}

function renderAssumptions() {
  state.assumptionValues = {};
  $('assumption-inputs').replaceChildren();
  $('assumption-list').replaceChildren();
  for (const field of ASSUMPTION_FIELDS) {
    const record = state.bundle.inputs.assumptions.find((item) => item.key === field.key);
    if (!record) continue;
    const value = record.value == null ? '' : field.money ? (record.value / 100).toFixed(2) : field.percent ? String(record.value / 100) : String(record.value);
    state.assumptionValues[field.key] = value;
    const wrapper = node('div');
    const label = node('label', field.label);
    const input = node('input');
    input.type = 'number';
    input.dataset.draft = '';
    input.dataset.assumption = field.key;
    input.step = field.money || field.percent ? '0.01' : '1';
    input.min = String(field.min ?? 0);
    if (field.max !== undefined) input.max = String(field.max);
    input.required = !field.nullable;
    input.placeholder = field.nullable ? 'Unknown (null)' : '';
    input.value = value;
    input.addEventListener('input', () => { state.assumptionValues[field.key] = input.value; markDirty(); });
    label.append(input);
    wrapper.append(label, node('p', record.description, 'hint'), button(`Assumption · ${record.assumptionId}`, () => inspectAssumption(record.assumptionId), 'reference-button'));
    $('assumption-inputs').append(wrapper);
  }
  for (const record of state.bundle.inputs.assumptions) {
    const item = node('article', null, 'assumption-record');
    item.append(node('strong', record.description || record.key || record.assumptionId), node('p', `Value: ${readable(record.value)} · origin: ${record.source || 'declared assumption'}`, 'hint'));
    item.append(button(record.assumptionId, () => inspectAssumption(record.assumptionId), 'reference-button'));
    $('assumption-list').append(item);
  }
}

function readAssumptionInputs() {
  const values = {};
  for (const field of ASSUMPTION_FIELDS) {
    if (!Object.hasOwn(state.assumptionValues, field.key)) continue;
    const text = state.assumptionValues[field.key];
    if (field.money) values[field.key] = centsInput(text, field.label, field.nullable);
    else {
      const input = document.querySelector(`[data-assumption="${field.key}"]`);
      if (!input.checkValidity() || text === '') throw new Error(`${field.label}: enter a valid ${field.percent ? 'percentage' : 'whole number'}.`);
      const value = field.percent ? Math.round(Number(text) * 100) : Number(text);
      if (!Number.isSafeInteger(value)) throw new Error(`${field.label}: value does not normalize to an integer.`);
      values[field.key] = value;
    }
  }
  return values;
}

async function saveDraft() {
  if (!state.bundle || state.saved || state.dirty || !$('review-confirm').checked) return;
  if (!state.bundle.definition.runConfig.model) throw new Error('Enter an explicit model ID, then reprepare the draft before saving this immutable version.');
  await busy(async () => {
    let saved;
    try {
      saved = await api('/api/experiments', { definition: state.bundle.definition, inputs: state.bundle.inputs });
    } catch (error) {
      if (['DRAFT_REQUIRED', 'DRAFT_CHANGED'].includes(error.code)) markDirty();
      throw error;
    }
    state.bundle = { ...state.bundle, ...saved };
    state.saved = true;
    await flushTiming('editing');
    activeStage = 'review';
    renderBundle();
    notify('Reviewed version saved. Verify the frozen model, then start when ready. Changes now require an explicit revision.');
  });
}

async function verifyProvider() {
  const model = currentModel();
  if (!model) throw new Error('Enter an exact model ID supported by your Copilot account. No model is selected automatically.');
  await busy(async () => {
    $('provider-status').textContent = 'Checking the explicitly requested model. This may make a small schema-verification call…';
    const status = await api(`/api/provider/status?model=${encodeURIComponent(model)}`);
    state.provider = status;
    renderProvider(status);
  });
}

function renderProvider(status) {
  const target = $('provider-status');
  const ready = providerReady(status);
  const identity = status.modelResolution === 'mismatch'
    ? 'Mismatch — this configuration cannot start a run'
    : status.modelResolution === 'reported' && status.resolvedModel
      ? 'CLI-reported only; not independently verified'
      : 'Unresolved — identity unverified';
  target.className = `provider-status ${ready ? 'ready' : 'problem'}`;
  target.replaceChildren(keyValues([
    ['Readiness', ready ? 'Explicit request passed the schema preflight' : status.ready === true ? 'Configuration mismatch — start blocked' : 'Not ready — resolve setup before starting'],
    ['Provider', status.provider || 'Not reported'],
    ['Configured model', currentModel() || 'Not configured'],
    ['Requested model', status.requestedModel || 'Not reported'],
    ['CLI-reported model', status.resolvedModel || 'Not exposed'],
    ['Model identity', identity],
    ['CLI version', status.cliVersion || 'Not reported'],
  ]));
  if (!status.resolvedModel) target.append(node('p', 'A successful request does not prove a resolved identity when the CLI does not expose it.', 'hint'));
  if (status.error?.message) target.append(node('p', status.error.message, 'hint'));
  else if (status.message) target.append(node('p', status.message, 'hint'));
  const details = node('details', null, 'inline-details');
  details.append(node('summary', 'Safe preflight details'), pretty(status));
  target.append(details);
}

function renderActors() {
  $('actor-panel').replaceChildren();
  $('comparison-actors').replaceChildren();
  for (const actor of state.bundle?.inputs.actors || []) {
    const item = button('', () => inspectActor(actor.id), 'actor-button');
    const text = node('span');
    const actorStatus = node('small', 'No run selected');
    actorStatus.dataset.actorStatus = actor.id;
    text.append(node('strong', actor.label), node('small', `${actor.role} · ${actor.profileMode}`), actorStatus);
    item.append(node('span', actor.role.slice(0, 1).toUpperCase(), 'actor-avatar'), text);
    $('actor-panel').append(item);
    $('comparison-actors').append(button(actor.label, () => inspectActor(actor.id), 'actor-chip'));
  }
}

async function startRun() {
  if (!state.saved || !providerReady()) throw new Error('Save a reviewed version and verify its exact model before starting.');
  await busy(async () => {
    await flushTiming('review');
    const { experimentId, version } = state.bundle.definition;
    if (!state.pendingStart || state.pendingStart.experimentId !== experimentId || state.pendingStart.version !== version) {
      state.pendingStart = { experimentId, version, idempotencyKey: crypto.randomUUID() };
      writeLocal(PENDING_START_KEY, state.pendingStart);
    }
    const started = await api(`/api/experiments/${encodeURIComponent(experimentId)}/runs`, {
      version, idempotencyKey: state.pendingStart.idempotencyKey,
    });
    writeLocal(SELECTED_RUN_KEY, { runId: started.runId, cursor: 0 });
    state.pendingStart = null;
    writeLocal(PENDING_START_KEY, null);
    await loadRun(started.runId);
    notify('Simulation started once for this request. Refreshing reconnects to this run; it does not start another.');
  });
}

function disconnectViewer() {
  state.eventSource?.close();
  state.eventSource = null;
  clearInterval(state.pollTimer);
  clearTimeout(state.refreshTimer);
  state.pollTimer = null;
  state.refreshTimer = null;
  state.refreshPromise = null;
  state.runEpoch += 1;
}

async function loadRun(runId, preferredSection = 'run-section') {
  disconnectViewer();
  const previousSelection = readLocal(SELECTED_RUN_KEY);
  state.run = null;
  writeLocal(SELECTED_RUN_KEY, {
    runId,
    cursor: previousSelection?.runId === runId ? Number(previousSelection.cursor) || 0 : 0,
  });
  const epoch = state.runEpoch;
  const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
  if (epoch !== state.runEpoch) return;
  const experimentId = run.manifest?.experimentId;
  const version = run.manifest?.version;
  if (!experimentId || version == null) throw new Error('The stored run does not identify its exact experiment version. It cannot be inspected safely.');
  const bundle = await api(`/api/experiments/${encodeURIComponent(experimentId)}?version=${encodeURIComponent(version)}`);
  if (epoch !== state.runEpoch) return;
  state.bundle = bundle;
  state.saved = true;
  state.dirty = false;
  state.run = run;
  state.replay = false;
  state.events = new Map();
  const selected = readLocal(SELECTED_RUN_KEY);
  state.cursor = selected?.runId === runId ? Number(selected.cursor) || 0 : 0;
  ingestSnapshot(run);
  renderBundle();
  renderRun();
  loadLocalBrief();
  showSection(preferredSection);
  persistCursor();
  if (!TERMINAL.has(run.status)) connectStream();
  else $('stream-status').textContent = 'Viewing saved committed results. No new model calls.';
  updateControls();
}

function persistCursor() {
  if (state.run) writeLocal(SELECTED_RUN_KEY, { runId: state.run.runId, cursor: state.cursor });
}

function ingestSnapshot(snapshot) {
  for (const event of snapshot.events || []) {
    if (!Number.isInteger(event.sequence) || event.runId !== snapshot.runId) continue;
    state.events.set(event.sequence, event);
    state.cursor = Math.max(state.cursor, event.sequence);
  }
}

function connectStream() {
  if (!state.run || TERMINAL.has(state.run.status)) return;
  state.eventSource?.close();
  clearInterval(state.pollTimer);
  state.pollTimer = null;
  const runId = state.run.runId;
  const epoch = state.runEpoch;
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${state.cursor}`);
  state.eventSource = source;
  $('stream-status').textContent = `Reconnecting viewer after event ${state.cursor}. No new inference requested.`;
  $('reconnect-button').hidden = true;
  source.addEventListener('open', () => {
    if (epoch === state.runEpoch) $('stream-status').textContent = 'Live viewer connected · events are persisted before publication.';
  });
  source.addEventListener('simulation', (message) => {
    if (epoch !== state.runEpoch) return;
    try {
      const event = JSON.parse(message.data);
      if (event.runId !== runId || !Number.isInteger(event.sequence) || event.sequence <= state.cursor) return;
      state.events.set(event.sequence, event);
      state.cursor = event.sequence;
      persistCursor();
      renderProgress();
      scheduleSnapshot();
    } catch {
      $('stream-status').textContent = 'An invalid stream event was ignored. Reading the committed server state.';
      scheduleSnapshot();
    }
  });
  source.addEventListener('error', () => {
    if (epoch !== state.runEpoch) return;
    source.close();
    state.eventSource = null;
    $('stream-status').textContent = 'Stream disconnected. Safely polling committed status every 5 seconds; the run is not cancelled or restarted.';
    $('reconnect-button').hidden = false;
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => void refreshSnapshot().catch(streamReadError), 5000);
    void refreshSnapshot().catch(streamReadError);
  });
}

function streamReadError(error) {
  $('stream-status').textContent = `Cannot read run status: ${error.message}. The viewer has not cancelled or restarted it. Reconnect when the server is available.`;
  $('reconnect-button').hidden = false;
}

function scheduleSnapshot() {
  if (state.refreshTimer) return;
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    void refreshSnapshot().catch(streamReadError);
  }, 350);
}

async function refreshSnapshot() {
  if (!state.run) return;
  if (state.refreshPromise) return state.refreshPromise;
  const epoch = state.runEpoch;
  const runId = state.run.runId;
  const request = (async () => {
    const snapshot = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (epoch !== state.runEpoch || state.run?.runId !== runId) return;
    state.run = snapshot;
    state.replay = false;
    ingestSnapshot(snapshot);
    const snapshotSequence = Math.max(0, ...(snapshot.events || []).map((event) => event.sequence));
    if (state.cursor > snapshotSequence && !TERMINAL.has(snapshot.status)) scheduleSnapshot();
    persistCursor();
    renderRun();
    if (state.section === 'compare-section') renderComparison();
    if (TERMINAL.has(snapshot.status)) {
      state.eventSource?.close();
      state.eventSource = null;
      clearInterval(state.pollTimer);
      state.pollTimer = null;
      $('stream-status').textContent = `Saved run status: ${snapshot.status}. Showing committed results; this viewer makes no new model calls.`;
      $('reconnect-button').hidden = true;
    }
    updateControls();
  })();
  state.refreshPromise = request;
  try { return await request; }
  finally { if (state.refreshPromise === request) state.refreshPromise = null; }
}

async function cancelRun() {
  if (!state.run || TERMINAL.has(state.run.status)) return;
  if (!window.confirm('Request cancellation of this simulation? The server will stop queued work and request termination of active calls. Already committed rounds remain available and may be incomplete.')) return;
  await busy(async () => {
    const cancellation = await api(`/api/runs/${encodeURIComponent(state.run.runId)}/cancel`, {});
    state.run.status = cancellation.status;
    await refreshSnapshot();
    notify('Explicit cancellation requested. Viewing or leaving the page would not have cancelled this run.');
  });
}

function scenarioLabel(scenarioId) {
  return state.bundle?.definition.scenarios.find((scenario) => scenario.scenarioId === scenarioId)?.label || scenarioId || 'Scenario not yet selected';
}

function committedActions() {
  return (state.run?.results || []).flatMap((result) => (result.actions || []).map((action) => ({ ...action, scenarioId: result.scenarioId })));
}

function renderRun() {
  const run = state.run;
  if (!run) return;
  const definition = state.bundle.definition;
  $('run-identity').textContent = `${definition.title} · version ${definition.version} · ${run.runId}`;
  $('run-state').textContent = state.replay ? 'Verified saved replay' : run.status;
  renderProgress();
  const accepted = committedActions();
  $('event-feed').replaceChildren();
  $('feed-empty').hidden = accepted.length > 0;
  for (const record of accepted.slice(-80).reverse()) {
    const actor = state.bundle.inputs.actors.find((item) => item.id === record.actorId);
    const item = node('li');
    item.append(button(actor?.label || record.actorId, () => inspectActor(record.actorId), 'reference-button'), node('span', ` · ${record.action?.type || 'Accepted action'}`), node('span', `Simulated · ${scenarioLabel(record.scenarioId)} · cycle ${record.round} · validated & committed`, 'caption'));
    $('event-feed').append(item);
  }
  if (run.error) {
    $('feed-empty').hidden = false;
    $('feed-empty').textContent = `Run issue: ${readable(run.error)}. Only committed rounds are shown. Missing responses are not fabricated.`;
  } else $('feed-empty').textContent = 'Validated actions will appear after a whole shopping cycle is committed.';
}

function renderProgress() {
  if (!state.run || !state.bundle) return;
  const definition = state.bundle.definition;
  const events = [...state.events.values()].sort((a, b) => a.sequence - b.sequence);
  const committed = committedActions().length;
  const planned = state.bundle.inputs.actors.length * definition.scenarios.length * definition.horizon.steps;
  const statusByAction = new Map();
  let attempts = 0;
  let current = null;
  for (const event of events) {
    const data = event.data || {};
    if (event.scenarioId || data.scenarioId) current = { scenarioId: event.scenarioId || data.scenarioId, round: data.round };
    const key = `${event.scenarioId || data.scenarioId || ''}:${data.round ?? ''}:${data.actorId || ''}`;
    const type = event.type;
    if (type === 'attempt_started') attempts += 1;
    if (data.actorId) {
      if (type === 'actor_retrying') statusByAction.set(key, 'retrying');
      else if (type === 'actor_failed') statusByAction.set(key, 'failed');
      else if (type === 'actor_cancelled') statusByAction.set(key, 'cancelled');
      else if (type === 'actor_completed' && data.validated === true) statusByAction.set(key, 'completed');
      else if (type === 'actor_started' || type === 'attempt_started') statusByAction.set(key, 'running');
    }
  }
  const counts = { pending: 0, running: 0, completed: 0, retrying: 0, failed: 0, cancelled: 0 };
  for (const status of statusByAction.values()) counts[status] += 1;
  counts.completed = Math.max(counts.completed, committed);
  counts.pending = Math.max(0, planned - Object.entries(counts).filter(([key]) => key !== 'pending').reduce((total, [, count]) => total + count, 0));
  if (state.run.status === 'cancelled') {
    counts.cancelled += counts.pending + counts.running + counts.retrying;
    counts.pending = 0;
    counts.running = 0;
    counts.retrying = 0;
  } else if (TERMINAL.has(state.run.status)) {
    counts.pending += counts.running + counts.retrying;
    counts.running = 0;
    counts.retrying = 0;
  }
  for (const element of document.querySelectorAll('[data-actor-status]')) {
    const key = `${current?.scenarioId || ''}:${current?.round ?? ''}:${element.dataset.actorStatus}`;
    let status = statusByAction.get(key) || (state.run.status === 'cancelled' ? 'cancelled' : 'pending');
    if (TERMINAL.has(state.run.status) && ['running', 'retrying', 'pending'].includes(status)) {
      status = state.run.status === 'cancelled' ? 'cancelled' : `not completed (${state.run.status})`;
    }
    element.textContent = current ? `${status} · ${scenarioLabel(current.scenarioId)}${current.round == null ? '' : ` · cycle ${current.round}`}` : 'pending · waiting for scenario';
  }
  $('progress-label').textContent = `${counts.completed} / ${planned} validated actions`;
  $('run-progress').max = planned || 1;
  $('run-progress').value = counts.completed;
  $('current-cycle').textContent = current ? `${scenarioLabel(current.scenarioId)}${current.round == null ? '' : ` · cycle ${current.round} of ${definition.horizon.steps}`}` : 'Waiting for first scenario';
  $('status-counts').replaceChildren();
  for (const [status, count] of Object.entries(counts)) {
    const item = node('span', null, 'status-count');
    item.append(node('strong', count), node('span', status === 'completed' ? 'completed (validated)' : status === 'pending' ? 'pending / not completed' : status));
    $('status-counts').append(item);
  }
  $('run-budget').textContent = `${committed} actions committed to metrics. ${attempts} observed started attempts / ${definition.runConfig.attemptCap} hard budget · ${definition.runConfig.concurrency} concurrent calls · ${definition.runConfig.deadlineMs / 60000}-minute deadline. Counts reflect saved events; validated but uncommitted actions do not enter metrics.`;
}

function canCreateBrief() {
  if (state.run?.status !== 'completed' || !state.run.comparison || !state.run.results?.length) return false;
  const results = state.run.results;
  return results.length === state.bundle?.definition.scenarios.length &&
    results.every((result) => result.complete && result.comparisonKey) &&
    new Set(results.map((result) => result.comparisonKey)).size === 1 &&
    state.run.comparison.status !== 'incomplete';
}

function metricValue(metric, value = metric?.value, signed = false) {
  if (!metric || value === null || value === undefined || !Number.isFinite(Number(value))) return 'Unavailable';
  const number = Number(value);
  let result;
  if (MONEY_METRICS.has(metric.metricId) || metric.unit === 'USD_cents') result = dollars(number);
  else if (metric.unit === 'percent' || metric.unit === '%') result = `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  else result = `${number.toLocaleString(undefined, { maximumFractionDigits: 4 })}${metric.unit && !['count', 'actions', 'orders', 'items'].includes(metric.unit) ? ` ${metric.unit}` : ''}`;
  return signed && number > 0 ? `+${result}` : result;
}

function renderComparison() {
  if (!state.run || !state.bundle) return;
  const run = state.run;
  const { definition } = state.bundle;
  const comparison = run.comparison;
  const allComparable = canCreateBrief();
  const best = allComparable && comparison?.status === 'complete'
    ? comparison.rows?.find((row) => row.scenarioId === comparison.bestScenarioId && row.eligible && row.complete)
    : null;
  let verdict = 'Incomplete — these are committed interim totals, not a ranking or recommendation.';
  if (allComparable) {
    if (best) verdict = `${best.label || scenarioLabel(best.scenarioId)} is best in this simulation on the declared objective and guardrails. Validate the hypothesis with a real pilot.`;
    else if (comparison.status === 'trade_off') verdict = 'Trade-off — the completed simulation does not establish a single option that meets every decision requirement.';
    else if (comparison.status === 'more_information_needed') verdict = 'More information needed — the cycles are complete, but missing inputs or unknown costs prevent a supported recommendation.';
    else verdict = 'Complete comparison — no eligible winner is identified. Review the trade-offs and declared constraints.';
  }
  $('comparison-verdict').textContent = state.replay ? `Verified exact replay (no model calls). ${verdict}` : verdict;
  $('comparison-subtitle').textContent = `${definition.title} · version ${definition.version} · ${definition.horizon.steps} shopping cycles · one run per option · ${run.runId}`;
  $('comparison-warnings').replaceChildren();
  if (comparison?.warnings?.length) {
    const warning = node('div', null, 'notice warning');
    list(comparison.warnings, warning);
    $('comparison-warnings').append(warning);
  }
  const table = $('comparison-table');
  const head = table.querySelector('thead');
  const body = table.querySelector('tbody');
  head.replaceChildren();
  body.replaceChildren();
  const header = node('tr');
  const metricHeading = node('th', 'Outcome');
  metricHeading.scope = 'col';
  header.append(metricHeading);
  for (const scenario of definition.scenarios) {
    const th = node('th', scenario.label);
    th.scope = 'col';
    th.append(node('small', scenario.isBaseline ? 'Baseline · freshly simulated' : 'Alternative · paired conditions'));
    th.append(node('small', `${dollars(scenario.policy.thresholdCents)} threshold · ${dollars(scenario.policy.shippingFeeCents)} fee`));
    const result = run.results?.find((item) => item.scenarioId === scenario.scenarioId);
    th.append(node('small', `${result?.complete ? 'Complete' : 'Incomplete'} · ${result?.completedRounds || 0}/${definition.horizon.steps} committed cycles`));
    header.append(th);
  }
  head.append(header);
  for (const [metricId, label] of METRICS) {
    const row = node('tr', null, metricId === definition.objective.metricId ? 'objective-row' : '');
    const title = node('th', label);
    title.scope = 'row';
    title.append(node('small', metricId));
    row.append(title);
    for (const scenario of definition.scenarios) {
      const comparisonRow = comparison?.rows?.find((item) => item.scenarioId === scenario.scenarioId);
      const result = run.results?.find((item) => item.scenarioId === scenario.scenarioId);
      const metric = result?.metrics?.find((item) => item.metricId === metricId) || comparisonRow?.metrics?.find((item) => item.metricId === metricId);
      const cell = node('td');
      if (metric) {
        const linked = button(metricValue(metric), () => inspectMetric(scenario.scenarioId, metricId), 'metric-link');
        linked.setAttribute('aria-label', `${scenario.label}: ${label}, ${metricValue(metric)}. Inspect contributing ledger events.`);
        cell.append(linked);
        cell.append(node('small', `Denominator: ${typeof metric.denominator === 'object' ? JSON.stringify(metric.denominator) : readable(metric.denominator)}`));
        if (metric.value == null) cell.append(node('small', `Missing coverage: ${readable(metric.missingCoverage)}`));
        if (!scenario.isBaseline) {
          const delta = comparisonRow?.deltas?.[metricId];
          cell.append(node('span', allComparable && delta != null ? `${metricValue(metric, delta, true)} vs baseline` : 'Δ unavailable until comparable', 'delta'));
        }
        if (!result?.complete) cell.append(node('small', 'Incomplete · not ranked'));
      } else cell.append(node('span', 'Not yet available', 'caption'));
      row.append(cell);
    }
    body.append(row);
  }
  const guardrails = node('tr');
  const guardHeading = node('th', 'Guardrails & eligibility');
  guardHeading.scope = 'row';
  guardrails.append(guardHeading);
  for (const scenario of definition.scenarios) {
    const cell = node('td');
    const row = comparison?.rows?.find((item) => item.scenarioId === scenario.scenarioId);
    cell.append(node('strong', !allComparable ? 'Not assessed as a ranking' : row?.eligible ? 'Eligible under declared guards' : 'Not eligible / unresolved'));
    if (row?.constraintResults?.length) {
      for (const guard of row.constraintResults) cell.append(node('small', readable(guard)));
    } else cell.append(node('small', 'No evaluated guardrail result supplied.'));
    guardrails.append(cell);
  }
  body.append(guardrails);
  renderTiming();
  updateControls();
}

function openDialog(id) {
  if (!$(id).open) $(id).showModal();
}

function addReferences(parent, evidenceIds = [], assumptionIds = [], bundle = state.bundle) {
  const refs = node('div', null, 'reference-list');
  for (const evidenceId of evidenceIds) refs.append(button(`Evidence · ${evidenceId}`, () => inspectEvidence(evidenceId, bundle.definition), 'reference-button'));
  for (const assumptionId of assumptionIds) refs.append(button(`Assumption · ${assumptionId}`, () => inspectAssumption(assumptionId, bundle), 'reference-button'));
  if (!evidenceIds.length && !assumptionIds.length) refs.append(node('span', 'No supporting reference supplied; do not treat as verified evidence.', 'caption'));
  parent.append(refs);
}

async function inspectEvidence(evidenceId, definition) {
  $('evidence-heading').textContent = `Evidence · ${evidenceId}`;
  $('evidence-content').replaceChildren(node('p', `Looking up the exact saved context: ${definition.experimentId}, version ${definition.version}…`, 'hint'));
  openDialog('evidence-dialog');
  const record = await api(`/api/evidence/${encodeURIComponent(evidenceId)}?experimentId=${encodeURIComponent(definition.experimentId)}&version=${encodeURIComponent(definition.version)}`);
  $('evidence-content').replaceChildren(
    node('p', `Source reference for experiment ${definition.experimentId}, version ${definition.version}. AdventureWorks records are sample data.`, 'hint'),
    pretty(record),
  );
}

function inspectAssumption(assumptionId, bundle = state.bundle) {
  const assumption = bundle.inputs.assumptions.find((item) => item.assumptionId === assumptionId || item.id === assumptionId);
  $('evidence-heading').textContent = `Assumption · ${assumptionId}`;
  $('evidence-content').replaceChildren(
    node('p', 'Declared scenario assumption, not an observed source fact. It is frozen for this experiment version.', 'hint'),
    node('p', `${bundle.definition.experimentId} · version ${bundle.definition.version}`, 'caption'),
    assumption ? pretty(assumption) : node('p', 'This reference is missing from the saved assumption set. Treat its support as unavailable.', 'notice warning'),
  );
  openDialog('evidence-dialog');
}

function inspectMetric(scenarioId, metricId) {
  activeStage = 'review';
  const result = state.run.results.find((item) => item.scenarioId === scenarioId);
  const metric = result?.metrics.find((item) => item.metricId === metricId);
  if (!metric) throw new Error('This metric has not been committed.');
  $('detail-heading').textContent = `${scenarioLabel(scenarioId)} · ${METRICS.find(([id]) => id === metricId)?.[1] || metricId}`;
  const content = $('detail-content');
  content.replaceChildren(
    node('p', result.complete ? 'Calculated from accepted, committed simulated events.' : 'Incomplete metric: only committed cycles contribute. Do not use it as a ranking.', 'notice neutral-notice'),
    keyValues([
      ['Metric ID', metric.metricId], ['Value', metricValue(metric)], ['Unit', metric.unit],
      ['Basis', metric.basis], ['Denominator', metric.denominator],
      ['Formula version', metric.formulaVersion], ['Horizon', metric.horizon],
      ['Missing coverage', metric.missingCoverage],
    ]),
  );
  const metricDefinition = state.bundle.definition.metricDefinitions.find((item) => item.metricId === metricId);
  if (metricDefinition) {
    const details = node('details', null, 'inline-details');
    details.append(node('summary', 'Stored metric definition'), pretty(metricDefinition));
    content.append(details);
  }
  const section = node('section', null, 'inspector-section');
  section.append(node('h3', 'Contributing ledger events'));
  const ids = metric.contributingEventIds || [];
  if (!ids.length) section.append(node('p', 'No contributing events. This may be a zero count, an unknown cost or an incomplete outcome; inspect coverage above.', 'hint'));
  for (const eventId of ids) {
    const event = (result.ledgerEvents || []).find((item) => item.eventId === eventId);
    const details = node('details', null, 'inline-details');
    details.append(node('summary', eventId), event ? pretty(event) : node('p', 'Referenced event unavailable in this saved result.', 'notice warning'));
    if (event?.actorId) details.append(button('Inspect contributing actor', () => inspectActor(event.actorId), 'reference-button'));
    section.append(details);
  }
  content.append(section);
  const assumptions = node('section', null, 'inspector-section');
  assumptions.append(node('h3', 'Frozen assumptions behind the calculation'));
  addReferences(assumptions, [], state.bundle.definition.assumptionIds);
  content.append(assumptions);
  openDialog('detail-dialog');
}

function inspectorSection(title, hint) {
  const section = node('section', null, 'inspector-section');
  section.append(node('h3', title));
  if (hint) section.append(node('p', hint, 'hint'));
  $('detail-content').append(section);
  return section;
}

function inspectActor(actorId) {
  activeStage = 'review';
  const bundle = state.bundle;
  const actor = bundle.inputs.actors.find((item) => item.id === actorId);
  if (!actor) throw new Error('This actor is not part of the selected frozen panel.');
  $('detail-heading').textContent = actor.label;
  $('detail-content').replaceChildren(node('p', `${actor.role} · ${actor.profileMode} · sample record with simulated behavior`, 'badge neutral'));
  const context = inspectorSection('Context', `Evidence is resolved in version ${bundle.definition.version}. Source snapshot date: ${bundle.inputs.snapshot.asOf || 'not supplied'}. Facts are not a validated model of a real person.`);
  context.append(keyValues([['Actor', actor.id], ['Source entities', actor.sourceEntityIds], ['Feasible actions', actor.feasibleActions]]));
  for (const fact of actor.facts || []) {
    const row = node('div', null, 'evidence-fact');
    row.append(node('p', `${fact.field}: ${readable(fact.value)}${fact.unit ? ` ${fact.unit}` : ''}`));
    addReferences(row, fact.evidenceIds || [], fact.assumptionIds || [], bundle);
    context.append(row);
  }
  context.append(node('h4', 'Known unknowns'));
  if (actor.unknowns?.length) list(actor.unknowns, context);
  else context.append(node('p', 'No explicit unknowns recorded; that is not proof of complete knowledge.', 'hint'));
  const records = committedActions().filter((record) => record.actorId === actorId);
  const saw = inspectorSection('What they saw', 'Only this actor’s saved observation for each decision — not other actors’ private contexts.');
  const did = inspectorSection('What they did', 'Accepted, schema-validated actions and their committed event records.');
  const why = inspectorSection('Why the model chose this', 'Short generated justification, not a real person’s thoughts and not proof of the model’s internal reasoning.');
  if (!records.length) {
    for (const section of [saw, did, why]) section.append(node('p', 'No accepted action has been committed for this actor yet. Pending or failed output is not treated as behavior.', 'hint'));
  }
  for (const record of records) {
    const title = `${scenarioLabel(record.scenarioId)} · cycle ${record.round}`;
    const observation = node('details', null, 'inline-details');
    observation.append(node('summary', title), record.observation ? pretty(record.observation) : node('p', 'Observation not available in this record.', 'hint'));
    saw.append(observation);
    const action = node('div', null, 'evidence-fact');
    action.append(node('strong', title), pretty({ type: record.action?.type, parameters: record.action?.parameters }));
    const result = state.run.results.find((item) => item.scenarioId === record.scenarioId);
    const ledger = result?.ledgerEvents || [];
    const eventIndex = new Map(ledger.map((event) => [event.eventId, event]));
    const events = Array.isArray(record.eventIds)
      ? record.eventIds.map((eventId) => eventIndex.get(eventId)).filter(Boolean)
      : ledger.filter((event) => event.actorId === actorId && event.round === record.round);
    if (Array.isArray(record.eventIds) && events.length !== record.eventIds.length) {
      action.append(node('p', 'Some referenced ledger events are unavailable in this saved result; the action trace is incomplete.', 'notice warning'));
    }
    if (events.length) {
      const details = node('details', null, 'inline-details');
      details.append(node('summary', `${events.length} related ledger events`));
      for (const event of events) details.append(pretty(event));
      action.append(details);
    }
    const provenance = node('details', null, 'inline-details');
    provenance.append(node('summary', 'Saved action provenance'), keyValues([
      ['Call ID', record.callId],
      ['Previous-state hash', record.previousStateHash],
      ['Resulting-state hash', record.stateHash],
      ['Contributing event IDs', record.eventIds],
    ]));
    action.append(provenance);
    did.append(action);
    const explanation = node('div', null, 'evidence-fact');
    explanation.append(node('strong', title), node('p', record.action?.explanation || 'No generated justification supplied.'));
    addReferences(explanation, record.action?.evidenceIds || [], record.action?.assumptionIds || [], bundle);
    why.append(explanation);
  }
  openDialog('detail-dialog');
}

async function showHistory() {
  $('history-list').replaceChildren(node('p', 'Loading saved experiments…', 'hint'));
  openDialog('history-dialog');
  const { experiments } = await api('/api/experiments');
  $('history-list').replaceChildren();
  if (!experiments?.length) $('history-list').append(node('p', 'No saved experiments yet. Prepare and save a reviewed version to begin.', 'empty-copy'));
  for (const experiment of experiments || []) {
    const item = node('article', null, 'history-item');
    item.append(node('h3', experiment.title), node('p', `${experiment.experimentId} · latest version ${experiment.version} · updated ${dateTime(experiment.updatedAt)}`, 'caption'));
    const actions = node('div', null, 'button-row');
    actions.append(button('Load latest version', () => loadExperiment(experiment.experimentId, experiment.version)));
    actions.append(button('Choose an older version', async () => {
      const saved = await api(`/api/experiments/${encodeURIComponent(experiment.experimentId)}`);
      const label = node('label', 'Saved version');
      const select = node('select');
      for (const version of saved.versions || []) {
        const option = node('option', `Version ${version.version} · ${dateTime(version.createdAt)}`);
        option.value = version.version;
        select.append(option);
      }
      label.append(select);
      actions.replaceChildren(label, button('Load selected version', () => loadExperiment(experiment.experimentId, Number(select.value))));
    }, 'button subtle'));
    item.append(actions);
    for (const run of experiment.runs || []) {
      const entry = node('div', null, 'history-run');
      const info = node('span', `Version ${run.version} · ${run.status} `);
      info.append(node('code', run.runId));
      entry.append(info, button('View saved run', async () => {
        await flushTiming();
        await loadRun(run.runId, TERMINAL.has(run.status) ? 'compare-section' : 'run-section');
        $('history-dialog').close();
        notify('Loaded the saved run. No new inference was started.');
      }));
      item.append(entry);
    }
    $('history-list').append(item);
  }
}

async function loadExperiment(experimentId, version) {
  await flushTiming();
  const bundle = await api(`/api/experiments/${encodeURIComponent(experimentId)}?version=${encodeURIComponent(version)}`);
  disconnectViewer();
  state.run = null;
  state.events.clear();
  state.bundle = bundle;
  state.saved = true;
  state.dirty = false;
  state.replay = false;
  state.sample = false;
  renderBundle();
  hideBrief();
  showSection('prepare-section');
  $('history-dialog').close();
  notify(`Loaded immutable version ${bundle.definition.version}. Verify its model before starting a new run, or open an existing run in History.`);
}

function openRevision() {
  if (!state.saved) return;
  state.revisionOptions = state.bundle.definition.scenarios.filter((scenario) => !scenario.isBaseline).map(policyFromScenario);
  $('revision-text').value = state.bundle.definition.decisionText;
  $('revision-confirm').checked = false;
  $('revision-parent').textContent = `Parent: ${state.bundle.definition.experimentId} · version ${state.bundle.definition.version}. All frozen comparison inputs remain unchanged.`;
  renderRevision();
  openDialog('revision-dialog');
}

function renderRevision() {
  $('revision-options').replaceChildren();
  for (const policy of state.revisionOptions) {
    const card = node('article', null, 'policy-card');
    card.append(node('h4', policy.label));
    const edit = (key) => (value) => { policy[key] = value; $('revision-confirm').checked = false; renderRevisionDiff(); };
    policyField(card, 'Free-shipping threshold ($)', policy.threshold, edit('threshold'), { editable: false });
    policyField(card, 'Fee below threshold ($)', policy.fee, edit('fee'), { editable: false });
    policyField(card, 'Existing-customer threshold ($, optional)', policy.existingThreshold, edit('existingThreshold'), { nullable: true, editable: false });
    $('revision-options').append(card);
  }
  renderRevisionDiff();
}

function revisionChanges() {
  return state.revisionOptions.flatMap((option) => {
    const before = state.bundle.definition.scenarios.find((scenario) => scenario.scenarioId === option.scenarioId).policy;
    const after = readPolicy(option);
    return ['thresholdCents', 'shippingFeeCents', 'existingCustomerThresholdCents'].filter((key) => (before[key] ?? null) !== after[key]).map((key) => ({ option: option.label, field: key, before: before[key] ?? null, after: after[key] }));
  });
}

function renderRevisionDiff() {
  const target = $('revision-diff');
  target.replaceChildren();
  try {
    const changes = revisionChanges();
    if (!changes.length) target.append(node('p', 'No policy changes. Edit a threshold or fee to create a meaningful policy revision.'));
    else {
      const ul = node('ul');
      for (const change of changes) {
        const amount = (value) => value === null ? 'null (no override)' : `${value} cents (${dollars(value)})`;
        ul.append(node('li', `${change.option} · ${change.field}: ${amount(change.before)} → ${amount(change.after)}`));
      }
      target.append(ul);
    }
    $('save-revision').disabled = !changes.length;
    if (state.revisionOptions.some((option) => option.existingThreshold !== '')) target.append(node('p', 'Eligibility warning: if all sample customers are existing customers, an old-threshold override may make the policy equivalent to baseline for this panel. It does not create a prospective-customer cohort.', 'hint'));
  } catch (error) {
    target.append(node('p', error.message));
    $('save-revision').disabled = true;
  }
}

async function saveRevision() {
  if (!$('revision-form').reportValidity() || !$('revision-confirm').checked) return;
  if (!revisionChanges().length) throw new Error('Change at least one policy field before saving a revision.');
  await busy(async () => {
    $('save-revision').disabled = true;
    try {
      await flushTiming('review');
      const { experimentId, version } = state.bundle.definition;
      const bundle = await api(`/api/experiments/${encodeURIComponent(experimentId)}/branches`, {
        version, decisionText: $('revision-text').value.trim() || state.bundle.definition.decisionText,
        options: state.revisionOptions.map(readPolicy),
      });
      disconnectViewer();
      state.bundle = bundle;
      state.saved = true;
      state.dirty = false;
      state.run = null;
      state.events.clear();
      state.replay = false;
      renderBundle();
      hideBrief();
      $('revision-dialog').close();
      showSection('prepare-section');
      notify(`Revision saved as version ${bundle.definition.version}, from parent version ${version}. Nothing has run. Start explicitly to freshly simulate the baseline and revised options under preserved conditions.`);
    } finally { $('save-revision').disabled = false; }
  });
}

async function replayRun() {
  if (!state.run) return;
  await busy(async () => {
    const replay = await api(`/api/runs/${encodeURIComponent(state.run.runId)}/replay`, {});
    if (replay.mode !== 'replay' || replay.verified !== true) throw new Error('Replay was not verified. The saved results have not been replaced.');
    state.replay = true;
    state.run.results = replay.results;
    state.run.comparison = replay.comparison;
    renderRun();
    renderComparison();
    notify('Exact saved replay verified against committed records. No model calls were made; this is not fresh inference.');
  });
}

function briefStorageKey() {
  return `copilot-simulations.brief.${state.run?.runId}`;
}

function hideBrief() {
  $('brief-editor').hidden = true;
  $('brief-markdown').value = '';
  $('brief-status').textContent = '';
}

function loadLocalBrief() {
  hideBrief();
  const saved = readLocal(briefStorageKey());
  if (saved?.markdown && canCreateBrief()) {
    $('brief-markdown').value = saved.markdown;
    $('brief-editor').hidden = false;
    $('brief-status').textContent = `Browser-saved draft · last edited ${dateTime(saved.editedAt)}. Verify edits against stored metrics.`;
  }
}

async function createBrief() {
  if (!canCreateBrief()) throw new Error('A brief requires all scenarios to be complete and comparable.');
  if (!$('brief-editor').hidden && !window.confirm('Replace the current browser-edited brief with a newly generated server brief? Download any edits you want to keep first.')) return;
  await busy(async () => {
    await flushTiming('review');
    const brief = await api(`/api/runs/${encodeURIComponent(state.run.runId)}/brief`, {});
    $('brief-markdown').value = brief.markdown;
    $('brief-editor').hidden = false;
    $('brief-status').textContent = `Generated ${dateTime(brief.generatedAt)} · references ${(brief.metricIds || []).join(', ')}`;
    writeLocal(briefStorageKey(), { markdown: brief.markdown, editedAt: new Date().toISOString() });
    activeStage = 'export';
    $('brief-markdown').focus();
    notify('Brief created from saved metrics. Edit the Markdown and download a copy for review; edits are not executed as HTML.');
  });
}

async function downloadBrief() {
  if (!$('brief-markdown').value.trim()) throw new Error('Create a brief before exporting.');
  activeStage = 'export';
  const text = $('brief-markdown').value;
  writeLocal(briefStorageKey(), { markdown: text, editedAt: new Date().toISOString() });
  const timingRecorded = await flushTiming('export', true);
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = node('a');
  anchor.href = url;
  anchor.download = `simulation-brief-${state.bundle.definition.experimentId.replace(/[^a-zA-Z0-9_-]/g, '-')}-v${state.bundle.definition.version}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $('brief-status').textContent = `Markdown downloaded ${new Date().toLocaleTimeString()} · ${timingRecorded ? 'export timing recorded' : 'timing not yet confirmed'}. Browser-edited copy retained for this run.`;
}

function tickTiming() {
  const now = performance.now();
  const elapsed = Math.min(now - lastTimingTick, 2000);
  if (activeStage && !state.busy && !document.hidden && document.hasFocus() && now - lastInteraction < 30000) activeTime[activeStage] += elapsed;
  lastTimingTick = now;
}

async function flushTiming(stage, recordZero = false, keepalive = false) {
  tickTiming();
  if (!state.saved || !state.bundle) return false;
  let recorded = true;
  const experimentId = state.bundle.definition.experimentId;
  const stages = stage ? [stage] : ['editing', 'review', 'export'];
  for (const name of stages) {
    const durationMs = Math.round(activeTime[name]);
    if (!durationMs && !recordZero) continue;
    activeTime[name] = 0;
    try {
      await api(`/api/experiments/${encodeURIComponent(experimentId)}/timing`, { stage: name, durationMs }, { keepalive });
    } catch (error) {
      recorded = false;
      activeTime[name] += durationMs;
      if (!keepalive) notify(`Work is saved, but ${name} timing could not be recorded: ${error.message}. It will be retried; no time-saving claim is made.`);
    }
  }
  return recorded;
}

function renderTiming() {
  let target = $('workflow-timing');
  if (!target) {
    target = node('section', null, 'card pad');
    target.id = 'workflow-timing';
    $('compare-section').append(target);
  }
  target.replaceChildren(node('h3', 'Measured workflow time, not claimed time savings'));
  target.append(node('p', 'Active time is a best-effort browser interaction estimate: visible, focused windows within 30 seconds of activity. Inference waiting is excluded. Elapsed timestamps are not active work, and neither establishes hours saved without a manual baseline.', 'hint'));
  const timing = state.run?.timing || [];
  const recordedActive = (stage) => {
    const records = timing.filter((item) => item.stage === stage && Number.isFinite(item.durationMs));
    return records.length ? `${(records.reduce((total, item) => total + item.durationMs, 0) / 1000).toFixed(1)} seconds` : 'Not yet recorded';
  };
  const finished = timing.find((item) => item.stage === 'run_completed');
  const elapsed = Number.isFinite(finished?.elapsedMs) ? `${(finished.elapsedMs / 1000).toFixed(1)} seconds` : 'No completed-run duration';
  target.append(keyValues([
    ['Run elapsed execution', elapsed],
    ['Recorded active editing', recordedActive('editing')],
    ['Recorded active review', recordedActive('review')],
    ['Recorded active brief / export work', recordedActive('export')],
  ]));
  target.append(node('p', 'Recorded active durations are experiment-family totals across versions and browser sessions. They are not this run’s elapsed inference duration.', 'caption'));
  if (timing.length) {
    const details = node('details', null, 'inline-details');
    details.append(node('summary', 'Recorded editing, review, export & execution timing'), pretty(timing));
    target.append(details);
  } else target.append(node('p', 'No timing records returned yet. Editing, review and export durations are recorded when you save or complete those stages.', 'caption'));
  target.append(keyValues([
    ['Recorded run provenance', state.run?.manifest?.createdAt || 'Inspect the manifest below for server timestamps'],
    ['Unflushed active editing', `${Math.round(activeTime.editing / 1000)} seconds`],
    ['Unflushed active review', `${Math.round(activeTime.review / 1000)} seconds`],
    ['Unflushed active brief work', `${Math.round(activeTime.export / 1000)} seconds`],
  ]));
  const manifest = node('details', null, 'inline-details');
  manifest.append(node('summary', 'Saved run manifest & model provenance'), pretty(state.run?.manifest));
  target.append(manifest);
}

async function newExperiment() {
  if (state.bundle && !state.saved && !window.confirm('Discard this unsaved draft and prepare a new experiment?')) return;
  await flushTiming();
  disconnectViewer();
  state.bundle = null;
  state.saved = false;
  state.dirty = false;
  state.policies = [];
  state.assumptionValues = {};
  state.otherConstraints = [];
  state.run = null;
  state.events.clear();
  state.replay = false;
  state.sample = false;
  state.provider = null;
  for (const stage of Object.keys(activeTime)) activeTime[stage] = 0;
  $('experiment-form').reset();
  $('provider-status').className = 'provider-status';
  $('provider-status').textContent = 'No model verified. Preparation does not start a simulation.';
  $('draft-review').hidden = true;
  $('policy-options').replaceChildren();
  $('assumption-inputs').replaceChildren();
  document.body.classList.remove('has-draft');
  hideBrief();
  showSection('prepare-section');
  updateControls();
  notify('New draft. Any existing run continues on the server; use History to return to it. No new model calls have started.');
  $('decision-text').focus();
}

function wireEvents() {
  $('experiment-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void safely(prepareDraft);
  });
  $('experiment-form').addEventListener('input', (event) => {
    if (!event.target.matches('[data-draft]')) return;
    if (event.target.id === 'decision-text') state.sample = false;
    if (event.target.id === 'model-id') {
      state.provider = null;
      $('provider-status').className = 'provider-status';
      $('provider-status').textContent = 'Model configuration changed. Verify this explicit ID; no fallback will be used.';
    }
    markDirty();
  });
  $('sample-button').addEventListener('click', () => {
    $('decision-text').value = SAMPLE;
    $('experiment-title').value = 'AdventureWorks shipping-policy review';
    state.sample = true;
    if (state.bundle) {
      state.policies = [
        { label: 'Baseline', isBaseline: true, threshold: '50.00', fee: '7.95', existingThreshold: '' },
        { label: '$75 threshold', isBaseline: false, threshold: '75.00', fee: '7.95', existingThreshold: '' },
        { label: '$100 threshold', isBaseline: false, threshold: '100.00', fee: '7.95', existingThreshold: '' },
      ];
      renderPolicies();
    }
    markDirty();
    $('decision-text').focus();
  });
  $('reprepare-button').addEventListener('click', () => void safely(prepareDraft));
  $('preflight-button').addEventListener('click', () => void safely(verifyProvider));
  $('save-button').addEventListener('click', () => void safely(saveDraft));
  $('start-button').addEventListener('click', () => void safely(startRun));
  $('cancel-button').addEventListener('click', () => void safely(cancelRun));
  $('history-button').addEventListener('click', () => void safely(showHistory));
  $('new-experiment').addEventListener('click', () => void safely(newExperiment));
  $('review-confirm').addEventListener('change', updateControls);
  $('add-option').addEventListener('click', () => {
    if (state.saved || state.policies.filter((item) => !item.isBaseline).length >= 2) return;
    const baseline = state.policies.find((policy) => policy.isBaseline);
    state.policies.push({ label: 'New option', isBaseline: false, threshold: baseline.threshold, fee: baseline.fee, existingThreshold: '' });
    renderPolicies();
    markDirty();
  });
  document.querySelectorAll('[data-section]').forEach((element) => element.addEventListener('click', () => showSection(element.dataset.section)));
  $('view-comparison').addEventListener('click', () => showSection('compare-section'));
  $('reconnect-button').addEventListener('click', () => void safely(async () => { await refreshSnapshot(); connectStream(); }));
  document.querySelectorAll('[data-close]').forEach((element) => element.addEventListener('click', () => element.closest('dialog').close()));
  $('revision-button').addEventListener('click', () => void safely(openRevision));
  $('revision-form').addEventListener('submit', (event) => { event.preventDefault(); void safely(saveRevision); });
  $('revision-text').addEventListener('input', () => { $('revision-confirm').checked = false; });
  $('revision-example').addEventListener('click', () => {
    const first = state.revisionOptions[0];
    if (!first) return;
    first.threshold = '75.00';
    first.fee = '3.95';
    first.existingThreshold = '';
    $('revision-text').value = 'Use a $75 threshold, with a $3.95 shipping fee below it. Keep other options and every shared starting condition unchanged.';
    $('revision-confirm').checked = false;
    renderRevision();
  });
  $('replay-button').addEventListener('click', () => void safely(replayRun));
  $('brief-button').addEventListener('click', () => void safely(createBrief));
  $('download-brief').addEventListener('click', () => void safely(downloadBrief));
  $('brief-markdown').addEventListener('input', () => {
    activeStage = 'export';
    const saved = writeLocal(briefStorageKey(), { markdown: $('brief-markdown').value, editedAt: new Date().toISOString() });
    $('brief-status').textContent = saved ? 'Edited draft saved in this browser. Numeric edits are not automatically verified.' : 'Browser save failed. Download your edits before leaving; numeric edits are not automatically verified.';
  });
  for (const type of ['pointerdown', 'keydown', 'input']) document.addEventListener(type, () => { lastInteraction = performance.now(); }, { passive: true });
  setInterval(tickTiming, 1000);
  setInterval(() => { if (state.saved) void flushTiming(); }, 30000);
  document.addEventListener('visibilitychange', () => {
    tickTiming();
    if (document.hidden) void flushTiming(undefined, false, true);
    else lastTimingTick = performance.now();
  });
  window.addEventListener('pagehide', () => {
    persistCursor();
    void flushTiming(undefined, false, true);
    state.eventSource?.close();
  });
}

async function initialize() {
  wireEvents();
  updateControls();
  const selected = readLocal(SELECTED_RUN_KEY);
  if (selected?.runId) {
    notify('Restoring the selected saved run. Reconnecting only; no fresh inference.');
    try {
      await loadRun(selected.runId);
      notify('Saved run restored. Refresh does not start a new simulation.');
    } catch (error) {
      reportError(new Error(`Could not restore the saved run: ${error.message} Use History or reconnect when the server is available. No new inference was started.`));
    }
  }
}

void initialize().catch(reportError);
