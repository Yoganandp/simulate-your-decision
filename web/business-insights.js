export const STAKEHOLDER_GROUPS = [
  { id: 'customer', label: 'Customers', short: 'Customer', role: 'customer' },
  { id: 'leadership', label: 'Leadership', short: 'Leader', role: 'employee' },
  { id: 'management', label: 'Management', short: 'Manager', role: 'employee' },
  { id: 'frontline', label: 'Frontline & operations', short: 'Operations', role: 'employee' },
  { id: 'supplier', label: 'Suppliers', short: 'Supplier', role: 'supplier' },
  { id: 'reseller', label: 'Resellers', short: 'Reseller', role: 'reseller' },
];

export function employeeGroup(title = '', department = '') {
  if (department === 'Executive' || /chief|president|vice president|director/i.test(title)) return 'leadership';
  if (/manager|supervisor|lead/i.test(title)) return 'management';
  return 'frontline';
}

export function stakeholderGroup(actor) {
  if (actor.role !== 'employee') return actor.role;
  const fact = key => actor.facts?.find(item => item.field === key)?.value;
  return employeeGroup(fact('jobTitle'), fact('department'));
}

export const BUSINESS_SECTIONS = [
  { id: 'finance', title: 'The economics', note: 'Recorded revenue and declared costs. Contribution is not net profit.', rows: [
    ['productRevenue', 'Product revenue', 'USD_cents'],
    ['shippingRevenue', 'Shipping collected', 'USD_cents'],
    ['costOfGoodsSold', 'Cost of goods', 'USD_cents'],
    ['shippingCost', 'Fulfillment cost', 'USD_cents'],
    ['incrementalLaborCost', 'Incremental labor cost', 'USD_cents'],
    ['contribution', 'Contribution', 'USD_cents'],
  ] },
  { id: 'customers', title: 'Customer choices', note: 'Observed in this simulation, not measured satisfaction, retention or churn.', rows: [
    ['customerOrders', 'Fulfilled customer orders', 'orders'],
    ['customerReach', 'Distinct purchasing customers', 'people'],
    ['conversion', 'Customer opportunities fulfilled', 'ratio'],
    ['abandonments', 'Explicit abandonments', 'opportunities'],
    ['deferrals', 'Customer & reseller deferrals', 'opportunities'],
    ['extraItems', 'Additional items purchased', 'units'],
  ] },
  { id: 'operations', title: 'Fulfillment & workforce', note: 'Labor and capacity are preset operating assumptions, not employee morale scores.', rows: [
    ['purchases', 'All fulfilled orders', 'orders'],
    ['stockouts', 'Orders blocked by stock', 'opportunities'],
    ['capacityBlocked', 'Orders blocked by capacity', 'opportunities'],
    ['laborMinutes', 'Additional work scheduled', 'minutes'],
    ['capacityScheduled', 'Extra order slots scheduled', 'slots'],
    ['capacityApplied', 'Extra slots available in horizon', 'slots'],
    ['escalations', 'Issues escalated', 'issues'],
  ] },
  { id: 'supply', title: 'Supply chain & partners', note: 'Dispatch is not delivery. Requests and arrivals are counted separately.', rows: [
    ['supplyRequests', 'Replenishment requests', 'requests'],
    ['unitsDispatched', 'Replenishment units scheduled', 'units'],
    ['unitsArrived', 'Replenishment units arrived', 'units'],
    ['supplyDeclines', 'Requests declined', 'requests'],
    ['resellerOrders', 'Fulfilled reseller orders', 'orders'],
    ['resellerRevenue', 'Reseller product revenue', 'USD_cents'],
  ] },
];

export function businessHighlights(insights, comparable = false) {
  const definitions = [
    ['contribution', 'Contribution', 'USD_cents', 1],
    ['customerOrders', 'Customer orders', 'orders', 1],
    ['stockouts', 'Orders out of stock', 'opportunities', -1],
    ['incrementalLaborCost', 'Extra labor cost', 'USD_cents', -1],
    ['unitsArrived', 'Replenishment arrived', 'units', 0],
    ['resellerRevenue', 'Reseller revenue', 'USD_cents', 1],
  ];
  const matched = comparable && insights.scenarios.length === 2 && insights.scenarios.every(scenario => scenario.complete);
  return definitions.map(([id, label, unit, direction]) => {
    const values = insights.scenarios.map(scenario => ({ scenarioId: scenario.scenarioId, scenarioLabel: scenario.label,
      ...scenario.values[id] }));
    const delta = matched && values.every(item => Number.isFinite(item.value)) ? values[1].value - values[0].value : null;
    return { id, label, unit, values, delta,
      tone: delta === null || delta === 0 || !direction ? 'neutral' : delta * direction > 0 ? 'improve' : 'worsen' };
  });
}

const sum = (events, field) => events.some(event => !Number.isFinite(event[field]))
  ? null : events.reduce((total, event) => total + event[field], 0);

function contribution(events) {
  const purchases = events.filter(event => event.type === 'purchase');
  const labor = events.filter(event => event.type === 'capacity_scheduled');
  const parts = [sum(purchases, 'productRevenueCents'), sum(purchases, 'shippingRevenueCents'),
    sum(purchases, 'costOfGoodsSoldCents'), sum(purchases, 'shippingCostCents'), sum(labor, 'incrementalLaborCostCents')];
  return parts.includes(null) ? null : parts[0] + parts[1] - parts[2] - parts[3] - parts[4];
}

// Only committed rounds feed this read-only view; it never estimates company totals.
export function businessInsights(bundle, results = []) {
  const actors = bundle.inputs.actors, actorMap = new Map(actors.map(actor => [actor.id, actor]));
  const groups = STAKEHOLDER_GROUPS.map(group => ({
    ...group, count: actors.filter(actor => stakeholderGroup(actor) === group.id).length,
  })).filter(group => group.count);
  const steps = bundle.definition.horizon.steps;
  const scenarios = bundle.definition.scenarios.map(scenario => {
    const result = results.find(item => item.scenarioId === scenario.scenarioId);
    const completedRounds = result?.completedRounds || 0;
    const events = (result?.ledgerEvents || []).filter(event => event.round > 0 && event.round <= completedRounds
      && (!event.scenarioId || event.scenarioId === scenario.scenarioId));
    const actions = (result?.actions || []).filter(record => record.round > 0 && record.round <= completedRounds);
    const byType = type => events.filter(event => event.type === type);
    const roleOf = event => actorMap.get(event.actorId)?.role;
    const purchases = byType('purchase'), customers = purchases.filter(event => roleOf(event) === 'customer');
    const resellers = purchases.filter(event => roleOf(event) === 'reseller');
    const opportunities = byType('opportunity').filter(event => roleOf(event) === 'customer');
    const derived = {
      customerOrders: [customers.length, customers],
      customerReach: [new Set(customers.map(event => event.actorId)).size, customers],
      conversion: [opportunities.length ? customers.length / opportunities.length : null, [...customers, ...opportunities]],
      capacityBlocked: [byType('capacity_unavailable').length, byType('capacity_unavailable')],
      laborMinutes: [sum(byType('capacity_scheduled'), 'laborMinutes'), byType('capacity_scheduled')],
      capacityScheduled: [sum(byType('capacity_scheduled'), 'additionalOrders'), byType('capacity_scheduled')],
      capacityApplied: [sum(byType('capacity_applied'), 'additionalOrders'), byType('capacity_applied')],
      escalations: [byType('escalation').length, byType('escalation')],
      supplyRequests: [byType('replenishment_requested').length, byType('replenishment_requested')],
      unitsDispatched: [sum(byType('replenishment_scheduled'), 'quantity'), byType('replenishment_scheduled')],
      unitsArrived: [sum(byType('replenishment_arrived'), 'quantity'), byType('replenishment_arrived')],
      supplyDeclines: [byType('replenishment_declined').length, byType('replenishment_declined')],
      resellerOrders: [resellers.length, resellers],
      resellerRevenue: [sum(resellers, 'productRevenueCents'), resellers],
    };
    const values = {};
    for (const section of BUSINESS_SECTIONS) for (const [id, label, unit] of section.rows) {
      const metric = result?.metrics?.find(item => item.metricId === id);
      const value = metric ? metric.value : derived[id]?.[0];
      values[id] = { id, label, unit, value: completedRounds && Number.isFinite(value) ? value : null,
        available: completedRounds > 0, metricId: metric?.metricId || null,
        eventIds: metric?.contributingEventIds || derived[id]?.[1].map(event => event.eventId) || [] };
    }
    return { ...scenario, completedRounds, complete: result?.complete === true, values,
      rounds: Array.from({ length: steps }, (_, index) => {
        const round = index + 1, saved = round <= completedRounds;
        const ledger = events.filter(event => event.round === round);
        return { round, saved, purchases: saved ? ledger.filter(event => event.type === 'purchase').length : null,
          contribution: saved ? contribution(ledger) : null };
      }),
      groups: groups.map(group => {
        const ids = new Set(actors.filter(actor => stakeholderGroup(actor) === group.id).map(actor => actor.id));
        const records = actions.filter(record => ids.has(record.actorId));
        const blocked = events.filter(event => ids.has(event.actorId) && ['stockout', 'capacity_unavailable'].includes(event.type));
        return { ...group, committed: records.length, planned: group.count * steps,
          changed: records.filter(record => record.action.type !== 'no_action').length,
          noAction: records.filter(record => record.action.type === 'no_action').length, blocked: blocked.length };
      }),
    };
  });
  return { groups, scenarios, population: bundle.inputs.snapshot.coverage?.population || null };
}
