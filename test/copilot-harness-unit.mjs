import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { CopilotHarness, copilotSdkEnvironment } from "../src/copilotHarness.mjs";
import { AiEngine, createSimulationEngine, preflightProvider } from "../src/aiEngine.mjs";

const MODEL = "fixture-mai";
const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeClient {
  constructor({ mode = "success", auth, models = [{ id: "auto" }], stopHangs = false, forceFails = false } = {}) {
    this.mode = mode;
    this.auth = auth || { isAuthenticated: true, authType: "user" };
    this.models = models;
    this.sessions = [];
    this.sent = [];
    this.deleted = [];
    this.stopCalls = 0;
    this.forceCalls = 0;
    this.abortCalls = 0;
    this.startCalls = 0;
    this.modelCalls = 0;
    this.stopHangs = stopHangs;
    this.forceFails = forceFails;
    this.options = null;
  }
  factory = (options) => { this.options = options; return this; };
  async start() {
    this.startCalls++;
    if (this.mode === "startup-hang") await new Promise(resolve => { this.finishStartup = resolve; });
    this.connected = true;
  }
  async getStatus() { return { version: "1.0.85", protocolVersion: 3 }; }
  async getAuthStatus() { return this.auth; }
  async listModels() {
    this.modelCalls++;
    if (this.mode === "catalog-error") throw new Error("Catalog unavailable");
    return this.models;
  }
  async createSession(config) {
    if (this.mode === "create-error") throw new Error("Model fixture-mai is not available");
    if (this.mode === "create-hang") await new Promise((resolve) => { this.finishCreation = resolve; });
    const client = this;
    const session = {
      sessionId: `fixture-session-${this.sessions.length + 1}`,
      config,
      async abort() { client.abortCalls++; },
      async sendAndWait({ prompt }) {
        client.sent.push({ prompt, sessionId: session.sessionId });
        if (client.mode === "hang") await new Promise((resolve) => { session.finish = resolve; });
        if (client.mode === "slow") await pause(20);
        if (client.mode === "auth-error") throw new Error("401 authentication; private-fixture-never-expose");
        if (client.mode === "rate-limit") throw new Error("429 rate limit");
        if (client.mode === "tool") config.onEvent({ type: "tool.execution_start", data: { toolName: "read_file" } });
        config.onEvent({ type: "assistant.reasoning", data: { content: "hidden-fixture-not-to-store" } });
        if (client.mode !== "no-model") config.onEvent({
          type: "assistant.usage",
          data: { model: client.mode === "wrong-model" ? "other-model" : config.model, inputTokens: 12, outputTokens: 4 },
        });
        let content = '{"ready":true}';
        if (client.mode === "application-error") content = '{"error":"not an action"}';
        if (client.mode === "schema-error") content = "READY";
        if (client.mode === "oversize") content = "x".repeat(10000);
        const response = { type: "assistant.message", data: { content } };
        config.onEvent(response);
        return response;
      },
    };
    this.sessions.push(session);
    return session;
  }
  async deleteSession(id) { this.deleted.push(id); }
  async stop() {
    this.stopCalls++;
    if (this.stopHangs) await new Promise(() => {});
    this.connected = false;
    return [];
  }
  async forceStop() {
    this.forceCalls++;
    if (this.forceFails) throw new Error("fixture stop failed");
  }
}

async function ready(client = new FakeClient(), options = {}) {
  const engine = new CopilotHarness({ model: MODEL, clientFactory: client.factory, stopTimeoutMs: 30, ...options });
  await engine.start();
  return { engine, client };
}

async function eventually(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await pause(5);
  assert.ok(predicate());
}

test("H0 factory selects SDK while preserving the legacy CLI class", () => {
  const sdk = createSimulationEngine({ provider: "copilot", model: MODEL, clientFactory: new FakeClient().factory });
  assert.ok(sdk instanceof CopilotHarness);
  assert.ok(!(sdk instanceof AiEngine));
  assert.ok(createSimulationEngine({ provider: "copilot", model: MODEL, transport: "cli", clientFactory: new FakeClient().factory }) instanceof CopilotHarness);
  assert.ok(createSimulationEngine({ provider: "claude", model: "fixture-claude" }) instanceof AiEngine);
});

test("SDK auth preserves Copilot state without injecting personal gh or custom-provider credentials", async () => {
  const env = copilotSdkEnvironment({
    COPILOT_HOME: "existing-copilot-home", HOME: "home", PATH: "path",
    GH_TOKEN: "private-gh", GITHUB_TOKEN: "private-repo", COPILOT_GITHUB_TOKEN: "not-implicitly-selected",
    GH_CONFIG_DIR: "repo-account", GH_HOST: "repo-host.example",
    COPILOT_PROVIDER_API_KEY: "private-byok", COPILOT_PROVIDER_BASE_URL: "https://other.example",
    COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "untrusted", NODE_OPTIONS: "--require arbitrary",
  });
  assert.equal(env.COPILOT_HOME, "existing-copilot-home");
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_CONFIG_DIR", "GH_HOST", "COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BASE_URL", "COPILOT_CUSTOM_INSTRUCTIONS_DIRS", "NODE_OPTIONS"]) {
    assert.equal(env[name], undefined);
  }
  const { engine, client } = await ready();
  try {
    assert.equal(client.options.useLoggedInUser, true);
    assert.equal(client.options.gitHubToken, undefined);
    assert.equal(client.options.baseDirectory, undefined);
    assert.equal(client.options.mode, "copilot-cli");
    assert.equal(engine.authSource, "user");
  } finally { await engine.stop(); }
});

test("missing Copilot auth and personal gh fallback cannot launch model calls", async () => {
  for (const auth of [
    { isAuthenticated: false },
    { isAuthenticated: true, authType: "gh-cli" },
    { isAuthenticated: true, authType: "api-key" },
  ]) {
    const client = new FakeClient({ auth });
    const status = await preflightProvider({ model: MODEL, clientFactory: client.factory });
    assert.equal(status.ready, false);
    assert.equal(status.error.category, "authentication");
    assert.equal(client.sent.length, 0);
    assert.equal(client.stopCalls, 1);
  }
});

test("incomplete SDK catalog never silently changes or rejects a working explicit model", async () => {
  const client = new FakeClient();
  const status = await preflightProvider({ model: MODEL, clientFactory: client.factory });
  assert.equal(client.modelCalls, 1);
  assert.deepEqual(status.availableModels, [{ id: "auto", policy: null }]);
  assert.equal(status.ready, true);
  assert.equal(status.requestedModel, MODEL);
  assert.equal(status.resolvedModel, MODEL);
  assert.equal(status.modelResolution, "reported");
  assert.equal(status.cliVersion, "1.0.85");
  assert.equal(status.authSource, "user");
  assert.equal(client.sessions[0].config.model, MODEL);
  assert.equal(client.sent.length, 1);
  assert.equal(client.stopCalls, 1);
});

test("catalog outages allow the explicit probe, but a reported disabled policy is respected", async () => {
  const unavailable = await preflightProvider({ model: MODEL, clientFactory: new FakeClient({ mode: "catalog-error" }).factory });
  assert.equal(unavailable.ready, true);
  assert.equal(unavailable.catalogStatus, "unavailable");
  const client = new FakeClient({ models: [{ id: MODEL, policy: { state: "disabled" } }] });
  const disabled = await preflightProvider({ model: MODEL, clientFactory: client.factory });
  assert.equal(disabled.ready, false);
  assert.equal(disabled.error.category, "model_unavailable");
  assert.equal(client.sent.length, 0);
});

test("each stakeholder receives a fresh SDK session with all ambient capabilities disabled", async () => {
  const { engine, client } = await ready();
  try {
    const a = await engine.askEnvelope("First private actor context", { attemptId: "attempt-1", promptVersion: "shipping-v1" });
    const b = await engine.askEnvelope("Second private actor context");
    assert.equal(a.errorCategory, undefined);
    assert.equal(b.errorCategory, undefined);
    assert.equal(a.attemptId, "attempt-1");
    assert.equal(a.promptVersion, "shipping-v1");
    assert.deepEqual(a.usage, { inputTokens: 12, outputTokens: 4 });
    assert.notEqual(client.sessions[0].sessionId, client.sessions[1].sessionId);
    assert.notEqual(client.sessions[0].config.workingDirectory, client.sessions[1].config.workingDirectory);
    for (const { config } of client.sessions) {
      for (const field of ["availableTools", "tools", "customAgents", "skillDirectories", "pluginDirectories", "instructionDirectories", "additionalDirectories"]) assert.deepEqual(config[field], []);
      for (const field of ["enableConfigDiscovery", "enableFileHooks", "enableHostGitOperations", "enableSessionStore", "enableSkills", "enableSessionTelemetry", "enableExperimentalMode", "enableMcpApps"]) assert.equal(config[field], false);
      assert.equal(config.skipCustomInstructions, true);
      assert.deepEqual(config.mcpServers, {});
      assert.deepEqual(config.memory, { enabled: false });
      assert.deepEqual(config.onPermissionRequest(), { kind: "reject" });
      assert.equal(config.remoteSession, "off");
      assert.equal(config.provider, undefined);
      assert.equal(config.gitHubToken, undefined);
    }
    assert.equal(client.deleted.length, 2);
    assert.equal(engine.activeSessions.size, 0);
    assert.ok(!JSON.stringify(a).includes("hidden-fixture"));
  } finally { await engine.stop(); }
  assert.equal(existsSync(engine.workspace), false);
});

test("SDK carries a 256KiB prompt as RPC content, not a process argument", async () => {
  const { engine, client } = await ready();
  try {
    const prompt = "x".repeat(256 * 1024);
    const envelope = await engine.askEnvelope(prompt);
    assert.equal(envelope.errorCategory, undefined);
    assert.equal(client.sent[0].prompt, prompt);
    assert.ok(!JSON.stringify(client.options).includes(prompt));
    assert.equal(engine.calls, 1);
  } finally { await engine.stop(); }
});

test("model mismatch, application errors, and forbidden tool events are rejected", async () => {
  for (const [mode, expected] of [
    ["wrong-model", "model_mismatch"], ["application-error", "application_error"], ["tool", "transport"],
    ["auth-error", "authentication"], ["rate-limit", "rate_limit"],
  ]) {
    const { engine, client } = await ready(new FakeClient({ mode }));
    try {
      const envelope = await engine.askEnvelope("actor", { retries: 5 });
      assert.equal(envelope.errorCategory, expected);
      assert.equal(envelope.text, null);
      assert.equal(client.sent.length, 1);
      assert.equal(engine.calls, 1);
      assert.ok(!JSON.stringify(envelope).includes("private-fixture"));
    } finally { await engine.stop(); }
  }
});

test("the pinned model cannot be overridden mid-run and SDK model creation errors are safe", async () => {
  const { engine, client } = await ready();
  try {
    const mismatch = await engine.askEnvelope("actor", { model: "other-model" });
    assert.equal(mismatch.errorCategory, "model_mismatch");
    assert.equal(client.sent.length, 0);
  } finally { await engine.stop(); }
  const unavailable = await preflightProvider({ model: MODEL, clientFactory: new FakeClient({ mode: "create-error" }).factory });
  assert.equal(unavailable.ready, false);
  assert.equal(unavailable.error.category, "model_unavailable");
});

test("SDK preflight requires an explicit model and rejects invalid readiness schemas", async () => {
  for (const model of [undefined, "auto"]) {
    const client = new FakeClient();
    const status = await preflightProvider({ model, clientFactory: client.factory });
    assert.equal(status.ready, false);
    assert.equal(status.error.category, "model_required");
    assert.equal(client.startCalls, 0);
  }
  const invalid = await preflightProvider({ model: MODEL, clientFactory: new FakeClient({ mode: "schema-error" }).factory });
  assert.equal(invalid.ready, false);
  assert.equal(invalid.error.category, "schema");
});

test("missing SDK model identity remains unresolved rather than guessed", async () => {
  const status = await preflightProvider({ model: MODEL, clientFactory: new FakeClient({ mode: "no-model" }).factory });
  assert.equal(status.ready, true);
  assert.equal(status.resolvedModel, null);
  assert.equal(status.modelResolution, "unresolved");
});

test("abort cancels queued and active sessions without late successful envelopes", async () => {
  const { engine, client } = await ready(new FakeClient({ mode: "hang" }), { concurrency: 1 });
  const active = new AbortController(), queued = new AbortController();
  try {
    const first = engine.askEnvelope("first", { signal: active.signal });
    await eventually(() => client.sent.length === 1);
    const second = engine.askEnvelope("second", { signal: queued.signal });
    queued.abort();
    assert.equal((await second).errorCategory, "cancelled");
    active.abort();
    const result = await first;
    assert.equal(result.errorCategory, "cancelled");
    assert.equal(result.text, null);
    assert.equal(engine.calls, 1);
    assert.equal(client.abortCalls, 1);
    client.sessions[0].finish();
    await pause();
    assert.equal(result.text, null);
    assert.equal(engine.activeSessions.size, 0);
  } finally { await engine.stop(); }
});

test("SDK deadlines and output caps fail closed with cleanup and attempt accounting", async () => {
  const { engine, client } = await ready(new FakeClient({ mode: "hang" }));
  try {
    const result = await engine.askEnvelope("actor", { timeout: 20 });
    assert.equal(result.errorCategory, "timeout");
    assert.equal(engine.calls, 1);
    assert.equal(client.abortCalls, 1);
    assert.equal(client.deleted.length, 1);
    client.sessions[0].finish();
  } finally { await engine.stop(); }
  const capped = await ready(new FakeClient({ mode: "oversize" }), { maxOutputBytes: 1000 });
  try { assert.equal((await capped.engine.askEnvelope("actor")).errorCategory, "output_limit"); }
  finally { await capped.engine.stop(); }
});

test("pre-aborted and expired requests never create a session or spend an inference attempt", async () => {
  const { engine, client } = await ready();
  try {
    const controller = new AbortController();
    controller.abort();
    assert.equal((await engine.askEnvelope("actor", { signal: controller.signal })).errorCategory, "cancelled");
    assert.equal((await engine.askEnvelope("actor", { deadlineAt: Date.now() - 1 })).errorCategory, "timeout");
    assert.equal(engine.calls, 0);
    assert.equal(client.sessions.length, 0);
  } finally { await engine.stop(); }
});

test("stop cancels pending work but cannot claim an unverified forced shutdown succeeded", async () => {
  const { engine, client } = await ready(new FakeClient({ mode: "hang", stopHangs: true }), { concurrency: 1 });
  const first = engine.askEnvelope("first");
  await eventually(() => client.sent.length === 1);
  const queued = engine.askEnvelope("queued");
  await assert.rejects(engine.stop(), { category: "stop_unconfirmed" });
  assert.equal((await first).errorCategory, "cancelled");
  assert.equal((await queued).errorCategory, "cancelled");
  assert.equal(client.stopCalls, 1);
  assert.equal(client.forceCalls, 1);
  client.sessions[0].finish();
  await assert.rejects(engine.stop(), { category: "stop_unconfirmed" });
  assert.equal((await engine.askEnvelope("late")).errorCategory, "not_started");
  rmSync(engine.workspace, { recursive: true, force: true });
});

test("unconfirmed forced shutdown is surfaced rather than reported stopped", async () => {
  const { engine } = await ready(new FakeClient({ stopHangs: true, forceFails: true }));
  try { await assert.rejects(engine.stop(), (error) => error.category === "stop_unconfirmed"); }
  finally { rmSync(engine.workspace, { recursive: true, force: true }); }
});

test("cancellation during SDK startup and late session creation cannot dispatch inference", async () => {
  const startingClient = new FakeClient({ mode: "startup-hang" });
  const starting = new CopilotHarness({ model: MODEL, clientFactory: startingClient.factory, stopTimeoutMs: 30 });
  const start = starting.start();
  const rejected = assert.rejects(start, (error) => error.category === "cancelled");
  await eventually(() => startingClient.startCalls === 1);
  let stopped = false;
  const stopping = starting.stop().then(() => { stopped = true; });
  await pause(5);
  assert.equal(stopped, false);
  startingClient.finishStartup();
  await stopping;
  await rejected;
  assert.equal(startingClient.connected, false);
  const { engine, client } = await ready(new FakeClient({ mode: "create-hang" }));
  const controller = new AbortController();
  const request = engine.askEnvelope("actor", { signal: controller.signal });
  await eventually(() => !!client.finishCreation);
  controller.abort();
  assert.equal((await request).errorCategory, "cancelled");
  client.finishCreation();
  await eventually(() => client.deleted.length === 1);
  assert.equal(client.sent.length, 0);
  await engine.stop();
});

test("an idle deletion timeout does not cancel a concurrent supplier repair", async () => {
  const client = new FakeClient();
  const create = client.createSession.bind(client);
  client.createSession = async config => {
    const session = await create(config);
    const send = session.sendAndWait.bind(session);
    session.sendAndWait = async message => {
      if (message.prompt === "supplier repair") await pause(75);
      return send(message);
    };
    return session;
  };
  client.deleteSession = async id => {
    client.deleted.push(id);
    if (id === "fixture-session-1") await new Promise(() => {});
  };
  const { engine } = await ready(client);
  try {
    const employee = engine.askEnvelope("employee");
    const first = await engine.askEnvelope("supplier initial");
    assert.equal(first.errorCategory, undefined);
    const repair = engine.askEnvelope("supplier repair");
    const result = await employee;
    assert.equal(result.errorCategory, undefined);
    assert.equal(result.cleanupWarnings[0].code, "SESSION_CLEANUP_DEFERRED");
    assert.equal(result.cleanupWarnings[0].category, "timeout");
    assert.equal((await repair).errorCategory, undefined);
    assert.equal(client.sent.length, 3);
    assert.equal(client.stopCalls, 0);
    assert.equal(engine.stopped, false);
  } finally { await engine.stop(); }
  assert.equal(client.stopCalls, 1);
});

test("failed idle deletion is recorded safely and retried at shutdown", async () => {
  const client = new FakeClient();
  let attempts = 0;
  client.deleteSession = async () => {
    if (++attempts === 1) throw new Error("private-delete-diagnostic");
  };
  const { engine } = await ready(client);
  const envelope = await engine.askEnvelope("actor");
  assert.equal(envelope.errorCategory, undefined);
  assert.equal(envelope.cleanupWarnings[0].category, "provider");
  assert.ok(!JSON.stringify(envelope).includes("private-delete"));
  await engine.stop();
  assert.equal(attempts, 2);
});

test("invalid application output from an idle session never aborts another actor", async () => {
  const client = new FakeClient();
  const create = client.createSession.bind(client);
  client.createSession = async config => {
    const session = await create(config);
    const send = session.sendAndWait.bind(session);
    session.abort = async () => {
      client.abortCalls++;
      throw new Error("idle abort must not be requested");
    };
    session.sendAndWait = async message => {
      if (message.prompt === "invalid actor") {
        const response = { type: "assistant.message", data: { content: '{"error":"invalid action"}' } };
        config.onEvent(response);
        return response;
      }
      await pause(40);
      return send(message);
    };
    return session;
  };
  const { engine } = await ready(client);
  try {
    const other = engine.askEnvelope("other actor");
    const invalid = await engine.askEnvelope("invalid actor");
    assert.equal(invalid.errorCategory, "application_error");
    assert.equal((await other).errorCategory, undefined);
    assert.equal(client.abortCalls, 0);
    assert.equal(client.stopCalls, 0);
    assert.equal(engine.stopped, false);
  } finally { await engine.stop(); }
});

test("actual SDK forceStop swallowing a kill failure remains unconfirmed", async () => {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  const client = new CopilotClient({ connection: RuntimeConnection.forStdio() });
  // No runtime is spawned: exercise the installed SDK's shutdown implementation.
  client.cliProcess = { exitCode: null, signalCode: null, kill() { throw new Error("fixture kill failure"); } };
  const engine = new CopilotHarness({ model: MODEL, stopTimeoutMs: 30 });
  engine.client = client;
  await assert.rejects(engine.stop(), { category: "stop_unconfirmed" });
});

test("shutdown without the SDK cleanup success contract remains unconfirmed", async () => {
  const client = new FakeClient();
  client.stop = async () => undefined;
  const { engine } = await ready(client);
  try {
    await assert.rejects(engine.stop(), { category: "stop_unconfirmed" });
    assert.equal(client.forceCalls, 1);
  } finally { rmSync(engine.workspace, { recursive: true, force: true }); }
});

test("preflight cancellation never masks unconfirmed runtime termination", async () => {
  const controller = new AbortController();
  const client = new FakeClient();
  client.stop = async () => {
    controller.abort();
    return [new Error("private shutdown error")];
  };
  const status = await preflightProvider({ model: MODEL, signal: controller.signal, clientFactory: client.factory });
  try {
    assert.equal(status.ready, false);
    assert.equal(status.error.category, "stop_unconfirmed");
    assert.ok(!JSON.stringify(status).includes("private shutdown"));
  } finally { rmSync(dirname(client.options.workingDirectory), { recursive: true, force: true }); }
});

test("cancelled and deadline-aborted preflights preserve shutdown failure over the call error", async () => {
  for (const category of ["cancelled", "timeout"]) {
    const controller = new AbortController();
    const client = new FakeClient({ mode: "hang", forceFails: true });
    client.stop = async () => [new Error("private shutdown failure")];
    const preflight = preflightProvider({ model: MODEL, signal: controller.signal, clientFactory: client.factory });
    await eventually(() => client.sent.length === 1);
    controller.abort(Object.assign(new Error("fixture abort"), { category }));
    try {
      const status = await preflight;
      assert.equal(status.ready, false);
      assert.equal(status.error.category, "stop_unconfirmed");
      assert.equal(client.forceCalls, 1);
      assert.ok(!JSON.stringify(status).includes("private shutdown"));
    } finally {
      client.sessions[0].finish();
      rmSync(dirname(client.options.workingDirectory), { recursive: true, force: true });
    }
  }
});

test("startup beyond the cleanup grace blocks scheduling and still cleans up its late child", async () => {
  const client = new FakeClient({ mode: "startup-hang" });
  const engine = new CopilotHarness({ model: MODEL, clientFactory: client.factory, stopTimeoutMs: 15 });
  const start = assert.rejects(engine.start(), { category: "stop_unconfirmed" });
  await eventually(() => client.startCalls === 1);
  await assert.rejects(engine.stop(), { category: "stop_unconfirmed" });
  await start;
  client.finishStartup();
  await eventually(() => client.stopCalls === 1 && client.connected === false);
  assert.equal(client.sent.length, 0);
  await assert.rejects(engine.stop(), { category: "stop_unconfirmed" });
  rmSync(engine.workspace, { recursive: true, force: true });
});

test("a late client factory cannot escape cancelled startup cleanup", async () => {
  const client = new FakeClient();
  let finishFactory;
  const engine = new CopilotHarness({
    model: MODEL, stopTimeoutMs: 30,
    clientFactory: () => new Promise(resolve => { finishFactory = () => resolve(client); }),
  });
  const start = assert.rejects(engine.start(), { category: "cancelled" });
  await eventually(() => Boolean(finishFactory));
  const stopping = engine.stop();
  finishFactory();
  await stopping;
  await start;
  assert.equal(client.startCalls, 0);
  assert.equal(client.stopCalls, 1);
});

test("actual SDK delayed transport startup is stopped before the scheduler barrier resolves", async () => {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  const client = new CopilotClient({ connection: RuntimeConnection.forStdio(), builtinPluginDirectories: [] });
  let finishTransport, killCalls = 0, metadataCalls = 0;
  const child = new EventEmitter();
  child.exitCode = child.signalCode = null;
  child.kill = () => {
    killCalls++;
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
    return true;
  };
  // Substitute only transport and protocol I/O; SDK start/stop lifecycle remains real.
  client.startCLIServer = async () => {
    await new Promise(resolve => { finishTransport = resolve; });
    client.cliProcess = child;
  };
  client.connectToServer = async () => {};
  client.verifyProtocolVersion = async () => {};
  client.getStatus = async () => { metadataCalls++; return { version: "fixture" }; };
  const engine = new CopilotHarness({ model: MODEL, clientFactory: () => client, stopTimeoutMs: 250 });
  const controller = new AbortController();
  const starting = assert.rejects(engine.start({ signal: controller.signal }), { category: "cancelled" });
  await eventually(() => Boolean(finishTransport));
  controller.abort();
  let barrierReleased = false;
  const stopping = engine.stop().then(() => { barrierReleased = true; });
  await pause(5);
  assert.equal(barrierReleased, false);
  finishTransport();
  await Promise.all([starting, stopping]);
  assert.equal(child.signalCode, "SIGTERM");
  assert.equal(killCalls, 1);
  assert.equal(metadataCalls, 0);
  assert.equal(engine.pendingStartup.size, 0);
  await engine.stop();
  assert.equal(killCalls, 1);
});

test("failed SDK handshake cannot hide a swallowed startup kill failure", async () => {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  const client = new CopilotClient({ connection: RuntimeConnection.forStdio(), builtinPluginDirectories: [] });
  let killCalls = 0;
  const child = {
    exitCode: null, signalCode: null,
    kill() { killCalls++; throw new Error("fixture kill failure"); },
  };
  client.startCLIServer = async () => { client.cliProcess = child; };
  client.connectToServer = async () => {};
  client.verifyProtocolVersion = async () => { throw new Error("fixture handshake failure"); };
  const engine = new CopilotHarness({ model: MODEL, clientFactory: () => client, stopTimeoutMs: 30 });
  try {
    await assert.rejects(engine.start(), { category: "stop_unconfirmed" });
    assert.equal(killCalls, 1);
    assert.equal(client.cliProcess, null);
    assert.equal(engine.clientStopped, false);
    await assert.rejects(engine.stop(), { category: "stop_unconfirmed" });
    assert.equal((await engine.askEnvelope("late")).errorCategory, "not_started");
  } finally { rmSync(engine.workspace, { recursive: true, force: true }); }
});
