import { createPeopleGraph } from './people-graph.js';
import { BUSINESS_SECTIONS, businessInsights, businessHighlights } from './business-insights.js';

const $ = (id) => document.getElementById(id);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'paused']);
const SELECTION_KEY = 'copilot-conversation.selection.v1';
const START_KEY = 'copilot-conversation.pending-start.v1';
const METRIC_NAMES = {
  contribution: 'simulated panel contribution', purchases: 'fulfilled purchases',
  abandonmentRate: 'abandonment rate', stockouts: 'stockouts', productRevenue: 'product revenue',
};
const state = {
  bundle: null, run: null, events: new Map(), cursor: 0, busy: false,
  stream: null, poll: null, timer: null, epoch: 0, refreshing: null,
  pending: readLocal(START_KEY), view: 'people', expanded: false,
};
let sessionToken;
let tokenRequest;
let restoreFocus;
let cardPlaceholder;
let previousScroll = 0;
let outcomeKey = '';
const inertElements = new Map();
const graph = createPeopleGraph($('people-graph'), { onInspect: inspectActor });

function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text != null) result.textContent = String(text);
  if (className) result.className = className;
  return result;
}

function actionButton(text, action, className = 'button secondary') {
  const result = element('button', text, className);
  result.type = 'button';
  result.addEventListener('click', () => void safely(action));
  return result;
}

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}

function writeLocal(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    notice('Browser storage is unavailable. Your comparisons are saved on the server; use Recent simulations after refreshing.');
  }
}

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function reportError(error) {
  const message = error?.message || String(error);
  $('error').textContent = message;
  $('error').hidden = false;
  if (state.expanded) $('simulation-progress').textContent = message;
}

async function safely(action) {
  $('error').hidden = true;
  try { return await action(); }
  catch (error) { reportError(error); }
}

async function working(action) {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  try { return await action(); }
  finally { state.busy = false; updateControls(); }
}

async function api(path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) {
    if (!sessionToken) {
      tokenRequest ||= fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' })
        .then(async (response) => {
          if (!response.ok) throw new Error('Could not connect to the local app. Refresh and try again.');
          const data = await response.json();
          if (!data.token) throw new Error('The local app did not provide a session token.');
          return data.token;
        }).finally(() => { tokenRequest = null; });
      sessionToken = await tokenRequest;
    }
    headers['X-Simulation-Token'] = sessionToken;
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', headers,
    credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error('The server response could not be read. If starting a simulation, use Retry start to recover the same request.'); }
  if (!response.ok) {
    if (response.status === 403) sessionToken = null;
    const error = new Error(typeof data.error === 'string' ? data.error : data.error?.message || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function money(cents) {
  return Number.isFinite(cents)
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(cents / 100)
    : 'Not available';
}

function titleCase(value) {
  return String(value).replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase());
}

function activeRun() { return Boolean(state.run && !TERMINAL.has(state.run.status)); }

function isComplete() {
  const results = state.run?.results || [];
  return state.run?.status === 'completed' && state.run.comparison &&
    state.run.comparison.status !== 'incomplete' &&
    results.length === state.bundle?.definition.scenarios.length &&
    results.every((result) => result.complete && result.comparisonKey) &&
    new Set(results.map((result) => result.comparisonKey)).size === 1;
}

function updateControls() {
  const running = activeRun();
  $('send-button').disabled = state.busy || running || Boolean(state.pending);
  $('message-input').disabled = state.busy || running || Boolean(state.pending);
  $('new-conversation').disabled = state.busy || running || Boolean(state.pending);
  $('history-button').disabled = state.busy;
  $('run-button').hidden = Boolean(state.run) && !state.pending;
  $('run-button').disabled = state.busy || !state.bundle;
  $('run-button').textContent = state.busy ? 'Connecting to Copilot...' : state.pending ? 'Retry start' : 'Run simulation';
  $('cancel-button').hidden = !running;
  $('cancel-button').disabled = state.busy || state.run?.status === 'cancelling';
  $('cancel-button').textContent = state.run?.status === 'cancelling' ? 'Stopping...' : 'Stop simulation';
  $('replay-button').hidden = !state.run;
  $('export-button').hidden = !state.run;
  $('replay-button').disabled = state.busy || !isComplete();
  $('export-button').disabled = state.busy || !isComplete();
  $('composer-hint').textContent = running
    ? 'Your simulation is running. Explore the people, or stop it to compare something new.'
    : state.pending ? 'Recover the pending simulation with Retry start before starting another comparison.'
      : state.bundle ? 'Describe a new pair of options to start another comparison.'
        : 'Describe both options. I will handle the setup.';
}

function showConversation(text) {
  document.body.classList.add('has-conversation');
  $('welcome').hidden = true;
  $('messages').hidden = false;
  $('user-message').textContent = text;
}

function assistant(text, linked = false) {
  $('assistant-message').replaceChildren(element('span', text));
  if (linked) {
    const link = element('a', 'Explore the simulation', 'chat-link');
    link.href = '#simulation-card';
    link.addEventListener('click', (event) => {
      event.preventDefault();
      $('simulation-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('expand-simulation').focus({ preventScroll: true });
    });
    $('assistant-message').append(document.createTextNode(' '), link);
  }
}

async function sendMessage() {
  const text = $('message-input').value.trim();
  if (!text || !$('conversation-form').reportValidity()) return;
  if (activeRun()) throw new Error('Stop the current simulation before starting a new comparison.');
  if (state.pending) throw new Error('Use Retry start to recover the pending simulation first.');
  await working(async () => {
    disconnect();
    setExpanded(false);
    state.run = null;
    state.bundle = null;
    state.events.clear();
    writeLocal(SELECTION_KEY, null);
    $('simulation-card').hidden = true;
    $('preparing').hidden = false;
    showConversation(text);
    assistant('I am setting up a fair comparison, using the same people and starting conditions for both options.');
    notice('');
    try {
      const prepared = await api('/api/experiments/conversation', { decisionText: text });
      const saved = await api('/api/experiments', { definition: prepared.definition, inputs: prepared.inputs });
      state.bundle = { ...saved, conversation: prepared.conversation };
      writeLocal(SELECTION_KEY, { experimentId: saved.definition.experimentId, version: saved.definition.version });
      renderBundle();
      assistant(`I've brought together ${saved.inputs.actors.length} sampled business stakeholders for both options: customers, leadership, managers, frontline staff and partners. Explore their perspectives and the operating assumptions first. Nothing runs until you start it.`, true);
      $('message-input').value = '';
      selectView('people');
      $('simulation-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
      assistant('I could not set up this comparison. Nothing has started. This preview compares shipping thresholds and fees.');
      throw error;
    } finally { $('preparing').hidden = true; }
  });
}

function renderBundle() {
  const { definition, inputs } = state.bundle;
  showConversation(definition.decisionText);
  $('simulation-card').hidden = false;
  $('simulation-title').textContent = definition.scenarios.length === 2
    ? 'Two options. A business of perspectives.' : 'Your options. A business of perspectives.';
  const planned = inputs.actors.length * definition.scenarios.length * definition.horizon.steps;
  $('runtime-plan').textContent = `${planned} planned actor calls · maximum ${definition.runConfig.concurrency} at a time · ${definition.horizon.steps} rounds per option. `
    + `${definition.runConfig.attemptCap} total attempts including repairs; ${Math.round(definition.runConfig.deadlineMs / 60000)}-minute hard stop, not an ETA. Starts only on request.`
    + (planned >= 300 && definition.runConfig.concurrency <= 2 ? ' This full panel can take an hour or more. Recent simulations opens saved work without new model calls.' : '');
  $('simulation-options').replaceChildren();
  definition.scenarios.forEach((scenario, index) => {
    const card = element('article', null, 'option-card');
    const copy = element('div');
    copy.append(element('strong', scenario.policy.thresholdCents === 0 ? 'Free shipping on every order' : `Free shipping over ${money(scenario.policy.thresholdCents)}`, 'option-policy'));
    copy.append(element('p', scenario.policy.thresholdCents === 0 ? 'No shipping fee' : `${money(scenario.policy.shippingFeeCents)} below the threshold`, 'option-fee'));
    card.append(element('span', String.fromCharCode(65 + index), 'option-letter'), copy);
    card.setAttribute('aria-label', `${scenario.label}: ${copy.textContent}`);
    $('simulation-options').append(card);
  });
  const source = inputs.snapshot.sourceType === 'synthetic_test_fixture' ? 'Synthetic test fixtures' : 'AdventureWorks sample business data';
  $('assumptions-summary').textContent = `${inputs.actors.length} sample stakeholders, ${definition.horizon.steps} shopping rounds, identical starting conditions. ${source}; not a validated prediction.`;
  const list = $('assumptions-list');
  list.replaceChildren();
  for (const item of state.bundle.conversation?.assumptions || []) list.append(element('li', item));
  if (!list.childElementCount) {
    list.append(element('li', 'These are saved scenario assumptions, not measured operating facts. Both options use the same frozen inputs.'));
    for (const key of ['fulfillmentCostPerOrderCents', 'incrementalLaborRateCentsPerHour']) {
      const item = inputs.assumptions.find((value) => value.key === key);
      if (item) list.append(element('li', `${key === 'fulfillmentCostPerOrderCents' ? 'Fulfillment per order' : 'Incremental labor per hour'}: ${money(item.value)} (scenario assumption).`));
    }
  }
  const provenance = $('provenance-details');
  provenance.replaceChildren();
  const details = element('details');
  details.append(element('summary', 'All assumptions and model provenance'));
  for (const item of inputs.assumptions) {
    const section = element('p', null, 'source-note');
    section.append(element('strong', `${titleCase(item.key || item.assumptionId)}: `));
    section.append(document.createTextNode(`${typeof item.value === 'object' ? JSON.stringify(item.value) : item.value ?? 'Unknown'}. ${item.description || item.rationale || ''}`));
    details.append(section);
  }
  details.append(element('p', `Requested model: ${definition.runConfig.model} via GitHub Copilot SDK. A successful request is not independent proof of model identity.`, 'source-note'));
  details.append(element('p', `Saved comparison: ${definition.experimentId}, version ${definition.version}. Source snapshot: ${inputs.snapshot.snapshotId}.`, 'source-note'));
  const advanced = element('a', 'Open the detailed workbench', 'chat-link');
  advanced.href = '/advanced';
  details.append(advanced);
  provenance.append(details);
  updateGraph();
  renderRun();
}

async function startRun() {
  if (!state.bundle || (state.run && !state.pending)) return;
  await working(async () => {
    if (state.pending && (state.run || state.bundle.definition.experimentId !== state.pending.experimentId)) {
      await loadExperiment(state.pending.experimentId, state.pending.version);
    }
    if (state.pending?.runId) {
      await loadRun(state.pending.runId);
      return;
    }
    const { experimentId, version } = state.bundle.definition;
    if (!state.pending) {
      state.pending = { experimentId, version, idempotencyKey: crypto.randomUUID() };
      writeLocal(START_KEY, state.pending);
    }
    if (state.pending.experimentId !== experimentId || state.pending.version !== version) {
      throw new Error('A different comparison has an unresolved start. Refresh to recover that comparison first.');
    }
    $('simulation-progress').textContent = 'Connecting to your Copilot session. This can take a moment...';
    const started = await api(`/api/experiments/${encodeURIComponent(experimentId)}/runs`, { version, idempotencyKey: state.pending.idempotencyKey });
    writeLocal(SELECTION_KEY, { runId: started.runId });
    state.pending = { ...state.pending, runId: started.runId };
    writeLocal(START_KEY, state.pending);
    await loadRun(started.runId);
    assistant('The simulation is running. Hover over a person to see their choices, switch between options, or open the full-screen view.', true);
  });
}

function disconnect() {
  state.epoch++;
  state.stream?.close();
  state.stream = null;
  clearInterval(state.poll);
  clearTimeout(state.timer);
  state.poll = null;
  state.timer = null;
  state.refreshing = null;
}

function ingest(snapshot) {
  for (const event of snapshot.events || []) {
    if (event.runId === snapshot.runId && Number.isInteger(event.sequence)) {
      state.events.set(event.sequence, event);
      state.cursor = Math.max(state.cursor, event.sequence);
    }
  }
}

async function reconcilePending(run) {
  const pending = state.pending;
  if (!pending || run.manifest.experimentId !== pending.experimentId || run.manifest.version !== pending.version) return;
  // Match the server's canonical hash without submitting another start from a history read.
  const data = new TextEncoder().encode(JSON.stringify({
    experimentId: pending.experimentId, idempotencyKey: pending.idempotencyKey,
  }));
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (state.pending === pending && (pending.runId === run.runId || run.manifest.idempotencyKeyHash === hash)) {
    state.pending = null;
    writeLocal(START_KEY, null);
  }
}

async function loadRun(runId) {
  disconnect();
  const epoch = state.epoch;
  const run = await api(`/api/runs/${encodeURIComponent(runId)}`);
  if (epoch !== state.epoch) return;
  const bundle = await api(`/api/experiments/${encodeURIComponent(run.manifest.experimentId)}?version=${run.manifest.version}`);
  if (epoch !== state.epoch) return;
  await reconcilePending(run);
  if (epoch !== state.epoch) return;
  state.bundle = bundle;
  state.run = run;
  state.events.clear();
  state.cursor = 0;
  ingest(run);
  writeLocal(SELECTION_KEY, { runId });
  renderBundle();
  selectView('people');
  if (activeRun()) connect();
  else assistant('Here is your saved comparison. Explore each round and the people behind the results. Opening it does not run the model again.', true);
  updateControls();
}

async function loadExperiment(experimentId, version) {
  disconnect();
  const bundle = await api(`/api/experiments/${encodeURIComponent(experimentId)}?version=${version}`);
  state.bundle = bundle;
  state.run = null;
  state.events.clear();
  state.cursor = 0;
  renderBundle();
  selectView('people');
  assistant('Your comparison is ready, with its saved assumptions and sample panel. Run it when you are ready.', true);
  writeLocal(SELECTION_KEY, { experimentId, version });
  updateControls();
}

function connect() {
  if (!activeRun()) return;
  state.stream?.close();
  clearInterval(state.poll);
  state.poll = null;
  const epoch = state.epoch;
  const runId = state.run.runId;
  const stream = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${state.cursor}`);
  state.stream = stream;
  stream.addEventListener('open', () => {
    if (epoch !== state.epoch) return;
    $('reconnect-button').hidden = true;
    renderRun();
  });
  stream.addEventListener('simulation', (message) => {
    if (epoch !== state.epoch) return;
    let event;
    try { event = JSON.parse(message.data); }
    catch {
      connectionIssue(new Error('A live update could not be read. Recovering saved progress.'));
      scheduleRefresh();
      return;
    }
    if (event.runId !== runId || !Number.isInteger(event.sequence) || event.sequence <= state.cursor) return;
    state.events.set(event.sequence, event);
    state.cursor = event.sequence;
    updateGraph();
    renderProgress();
    scheduleRefresh();
  });
  stream.addEventListener('error', () => {
    if (epoch !== state.epoch) return;
    stream.close();
    state.stream = null;
    connectionIssue(new Error('Live connection interrupted. The simulation continues; checking saved progress.'));
    clearInterval(state.poll);
    state.poll = setInterval(() => void refresh().catch(connectionIssue), 5000);
    void refresh().catch(connectionIssue);
  });
}

function connectionIssue(error) {
  $('simulation-progress').textContent = error.message;
  $('reconnect-button').hidden = false;
}

function scheduleRefresh() {
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void refresh().catch(connectionIssue);
  }, 400);
}

async function refresh() {
  if (!state.run) return;
  if (state.refreshing) return state.refreshing;
  const epoch = state.epoch;
  const runId = state.run.runId;
  let snapshotSequence = 0;
  const request = (async () => {
    const snapshot = await api(`/api/runs/${encodeURIComponent(runId)}`);
    if (epoch !== state.epoch || state.run?.runId !== runId) return;
    snapshotSequence = Math.max(0, ...(snapshot.events || []).map((event) => event.sequence));
    const wasActive = activeRun();
    state.run = snapshot;
    ingest(snapshot);
    renderRun();
    if (!activeRun()) {
      state.stream?.close();
      state.stream = null;
      clearInterval(state.poll);
      state.poll = null;
      $('reconnect-button').hidden = true;
      if (wasActive) assistant(snapshot.status === 'completed'
        ? 'Your comparison is ready. See the outcomes, then hover over people to understand the choices behind them.'
        : `The simulation ${snapshot.status}. The rounds that finished are still available; incomplete results are not ranked.`, true);
    }
    updateControls();
  })();
  state.refreshing = request;
  try { await request; }
  finally {
    if (state.refreshing === request) state.refreshing = null;
    if (epoch === state.epoch && snapshotSequence > 0 && snapshotSequence < state.cursor) scheduleRefresh();
  }
}

function updateGraph() {
  if (state.bundle) graph.update({ bundle: state.bundle, run: state.run, events: [...state.events.values()] });
}

function renderProgress() {
  if (!state.bundle) return;
  const { definition } = state.bundle;
  const results = state.run?.results || [];
  const rounds = results.reduce((sum, result) => sum + result.completedRounds, 0);
  const totalRounds = definition.scenarios.length * definition.horizon.steps;
  $('simulation-status').textContent = !state.run ? 'Ready to explore' : activeRun() ? state.run.status === 'cancelling' ? 'Stopping' : 'Live simulation' : titleCase(state.run.status);
  $('simulation-status').dataset.status = !state.run ? 'ready' : activeRun() ? 'running' : state.run.status;
  $('simulation-progress').textContent = !state.run
    ? `${state.bundle.inputs.actors.length} people and operational stakeholders. ${definition.horizon.steps} rounds for each option.`
    : state.run.error ? `Simulation stopped: ${typeof state.run.error === 'string' ? state.run.error : state.run.error.message || 'A model response could not be completed.'}`
      : `${rounds} of ${totalRounds} rounds saved${activeRun() ? ' - people are considering their next move' : state.run.status === 'completed' ? ' - explore what changed' : ' - partial results only'}.`;
  const latest = [...state.events.values()].sort((a, b) => b.sequence - a.sequence)
    .find((event) => event.scenarioId && event.data?.round);
  const label = definition.scenarios.find((scenario) => scenario.scenarioId === latest?.scenarioId)?.label;
  $('round-context').textContent = latest
    ? `${activeRun() ? 'Currently simulating' : 'Last activity'}: ${label || latest.scenarioId}, round ${latest.data.round} of ${definition.horizon.steps}.`
    : 'Choose an option, then hover over a person to explore.';
}

function renderRun() {
  renderProgress();
  updateGraph();
  renderOutcomes();
  updateControls();
}

function selectView(view) {
  state.view = view;
  for (const name of ['people', 'results']) {
    $(`${name}-tab`).setAttribute('aria-selected', String(view === name));
    $(`${name}-tab`).tabIndex = view === name ? 0 : -1;
    $(`${name}-view`).hidden = view !== name;
  }
}

function metric(result, name) { return result?.metrics?.find((item) => item.metricId === name); }

function renderOutcomes() {
  if (!state.bundle) return;
  const nextKey = JSON.stringify([state.bundle.definition.experimentId, state.bundle.definition.version,
    state.run?.runId, state.run?.status, state.run?.comparison,
    state.run?.results?.map(result => [result.stateHash, result.completedRounds, result.complete, result.metrics])]);
  if (outcomeKey === nextKey) return;
  outcomeKey = nextKey;
  const comparison = state.run?.comparison;
  const complete = isComplete();
  const objective = state.bundle.definition.objective;
  const objectiveLabel = METRIC_NAMES[objective.metricId] || titleCase(objective.metricId);
  const winner = complete && comparison.status === 'complete'
    ? comparison.rows?.find((row) => row.scenarioId === comparison.bestScenarioId && row.eligible && row.complete)
    : null;
  $('outcome-summary').textContent = !state.run ? 'The outcomes will appear here as rounds finish.'
    : !complete ? 'Still a partial picture. Explore the saved rounds; there is no winner yet.'
      : winner ? `${winner.label} leads on ${objectiveLabel} (${objective.direction === 'minimize' ? 'lower' : 'higher'} is better). Treat this as a hypothesis to pilot, not a forecast.`
        : comparison.status === 'more_information_needed' ? 'The rounds are complete, but missing inputs prevent a supported recommendation.'
          : 'There is no clear winner. Compare the trade-offs before choosing a pilot.';
  $('outcome-summary').dataset.kind = winner ? 'complete' : 'pending';
  $('outcome-cards').replaceChildren();
  for (const scenario of state.bundle.definition.scenarios) {
    const result = state.run?.results?.find((item) => item.scenarioId === scenario.scenarioId);
    const contribution = metric(result, 'contribution');
    const hasContribution = Number.isFinite(contribution?.value);
    const card = element('article', null, 'outcome-card');
    card.append(element('h3', scenario.label));
    const amount = actionButton(hasContribution ? money(contribution.value) : 'Not available', () => inspectMetric(scenario.scenarioId, 'contribution'), 'outcome-value');
    amount.disabled = !hasContribution;
    amount.setAttribute('aria-label', `${scenario.label} simulated contribution: ${hasContribution ? money(contribution.value) : 'not available'}. View supporting events.`);
    card.append(amount, element('p', 'Simulated panel contribution', 'outcome-label'));
    card.append(element('p', `${result?.completedRounds || 0} / ${state.bundle.definition.horizon.steps} rounds${result?.complete ? ' complete' : ' saved - interim'}`, 'source-note'));
    $('outcome-cards').append(card);
  }
  renderBusinessImpact(complete);
  $('outcome-notes').textContent = 'Sample-panel results, not a company forecast. Contribution is not net profit. Sentiment, morale and churn are not modeled.';
}

function formatImpact(value, unit) {
  if (!Number.isFinite(value)) return 'Not available';
  if (unit === 'USD_cents') return money(value);
  if (unit === 'ratio') return `${(value * 100).toFixed(1)}%`;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
}

function renderBusinessImpact(complete) {
  const insights = businessInsights(state.bundle, state.run?.results || []);
  const root = $('business-impact');
  const openSections = new Set([...root.querySelectorAll('details[open]')].map(details => details.dataset.section));
  const focusSection = root.contains(document.activeElement) ? document.activeElement.closest('details')?.dataset.section : null;
  root.replaceChildren();
  const more = (id, title) => {
    const details = element('details', null, 'outcome-details');
    details.dataset.section = id; details.open = openSections.has(id);
    details.append(element('summary', title));
    root.append(details);
    return details;
  };
  root.append(element('p', insights.scenarios.length === 2
    ? `What changes from ${insights.scenarios[0].label} to ${insights.scenarios[1].label}`
    : 'Compare the saved business outcomes', 'business-kpi-heading'));
  const highlights = element('div', null, 'business-kpis');
  for (const item of businessHighlights(insights, complete)) {
    const card = element('article', null, `business-kpi ${item.tone}`);
    card.dataset.metricId = item.id;
    const change = item.delta === null ? 'Not compared yet'
      : `${item.delta > 0 ? '+' : ''}${formatImpact(item.delta, item.unit)}`;
    card.append(element('h3', item.label), element('strong', change, 'business-kpi-change'));
    const values = element('div', null, 'business-kpi-values');
    for (const value of item.values) {
      const button = actionButton(`${value.scenarioLabel}: ${value.available ? formatImpact(value.value, item.unit) : 'Pending'}`,
        () => inspectBusinessOutcome(value.scenarioId, value), 'business-value');
      button.disabled = !value.available || value.value === null;
      button.setAttribute('aria-label', `${value.scenarioLabel}, ${item.label}: ${value.available ? formatImpact(value.value, item.unit) : 'pending'}. Inspect evidence.`);
      values.append(button);
    }
    card.append(values); highlights.append(card);
  }
  root.append(highlights, element('p', complete
    ? 'Changes are B minus A. Colors describe individual metrics, not an overall recommendation. Select a value to see its evidence.'
    : 'Only saved rounds are shown. Differences and a winner stay unavailable until both options finish.', 'business-kpi-note'));
  const moneyDetails = more('money', 'The money and operational trade-offs');
  const roundDetails = more('rounds', 'Round-by-round changes');
  const responseDetails = more('responses', 'Who responded and what they did');
  const sampleDetails = more('sample', 'Sample coverage and modeling limits');
  const coverage = element('section', null, 'business-coverage');
  coverage.append(element('h3', 'Who is in the sample'));
  const groups = element('div', null, 'business-perspectives');
  for (const group of insights.groups) {
    const item = element('div');
    item.append(element('strong', group.count), element('span', group.label));
    groups.append(item);
  }
  coverage.append(groups);
  if (insights.population) {
    const description = Object.entries(insights.population).map(([role, counts]) =>
      `${titleCase(role)}: ${counts.selected} of ${counts.eligible.toLocaleString()} eligible records (${counts.source.toLocaleString()} source rows)`).join(' · ');
    coverage.append(element('p', description, 'source-note'));
  } else coverage.append(element('p', 'This saved snapshot does not record full source-population coverage; no population estimate is inferred.', 'source-note'));
  coverage.append(element('p', 'No population weighting or annualization. Employee job titles organize the view but do not add authority to the shipping model. Satisfaction, morale, churn, overhead and tax are not modeled.', 'source-note'));
  sampleDetails.append(coverage);
  renderRoundTrend(roundDetails, insights);

  const panels = element('div', null, 'business-panels');
  for (const section of BUSINESS_SECTIONS) {
    const panel = element('section', null, 'business-panel');
    panel.append(element('h3', section.title), element('p', section.note, 'source-note'));
    const scroll = element('div', null, 'business-table-scroll'), table = element('table', null, 'business-table');
    const caption = element('caption', section.title, 'sr-only');
    const head = element('thead'), headings = element('tr');
    for (const label of ['Outcome', ...insights.scenarios.map(scenario => scenario.label), ...(insights.scenarios.length === 2 ? ['B − A'] : [])]) {
      const th = element('th', label); th.scope = 'col'; headings.append(th);
    }
    head.append(headings); table.append(caption, head);
    const body = element('tbody');
    for (const [id, label, unit] of section.rows) {
      const tr = element('tr'), name = element('th', label); name.scope = 'row'; tr.append(name);
      for (const scenario of insights.scenarios) {
        const item = scenario.values[id], td = element('td');
        const button = actionButton(item.available ? formatImpact(item.value, unit) : 'Pending',
          () => inspectBusinessOutcome(scenario.scenarioId, item), 'business-value');
        button.disabled = !item.available;
        button.setAttribute('aria-label', `${scenario.label}: ${label}, ${item.available ? formatImpact(item.value, unit) : 'pending'}. Inspect saved evidence.`);
        td.append(button); tr.append(td);
      }
      if (insights.scenarios.length === 2) {
        const [a, b] = insights.scenarios.map(scenario => scenario.values[id].value);
        const delta = complete && Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
        const display = delta === null ? '—' : unit === 'ratio'
          ? `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)} pp`
          : `${delta > 0 ? '+' : ''}${formatImpact(delta, unit)}`;
        tr.append(element('td', display, 'business-delta'));
      }
      body.append(tr);
    }
    table.append(body); scroll.append(table); panel.append(scroll); panels.append(panel);
  }
  moneyDetails.append(panels, element('p', 'B − A compares complete, matched options only. A positive difference is not necessarily an improvement. Click any saved value to inspect its evidence.', 'source-note'));
  const responses = element('section', null, 'business-coverage');
  responses.append(element('h3', 'How each part of the business responded'),
    element('p', 'Action counts, not sentiment scores. “Took an action” includes purchases, deferrals, abandonments and operational choices; it does not mean approval.', 'source-note'));
  const roster = element('div', null, 'business-response-grid');
  for (const group of insights.groups) {
    const item = element('article', null, 'business-response');
    item.append(element('h4', group.label));
    for (const scenario of insights.scenarios) {
      const value = scenario.groups.find(entry => entry.id === group.id);
      item.append(element('p', `${scenario.label}: ${value.committed} / ${value.planned} decisions saved`, 'business-response-title'));
      const progress = element('progress');
      progress.max = value.planned; progress.value = value.committed;
      progress.setAttribute('aria-label', `${scenario.label}, ${group.label}: ${value.committed} of ${value.planned} decisions saved`);
      item.append(progress, element('p', value.committed ? `${value.changed} took an action · ${value.noAction} no action · ${value.blocked} orders blocked` : 'No saved decisions yet.', 'source-note'));
    }
    roster.append(item);
  }
  responses.append(roster); responseDetails.append(responses);
  if (focusSection) root.querySelector(`details[data-section="${CSS.escape(focusSection)}"] > summary`)?.focus({ preventScroll: true });
}

function renderRoundTrend(root, insights) {
  const section = element('section', null, 'business-trend');
  section.append(element('span', 'THE PATH THROUGH THE ROUNDS', 'business-eyebrow'), element('h3', 'Contribution, one shopping cycle at a time'));
  const series = insights.scenarios.map(scenario => ({ label: scenario.label, rounds: scenario.rounds }));
  const values = series.flatMap(item => item.rounds.map(round => round.contribution)).filter(Number.isFinite);
  if (values.length) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 560 150'); svg.setAttribute('class', 'business-trend-chart');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Per-cycle simulated contribution. Exact values and missing rounds are listed below.');
    const low = Math.min(0, ...values), high = Math.max(1, ...values);
    const x = index => 36 + index * (488 / Math.max(1, state.bundle.definition.horizon.steps - 1));
    const y = value => 118 - (value - low) / (high - low) * 96;
    const add = (tag, attributes) => {
      const node = document.createElementNS(svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      svg.append(node); return node;
    };
    add('path', { d: `M28 ${y(0)} H532`, class: 'business-zero' });
    series.forEach((item, index) => {
      let previous = null;
      for (const point of item.rounds) {
        if (point.contribution === null) { previous = null; continue; }
        const position = { x: x(point.round - 1), y: y(point.contribution) };
        if (previous) add('path', { d: `M${previous.x} ${previous.y} L${position.x} ${position.y}`, class: `business-line series-${index}` });
        add('circle', { cx: position.x, cy: position.y, r: 4, class: `business-point series-${index}` });
        previous = position;
      }
    });
    series[0].rounds.forEach(point => { add('text', { x: x(point.round - 1), y: 143, 'text-anchor': 'middle' }).textContent = `Round ${point.round}`; });
    section.append(svg);
  } else section.append(element('p', 'The trajectory appears after a round commits. No projected line or invented outcome.', 'source-note'));
  const legend = element('div', null, 'business-trend-values');
  series.forEach((item, index) => {
    const row = element('p', null, `series-${index}`);
    row.append(element('strong', `${item.label}: `), document.createTextNode(item.rounds.map(point =>
      `R${point.round} ${point.saved ? formatImpact(point.contribution, 'USD_cents') : 'pending'}`).join(' · ')));
    legend.append(row);
  });
  section.append(legend); root.append(section);
}

function inspectBusinessOutcome(scenarioId, item) {
  if (item.metricId) { inspectMetric(scenarioId, item.metricId); return; }
  const result = state.run?.results.find(entry => entry.scenarioId === scenarioId);
  const ids = new Set(item.eventIds);
  const events = (result?.ledgerEvents || []).filter(event => ids.has(event.eventId));
  showDetails(item.label, [
    element('p', formatImpact(item.value, item.unit), 'outcome-value'),
    element('p', `Calculated from committed ${scenarioId} ledger events, through round ${result?.completedRounds || 0}. Unit: ${item.unit}. Not a company-wide estimate.`, 'source-note'),
    ...(events.length ? events.map(event => disclosure(`${titleCase(event.type)} · round ${event.round}`, event))
      : [element('p', 'No matching events in the saved rounds. A zero count is not a forecast; undefined rates and missing amounts remain unavailable.')]),
  ]);
}

async function stopRun() {
  if (!activeRun()) return;
  await working(async () => {
    const result = await api(`/api/runs/${encodeURIComponent(state.run.runId)}/cancel`, {});
    state.run.status = result.status;
    await refresh();
    notice('Simulation stopped. Completed rounds remain saved.');
  });
}

function showDetails(title, children) {
  $('detail-heading').textContent = title;
  $('detail-content').replaceChildren(...children);
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
}

function disclosure(title, value) {
  const details = element('details', null, 'detail-section');
  details.append(element('summary', title), element('pre', JSON.stringify(value, null, 2)));
  return details;
}

function inspectActor(actorId, selected = {}) {
  const actor = state.bundle?.inputs.actors.find((item) => item.id === actorId);
  if (!actor) { reportError(new Error('That person is not in this saved panel.')); return; }
  const sections = [element('p', `${titleCase(actor.role)} - sample record with simulated behavior, not a real person's prediction.`, 'source-note')];
  for (const result of state.run?.results || []) {
    if (selected.scenarioId && result.scenarioId !== selected.scenarioId) continue;
    for (const record of result.actions || []) {
      if (record.actorId !== actorId || (selected.round && record.round !== selected.round)) continue;
      const scenario = state.bundle.definition.scenarios.find((item) => item.scenarioId === result.scenarioId);
      const section = element('section', null, 'detail-section');
      section.append(element('h3', `${scenario.label} - round ${record.round}`), element('strong', titleCase(record.action.type)),
        element('p', record.action.explanation), element('p', 'Generated explanation of a committed simulated choice.', 'source-note'));
      section.append(disclosure('What this person could see', record.observation));
      const events = (result.ledgerEvents || []).filter((event) => record.eventIds?.includes(event.eventId));
      section.append(disclosure('Saved action and its consequences', { action: record.action, events }));
      for (const id of record.action.evidenceIds || []) {
        section.append(actionButton('View supporting source', () => inspectEvidence(id, () => inspectActor(actorId, selected)), 'chat-link'));
      }
      sections.push(section);
    }
  }
  if (sections.length === 1) sections.push(element('p', 'No choice has been committed for this person in the selected round yet.'));
  sections.push(disclosure('Source facts and known unknowns', { facts: actor.facts, unknowns: actor.unknowns }));
  showDetails(actor.label, sections);
}

function inspectMetric(scenarioId, metricId) {
  const result = state.run?.results.find((item) => item.scenarioId === scenarioId);
  const value = metric(result, metricId);
  if (!value) throw new Error('This outcome is not available yet.');
  const scenario = state.bundle.definition.scenarios.find((item) => item.scenarioId === scenarioId);
  const sections = [
    element('p', value.unit === 'USD_cents' ? money(value.value) : String(value.value ?? 'Unknown'), 'outcome-value'),
    element('p', 'Calculated from saved simulated events. Only completed rounds contribute.', 'source-note'),
  ];
  const ids = new Set(value.contributingEventIds || []);
  const events = (result.ledgerEvents || []).filter((event) => ids.has(event.eventId));
  if (!events.length) sections.push(element('p', 'No contributing events. See metric coverage for zero, unknown or incomplete outcomes.'));
  for (const event of events) {
    const actor = state.bundle.inputs.actors.find((item) => item.id === event.actorId);
    const section = element('section', null, 'detail-section');
    section.append(element('h3', `${titleCase(event.type)} - round ${event.round}`));
    if (actor) section.append(actionButton(actor.label, () => inspectActor(actor.id, { scenarioId, round: event.round }), 'chat-link'));
    section.append(disclosure('Recorded event', event));
    sections.push(section);
  }
  sections.push(disclosure('Metric definition and coverage', value));
  showDetails(`${scenario.label} - ${titleCase(metricId.replace(/([A-Z])/g, ' $1'))}`, sections);
}

async function inspectEvidence(id, back) {
  const { experimentId, version } = state.bundle.definition;
  const evidence = await api(`/api/evidence/${encodeURIComponent(id)}?experimentId=${encodeURIComponent(experimentId)}&version=${version}`);
  showDetails('Supporting source', [
    actionButton('Back to person', back, 'chat-link'),
    element('p', 'This is sample business data, not evidence that a real person would act this way.', 'source-note'),
    disclosure('Exact saved source reference', evidence),
  ]);
}

async function replayRun() {
  if (!isComplete()) return;
  await working(async () => {
    const result = await api(`/api/runs/${encodeURIComponent(state.run.runId)}/replay`, {});
    if (result.mode !== 'replay' || result.verified !== true) throw new Error('Saved replay did not match. The original results have been retained.');
    state.run.results = result.results;
    state.run.comparison = result.comparison;
    renderRun();
    notice('Exact saved replay verified. No new model calls.');
  });
}

async function exportBrief() {
  if (!isComplete()) return;
  await working(async () => {
    const brief = await api(`/api/runs/${encodeURIComponent(state.run.runId)}/brief`, {});
    if (typeof brief.markdown !== 'string' || !brief.markdown.trim()) throw new Error('The server did not return a decision brief.');
    const url = URL.createObjectURL(new Blob([brief.markdown], { type: 'text/markdown;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = `simulation-brief-${state.bundle.definition.experimentId}-v${state.bundle.definition.version}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice('Decision brief downloaded with the saved outcomes and supporting references.');
  });
}

async function showHistory() {
  $('history-list').replaceChildren(element('p', 'Loading your saved simulations...'));
  $('history-dialog').showModal();
  const { experiments } = await api('/api/experiments');
  $('history-list').replaceChildren();
  if (!experiments.length) $('history-list').append(element('p', 'Your first comparison will appear here. Start by describing two shipping options.'));
  for (const item of experiments) {
    const article = element('article', null, 'history-item');
    article.append(element('h3', item.title), element('p', `Updated ${new Date(item.updatedAt).toLocaleDateString()}`, 'source-note'));
    const runs = [...(item.runs || [])].reverse();
    for (const run of runs) {
      const row = element('div', null, 'history-run');
      row.append(element('span', `Version ${run.version} - ${titleCase(run.status)}`), actionButton('Open simulation', () => working(async () => {
        await loadRun(run.runId);
        $('history-dialog').close();
      })));
      article.append(row);
    }
    if (!runs.length) article.append(actionButton('Open comparison', () => working(async () => {
      await loadExperiment(item.experimentId, item.version);
      $('history-dialog').close();
    })));
    $('history-list').append(article);
  }
}

function setExpanded(expanded) {
  if (state.expanded === expanded) return;
  const card = $('simulation-card');
  if (expanded) {
    previousScroll = window.scrollY;
    cardPlaceholder = element('div');
    cardPlaceholder.setAttribute('aria-hidden', 'true');
    cardPlaceholder.style.height = `${card.getBoundingClientRect().height}px`;
    cardPlaceholder.style.marginTop = getComputedStyle(card).marginTop;
    card.before(cardPlaceholder);
  }
  state.expanded = expanded;
  card.classList.toggle('is-expanded', expanded);
  document.body.classList.toggle('simulation-expanded', expanded);
  $('expand-simulation').setAttribute('aria-expanded', String(expanded));
  $('expand-simulation').setAttribute('aria-label', expanded ? 'Back to chat' : 'Expand simulation');
  $('expand-simulation').textContent = expanded ? 'Back to chat' : 'Expand';
  if (expanded) {
    restoreFocus = document.activeElement;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    // Inert only siblings along the card's ancestor path, never the card itself.
    for (let child = card; child.parentElement; child = child.parentElement) {
      for (const sibling of child.parentElement.children) {
        if (sibling !== child && sibling.tagName !== 'DIALOG' && !['SCRIPT', 'LINK'].includes(sibling.tagName)) {
          inertElements.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
      if (child.parentElement === document.body) break;
    }
    $('expand-simulation').focus({ preventScroll: true });
  } else {
    card.removeAttribute('role');
    card.removeAttribute('aria-modal');
    for (const [sibling, previous] of inertElements) sibling.inert = previous;
    inertElements.clear();
    cardPlaceholder?.remove();
    cardPlaceholder = null;
    window.scrollTo({ top: previousScroll, behavior: 'instant' });
    if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  }
}

function newConversation() {
  if (activeRun() || state.pending) throw new Error('Finish or recover your current simulation first.');
  disconnect();
  setExpanded(false);
  state.bundle = null;
  state.run = null;
  state.events.clear();
  state.cursor = 0;
  writeLocal(SELECTION_KEY, null);
  document.body.classList.remove('has-conversation');
  $('welcome').hidden = false;
  $('messages').hidden = true;
  $('simulation-card').hidden = true;
  $('message-input').value = '';
  notice('');
  $('error').hidden = true;
  updateControls();
  $('message-input').focus();
}

$('conversation-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void safely(sendMessage);
});
$('message-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('conversation-form').requestSubmit();
  }
});
for (const button of document.querySelectorAll('[data-prompt]')) {
  button.addEventListener('click', () => {
    $('message-input').value = button.dataset.prompt;
    $('message-input').focus();
  });
}
for (const [id, action] of [
  ['run-button', startRun], ['cancel-button', stopRun], ['replay-button', replayRun],
  ['export-button', exportBrief], ['history-button', showHistory], ['new-conversation', newConversation],
  ['reconnect-button', async () => { await refresh(); connect(); }],
]) $(id).addEventListener('click', () => void safely(action));
$('expand-simulation').addEventListener('click', () => setExpanded(!state.expanded));
for (const name of ['people', 'results']) {
  $(`${name}-tab`).addEventListener('click', () => selectView(name));
  $(`${name}-tab`).addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'people' : event.key === 'End' ? 'results' : name === 'people' ? 'results' : 'people';
    selectView(next);
    $(`${next}-tab`).focus();
  });
}
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}
$('sidebar-toggle').addEventListener('click', () => {
  const open = $('sidebar-toggle').getAttribute('aria-expanded') !== 'true';
  $('sidebar-toggle').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('sidebar-open', open);
});
document.addEventListener('click', (event) => {
  if (!document.body.classList.contains('sidebar-open') || event.target.closest('#sidebar-toggle')) return;
  if (!event.target.closest('#sidebar') || event.target.closest('#history-button, #new-conversation')) {
    document.body.classList.remove('sidebar-open');
    $('sidebar-toggle').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
    document.body.classList.remove('sidebar-open');
    $('sidebar-toggle').setAttribute('aria-expanded', 'false');
    $('sidebar-toggle').focus();
  }
  if (!state.expanded || document.querySelector('dialog[open]') || event.defaultPrevented) return;
  if (event.key === 'Escape') { event.preventDefault(); setExpanded(false); return; }
  if (event.key !== 'Tab') return;
  const controls = [...$('simulation-card').querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select, summary, [tabindex="0"]')]
    .filter((control) => control.getClientRects().length && !control.closest('[hidden]'));
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
window.addEventListener('pagehide', () => { disconnect(); graph.destroy(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) window.location.reload(); });

updateControls();
void safely(async () => {
  if (state.pending?.experimentId) {
    await working(async () => {
      await loadExperiment(state.pending.experimentId, state.pending.version);
      if (state.pending?.runId) await loadRun(state.pending.runId);
    });
    if (state.pending) notice('A previous start needs recovery. Retry start uses the same request and will not create a duplicate run.');
    return;
  }
  const selection = readLocal(SELECTION_KEY);
  if (selection?.runId) await working(() => loadRun(selection.runId));
  else if (selection?.experimentId) await working(() => loadExperiment(selection.experimentId, selection.version));
});
