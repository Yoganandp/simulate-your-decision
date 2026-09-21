import assert from 'node:assert/strict';
import { test } from 'node:test';
import { derivePeopleGraphState } from '../web/people-graph.js';

// Test-only records never enter the application or its persisted runtime.
const bundle = {
  definition: { experimentId: 'graph-test', version: 1, horizon: { steps: 3 }, scenarios: [
    { scenarioId: 'baseline', label: 'Baseline', isBaseline: true },
    { scenarioId: 'option-1', label: 'Saved option A' },
    { scenarioId: 'option-2', label: 'Saved option B' },
  ] },
  inputs: { actors: [
    { id: 'customer-1', label: 'Sample customer record 1', role: 'customer' },
    { id: 'employee-1', label: 'Sample employee record 1', role: 'employee' },
  ], graph: { edges: [] } },
};
const event = (sequence, type, data = {}, scenarioId = 'baseline') => ({ sequence, type, data, scenarioId, runId: 'run-test' });
const run = (overrides = {}) => ({ runId: 'run-test', status: 'running', results: [], events: [], ...overrides });
const record = (type = 'no_action', overrides = {}) => ({
  actorId: 'customer-1', scenarioId: 'baseline', round: 1, status: 'accepted',
  action: { type, parameters: {}, explanation: 'Recorded test explanation.' }, ...overrides,
});
const first = value => derivePeopleGraphState({ bundle, ...value }).nodes[0];

test('prepared panel is idle without fabricated actions or activity', () => {
  const node = first({ events: [event(1, 'actor_started', { actorId: 'customer-1', round: 1 })] });
  assert.equal(node.state, 'idle');
  assert.equal(node.statusLabel, 'Ready to simulate');
  assert.equal(node.label, 'Customer 1');
  assert.equal(node.sourceLabel, 'Sample customer record 1');
  assert.equal(node.active, false);
  assert.equal(node.record, null);
  assert.deepEqual(node.facts, []);
});

test('only a persisted active actor event lights up that exact actor', () => {
  const model = derivePeopleGraphState({ bundle, run: run(), events: [
    event(1, 'scenario_started'), event(2, 'actor_started', { actorId: 'customer-1', round: 1 }),
  ] });
  assert.equal(model.nodes[0].active, true);
  assert.equal(model.nodes[0].committed, false);
  assert.equal(model.nodes[1].active, false);
  assert.equal(model.nodes[1].statusLabel, 'Waiting for turn');
  assert.equal(model.active, 1);
});

test('validated actor response is ready, not a committed decision', () => {
  const node = first({ run: run(), events: [
    event(1, 'actor_started', { actorId: 'customer-1', round: 1 }),
    event(2, 'actor_completed', { actorId: 'customer-1', round: 1, validated: true, committed: false }),
  ] });
  assert.equal(node.statusLabel, 'Response ready');
  assert.equal(node.active, false);
  assert.equal(node.committed, false);
  assert.equal(node.explanation, '');
});

test('unvalidated actor completion never becomes a saved response', () => {
  const node = first({ run: run(), events: [event(1, 'actor_completed', { actorId: 'customer-1', round: 1, validated: false })] });
  assert.equal(node.committed, false);
  assert.equal(node.state, 'idle');
});

test('atomic round commit updates ahead of a stale HTTP snapshot', () => {
  const decision = record('add_item');
  const node = first({ run: run(), events: [
    event(1, 'actor_started', { actorId: 'customer-1', round: 1 }),
    event(2, 'round_committed', { round: 1, actions: [decision], events: [
      { eventId: 'purchase-1', type: 'purchase', actorId: 'customer-1', scenarioId: 'baseline', round: 1, totalChargeCents: 8795, items: [{ quantity: 2 }] },
    ] }),
  ] });
  assert.equal(node.statusLabel, 'Added an item');
  assert.equal(node.committed, true);
  assert.equal(node.explanation, decision.action.explanation);
  assert.deepEqual(node.facts, ['$87.95 total charged', '2 items']);
  assert.equal(node.active, false);
});

test('stockout and capacity arbitration never misrepresent an intended purchase as fulfilled', () => {
  for (const type of ['stockout', 'capacity_unavailable']) {
    const node = first({ run: run({ results: [{ scenarioId: 'baseline', actions: [record('purchase')], ledgerEvents: [
      { eventId: type, type, actorId: 'customer-1', round: 1 },
    ] }] }) });
    assert.equal(node.state, 'constrained');
    assert.match(node.statusLabel, /^Not purchased/);
    assert.equal(node.committed, true);
    assert.deepEqual(node.facts, []);
  }
});

test('an accepted purchase without its ledger is a chosen action, not evidence of a charge', () => {
  const node = first({ run: run({ results: [{ scenarioId: 'baseline', actions: [record('purchase')], ledgerEvents: [] }] }) });
  assert.equal(node.statusLabel, 'Purchase chosen');
  assert.deepEqual(node.facts, []);
});

test('no_action remains neutral while deferral and abandonment use actual action labels', () => {
  for (const [type, label] of [['no_action', 'No action'], ['defer', 'Deferred'], ['abandon', 'Left without buying']]) {
    const node = first({ run: run({ results: [{ scenarioId: 'baseline', actions: [record(type)] }] }) });
    assert.equal(node.statusLabel, label);
    assert.equal(node.committed, true);
    if (type === 'no_action') assert.equal(node.state, 'neutral');
  }
});

test('selected scenario and round isolate statuses and committed explanations', () => {
  const value = { run: run({ results: [
    { scenarioId: 'baseline', actions: [record('abandon')] },
    { scenarioId: 'option-1', actions: [record('defer', { scenarioId: 'option-1', round: 2 })] },
  ] }), events: [event(1, 'actor_started', { actorId: 'customer-1', round: 3 }, 'option-2')] };
  assert.equal(first({ ...value, selection: { scenarioId: 'baseline', round: 1 } }).statusLabel, 'Left without buying');
  assert.equal(first({ ...value, selection: { scenarioId: 'option-1', round: 2 } }).statusLabel, 'Deferred');
  const empty = first({ ...value, selection: { scenarioId: 'baseline', round: 3 } });
  assert.equal(empty.committed, false);
  assert.equal(empty.active, false);
  assert.equal(empty.explanation, '');
  assert.equal(first(value).active, true);
});

test('follow cursor uses real round numbers and resets to round one for the next scenario', () => {
  const model = derivePeopleGraphState({ bundle, run: run(), events: [
    event(1, 'round_committed', { round: 3, actions: [], events: [] }),
    event(2, 'scenario_started', {}, 'option-1'),
  ] });
  assert.deepEqual(model.cursor, { scenarioId: 'option-1', round: 1 });
  const next = derivePeopleGraphState({ bundle, run: run(), events: [
    event(1, 'actor_started', { actorId: 'customer-1', round: 2 }, 'option-2'),
    event(2, 'actor_started', { actorId: 'customer-1', round: 99 }, 'option-2'),
  ] });
  assert.deepEqual(next.cursor, { scenarioId: 'option-2', round: 2 });
});

test('stream order is by persisted sequence and duplicate snapshot events do not duplicate decisions', () => {
  const completed = event(3, 'round_committed', { round: 1, actions: [record()], events: [] });
  const model = derivePeopleGraphState({ bundle, run: run({ events: [completed] }), events: [
    completed, event(1, 'actor_started', { actorId: 'customer-1', round: 1 }),
    event(2, 'actor_completed', { actorId: 'customer-1', round: 1, validated: true }),
  ] });
  assert.equal(model.committed, 1);
  assert.equal(model.nodes[0].active, false);
});

test('every terminal or paused state suppresses ghost activity and identifies missing commits', () => {
  for (const status of ['failed', 'cancelled', 'completed', 'interrupted', 'paused']) {
    const node = first({ run: run({ status }), events: [event(1, 'actor_started', { actorId: 'customer-1', round: 1 })] });
    assert.equal(node.active, false, status);
    assert.equal(node.committed, false, status);
    assert.match(node.note, /No decision was committed/, status);
    assert.notEqual(node.state, 'running', status);
  }
});

test('a newer terminal event overrides a still-running HTTP snapshot', () => {
  const start = event(1, 'actor_started', { actorId: 'customer-1', round: 1 });
  const model = derivePeopleGraphState({ bundle, run: run({ events: [start] }), events: [start, event(2, 'run_cancelled')] });
  assert.equal(model.runStatus, 'cancelled');
  assert.equal(model.nodes[0].active, false);
  assert.equal(model.nodes[0].statusLabel, 'Cancelled · not committed');
});

test('old streamed run_started cannot revive a failed HTTP snapshot', () => {
  const model = derivePeopleGraphState({ bundle, run: run({ status: 'failed' }), events: [
    event(1, 'run_started'), event(2, 'actor_started', { actorId: 'customer-1', round: 1 }),
  ] });
  assert.equal(model.runStatus, 'failed');
  assert.equal(model.active, 0);
});

test('a response ready at failure remains explicitly uncommitted', () => {
  const node = first({ run: run({ status: 'failed' }), events: [
    event(1, 'actor_completed', { actorId: 'customer-1', round: 1, validated: true }),
  ] });
  assert.equal(node.statusLabel, 'Response ready · not committed');
  assert.equal(node.committed, false);
  assert.equal(node.active, false);
});

test('cancelled in-flight actors use cancellation even when settlement emits actor_failed', () => {
  const node = first({ run: run({ status: 'cancelled' }), events: [
    event(1, 'actor_failed', { actorId: 'customer-1', round: 1, error: { code: 'CANCELLED', message: 'The run was cancelled.' } }),
  ] });
  assert.equal(node.statusLabel, 'Cancelled · not committed');
  assert.equal(node.state, 'cancelled');
});

test('a paused snapshot accepts a newer persisted cancellation without reviving pending work', () => {
  const paused = event(2, 'run_paused');
  const model = derivePeopleGraphState({ bundle, run: run({ status: 'paused', events: [paused] }), events: [
    event(1, 'actor_started', { actorId: 'customer-1', round: 1 }), event(3, 'run_cancelled'),
  ] });
  assert.equal(model.runStatus, 'cancelled');
  assert.equal(model.active, 0);
});

test('a stale event subset cannot move follow behind newer committed snapshot rounds', () => {
  const model = derivePeopleGraphState({ bundle, run: run({ results: [
    { scenarioId: 'option-2', completedRounds: 3, actions: [] },
  ] }), events: [event(1, 'scenario_started', {}, 'baseline')] });
  assert.deepEqual(model.cursor, { scenarioId: 'option-2', round: 3 });
});

test('missing actor, foreign run, unknown scenario and unsequenced data cannot create people or activity', () => {
  const model = derivePeopleGraphState({ bundle, run: run(), events: [
    event(1, 'actor_started', { actorId: 'missing-actor', round: 1 }),
    { ...event(2, 'actor_started', { actorId: 'customer-1', round: 1 }), runId: 'another-run' },
    event(3, 'actor_started', { actorId: 'customer-1', round: 1 }, 'not-an-option'),
    { type: 'actor_started', data: { actorId: 'customer-1', round: 1 }, scenarioId: 'baseline' },
  ] });
  assert.equal(model.nodes.length, 2);
  assert.equal(model.active, 0);
});

test('snapshot commits survive failed later rounds and update inputs are not mutated', () => {
  const value = { bundle, run: run({ status: 'failed', results: [
    { scenarioId: 'baseline', completedRounds: 1, actions: [record('defer')] },
  ] }), selection: { scenarioId: 'baseline', round: 1 } };
  const before = JSON.stringify(value);
  assert.equal(derivePeopleGraphState(value).nodes[0].statusLabel, 'Deferred');
  assert.equal(JSON.stringify(value), before);
  assert.equal(derivePeopleGraphState({ ...value, selection: { scenarioId: 'baseline', round: 2 } }).nodes[0].committed, false);
});

test('new data replaces waiting state without leaking earlier selections', () => {
  const snapshot = run();
  assert.equal(first({ run: snapshot }).statusLabel, 'Waiting for turn');
  const events = [event(1, 'actor_retrying', { actorId: 'customer-1', round: 1 })];
  assert.equal(first({ run: snapshot, events }).active, true);
  events.push(event(2, 'attempt_failed', { actorId: 'customer-1', round: 1 }));
  assert.equal(first({ run: snapshot, events }).active, false);
  events.push(event(3, 'actor_failed', { actorId: 'customer-1', round: 1 }));
  assert.equal(first({ run: snapshot, events }).statusLabel, 'Response failed');
});

test('manifest bundle fallback works and empty input is safe to import without a browser', () => {
  assert.equal(derivePeopleGraphState({ run: run({ manifest: bundle }) }).nodes.length, 2);
  assert.deepEqual(derivePeopleGraphState().nodes, []);
});

test('a business-sized panel groups titles without inventing active people or decisions', () => {
  const actors = Array.from({ length: 63 }, (_, index) => ({
    id: `person-${index}`, role: index < 32 ? 'customer' : 'employee', label: `Sample record ${index}`,
    facts: index === 32 ? [{ field: 'jobTitle', value: 'Chief Executive Officer' }]
      : index === 33 ? [{ field: 'jobTitle', value: 'Production Manager' }] : [],
  }));
  const large = { ...bundle, inputs: { actors, graph: { edges: [] } } };
  const model = derivePeopleGraphState({ bundle: large, run: run(), events: [
    event(1, 'actor_started', { actorId: 'person-0', round: 1 }),
    event(2, 'actor_started', { actorId: 'person-1', round: 1 }),
  ] });
  assert.equal(model.nodes.length, 63);
  assert.equal(model.active, 2);
  assert.equal(model.committed, 0);
  assert.equal(model.nodes[32].group, 'leadership');
  assert.equal(model.nodes[33].group, 'management');
  assert.equal(model.nodes[34].group, 'frontline');
});

test('source-backed display names retain the sample record identity and have a legacy fallback', () => {
  const named = structuredClone(bundle);
  named.inputs.actors[0].facts = [{ field: 'givenName', value: 'Sample' }, { field: 'familyName', value: 'Customer' }];
  const model = derivePeopleGraphState({ bundle: named });
  assert.equal(model.nodes[0].label, 'Sample Customer');
  assert.equal(model.nodes[0].sourceLabel, 'Sample customer record 1');
  assert.equal(model.nodes[0].actorId, 'customer-1');
  assert.equal(model.nodes[0].record, null);
});
