import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore, contentHash, LIMITS, safeId } from "../src/sim/store.mjs";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const root = join(repository, `.test-persistence-${randomUUID()}`);
  mkdirSync(root);
  let store = await createStore({ root });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const definition = { experimentId: "experiment-test", version: 1, title: "Fixture", scenarios: [{ scenarioId: "baseline" }] };
  const inputs = { snapshot: { hash: "fixture" }, evidence: [] };
  store.saveExperiment({ definition, inputs });
  function create(runId = "run-test", key = "request-key") {
    const requestHash = contentHash({ experimentId: definition.experimentId, version: 1 });
    const { keyHash } = store.findRequest(definition.experimentId, key, requestHash, 1);
    return store.createRun({
      runId, experimentId: definition.experimentId, version: 1, createdAt: new Date().toISOString(),
      definition, inputs, idempotencyKeyHash: keyHash, requestHash,
    });
  }
  return {
    root, get store() { return store; }, definition, inputs, create,
    async reopen() { store.close(); store = await createStore({ root }); return store; },
  };
}

function begin(store, runId = "run-test") {
  store.append(runId, "run_preparing");
  store.append(runId, "run_started");
}
function commit(store, round = 1, runId = "run-test") {
  const state = { round, total: round * 10 }, actions = [{ actorId: "actor-test", action: { type: "defer" } }];
  const events = [{ eventId: `baseline-${round}-0`, amount: 10 }];
  return store.append(runId, "round_committed", {
    round, state, actions, events, stateHash: contentHash(state),
    actionsHash: contentHash(actions), eventsHash: contentHash(events),
  }, "baseline");
}

test("immutable version files, manifests and request mappings", async t => {
  const f = await fixture(t);
  const saved = f.store.getExperiment("experiment-test");
  f.store.saveExperiment({ definition: f.definition, inputs: f.inputs });
  assert.throws(() => f.store.saveExperiment({ definition: { ...f.definition, title: "Changed" }, inputs: f.inputs }), { code: "IMMUTABLE_VERSION" });
  const run = f.create();
  const manifestPath = join(f.root, "runs", "run-test", "manifest.json");
  const original = readFileSync(manifestPath, "utf8");
  run.manifest.definition.title = "Mutable caller copy";
  assert.equal(f.store.readRun("run-test").manifest.definition.title, "Fixture");
  begin(f.store);
  commit(f.store);
  assert.equal(readFileSync(manifestPath, "utf8"), original);
  const requestHash = contentHash({ experimentId: "experiment-test", version: 1 });
  assert.equal(f.store.findRequest("experiment-test", "request-key", requestHash, 1).runId, "run-test");
  assert.throws(() => f.store.findRequest("experiment-test", "request-key", "different", 2), { code: "IDEMPOTENCY_CONFLICT" });
  assert.equal(f.store.getExperiment("experiment-test").bundleHash, saved.bundleHash);
});

test("commit log recovers crash before snapshot and excludes uncommitted work", async t => {
  const f = await fixture(t);
  f.create();
  begin(f.store);
  f.store.writeSnapshot = () => { throw new Error("Simulated crash before snapshot"); };
  const event = commit(f.store);
  f.store.append("run-test", "actor_completed", { actorId: "later", round: 2, validated: true, committed: false });
  await f.reopen();
  const recovered = f.store.readRun("run-test");
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.rounds.baseline.length, 1);
  assert.equal(recovered.rounds.baseline[0].stateHash, event.data.stateHash);
  assert.equal(recovered.rounds.baseline[0].actions.length, 1);
  assert.equal(recovered.events.at(-1).type, "run_interrupted");
});

test("incomplete log tail is discarded but non-tail corruption is rejected", async t => {
  const f = await fixture(t);
  f.create();
  begin(f.store);
  commit(f.store);
  const log = join(f.root, "runs", "run-test", "events.jsonl");
  appendFileSync(log, '{"sequence":');
  await f.reopen();
  assert.equal(f.store.readRun("run-test").rounds.baseline.length, 1);
  f.store.close();
  const lines = readFileSync(log, "utf8").split("\n");
  lines[1] = "{broken record}";
  writeFileSync(log, lines.join("\n"));
  await assert.rejects(createStore({ root: f.root }), { code: "CORRUPT_LOG" });
  assert.equal(existsSync(join(f.root, "store.lock")), false);
});

test("valid JSON event tampering and sequence gaps fail integrity checking", async t => {
  const f = await fixture(t);
  f.create();
  begin(f.store);
  const path = join(f.root, "runs", "run-test", "events.jsonl");
  f.store.close();
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const changed = JSON.parse(lines[1]);
  changed.sequence = 999;
  lines[1] = JSON.stringify(changed);
  writeFileSync(path, lines.join("\n") + "\n");
  await assert.rejects(createStore({ root: f.root }), { code: "CORRUPT_LOG" });
});

test("recovery reconstructs mapping after a manifest-to-index crash", async t => {
  const f = await fixture(t);
  const run = f.create();
  const path = join(f.root, "idempotency", `${run.manifest.idempotencyKeyHash}.json`);
  unlinkSync(path);
  await f.reopen();
  assert.equal(existsSync(path), true);
  assert.equal(f.store.findRequest("experiment-test", "request-key", run.manifest.requestHash, 1).runId, "run-test");
  assert.equal(f.store.readRun("run-test").status, "interrupted");
});

test("persisted-before-published replay is ordered through synchronous subscription races", async t => {
  const f = await fixture(t);
  f.create();
  begin(f.store);
  const received = [], log = join(f.root, "runs", "run-test", "events.jsonl");
  const unsubscribe = f.store.subscribe("run-test", 0, event => {
    const persisted = readFileSync(log, "utf8").trimEnd().split("\n").map(JSON.parse);
    assert.ok(persisted.some(item => item.eventHash === event.eventHash));
    received.push(event.sequence);
    if (event.sequence === 1) f.store.append("run-test", "actor_started", { actorId: "during-replay" });
  });
  assert.deepEqual(received, [1, 2, 3, 4]);
  assert.equal(f.store.listenerCount("run-test"), 1);
  f.store.append("run-test", "actor_completed", { actorId: "during-replay", validated: true, committed: false });
  assert.deepEqual(received, [1, 2, 3, 4, 5]);
  unsubscribe();
  unsubscribe();
  assert.equal(f.store.listenerCount(), 0);
  const resumed = [];
  f.store.subscribe("run-test", 3, event => resumed.push(event.sequence))();
  assert.deepEqual(resumed, [4, 5]);
  assert.throws(() => f.store.subscribe("run-test", 100, () => {}), { code: "INVALID_CURSOR" });
  f.store.subscribe("run-test", 0, () => { throw new Error("Disconnected viewer"); });
  assert.equal(f.store.listenerCount(), 0);
});

test("terminal outputs stay immutable and stopped states recover as interrupted", async t => {
  const f = await fixture(t);
  for (const [index, desired] of ["queued", "preparing", "running", "aggregating", "paused"].entries()) {
    const id = `run-${index}`;
    f.create(id, `request-${index}`);
    if (desired !== "queued") f.store.append(id, "run_preparing");
    if (["running", "aggregating", "paused"].includes(desired)) f.store.append(id, "run_started");
    if (desired === "aggregating") f.store.append(id, "run_aggregating");
    if (desired === "paused") f.store.append(id, "run_paused");
  }
  f.create("run-cancelled", "request-cancelled");
  f.store.append("run-cancelled", "run_cancelled");
  assert.throws(() => begin(f.store, "run-cancelled"), { code: "TERMINAL_RUN" });
  const original = f.store.readRun("run-cancelled");
  await f.reopen();
  for (let index = 0; index < 5; index++) assert.equal(f.store.readRun(`run-${index}`).status, "interrupted");
  assert.deepEqual(f.store.readRun("run-cancelled"), original);
});

test("reentrant live publication cannot overtake an event for another subscriber", async t => {
  const f = await fixture(t);
  f.create();
  const first = [], second = [];
  const unsubscribeFirst = f.store.subscribe("run-test", 1, event => {
    first.push(event.sequence);
    if (event.type === "run_preparing") f.store.append("run-test", "preparing_detail", {});
  });
  const unsubscribeSecond = f.store.subscribe("run-test", 1, event => second.push(event.sequence));
  f.store.append("run-test", "run_preparing", {});
  assert.deepEqual(first, [2, 3]);
  assert.deepEqual(second, [2, 3]);
  unsubscribeFirst();
  unsubscribeSecond();
  assert.equal(f.store.listenerCount(), 0);
});

test("storage bounds, traversal protection, credentials and single-writer lease", async t => {
  const f = await fixture(t);
  for (const id of ["../outside", "..", "a/b", "a\\b", "CON", "nul", "x\u0000y", "a".repeat(97)]) assert.throws(() => safeId(id), { code: "INVALID_ID" });
  await assert.rejects(createStore({ root: f.root }), { code: "STORAGE_BUSY" });
  assert.equal(existsSync(join(f.root, "store.lock")), true);
  assert.throws(() => f.store.saveExperiment({
    definition: { ...f.definition, version: 2 }, inputs: { password: "do-not-save" },
  }), { code: "SENSITIVE_DATA" });
  f.create();
  assert.throws(() => f.store.append("run-test", "oversized", { text: "x".repeat(LIMITS.eventBytes) }), { code: "SIZE_LIMIT" });
  assert.equal(f.store.readRun("run-test").events.length, 1);
  assert.throws(() => commit(f.store), { code: "INVALID_ROUND" });
  f.store.writeDebug("run-test", "debug-call", { rawText: "password=private", envelope: { access_token: "private" } });
  const debug = readFileSync(join(f.root, "runs", "run-test", "debug", "debug-call.json"), "utf8");
  assert.ok(!debug.includes("private"));
});
