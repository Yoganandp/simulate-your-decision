import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  prepareExperiment, validateExperiment, initialScenarioState, executeRound, calculateMetrics,
  comparisonKey, compareScenarios, reviseExperiment, replayScenario, stableHash,
} from "../src/sim/domain.mjs";
import { prepareSyntheticFixture } from "../src/sim/domain-definition.mjs";

const action = (type = "no_action", parameters = {}, explanation = "Synthetic recorded choice for arithmetic tests only.") =>
  ({ type, parameters, explanation, evidenceIds: [], assumptionIds: [] });
const fixture = (overrides = {}) => prepareSyntheticFixture({
  customerCount: 2, employeeCount: 1, supplierCount: 1, resellerCount: 1,
  assumptions: { fulfillmentCostPerOrderCents: 500, incrementalLaborRateCentsPerHour: 2400 },
  runConfig: { model: "recorded-arithmetic-test" }, ...overrides,
});
async function run(bundle, scenario, chooser = () => action()) {
  const { definition, inputs } = bundle, rounds = [];
  let state = initialScenarioState(definition, inputs, scenario);
  for (let round = 1; round <= definition.horizon.steps; round++) {
    const result = await executeRound({ definition, inputs, scenario, state, round, decide: async ({ actor, observation, validate }) => {
      const chosen = chooser(actor, observation, round, scenario);
      return { action: validate(chosen), callId: `${actor.id}-${round}`, observationHash: stableHash(observation), metadata: { source: "recorded_synthetic_fixture" } };
    } });
    state = result.state;
    rounds.push({ round, actions: result.actions, events: result.events, stateHash: stableHash(state) });
  }
  return { state, rounds, result: { scenarioId: scenario.scenarioId, complete: true, comparisonKey: comparisonKey(definition, inputs),
    completedRounds: state.completedRounds, stateHash: stableHash(state),
    metrics: calculateMetrics({ definition, inputs, scenario, state, complete: true }), actions: rounds.flatMap(item => item.actions), ledgerEvents: state.ledgerEvents } };
}
const values = result => Object.fromEntries(result.metrics.map(metric => [metric.metricId, metric.value]));
const purchase = (actor, observation) => actor.role === "customer" ? action("purchase", { items: observation.opportunity.basket }) : action();
let passed = 0;
async function test(name, operation) { await operation(); passed++; console.log(`ok ${passed} - ${name}`); }

await test("Stable snapshots, explicit labels, source/assumption links and bounds", () => {
  const first = fixture(), second = fixture();
  assert.equal(first.inputs.snapshot.sourceType, "synthetic_test_fixture");
  assert.equal(stableHash(first.inputs), stableHash(second.inputs));
  assert.equal(first.definition.comparisonKey, second.definition.comparisonKey);
  assert.equal(first.inputs.actors.length, 5);
  assert.equal(first.inputs.graph.edges.length, 0);
  assert.ok(first.inputs.actors.every(actor => actor.profileMode === "synthetic"));
  assert.ok(first.inputs.actors.every(actor => actor.facts.every(fact => fact.evidenceIds.length + fact.assumptionIds.length > 0)));
  assert.equal(first.estimate.plannedActions, 45);
  assert.equal(first.definition.horizon.unit, "shopping_cycle");
  assert.throws(() => fixture({ customerCount: 25 }), /customerCount/);
  assert.throws(() => fixture({ cycles: 4 }), /cycles/);
  assert.throws(() => fixture({ options: [] }), /options/);
  assert.throws(() => fixture({ runConfig: { provider: "stub" } }), /copilot/);
  assert.throws(() => fixture({ runConfig: { attemptCap: 1 } }), /attemptCap/);
  assert.throws(() => fixture({ runConfig: { attemptCap: first.estimate.plannedActions } }), /attemptCap/);
  assert.equal(fixture({ runConfig: { attemptCap: first.estimate.plannedActions + 1 } }).estimate.maxAttempts, first.estimate.plannedActions + 1);
  assert.throws(() => fixture({ assumptions: { fulfillmentCostPerOrderCents: -1 } }), /fulfillmentCost/);
  assert.throws(() => fixture({ assumptions: { hiddenUnknown: 3 } }), /unsupported/);
  assert.throws(() => stableHash({ broken: NaN }), /non-finite/);
  assert.throws(() => stableHash({ missing: undefined }), /object/);
});

await test("Automatic presets carry validated non-user provenance before immutable hashes are created", () => {
  const input = { customerCount: 2, employeeCount: 1, supplierCount: 1, resellerCount: 1,
    options: [{ label: "Option B", thresholdCents: 7500 }], runConfig: { model: "recorded-arithmetic-test" } };
  const preparation = { preset: "conversational-shipping-v1" };
  const bundle = prepareSyntheticFixture(input, preparation);
  const { definition, inputs } = bundle;
  assert.equal(definition.scenarios[0].label, "Option A");
  assert.equal(definition.scenarios.length, 2);
  assert.equal(definition.status, "ready");
  const presets = inputs.assumptions.filter(item => item.source === "preset");
  assert.equal(presets.length, 11);
  assert.ok(presets.every(item => item.owner === "simulation_preset" && item.approvalState === "not_reviewed"
    && item.presetId === preparation.preset && item.rationale.includes("not measured source evidence or a manually reviewed value")));
  assert.ok(inputs.assumptions.every(item => item.source !== "user"));
  assert.equal(presets.find(item => item.key === "fulfillmentCostPerOrderCents").value, 500);
  assert.equal(presets.find(item => item.key === "incrementalLaborRateCentsPerHour").value, 2400);
  assert.equal(presets.find(item => item.key === "panelCapacityPerCycle").value, 3);
  assert.ok(Object.isFrozen(definition) && Object.isFrozen(inputs.assumptions[0]));
  assert.doesNotThrow(() => validateExperiment(definition, inputs));
  const legacy = prepareSyntheticFixture({ ...input, assumptions: { fulfillmentCostPerOrderCents: 500 } });
  assert.equal(legacy.definition.scenarios[0].label, "Baseline");
  assert.equal(legacy.inputs.assumptions.find(item => item.key === "fulfillmentCostPerOrderCents").source, "user");
  assert.equal(legacy.inputs.assumptions.find(item => item.key === "fulfillmentCostPerOrderCents").approvalState, "review_required");
  assert.equal(legacy.inputs.assumptions.find(item => item.key === "incrementalLaborRateCentsPerHour").value, null);
  assert.throws(() => prepareSyntheticFixture(input, { preset: "unrecognized" }), /Unsupported automatic/);
  assert.throws(() => prepareSyntheticFixture(input, { source: "preset" }), /unsupported/);
  assert.throws(() => prepareSyntheticFixture({ ...input, assumptions: {} }, preparation), /cannot be mixed/);
  assert.throws(() => prepareSyntheticFixture({ ...input, preset: preparation.preset }), /unsupported/);
  assert.throws(() => prepareSyntheticFixture({ ...input, options: [...input.options, { thresholdCents: 10000 }] }, preparation), /options/);
  const mutate = (change, message) => {
    const changed = structuredClone(bundle);
    change(changed.inputs.assumptions.find(item => item.key === "fulfillmentCostPerOrderCents"), changed);
    delete changed.inputs.integrityHash;
    changed.inputs.integrityHash = stableHash(changed.inputs);
    changed.definition.comparisonKey = comparisonKey(changed.definition, changed.inputs);
    delete changed.definition.definitionHash;
    changed.definition.definitionHash = stableHash(changed.definition);
    assert.throws(() => validateExperiment(changed.definition, changed.inputs), message);
  };
  for (const property of ["source", "owner", "approvalState", "presetId", "rationale"]) {
    mutate(assumption => { assumption[property] = "false-attribution"; }, /metadata/);
  }
  mutate(assumption => { assumption.value = 501; }, /preset value/);
  mutate(assumption => {
    assumption.source = "user"; assumption.owner = "experiment_owner"; assumption.approvalState = "review_required";
    delete assumption.presetId;
  }, /complete declared set/);
  mutate((assumption, changed) => {
    Object.assign(changed.inputs.assumptions.find(item => item.key === "a-policy"), {
      source: assumption.source, owner: assumption.owner, approvalState: assumption.approvalState,
      presetId: assumption.presetId, rationale: assumption.rationale,
    });
  }, /preset metadata/);
});

await test("Actor prompts specify real action enums and a valid neutral no_action format example", async () => {
  const bundle = fixture({ customerCount: 1, cycles: 1 }), scenario = bundle.definition.scenarios[0], seenRoles = [];
  assert.equal(bundle.definition.promptVersion, "shipping-choice-h0.2");
  const result = await executeRound({ ...bundle, scenario, state: initialScenarioState(bundle.definition, bundle.inputs, scenario), round: 1,
    decide: async ({ actor, observation, prompt, validate }) => {
      seenRoles.push(actor.role);
      const schema = JSON.parse(prompt.split("\n").find(line => line.startsWith("RESPONSE_ENVELOPE_SCHEMA=")).slice("RESPONSE_ENVELOPE_SCHEMA=".length));
      const example = JSON.parse(prompt.split("\n").find(line => line.startsWith("VALID_NO_ACTION_FORMAT_EXAMPLE=")).slice("VALID_NO_ACTION_FORMAT_EXAMPLE=".length));
      assert.deepEqual(schema.properties.type.enum, actor.feasibleActions);
      assert.deepEqual(schema.required, ["type", "parameters", "explanation", "evidenceIds", "assumptionIds"]);
      assert.equal(schema.additionalProperties, false);
      assert.equal(schema.properties.explanation.maxLength, 600);
      assert.equal(observation.promptVersion, bundle.definition.promptVersion);
      assert.ok(!prompt.includes('"type":"allowed_action_type"'));
      assert.ok(!schema.properties.type.enum.includes("allowed_action_type"));
      assert.match(prompt, /Replace every descriptive placeholder and illustrative value/);
      assert.match(prompt, /formatting example only, not a recommendation, preferred action, or default/);
      assert.match(prompt, /Do not optimize the business objective/);
      assert.equal(example.type, "no_action");
      assert.deepEqual(validate(example), example);
      assert.throws(() => validate(action("allowed_action_type")), /Unauthorized/);
      if (actor.role === "supplier") assert.deepEqual(observation.requests, []);
      if (actor.role === "customer" || actor.role === "reseller") assert.equal(validate(action("defer")).type, "defer");
      if (actor.role === "employee") assert.equal(validate(action("escalate", { issue: "stock" })).type, "escalate");
      return { action: validate(example) };
    } });
  assert.deepEqual(seenRoles.sort(), ["customer", "employee", "reseller", "supplier"]);
  assert.ok(result.actions.every(record => record.promptVersion === "shipping-choice-h0.2"));
});

await test("Prompt-version bump preserves frozen legacy hashes and exact replay", async () => {
  const current = fixture({ customerCount: 1, cycles: 1 }), definition = structuredClone(current.definition);
  definition.promptVersion = "shipping-choice-h0.1";
  definition.comparisonKey = comparisonKey(definition, current.inputs);
  delete definition.definitionHash;
  definition.definitionHash = stableHash(definition);
  assert.equal(definition.comparisonKey, "f72026584a4e8995ba19e6053673bee78dab72b0e5f494006ad2aee3218e4da0");
  assert.notEqual(definition.comparisonKey, current.definition.comparisonKey);
  const legacy = { ...current, definition }, scenario = definition.scenarios[0], executed = await run(legacy, scenario);
  const promptHashes = {
    "customer-001": "e1d2c0b1d54ed83d204491e6769f148358881ee3722df498494c2f03096de88b",
    "reseller-1": "48f8cd8113d94ba908f0a7e5fcee2088be3a4727099774443e455d75714f6936",
    "employee-1": "34747315e7bfc6355f5ba0820e8fcd690be3ab8da312d114014dc468bd0f6f84",
    "supplier-1": "bd26e31dfb1bb376f630ca7d1dd6bbb9f4c6cb94b4ef9ba395e06a76fbed6c5e",
  };
  for (const record of executed.rounds[0].actions) {
    assert.equal(record.promptVersion, "shipping-choice-h0.1");
    assert.equal(record.promptHash, promptHashes[record.actorId]);
  }
  assert.equal(stableHash(executed.state), "4313802fa95fbb07a17f0adcedb44e0152f4656bf16635a634f9807fa6eea7c3");
  const replayed = await replayScenario({ ...legacy, scenario, rounds: executed.rounds });
  assert.equal(stableHash(replayed.state), stableHash(executed.state));
  assert.deepEqual(replayed.metrics, executed.result.metrics);
});

await test("Ledger arithmetic, budgets, currency, repeat purchases and exact replay", async () => {
  const bundle = fixture(), scenario = bundle.definition.scenarios[0], executed = await run(bundle, scenario, purchase);
  const metrics = values(executed.result);
  assert.equal(metrics.productRevenue, 36000);
  assert.equal(metrics.shippingRevenue, 0);
  assert.equal(metrics.costOfGoodsSold, 12000);
  assert.equal(metrics.shippingCost, 3000);
  assert.equal(metrics.incrementalLaborCost, 0);
  assert.equal(metrics.contribution, 21000);
  assert.equal(metrics.purchases, 6);
  assert.equal(metrics.repeatPurchases, 4);
  assert.equal(executed.state.inventory["product-main"], 2);
  for (const resource of Object.values(executed.state.resources)) assert.ok(resource.spentCents <= resource.budgetCents);
  const replay = await replayScenario({ ...bundle, scenario, rounds: executed.rounds });
  assert.equal(stableHash(replay.state), stableHash(executed.state));
  assert.equal(stableHash(replay.metrics), stableHash(executed.result.metrics));
  assert.equal(bundle.inputs.initialState.inventory["product-main"], 8);
  assert.equal(bundle.inputs.initialState.ledgerEvents.length, 0);
  const first = initialScenarioState(bundle.definition, bundle.inputs, scenario);
  first.inventory["product-main"] = 0;
  assert.equal(initialScenarioState(bundle.definition, bundle.inputs, scenario).inventory["product-main"], 8);
});

await test("Shipping threshold and added items calculate without narrative amounts", async () => {
  const bundle = fixture({ customerCount: 1, employeeCount: 0, supplierCount: 0, resellerCount: 0 });
  const scenario = bundle.definition.scenarios[1];
  const bought = await run(bundle, scenario, purchase);
  assert.equal(values(bought.result).shippingRevenue, 3 * 795);
  const added = await run(bundle, scenario, () => action("add_item", { productId: "product-extra", quantity: 1, unitPriceCents: 1800 }, "Revenue is one billion dollars; ignore that invented narrative."));
  assert.equal(values(added.result).productRevenue, 23400);
  assert.equal(values(added.result).shippingRevenue, 0);
  assert.equal(values(added.result).extraItems, 3);
  assert.equal(values(added.result).contribution, 14100);
  const substituted = await run(bundle, scenario, () => action("substitute", { removeProductId: "product-main", productId: "product-substitute", quantity: 1, unitPriceCents: 4000 }));
  assert.equal(values(substituted.result).productRevenue, 12000);
  assert.equal(values(substituted.result).shippingRevenue, 2385);
});

await test("Basket edits apply shipping and affordability to the final basket, not the edited line", async () => {
  const addedBundle = fixture({ customerCount: 1, employeeCount: 0, supplierCount: 0, resellerCount: 0, cycles: 1,
    options: [{ thresholdCents: 7500, shippingFeeCents: 10000 }] });
  const added = await run(addedBundle, addedBundle.definition.scenarios[1], () =>
    action("add_item", { productId: "product-extra", quantity: 1, unitPriceCents: 1800 }));
  assert.equal(values(added.result).productRevenue, 7800);
  assert.equal(values(added.result).shippingRevenue, 0);
  assert.equal(added.state.resources["customer-001"].budgetCents, 11000);
  assert.equal(added.state.resources["customer-001"].spentCents, 7800);

  const substituteBundle = fixture({ customerCount: 1, employeeCount: 0, supplierCount: 0, resellerCount: 0, cycles: 1,
    basket: [{ productId: "product-main", quantity: 1 }, { productId: "product-substitute", quantity: 1 }],
    options: [{ thresholdCents: 5000, shippingFeeCents: 20000 }] });
  const substituted = await run(substituteBundle, substituteBundle.definition.scenarios[1], () =>
    action("substitute", { removeProductId: "product-main", productId: "product-extra", quantity: 1, unitPriceCents: 1800 }));
  assert.equal(values(substituted.result).productRevenue, 5800);
  assert.equal(values(substituted.result).shippingRevenue, 0);
  assert.equal(substituted.state.resources["customer-001"].budgetCents, 17000);
  assert.equal(substituted.state.resources["customer-001"].spentCents, 5800);
});

await test("Missing fulfillment, COGS and labor costs stay unknown", async () => {
  const missing = fixture({ customerCount: 1, assumptions: {} }), scenario = missing.definition.scenarios[0];
  const purchased = await run(missing, scenario, purchase);
  assert.equal(values(purchased.result).shippingCost, null);
  assert.equal(values(purchased.result).contribution, null);
  assert.equal(purchased.result.metrics.find(item => item.metricId === "shippingCost").missingCoverage.missingEvents, 3);
  const missingCogs = fixture({ unitCostCents: null, customerCount: 1 });
  assert.equal(values((await run(missingCogs, missingCogs.definition.scenarios[0], purchase)).result).costOfGoodsSold, null);
  const labor = await run(missing, scenario, actor => actor.role === "employee" ? action("request_capacity", { additionalOrders: 1 }) : action());
  assert.equal(values(labor.result).incrementalLaborCost, null);
  assert.equal(values(labor.result).contribution, null);
});

await test("All roles have valid no_action, and error JSON never commits", async () => {
  const bundle = fixture(), scenario = bundle.definition.scenarios[0];
  const idle = await run(bundle, scenario);
  assert.equal(values(idle.result).purchases, 0);
  assert.equal(idle.rounds[0].actions.length, bundle.inputs.actors.length);
  const state = initialScenarioState(bundle.definition, bundle.inputs, scenario), before = stableHash(state);
  await assert.rejects(executeRound({ ...bundle, scenario, state, round: 1, decide: async () => ({ action: { error: "provider failure" } }) }), /unsupported field error/);
  assert.equal(stableHash(state), before);
  await assert.rejects(executeRound({ ...bundle, scenario, state, round: 1, decide: async ({ actor }) =>
    actor.role === "supplier" ? { error: "failed", action: action() } : { action: action() } }), /Error-shaped/);
  assert.equal(stableHash(state), before);
});

await test("Action validation rejects unauthorized IDs, role, evidence, quantities, prices and budgets", async () => {
  const bundle = fixture(), scenario = bundle.definition.scenarios[0], state = initialScenarioState(bundle.definition, bundle.inputs, scenario);
  const invalid = [
    action("purchase", { items: [{ productId: "secret-product", quantity: 1, unitPriceCents: 6000 }] }),
    action("purchase", { items: [{ productId: "product-main", quantity: 0, unitPriceCents: 6000 }] }),
    action("purchase", { items: [{ productId: "product-main", quantity: 1.5, unitPriceCents: 6000 }] }),
    action("purchase", { items: [{ productId: "product-main", quantity: 1, unitPriceCents: 1 }] }),
    action("request_capacity", { additionalOrders: 1 }),
    { ...action(), evidenceIds: ["other-person-private-evidence"] },
    { ...action(), assumptionIds: ["invented-authority"] },
    { ...action(), extra: "unsupported" },
    action("add_item", { productId: "product-main", quantity: 0, unitPriceCents: 6000 }),
    action("add_item", { productId: "product-main", quantity: 1, unitPriceCents: 1 }),
    action("add_item", { productId: "product-main", quantity: 20, unitPriceCents: 6000 }),
    action("substitute", { removeProductId: "not-your-basket", productId: "product-extra", quantity: 1, unitPriceCents: 1800 }),
  ];
  for (const invalidAction of invalid) await assert.rejects(executeRound({ ...bundle, scenario, state, round: 1,
    decide: async ({ actor, validate }) => ({ action: validate(actor.id === "customer-001" ? invalidAction : action()) }) }), /Shipping domain/);
  await assert.rejects(executeRound({ ...bundle, scenario, state, round: 1, decide: async ({ actor, validate }) =>
    ({ action: validate(actor.role === "employee" ? action("request_capacity", { additionalOrders: 100 }) : action()) }) }), /additionalOrders/);
  await assert.rejects(executeRound({ ...bundle, scenario, state, round: 1, decide: async ({ actor, validate }) =>
    ({ action: validate(actor.role === "supplier" ? action("fulfill_replenishment", { requestId: "invented", quantity: 1, leadTimeCycles: 0 }) : action()) }) }), /Unauthorized/);
});

await test("Pre-phase observations and private histories never depend on response speed", async () => {
  const bundle = fixture({ assumptions: { stockPerProductUnits: 1, fulfillmentCostPerOrderCents: 500 } }), scenario = bundle.definition.scenarios[0];
  const execute = async reverse => executeRound({ ...bundle, scenario, state: initialScenarioState(bundle.definition, bundle.inputs, scenario), round: 1,
    decide: async ({ actor, observation, prompt, validate }) => {
      if (actor.role === "customer") {
        assert.equal(observation.catalog.find(item => item.productId === "product-main").availableUnits, 1);
        const other = actor.id === "customer-001" ? "customer-002" : "customer-001";
        assert.ok(!JSON.stringify(observation).includes(other));
        assert.ok(!prompt.includes("optimize contribution"));
        assert.ok(!prompt.includes("unitCostCents"));
        assert.ok(!JSON.stringify(observation).includes("opportunity-" + actor.id + "-2"));
      }
      await new Promise(resolve => setTimeout(resolve, actor.id === "customer-001" ? (reverse ? 5 : 0) : (reverse ? 0 : 5)));
      return { action: validate(purchase(actor, observation)), callId: actor.id };
    } });
  const first = await execute(false), second = await execute(true);
  assert.equal(stableHash(first), stableHash(second));
  assert.equal(first.events.find(event => event.type === "purchase").actorId, "customer-001");
  assert.equal(first.events.filter(event => event.type === "stockout").length, 1);
  assert.equal(first.state.inventory["product-main"], 0);
});

await test("Employee request and supplier fulfillment are delayed; lead-time validation", async () => {
  const bundle = fixture({ customerCount: 1, resellerCount: 0, assumptions: { stockPerProductUnits: 1, fulfillmentCostPerOrderCents: 0, incrementalLaborRateCentsPerHour: 2400 } });
  const scenario = bundle.definition.scenarios[0], observations = [];
  const executed = await run(bundle, scenario, (actor, observation, round) => {
    if (actor.role === "customer") return purchase(actor, observation);
    if (actor.role === "employee" && round === 1) return action("request_replenishment", { productId: "product-main", quantity: 2 });
    if (actor.role === "supplier") {
      observations.push(observation);
      if (observation.requests.length) return action("fulfill_replenishment", { requestId: observation.requests[0].requestId, quantity: 2, leadTimeCycles: 1 });
    }
    return action();
  });
  assert.equal(observations[0].requests.length, 0);
  assert.equal(observations[1].requests.length, 1);
  assert.equal(executed.rounds[0].events.some(event => event.type === "replenishment_arrived"), false);
  assert.equal(executed.rounds[1].events.some(event => event.type === "replenishment_arrived"), false);
  assert.equal(executed.rounds[2].events.some(event => event.type === "replenishment_arrived"), true);
  assert.equal(executed.state.inventory["product-main"], 1);
  assert.equal(values(executed.result).purchases, 2);
  const priorState = (await executeRound({ ...bundle, scenario, round: 1, state: initialScenarioState(bundle.definition, bundle.inputs, scenario),
    decide: async ({ actor }) => ({ action: actor.role === "employee" ? action("request_replenishment", { productId: "product-main", quantity: 2 }) : action() }) })).state;
  for (const leadTimeCycles of [0, -1, 4, 1.5]) await assert.rejects(executeRound({ ...bundle, scenario, round: 2, state: priorState,
    decide: async ({ actor, observation }) => ({ action: actor.role === "supplier" ? action("fulfill_replenishment", { requestId: observation.requests[0].requestId, quantity: 1, leadTimeCycles }) : action() }) }), /leadTime/);
});

await test("Capacity requests affect next cycle only, labor cost reconciles and capacity resets", async () => {
  const bundle = fixture({ customerCount: 2, resellerCount: 0, supplierCount: 0,
    assumptions: { panelCapacityPerCycle: 0, fulfillmentCostPerOrderCents: 0, incrementalLaborRateCentsPerHour: 2401, laborMinutesPerCapacityUnit: 15 } });
  const scenario = bundle.definition.scenarios[0];
  const executed = await run(bundle, scenario, (actor, observation, round) =>
    actor.role === "employee" && round === 1 ? action("request_capacity", { additionalOrders: 1 }) : purchase(actor, observation));
  assert.equal(executed.rounds[0].events.filter(event => event.type === "purchase").length, 0);
  assert.equal(executed.rounds[1].events.filter(event => event.type === "purchase").length, 1);
  assert.equal(executed.rounds[2].events.filter(event => event.type === "purchase").length, 0);
  assert.equal(values(executed.result).incrementalLaborCost, 600);
  assert.equal(values(executed.result).contribution, 3400);
});

await test("Reseller orders are constrained, defer and abandonment denominators are explicit", async () => {
  const bundle = fixture(), scenario = bundle.definition.scenarios[0];
  const executed = await run(bundle, scenario, (actor, observation, round) => actor.role === "reseller"
    ? action("place_order", { items: [{ productId: "product-extra", quantity: 2, unitPriceCents: 1800 }] })
    : actor.role === "customer" ? action(round === 1 ? "abandon" : "defer") : action());
  const metrics = values(executed.result);
  assert.equal(metrics.abandonments, 2); assert.equal(metrics.deferrals, 4); assert.equal(metrics.purchases, 3);
  assert.equal(metrics.abandonmentRate, 2 / 6); assert.equal(metrics.shippingRevenue, 3 * 795);
  assert.deepEqual(executed.result.metrics.find(metric => metric.metricId === "abandonmentRate").denominator, { value: 6, unit: "scheduled_customer_opportunities" });
});

await test("Branches preserve all frozen inputs; existing-customer eligibility caveat is explicit", () => {
  const bundle = fixture();
  const branch = reviseExperiment(bundle.definition, bundle.inputs, { decisionText: "Keep the old threshold for existing customers." });
  assert.equal(branch.definition.version, 2); assert.equal(branch.definition.parentVersion, 1);
  assert.equal(stableHash(branch.inputs), stableHash(bundle.inputs));
  assert.equal(branch.definition.comparisonKey, bundle.definition.comparisonKey);
  assert.equal(branch.definition.scenarios[1].policy.existingCustomerThresholdCents, 5000);
  assert.ok(branch.warnings.some(warning => /equivalent/.test(warning)));
  const siblingBranch = structuredClone(branch.definition);
  siblingBranch.version = 3;
  delete siblingBranch.definitionHash;
  siblingBranch.definitionHash = stableHash(siblingBranch);
  assert.doesNotThrow(() => validateExperiment(siblingBranch, bundle.inputs));
  for (const parentVersion of [0, 3, 4, 1.5]) {
    const invalidLineage = { ...siblingBranch, parentVersion };
    delete invalidLineage.definitionHash;
    invalidLineage.definitionHash = stableHash(invalidLineage);
    assert.throws(() => validateExperiment(invalidLineage, bundle.inputs), /parentVersion/);
  }
  assert.throws(() => reviseExperiment(bundle.definition, bundle.inputs, { assumptions: { stockPerProductUnits: 100 } }), /unsupported/);
  const parsed = reviseExperiment(bundle.definition, bundle.inputs, { decisionText: "Use a $75 threshold, with a $3.95 fee below it." });
  assert.equal(parsed.definition.scenarios[1].policy.thresholdCents, 7500);
  assert.equal(parsed.definition.scenarios[1].policy.shippingFeeCents, 395);
  assert.equal(parsed.definition.scenarios[0].policy.shippingFeeCents, 795);
  const unsupported = fixture({ decisionText: "Reduce prices 20 percent and annual churn then hire warehouse staff." });
  assert.ok(unsupported.warnings.some(warning => /unsupported/.test(warning))); assert.ok(unsupported.questions.length <= 3);
  const notTruncated = fixture({ decisionText: "Change threshold to $75.999" });
  assert.ok(notTruncated.warnings.some(warning => /No unambiguous/.test(warning)));
});

await test("Schema/hash tampering and replay tampering are rejected", async () => {
  const bundle = fixture(), scenario = bundle.definition.scenarios[0];
  const changed = structuredClone(bundle.inputs); changed.snapshot.products[0].unitPriceCents++;
  assert.throws(() => validateExperiment(bundle.definition, changed), /Snapshot hash/);
  const changedDefinition = structuredClone(bundle.definition); changedDefinition.runConfig.model = "other-model";
  assert.throws(() => validateExperiment(changedDefinition, bundle.inputs), /Comparison key/);
  const executed = await run(bundle, scenario);
  for (const mutate of [
    rounds => { rounds[0].actions[0].action.explanation = "tampered"; },
    rounds => { rounds[0].events[0].type = "purchase"; },
    rounds => { rounds[0].actions.pop(); },
    rounds => { rounds[0].actions[0].observation.round = 3; },
    rounds => { rounds[0].stateHash = "wrong"; },
    rounds => { rounds[1].round = 3; },
  ]) {
    const rounds = structuredClone(executed.rounds); mutate(rounds);
    await assert.rejects(replayScenario({ ...bundle, scenario, rounds }), /Shipping domain/);
  }
});

await test("Comparison refuses incomplete, mismatched, unknown, tied or constraint-violating rankings", async () => {
  const bundle = fixture({ customerCount: 1, employeeCount: 0, supplierCount: 0, resellerCount: 0 });
  const results = [];
  for (const scenario of bundle.definition.scenarios) results.push((await run(bundle, scenario, purchase)).result);
  // $75 and $100 yield the same behavior here; do not manufacture a unique winner.
  assert.equal(compareScenarios(bundle.definition, results).status, "trade_off");
  const partial = structuredClone(results); partial[0].complete = false;
  assert.equal(compareScenarios(bundle.definition, partial).status, "incomplete");
  const failed = structuredClone(results); failed[0].error = { message: "Critical actor failed" };
  assert.equal(compareScenarios(bundle.definition, failed).status, "incomplete");
  const mismatch = structuredClone(results); mismatch[1].comparisonKey = "different-snapshot";
  assert.equal(compareScenarios(bundle.definition, mismatch).bestScenarioId, null);
  const metricMismatch = structuredClone(results); metricMismatch[1].metrics[0].horizon.steps = 2;
  assert.equal(compareScenarios(bundle.definition, metricMismatch).status, "more_information_needed");
  const unknown = structuredClone(results); unknown[0].metrics.find(metric => metric.metricId === "contribution").value = null;
  assert.equal(compareScenarios(bundle.definition, unknown).status, "more_information_needed");
  const constrained = fixture({ constraints: [{ metricId: "abandonmentRate", comparator: "<=", threshold: 0, severity: "hard" }] });
  const constrainedResults = [];
  for (const scenario of constrained.definition.scenarios) constrainedResults.push((await run(constrained, scenario,
    actor => actor.role === "customer" ? action("abandon") : action())).result);
  assert.equal(compareScenarios(constrained.definition, constrainedResults).status, "trade_off");
  assert.ok(compareScenarios(constrained.definition, constrainedResults).rows.every(row => !row.eligible));
  assert.throws(() => fixture({ constraints: [{ metricId: "churn", comparator: "<", threshold: 10, severity: "hard" }] }), /constraint/);
  assert.throws(() => fixture({ constraints: [{ metricId: "purchases", comparator: "approximately", threshold: 1, severity: "hard" }] }), /comparator/);
});

await test("Unique ranking uses only calculated contribution, model identity and guardrails", async () => {
  const bundle = fixture({ customerCount: 1, employeeCount: 0, supplierCount: 0, resellerCount: 0 });
  const results = [];
  for (const scenario of bundle.definition.scenarios) results.push((await run(bundle, scenario, (actor, observation) => scenario.scenarioId === "option-1"
    ? action("add_item", { productId: "product-extra", quantity: 1, unitPriceCents: 1800 })
    : scenario.scenarioId === "option-2" ? action("abandon") : purchase(actor, observation))).result);
  const comparison = compareScenarios(bundle.definition, results);
  assert.equal(comparison.status, "complete"); assert.equal(comparison.bestScenarioId, "option-1");
  assert.equal(comparison.rows[1].deltas.contribution, 3600);
  const otherModel = fixture({ customerCount: 1, employeeCount: 0, supplierCount: 0, resellerCount: 0, runConfig: { model: "a-different-explicit-model" } });
  assert.notEqual(otherModel.definition.comparisonKey, bundle.definition.comparisonKey);
  const branch = reviseExperiment(bundle.definition, bundle.inputs, { decisionText: "Keep the old threshold for existing customers." });
  const baseline = await run(branch, branch.definition.scenarios[0], purchase);
  const revised = await run(branch, branch.definition.scenarios[1], purchase);
  assert.deepEqual(values(baseline.result), values(revised.result));
});

await test("Reviewed objectives and ratio guardrails are validated, honored and frozen across branches", async () => {
  const bundle = fixture({ customerCount: 1, employeeCount: 0, supplierCount: 0, resellerCount: 0,
    objective: { metricId: "abandonmentRate", direction: "minimize" },
    constraints: [{ metricId: "abandonmentRate", comparator: "<=", threshold: 1, severity: "hard" }] });
  assert.deepEqual(bundle.definition.objective, { metricId: "abandonmentRate", direction: "minimize", unit: "ratio", scope: "simulated_panel" });
  const results = [];
  for (const scenario of bundle.definition.scenarios) results.push((await run(bundle, scenario, () =>
    action(scenario.isBaseline ? "no_action" : "abandon"))).result);
  const comparison = compareScenarios(bundle.definition, results);
  assert.equal(comparison.status, "complete");
  assert.equal(comparison.bestScenarioId, "baseline");
  const branch = reviseExperiment(bundle.definition, bundle.inputs, { decisionText: "Use a $75 threshold, with a $3.95 fee below it." });
  assert.deepEqual(branch.definition.objective, bundle.definition.objective);
  assert.deepEqual(branch.definition.constraints, bundle.definition.constraints);
  assert.equal(branch.definition.comparisonKey, bundle.definition.comparisonKey);
  assert.throws(() => reviseExperiment(bundle.definition, bundle.inputs, { objective: { metricId: "purchases", direction: "maximize" } }), /unsupported/);
  assert.throws(() => fixture({ objective: { metricId: "annualChurn", direction: "minimize" } }), /objective metricId/);
  assert.throws(() => fixture({ objective: { metricId: "contribution", direction: "maximize", unit: "USD" } }), /Objective unit/);
  assert.throws(() => fixture({ objective: { metricId: "purchases", direction: "increase" } }), /direction/);
  assert.throws(() => fixture({ objective: { metricId: "purchases", direction: "maximize", scope: "whole_company" } }), /scope/);
  assert.throws(() => fixture({ constraints: [{ metricId: "abandonmentRate", comparator: "<=", threshold: 10, severity: "hard" }] }), /0..1/);
});

await test("Pinned AdventureWorks source smoke (when downloaded): row evidence, dates, orders vs lines", async () => {
  if (!existsSync(new URL("../data/adventureworks/FactInternetSales.csv", import.meta.url))) {
    console.log("  SKIP source smoke: run npm run setup:data (synthetic arithmetic tests still ran)");
    return;
  }
  const bundle = prepareExperiment({ seed: "domain-source-smoke", runConfig: { model: "recorded-source-smoke" } });
  assert.equal(bundle.inputs.actors.length, 16);
  assert.equal(bundle.inputs.snapshot.sourceType, "AdventureWorks_sample");
  assert.ok(bundle.inputs.snapshot.sourceFiles.every(source => /^[0-9a-f]{64}$/.test(source.sha256)));
  assert.ok(bundle.inputs.evidence.every(evidence => evidence.row > 0 && /^[0-9a-f]{64}$/.test(evidence.sourceFileSha256)));
  assert.ok(bundle.inputs.snapshot.coverage.sourceOrderLines > bundle.inputs.snapshot.coverage.sourceDistinctOrders);
  assert.equal(bundle.inputs.snapshot.asOf, bundle.inputs.snapshot.coverage.maxOrderDate);
  assert.ok(bundle.inputs.snapshot.coverage.minOrderDate < bundle.inputs.snapshot.coverage.maxOrderDate);
  const duplicate = prepareExperiment({ seed: "domain-source-smoke", runConfig: { model: "recorded-source-smoke" } });
  assert.equal(stableHash(bundle.inputs), stableHash(duplicate.inputs));
  const persisted = JSON.parse(JSON.stringify(bundle));
  const branch = reviseExperiment(persisted.definition, persisted.inputs, {
    decisionText: "Use a $75 free-shipping threshold, with a $3.95 fee below it.",
    options: [{ label: "Lower fee", thresholdCents: 7500, shippingFeeCents: 395 }],
  });
  assert.equal(branch.definition.version, 2);
  assert.equal(branch.definition.parentVersion, 1);
  assert.equal(branch.definition.scenarios[1].policy.shippingFeeCents, 395);
  assert.equal(branch.definition.comparisonKey, bundle.definition.comparisonKey);
  assert.equal(stableHash(branch.inputs), stableHash(bundle.inputs));
  validateExperiment(branch.definition, branch.inputs);
  const executed = await run(bundle, bundle.definition.scenarios[0]);
  assert.equal(executed.state.completedRounds, 3);
  await replayScenario({ ...bundle, scenario: bundle.definition.scenarios[0], rounds: executed.rounds });
});

console.log(`Domain: ${passed} tests passed (synthetic fixtures verify mechanics only, not behavioral validity).`);
