import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSimulationApi } from "../src/sim/api.mjs";
import { RunManager } from "../src/sim/runManager.mjs";
import { stableHash } from "../src/sim/domain.mjs";
import { prepareSyntheticFixture } from "../src/sim/domain-definition.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Condition did not become true");
    await wait(10);
  }
}
function observationFrom(prompt) {
  return JSON.parse(prompt.split("PERMITTED_OBSERVATION_DATA=")[1].split("\n\nYour previous")[0]);
}
function recordedAction(prompt) {
  const observation = observationFrom(prompt);
  return {
    type: observation.self.role === "customer" ? "purchase" : "no_action",
    parameters: observation.self.role === "customer" ? { items: observation.opportunity.basket } : {},
    explanation: "Recorded synthetic test action, not a behavioral prediction.",
    evidenceIds: [], assumptionIds: [],
  };
}

async function fixture(t, { behavior, startBehavior, stopBehavior, preflightResult, config = {}, cycles = 1, customers = 2,
  employees = 1, suppliers = 1, resellers = 1, unitCostCents, objective, constraints } = {}) {
  const root = join(repository, `.test-orchestration-${randomUUID()}`);
  mkdirSync(root);
  const counters = { calls: 0, starts: 0, stops: 0, preflights: 0, active: 0, maxActive: 0, prompts: [], signals: [] };
  const engineFactory = () => ({
    async start() { counters.starts++; if (startBehavior) await startBehavior(); },
    async askEnvelope(prompt, options) {
      const index = ++counters.calls;
      counters.active++;
      counters.maxActive = Math.max(counters.maxActive, counters.active);
      counters.prompts.push(prompt);
      counters.signals.push(options.signal);
      assert.equal(options.retries, 0);
      try {
        const standard = { text: JSON.stringify(recordedAction(prompt)), provider: "copilot", requestedModel: "recorded-test", resolvedModel: "recorded-test", usage: null };
        return behavior ? await behavior({ index, prompt, options, standard, counters }) : await wait(5).then(() => standard);
      } finally { counters.active--; }
    },
    async stop() { counters.stops++; if (stopBehavior) await stopBehavior(); },
  });
  const preflight = async options => {
    counters.preflights++;
    return preflightResult || { ready: true, provider: "copilot", requestedModel: options.model, resolvedModel: options.model, cliVersion: "recorded-fixture", modelResolution: "reported", durationMs: 1 };
  };
  const api = await createSimulationApi({ root, engineFactory, preflight });
  let server;
  t.after(async () => {
    await api.close();
    if (server) await new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
    rmSync(root, { recursive: true, force: true });
  });
  const bundle = prepareSyntheticFixture({
    decisionText: "Compare the reviewed shipping policy options.",
    customerCount: customers, employeeCount: employees, supplierCount: suppliers, resellerCount: resellers, cycles,
    ...(unitCostCents === undefined ? {} : { unitCostCents }),
    ...(objective === undefined ? {} : { objective }),
    ...(constraints === undefined ? {} : { constraints }),
    options: [{ label: "Reviewed option", thresholdCents: 7500, shippingFeeCents: 795 }],
    assumptions: { fulfillmentCostPerOrderCents: 500, incrementalLaborRateCentsPerHour: 3000 },
    runConfig: { provider: "copilot", model: "recorded-test", concurrency: 2, attemptCap: 100, deadlineMs: 10000, callTimeoutMs: 1000, repetitions: 1, ...config },
  });
  api.store.saveExperiment(bundle);
  return {
    api, root, bundle, counters,
    async start(key = "request-fixture", version = 1) { return api.manager.start(bundle.definition.experimentId, { version, idempotencyKey: key }); },
    async listen() {
      server = createServer((req, res) => {
        api.handle(req, res, new URL(req.url, "http://localhost")).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      return {
        base,
        async request(path, value, method = value === undefined ? "GET" : "POST") {
          const response = await fetch(base + path, {
            method, headers: { "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
          });
          return { status: response.status, value: await response.json() };
        },
      };
    },
  };
}

test("complete real-domain round execution, budgets, immutable metadata, replay and deterministic brief", async t => {
  const f = await fixture(t);
  const start = await f.start();
  await f.api.manager.waitForIdle();
  const run = f.api.manager.getRun(start.runId);
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.ok(run.results.every(result => result.complete && result.completedRounds === 1));
  assert.equal(f.counters.calls, f.bundle.inputs.actors.length * f.bundle.definition.scenarios.length);
  assert.ok(f.counters.maxActive <= 2 && f.counters.maxActive > 1);
  assert.equal(run.manifest.requestedModel, "recorded-test");
  assert.equal(run.manifest.transport, "injected");
  assert.equal(run.manifest.promptVersions.stakeholder, f.bundle.definition.promptVersion);
  assert.equal(run.manifest.inputsHash, stableHash(f.bundle.inputs));
  assert.equal(run.events.filter(event => event.type === "attempt_started").length, f.counters.calls + 1);
  assert.equal(run.events.filter(event => event.type === "attempt_completed").length, f.counters.calls + 1);
  const completion = run.events.at(-1);
  assert.equal(completion.type, "run_completed");
  assert.equal(completion.data.attempts, f.counters.calls + 1);
  for (const event of run.events.filter(event => event.type === "actor_completed")) {
    assert.equal(event.data.validated, true);
    assert.equal(event.data.committed, false);
    assert.equal(event.data.action, undefined);
  }
  const beforeReplay = f.counters.calls;
  const replay = await f.api.manager.replay(start.runId);
  assert.equal(replay.verified, true);
  assert.deepEqual(replay.results, run.results);
  assert.equal(f.counters.calls, beforeReplay);
  const brief = f.api.manager.brief(start.runId);
  assert.deepEqual(f.api.manager.brief(start.runId), brief);
  assert.ok(brief.markdown.split(/\s+/).length <= 800);
  assert.match(brief.markdown, /Empirical validation is not established/);
  assert.ok(brief.metricIds.every(id => run.results.some(result => result.metrics.some(metric => `${metric.scenarioId}:${metric.metricId}` === id))));
  assert.deepEqual(f.api.manager.getRun(start.runId).events, run.events);
  assert.equal((await f.api.manager.cancel(start.runId)).status, "completed");
  const debug = join(f.root, "runs", start.runId, "debug");
  assert.equal(readdirSync(debug).length, f.counters.calls);
  assert.ok(JSON.parse(readFileSync(join(debug, readdirSync(debug)[0]), "utf8")).rawText);
});

test("business-sized panel persists all 378 fixture choices with at most two requests active", async t => {
  const f = await fixture(t, {
    customers: 32, employees: 22, suppliers: 5, resellers: 4, cycles: 3,
    config: { concurrency: 2, attemptCap: 757, deadlineMs: 120000, callTimeoutMs: 1000 },
  });
  const started = await f.start();
  await f.api.manager.waitForIdle();
  const run = f.api.manager.getRun(started.runId);
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.equal(f.counters.calls, 378);
  assert.equal(f.counters.maxActive, 2);
  assert.equal(run.events.filter(event => event.type === "attempt_started").length, 379);
  assert.equal(run.results.reduce((sum, result) => sum + result.actions.length, 0), 378);
  assert.ok(run.results.every(result => result.complete && result.completedRounds === 3));
  assert.ok(Buffer.byteLength(JSON.stringify(run.results)) < 8 * 1024 * 1024);
  assert.match(f.api.manager.brief(started.runId).markdown, /Business perspectives/);
});

test("production H0 factory selects the official SDK harness, never the legacy CLI engine", async t => {
  const f = await fixture(t);
  const manager = new RunManager({ store: f.api.store });
  const engine = await manager.engineFactory({ provider: "copilot", model: "recorded-test", concurrency: 1 });
  assert.equal(engine.constructor.name, "CopilotHarness");
  assert.equal(manager.transport, "copilot-sdk");
  await engine.stop();
  await manager.close();
  assert.equal(f.counters.calls, 0);
  assert.equal(f.counters.preflights, 0);
});

test("parallel duplicate starts create exactly one persisted run and reject version conflicts", async t => {
  const f = await fixture(t);
  const [first, duplicate] = await Promise.all([f.start("request-duplicate"), f.start("request-duplicate")]);
  assert.equal(first.runId, duplicate.runId);
  assert.equal(f.counters.preflights, 1);
  await assert.rejects(f.start("request-duplicate", 2), { code: "IDEMPOTENCY_CONFLICT" });
  await f.api.manager.waitForIdle();
  assert.equal(f.api.store.listRuns(f.bundle.definition.experimentId).length, 1);
  assert.equal((await f.start("request-duplicate")).runId, first.runId);
});

test("multiple shopping cycles retain contiguous source hashes and exact replay", async t => {
  const f = await fixture(t, { cycles: 3, customers: 1 });
  const { runId } = await f.start();
  await f.api.manager.waitForIdle();
  const run = f.api.manager.getRun(runId);
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.ok(run.results.every(result => result.completedRounds === 3));
  for (const scenario of f.bundle.definition.scenarios) {
    const commits = run.events.filter(event => event.type === "round_committed" && event.scenarioId === scenario.scenarioId);
    assert.deepEqual(commits.map(event => event.data.round), [1, 2, 3]);
    assert.equal(commits[1].data.previousStateHash, commits[0].data.stateHash);
    assert.equal(commits[2].data.previousStateHash, commits[1].data.stateHash);
  }
  const before = f.counters.calls;
  assert.equal((await f.api.manager.replay(runId)).verified, true);
  assert.equal(f.counters.calls, before);
});

test("missing cost coverage remains unknown in complete results and deterministic briefs", async t => {
  const f = await fixture(t, { customers: 1, unitCostCents: null });
  const { runId } = await f.start();
  await f.api.manager.waitForIdle();
  const run = f.api.manager.getRun(runId);
  assert.equal(run.status, "completed");
  for (const result of run.results) {
    assert.equal(result.complete, true);
    assert.equal(result.metrics.find(metric => metric.metricId === "costOfGoodsSold").value, null);
    assert.equal(result.metrics.find(metric => metric.metricId === "contribution").value, null);
  }
  assert.equal(run.comparison.status, "more_information_needed");
  assert.equal(run.comparison.bestScenarioId, null);
  const brief = f.api.manager.brief(runId);
  assert.match(brief.markdown, /contribution: unavailable \[metric:/);
  assert.doesNotMatch(brief.markdown, /contribution: 0 USD_cents/);
  assert.match(brief.markdown, /does not establish an unqualified preferred option/);
});

test("briefs honor the frozen chosen objective and declared guardrails", async t => {
  const f = await fixture(t, {
    objective: { metricId: "purchases", direction: "minimize" },
    constraints: [{ metricId: "abandonmentRate", comparator: "<=", threshold: 0.25, severity: "hard" }],
  });
  const { runId } = await f.start();
  await f.api.manager.waitForIdle();
  const brief = f.api.manager.brief(runId);
  assert.match(brief.markdown, /Objective: minimize calculated purchases/);
  assert.match(brief.markdown, /unit: orders; scope: simulated_panel/);
  assert.doesNotMatch(brief.markdown, /Objective: maximize calculated contribution/);
  assert.match(brief.markdown, /guardrails are reviewable decision assumptions/);
  assert.ok(brief.metricIds.includes("baseline:purchases"));
});

test("one total repair or transient retry, never nested multiplication or error JSON success", async t => {
  const f = await fixture(t, {
    config: { concurrency: 1 },
    behavior: ({ index, standard }) => index === 1 ? { ...standard, text: '{"error":"do-not-expose-provider-diagnostics"}' }
      : index === 2 ? { ...standard, errorCategory: "rate_limit", error: "private diagnostic" } : standard,
  });
  const { runId } = await f.start();
  await f.api.manager.waitForIdle();
  const run = f.api.manager.getRun(runId);
  assert.equal(run.status, "failed");
  assert.equal(f.counters.calls, 2);
  assert.ok(run.results.every(result => result.completedRounds === 0 && result.actions.length === 0));
  assert.equal(run.events.filter(event => event.type === "attempt_failed").length, 2);
  assert.equal(run.events.filter(event => event.type === "actor_completed").length, 0);
  assert.equal(run.comparison, null);
  assert.ok(!JSON.stringify(run).includes("private diagnostic"));
  assert.ok(!JSON.stringify(run).includes("do-not-expose-provider-diagnostics"));
  await assert.rejects(f.api.manager.replay(runId), { code: "INCOMPLETE_RUN" });
  assert.throws(() => f.api.manager.brief(runId), { code: "INCOMPLETE_RUN" });
});

test("a successful schema repair preserves the observation and stays within two attempts", async t => {
  const f = await fixture(t, {
    config: { concurrency: 1 },
    behavior: ({ index, standard }) => index === 1 ? { ...standard, text: "{}" } : standard,
  });
  const { runId } = await f.start();
  await f.api.manager.waitForIdle();
  const run = f.api.manager.getRun(runId);
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  const attempts = run.events.filter(event => event.type === "attempt_started" && event.data.purpose !== "preflight");
  assert.equal(attempts[0].data.observationHash, attempts[1].data.observationHash);
  assert.equal(attempts[1].data.purpose, "repair");
  assert.equal(attempts[1].data.actorAttempt, 2);
  assert.ok(f.counters.prompts[1].startsWith(f.counters.prompts[0]));
  assert.match(f.counters.prompts[1], /Action requires type, parameters, explanation, evidenceIds and assumptionIds/);
  assert.match(run.events.find(event => event.type === "actor_retrying").data.validationFeedback, /Action requires/);
  assert.equal(f.counters.calls, f.bundle.estimate.plannedActions + 1);
});

test("authentication and unavailable model preflights never create a run", async t => {
  for (const category of ["authentication", "model_unavailable"]) {
    await t.test(category, async subtest => {
      const f = await fixture(subtest, { preflightResult: { ready: false, error: { category, message: "sensitive detail" } } });
      await assert.rejects(f.start(), error => error.status === 503 && !error.message.includes("sensitive detail"));
      assert.equal(f.counters.calls, 0);
      assert.equal(f.api.store.listRuns(f.bundle.definition.experimentId).length, 0);
    });
  }
});

test("preflight with unconfirmed shutdown blocks subsequent inference instead of retrying", async t => {
  const f = await fixture(t, { preflightResult: { ready: false, error: { category: "stop_unconfirmed", message: "Private diagnostic" } } });
  await assert.rejects(f.start(), { code: "STOP_UNCONFIRMED" });
  assert.equal(f.api.store.getRuntimeBlock().code, "STOP_UNCONFIRMED");
  await assert.rejects(f.start("request-next"), { code: "STOP_UNCONFIRMED" });
  assert.equal(f.counters.preflights, 1);
  assert.equal(f.counters.calls, 0);
});

test("model/auth failures during execution stop immediately with no fallback and no partial round", async t => {
  for (const category of ["authentication", "model_unavailable", "model_mismatch"]) {
    await t.test(category, async subtest => {
      const f = await fixture(subtest, { config: { concurrency: 1 }, behavior: ({ standard }) => ({ ...standard, errorCategory: category, error: "private" }) });
      const { runId } = await f.start();
      await f.api.manager.waitForIdle();
      const run = f.api.manager.getRun(runId);
      assert.equal(run.status, "paused");
      assert.equal(f.counters.calls, 1);
      assert.ok(run.results.every(result => result.completedRounds === 0));
      assert.ok(f.counters.stops > 0);
      assert.equal((await f.api.manager.cancel(runId)).status, "cancelled");
    });
  }
});

test("shared budget includes the preflight and all retries, keeping only complete earlier rounds", async t => {
  const budget = 11;
  const f = await fixture(t, {
    config: { attemptCap: budget, concurrency: 1 },
    behavior: ({ index, standard }) => index === 1 ? { ...standard, text: "{}" } : standard,
  });
  const { runId } = await f.start();
  await f.api.manager.waitForIdle();
  const run = f.api.manager.getRun(runId);
  assert.equal(run.status, "failed");
  assert.equal(run.error.code, "BUDGET");
  assert.equal(f.counters.calls, budget - 1);
  assert.equal(run.events.filter(event => event.type === "attempt_started").length, budget);
  assert.equal(run.results[0].completedRounds, 1);
  assert.equal(run.results[1].completedRounds, 0);
  assert.equal(run.comparison, null);
});

test("cancelling running and queued work stops scheduling and rejects late round commits", async t => {
  const pending = [];
  const f = await fixture(t, {
    config: { concurrency: 4 },
    behavior: ({ standard }) => new Promise(resolve => pending.push(() => resolve(standard))),
  });
  const first = await f.start("request-first");
  await eventually(() => f.counters.calls === 3);
  const queued = await f.start("request-queued");
  assert.equal(f.api.store.readRun(queued.runId).status, "queued");
  await f.api.manager.cancel(queued.runId);
  await f.api.manager.cancel(first.runId);
  const cancelled = f.api.manager.getRun(first.runId);
  assert.equal(cancelled.status, "cancelled");
  assert.ok(f.counters.signals.every(signal => signal.aborted));
  assert.ok(f.counters.stops > 0);
  assert.equal(cancelled.events.filter(event => event.type === "attempt_failed").length, 3);
  const sequence = cancelled.events.length;
  pending.forEach(resolve => resolve());
  await f.api.manager.waitForIdle();
  await wait(10);
  assert.equal(f.counters.calls, 3);
  assert.equal(f.api.manager.getRun(first.runId).events.length, sequence);
  assert.ok(f.api.manager.getRun(first.runId).results.every(result => result.completedRounds === 0));
  assert.equal(f.api.manager.getRun(queued.runId).status, "cancelled");
});

test("cancellation from attempt notifications records exactly one outcome per attempt", async t => {
  for (const eventType of ["attempt_started", "attempt_completed"]) {
    await t.test(eventType, async subtest => {
      const f = await fixture(subtest, { config: { concurrency: 1 } });
      const { runId } = await f.start();
      const unsubscribe = f.api.store.subscribe(runId, 0, event => {
        if (event.type === eventType && event.data.callId !== "preflight") void f.api.manager.cancel(runId);
      });
      await f.api.manager.waitForIdle();
      unsubscribe();
      const run = f.api.manager.getRun(runId);
      assert.equal(run.status, "cancelled");
      for (const event of run.events.filter(item => item.type === "attempt_started")) {
        assert.equal(run.events.filter(item => ["attempt_completed", "attempt_failed"].includes(item.type) && item.data.callId === event.data.callId).length, 1);
      }
      assert.ok(run.results.every(result => result.completedRounds === 0));
    });
  }
});

test("overall deadlines cancel an uncooperative envelope without creating state", async t => {
  const f = await fixture(t, {
    config: { concurrency: 1, deadlineMs: 1000, callTimeoutMs: 1000 },
    behavior: () => new Promise(() => {}),
  });
  const { runId } = await f.start();
  await f.api.manager.waitForIdle();
  const run = f.api.manager.getRun(runId);
  assert.equal(run.status, "failed");
  assert.equal(run.error.code, "DEADLINE");
  assert.ok(run.results.every(result => result.completedRounds === 0));
  assert.ok(f.counters.signals.every(signal => signal.aborted));
  assert.equal(run.events.filter(event => event.type === "attempt_started").length, run.events.filter(event => ["attempt_completed", "attempt_failed"].includes(event.type)).length);
});

test("cancellation interrupts preparation even if a provider ignores its startup signal", { timeout: 3000 }, async t => {
  const f = await fixture(t, { startBehavior: () => new Promise(() => {}) });
  const { runId } = await f.start();
  await eventually(() => f.counters.starts === 1);
  assert.equal(f.api.store.readRun(runId).status, "preparing");
  await f.api.manager.cancel(runId);
  await f.api.manager.waitForIdle();
  assert.equal(f.api.store.readRun(runId).status, "cancelled");
  assert.equal(f.counters.calls, 0);
  assert.ok(f.counters.stops > 0);
});

test("unconfirmed child termination persistently blocks queued and new inference", async t => {
  const pending = [];
  const f = await fixture(t, {
    config: { concurrency: 4 },
    behavior: ({ standard }) => new Promise(resolve => pending.push(() => resolve(standard))),
    stopBehavior: () => { throw new Error("Synthetic unconfirmed child termination"); },
  });
  const first = await f.start("request-active");
  await eventually(() => f.counters.calls === 3);
  const queued = await f.start("request-queued");
  await f.api.manager.cancel(first.runId);
  pending.forEach(resolve => resolve());
  await f.api.manager.waitForIdle();
  assert.equal(f.api.manager.getRun(first.runId).status, "cancelled");
  assert.equal(f.api.manager.getRun(queued.runId).status, "failed");
  assert.equal(f.api.manager.getRun(queued.runId).error.code, "STOP_UNCONFIRMED");
  const preflights = f.counters.preflights;
  await assert.rejects(f.start("request-blocked"), { code: "STOP_UNCONFIRMED" });
  assert.equal(f.counters.preflights, preflights);
  assert.equal(f.counters.starts, 1);
  assert.equal(f.api.store.getRuntimeBlock().code, "STOP_UNCONFIRMED");
  await f.api.close();
  const reopened = await createSimulationApi({ root: f.root });
  try {
    assert.equal((await reopened.manager.providerStatus()).error.code, "STOP_UNCONFIRMED");
    await assert.rejects(reopened.manager.start(f.bundle.definition.experimentId, { version: 1, idempotencyKey: "request-after-restart" }), { code: "STOP_UNCONFIRMED" });
    assert.equal(reopened.manager.getRun(first.runId).status, "cancelled");
  } finally { await reopened.close(); }
});

test("rate-limit backoff is cancellable and never schedules a late retry", async t => {
  const f = await fixture(t, {
    config: { concurrency: 1 },
    behavior: ({ standard }) => ({ ...standard, errorCategory: "rate_limit", error: "private provider diagnostic" }),
  });
  const { runId } = await f.start();
  await eventually(() => f.api.store.readRun(runId).events.some(event => event.type === "actor_retrying"));
  await f.api.manager.cancel(runId);
  await f.api.manager.waitForIdle();
  assert.equal(f.counters.calls, 1);
  const run = f.api.manager.getRun(runId);
  assert.equal(run.status, "cancelled");
  assert.equal(run.events.filter(event => event.type === "actor_failed").length, 1);
});

test("finished runs reopen with identical committed results and persistent request identity", async t => {
  const f = await fixture(t);
  const started = await f.start();
  await f.api.manager.waitForIdle();
  const original = f.api.manager.getRun(started.runId);
  const brief = f.api.manager.brief(started.runId);
  await f.api.close();
  const reopened = await createSimulationApi({ root: f.root });
  try {
    const restored = reopened.manager.getRun(started.runId);
    assert.deepEqual(restored, original);
    assert.deepEqual(reopened.manager.brief(started.runId), brief);
    assert.equal((await reopened.manager.start(f.bundle.definition.experimentId, { version: 1, idempotencyKey: "request-fixture" })).runId, started.runId);
    assert.equal((await reopened.manager.replay(started.runId)).verified, true);
  } finally { await reopened.close(); }
});

test("provider readiness caches failed and concurrent preflights without substituting models", async t => {
  const previousProvider = process.env.AI_PROVIDER, previousModel = process.env.AI_MODEL;
  process.env.AI_PROVIDER = "copilot";
  process.env.AI_MODEL = "recorded-test";
  t.after(() => {
    if (previousProvider == null) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = previousProvider;
    if (previousModel == null) delete process.env.AI_MODEL; else process.env.AI_MODEL = previousModel;
  });
  const f = await fixture(t, { preflightResult: { ready: false, error: { category: "authentication", message: "private" } } });
  const results = await Promise.all([f.api.manager.providerStatus(), f.api.manager.providerStatus()]);
  assert.equal(results[0].ready, false);
  assert.equal(results[0].model, "recorded-test");
  assert.equal(f.counters.preflights, 1);
  await f.api.manager.providerStatus();
  assert.equal(f.counters.preflights, 1);
  await assert.rejects(f.start(), { code: "AUTHENTICATION" });
  assert.equal(f.counters.preflights, 2);
});

test("provider configuration errors fail closed without executing a preflight", async t => {
  const previous = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "invalid-provider-do-not-echo";
  t.after(() => { if (previous == null) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = previous; });
  const f = await fixture(t);
  const status = await f.api.manager.providerStatus();
  assert.equal(status.ready, false);
  assert.equal(status.error.code, "CONFIGURATION");
  assert.ok(!JSON.stringify(status).includes("invalid-provider-do-not-echo"));
  assert.equal(f.counters.preflights, 0);
  assert.equal(f.counters.calls, 0);
});

test("the single-active-run queue has a hard admission bound", async t => {
  const f = await fixture(t, {
    config: { concurrency: 4, callTimeoutMs: 10000 },
    behavior: () => new Promise(() => {}),
  });
  const active = await f.start("request-active");
  await eventually(() => f.counters.calls === 3);
  for (let index = 0; index < 8; index++) {
    const queued = await f.start(`request-queued-${index}`);
    assert.equal(f.api.store.readRun(queued.runId).status, "queued");
  }
  await assert.rejects(f.start("request-overflow"), { code: "QUEUE_FULL" });
  assert.equal(f.counters.starts, 1);
  assert.equal(f.api.store.readRun(active.runId).status, "running");
  assert.equal(f.api.store.listRuns(f.bundle.definition.experimentId).length, 9);
});

test("API bounds reject oversized, malformed and unsupported input without inference", async t => {
  const f = await fixture(t), http = await f.listen();
  const oversized = await fetch(http.base + "/api/experiments/draft", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decisionText: "x".repeat(4 * 1024 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "PAYLOAD_LIMIT");
  const malformed = await fetch(http.base + "/api/experiments", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
  });
  assert.equal(malformed.status, 400);
  await malformed.json();
  const wrongType = await fetch(http.base + "/api/experiments", {
    method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}",
  });
  assert.equal(wrongType.status, 415);
  await wrongType.json();
  const badTiming = await http.request(`/api/experiments/${f.bundle.definition.experimentId}/timing`, { stage: "review", durationMs: -1 });
  assert.equal(badTiming.status, 400);
  const badRequest = await http.request(`/api/experiments/${f.bundle.definition.experimentId}/runs`, { version: 1, idempotencyKey: "short" });
  assert.equal(badRequest.status, 400);
  assert.equal(f.counters.calls, 0);
  assert.equal(f.counters.preflights, 0);
});

test("unexpected API failures log redacted diagnostics but return only safe public errors", async t => {
  const f = await fixture(t), http = await f.listen();
  const originalList = f.api.store.listExperiments, originalLog = console.error, messages = [];
  f.api.store.listExperiments = () => { throw new Error("Synthetic storage failure password=private-value"); };
  console.error = (...parts) => messages.push(parts.join(" "));
  try {
    const result = await http.request("/api/experiments");
    assert.equal(result.status, 500);
    assert.equal(result.value.error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(result.value).includes("Synthetic storage failure"));
    assert.ok(messages.some(message => message.includes("Synthetic storage failure")));
    assert.ok(messages.every(message => !message.includes("private-value")));
  } finally {
    f.api.store.listExperiments = originalList;
    console.error = originalLog;
  }
});

test("save accepts only the issued reviewed draft, not client edits with recomputed hashes", async t => {
  const f = await fixture(t), http = await f.listen();
  const prepared = await http.request("/api/experiments/draft", {
    decisionText: "Compare reviewed shipping thresholds.",
    customerCount: 1, employeeCount: 0, supplierCount: 0, resellerCount: 0, cycles: 1,
    options: [{ label: "Option", thresholdCents: 7500, shippingFeeCents: 795 }],
    objective: { metricId: "purchases", direction: "minimize" },
    constraints: [{ metricId: "abandonmentRate", comparator: "<=", threshold: 0.25, severity: "hard" }],
    runConfig: { model: "recorded-test" },
  });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
  assert.equal(prepared.value.definition.objective.metricId, "purchases");
  assert.equal(prepared.value.definition.objective.direction, "minimize");
  assert.equal(prepared.value.definition.constraints[0].threshold, 0.25);
  const submitted = { definition: prepared.value.definition, inputs: prepared.value.inputs };
  const changed = structuredClone(submitted);
  changed.definition.title = "Client-edited title with recomputed integrity digest";
  const { definitionHash: ignored, ...hashable } = changed.definition;
  changed.definition.definitionHash = stableHash(hashable);
  const rejected = await http.request("/api/experiments", changed);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.value.error.code, "DRAFT_CHANGED");
  const saved = await http.request("/api/experiments", submitted);
  assert.equal(saved.status, 201);
  assert.equal((await http.request("/api/experiments", submitted)).status, 201);
  const forged = structuredClone(submitted);
  forged.definition.experimentId = `experiment-${randomUUID()}`;
  const { definitionHash: oldHash, ...forgedHashable } = forged.definition;
  forged.definition.definitionHash = stableHash(forgedHashable);
  const unissued = await http.request("/api/experiments", forged);
  assert.equal(unissued.status, 409);
  assert.equal(unissued.value.error.code, "DRAFT_REQUIRED");
  assert.equal(f.counters.calls, 0);
});

test("JSON API persists reviewed versions, branches frozen inputs, exposes evidence and safe errors", async t => {
  const f = await fixture(t);
  const http = await f.listen(), id = f.bundle.definition.experimentId;
  const saved = await http.request("/api/experiments", { definition: f.bundle.definition, inputs: f.bundle.inputs });
  assert.equal(saved.status, 201);
  const listing = await http.request("/api/experiments");
  assert.equal(listing.value.experiments[0].experimentId, id);
  const branch = await http.request(`/api/experiments/${id}/branches`, { version: 1, decisionText: "Keep the old threshold for existing customers." });
  assert.equal(branch.status, 201, JSON.stringify(branch.value));
  assert.equal(branch.value.definition.version, 2);
  assert.equal(branch.value.inputs.populationHash, f.bundle.inputs.populationHash);
  assert.equal(stableHash(branch.value.inputs), stableHash(f.bundle.inputs));
  const olderBranch = await http.request(`/api/experiments/${id}/branches`, { version: 1, options: [{ label: "Another reviewed policy", thresholdCents: 9000, shippingFeeCents: 795 }] });
  assert.equal(olderBranch.status, 201, JSON.stringify(olderBranch.value));
  assert.equal(olderBranch.value.definition.version, 3);
  assert.equal(olderBranch.value.definition.parentVersion, 1);
  const version = await http.request(`/api/experiments/${id}?version=1`);
  assert.equal(version.value.definition.version, 1);
  assert.equal(version.value.versions.length, 3);
  const bad = structuredClone(f.bundle);
  bad.inputs.initialState.inventory[Object.keys(bad.inputs.initialState.inventory)[0]] = 999;
  const rejected = await http.request("/api/experiments", { definition: bad.definition, inputs: bad.inputs });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.value.error.code, "INVALID_EXPERIMENT");
  const evidence = f.bundle.inputs.evidence[0];
  const found = await http.request(`/api/evidence/${evidence.evidenceId}?experimentId=${id}&version=1`);
  assert.deepEqual(found.value, evidence);
  const timing = await http.request(`/api/experiments/${id}/timing`, { stage: "review", durationMs: 2500 });
  assert.deepEqual(timing.value, { recorded: true });
  const traversal = await http.request("/api/runs/..%5coutside");
  assert.equal(traversal.status, 400);
  const unknown = await http.request("/api/runs/run-missing");
  assert.equal(unknown.status, 404);
  assert.ok(!JSON.stringify(unknown.value).includes(f.root));
  const request = await http.request(`/api/experiments/${id}/runs`, { version: 3, idempotencyKey: "request-branch" });
  assert.equal(request.status, 202, JSON.stringify(request.value));
  await f.api.manager.waitForIdle();
  const run = await http.request(`/api/runs/${request.value.runId}`);
  assert.equal(run.value.status, "completed", JSON.stringify(run.value.error));
  assert.equal(run.value.manifest.version, 3);
  assert.ok(run.value.events.some(event => event.type === "scenario_started" && event.scenarioId === "baseline"));
  assert.ok(run.value.timing.some(item => item.stage === "review" && item.durationMs === 2500));
});

test("SSE reconnect replays monotonically, viewer disconnect cleans up without cancelling", async t => {
  const pending = [];
  const f = await fixture(t, { behavior: ({ standard }) => new Promise(resolve => pending.push(() => resolve(standard))) });
  const http = await f.listen(), { runId } = await f.start();
  await eventually(() => f.counters.calls === 2);
  const stoppedBefore = f.counters.stops;
  const subscribe = (after, expected, lastEventHeader = false) => new Promise((resolve, reject) => {
    const sequence = [];
    const request = httpGet(`${http.base}/api/runs/${runId}/events${lastEventHeader ? "" : `?after=${after}`}`, {
      headers: lastEventHeader ? { "Last-Event-ID": String(after) } : {},
    }, response => {
      assert.equal(response.statusCode, 200);
      let buffer = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        buffer += chunk;
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          if (!event.startsWith("id:")) continue;
          assert.match(event, /\nevent: simulation\n/);
          sequence.push(Number(event.match(/^id: (\d+)/)[1]));
          if (sequence.length === expected) { request.destroy(); resolve(sequence); return; }
        }
      });
    });
    request.on("error", error => { if (error.code !== "ECONNRESET") reject(error); });
  });
  const count = f.api.store.readRun(runId).events.length;
  assert.deepEqual(await subscribe(0, count), Array.from({ length: count }, (_, index) => index + 1));
  await eventually(() => f.api.store.listenerCount() === 0);
  assert.equal(f.api.store.readRun(runId).status, "running");
  assert.equal(f.counters.stops, stoppedBefore);
  assert.deepEqual(await subscribe(count - 2, 2, true), [count - 1, count]);
  await eventually(() => f.api.store.listenerCount() === 0);
  const invalid = await http.request(`/api/runs/${runId}/events?after=999999`);
  assert.equal(invalid.status, 400);
  await f.api.manager.cancel(runId);
  pending.forEach(resolve => resolve());
});
