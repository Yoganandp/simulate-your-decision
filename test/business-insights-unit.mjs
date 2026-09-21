import assert from 'node:assert/strict';
import test from 'node:test';
import { businessInsights, employeeGroup, stakeholderGroup } from '../web/business-insights.js';
import { prepareSyntheticFixture } from '../src/sim/domain-definition.mjs';
import { initialScenarioState, executeRound, calculateMetrics, compareScenarios, replayScenario, stableHash } from '../src/sim/domain.mjs';
import { validateRunConfig } from '../src/sim/runManager.mjs';
import { createBrief } from '../src/sim/brief.mjs';
import { seededOrder } from '../src/sim/domain-common.mjs';

const bundle = () => prepareSyntheticFixture({
  customerCount: 1, employeeCount: 1, supplierCount: 1, resellerCount: 1,
  options: [{ label: 'Option B', thresholdCents: 7500 }], runConfig: { model: 'synthetic-test-only' },
});

test('workforce display groups come from titles and departments, not invented roles', () => {
  assert.equal(employeeGroup('Chief Executive Officer', 'Executive'), 'leadership');
  assert.equal(employeeGroup('Production Supervisor', 'Production'), 'management');
  assert.equal(employeeGroup('Buyer', 'Purchasing'), 'frontline');
  assert.equal(stakeholderGroup({ role: 'employee', facts: [] }), 'frontline');
  assert.equal(stakeholderGroup({ role: 'supplier' }), 'supplier');
});

test('pending results stay unknown, never zero-valued fake outcomes', () => {
  const model = businessInsights(bundle());
  assert.ok(model.scenarios.every(scenario => Object.values(scenario.values).every(item => item.value === null && !item.available)));
  assert.ok(model.scenarios.every(scenario => scenario.rounds.every(round => !round.saved && round.contribution === null)));
  assert.ok(model.scenarios.every(scenario => scenario.groups.every(group => group.committed === 0)));
  assert.equal(model.population, null);
});

test('business impacts use committed events, distinct people, and actual arrivals only', () => {
  const input = bundle(), scenarioId = input.definition.scenarios[0].scenarioId;
  const event = (type, id, fields = {}) => ({ type, eventId: id, scenarioId, round: 1, actorId: 'customer-001', ...fields });
  const purchase = id => event('purchase', id, {
    productRevenueCents: 6000, shippingRevenueCents: 0, costOfGoodsSoldCents: 2000, shippingCostCents: 500,
  });
  const ledgerEvents = [event('opportunity', 'o1'), event('opportunity', 'o2'), purchase('p1'), purchase('p2'),
    event('purchase', 'resale', { ...purchase('resale'), actorId: 'reseller-1', productRevenueCents: 3000 }),
    event('capacity_scheduled', 'labor', { actorId: 'employee-1', laborMinutes: 30, additionalOrders: 2, incrementalLaborCostCents: 1200, arrivalRound: 2 }),
    event('replenishment_scheduled', 'supply', { actorId: 'supplier-1', quantity: 6, arrivalRound: 2 }),
    event('capacity_unavailable', 'blocked'),
    event('replenishment_arrived', 'future-arrival', { actorId: 'supplier-1', quantity: 6, round: 2 })];
  const result = { scenarioId, completedRounds: 1, complete: false, actions: [], ledgerEvents };
  const before = JSON.stringify(result);
  const model = businessInsights(input, [result]).scenarios[0];
  assert.equal(model.values.customerOrders.value, 2);
  assert.equal(model.values.customerReach.value, 1);
  assert.equal(model.values.conversion.value, 1);
  assert.equal(model.values.resellerOrders.value, 1);
  assert.equal(model.values.resellerRevenue.value, 3000);
  assert.equal(model.values.laborMinutes.value, 30);
  assert.equal(model.values.capacityApplied.value, 0);
  assert.equal(model.values.capacityBlocked.value, 1);
  assert.equal(model.values.unitsDispatched.value, 6);
  assert.equal(model.values.unitsArrived.value, 0);
  assert.equal(model.rounds[0].contribution, 6300);
  assert.equal(model.rounds[1].contribution, null);
  assert.deepEqual(model.values.unitsDispatched.eventIds, ['supply']);
  assert.equal(JSON.stringify(result), before);
});

test('missing money and undefined rates remain unknown, even with completed rounds', () => {
  const input = bundle(), scenarioId = input.definition.scenarios[0].scenarioId;
  const result = { scenarioId, completedRounds: 1, ledgerEvents: [
    { type: 'purchase', round: 1, eventId: 'purchase', actorId: 'customer-001',
      productRevenueCents: 6000, shippingRevenueCents: 0, shippingCostCents: null, costOfGoodsSoldCents: 2000 },
  ], metrics: [{ metricId: 'contribution', value: null, contributingEventIds: ['purchase'] }] };
  const model = businessInsights(input, [result]).scenarios[0];
  assert.equal(model.values.contribution.value, null);
  assert.equal(model.values.conversion.value, null);
  assert.equal(model.rounds[0].contribution, null);
  assert.equal(model.values.customerOrders.value, 1);
});

test('precomputed seeded ranks preserve the exact historical ordering', () => {
  const values = Array.from({ length: 200 }, (_, index) => ({ id: `record-${index}` }));
  const expected = [...values].sort((a, b) => stableHash(['test-seed', a.id]).localeCompare(stableHash(['test-seed', b.id])));
  assert.deepEqual(seededOrder(values, 'test-seed'), expected);
});

test('63-actor arithmetic-only panel completes 378 choices and supports replay and business brief', async () => {
  const input = prepareSyntheticFixture({
    customerCount: 32, employeeCount: 22, supplierCount: 5, resellerCount: 4,
    options: [{ label: 'Option B', thresholdCents: 7500 }],
    runConfig: { provider: 'copilot', model: 'synthetic-test-only', concurrency: 2, attemptCap: 757, deadlineMs: 7200000 },
  }, { preset: 'conversational-shipping-v1' });
  assert.equal(input.inputs.actors.length, 63);
  assert.equal(input.estimate.plannedActions, 378);
  assert.doesNotThrow(() => validateRunConfig(input.definition, input.inputs));
  const unsafe = structuredClone(input.definition);
  unsafe.runConfig.concurrency = 3;
  assert.throws(() => validateRunConfig(unsafe, input.inputs), /two concurrent/);
  const results = [];
  let decisions = 0;
  for (const scenario of input.definition.scenarios) {
    let state = initialScenarioState(input.definition, input.inputs, scenario);
    const actions = [], rounds = [];
    for (let round = 1; round <= 3; round++) {
      const result = await executeRound({ definition: input.definition, inputs: input.inputs, scenario, state, round,
        decide: async () => {
          decisions++;
          return { action: { type: 'no_action', parameters: {}, explanation: 'Synthetic arithmetic fixture. No inference.',
            evidenceIds: [], assumptionIds: [] } };
        } });
      state = result.state; actions.push(...result.actions);
      rounds.push({ round, actions: result.actions, events: result.events, stateHash: stableHash(state) });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4 * 1024 * 1024);
    }
    const replay = await replayScenario({ definition: input.definition, inputs: input.inputs, scenario, rounds });
    assert.equal(stableHash(replay.state), stableHash(state));
    results.push({ scenarioId: scenario.scenarioId, complete: true, completedRounds: 3,
      comparisonKey: input.definition.comparisonKey, actions, ledgerEvents: state.ledgerEvents,
      metrics: calculateMetrics({ definition: input.definition, inputs: input.inputs, scenario, state, complete: true }) });
  }
  assert.equal(decisions, 378);
  const insights = businessInsights(input, results);
  assert.ok(insights.scenarios.every(scenario => scenario.groups.every(group => group.committed === group.planned && group.changed === 0)));
  const brief = createBrief({ runId: 'arithmetic-test', status: 'completed', manifest: input, results,
    comparison: compareScenarios(input.definition, results) });
  assert.match(brief.markdown, /Business perspectives/);
  assert.match(brief.markdown, /Satisfaction, morale and churn are not modeled/);
  assert.ok(brief.markdown.split(/\s+/).length <= 800);
});

test('the expanded brief still supports three-option advanced comparisons within its word budget', async () => {
  const input = prepareSyntheticFixture({ customerCount: 1, employeeCount: 0, supplierCount: 0, resellerCount: 0, cycles: 1,
    constraints: [{ metricId: 'purchases', comparator: '>=', threshold: 0, severity: 'warning' }] });
  const results = [];
  for (const scenario of input.definition.scenarios) {
    const round = await executeRound({ definition: input.definition, inputs: input.inputs, scenario,
      state: initialScenarioState(input.definition, input.inputs, scenario), round: 1,
      decide: async () => ({ action: { type: 'no_action', parameters: {}, explanation: 'Synthetic fixture only.', evidenceIds: [], assumptionIds: [] } }) });
    results.push({ scenarioId: scenario.scenarioId, completedRounds: 1, complete: true,
      comparisonKey: input.definition.comparisonKey, actions: round.actions, ledgerEvents: round.events,
      metrics: calculateMetrics({ definition: input.definition, inputs: input.inputs, scenario, state: round.state, complete: true }) });
  }
  const brief = createBrief({ runId: 'three-option-fixture', status: 'completed', manifest: input, results,
    comparison: compareScenarios(input.definition, results) });
  assert.ok(brief.markdown.split(/\s+/).length <= 800);
  assert.match(brief.markdown, /Declared guardrails/);
});
