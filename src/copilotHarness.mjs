import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "out", "copilot-harness");
const MAX_PROMPT_BYTES = 1024 * 1024;
const MESSAGES = {
  authentication: "The Copilot harness is not authenticated with the intended Copilot login. Select that account in Copilot and retry; repository gh credentials were not injected.",
  model_required: "Select an explicit model ID; automatic model selection is not allowed for H0.",
  model_unavailable: "The explicit model request failed. No alternative model was selected.",
  model_mismatch: "The harness reported a different model; its response was rejected.",
  cancelled: "The AI request was cancelled.",
  timeout: "The AI request exceeded its deadline.",
  output_limit: "The AI response exceeded its output-size limit.",
  application_error: "The model returned an error-shaped application response.",
  transport: "The harness returned invalid transport or attempted a forbidden tool.",
  schema: "The preflight response did not match the required schema.",
  rate_limit: "The provider rate-limited the request.",
  configuration: "The Copilot SDK configuration is invalid.",
  not_started: "The Copilot harness has not been started or has been stopped.",
  provider: "The Copilot harness request failed.",
  stop_unconfirmed: "Copilot shutdown could not be confirmed; do not start another run.",
};

function failure(category) {
  const error = new Error(MESSAGES[category] || MESSAGES.provider);
  error.category = error.errorCategory = category;
  return error;
}

function categoryOf(error) {
  if (error?.category && Object.hasOwn(MESSAGES, error.category)) return error.category;
  const text = String(error?.message || "");
  if (/model.{0,100}(unavailable|not available|not found|unsupported|not supported)|unknown model/i.test(text)) return "model_unavailable";
  if (/auth|unauthor|401|403|not (?:logged|signed) in|credential/i.test(text)) return "authentication";
  if (/rate.?limit|429|too many requests/i.test(text)) return "rate_limit";
  if (/timeout|timed out/i.test(text)) return "timeout";
  return "provider";
}

function positive(value, maximum = 2 ** 31 - 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure("configuration");
  return value;
}

function explicitModel(model) {
  if (model == null || model === "" || model === "auto") throw failure("model_required");
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) throw failure("configuration");
  return model;
}

function abortError(signal) {
  return failure(signal?.reason?.category && Object.hasOwn(MESSAGES, signal.reason.category) ? signal.reason.category : "cancelled");
}

function bounded(operation, timeout, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    if (!Number.isFinite(timeout) || timeout <= 0) { reject(failure("timeout")); return; }
    const deadline = Date.now() + timeout;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(abortError(signal));
    const timer = setTimeout(() => finish(failure("timeout")), Math.max(1, timeout));
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      if (settled) return;
      if (Date.now() >= deadline) throw failure("timeout");
      return operation();
    }).then((value) => finish(null, value), (error) => finish(error));
  });
}

export function copilotSdkEnvironment(source = process.env) {
  const env = {};
  // Preserve Copilot's own home/keychain selection, not repository-token overrides.
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|LANG|LC_ALL|TERM|TMP|TEMP|TMPDIR|XDG_CONFIG_HOME|XDG_DATA_HOME|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|COPILOT_HOME|COPILOT_GH_HOST)$/i;
  for (const [key, value] of Object.entries(source)) if (allowed.test(key)) env[key] = value;
  env.CI = "true";
  env.NO_COLOR = "1";
  return env;
}

export function stakeholderSessionConfig(model, workingDirectory, onEvent, onForbiddenTool) {
  return {
    model,
    workingDirectory,
    availableTools: [],
    excludedTools: ["builtin:*", "mcp:*", "custom:*"],
    tools: [],
    mcpServers: {},
    disabledMcpServers: ["github-mcp-server"],
    customAgents: [],
    includedBuiltinSkills: [],
    skillDirectories: [],
    pluginDirectories: [],
    instructionDirectories: [],
    additionalDirectories: [],
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSkills: false,
    enableSessionTelemetry: false,
    enableExperimentalMode: false,
    enableMcpApps: false,
    enableFileChangeTracking: false,
    customAgentsLocalOnly: true,
    manageScheduleEnabled: false,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: "in-memory",
    mcpOAuthTokenStorage: "in-memory",
    memory: { enabled: false },
    infiniteSessions: { enabled: false },
    remoteSession: "off",
    streaming: false,
    includeSubAgentStreamingEvents: false,
    hooks: {},
    onPermissionRequest: () => { onForbiddenTool?.(); return { kind: "reject" }; },
    onEvent,
  };
}

async function defaultClientFactory(options) {
  const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
  return new CopilotClient({ ...options, connection: RuntimeConnection.forStdio() });
}

/** A fresh SDK session per request, sharing only the authenticated runtime process. */
export class CopilotHarness {
  constructor({ provider = "copilot", model, concurrency = 4, maxOutputBytes = MAX_PROMPT_BYTES, clientFactory = defaultClientFactory, stopTimeoutMs = 2000 } = {}) {
    if (provider !== "copilot") throw failure("configuration");
    this.provider = "copilot";
    this.model = model ?? null;
    this.concurrency = positive(concurrency, 64);
    this.maxOutputBytes = positive(maxOutputBytes, 16 * MAX_PROMPT_BYTES);
    this.stopTimeoutMs = positive(stopTimeoutMs, 30000);
    this.clientFactory = clientFactory;
    this.client = null;
    this.version = null;
    this.authSource = null;
    this.availableModels = [];
    this.catalogStatus = "unavailable";
    this.calls = 0;
    this.started = false;
    this.stopped = false;
    this.queue = [];
    this.running = 0;
    this.active = new Set();
    this.activeSessions = new Set();
    this.pendingStartup = new Set();
    this.sessionDeletions = new Map();
    this.cleanupWarnings = [];
    this.clientStopped = false;
    this.startupTerminationUncertain = false;
    this.stopReason = null;
    this.startController = new AbortController();
    this.startPromise = null;
    this.stopPromise = null;
    this.workspace = null;
  }

  async start({ timeout = 20000, signal } = {}) {
    if (this.stopped) throw failure("not_started");
    if (this.started) return this.model;
    if (this.startPromise) return this.startPromise;
    positive(timeout);
    this.model = explicitModel(this.model);
    this.startPromise = this._start(timeout, signal);
    try { return await this.startPromise; }
    catch (error) {
      await this.stop();
      throw failure(categoryOf(error));
    }
  }

  async _start(timeout, signal) {
    const abort = () => this.startController.abort(failure("cancelled"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const deadline = Date.now() + timeout;
    const operation = (fn) => bounded(fn, deadline - Date.now(), this.startController.signal);
    try {
      if (/(?:^|[,\s])child_process(?:$|[,\s])|\*/i.test(process.env.NODE_DEBUG || "")) throw failure("configuration");
      this.workspace = join(ROOT, randomUUID());
      const cwd = join(this.workspace, "cwd");
      mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const env = copilotSdkEnvironment();
      env.GIT_CEILING_DIRECTORIES = this.workspace;
      // SDK 1.0.14's "empty" client mode disables the OS keychain. Preserve the
      // logged-in Copilot account and apply its empty-session defaults explicitly.
      const options = { mode: "copilot-cli", useLoggedInUser: true, workingDirectory: cwd, env, logLevel: "none", builtinPluginDirectories: [] };
      this.client = await operation(() => this._trackStartup(async () => {
        const client = await this.clientFactory(options);
        this.client = client;
        if (this.stopped) {
          await this._stopClient(client);
          throw failure("cancelled");
        }
        return client;
      }));
      await operation(() => this._trackStartup(async () => {
        try { await this.client.start(); }
        catch (error) {
          // The SDK force-stops failed startup internally and discards its child
          // handle even if killing fails. A later empty stop result is not proof.
          this.startupTerminationUncertain = true;
          throw error;
        }
        if (this.stopped) {
          await this._stopClient(this.client);
          throw failure("cancelled");
        }
      }));
      const status = await operation(() => this.client.getStatus());
      this.version = typeof status?.version === "string" ? status.version.slice(0, 200) : null;
      const auth = await operation(() => this.client.getAuthStatus());
      this.authSource = auth?.authType || "unresolved";
      if (!auth?.isAuthenticated || ["gh-cli", "api-key"].includes(auth.authType)) throw failure("authentication");
      try {
        const models = await bounded(() => this.client.listModels(), Math.min(5000, deadline - Date.now()), this.startController.signal);
        this.availableModels = (Array.isArray(models) ? models : []).filter((entry) =>
          typeof entry?.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(entry.id),
        ).map((entry) => ({ id: entry.id, policy: ["enabled", "disabled", "unconfigured"].includes(entry.policy?.state) ? entry.policy.state : null }));
        this.catalogStatus = "reported";
      } catch (error) {
        if (this.startController.signal.aborted || Date.now() >= deadline) throw error;
      }
      if (this.availableModels.some((entry) => entry.id === this.model && entry.policy === "disabled")) throw failure("model_unavailable");
      // listModels() can omit a working explicit model; the actual request is authoritative.
      if (this.stopped || this.startController.signal.aborted) throw failure("cancelled");
      if (Date.now() >= deadline) throw failure("timeout");
      this.started = true;
      return this.model;
    } finally { signal?.removeEventListener("abort", abort); }
  }

  describe() { return `GitHub Copilot SDK${this.model ? ` (${this.model})` : ""}`; }

  _trackStartup(operation) {
    const pending = Promise.resolve().then(operation);
    this.pendingStartup.add(pending);
    pending.then(() => this.pendingStartup.delete(pending), () => this.pendingStartup.delete(pending));
    return pending;
  }

  _drain() {
    while (!this.stopped && this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      job.dispose();
      this.running++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { this.running--; this._drain(); });
    }
  }

  _schedule(run, deadline, signal) {
    return new Promise((resolve, reject) => {
      let timer, settled = false;
      const dispose = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const cancel = (category) => {
        if (settled) return;
        settled = true;
        dispose();
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        reject(failure(category));
      };
      const abort = () => cancel("cancelled");
      const job = { run, resolve, reject, dispose, cancel };
      if (this.stopped || signal?.aborted) { cancel("cancelled"); return; }
      if (Date.now() >= deadline) { cancel("timeout"); return; }
      this.queue.push(job);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => cancel("timeout"), Math.max(1, deadline - Date.now()));
      this._drain();
    });
  }

  async _disposeSession(session, abort) {
    if (abort) await bounded(() => session.abort(), this.stopTimeoutMs);
    this.activeSessions.delete(session);
    const deletion = { session, settled: false, warning: null };
    this.sessionDeletions.set(session.sessionId, deletion);
    deletion.promise = Promise.resolve().then(() => this.client.deleteSession(session.sessionId));
    deletion.promise.then(() => {
      deletion.settled = true;
      this.sessionDeletions.delete(session.sessionId);
    }, () => { deletion.settled = true; });
    try {
      await bounded(() => deletion.promise, this.stopTimeoutMs);
      return null;
    } catch (error) {
      // sendAndWait reached idle (or abort completed). Deleting its saved state is
      // bookkeeping, not termination of inference in another private session.
      deletion.warning = {
        code: "SESSION_CLEANUP_DEFERRED", category: categoryOf(error),
        message: "Completed session deletion was deferred until runtime shutdown.",
      };
      this.cleanupWarnings.push(deletion.warning);
      return deletion.warning;
    }
  }

  async _invoke(prompt, model, deadline, signal) {
    if (this.stopped) throw this.stopReason || failure("cancelled");
    if (signal?.aborted) throw failure("cancelled");
    if (Date.now() >= deadline) throw failure("timeout");
    const controller = new AbortController();
    const abort = () => controller.abort(failure("cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const job = { controller, session: null };
    this.active.add(job);
    const events = [];
    let bytes = 0, result, failed = false, idle = false;
    const operation = (fn) => bounded(fn, deadline - Date.now(), controller.signal);
    const record = (event) => {
      if (controller.signal.aborted || this.stopped) return;
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes > this.maxOutputBytes) { controller.abort(failure("output_limit")); return; }
      if (event.type === "tool.execution_start") { controller.abort(failure("transport")); return; }
      if (event.type === "session.error") {
        controller.abort(failure(categoryOf({ message: event.data?.message || event.data?.errorType })));
        return;
      }
      if (!["assistant.message", "assistant.usage"].includes(event.type)) return;
      const data = event.data || {};
      if (data.toolRequests?.length) { controller.abort(failure("transport")); return; }
      const clean = {
        type: event.type,
        data: { content: data.content, model: data.model, resolvedModel: data.resolvedModel,
          inputTokens: data.inputTokens, outputTokens: data.outputTokens, cacheReadTokens: data.cacheReadTokens, cacheWriteTokens: data.cacheWriteTokens },
      };
      events.push(clean);
    };
    try {
      const directory = join(this.workspace, randomUUID());
      mkdirSync(directory, { mode: 0o700 });
      const create = () => Promise.resolve().then(() => {
        if (controller.signal.aborted || this.stopped) throw failure("cancelled");
        if (Date.now() >= deadline) throw failure("timeout");
        return this.client.createSession(stakeholderSessionConfig(model, directory, record, () => controller.abort(failure("transport"))));
      }).then(async (session) => {
        if (controller.signal.aborted || this.stopped) {
          try { await this._disposeSession(session, true); } catch { await this.stop(); }
          throw failure("cancelled");
        }
        job.session = session;
        this.activeSessions.add(session);
        return session;
      });
      const session = await operation(create);
      const response = await operation(async () => {
        this.calls++;
        const response = await session.sendAndWait({ prompt }, Math.max(1, deadline - Date.now()));
        idle = true;
        return response;
      });
      if (controller.signal.aborted) throw abortError(controller.signal);
      if (this.stopped) throw this.stopReason || failure("cancelled");
      if (Date.now() >= deadline) throw failure("timeout");
      if (response?.data?.content && !events.some((event) => event.type === "assistant.message")) record(response);
      if (controller.signal.aborted) throw abortError(controller.signal);
      const { parseProviderEnvelope } = await import("./aiEngine.mjs");
      result = parseProviderEnvelope("copilot", events.map((event) => JSON.stringify(event)).join("\n"), { strictTransport: true });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (failed && !controller.signal.aborted) controller.abort(failure("cancelled"));
      try {
        if (job.session && !this.stopped) {
          const warning = await this._disposeSession(job.session, !idle);
          if (warning && result) result.cleanupWarnings = [warning];
        }
      } catch {
        await this.stop(failure("provider"));
        throw this.stopReason;
      } finally { this.active.delete(job); }
    }
    if (this.stopped) throw this.stopReason || failure("cancelled");
    if (signal?.aborted) throw failure("cancelled");
    if (Date.now() >= deadline) throw failure("timeout");
    return result;
  }

  async askEnvelope(prompt, { model, timeout = 60000, signal, deadlineAt, attemptId, promptVersion } = {}) {
    const began = Date.now();
    const envelope = {
      text: null, provider: "copilot", requestedModel: this.model, resolvedModel: null,
      modelResolution: "unresolved", cliVersion: this.version, durationMs: 0,
      attemptId: typeof attemptId === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(attemptId) ? attemptId : randomUUID(),
      usage: null,
    };
    if (typeof promptVersion === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(promptVersion)) envelope.promptVersion = promptVersion;
    try {
      if (!this.started || this.stopped) throw failure("not_started");
      positive(timeout);
      if (deadlineAt != null && (!Number.isFinite(deadlineAt) || deadlineAt < 0)) throw failure("configuration");
      if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw failure("configuration");
      const requested = explicitModel(model ?? this.model);
      envelope.requestedModel = requested;
      if (requested !== this.model) throw failure("model_mismatch");
      const deadline = Math.min(began + timeout, deadlineAt ?? Infinity);
      const parsed = await this._schedule(() => this._invoke(prompt, requested, deadline, signal), deadline, signal);
      if (this.stopped) throw this.stopReason || failure("cancelled");
      if (signal?.aborted) throw failure("cancelled");
      if (parsed.resolvedModel && parsed.resolvedModel !== requested) {
        envelope.resolvedModel = parsed.resolvedModel;
        envelope.modelResolution = "mismatch";
        throw failure("model_mismatch");
      }
      Object.assign(envelope, parsed);
    } catch (error) {
      envelope.errorCategory = categoryOf(error);
      envelope.error = MESSAGES[envelope.errorCategory] || MESSAGES.provider;
    }
    envelope.durationMs = Date.now() - began;
    return envelope;
  }

  async ask(prompt, options) {
    const result = await this.askEnvelope(prompt, options);
    if (!result.errorCategory) return result.text;
    const error = failure(result.errorCategory);
    error.envelope = result;
    throw error;
  }

  async map(items, fn, { onProgress, signal } = {}) {
    const results = new Array(items.length);
    let next = 0, done = 0;
    const worker = async () => {
      while (next < items.length) {
        if (this.stopped || signal?.aborted) throw failure("cancelled");
        const index = next++;
        const result = await fn(items[index], index);
        if (this.stopped || signal?.aborted) throw failure("cancelled");
        results[index] = result;
        onProgress?.(++done, items.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(items.length, this.concurrency) }, worker));
    return results;
  }

  async stop(reason = failure("cancelled")) {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.started = false;
    this.stopReason = reason;
    this.startController.abort(reason);
    for (const job of [...this.queue]) job.cancel(categoryOf(reason));
    for (const job of this.active) job.controller.abort(reason);
    this.stopPromise = this._stop();
    return this.stopPromise;
  }

  async _stopClient(client) {
    if (this.clientStopped) return;
    try {
      const errors = await bounded(() => client.stop(), this.stopTimeoutMs);
      if (this.startupTerminationUncertain || !Array.isArray(errors) || errors.length) throw failure("stop_unconfirmed");
      this.clientStopped = true;
    } catch {
      // SDK 1.0.14 forceStop neither awaits child exit nor reports kill failures.
      // Attempt it, but never use its resolution as proof of termination.
      try { await bounded(() => client.forceStop(), this.stopTimeoutMs); }
      finally { throw failure("stop_unconfirmed"); }
    }
  }

  async _stop() {
    try {
      const startups = await bounded(() => Promise.allSettled([...this.pendingStartup]), this.stopTimeoutMs);
      if (startups.some(item => item.status === "rejected" && categoryOf(item.reason) === "stop_unconfirmed")) throw failure("stop_unconfirmed");
    } catch {
      // The tracked startup continuation will also stop a late-created runtime.
      // Until it settles, the caller must retain its persistent scheduling block.
      try { if (this.client) await bounded(() => this.client.forceStop(), this.stopTimeoutMs); }
      finally { throw failure("stop_unconfirmed"); }
    }
    if (this.client) {
      await Promise.all([...this.activeSessions].map((session) =>
        bounded(() => session.abort(), this.stopTimeoutMs).catch(() => {}),
      ));
      await Promise.all([...this.sessionDeletions.values()].map(async deletion => {
        try {
          await bounded(() => deletion.settled
            ? this.client.deleteSession(deletion.session.sessionId)
            : deletion.promise, this.stopTimeoutMs);
          this.sessionDeletions.delete(deletion.session.sessionId);
        } catch (error) {
          this.cleanupWarnings.push({
            code: "SESSION_CLEANUP_RETAINED", category: categoryOf(error),
            message: "Session deletion did not finish; runtime shutdown is still required.",
          });
        }
      }));
      await this._stopClient(this.client);
    }
    this.activeSessions.clear();
    if (this.workspace) {
      try { rmSync(this.workspace, { recursive: true, force: true }); } catch { /* runtime may be releasing handles */ }
    }
  }
}

export async function preflightCopilot({ model, timeout = 60000, signal, clientFactory } = {}) {
  const began = Date.now();
  const status = {
    ready: false, provider: "copilot", requestedModel: null, resolvedModel: null,
    modelResolution: "unresolved", cliVersion: null, authSource: null,
    availableModels: [], catalogStatus: "unavailable", checkedAt: new Date(began).toISOString(), durationMs: 0,
  };
  let engine;
  try {
    status.requestedModel = explicitModel(model);
    positive(timeout);
    engine = new CopilotHarness({ model: status.requestedModel, concurrency: 1, clientFactory });
    await engine.start({ timeout: Math.min(timeout, 20000), signal });
    status.cliVersion = engine.version;
    status.authSource = engine.authSource;
    status.availableModels = engine.availableModels;
    status.catalogStatus = engine.catalogStatus;
    const result = await engine.askEnvelope('Reply with exactly this JSON object and nothing else: {"ready":true}', {
      timeout: Math.max(1, timeout - (Date.now() - began)), deadlineAt: began + timeout, signal,
    });
    status.resolvedModel = result.resolvedModel;
    status.modelResolution = result.modelResolution;
    if (result.errorCategory) throw failure(result.errorCategory);
    let parsed;
    try { parsed = JSON.parse(result.text); } catch { throw failure("schema"); }
    if (parsed?.ready !== true || Object.keys(parsed).length !== 1) throw failure("schema");
    status.ready = true;
  } catch (error) {
    const category = categoryOf(error);
    status.error = { category, message: MESSAGES[category] || MESSAGES.provider };
  } finally {
    if (engine) {
      status.cliVersion = engine.version;
      status.authSource = engine.authSource;
      status.availableModels = engine.availableModels;
      status.catalogStatus = engine.catalogStatus;
      try { await engine.stop(); }
      catch { status.ready = false; status.error = { category: "stop_unconfirmed", message: MESSAGES.stop_unconfirmed }; }
    }
    if (signal?.aborted && status.error?.category !== "stop_unconfirmed") {
      status.ready = false;
      status.error = { category: "cancelled", message: MESSAGES.cancelled };
    }
    status.durationMs = Date.now() - began;
  }
  return status;
}
