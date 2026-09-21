import { randomUUID } from "node:crypto";
import { ADAPTER_VERSION, CAPABILITIES, PROMPT_VERSION, SUPPORTED_PROMPT_VERSIONS, MAX_MONEY, PANEL_LIMITS, array, canonical, check, clone,
  freeze, integer, keys, object, omit, stableHash, text, unique } from "./domain-common.mjs";
import { loadSample, SOURCE_HASHES, syntheticSource } from "./domain-source.mjs";

export const METRIC_DEFINITIONS = [
  ["productRevenue", "USD_cents", "Sum fulfilled units × assigned sale price."],
  ["shippingRevenue", "USD_cents", "Sum shipping charges on fulfilled panel orders."],
  ["costOfGoodsSold", "USD_cents", "Sum fulfilled units × assigned unit cost; null if any cost is missing."],
  ["shippingCost", "USD_cents", "Fulfilled orders × assumed fulfillment cost; null when missing."],
  ["incrementalLaborCost", "USD_cents", "Approved additional capacity × minutes per unit × hourly rate / 60, rounded half-up; missing rate stays null."],
  ["contribution", "USD_cents", "Product revenue + collected shipping − COGS − fulfillment − incremental labor; not net profit."],
  ["purchases", "orders", "Fully fulfilled customer and reseller orders in the unweighted panel."],
  ["abandonments", "opportunities", "Explicit customer abandon actions; no_action is not abandonment."],
  ["deferrals", "opportunities", "Explicit customer or reseller defer actions; a deferral does not create extra future opportunities."],
  ["extraItems", "units", "Additional units from fulfilled add_item actions, not substituted units."],
  ["stockouts", "opportunities", "Attempted orders blocked by at least one unavailable unit; one count per opportunity."],
  ["repeatPurchases", "orders", "Fulfilled customer or reseller orders after that actor's first fulfilled order in this horizon."],
  ["abandonmentRate", "ratio", "Explicit customer abandonments / scheduled customer purchase opportunities."],
].map(([metricId, unit, formula]) => ({ metricId, unit, formula, formulaVersion: "shipping-ledger-v1", basis: "calculated", scope: "simulated_panel" }));

const ASSUMPTION_DEFAULTS = {
  stockPerProductUnits: 8, panelCapacityPerCycle: null, customerBudgetMultiplierBps: 15000,
  resellerBudgetCents: 30000, fulfillmentCostPerOrderCents: null, incrementalLaborRateCentsPerHour: null,
  employeeMaxAdditionalCapacity: 2, laborMinutesPerCapacityUnit: 15, supplierCapacityUnits: 6,
  supplierLeadTimeCycles: 1, resellerMaxUnitsPerOrder: 3,
};
const CONVERSATION_PRESET = "conversational-shipping-v1";
const CONVERSATION_COSTS = { fulfillmentCostPerOrderCents: 500, incrementalLaborRateCentsPerHour: 2400 };
const PRESET_RATIONALE = "Automatically applied illustrative conversational preset; not measured source evidence or a manually reviewed value.";
const ASSUMPTION_IDS = {
  stockPerProductUnits: "a-stock", panelCapacityPerCycle: "a-capacity", customerBudgetMultiplierBps: "a-budget",
  resellerBudgetCents: "a-reseller-budget", fulfillmentCostPerOrderCents: "a-fulfillment",
  incrementalLaborRateCentsPerHour: "a-labor-rate", employeeMaxAdditionalCapacity: "a-staff-authority",
  laborMinutesPerCapacityUnit: "a-labor-time", supplierCapacityUnits: "a-supplier-capacity",
  supplierLeadTimeCycles: "a-lead-time", resellerMaxUnitsPerOrder: "a-reseller-volume",
};
const DESCRIPTIONS = {
  stockPerProductUnits: "Initial inventory units for each retained product, scaled to this unweighted panel; not observed company stock.",
  panelCapacityPerCycle: "Base fulfilled-order capacity per shopping cycle for the panel; no full-company scaling.",
  customerBudgetMultiplierBps: "Total per-customer budget: scheduled base merchandise total × this factor in basis points plus one $20 allowance per cycle. Not inferred from income or demographics.",
  resellerBudgetCents: "Reseller total purchase budget for the complete simulated horizon.",
  fulfillmentCostPerOrderCents: "Fulfillment cost per completed customer or reseller order; missing remains unknown, not historical Freight.",
  incrementalLaborRateCentsPerHour: "Incremental hourly labor cost for approved additional capacity; missing remains unknown.",
  employeeMaxAdditionalCapacity: "Per-employee authority to schedule this many additional order slots for the next shopping cycle only.",
  laborMinutesPerCapacityUnit: "Additional work minutes per approved capacity unit; cost is committed when capacity is requested, including beyond the horizon.",
  supplierCapacityUnits: "Per-supplier unit capacity per response cycle; supply relationships and authority are illustrative, not source-backed product/vendor joins.",
  supplierLeadTimeCycles: "Minimum supplier dispatch delay in shopping cycles after acceptance; never immediate.",
  resellerMaxUnitsPerOrder: "Maximum reseller order units per cycle, using the same displayed retail prices/shipping as customers; wholesale terms are unknown.",
};
const ADAPTER_ASSUMPTIONS = [
  ["a-policy", "Policy values are scenario inputs, not asserted historical company policies.", "scenario.policy"],
  ["a-opportunities", "One opportunity per buyer per shopping cycle; historical baskets cycle through the frozen schedule, with no annualization or inferred purchase rate.", 1],
  ["a-historical-prices", "Freeze latest retained source product sale prices for every scenario; historical basket IDs/quantities remain evidence, not predictions.", "historical_assigned"],
  ["a-historical-costs", "Freeze historical product standard cost as assigned cost; it is not a claim about present costs. Missing costs remain null.", "historical_assigned"],
  ["a-influence", "Customer-to-customer influence is off. Operational results are aggregate observations, not private peer messages.", false],
  ["a-arbitration", "Atomic whole-order fulfillment in stable ascending actor ID order; response arrival time does not allocate stock or capacity.", "stable_actor_id"],
  ["a-eligibility", "All historical customer actors are existing customers; no prospective cohort is synthesized.", "existing_customers"],
  ["a-operational-authority", "Operational authority, supplier-product eligibility, and equal-price reseller terms are limited synthetic H0 capabilities, not source relationships.", CAPABILITIES],
  ["a-currency", "Integer USD cents. Source decimals and derived prices round half-up once; labor rounds half-up per accepted capacity action. No tax, overhead, capital cost or discount model.", "USD_cents_half_up"],
];

function countsFrom(input) {
  return {
    customer: integer(input.customerCount ?? 12, "customerCount", 1, PANEL_LIMITS.customer),
    employee: integer(input.employeeCount ?? 2, "employeeCount", 0, PANEL_LIMITS.employee),
    supplier: integer(input.supplierCount ?? 1, "supplierCount", 0, PANEL_LIMITS.supplier),
    reseller: integer(input.resellerCount ?? 1, "resellerCount", 0, PANEL_LIMITS.reseller),
  };
}
function validateAssumptionValues(values) {
  keys(values, Object.keys(ASSUMPTION_DEFAULTS), "assumptions");
  integer(values.stockPerProductUnits, "stockPerProductUnits", 0, 10000);
  integer(values.panelCapacityPerCycle, "panelCapacityPerCycle", 0, 200);
  integer(values.customerBudgetMultiplierBps, "customerBudgetMultiplierBps", 1000, 100000);
  integer(values.resellerBudgetCents, "resellerBudgetCents");
  for (const key of ["fulfillmentCostPerOrderCents", "incrementalLaborRateCentsPerHour"]) if (values[key] !== null) integer(values[key], key);
  integer(values.employeeMaxAdditionalCapacity, "employeeMaxAdditionalCapacity", 0, 20);
  integer(values.laborMinutesPerCapacityUnit, "laborMinutesPerCapacityUnit", 1, 480);
  integer(values.supplierCapacityUnits, "supplierCapacityUnits", 1, 1000);
  integer(values.supplierLeadTimeCycles, "supplierLeadTimeCycles", 1, 3);
  integer(values.resellerMaxUnitsPerOrder, "resellerMaxUnitsPerOrder", 1, 20);
}
function validateRunConfig(config, plannedActions) {
  keys(config, ["provider", "model", "concurrency", "attemptCap", "deadlineMs", "callTimeoutMs", "repetitions"], "runConfig");
  check(config.provider === "copilot", "H0 requires provider copilot; no simulated provider fallback");
  check(config.model === null || (typeof config.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(config.model)), "model must be an explicit model ID or null while preparing");
  integer(config.concurrency, "concurrency", 1, 8);
  integer(config.attemptCap, "attemptCap", plannedActions + 1, 1000);
  integer(config.deadlineMs, "deadlineMs", 1000, 7_200_000);
  integer(config.callTimeoutMs, "callTimeoutMs", 1000, 120_000);
  check(config.callTimeoutMs <= config.deadlineMs, "callTimeoutMs exceeds total deadline");
  check(config.repetitions === 1, "H0 supports one repetition only");
}
function policy(value, label) {
  keys(value, ["thresholdCents", "shippingFeeCents", "existingCustomerThresholdCents"], label);
  integer(value.thresholdCents, `${label}.thresholdCents`);
  integer(value.shippingFeeCents, `${label}.shippingFeeCents`, 0, 100000);
  if (value.existingCustomerThresholdCents !== null) integer(value.existingCustomerThresholdCents, `${label}.existingCustomerThresholdCents`);
  return value;
}
function normalizeOption(option, index, baseline, originalText) {
  keys(option, ["label", "thresholdCents", "shippingFeeCents", "existingCustomerThresholdCents"], "option");
  const normalized = policy({
    thresholdCents: option.thresholdCents,
    shippingFeeCents: option.shippingFeeCents ?? baseline.shippingFeeCents,
    existingCustomerThresholdCents: option.existingCustomerThresholdCents ?? null,
  }, "option.policy");
  return { scenarioId: `option-${index + 1}`, label: text(option.label ?? `Option ${index + 1}`, "option.label", 120, 1),
    isBaseline: false, policy: normalized, originalText,
    interventions: Object.keys(normalized).filter(field => normalized[field] !== baseline[field]).map(field => ({
      field, oldValue: baseline[field], newValue: normalized[field], effectiveStep: 1,
      eligibility: field === "existingCustomerThresholdCents" ? "existing_customers" : "all_panel_buyers",
    })) };
}
function parseText(decisionText, baseline, existingOptions = null) {
  const warnings = [
    "Template parser supports shipping threshold and fee edits only. All normalized policies require review; other wording is not executed.",
  ], questions = [];
  let options = existingOptions ? clone(existingOptions) : [
    { label: "$75 threshold", thresholdCents: 7500, shippingFeeCents: baseline.shippingFeeCents },
    { label: "$100 threshold", thresholdCents: 10000, shippingFeeCents: baseline.shippingFeeCents },
  ];
  const dollars = value => Math.round(Number(value) * 100);
  const threshold = decisionText.match(/(?:threshold\s+(?:(?:to|of|at)\s+)?\$?(\d+(?:\.\d{1,2})?)(?![\d.,])|\$(\d+(?:\.\d{1,2})?)\s+(?:free[- ]shipping\s+)?threshold)/i);
  const fee = decisionText.match(/(?:fee\s+(?:(?:to|of|at)\s+)?\$(\d+(?:\.\d{1,2})?)(?![\d.,])|\$(\d+(?:\.\d{1,2})?)\s+(?:shipping\s+)?fee)/i);
  if (/existing\s+customers/i.test(decisionText) && /keep|retain|old|original/i.test(decisionText)) {
    options = options.map(option => ({ ...option, existingCustomerThresholdCents: baseline.thresholdCents }));
    warnings.push("Every customer in this panel is an existing customer. Retaining the baseline threshold makes customer offers equivalent when fees also match; stochastic reruns can still vary. Reseller terms are separate.");
  } else if (threshold || fee) {
    options = [{
      label: "Parsed shipping option",
      thresholdCents: threshold ? dollars(threshold[1] || threshold[2]) : options[0].thresholdCents,
      shippingFeeCents: fee ? dollars(fee[1] || fee[2]) : options[0].shippingFeeCents,
      existingCustomerThresholdCents: options[0].existingCustomerThresholdCents ?? null,
    }];
  } else {
    warnings.push("No unambiguous supported policy edit was parsed. The displayed options are explicit defaults (or unchanged branch policies), not a full interpretation of the proposal.");
    questions.push("Do the displayed shipping thresholds and fees match your intended change?");
  }
  if (/\b(price|discount|membership|annual|day|week|month|year|churn|staff|wage|warehouse|acquisition|prospect|percent|%)\b/i.test(decisionText)) {
    warnings.push("Material non-shipping-policy text is unsupported and has not changed prices, populations, time units, staffing, or costs.");
    questions.push("Remove unsupported changes or confirm that this experiment tests only the displayed shipping policies.");
  }
  return { options, warnings, questions: questions.slice(0, 3) };
}
export function validateConstraints(constraints) {
  array(constraints, "constraints", 8);
  for (const constraint of constraints) {
    keys(constraint, ["metricId", "comparator", "threshold", "severity"], "constraint");
    check(METRIC_DEFINITIONS.some(metric => metric.metricId === constraint.metricId), "Unknown constraint metricId");
    check([">=", "<=", ">", "<", "=="].includes(constraint.comparator), "Invalid constraint comparator");
    check(["hard", "warning"].includes(constraint.severity), "Invalid constraint severity (hard or warning)");
    check(Number.isFinite(constraint.threshold), "Constraint threshold must be finite");
    if (constraint.metricId !== "abandonmentRate") check(Number.isSafeInteger(constraint.threshold), "Money and count thresholds must be integers");
    if (constraint.metricId === "abandonmentRate") check(constraint.threshold >= 0 && constraint.threshold <= 1, "abandonmentRate constraint must be in 0..1");
    check(Math.abs(constraint.threshold) <= MAX_MONEY, "Constraint threshold exceeds bound");
  }
}
export function normalizeObjective(input = { metricId: "contribution", direction: "maximize" }) {
  keys(input, ["metricId", "direction", "unit", "scope"], "objective");
  const metric = METRIC_DEFINITIONS.find(item => item.metricId === input.metricId);
  check(metric, "Unknown objective metricId");
  check(["maximize", "minimize"].includes(input.direction), "Objective direction must be maximize or minimize");
  const normalized = { metricId: input.metricId, direction: input.direction, unit: input.unit ?? metric.unit, scope: input.scope ?? "simulated_panel" };
  check(normalized.unit === metric.unit, "Objective unit must match its H0 metric definition");
  check(normalized.scope === "simulated_panel", "Objective scope must be simulated_panel");
  return normalized;
}

export function comparisonKey(definition, inputs) {
  return stableHash({ schemaVersion: definition.schemaVersion, adapter: definition.domainAdapter, adapterVersion: definition.adapterVersion,
    promptVersion: definition.promptVersion, snapshot: inputs.snapshot.hash, population: inputs.populationHash,
    initialState: inputs.initialStateHash, graph: inputs.graph.hash, opportunities: inputs.externalEventsHash,
    horizon: definition.horizon, metrics: definition.metricDefinitions, assumptions: inputs.assumptions,
    provider: definition.runConfig.provider, model: definition.runConfig.model, repetitions: definition.runConfig.repetitions,
    seed: definition.seed, objective: definition.objective, constraints: definition.constraints });
}

function prepare(input, synthetic = false, preparation = {}) {
  keys(preparation, ["preset"], "preparation options");
  const preset = preparation.preset;
  check(preset === undefined || preset === CONVERSATION_PRESET, "Unsupported automatic assumption preset");
  keys(input, ["decisionText", "title", "seed", "customerCount", "employeeCount", "supplierCount", "resellerCount",
    "cycles", "baseline", "options", "assumptions", "runConfig", "objective", "constraints", ...(synthetic ? ["unitCostCents", "basket"] : [])], "preparation input");
  check(!preset || input.assumptions === undefined, "Automatic preset assumptions cannot be mixed with user-supplied assumptions");
  const decisionText = text(input.decisionText ?? "Compare free-shipping thresholds.", "decisionText", 4000);
  const seed = text(String(input.seed ?? "shipping-h0"), "seed", 120, 1);
  const counts = countsFrom(input), cycles = integer(input.cycles ?? 3, "cycles", 1, 3);
  const source = synthetic ? syntheticSource(counts, cycles, input.unitCostCents === undefined ? 2000 : input.unitCostCents, input.basket) : loadSample(seed, counts, cycles);
  const baseline = { thresholdCents: 5000, shippingFeeCents: 795, existingCustomerThresholdCents: null, ...(input.baseline || {}) };
  policy(baseline, "baseline");
  const parsed = parseText(decisionText, baseline);
  const chosenOptions = input.options ?? parsed.options;
  array(chosenOptions, "options", preset ? 1 : 2, 1);
  const scenarios = [{ scenarioId: "baseline", label: preset ? "Option A" : "Baseline", isBaseline: true, policy: baseline, interventions: [], originalText: decisionText },
    ...chosenOptions.map((option, index) => normalizeOption(option, index, baseline, decisionText))];
  const values = { ...ASSUMPTION_DEFAULTS, panelCapacityPerCycle: source.customers.length + source.operational.filter(actor => actor.role === "reseller").length,
    ...(preset ? CONVERSATION_COSTS : input.assumptions || {}) };
  validateAssumptionValues(values);
  const assumptions = Object.entries(values).map(([key, value]) => ({
    assumptionId: ASSUMPTION_IDS[key], key, description: DESCRIPTIONS[key], value,
    rationale: preset ? PRESET_RATIONALE : "Explicit exploratory panel-scale input, not a measured AdventureWorks operating policy.",
    owner: preset ? "simulation_preset" : "experiment_owner", approvalState: preset ? "not_reviewed" : "review_required",
    source: preset ? "preset" : Object.hasOwn(input.assumptions || {}, key) ? "user" : "adapter_default",
    ...(preset ? { presetId: preset } : {}),
    affectedMetrics: METRIC_DEFINITIONS.map(metric => metric.metricId),
  }));
  for (const [assumptionId, description, value] of ADAPTER_ASSUMPTIONS) assumptions.push({
    assumptionId, key: assumptionId, description, value, rationale: "H0 adapter boundary", owner: "experiment_owner",
    approvalState: "review_required", source: "adapter_default", affectedMetrics: METRIC_DEFINITIONS.map(metric => metric.metricId),
  });
  const fact = (field, value, unit, evidenceIds = [], assumptionIds = []) => ({ field, value, unit, evidenceIds, assumptionIds });
  const actors = source.customers.map(customer => ({
    id: customer.id, role: "customer", label: customer.label, profileMode: customer.profileMode, sourceEntityIds: [customer.sourceEntityId],
    facts: [...(customer.facts || []), fact("firstPurchaseDate", customer.firstPurchaseDate, "date", customer.evidenceIds),
      fact("existingCustomer", true, "boolean", customer.evidenceIds, ["a-eligibility"]),
      fact("panelWeight", 1, "unweighted_actor", [], ["a-opportunities"])],
    unknowns: ["preferences", "shipping_sensitivity", "current_real_budget", "future_purchase_frequency"],
    feasibleActions: CAPABILITIES.customer,
  }));
  for (const actor of source.operational) actors.push({
    id: actor.id, role: actor.role, label: actor.label, profileMode: actor.profileMode, sourceEntityIds: [actor.sourceEntityId],
    facts: [...actor.facts, fact("authority", CAPABILITIES[actor.role], "allowed_action_types", [], ["a-operational-authority"])],
    unknowns: actor.role === "supplier" ? ["observed_product_vendor_relationship", "real_capacity", "real_lead_time"] : ["real_operating_capacity", "private_preferences"],
    feasibleActions: CAPABILITIES[actor.role],
  });
  actors.sort((a, b) => a.id.localeCompare(b.id));
  const productMap = new Map(source.products.map(product => [product.id, product]));
  const extras = [...source.products].sort((a, b) => a.unitPriceCents - b.unitPriceCents || a.id.localeCompare(b.id)).slice(0, 4).map(product => product.id);
  const opportunities = [];
  for (const actor of actors.filter(actor => ["customer", "reseller"].includes(actor.role))) {
    const historical = source.historicalOrders.filter(order => order.actorId === actor.id);
    for (let round = 1; round <= cycles; round++) {
      const order = historical.length ? historical[(round - 1) % historical.length] : null;
      const merged = new Map();
      for (const line of order?.lines || [{ productId: extras[0], quantity: 1, evidenceIds: [] }]) {
        if (!merged.has(line.productId)) merged.set(line.productId, { productId: line.productId, quantity: 0, unitPriceCents: productMap.get(line.productId).unitPriceCents });
        merged.get(line.productId).quantity += line.quantity;
      }
      const basket = [...merged.values()];
      check(basket.reduce((sum, item) => sum + item.quantity, 0) <= 20, "Historical basket exceeds 20 units; reduce panel or choose another seed");
      opportunities.push({ opportunityId: `opportunity-${actor.id}-${round}`, actorId: actor.id, round,
        basket, allowedProductIds: [...new Set([...basket.map(item => item.productId), ...extras])],
        sourceOrderId: order?.sourceOrderId ?? null,
        evidenceIds: [...new Set(order?.lines.flatMap(line => line.evidenceIds) || [])], assumptionIds: ["a-opportunities", "a-historical-prices", ...(order ? [] : ["a-operational-authority"])] });
    }
  }
  const resources = {};
  for (const actor of actors) {
    const merchandise = opportunities.filter(op => op.actorId === actor.id).reduce((sum, op) => sum + op.basket.reduce((total, item) => total + item.quantity * item.unitPriceCents, 0), 0);
    const budgetCents = actor.role === "customer" ? Math.round(merchandise * values.customerBudgetMultiplierBps / 10000) + cycles * 2000
      : actor.role === "reseller" ? values.resellerBudgetCents : 0;
    integer(budgetCents, `${actor.id} budget`);
    resources[actor.id] = { budgetCents, spentCents: 0, purchases: 0, memory: [] };
    if (["customer", "reseller"].includes(actor.role)) actor.facts.push(fact("initialBudgetCents", budgetCents, "USD_cents", [], [actor.role === "customer" ? "a-budget" : "a-reseller-budget"]));
  }
  const snapshot = { schemaVersion: 1, importerVersion: "adventureworks-bounded-v1", sourceType: source.sourceType, asOf: source.asOf,
    units: { money: "USD_cents", stock: "units", orderGrain: "distinct SalesOrderNumber per CustomerKey", time: "shopping_cycle" },
    sourceFiles: source.sourceFiles, entityCounts: {
      customers: actors.filter(actor => actor.role === "customer").length, employees: actors.filter(actor => actor.role === "employee").length,
      suppliers: actors.filter(actor => actor.role === "supplier").length, resellers: actors.filter(actor => actor.role === "reseller").length,
      products: source.products.length, historicalOrders: source.historicalOrders.length,
    }, coverage: source.coverage, products: source.products, historicalOrders: source.historicalOrders, evidenceHash: stableHash(source.evidence) };
  snapshot.hash = stableHash(snapshot); snapshot.snapshotId = `snapshot-${snapshot.hash.slice(0, 24)}`;
  const graph = { schemaVersion: 1, edges: [], assumptionIds: ["a-influence"] };
  graph.hash = stableHash(graph); graph.graphId = `graph-${graph.hash.slice(0, 24)}`;
  const initialState = { schemaVersion: 1, completedRounds: 0, inventory: Object.fromEntries(source.products.map(product => [product.id, values.stockPerProductUnits])),
    resources, pendingDeliveries: [], pendingCapacity: [], replenishmentRequests: [], ledgerEvents: [],
    baseCapacity: values.panelCapacityPerCycle, availableCapacity: values.panelCapacityPerCycle,
    assumptionIds: ["a-stock", "a-capacity", "a-budget", "a-reseller-budget", "a-arbitration"] };
  const inputs = { snapshot, actors, graph, initialState, opportunities, evidence: source.evidence, assumptions,
    populationHash: stableHash(actors), initialStateHash: stableHash(initialState), externalEventsHash: stableHash(opportunities) };
  inputs.populationId = `panel-${inputs.populationHash.slice(0, 24)}`;
  inputs.initialStateId = `state-${inputs.initialStateHash.slice(0, 24)}`;
  inputs.integrityHash = stableHash(inputs);
  const plannedActions = actors.length * scenarios.length * cycles;
  const runConfig = { provider: "copilot", model: null, concurrency: actors.length > 32 ? 2 : 4, attemptCap: Math.min(1000, Math.max(320, plannedActions * 2 + 1)), deadlineMs: 900000,
    callTimeoutMs: 60000, repetitions: 1, ...(input.runConfig || {}) };
  validateRunConfig(runConfig, plannedActions);
  const constraints = clone(input.constraints || []);
  validateConstraints(constraints);
  const objective = normalizeObjective(input.objective);
  const definition = { experimentId: `experiment-${randomUUID()}`, version: 1, schemaVersion: 1,
    title: text(input.title ?? "Shipping-policy experiment", "title", 160, 1), decisionText, owner: "local_user", status: "ready",
    objective, constraints,
    snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash, asOf: snapshot.asOf,
    domainAdapter: "shipping-policy", adapterVersion: ADAPTER_VERSION, promptVersion: PROMPT_VERSION,
    capabilities: CAPABILITIES, scenarios, baselineScenarioId: "baseline", populationId: inputs.populationId, graphId: graph.graphId,
    initialStateId: inputs.initialStateId, horizon: { steps: cycles, unit: "shopping_cycle",
      interpretation: "One modeled purchase opportunity per eligible panel buyer per cycle, not a day or year. Unweighted panel only; no annualization." },
    metricDefinitions: clone(METRIC_DEFINITIONS), assumptionIds: assumptions.map(item => item.assumptionId), runConfig, seed };
  definition.comparisonKey = comparisonKey(definition, inputs);
  definition.definitionHash = stableHash(definition);
  const warnings = [...parsed.warnings,
    "Sample-record and synthetic model responses are hypotheses; no individual-twin or behavioral accuracy validation has been performed.",
    "Historical baskets, prices and standard costs are assigned scenario inputs; panel stock, budgets, supply links, capacity and opportunity frequency are explicit assumptions.",
    "H0 operations are limited to next-cycle capacity, stock requests, delayed supplier dispatch, escalation and constrained equal-price reseller orders."];
  if (values.fulfillmentCostPerOrderCents === null) warnings.push("Fulfillment cost is unknown. Contribution is unavailable for scenarios with fulfilled orders until an explicit cost is supplied in a new experiment.");
  if (values.incrementalLaborRateCentsPerHour === null) warnings.push("Incremental labor rate is unknown. Capacity requests make contribution unknown rather than assuming free additional work.");
  for (const [role, requested] of Object.entries(counts)) {
    const actual = actors.filter(actor => actor.role === role).length;
    if (actual < requested) warnings.push(`Requested ${requested} ${role} actors, instantiated ${actual} eligible source records.`);
  }
  validateExperiment(definition, inputs);
  return { definition: freeze(definition), inputs: freeze(inputs), questions: parsed.questions.slice(0, 3), warnings,
    estimate: { plannedActions, maxAttempts: Math.min(runConfig.attemptCap, plannedActions * 2 + 1) } };
}
export function prepareExperiment(input = {}, preparation = {}) { return prepare(input, false, preparation); }
export function prepareSyntheticFixture(input = {}, preparation = {}) { return prepare(input, true, preparation); }

export function validateExperiment(definition, inputs) {
  object(definition, "definition"); object(inputs, "inputs");
  check(canonical({ definition, inputs }).length <= 3_000_000, "Experiment exceeds 3 MB serialized bound");
  keys(definition, ["experimentId", "version", "schemaVersion", "title", "decisionText", "owner", "status", "objective", "constraints",
    "snapshotId", "snapshotHash", "asOf", "domainAdapter", "adapterVersion", "promptVersion", "capabilities", "scenarios", "baselineScenarioId",
    "populationId", "graphId", "initialStateId", "horizon", "metricDefinitions", "assumptionIds", "runConfig", "seed",
    "comparisonKey", "definitionHash", "parentExperimentId", "parentVersion"], "definition");
  keys(inputs, ["snapshot", "actors", "graph", "initialState", "opportunities", "evidence", "assumptions", "populationHash",
    "initialStateHash", "externalEventsHash", "populationId", "initialStateId", "integrityHash"], "inputs");
  check(/^experiment-[A-Za-z0-9-]{1,80}$/.test(definition.experimentId), "Invalid experimentId");
  integer(definition.version, "version", 1, 10000); text(definition.title, "title", 160, 1); text(definition.decisionText, "decisionText", 4000);
  text(definition.seed, "seed", 120, 1); check(definition.owner === "local_user", "Unsupported experiment owner");
  if (definition.version === 1) check(definition.parentVersion === undefined && definition.parentExperimentId === undefined, "First version cannot have a parent");
  else {
    integer(definition.parentVersion, "parentVersion", 1, definition.version - 1);
    check(definition.parentExperimentId === definition.experimentId, "Invalid branch lineage");
  }
  check(definition.schemaVersion === 1 && definition.status === "ready", "Unsupported experiment schema/status");
  check(definition.domainAdapter === "shipping-policy" && definition.adapterVersion === ADAPTER_VERSION && SUPPORTED_PROMPT_VERSIONS.includes(definition.promptVersion), "Unsupported adapter/prompt version");
  check(stableHash(definition.capabilities) === stableHash(CAPABILITIES), "Unsupported role capabilities");
  check(stableHash(definition.metricDefinitions) === stableHash(METRIC_DEFINITIONS), "Metric definitions were changed");
  check(stableHash(definition.objective) === stableHash(normalizeObjective(definition.objective)), "Objective definition must be fully normalized");
  validateConstraints(definition.constraints);
  keys(definition.horizon, ["steps", "unit", "interpretation"], "horizon");
  integer(definition.horizon.steps, "horizon.steps", 1, 3); check(definition.horizon.unit === "shopping_cycle", "Horizon must use shopping_cycle");
  text(definition.horizon.interpretation, "horizon interpretation", 1000, 1);
  array(definition.scenarios, "scenarios", 3, 2); unique(definition.scenarios.map(item => item.scenarioId), "scenarios");
  const baseline = definition.scenarios.find(scenario => scenario.scenarioId === definition.baselineScenarioId);
  check(baseline?.isBaseline && definition.scenarios.filter(scenario => scenario.isBaseline).length === 1, "Exactly one baseline required");
  for (const [index, scenario] of definition.scenarios.entries()) {
    keys(scenario, ["scenarioId", "label", "isBaseline", "policy", "interventions", "originalText"], "scenario");
    check(scenario.scenarioId === (index === 0 ? "baseline" : `option-${index}`), "Invalid stable scenario ID/order");
    text(scenario.label, "scenario label", 120, 1); text(scenario.originalText, "scenario originalText", 4000);
    check(typeof scenario.isBaseline === "boolean", "Invalid baseline flag");
    policy(scenario.policy, "policy");
    const expected = scenario.isBaseline ? [] : normalizeOption({ label: scenario.label, ...scenario.policy }, index - 1, baseline.policy, scenario.originalText).interventions;
    check(stableHash(scenario.interventions) === stableHash(expected), "Interventions do not match normalized policy");
  }
  const snapshot = inputs.snapshot;
  object(snapshot, "snapshot"); array(snapshot.products, "products", 128, 1); array(snapshot.historicalOrders, "historicalOrders", 96, 1);
  keys(snapshot, ["schemaVersion", "importerVersion", "sourceType", "asOf", "units", "sourceFiles", "entityCounts", "coverage",
    "products", "historicalOrders", "evidenceHash", "hash", "snapshotId"], "snapshot");
  check(["AdventureWorks_sample", "synthetic_test_fixture"].includes(snapshot.sourceType), "Unsupported snapshot sourceType");
  check(snapshot.schemaVersion === 1 && snapshot.importerVersion === "adventureworks-bounded-v1", "Unsupported snapshot version");
  check(snapshot.hash === stableHash(omit(snapshot, "hash", "snapshotId")), "Snapshot hash mismatch");
  check(snapshot.snapshotId === `snapshot-${snapshot.hash.slice(0, 24)}`, "Snapshot ID/hash mismatch");
  check(definition.snapshotHash === snapshot.hash && definition.snapshotId === snapshot.snapshotId && definition.asOf === snapshot.asOf, "Definition snapshot mismatch");
  check(/^\d{4}-\d{2}-\d{2}$/.test(snapshot.asOf) && Number.isFinite(Date.parse(snapshot.asOf)), "Invalid snapshot asOf");
  check(snapshot.coverage.maxOrderDate === snapshot.asOf && snapshot.coverage.minOrderDate <= snapshot.asOf, "Source date coverage mismatch");
  check(snapshot.coverage.sampleDataNotRealPeople === true && snapshot.coverage.behavioralValidation === "not_performed"
    && snapshot.coverage.demographicPreferenceInference === false, "Invalid sample-data/validation labeling");
  for (const key of ["sourceOrderLines", "sourceDistinctOrders", "retainedHistoricalOrders", "retainedHistoricalLines"]) integer(snapshot.coverage[key], `coverage.${key}`, 1, 100000);
  check(snapshot.coverage.sourceDistinctOrders <= snapshot.coverage.sourceOrderLines, "Order grain coverage inconsistent");
  check(snapshot.coverage.retainedHistoricalOrders === snapshot.historicalOrders.length
    && snapshot.coverage.retainedHistoricalLines === snapshot.historicalOrders.reduce((sum, order) => sum + array(order.lines, "historical lines", 12, 1).length, 0), "Retained history coverage inconsistent");
  array(snapshot.sourceFiles, "sourceFiles", 6);
  unique(snapshot.sourceFiles.map(file => file.file), "source files");
  if (snapshot.sourceType === "AdventureWorks_sample") {
    check(snapshot.sourceFiles.length === Object.keys(SOURCE_HASHES).length, "Missing pinned source files");
    for (const file of snapshot.sourceFiles) {
      keys(file, ["file", "sha256", "rows", "sourceCommit"], "source file");
      check(SOURCE_HASHES[file.file] === file.sha256, "Source file SHA256 is not the pinned download");
      integer(file.rows, "source file rows", 1, 100000);
      check(file.sourceCommit === "1ab31bc560415b570d57bb5ff9896f4698891321", "Unexpected sample source commit");
    }
  } else check(snapshot.sourceFiles.length === 0 && snapshot.coverage.fixtureOnly === true, "Synthetic fixture must not claim source files");
  array(inputs.evidence, "evidence", 5000, 1); unique(inputs.evidence.map(item => item.evidenceId), "evidence");
  array(inputs.assumptions, "assumptions", 40, 1); unique(inputs.assumptions.map(item => item.assumptionId), "assumptions");
  const evidenceIds = new Set(inputs.evidence.map(item => item.evidenceId)), assumptionIds = new Set(inputs.assumptions.map(item => item.assumptionId));
  array(snapshot.coverage.evidenceIds, "coverage evidenceIds", 10, 1);
  check(snapshot.coverage.evidenceIds.every(id => evidenceIds.has(id)), "Invalid source coverage evidence");
  check(stableHash(inputs.evidence) === snapshot.evidenceHash, "Evidence hash mismatch");
  const files = new Map(snapshot.sourceFiles.map(file => [file.file, file]));
  for (const evidence of inputs.evidence) {
    keys(evidence, ["evidenceId", "sourceTable", "sourceFile", "sourceFileSha256", "row", "entityKey", "field", "value",
      "unit", "sourceTimestamp", "transformation", "quality", "sourceType"], "evidence");
    text(evidence.evidenceId, "evidence ID", 80, 1); text(evidence.field, "evidence field", 160, 1);
    text(evidence.entityKey, "evidence entity key", 160, 1); text(evidence.transformation, "evidence transformation", 500, 1);
    check(evidence.sourceType === snapshot.sourceType, "Evidence source type differs from snapshot");
    if (snapshot.sourceType === "AdventureWorks_sample") {
      const file = files.get(evidence.sourceFile);
      check(file && evidence.sourceFileSha256 === file.sha256 && evidence.sourceTable === file.file.replace(".csv", ""), "Evidence file/hash/table mismatch");
      integer(evidence.row, "evidence row", 1, file.rows);
      check(evidence.quality === "sample_business_data", "Incorrect sample evidence quality");
    } else check(evidence.quality === "synthetic" && evidence.sourceFile === null && evidence.row === null && evidence.sourceFileSha256 === null, "Incorrect synthetic evidence provenance");
  }
  check(stableHash(definition.assumptionIds) === stableHash(inputs.assumptions.map(item => item.assumptionId)), "Assumption IDs mismatch");
  const refs = (item, label) => {
    array(item.evidenceIds, `${label} evidenceIds`, 1000); array(item.assumptionIds, `${label} assumptionIds`, 40);
    check(item.evidenceIds.length + item.assumptionIds.length > 0, `${label} lacks provenance`);
    check(item.evidenceIds.every(id => evidenceIds.has(id)) && item.assumptionIds.every(id => assumptionIds.has(id)), `${label} has unauthorized evidence/assumption IDs`);
  };
  unique(inputs.assumptions.map(item => item.key), "assumption keys");
  check(inputs.assumptions.length === Object.keys(ASSUMPTION_IDS).length + ADAPTER_ASSUMPTIONS.length, "Unexpected assumption set");
  for (const assumption of inputs.assumptions) {
    keys(assumption, ["assumptionId", "key", "description", "value", "rationale", "owner", "approvalState", "source", "affectedMetrics", "presetId"], "assumption");
    text(assumption.description, "assumption description", 1000, 1);
    if (assumption.source === "preset") {
      check(assumption.owner === "simulation_preset" && assumption.approvalState === "not_reviewed"
        && assumption.presetId === CONVERSATION_PRESET && assumption.rationale === PRESET_RATIONALE
        && Object.hasOwn(ASSUMPTION_DEFAULTS, assumption.key), "Invalid automatic preset metadata");
      const expected = { ...ASSUMPTION_DEFAULTS, panelCapacityPerCycle: snapshot.entityCounts.customers + snapshot.entityCounts.resellers, ...CONVERSATION_COSTS };
      check(assumption.value === expected[assumption.key], "Automatic preset value differs from its declared preset");
    } else {
      check(!Object.hasOwn(assumption, "presetId") && assumption.owner === "experiment_owner" && assumption.approvalState === "review_required"
        && ["user", "adapter_default"].includes(assumption.source), "Invalid assumption metadata");
    }
    check(stableHash(assumption.affectedMetrics) === stableHash(METRIC_DEFINITIONS.map(metric => metric.metricId)), "Invalid assumption metric coverage");
    if (Object.hasOwn(ASSUMPTION_IDS, assumption.key)) {
      check(assumption.assumptionId === ASSUMPTION_IDS[assumption.key] && assumption.description === DESCRIPTIONS[assumption.key], "Operating assumption ID/definition mismatch");
    } else {
      const expected = ADAPTER_ASSUMPTIONS.find(([id]) => id === assumption.key);
      check(expected && assumption.assumptionId === expected[0] && assumption.description === expected[1]
        && stableHash(assumption.value) === stableHash(expected[2]), "Adapter assumption differs from declared H0 mechanics");
    }
  }
  if (inputs.assumptions.some(item => item.source === "preset")) {
    check(inputs.assumptions.filter(item => Object.hasOwn(ASSUMPTION_DEFAULTS, item.key)).every(item => item.source === "preset"),
      "Automatic preset assumptions must remain a complete declared set");
  }
  const values = Object.fromEntries(inputs.assumptions.filter(item => Object.hasOwn(ASSUMPTION_DEFAULTS, item.key)).map(item => [item.key, item.value]));
  check(Object.keys(values).length === Object.keys(ASSUMPTION_DEFAULTS).length, "Missing operating assumptions"); validateAssumptionValues(values);
  unique(snapshot.products.map(item => item.id), "products");
  for (const product of snapshot.products) {
    keys(product, ["id", "label", "unitPriceCents", "unitCostCents", "evidenceIds", "costEvidenceIds", "assumptionIds"], "product");
    check(/^product-[A-Za-z0-9-]+$/.test(product.id), "Invalid product ID");
    text(product.label, "product label", 200, 1); integer(product.unitPriceCents, "unit price");
    if (product.unitCostCents !== null) integer(product.unitCostCents, "unit cost");
    refs(product, "product"); array(product.costEvidenceIds, "product costEvidenceIds", 10, 1); check(product.costEvidenceIds.every(id => evidenceIds.has(id)), "Invalid product cost evidence");
  }
  array(inputs.actors, "actors", 63, 1); unique(inputs.actors.map(actor => actor.id), "actors");
  if (inputs.actors.length > 32) check(definition.runConfig.concurrency <= 2, "Business panels are limited to two concurrent requests");
  for (const role of Object.keys(CAPABILITIES)) {
    const count = inputs.actors.filter(actor => actor.role === role).length;
    integer(count, `${role} count`, role === "customer" ? 1 : 0, PANEL_LIMITS[role]);
    if (snapshot.coverage.population) {
      const population = snapshot.coverage.population[role];
      object(population, `${role} population`);
      integer(population.source, `${role} source population`, 0, 100000);
      integer(population.eligible, `${role} eligible population`, count, population.source);
      check(population.selected === count, `${role} selected population mismatch`);
    }
  }
  for (const actor of inputs.actors) {
    keys(actor, ["id", "role", "label", "profileMode", "sourceEntityIds", "facts", "unknowns", "feasibleActions"], "actor");
    check(Object.hasOwn(CAPABILITIES, actor.role), "Invalid actor role");
    check(new RegExp(`^${actor.role}-[A-Za-z0-9-]+$`).test(actor.id), "Invalid actor ID");
    check(["individual", "cohort", "synthetic"].includes(actor.profileMode), "Invalid profile mode");
    check(actor.profileMode !== "cohort", "H0 uses explicit individual or synthetic actors, not weighted cohorts");
    check(actor.profileMode === (snapshot.sourceType === "synthetic_test_fixture" ? "synthetic" : "individual"), "Profile mode is inconsistent with snapshot");
    text(actor.label, "actor label", 200, 1); array(actor.facts, "facts", 20, 1); actor.facts.forEach(f => {
      keys(f, ["field", "value", "unit", "evidenceIds", "assumptionIds"], "fact");
      refs(f, "fact");
    });
    unique(actor.facts.map(fact => fact.field), "actor fact fields");
    if (actor.role === "customer") check(actor.facts.find(fact => fact.field === "existingCustomer")?.value === true, "Customer eligibility must match historical panel");
    array(actor.sourceEntityIds, "sourceEntityIds", 10, 1); array(actor.unknowns, "unknowns", 20);
    check(stableHash(actor.feasibleActions) === stableHash(CAPABILITIES[actor.role]), "Invalid feasible actions");
  }
  check(stableHash(inputs.actors) === inputs.populationHash && inputs.populationId === `panel-${inputs.populationHash.slice(0, 24)}` && definition.populationId === inputs.populationId, "Population hash/ID mismatch");
  keys(inputs.graph, ["schemaVersion", "edges", "assumptionIds", "hash", "graphId"], "graph");
  array(inputs.graph.edges, "graph edges", 0);
  check(inputs.graph.schemaVersion === 1 && stableHash(inputs.graph.assumptionIds) === stableHash(["a-influence"]), "Invalid graph provenance/version");
  check(inputs.graph.hash === stableHash(omit(inputs.graph, "hash", "graphId")) && inputs.graph.graphId === `graph-${inputs.graph.hash.slice(0, 24)}` && definition.graphId === inputs.graph.graphId, "Graph hash/ID mismatch");
  check(inputs.initialStateHash === stableHash(inputs.initialState) && inputs.initialStateId === `state-${inputs.initialStateHash.slice(0, 24)}` && definition.initialStateId === inputs.initialStateId, "Initial state hash/ID mismatch");
  const initial = inputs.initialState;
  keys(initial, ["schemaVersion", "completedRounds", "inventory", "resources", "pendingDeliveries", "pendingCapacity",
    "replenishmentRequests", "ledgerEvents", "baseCapacity", "availableCapacity", "assumptionIds"], "initialState");
  check(initial.schemaVersion === 1, "Invalid initial state schema version");
  for (const key of ["ledgerEvents", "pendingDeliveries", "pendingCapacity", "replenishmentRequests"]) array(initial[key], `initialState.${key}`, 0);
  check(initial.completedRounds === 0 && initial.ledgerEvents.length === 0 && initial.pendingDeliveries.length === 0 && initial.pendingCapacity.length === 0 && initial.replenishmentRequests.length === 0, "Initial state contains prior effects");
  check(initial.baseCapacity === values.panelCapacityPerCycle && initial.availableCapacity === initial.baseCapacity, "Initial capacity mismatch");
  check(stableHash(Object.keys(initial.resources).sort()) === stableHash(inputs.actors.map(actor => actor.id).sort()), "Initial actor resources mismatch");
  check(stableHash(Object.keys(initial.inventory).sort()) === stableHash(snapshot.products.map(product => product.id).sort()), "Initial inventory IDs mismatch");
  for (const amount of Object.values(initial.inventory)) check(amount === values.stockPerProductUnits, "Initial stock differs from assumption");
  for (const resource of Object.values(initial.resources)) {
    keys(resource, ["budgetCents", "spentCents", "purchases", "memory"], "initial resources");
    integer(resource.budgetCents, "initial budget"); check(resource.spentCents === 0 && resource.purchases === 0 && resource.memory.length === 0, "Initial resources contain prior effects");
  }
  const buyers = inputs.actors.filter(actor => ["customer", "reseller"].includes(actor.role));
  array(inputs.opportunities, "opportunities", 108, 1);
  check(inputs.opportunities.length === buyers.length * definition.horizon.steps, "Opportunity schedule incomplete");
  unique(inputs.opportunities.map(op => `${op.actorId}:${op.round}`), "opportunity actor/round");
  unique(inputs.opportunities.map(op => op.opportunityId), "opportunities");
  const products = new Map(snapshot.products.map(product => [product.id, product]));
  unique(snapshot.historicalOrders.map(order => order.id), "historical orders");
  for (const order of snapshot.historicalOrders) {
    keys(order, ["id", "actorId", "sourceOrderId", "date", "lines"], "historical order");
    check(inputs.actors.some(actor => actor.id === order.actorId && actor.role === "customer"), "Invalid historical order actor");
    check(order.date >= snapshot.coverage.minOrderDate && order.date <= snapshot.asOf, "Historical order falls outside date coverage");
    for (const line of order.lines) {
      keys(line, ["productId", "quantity", "historicalUnitPriceCents", "evidenceIds"], "historical line");
      check(products.has(line.productId), "Invalid historical product ID");
      integer(line.quantity, "historical quantity", 1, 20); integer(line.historicalUnitPriceCents, "historical unit price");
      array(line.evidenceIds, "historical evidence", 10, 1); check(line.evidenceIds.every(id => evidenceIds.has(id)), "Invalid historical line evidence");
    }
  }
  const expectedCounts = { customers: inputs.actors.filter(actor => actor.role === "customer").length, employees: inputs.actors.filter(actor => actor.role === "employee").length,
    suppliers: inputs.actors.filter(actor => actor.role === "supplier").length, resellers: inputs.actors.filter(actor => actor.role === "reseller").length,
    products: snapshot.products.length, historicalOrders: snapshot.historicalOrders.length };
  check(stableHash(snapshot.entityCounts) === stableHash(expectedCounts), "Snapshot entity counts mismatch");
  for (const opportunity of inputs.opportunities) {
    keys(opportunity, ["opportunityId", "actorId", "round", "basket", "allowedProductIds", "sourceOrderId", "evidenceIds", "assumptionIds"], "opportunity");
    check(buyers.some(actor => actor.id === opportunity.actorId), "Unauthorized opportunity actor");
    integer(opportunity.round, "opportunity round", 1, definition.horizon.steps);
    check(opportunity.opportunityId === `opportunity-${opportunity.actorId}-${opportunity.round}`, "Invalid stable opportunity ID");
    array(opportunity.basket, "basket", 12, 1); unique(opportunity.basket.map(item => item.productId), "basket products");
    array(opportunity.allowedProductIds, "allowedProductIds", 16, 1); unique(opportunity.allowedProductIds, "allowed products");
    check(opportunity.allowedProductIds.every(id => products.has(id)), "Unauthorized opportunity product");
    check(opportunity.basket.reduce((sum, item) => sum + item.quantity, 0) <= 20, "Opportunity basket exceeds 20 units");
    for (const item of opportunity.basket) {
      keys(item, ["productId", "quantity", "unitPriceCents"], "basket item");
      check(opportunity.allowedProductIds.includes(item.productId), "Basket not in allowed choices"); integer(item.quantity, "basket quantity", 1, 20);
      check(item.unitPriceCents === products.get(item.productId)?.unitPriceCents, "Basket price mismatch");
    }
    refs(opportunity, "opportunity");
    if (inputs.actors.find(actor => actor.id === opportunity.actorId).role === "customer") {
      const historical = snapshot.historicalOrders.find(order => order.actorId === opportunity.actorId && order.sourceOrderId === opportunity.sourceOrderId);
      check(historical, "Opportunity does not refer to this customer's retained historical order");
      const quantities = historical.lines.reduce((map, item) => ({ ...map, [item.productId]: (map[item.productId] || 0) + item.quantity }), {});
      check(stableHash(quantities) === stableHash(Object.fromEntries(opportunity.basket.map(item => [item.productId, item.quantity]))), "Opportunity quantities do not match the retained historical basket");
    } else check(opportunity.sourceOrderId === null, "Synthetic reseller opportunity cannot claim a historical order");
  }
  for (const actor of inputs.actors) {
    const merchandise = inputs.opportunities.filter(opportunity => opportunity.actorId === actor.id).reduce((sum, op) => sum + op.basket.reduce((subtotal, item) => subtotal + item.quantity * item.unitPriceCents, 0), 0);
    const expectedBudget = actor.role === "customer" ? Math.round(merchandise * values.customerBudgetMultiplierBps / 10000) + definition.horizon.steps * 2000
      : actor.role === "reseller" ? values.resellerBudgetCents : 0;
    check(initial.resources[actor.id].budgetCents === expectedBudget, "Initial budget differs from explicit assumption");
    if (["customer", "reseller"].includes(actor.role)) check(actor.facts.find(fact => fact.field === "initialBudgetCents")?.value === expectedBudget, "Actor budget fact differs from resources");
  }
  check(inputs.externalEventsHash === stableHash(inputs.opportunities), "Opportunity hash mismatch");
  validateRunConfig(definition.runConfig, inputs.actors.length * definition.scenarios.length * definition.horizon.steps);
  check(definition.comparisonKey === comparisonKey(definition, inputs), "Comparison key mismatch");
  check(inputs.integrityHash === stableHash(omit(inputs, "integrityHash")), "Input integrity hash mismatch");
  check(definition.definitionHash === stableHash(omit(definition, "definitionHash")), "Definition integrity hash mismatch");
  return definition;
}

export function reviseExperiment(definition, inputs, patch) {
  validateExperiment(definition, inputs);
  keys(patch, ["decisionText", "options", "title"], "revision");
  const next = clone(definition);
  const decisionText = text(patch.decisionText ?? definition.decisionText, "decisionText", 4000);
  const baseline = next.scenarios[0];
  const parsed = parseText(decisionText, baseline.policy, next.scenarios.slice(1).map(scenario => ({ label: scenario.label, ...scenario.policy })));
  const options = patch.options ?? parsed.options;
  array(options, "options", 2, 1);
  next.scenarios = [baseline, ...options.map((option, index) => normalizeOption(option, index, baseline.policy, decisionText))];
  next.decisionText = decisionText; next.title = text(patch.title ?? next.title, "title", 160, 1);
  next.version++; next.parentExperimentId = definition.experimentId; next.parentVersion = definition.version;
  next.definitionHash = stableHash(omit(next, "definitionHash"));
  validateExperiment(next, inputs);
  return { definition: freeze(next), inputs, questions: parsed.questions, warnings: [...parsed.warnings, "Fresh counterfactual: all frozen inputs and baseline policies are unchanged; baseline is simulated again."],
    estimate: { plannedActions: inputs.actors.length * next.scenarios.length * next.horizon.steps,
      maxAttempts: Math.min(next.runConfig.attemptCap, inputs.actors.length * next.scenarios.length * next.horizon.steps * 2 + 1) } };
}

export function assumptionValues(inputs) {
  return Object.fromEntries(inputs.assumptions.filter(item => Object.hasOwn(ASSUMPTION_DEFAULTS, item.key)).map(item => [item.key, item.value]));
}
