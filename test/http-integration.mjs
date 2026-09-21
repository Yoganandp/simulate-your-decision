import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { createAppServer } from "../src/server.mjs";

const root = await mkdtemp(join(tmpdir(), "simulations-http-"));
const recordedAction = {
  type: "no_action", parameters: {}, explanation: "Recorded mechanical fixture, not behavioral evidence.",
  evidenceIds: [], assumptionIds: [],
};
let inferenceCalls = 0;
let delayed = false;
let stops = 0;
const engineFactory = (config) => {
  const pending = new Set();
  return {
    provider: "copilot",
    model: config.model,
    calls: 0,
    async start() { return config.model; },
    describe() { return "Recorded mechanical fixture"; },
    async askEnvelope() {
      inferenceCalls++;
      this.calls++;
      if (delayed) await new Promise((resolve) => pending.add(resolve));
      return {
        text: JSON.stringify(recordedAction), provider: "copilot",
        requestedModel: config.model, resolvedModel: config.model,
        modelResolution: "verified", cliVersion: "fixture",
        durationMs: 1, attemptId: `fixture-${inferenceCalls}`, usage: null,
      };
    },
    async stop() {
      stops++;
      for (const resolve of pending) resolve();
      pending.clear();
    },
  };
};
const preflight = async ({ model }) => ({
  ready: true, provider: "copilot", requestedModel: model, resolvedModel: model,
  modelResolution: "verified", cliVersion: "fixture", checkedAt: new Date().toISOString(),
});
let app;
try {
  app = await createAppServer({ root, engineFactory, preflight });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const status = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = http.get(`${base}${path}`, { headers }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
    req.once("error", reject);
  });
  let token = (await (await fetch(`${base}/api/session`)).json()).token;
  const request = async (path, body, expected = 200) => {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Simulation-Token": token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, expected, `${path}: ${text}`);
    return JSON.parse(text);
  };
  const terminal = async (id) => {
    for (let i = 0; i < 300; i++) {
      const run = await request(`/api/runs/${id}`);
      if (["completed", "failed", "cancelled", "interrupted", "paused"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Fixture run did not terminate.");
  };

  assert.equal((await request("/api/health")).ok, true);
  assert.equal(await status("/api/session", { Host: "attacker.example" }), 403);
  assert.equal(await status("/api/session", { Origin: "https://attacker.example" }), 403);
  const deniedWrite = await fetch(`${base}/api/experiments`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  await deniedWrite.arrayBuffer();
  assert.equal(deniedWrite.status, 403);
  const page = await fetch(base);
  assert.ok((await page.text()).includes("Copilot Simulations"));
  assert.ok(page.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
  for (const asset of ["/simulations.js", "/simulations.css", "/legacy"]) {
    assert.equal(await status(asset), 200, asset);
  }

  const draft = await request("/api/experiments/draft", {
    decisionText: "Raise the free-shipping threshold from $50 to $75. Keep the fee at $7.95.",
    customerCount: 2, employeeCount: 1, supplierCount: 1, resellerCount: 1, cycles: 1,
    options: [{ label: "$75 threshold", thresholdCents: 7500, shippingFeeCents: 795 }],
    objective: { metricId: "purchases", direction: "minimize" },
    constraints: [{ metricId: "abandonmentRate", comparator: "<=", threshold: 0.25, severity: "hard" }],
    runConfig: { provider: "copilot", model: "fixture-model", concurrency: 2 },
  });
  assert.equal(draft.inputs.actors.length, 5);
  assert.equal(draft.definition.objective.metricId, "purchases");
  assert.equal(draft.definition.objective.direction, "minimize");
  assert.equal(draft.definition.constraints[0].threshold, 0.25);
  const saved = await request("/api/experiments", { definition: draft.definition, inputs: draft.inputs }, 201);
  const id = saved.definition.experimentId;
  const payload = { version: saved.definition.version, idempotencyKey: "http-mechanical-fixture" };
  const started = await request(`/api/experiments/${id}/runs`, payload, 202);
  const repeated = await request(`/api/experiments/${id}/runs`, payload, 202);
  assert.equal(repeated.runId, started.runId);
  const run = await terminal(started.runId);
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.equal(run.results.length, 2);
  assert.ok(run.results.every((result) => result.complete && result.completedRounds === 1));
  const callsBeforeReplay = inferenceCalls;
  const replay = await request(`/api/runs/${run.runId}/replay`, {});
  assert.equal(replay.mode, "replay");
  assert.equal(replay.verified, true);
  assert.equal(inferenceCalls, callsBeforeReplay);
  assert.deepEqual(replay.results.map((result) => result.stateHash), run.results.map((result) => result.stateHash));
  const brief = await request(`/api/runs/${run.runId}/brief`, {});
  assert.ok(brief.markdown.includes("simulat"));
  assert.ok(brief.metricIds.length > 0);
  assert.match(brief.markdown, /minimize[^\n]*purchases|purchases[^\n]*minimize/i);

  const controller = new AbortController();
  const stream = await fetch(`${base}/api/runs/${run.runId}/events?after=1`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.ok(stream.headers.get("content-type").includes("text/event-stream"));
  const reader = stream.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /event: simulation/);
  const ids = [...first.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.ok(ids.length > 0 && ids.every((sequence) => sequence > 1));
  assert.equal(new Set(ids).size, ids.length);
  await reader.cancel();
  controller.abort();
  assert.equal(inferenceCalls, callsBeforeReplay);

  const branch = await request(`/api/experiments/${id}/branches`, {
    version: saved.definition.version,
    decisionText: "Use a $75 free-shipping threshold, with a $3.95 fee below it.",
    options: [{ label: "Lower fee", thresholdCents: 7500, shippingFeeCents: 395 }],
  }, 201);
  assert.equal(branch.definition.version, saved.definition.version + 1);
  assert.deepEqual(branch.inputs, saved.inputs);
  assert.deepEqual(branch.definition.objective, saved.definition.objective);
  assert.deepEqual(branch.definition.constraints, saved.definition.constraints);
  assert.equal(branch.definition.parentVersion, saved.definition.version);
  const old = await request(`/api/experiments/${id}?version=${saved.definition.version}`);
  assert.equal(old.definition.scenarios[1].policy.shippingFeeCents, 795);
  const evidence = saved.inputs.evidence[0];
  if (evidence) {
    const found = await request(`/api/evidence/${encodeURIComponent(evidence.evidenceId)}?experimentId=${id}&version=${saved.definition.version}`);
    assert.equal(found.evidenceId, evidence.evidenceId);
  }
  await request(`/api/experiments/${id}/timing`, { stage: "review", durationMs: 25 });

  delayed = true;
  const cancelled = await request(`/api/experiments/${id}/runs`, {
    version: branch.definition.version, idempotencyKey: "http-cancellation-fixture",
  }, 202);
  for (let i = 0; i < 100 && inferenceCalls === callsBeforeReplay; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await request(`/api/runs/${cancelled.runId}/cancel`, {});
  const cancelledRun = await terminal(cancelled.runId);
  assert.equal(cancelledRun.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 30));
  const afterLateOutput = await request(`/api/runs/${cancelled.runId}`);
  assert.equal(afterLateOutput.status, "cancelled");
  assert.ok(afterLateOutput.results.every((result) => result.completedRounds === 0));
  assert.ok(stops > 0);
  const callsAfterCancellation = inferenceCalls;

  await app.close();
  app = await createAppServer({ root, engineFactory, preflight });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  token = (await (await fetch(`${base}/api/session`)).json()).token;
  const reopened = await request(`/api/runs/${run.runId}`);
  assert.equal(reopened.status, "completed");
  assert.deepEqual(reopened.results, run.results);
  assert.equal(inferenceCalls, callsAfterCancellation);
  console.log("HTTP workflow, reconnect, replay, revision, cancellation and restart tests passed.");
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
