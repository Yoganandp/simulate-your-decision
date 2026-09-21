import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { interpretConversation, prepareConversation } from "../src/sim/conversation.mjs";
import { comparisonKey, prepareExperiment, stableHash, validateExperiment } from "../src/sim/domain.mjs";
import { validateRunConfig } from "../src/sim/runManager.mjs";
import { createAppServer } from "../src/server.mjs";

const interpret = decisionText => interpretConversation({ decisionText });
const policies = decisionText => interpret(decisionText).policies.map(({ thresholdCents, shippingFeeCents }) => [thresholdCents, shippingFeeCents]);
const examples = [
  ["Compare free shipping over $50 with free shipping over $75. Charge $7.95 below either threshold.", [[5000, 795], [7500, 795]]],
  ["What if we offer free shipping over $75 instead of $100? Keep the fee at $5.95.", [[7500, 595], [10000, 595]]],
  ["Option A: free shipping over $50, otherwise $7.95. Option B: free shipping over $75, otherwise $3.95.", [[5000, 795], [7500, 395]]],
  ["Compare a $50 free-shipping threshold with a $100 threshold", [[5000, 795], [10000, 795]]],
  ["Compare free shipping on every order with free shipping over $75", [[0, 795], [7500, 795]]],
  ["Compare free shipping on every order with free shipping over $75. Charge $7.95 below the $75 threshold.", [[0, 795], [7500, 795]]],
  ["Compare free shipping over $50 with free shipping over $75. Charge $3.95 below the $75 threshold.", [[5000, 795], [7500, 395]]],
  ["Compare free shipping over $50 with free shipping over $75. Charge $3.95 under $50, and $5.95 below $75.", [[5000, 395], [7500, 595]]],
  ["Compare $75 and $100 free shipping thresholds", [[7500, 795], [10000, 795]]],
  ["Compare $50 versus $75 free-shipping thresholds, with a $5.95 shipping fee.", [[5000, 595], [7500, 595]]],
  ["Compare free shipping above $50 ($7.95 below) against free shipping above $75 ($3.95 below).", [[5000, 795], [7500, 395]]],
  ["Compare free shipping over $50, otherwise $3.95, with free shipping over $75.", [[5000, 395], [7500, 795]]],
  ["Compare free shipping over $50 with free shipping over $75, otherwise $3.95.", [[5000, 795], [7500, 395]]],
  ["Compare free shipping over $50 with free shipping over $75 ($3.95 below).", [[5000, 795], [7500, 395]]],
  ["Option A: free shipping over $50. Option B: free shipping over $75, otherwise $3.95.", [[5000, 795], [7500, 395]]],
  ["Option A: free shipping over $50, otherwise $3.95. Option B: free shipping over $75.", [[5000, 395], [7500, 795]]],
  ["Option A: free shipping over $50. Option B: free shipping over $75. Keep the shipping fee at $5.95.", [[5000, 595], [7500, 595]]],
  ["Option A: free shipping over $50; keep the fee at $7.95. Option B: free shipping over $75; fee at $3.95.", [[5000, 795], [7500, 395]]],
  ["Compare free shipping over $50 and free shipping over $75. Both have a $0 shipping fee.", [[5000, 0], [7500, 0]]],
  ["Change the free-shipping threshold from $50 to $75. Keep the fee at $7.95.", [[5000, 795], [7500, 795]]],
  ["Compare free shipping for all orders with a $100 shipping threshold.", [[0, 795], [10000, 795]]],
  ["Compare unconditional free shipping versus a $75 threshold.", [[0, 795], [7500, 795]]],
  ["Compare free shipping with no minimum with free shipping above $75.", [[0, 795], [7500, 795]]],
  ["Compare free shipping at least USD 50 with free shipping at least 75 dollars; fee at USD 5.95.", [[5000, 595], [7500, 595]]],
  ["Compare free shipping over US$50 with free shipping over USD $75.", [[5000, 795], [7500, 795]]],
  ["Compare $50.25 and $75.50 free-shipping thresholds; charge $7.05 below either.", [[5025, 705], [7550, 705]]],
  ["Compare $1,000 and $1,500 free shipping thresholds.", [[100000, 795], [150000, 795]]],
  ["Compare free shipping over 50 with free shipping over 75; fee at 5.95.", [[5000, 595], [7500, 595]]],
  ["Free shipping: Option A: $50. Option B: $75.", [[5000, 795], [7500, 795]]],
  ["Compare free shipping over $75", [[7500, 795], [10000, 795]]],
  ["Compare free shipping over $100", [[10000, 795], [7500, 795]]],
  ["Compare free-shipping thresholds.", [[5000, 795], [7500, 795]]],
  ["Compare $50 and $75 free shipping thresholds. I don't know our fulfillment or labor costs yet.", [[5000, 795], [7500, 795]]],
  ["We currently offer free shipping over $50; compare $75 and $100 free shipping thresholds.", [[7500, 795], [10000, 795]]],
  ["We currently offer free shipping over $50 and are considering $75 or $100.", [[7500, 795], [10000, 795]]],
  ["Currently free shipping over $50, otherwise $9.95. Option A: free shipping over $75. Option B: free shipping over $100.", [[7500, 795], [10000, 795]]],
  ["Option A: use presets. Option B: free shipping over $100 with a $3.95 shipping fee.", [[5000, 795], [10000, 395]]],
  ["Option A: free shipping threshold unspecified. Option B: free shipping over $100 with a $3.95 shipping fee.", [[5000, 795], [10000, 395]]],
  ["Option A: use presets with a $5.95 shipping fee. Option B: free shipping over $100 with a $3.95 shipping fee.", [[5000, 595], [10000, 395]]],
  ["Option A: free shipping over $50 with a $3.95 shipping fee. Option B: use presets.", [[5000, 395], [7500, 795]]],
  ["Free shipping thresholds: Option A: use presets. Option B: use presets.", [[5000, 795], [7500, 795]]],
  ["Currently free shipping over $25. Option A: use presets. Option B: free shipping over $100 with a $3.95 shipping fee.", [[5000, 795], [10000, 395]]],
  ["Compare free shipping over $50 with free shipping over $75. For the latter, charge $3.95 below the threshold.", [[5000, 795], [7500, 395]]],
  ["Compare free shipping over $50 with free shipping over $75. For the former, charge $3.95 below the threshold.", [[5000, 395], [7500, 795]]],
  ["Compare free shipping over $50 with free shipping over $75. For the first, charge $3.95 below the threshold.", [[5000, 395], [7500, 795]]],
  ["Compare free shipping over $50 with free shipping over $75. For the second, charge $3.95 below the threshold.", [[5000, 795], [7500, 395]]],
  ["Compare free shipping over $50 with free shipping over $75. For the latter, keep the fee at $3.95.", [[5000, 795], [7500, 395]]],
  ["Compare free shipping over $50 with free shipping over $75. Keep the fee at $3.95 for the former.", [[5000, 395], [7500, 795]]],
  ["Compare free shipping over $50 with free shipping over $75. For the former, charge $3.95 below the threshold; for the latter, charge $5.95 below the threshold.", [[5000, 395], [7500, 595]]],
];

for (const [text, expected] of examples) {
  test(`interprets: ${text}`, () => {
    assert.deepEqual(policies(text), expected);
    assert.equal(interpret(text).policies.length, 2);
    assert.ok(interpret(text).policies.every(policy => policy.existingCustomerThresholdCents === null));
  });
}

test("describes presets honestly and omits the contextual current policy", () => {
  const missing = interpret("Compare free shipping over $75").conversation;
  assert.match(missing.assumptions.join(" "), /No second threshold.*\$100\.00/);
  assert.match(missing.assumptions.join(" "), /\$7\.95.*illustrative|illustrative.*\$7\.95/);
  assert.match(missing.summary, /Option A.*\$75\.00.*Option B.*\$100\.00/);
  assert.match(missing.summary, /not a claim about your current policy/);
  const current = interpret("We currently offer free shipping over $50; compare $75 and $100 free shipping thresholds.");
  assert.match(current.conversation.summary, /current \$50\.00 threshold is context only.*without a third scenario/);
  assert.ok(!interpret(examples[0][0]).conversation.assumptions.some(item => item.includes("shipping fee preset")));
  const labeled = interpret("Option A: use presets. Option B: free shipping over $100 with a $3.95 shipping fee.").conversation;
  assert.match(labeled.summary, /Option A.*\$50\.00.*Option B.*\$100\.00.*\$3\.95/);
  assert.match(labeled.assumptions.join(" "), /Option A uses an illustrative \$50\.00 threshold/);
  assert.ok(!labeled.assumptions.some(item => /No second threshold|Option B.*preset/.test(item)));
});

const rejected = [
  ["Compare subscriptions priced at $50 and $75", "UNSUPPORTED_POLICY"],
  ["Should we hire staff or open a warehouse?", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with a 10% discount", "UNSUPPORTED_POLICY"],
  ["Compare free shipping with a flat-rate shipping policy", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with opening another store", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 only for new customers with free shipping over $75", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over €50 and €75", "UNSUPPORTED_CURRENCY"],
  ["Compare free shipping over £50 and £75", "UNSUPPORTED_CURRENCY"],
  ["Compare CAD $50 and CAD $75 free shipping thresholds", "UNSUPPORTED_CURRENCY"],
  ["Compare $50 and $75 free shipping thresholds in Canadian dollars", "UNSUPPORTED_CURRENCY"],
  ["Compare free shipping over $-50 with free shipping over $75"],
  ["Compare free shipping over -$50 with free shipping over $75"],
  ["Compare free shipping over −$50 with free shipping over $75"],
  ["Compare $50 and $75 free shipping thresholds. Charge $-7.95 below both."],
  ["Compare free shipping over $50.001 with free shipping over $75"],
  ["Compare free shipping over $50.2.2 with free shipping over $75"],
  ["Compare free shipping over $50,00 with free shipping over $75"],
  ["Compare free shipping over $.50 with free shipping over $75"],
  ["Compare free shipping over $1e3 with free shipping over $75"],
  ["Compare free shipping over $50k with free shipping over $75"],
  ["Compare free shipping over $1 million with free shipping over $75"],
  ["Compare free shipping over 50 cents with free shipping over $75"],
  ["Compare free shipping over $NaN with free shipping over $75"],
  ["Compare free shipping over $Infinity with free shipping over $75"],
  ["Compare free shipping over fifty with free shipping over $75"],
  ["Compare free shipping over $50-$75 with free shipping over $100"],
  ["Compare free shipping over $1000001 with free shipping over $75"],
  ["Compare $50 and $75 free shipping thresholds. Charge $1000.01 below either."],
  [`Compare free shipping over $${"9".repeat(3500)} with free shipping over $75`],
  ["Compare $50 and $75 and $100 free shipping thresholds"],
  ["Compare $50, $75 and $100 free shipping thresholds"],
  ["Option A: free shipping over $50. Option B: free shipping over $75. Option C: free shipping over $100."],
  ["Option B: free shipping over $50. Option A: free shipping over $75."],
  ["Compare free shipping over $50 with free shipping over $50"],
  ["Compare free shipping over $50 with free shipping over $75. Keep the fee at $7.95. Keep the fee at $3.95."],
  ["Compare $50 and $75 free shipping thresholds; fulfillment is $123."],
  ["Compare $50 and $75 free shipping thresholds. Charge $3.95 below the $100 threshold."],
  ["Compare $50 and $75 free shipping thresholds, below $75."],
  ["Compare shipping costs of $50 and $75"],
  ["Compare free shipping over @0@ and $75"],
  ["Compare free shipping over $50.\u0000"],
  ["Compare free shipping over $50 with lowering the price.", "UNSUPPORTED_POLICY"],
  ["Option A: free shipping over $50. Option B: lowering the price.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with using smaller boxes.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with keeping it unchanged.", "UNSUPPORTED_POLICY"],
  ["Option A: free shipping over $50. Option B: keep it unchanged.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with free shipping over $75 and reducing packaging.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with doing nothing.", "UNSUPPORTED_POLICY"],
  ["Compare no free shipping with free shipping over $75.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 but not free shipping over $75.", "UNSUPPORTED_POLICY"],
  ["Option A: do not offer free shipping over $50. Option B: free shipping over $75.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with free shipping over $75. Don't charge $3.95 below either threshold.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with free shipping over $75. For the latter, do not charge $3.95 below the threshold.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with free shipping over $75. Never charge $3.95 below either threshold.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with free shipping over $75. Charge $3.95 except for the latter.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with free shipping over $75. For the other option, charge $3.95 below the threshold.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50 with free shipping over $75. For the third option, charge $3.95 below the threshold.", "UNSUPPORTED_POLICY"],
  ["Compare free shipping over $50. For the latter, charge $3.95 below the threshold."],
  ["Compare free shipping over $50 with free shipping over $75. For both and the former, charge $3.95 below the threshold."],
  ["Compare free shipping over $50 with free shipping over $75. For the former, charge $3.95 below the $75 threshold."],
  ["Option A: free shipping over $50, charge $3.95 below the $75 threshold. Option B: free shipping over $75."],
  ["Option A: free shipping over $50, for the latter charge $3.95 below the threshold. Option B: free shipping over $75."],
];
for (const [decisionText, code] of rejected) {
  test(`rejects unsupported or malformed input: ${decisionText.slice(0, 100)}`, () => {
    assert.throws(() => interpret(decisionText), error => error.status === 400 && (!code || error.code === code));
  });
}

test("enforces the exact body and 4000-character boundary without truncating", () => {
  for (const body of [null, [], {}, { decisionText: "" }, { decisionText: "  " }, { decisionText: 50 },
    { decisionText: "Compare free shipping thresholds", options: [] },
    { decisionText: "Compare free shipping thresholds", runConfig: { model: "other" } },
    { decisionText: "Compare free shipping thresholds", assumptions: {} }]) {
    assert.throws(() => interpretConversation(body));
  }
  const text = "Compare $50 and $75 free shipping thresholds.";
  assert.equal(interpret(`${text}${" ".repeat(4000 - text.length)}`).policies.length, 2);
  assert.throws(() => interpret(`${text}${" ".repeat(4001 - text.length)}`), /4000/);
});

test("prepares immutable evidence-linked, model-ready options with declared cost presets", async () => {
  const decisionText = examples[2][0];
  const draft = await prepareConversation({ decisionText });
  assert.deepEqual(Object.keys(draft).sort(), ["conversation", "definition", "estimate", "inputs", "questions", "warnings"]);
  const { definition, inputs } = draft;
  assert.doesNotThrow(() => validateExperiment(definition, inputs));
  assert.doesNotThrow(() => validateRunConfig(definition, inputs));
  assert.deepEqual(definition.scenarios.map(s => [s.scenarioId, s.label, s.isBaseline]), [
    ["baseline", "Option A", true], ["option-1", "Option B", false],
  ]);
  assert.equal(definition.decisionText, decisionText);
  assert.deepEqual(definition.scenarios.map(s => s.originalText), [decisionText, decisionText]);
  assert.deepEqual(definition.scenarios.map(s => [s.policy.thresholdCents, s.policy.shippingFeeCents]), [[5000, 795], [7500, 395]]);
  assert.deepEqual(draft.questions, []);
  assert.ok(!draft.warnings.some(warning => /require review|No unambiguous|unknown.*cost/i.test(warning)));
  assert.deepEqual(draft.estimate, { plannedActions: 378, maxAttempts: 757 });
  assert.deepEqual(definition.runConfig, { provider: "copilot", model: "mai-code-1.1-flash", concurrency: 2,
    attemptCap: 757, deadlineMs: 7200000, callTimeoutMs: 60000, repetitions: 1 });
  assert.equal(definition.horizon.steps, 3);
  assert.deepEqual(Object.fromEntries(["customer", "employee", "supplier", "reseller"].map(role =>
    [role, inputs.actors.filter(actor => actor.role === role).length])), { customer: 32, employee: 22, supplier: 5, reseller: 4 });
  assert.ok(Buffer.byteLength(JSON.stringify({ definition, inputs })) < 3_000_000);
  for (const [role, coverage] of Object.entries(inputs.snapshot.coverage.population)) {
    assert.equal(coverage.selected, inputs.actors.filter(actor => actor.role === role).length);
    assert.ok(coverage.eligible >= coverage.selected && coverage.source >= coverage.eligible);
  }
  const titles = inputs.actors.filter(actor => actor.role === "employee").map(actor => actor.facts.find(fact => fact.field === "jobTitle").value);
  assert.ok(titles.some(title => /chief|president|director/i.test(title)));
  assert.ok(titles.some(title => /manager|supervisor|lead/i.test(title)));
  assert.match(draft.conversation.assumptions.join(" "), /2 concurrent.*120-minute/);
  for (const [id, expected] of [["a-fulfillment", 500], ["a-labor-rate", 2400]]) {
    const assumption = inputs.assumptions.find(item => item.assumptionId === id);
    assert.equal(assumption.value, expected);
    assert.equal(assumption.source, "preset");
    assert.equal(assumption.owner, "simulation_preset");
    assert.equal(assumption.approvalState, "not_reviewed");
    assert.equal(assumption.presetId, "conversational-shipping-v1");
    assert.match(assumption.rationale, /not measured source evidence or a manually reviewed value/);
  }
  assert.equal(inputs.snapshot.sourceType, "AdventureWorks_sample");
  assert.equal(inputs.snapshot.coverage.fulfillmentCost, "unknown");
  assert.equal(inputs.snapshot.coverage.historicalShippingPolicy, "unknown");
  assert.equal(inputs.snapshot.coverage.behavioralValidation, "not_performed");
  assert.ok(inputs.evidence.length > 0 && inputs.evidence.every(item => item.quality === "sample_business_data"));
  assert.equal(inputs.snapshot.evidenceHash, stableHash(inputs.evidence));
  assert.equal(definition.comparisonKey, comparisonKey(definition, inputs));
  assert.match(draft.conversation.assumptions.join(" "), /illustrative presets.*\$5\.00.*\$24\.00/);
  assert.match(draft.conversation.assumptions.join(" "), /missing product costs remain unknown/);
  assert.match(draft.conversation.assumptions.join(" "), /not manually reviewed/);
  assert.ok(Object.isFrozen(inputs.evidence[0]) && Object.isFrozen(inputs) && Object.isFrozen(definition.scenarios[0]));
  assert.ok(!Object.hasOwn(draft, "results"));
  assert.throws(() => { inputs.assumptions[0].value = 1; }, TypeError);

  const legacy = await prepareExperiment({ decisionText, customerCount: 32, employeeCount: 22, supplierCount: 5, resellerCount: 4 });
  assert.equal(legacy.definition.scenarios[0].label, "Baseline");
  assert.equal(legacy.inputs.assumptions.find(item => item.assumptionId === "a-fulfillment").value, null);
  assert.deepEqual(legacy.inputs.evidence, inputs.evidence);
  assert.deepEqual(legacy.inputs.snapshot, inputs.snapshot);
});

test("an explicit quick preview keeps source evidence and all role groups with only forty planned choices", async () => {
  const decisionText = `Quick preview: ${examples[2][0]}`;
  const draft = await prepareConversation({ decisionText });
  assert.doesNotThrow(() => validateExperiment(draft.definition, draft.inputs));
  assert.doesNotThrow(() => validateRunConfig(draft.definition, draft.inputs));
  assert.equal(draft.definition.decisionText, decisionText);
  assert.match(draft.definition.title, /Quick preview/);
  assert.equal(draft.definition.horizon.steps, 2);
  assert.deepEqual(draft.estimate, { plannedActions: 40, maxAttempts: 81 });
  assert.deepEqual(draft.definition.runConfig, { provider: "copilot", model: "mai-code-1.1-flash",
    concurrency: 4, attemptCap: 81, deadlineMs: 600000, callTimeoutMs: 60000, repetitions: 1 });
  assert.deepEqual(Object.fromEntries(["customer", "employee", "supplier", "reseller"].map(role =>
    [role, draft.inputs.actors.filter(actor => actor.role === role).length])), { customer: 3, employee: 5, supplier: 1, reseller: 1 });
  const titles = draft.inputs.actors.filter(actor => actor.role === "employee").map(actor => actor.facts.find(fact => fact.field === "jobTitle").value);
  assert.ok(titles.some(title => /chief|president|director/i.test(title)));
  assert.ok(titles.some(title => /manager|supervisor|lead/i.test(title)));
  assert.ok(titles.some(title => !/chief|president|director|manager|supervisor|lead/i.test(title)));
  assert.match(draft.conversation.summary, /smaller exploratory sample/);
  assert.match(draft.conversation.assumptions.join(" "), /4 concurrent.*10-minute/);
  assert.deepEqual(draft.definition.scenarios.map(s => [s.policy.thresholdCents, s.policy.shippingFeeCents]), [[5000, 795], [7500, 395]]);
  assert.equal(draft.inputs.snapshot.sourceType, "AdventureWorks_sample");
  assert.ok(!Object.hasOwn(draft, "results"));
  assert.throws(() => interpretConversation({ decisionText: "Quick preview: Compare subscriptions priced at $50 and $75" }));
});

test("HTTP conversation drafts save unchanged and reach manager readiness only when a run starts", async () => {
  const root = join(process.cwd(), "test", `.conversation-http-${randomUUID()}`);
  let app, base, token, inference = 0, readiness = 0;
  const engineFactory = () => { inference++; throw new Error("Preparation must not invoke a model"); };
  const preflight = async () => { readiness++; throw new Error("Recorded readiness refusal; no provider call was made."); };
  const open = async () => {
    app = await createAppServer({ root, engineFactory, preflight });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
    token = (await (await fetch(`${base}/api/session`)).json()).token;
  };
  const request = async (path, body, expected = 200) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Simulation-Token": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };
  try {
    await open();
    const denied = await fetch(`${base}/api/experiments/conversation`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decisionText: examples[0][0] }),
    });
    await denied.arrayBuffer();
    assert.equal(denied.status, 403);
    await request("/api/experiments/conversation", { decisionText: examples[0][0], options: [] }, 400);
    await request("/api/experiments/draft", { decisionText: examples[0][0], preset: "conversational-shipping-v1" }, 400);
    await request("/api/experiments/conversation", { decisionText: "x".repeat(4001) }, 400);
    await request("/api/experiments/conversation", { decisionText: "Compare a membership and a discount" }, 400);
    const draft = await request("/api/experiments/conversation", { decisionText: examples[2][0] });
    const submitted = { definition: draft.definition, inputs: draft.inputs };
    const tampered = structuredClone(submitted);
    tampered.definition.title = "Changed after preparation";
    delete tampered.definition.definitionHash;
    tampered.definition.definitionHash = stableHash(tampered.definition);
    assert.equal((await request("/api/experiments", tampered, 409)).error.code, "DRAFT_CHANGED");
    assert.equal(inference, 0);
    const saved = await request("/api/experiments", submitted, 201);
    assert.deepEqual(saved, submitted);
    assert.deepEqual(await request("/api/experiments", submitted, 201), submitted);
    assert.equal((await request("/api/experiments", tampered, 409)).error.code, "IMMUTABLE_VERSION");
    const legacy = await request("/api/experiments/draft", {
      decisionText: "Compare shipping thresholds", customerCount: 1, employeeCount: 0, supplierCount: 0,
      resellerCount: 0, cycles: 1, runConfig: { provider: "copilot", model: "legacy-fixture" },
    });
    assert.equal(legacy.definition.scenarios.length, 3);
    assert.equal(legacy.definition.scenarios[0].label, "Baseline");
    assert.ok(!Object.hasOwn(legacy, "conversation"));
    assert.ok(legacy.questions.length > 0);
    await request("/api/experiments", { definition: legacy.definition, inputs: legacy.inputs }, 201);
    const neverIssued = await prepareConversation({ decisionText: examples[0][0] });
    assert.equal((await request("/api/experiments", { definition: neverIssued.definition, inputs: neverIssued.inputs }, 409)).error.code, "DRAFT_REQUIRED");
    await app.close();
    await open();
    const reopened = await request(`/api/experiments/${saved.definition.experimentId}`);
    assert.deepEqual(reopened.definition, saved.definition);
    assert.deepEqual(reopened.inputs, saved.inputs);
    assert.deepEqual(reopened.runs, []);
    assert.equal(inference, 0);
    assert.equal(readiness, 0);
    const refused = await request(`/api/experiments/${saved.definition.experimentId}/runs`, {
      version: saved.definition.version, idempotencyKey: "conversation-manager-readiness",
    }, 503);
    assert.equal(refused.error.code, "PROVIDER");
    assert.equal(readiness, 1);
    assert.equal(inference, 0);
    assert.deepEqual((await request(`/api/experiments/${saved.definition.experimentId}`)).runs, []);
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
