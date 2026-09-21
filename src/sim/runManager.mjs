import { randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";
import * as runtime from "../aiEngine.mjs";
import * as domain from "./domain.mjs";
import { SimulationError, TERMINAL, contentHash, publicError, safeId } from "./store.mjs";
import { createBrief } from "./brief.mjs";

const MAX_QUEUE = 8;
const STOP_WAIT_MS = 10000;
const shutdownBlocked = () => new SimulationError("STOP_UNCONFIRMED", "Provider shutdown could not be confirmed. Inference is blocked; inspect the local runtime before clearing its persisted block.", 503);
const ERROR_MESSAGES = {
  authentication: "The provider requires authentication. Configure access before starting another run.",
  model_unavailable: "The explicitly selected model is unavailable. No alternative model was used.",
  rate_limit: "The provider rate limit prevented this action from completing.",
  timeout: "The model call exceeded its deadline.",
  transient: "The provider could not complete the model call.",
  invalid_response: "The model did not return a valid action for the permitted observations.",
  cancelled: "The run was cancelled.",
  budget: "The run reached its total model-attempt budget.",
  deadline: "The run exceeded its overall deadline.",
  configuration: "Provider configuration is invalid. Review the local provider and explicit model settings before retrying.",
  stop_unconfirmed: "Provider shutdown could not be confirmed. Further inference is blocked.",
  provider: "The selected provider could not complete the operation.",
};
const RETRYABLE = new Set(["rate_limit", "timeout", "transient", "invalid_response"]);

function failure(category, status = 409) {
  const error = new SimulationError(category.toUpperCase(), ERROR_MESSAGES[category] || ERROR_MESSAGES.provider, status);
  error.category = category;
  return error;
}

function categoryOf(error) {
  const raw = String(error?.category || error?.errorCategory || error?.error?.category || error?.code || "").toLowerCase().replace(/-/g, "_");
  if (/auth|unauthor|forbidden|login/.test(raw)) return "authentication";
  if (/model.*(?:unavailable|access|not_found|unsupported|mismatch|required)|unknown_model/.test(raw)) return "model_unavailable";
  if (/rate|429/.test(raw)) return "rate_limit";
  if (/timeout|timed_out/.test(raw)) return "timeout";
  if (/cancel|abort/.test(raw)) return "cancelled";
  if (/transient|network|busy|overloaded|unavailable|502|503|econn/.test(raw)) return "transient";
  if (/invalid_response|schema|validation|parse|application_error|transport/.test(raw)) return "invalid_response";
  return ERROR_MESSAGES[raw] ? raw : "provider";
}

function boundedInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new SimulationError("INVALID_CONFIG", `Invalid ${label}.`);
  return value;
}

export function validateRunConfig(definition, inputs) {
  const config = definition?.runConfig;
  if (!config || typeof config !== "object") throw new SimulationError("INVALID_CONFIG", "Run configuration is required.");
  if (config.provider !== "copilot") throw new SimulationError("UNSUPPORTED_PROVIDER", "H0 simulations require the explicitly configured Copilot provider.");
  if (config.model != null && (typeof config.model !== "string" || config.model === "auto" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(config.model))) {
    throw new SimulationError("INVALID_MODEL", "Invalid explicit model identifier.");
  }
  boundedInteger(config.concurrency, 1, 8, "concurrency");
  boundedInteger(config.attemptCap, 1, 1000, "attempt budget");
  boundedInteger(config.deadlineMs, 100, 30 * 60 * 1000, "run deadline");
  boundedInteger(config.callTimeoutMs, 25, 120000, "call deadline");
  if (config.repetitions !== 1) throw new SimulationError("INVALID_CONFIG", "H0 supports a single repetition per scenario.");
  boundedInteger(definition.horizon?.steps, 1, 6, "horizon");
  if (!Array.isArray(definition.scenarios) || definition.scenarios.length < 2 || definition.scenarios.length > 3
    || !Array.isArray(inputs.actors) || inputs.actors.length < 1 || inputs.actors.length > 64) {
    throw new SimulationError("INVALID_CONFIG", "H0 requires a bounded stakeholder panel and a baseline with alternatives.");
  }
  for (const scenario of definition.scenarios) safeId(scenario.scenarioId, "scenario identifier");
  for (const actor of inputs.actors) safeId(actor.id, "actor identifier");
  return config;
}

function safePreflight(result, config) {
  const requestedModel = result?.requestedModel || result?.model || result?.metadata?.requestedModel;
  if (!(result?.ok === true || result?.ready === true) || result.error || result.errorCategory) {
    throw failure(categoryOf(result?.error || result || { category: "provider" }), 503);
  }
  if (requestedModel !== config.model || (result.provider && result.provider !== config.provider)) throw failure("model_unavailable", 503);
  const resolved = result.resolvedModel || result.metadata?.resolvedModel || null;
  if (resolved && resolved !== config.model) throw failure("model_unavailable", 503);
  return {
    ok: true, provider: config.provider, requestedModel: config.model,
    resolvedModel: typeof resolved === "string" ? resolved.slice(0, 128) : null,
    identityVerified: result.identityVerified === true || result.modelIdentityVerified === true || (result.modelResolution === "reported" && resolved === config.model),
    modelResolution: result.modelResolution || (resolved ? "reported" : "unresolved"),
    authSource: ["user", "environment", "unresolved"].includes(result.authSource) ? result.authSource : null,
    cliVersion: String(result.cliVersion || result.version || result.metadata?.cliVersion || "unavailable").slice(0, 160),
    checkedAt: new Date().toISOString(),
    durationMs: Number.isFinite(result.durationMs) ? Math.max(0, result.durationMs) : null,
  };
}

class Semaphore {
  constructor(limit) { this.limit = limit; this.used = 0; this.waiting = []; }
  acquire(signal) {
    if (signal.aborted) return Promise.reject(failure("cancelled"));
    if (this.waiting.length >= 128) return Promise.reject(new SimulationError("QUEUE_FULL", "The model scheduler queue is full.", 429));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => {
        this.waiting = this.waiting.filter(item => item !== waiter);
        reject(failure("cancelled"));
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.drain();
    });
  }
  drain() {
    while (this.used < this.limit && this.waiting.length) {
      const waiter = this.waiting.shift();
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(failure("cancelled")); continue; }
      this.used++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.used--;
        this.drain();
      });
    }
  }
}

function delay(ms, signal) {
  if (signal.aborted) return Promise.reject(failure("cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(failure("cancelled")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function parseAction(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 128 * 1024) throw failure("invalid_response");
  let source = text.trim();
  const fence = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) source = fence[1];
  let object;
  try { object = JSON.parse(source); } catch { throw failure("invalid_response"); }
  if (!object || typeof object !== "object" || Array.isArray(object) || Object.hasOwn(object, "error")
    || Object.hasOwn(object, "errors") || object.is_error || object.ok === false || object.status === "error") {
    throw failure("invalid_response");
  }
  return object;
}

function metadataFor(envelope, manifest, durationMs) {
  const usage = envelope?.usage;
  const numericUsage = usage && typeof usage === "object"
    ? Object.fromEntries(Object.entries(usage).filter(([key, value]) => /^[A-Za-z][A-Za-z_]{0,40}$/.test(key) && Number.isFinite(value) && value >= 0))
    : null;
  const safeUsage = numericUsage && Object.keys(numericUsage).length ? numericUsage : null;
  const resolvedModel = typeof envelope?.resolvedModel === "string" ? envelope.resolvedModel.slice(0, 128) : null;
  return {
    provider: manifest.provider, requestedModel: manifest.requestedModel,
    resolvedModel, modelResolution: resolvedModel ? "reported" : "unresolved",
    modelIdentityVerified: resolvedModel != null && (envelope?.identityVerified === true || envelope?.modelIdentityVerified === true
      || (envelope?.modelResolution === "reported" && resolvedModel === manifest.requestedModel)),
    cliVersion: manifest.cliVersion, promptVersion: manifest.promptVersions.stakeholder, actionSchemaVersion: 1,
    durationMs, usage: safeUsage, usageAvailable: safeUsage != null,
  };
}

export class RunManager {
  constructor({ store, engineFactory, preflight } = {}) {
    if (!store) throw new Error("A simulation store is required.");
    this.store = store;
    this.engineFactory = engineFactory || (options => runtime.createSimulationEngine(options));
    this.preflight = preflight || (options => runtime.preflightProvider({ ...options, transport: "sdk" }));
    this.transport = engineFactory ? "injected" : "copilot-sdk";
    this.queue = [];
    this.active = null;
    this.startTail = Promise.resolve();
    this.closed = false;
    this.providerCache = new Map();
    this.globalScheduler = new Semaphore(1);
    this.pendingStarts = 0;
    this.preflightControllers = new Set();
    this.pendingPreflights = new Set();
    this.schedulerBlocked = store.getRuntimeBlock() ? shutdownBlocked() : null;
  }

  async providerStatus(model) {
    let config;
    try {
      config = runtime.getConfiguredProvider();
      if (model) config = { ...config, model };
      if (this.schedulerBlocked) return { ready: false, provider: config?.provider || "copilot", model: config?.model || null, error: publicError(this.schedulerBlocked) };
      if (config?.provider !== "copilot" || typeof config.model !== "string" || !config.model.trim() || config.model === "auto") {
        return { ready: false, provider: config?.provider || "copilot", model: config?.model || null, error: { code: "MODEL_REQUIRED", message: "Configure Copilot with an explicit available model before running." } };
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(config.model)) throw failure("model_unavailable");
      const key = contentHash(config), cached = this.providerCache.get(key);
      if (cached && Date.now() - cached.at < 60000) return await cached.value;
      const value = this.checkedPreflight(config, 30000)
        .then(result => ({ ...result, ready: true, model: config.model }))
        .catch(error => ({
          ready: false, provider: config.provider, model: config.model,
          error: publicError(error instanceof SimulationError ? error : failure(categoryOf(error), 503)),
        }));
      if (this.providerCache.size >= 8) this.providerCache.delete(this.providerCache.keys().next().value);
      this.providerCache.set(key, { at: Date.now(), value });
      return await value;
    } catch (error) {
      return { ready: false, provider: "copilot", model: config?.model || model || null, error: publicError(error instanceof SimulationError ? error : failure(categoryOf(error), 503)) };
    }
  }

  withDeadline(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure("timeout", 503)), ms); })])
      .finally(() => clearTimeout(timer));
  }

  checkedPreflight(config, timeout) {
    const operation = this.runPreflight(config, timeout);
    this.pendingPreflights.add(operation);
    operation.then(() => this.pendingPreflights.delete(operation), () => this.pendingPreflights.delete(operation));
    return operation;
  }

  async runPreflight(config, timeout) {
    if (this.schedulerBlocked) throw this.schedulerBlocked;
    const controller = new AbortController();
    this.preflightControllers.add(controller);
    const deadline = Date.now() + timeout;
    const timer = setTimeout(() => controller.abort(), timeout);
    let release, abort, operation, settled = false;
    try {
      release = await this.globalScheduler.acquire(controller.signal);
      const remaining = Math.max(1, deadline - Date.now());
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(failure(this.closed ? "cancelled" : "timeout", 503));
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      if (controller.signal.aborted) throw failure("timeout", 503);
      operation = Promise.resolve().then(() => this.preflight({
        provider: config.provider, model: config.model, timeout: remaining, timeoutMs: remaining, signal: controller.signal,
      })).then(result => {
        settled = true;
        if (categoryOf(result?.error || result) === "stop_unconfirmed") this.blockScheduling();
        return result;
      }, error => {
        settled = true;
        if (categoryOf(error) === "stop_unconfirmed") this.blockScheduling();
        throw error;
      });
      return safePreflight(await Promise.race([operation, cancelled]), config);
    } catch (error) {
      if (this.schedulerBlocked) throw this.schedulerBlocked;
      throw error;
    } finally {
      clearTimeout(timer);
      if (abort) controller.signal.removeEventListener("abort", abort);
      controller.abort();
      if (operation && !settled) {
        try { await this.withDeadline(operation, STOP_WAIT_MS); }
        catch { if (!settled) this.blockScheduling(); }
      }
      this.preflightControllers.delete(controller);
      release?.();
    }
  }

  async start(experimentId, { version, idempotencyKey }) {
    if (this.pendingStarts >= 16) throw new SimulationError("QUEUE_FULL", "Too many pending run requests.", 429);
    this.pendingStarts++;
    const operation = this.startTail.then(() => this.startLocked(experimentId, { version, idempotencyKey }));
    this.startTail = operation.catch(() => {});
    try { return await operation; } finally { this.pendingStarts--; }
  }

  async startLocked(experimentId, { version, idempotencyKey }) {
    if (this.closed) throw new SimulationError("MANAGER_CLOSED", "The run manager is shutting down.", 503);
    safeId(experimentId);
    boundedInteger(version, 1, 40, "experiment version");
    const requestHash = contentHash({ experimentId, version });
    const request = this.store.findRequest(experimentId, idempotencyKey, requestHash, version);
    if (request.runId) return this.startResponse(request.runId);
    if (this.schedulerBlocked) throw this.schedulerBlocked;
    if (this.queue.length >= MAX_QUEUE) throw new SimulationError("QUEUE_FULL", "The run queue is full. Wait for a queued run to finish.", 429);
    const { definition, inputs, bundleHash } = this.store.getExperiment(experimentId, version);
    try { domain.validateExperiment(definition, inputs); }
    catch { throw new SimulationError("INVALID_EXPERIMENT", "The saved experiment failed domain validation."); }
    const config = validateRunConfig(definition, inputs);
    if (!config.model) throw new SimulationError("MODEL_REQUIRED", "Select and review an explicit Copilot model before starting a run.", 409);
    const preflightStartedAt = new Date().toISOString();
    let checked;
    try {
      checked = await this.checkedPreflight(config, config.callTimeoutMs);
    } catch (error) {
      if (this.schedulerBlocked) throw this.schedulerBlocked;
      throw error instanceof SimulationError ? error : failure(categoryOf(error), 503);
    }
    if (this.closed) throw new SimulationError("MANAGER_CLOSED", "The run manager is shutting down.", 503);
    if (this.schedulerBlocked) throw this.schedulerBlocked;
    const runId = `run-${randomUUID()}`, createdAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1, runId, experimentId, version, createdAt,
      definition, inputs, experimentHash: bundleHash, definitionHash: domain.stableHash(definition), inputsHash: domain.stableHash(inputs),
      snapshotHash: definition.snapshotHash, populationHash: inputs.populationHash, graphHash: inputs.graph.hash,
      initialStateHash: inputs.initialStateHash, externalEventsHash: inputs.externalEventsHash,
      comparisonKey: domain.comparisonKey(definition, inputs),
      adapterVersion: definition.adapterVersion, promptVersions: { stakeholder: definition.promptVersion },
      metricDefinitionsHash: domain.stableHash(definition.metricDefinitions), seed: definition.seed,
      runConfig: { ...config }, provider: checked.provider, requestedModel: checked.requestedModel,
      transport: this.transport,
      resolvedModel: checked.resolvedModel, modelIdentityVerified: checked.identityVerified, cliVersion: checked.cliVersion,
      preflight: { ...checked, startedAt: preflightStartedAt },
      preflightAttempts: 1, usage: null,
      reproducibility: "Exact replay uses saved accepted actions. Fresh model calls are not deterministic.",
      idempotencyKeyHash: request.keyHash, requestHash,
    };
    this.store.createRun(manifest);
    try {
      this.store.append(runId, "attempt_started", { callId: "preflight", purpose: "preflight", attempt: 1, startedAt: preflightStartedAt });
      this.store.append(runId, "attempt_completed", { callId: "preflight", purpose: "preflight", attempt: 1, durationMs: checked.durationMs });
    } catch (error) {
      try { this.store.append(runId, "run_interrupted", { reason: "The preflight record could not be saved before execution." }); } catch { /* Startup recovery will interrupt any unfinished run. */ }
      throw error;
    }
    this.queue.push(runId);
    const response = this.startResponse(runId);
    queueMicrotask(() => this.pump());
    return response;
  }

  startResponse(runId) {
    const run = this.store.readRun(runId);
    return { runId, status: run.status, manifest: run.manifest };
  }

  pump() {
    if (this.active || this.closed || this.schedulerBlocked) return;
    const runId = this.queue.shift();
    if (!runId) return;
    if (this.store.readRun(runId).status !== "queued") { queueMicrotask(() => this.pump()); return; }
    const manifest = this.store.readRun(runId).manifest;
    const context = {
      runId, manifest, controller: new AbortController(), engine: null,
      attempts: manifest.preflightAttempts, deadline: Date.now() + manifest.runConfig.deadlineMs,
      semaphore: new Semaphore(manifest.runConfig.concurrency), failure: null, tasks: new Set(), inFlight: new Map(), actors: new Map(),
    };
    setMaxListeners(128, context.controller.signal);
    this.active = context;
    this.globalScheduler.limit = manifest.runConfig.concurrency;
    this.globalScheduler.drain();
    context.done = this.execute(context).catch(() => {}).finally(() => {
      this.active = null;
      this.globalScheduler.limit = 1;
      this.pump();
    });
  }

  check(context) {
    if (context.failure) throw context.failure;
    if (context.controller.signal.aborted || TERMINAL.has(this.store.getInternalRun(context.runId).status)) throw failure("cancelled");
    if (Date.now() >= context.deadline) throw failure("deadline");
  }

  stopContext(context, error) {
    if (!context.failure) context.failure = error;
    context.controller.abort();
    this.stopEngine(context).catch(() => {});
  }

  stopEngine(context) {
    if (!context.engine) return Promise.resolve();
    context.stopPromise ||= Promise.resolve().then(() => context.engine.stop?.());
    return context.stopPromise;
  }

  blockScheduling() {
    if (this.schedulerBlocked) return;
    this.schedulerBlocked = shutdownBlocked();
    if (this.active && !this.active.controller.signal.aborted) this.stopContext(this.active, this.schedulerBlocked);
    for (const controller of this.preflightControllers) controller.abort();
    console.error("Simulation inference blocked:", this.schedulerBlocked.message);
    try { this.store.blockRuntime(); } catch { /* The in-process barrier remains active even if storage is unavailable. */ }
    for (const id of this.queue.splice(0)) {
      try { this.store.append(id, "run_failed", { error: publicError(this.schedulerBlocked), stoppedAt: new Date().toISOString() }); }
      catch { /* Startup recovery will mark any unwritable queued record interrupted. */ }
    }
  }

  async untilStopped(context, promise) {
    try { this.check(context); }
    catch (error) { Promise.resolve(promise).catch(() => {}); throw error; }
    let abort;
    const stopped = new Promise((_, reject) => {
      abort = () => reject(context.failure || failure("cancelled"));
      context.controller.signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([promise, stopped]); }
    finally { context.controller.signal.removeEventListener("abort", abort); }
  }

  settleOpenAttempts(context, error) {
    const status = this.store.getInternalRun(context.runId).status;
    if (TERMINAL.has(status)) return;
    const attempts = [...context.inFlight], actors = [...context.actors.values()];
    context.inFlight.clear();
    context.actors.clear();
    context.settling = true;
    try {
      for (const [callId, attempt] of attempts) {
        this.store.append(context.runId, "attempt_failed", {
          ...attempt.data, callId, durationMs: Math.max(0, Date.now() - attempt.startedAt),
          error: publicError(error),
        }, attempt.scenarioId);
      }
      for (const actor of actors) {
        this.store.append(context.runId, "actor_failed", { ...actor.data, error: publicError(error) }, actor.scenarioId);
      }
    } finally { context.settling = false; }
  }

  async execute(context) {
    const { manifest, runId } = context, { definition, inputs } = manifest;
    const deadlineTimer = setTimeout(() => this.stopContext(context, failure("deadline")), Math.max(1, context.deadline - Date.now()));
    try {
      this.store.append(runId, "run_preparing", { startedAt: new Date().toISOString() });
      const creatingEngine = Promise.resolve().then(() => {
        this.check(context);
        return this.engineFactory({ ...manifest.runConfig, provider: manifest.provider, model: manifest.requestedModel });
      })
        .then(engine => {
          context.engine = engine;
          if (context.controller.signal.aborted) {
            this.withDeadline(this.stopEngine(context), STOP_WAIT_MS).catch(() => this.blockScheduling());
          }
          return engine;
        });
      await this.untilStopped(context, creatingEngine);
      this.check(context);
      if (typeof context.engine?.askEnvelope !== "function") throw failure("provider");
      if (typeof context.engine.start === "function") await this.untilStopped(context,
        context.engine.start({ signal: context.controller.signal, timeout: Math.min(15000, Math.max(1, context.deadline - Date.now())) }),
      );
      this.check(context);
      if ((context.engine.provider && context.engine.provider !== manifest.provider)
        || (context.engine.model && context.engine.model !== manifest.requestedModel)
        || (context.engine.version && manifest.cliVersion !== "unavailable" && context.engine.version !== manifest.cliVersion)) {
        throw new SimulationError("CONFIGURATION_CHANGED", "Provider metadata changed after preflight. Start a new explicitly configured run.", 409);
      }
      this.store.append(runId, "run_started", { startedAt: new Date().toISOString(), attemptCap: manifest.runConfig.attemptCap });
      for (const scenario of definition.scenarios) {
        this.check(context);
        this.store.append(runId, "scenario_started", { label: scenario.label }, scenario.scenarioId);
        let state = domain.initialScenarioState(definition, inputs, scenario);
        for (let round = 1; round <= definition.horizon.steps; round++) {
          this.check(context);
          const outcome = await domain.executeRound({
            definition, inputs, scenario, state, round,
            decide: request => {
              const task = this.decide(context, scenario, round, request);
              context.tasks.add(task);
              task.then(() => context.tasks.delete(task), () => context.tasks.delete(task));
              return task;
            },
          });
          this.check(context);
          const stateHash = domain.stableHash(outcome.state);
          this.store.append(runId, "round_committed", {
            round, actions: outcome.actions, events: outcome.events, state: outcome.state,
            stateHash, actionsHash: contentHash(outcome.actions), eventsHash: contentHash(outcome.events),
            previousStateHash: domain.stableHash(state),
            snapshotHash: definition.snapshotHash, inputsHash: manifest.inputsHash,
          }, scenario.scenarioId);
          state = outcome.state;
          const metrics = domain.calculateMetrics({ definition, inputs, scenario, state, complete: round === definition.horizon.steps });
          this.store.append(runId, "metrics_updated", { round, complete: round === definition.horizon.steps, metrics, sourceStateHash: stateHash }, scenario.scenarioId);
        }
      }
      this.check(context);
      this.store.append(runId, "run_aggregating", {});
      const results = this.resultsFor(this.store.readRun(runId));
      const comparison = domain.compareScenarios(definition, results);
      if (!results.every(result => result.complete) || comparison.status === "incomplete") throw new SimulationError("INCOMPLETE_RUN", "The run did not produce comparable complete scenarios.", 409);
      this.check(context);
      this.store.append(runId, "run_completed", {
        completedAt: new Date().toISOString(), attempts: context.attempts,
        resultsHash: domain.stableHash(results), comparisonHash: domain.stableHash(comparison),
        elapsedMs: Math.max(0, Date.now() - (context.deadline - manifest.runConfig.deadlineMs)),
      });
    } catch (error) {
      const actual = context.failure || (error instanceof SimulationError ? error : failure(categoryOf(error)));
      this.stopContext(context, actual);
      const status = this.store.getInternalRun(runId).status;
      if (!TERMINAL.has(status) && status !== "paused") {
        const type = ["authentication", "model_unavailable"].includes(actual.category) ? "run_paused" : "run_failed";
        try {
          this.settleOpenAttempts(context, actual);
          this.store.append(runId, type, { error: publicError(actual), attempts: context.attempts, stoppedAt: new Date().toISOString() });
        }
        catch { /* Storage failure cannot turn an incomplete round into a commit. */ }
      }
    } finally {
      clearTimeout(deadlineTimer);
      context.controller.abort();
      try { await this.withDeadline(this.stopEngine(context), STOP_WAIT_MS); }
      catch { this.blockScheduling(); }
      await Promise.allSettled([...context.tasks]);
    }
  }

  async invoke(context, prompt, callId) {
    this.check(context);
    const timeout = Math.min(context.manifest.runConfig.callTimeoutMs, context.deadline - Date.now());
    const controller = new AbortController();
    let timer, abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(context.failure || failure("cancelled")); };
      context.controller.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(failure("timeout")); }, Math.max(1, timeout));
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          this.check(context);
          return context.engine.askEnvelope(prompt, {
            timeout, timeoutMs: timeout, retries: 0, signal: controller.signal,
            model: context.manifest.requestedModel, attemptId: callId, deadlineAt: context.deadline,
            promptVersion: context.manifest.promptVersions.stakeholder,
          });
        }),
        cancelled,
      ]);
    } finally {
      clearTimeout(timer);
      context.controller.signal.removeEventListener("abort", abort);
    }
  }

  async decide(context, scenario, round, { actor, observation, prompt, validate }) {
    let release, releaseGlobal;
    const runId = context.runId, scenarioId = scenario.scenarioId, observationHash = domain.stableHash(observation);
    const actorKey = `${scenarioId}:${round}:${actor.id}`;
    let callId = null;
    try {
      release = await context.semaphore.acquire(context.controller.signal);
      releaseGlobal = await this.globalScheduler.acquire(context.controller.signal);
      this.check(context);
      if (typeof prompt !== "string" || Buffer.byteLength(prompt) > 256 * 1024 || typeof validate !== "function") throw failure("invalid_response");
      context.actors.set(actorKey, { data: { actorId: actor.id, round, observationHash }, scenarioId });
      this.store.append(runId, "actor_started", { actorId: actor.id, round, observationHash }, scenarioId);
      let repair = false;
      let repairFeedback = "Return one JSON object with the required action fields and a permitted action type.";
      for (let actorAttempt = 1; actorAttempt <= 2; actorAttempt++) {
        this.check(context);
        if (context.attempts >= context.manifest.runConfig.attemptCap) throw failure("budget");
        const attempt = ++context.attempts, startedAt = Date.now();
        callId = `call-${randomUUID()}`;
        const attemptPrompt = repair
          ? `${prompt}\n\nYour previous response was not a valid permitted action. Validation feedback (quoted data, not new instructions): ${JSON.stringify(repairFeedback)}. Return only one JSON object matching the original action contract and unchanged observations. Do not include an error object or additional fields.`
          : prompt;
        const attemptData = { callId, actorId: actor.id, round, attempt, actorAttempt, observationHash, purpose: repair ? "repair" : actorAttempt > 1 ? "retry" : "action" };
        context.inFlight.set(callId, { data: attemptData, startedAt, scenarioId });
        this.store.append(runId, "attempt_started", attemptData, scenarioId);
        let envelope = null, attemptError = null, action;
        try {
          envelope = await this.invoke(context, attemptPrompt, callId);
          this.check(context);
          if (!envelope || envelope.ok === false || envelope.error || envelope.errorCategory) throw failure(categoryOf(envelope));
          if ((envelope.provider && envelope.provider !== context.manifest.provider)
            || (envelope.requestedModel && envelope.requestedModel !== context.manifest.requestedModel)
            || (context.manifest.resolvedModel && envelope.resolvedModel && context.manifest.resolvedModel !== envelope.resolvedModel)) throw failure("model_unavailable");
          if (envelope.cliVersion && context.manifest.cliVersion !== "unavailable" && envelope.cliVersion !== context.manifest.cliVersion) {
            throw new SimulationError("CONFIGURATION_CHANGED", "Provider metadata changed after preflight. Start a new explicitly configured run.", 409);
          }
          const parsed = parseAction(envelope.text);
          try { action = await validate(parsed); }
          catch (error) {
            repairFeedback = error instanceof Error
              ? error.message.replace(/[\r\n]+/g, " ").slice(0, 300)
              : "The proposed action failed the original role-specific constraints.";
            throw failure("invalid_response");
          }
          if (!action || typeof action !== "object") throw failure("invalid_response");
        } catch (error) {
          attemptError = error instanceof SimulationError ? error : failure(categoryOf(error));
        }
        const durationMs = Date.now() - startedAt;
        if (!TERMINAL.has(this.store.getInternalRun(runId).status)) {
          this.store.writeDebug(runId, callId, {
            callId, actorId: actor.id, scenarioId, round, observationHash,
            prompt: attemptPrompt, rawText: envelope?.text || "", envelope,
            errorCategory: attemptError?.category || null,
            ...(attemptError?.category === "invalid_response" ? { validationFeedback: repairFeedback } : {}),
          });
        }
        this.check(context);
        if (!attemptError) {
          const metadata = { ...metadataFor(envelope, context.manifest, durationMs), callId, attempt, actorAttempt, observationHash };
          context.inFlight.delete(callId);
          this.store.append(runId, "attempt_completed", { callId, actorId: actor.id, round, attempt, actorAttempt, durationMs, observationHash, metadata }, scenarioId);
          this.check(context);
          context.actors.delete(actorKey);
          this.store.append(runId, "actor_completed", { callId, actorId: actor.id, round, observationHash, actionHash: domain.stableHash(action), validated: true, committed: false }, scenarioId);
          return { action, callId, observationHash, metadata };
        }
        context.inFlight.delete(callId);
        this.store.append(runId, "attempt_failed", { callId, actorId: actor.id, round, attempt, actorAttempt, observationHash, durationMs, error: publicError(attemptError) }, scenarioId);
        this.check(context);
        if (actorAttempt === 2 || !RETRYABLE.has(attemptError.category)) throw attemptError;
        repair = attemptError.category === "invalid_response";
        this.store.append(runId, "actor_retrying", {
          actorId: actor.id, round, callId, reason: attemptError.category, nextActorAttempt: 2,
          ...(repair ? { validationFeedback: repairFeedback } : {}),
        }, scenarioId);
        if (!repair) await delay(Math.min(attemptError.category === "rate_limit" ? 500 : 100, Math.max(1, context.deadline - Date.now())), context.controller.signal);
      }
      throw failure("invalid_response");
    } catch (error) {
      const actual = context.failure || (error instanceof SimulationError ? error : failure(categoryOf(error)));
      if (!TERMINAL.has(this.store.getInternalRun(runId).status) && !context.controller.signal.aborted) {
        context.actors.delete(actorKey);
        this.store.append(runId, "actor_failed", { actorId: actor.id, round, callId, observationHash, error: publicError(actual) }, scenarioId);
      }
      this.stopContext(context, actual);
      throw actual;
    } finally { releaseGlobal?.(); release?.(); }
  }

  resultsFor(run) {
    const { definition, inputs } = run.manifest;
    return definition.scenarios.map(scenario => {
      const rounds = run.rounds[scenario.scenarioId] || [];
      const state = rounds.at(-1)?.state || domain.initialScenarioState(definition, inputs, scenario);
      const complete = rounds.length === definition.horizon.steps;
      return {
        scenarioId: scenario.scenarioId, complete, comparisonKey: run.manifest.comparisonKey,
        completedRounds: rounds.length, stateHash: domain.stableHash(state),
        metrics: domain.calculateMetrics({ definition, inputs, scenario, state, complete }),
        actions: rounds.flatMap(round => round.actions), ledgerEvents: rounds.flatMap(round => round.events),
      };
    });
  }

  getRun(runId) {
    const run = this.store.readRun(runId), results = this.resultsFor(run);
    const comparison = run.status === "completed" ? domain.compareScenarios(run.manifest.definition, results) : null;
    const completion = run.events.find(event => event.type === "run_completed");
    if (completion && (completion.data.resultsHash !== domain.stableHash(results) || completion.data.comparisonHash !== domain.stableHash(comparison))) {
      throw new SimulationError("INTEGRITY_ERROR", "Saved results do not match their committed output hashes.", 500);
    }
    const failureEvent = [...run.events].reverse().find(event => ["run_failed", "run_paused", "run_interrupted"].includes(event.type));
    return {
      runId, status: run.status, manifest: run.manifest, results, comparison,
      ...(failureEvent ? { error: failureEvent.data.error || { code: "INTERRUPTED", message: failureEvent.data.reason } } : {}),
      events: run.events,
      timing: [
        { stage: "creation", timestamp: run.manifest.createdAt },
        ...run.events.filter(event => ["run_preparing", "run_started", "run_completed", "run_failed", "run_cancelled", "run_paused"].includes(event.type))
          .map(event => ({ stage: event.type, timestamp: event.timestamp, ...(event.data.elapsedMs != null ? { elapsedMs: event.data.elapsedMs } : {}) })),
        ...this.store.getTiming(run.manifest.experimentId),
      ],
    };
  }

  async cancel(runId) {
    if (this.active?.runId === runId && this.active.cancelling) return { runId, status: "cancelled" };
    if (this.active?.runId === runId && this.active.settling) {
      await Promise.resolve();
      return this.cancel(runId);
    }
    const run = this.store.readRun(runId);
    if (TERMINAL.has(run.status)) return { runId, status: run.status };
    this.queue = this.queue.filter(id => id !== runId);
    if (this.active?.runId === runId) {
      this.active.cancelling = true;
      this.stopContext(this.active, failure("cancelled"));
      this.settleOpenAttempts(this.active, failure("cancelled"));
    }
    try { this.store.append(runId, "run_cancelled", { cancelledAt: new Date().toISOString(), reason: "Explicit cancellation." }); }
    catch (error) {
      if (this.active?.runId === runId) this.active.cancelling = false;
      throw error;
    }
    return { runId, status: "cancelled" };
  }

  async replay(runId) {
    const run = this.store.readRun(runId);
    if (run.status !== "completed") throw new SimulationError("INCOMPLETE_RUN", "Only a complete run can be verified as a comparable replay.", 409);
    const { definition, inputs } = run.manifest;
    const saved = this.getRun(runId), results = [];
    for (const scenario of definition.scenarios) {
      const rounds = run.rounds[scenario.scenarioId] || [];
      let replayed;
      try { replayed = await domain.replayScenario({ definition, inputs, scenario, rounds }); }
      catch { throw new SimulationError("REPLAY_MISMATCH", "Saved actions could not reproduce the committed scenario.", 409); }
      const expected = saved.results.find(result => result.scenarioId === scenario.scenarioId);
      if (domain.stableHash(replayed.state) !== expected.stateHash || domain.stableHash(replayed.metrics) !== domain.stableHash(expected.metrics)) {
        throw new SimulationError("REPLAY_MISMATCH", "Replayed state or metrics differ from committed results.", 409);
      }
      results.push(expected);
    }
    return { runId, mode: "replay", verified: true, results, comparison: domain.compareScenarios(definition, results) };
  }

  brief(runId) {
    const run = this.getRun(runId);
    if (run.status !== "completed") throw new SimulationError("INCOMPLETE_RUN", "Complete the run before creating its brief.", 409);
    return this.store.saveBrief(runId, createBrief(run));
  }

  async waitForIdle() {
    await this.startTail;
    while (this.active || this.queue.length) {
      if (!this.active) this.pump();
      if (this.active) await this.active.done;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.preflightControllers) controller.abort();
    const active = this.active;
    if (active) await this.cancel(active.runId);
    for (const id of [...this.queue]) await this.cancel(id);
    await this.startTail;
    await Promise.allSettled([...this.pendingPreflights]);
    if (active) await active.done;
  }
}
