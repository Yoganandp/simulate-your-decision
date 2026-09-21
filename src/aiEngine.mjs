// Provider-neutral wrapper for GitHub Copilot CLI, Claude Code, and Codex CLI.
// Every simulation call is a fresh, tool-less/read-only non-interactive CLI run.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotHarness, preflightCopilot } from "./copilotHarness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PROVIDER_CONFIG = join(ROOT, "config", "ai-provider.json");
const RUNTIME_ROOT = join(ROOT, "out", "ai-runtime");
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT = 2 ** 31 - 1;
const LEGACY_GH_LOGIN = "For the legacy CLI transport, run `gh auth login --hostname github.com` (or the configured GH_HOST), then retry. No token values or login files are copied into project configuration.";
const LEGACY_AUTH_ENV = {
  claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY"],
};
const ERROR_MESSAGES = {
  authentication: "Provider authentication failed. Sign in using the provider's supported login flow, then preflight again.",
  model_unavailable: "The explicitly requested model is unavailable. Check the CLI's model picker and account access; no fallback was used.",
  model_mismatch: "The provider reported a different model from the requested model. The response was rejected.",
  model_required: "Select an explicit model ID before preflight. Automatic model selection is not permitted for H0.",
  capability_unavailable: "This CLI did not expose its supported model IDs. Update the CLI or explicitly configure another provider; no model was guessed.",
  rate_limit: "The provider rate-limited the request.",
  timeout: "The AI request exceeded its deadline.",
  cancelled: "The AI request was cancelled.",
  output_limit: "The AI request exceeded its output-size limit.",
  transport: "The provider returned invalid or incomplete structured transport.",
  application_error: "The provider returned an error-shaped application response.",
  schema: "The provider preflight response did not match the required schema.",
  provider: "The provider request failed.",
  configuration: "The AI provider configuration or executable is invalid.",
  not_started: "AI engine has not been started, or has been stopped.",
};

function runtimeError(category, message = ERROR_MESSAGES[category]) {
  const error = new Error(message || ERROR_MESSAGES.provider);
  error.category = error.errorCategory = category;
  return error;
}

function classifyError(detail) {
  const text = String(detail || "");
  if (/model.{0,100}(not found|not available|unavailable|unsupported|not supported|invalid|not enabled|not allowed|access denied|falling back|fallback)|(?:unknown|invalid|unsupported|unavailable) model|no access to.{0,60}model/i.test(text)) return "model_unavailable";
  if (/authentication|unauthorized|not (?:logged|signed) in|login required|log in|sign in|credential|access token|401|403/i.test(text)) return "authentication";
  if (/rate.?limit|too many requests|429|quota exceeded/i.test(text)) return "rate_limit";
  return "provider";
}

function positiveInteger(value, name, maximum = MAX_TIMEOUT) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw runtimeError("configuration", `${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function normalizeModel(model) {
  if (model == null || model === "") return null;
  if (typeof model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) {
    throw runtimeError("configuration", "Use an exact model ID from the provider's documented model capabilities.");
  }
  return model;
}

export const PROVIDERS = {
  copilot: {
    label: "GitHub Copilot CLI",
    command: "copilot",
    pathEnv: "COPILOT_CLI_PATH",
    installUrl: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    login: "Open Copilot and select the intended inference account; use `/login` if necessary. The SDK uses that existing Copilot login, not the repository's personal gh token.",
  },
  claude: {
    label: "Claude Code",
    command: "claude",
    pathEnv: "CLAUDE_CLI_PATH",
    installUrl: "https://code.claude.com/docs/en/setup",
    login: "The isolated legacy Claude adapter does not reuse `claude auth login` credentials. Provide ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, or ANTHROPIC_AUTH_TOKEN through the launching process environment; never store credentials in project configuration.",
  },
  codex: {
    label: "Codex CLI",
    command: "codex",
    pathEnv: "CODEX_CLI_PATH",
    installUrl: "https://developers.openai.com/codex/cli",
    login: "The isolated legacy Codex adapter does not reuse `codex login` credentials. Provide CODEX_API_KEY through the launching process environment (OPENAI_API_KEY is accepted as an alias); never store credentials in project configuration.",
  },
};

function normalizeProvider(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) return null;
  if (!Object.hasOwn(PROVIDERS, id)) throw runtimeError("configuration", "Unknown AI provider. Use copilot, claude, or codex.");
  return id;
}

function executableCandidates(command) {
  if (process.platform !== "win32") return [command];
  if (extname(command)) return [command];
  const extensions = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
    .split(";")
    .filter(Boolean)
    .map((x) => x.toLowerCase());
  return [command, ...extensions.map((x) => command + x)];
}

export function findExecutable(command, explicitPath) {
  const requested = explicitPath || command;
  if (isAbsolute(requested) || requested.includes("\\") || requested.includes("/")) {
    if (existsSync(requested) && statSync(requested).isFile()) return requested;
    throw new Error(`AI CLI not found at ${requested}`);
  }
  for (const rawDir of (process.env.PATH || "").split(delimiter)) {
    const dir = rawDir.replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const candidate of executableCandidates(requested)) {
      const full = join(dir, candidate);
      if (existsSync(full) && statSync(full).isFile()) return full;
    }
  }
  return null;
}

export function detectInstalledProviders() {
  return Object.entries(PROVIDERS).flatMap(([id, provider]) => {
    const path = findExecutable(provider.command, process.env[provider.pathEnv] || process.env.AI_CLI_PATH);
    return path ? [{ id, label: provider.label, path }] : [];
  });
}

export function readProviderConfig(configPath = PROVIDER_CONFIG) {
  if (!existsSync(configPath)) return null;
  let parsed;
  try { parsed = JSON.parse(readFileSync(configPath, "utf8")); }
  catch { throw runtimeError("configuration", "The AI provider configuration could not be read as valid JSON. Correct config/ai-provider.json."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw runtimeError("configuration", "The AI provider configuration must be a JSON object.");
  }
  return { provider: normalizeProvider(parsed.provider), model: normalizeModel(parsed.model) };
}

function selectedConfig(explicitProvider, explicitModel, { allowMissing = false, configPath = PROVIDER_CONFIG } = {}) {
  const saved = explicitProvider && explicitModel ? null : readProviderConfig(configPath);
  const provider = normalizeProvider(explicitProvider || process.env.AI_PROVIDER || saved?.provider);
  // A model configured for one provider must not bleed into a different provider.
  const savedModel = !provider || saved?.provider === provider ? saved?.model : null;
  const model = normalizeModel(explicitModel || process.env.AI_MODEL || savedModel);
  if (provider) return { provider, model };

  const installed = detectInstalledProviders();
  const preferred = installed.find((item) => item.id === "copilot");
  if (preferred) return { provider: preferred.id, model };
  if (installed.length === 1) return { provider: installed[0].id, model };
  if (!installed.length) {
    if (allowMissing) return { provider: "copilot", model };
    throw new Error("No supported AI CLI found. Install GitHub Copilot CLI, Claude Code, or Codex CLI, then run `npm run setup`.");
  }
  throw new Error("Multiple AI CLIs are installed. Run `npm run setup` to choose one, or set AI_PROVIDER=copilot|claude|codex.");
}

/** Configuration only: no credentials, login checks, or inference. */
export function getConfiguredProvider({ configPath = PROVIDER_CONFIG } = {}) {
  return selectedConfig(undefined, undefined, { allowMissing: true, configPath });
}

function githubAuthHost() {
  const host = (process.env.GH_HOST || "github.com").trim().toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw runtimeError("configuration", "GH_HOST must be an explicit DNS hostname without a URL, credentials, path, or port.");
  }
  return host;
}

function authenticationCredential(value) {
  const credential = String(value || "").trim();
  if (!/^[a-zA-Z0-9_.-]{8,8192}$/.test(credential)) throw runtimeError("authentication", LEGACY_GH_LOGIN);
  return credential;
}

/** Resolve npm shims without passing any prompt through cmd.exe or PowerShell. */
export function resolveCliCommand(commandPath) {
  if (/\.(?:mjs|cjs|js)$/i.test(commandPath)) return { command: process.execPath, prefix: [commandPath] };
  if (/\.(?:cmd|bat)$/i.test(commandPath)) {
    const shim = readFileSync(commandPath, "utf8");
    const match = shim.match(/"%(?:dp0|~dp0)%?\\([^"\r\n]+\.(?:mjs|cjs|js))"/i);
    if (!match) throw runtimeError("configuration", "Cannot safely resolve this CLI shell shim. Set the provider CLI path to its executable or Node entry point.");
    const entry = resolve(dirname(commandPath), ...match[1].split(/[\\/]/));
    if (!existsSync(entry) || !statSync(entry).isFile()) throw runtimeError("configuration");
    return { command: process.execPath, prefix: [entry] };
  }
  if (/\.ps1$/i.test(commandPath)) throw runtimeError("configuration", "Use a native executable or Node entry point instead of a PowerShell CLI shim.");
  return { command: commandPath, prefix: [] };
}

export function buildInvocation(provider, prompt, model) {
  switch (provider) {
    case "copilot": {
      const useStdin = Buffer.byteLength(prompt, "utf8") > 8192;
      const args = [
        // Copilot supports piped prompts, but ignores stdin when -p is also present.
        ...(useStdin ? [] : ["-p", prompt]),
        "--output-format", "json",
        "--stream", "off",
        "--available-tools=",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        // In 1.0.84-5, --no-auto-login suppresses environment-token auth too.
        // start() requires an explicit credential before any non-interactive inference.
        "--no-ask-user",
        "--no-auto-update",
        "--no-color",
        "--no-remote",
        "--no-remote-export",
        "--log-level", "none",
      ];
      if (model) args.push("--model", model);
      return { args, stdin: useStdin ? prompt : null };
    }
    case "claude": {
      const args = [
        "-p",
        "--output-format", "json",
        "--no-session-persistence",
        "--tools", "",
        "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}',
        "--setting-sources", "",
        "--max-turns", "1",
      ];
      if (model) args.push("--model", model);
      return { args, stdin: prompt };
    }
    case "codex": {
      const args = [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--json",
        "-c", "features.shell_tool=false",
        "-c", "features.unified_exec=false",
        "-c", "features.apply_patch_freeform=false",
        "-c", "features.apps=false",
        "-c", "features.plugins=false",
        "-c", "features.hooks=false",
        "-c", "features.multi_agent=false",
        "-c", "features.view_image=false",
        "-c", "features.image_generation=false",
        "-c", "features.browser_use=false",
        "-c", "features.computer_use=false",
        "-c", "features.js_repl=false",
        "-c", "web_search=\"disabled\"",
        "-c", "project_doc_max_bytes=0",
      ];
      if (model) args.push("--model", model);
      args.push("-");
      return { args, stdin: prompt };
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

function errorShaped(value) {
  return value && typeof value === "object" && (
    !!value.error || (Array.isArray(value.errors) && value.errors.length > 0) ||
    value.is_error === true || value.ok === false || value.success === false ||
    /^(?:error|failed|failure|cancelled|canceled)$/.test(value.status || "") ||
    /^(?:error|error[._])/.test(value.type || "") || /^error(?:_|$)/.test(value.subtype || "")
  );
}

function assertApplicationText(text) {
  if (typeof text !== "string" || !text.trim()) throw runtimeError("transport");
  let value;
  try { value = JSON.parse(text); } catch { value = extractJson(text); }
  if (errorShaped(value) || (Array.isArray(value) && value.some(errorShaped))) {
    throw runtimeError("application_error");
  }
  return text.trim();
}

const TRANSPORT_TYPES = new Set([
  "system", "assistant", "user", "result", "error", "session.start", "session.resume",
  "session.error", "session.idle", "session.shutdown", "session.model_change",
  "session.usage_info", "assistant.message", "assistant.message_delta", "assistant.usage",
  "assistant.turn_start", "assistant.turn_end", "assistant.reasoning", "assistant.reasoning_delta",
  "user.message", "tool.execution_start", "tool.execution_complete",
  "thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed",
]);

function textContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((part) => part.type === "text").map((part) => part.text || "").join("");
  return null;
}

function safeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const result = {};
  for (const key of [
    "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens",
    "inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens",
  ]) {
    if (Number.isFinite(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  }
  return Object.keys(result).length ? result : null;
}

/** Decode provider transport before inspecting the model's application JSON. */
export function parseProviderEnvelope(provider, stdout, { strictTransport = false } = {}) {
  const raw = String(stdout || "").trim();
  let whole;
  try { whole = JSON.parse(raw); } catch { /* JSONL or plain text */ }
  let records;
  try { records = whole ? [whole] : raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch {
    if (strictTransport || provider === "claude") throw runtimeError("transport");
    return { text: assertApplicationText(raw), resolvedModel: null, modelResolution: "unresolved", usage: null };
  }
  const isTransport = records.some((record) => TRANSPORT_TYPES.has(record?.type));
  if (!isTransport) {
    if (errorShaped(whole)) throw runtimeError("application_error");
    if (strictTransport || provider === "claude") throw runtimeError("transport");
    return { text: assertApplicationText(raw), resolvedModel: null, modelResolution: "unresolved", usage: null };
  }

  let text = null, finalText = null, usage = null;
  const models = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || !TRANSPORT_TYPES.has(record.type)) {
      // Unknown structured events are forward-compatible, but never application results.
      if (!record || typeof record.type !== "string") throw runtimeError("transport");
    }
    const data = record.data || {};
    if (errorShaped(record) || record.type === "session.error" || record.type === "turn.failed") {
      throw runtimeError(classifyError(JSON.stringify(record)));
    }
    if (record.type === "tool.execution_start" ||
        (record.type === "assistant.message" && data.toolRequests?.length) ||
        (record.type === "assistant" && record.message?.content?.some?.((part) => part.type === "tool_use")) ||
        (record.type === "item.completed" && ["command_execution", "mcp_tool_call"].includes(record.item?.type))) {
      throw runtimeError("transport", "The provider attempted a tool call in a tool-less request.");
    }
    if (record.type === "assistant.message") text = textContent(data.content) ?? text;
    if (record.type === "assistant") text = textContent(record.message?.content ?? record.content) ?? text;
    if (record.type === "item.completed" && record.item?.type === "agent_message") text = record.item.text;
    if (record.type === "result") {
      finalText = record.structured_output != null ? JSON.stringify(record.structured_output) : textContent(record.result);
    }
    if (["assistant.message", "assistant.usage", "assistant", "result", "turn.completed", "session.model_change"].includes(record.type)) {
      const model = data.resolvedModel ?? data.model ?? record.resolvedModel ?? record.model ?? record.message?.model ??
        (record.type === "session.model_change" ? data.newModel ?? data.modelAfter : null);
      if (typeof model === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)) models.add(model);
      usage = safeUsage(record.usage ?? data.usage ?? (record.type === "assistant.usage" ? data : null)) ?? usage;
    }
  }
  if (models.size > 1) throw runtimeError("model_mismatch");
  const resolvedModel = [...models][0] || null;
  return {
    text: assertApplicationText(finalText ?? text),
    resolvedModel,
    modelResolution: resolvedModel ? "reported" : "unresolved",
    usage,
  };
}

export function parseProviderOutput(provider, stdout) {
  return parseProviderEnvelope(provider, stdout).text;
}

/** CLI completion is a documented capability, not proof of account entitlement. */
export function parseSupportedModels(completion) {
  const block = String(completion).match(/--model\)\s*([\s\S]*?)\s*;;/);
  const choices = block?.[1].match(/compgen\s+-W\s+"([^"]+)"/)?.[1];
  return choices ? [...new Set(choices.split(/\s+/).filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(id)))] : [];
}

function isolatedEnvironment(provider, workspace) {
  const env = {};
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|LANG|LC_ALL|TERM|TMP|TEMP|TMPDIR|XDG_CONFIG_HOME|XDG_DATA_HOME|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|GH_HOST|GH_CONFIG_DIR)$/i;
  const authNames = LEGACY_AUTH_ENV[provider] || [];
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.test(key) || authNames.includes(key)) env[key] = value;
  }
  if (provider === "codex") {
    // codex exec documents CODEX_API_KEY; OPENAI_API_KEY alone is not a saved login.
    env.CODEX_API_KEY = env.CODEX_API_KEY?.trim() ? env.CODEX_API_KEY : env.OPENAI_API_KEY;
    delete env.OPENAI_API_KEY;
  }
  env.CI = "true";
  env.NO_COLOR = "1";
  env.GIT_CEILING_DIRECTORIES = dirname(workspace);
  // Never load the user's MCP servers, plugins, hooks, instruction directories, or BYOK routing.
  if (provider === "copilot") env.COPILOT_HOME = join(workspace, "home");
  if (provider === "claude") env.CLAUDE_CONFIG_DIR = join(workspace, "home");
  if (provider === "codex") env.CODEX_HOME = join(workspace, "home");
  return env;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedWait(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, milliseconds); })])
    .finally(() => clearTimeout(timer));
}

async function taskkill(pid, force) {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  await new Promise((resolve) => {
    const killer = spawn(executable, ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      shell: false, windowsHide: true, stdio: "ignore",
    });
    const timer = setTimeout(() => { killer.kill(); resolve(); }, 2000);
    const done = () => { clearTimeout(timer); resolve(); };
    killer.once("error", done);
    killer.once("close", done);
  });
}

async function terminateTree(child) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) return;
  if (process.platform === "win32") {
    await taskkill(child.pid, false);
    await wait(150);
    await taskkill(child.pid, true);
  } else {
    const kill = (signal) => {
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== "ESRCH") { try { child.kill(signal); } catch { /* already gone */ } } }
    };
    kill("SIGTERM");
    await wait(150);
    kill("SIGKILL");
  }
}

/** Legacy CLI adapter. H0 runs use createSimulationEngine, which selects the SDK for Copilot. */
export class AiEngine {
  #copilotCredential = null;
  #authHost = null;
  #starting = null;

  constructor({ provider = null, model = null, concurrency = 4, reasoningEffort = "low", maxOutputBytes = MAX_OUTPUT_BYTES } = {}) {
    this.explicitProvider = provider;
    this.explicitModel = model;
    this.concurrency = positiveInteger(concurrency, "concurrency", 64);
    this.maxOutputBytes = positiveInteger(maxOutputBytes, "maxOutputBytes", 16 * MAX_OUTPUT_BYTES);
    this.reasoningEffort = reasoningEffort;
    this.provider = null;
    this.model = null;
    this.cliPath = null;
    this.version = null;
    this.authSource = null;
    this.calls = 0;
    this.activeChildren = new Set();
    this.jobs = new Set();
    this.queue = [];
    this.running = 0;
    this.stopped = false;
    this.started = false;
    this.supportedModels = [];
    this.workspaces = new Set();
    this.terminations = new Set();
  }

  async start({ timeout = 15000, signal } = {}) {
    if (this.stopped) throw runtimeError("not_started");
    if (this.started) return this.model || `${PROVIDERS[this.provider].label} default`;
    if (!this.#starting) {
      this.#starting = this._start({ timeout, signal }).finally(() => { this.#starting = null; });
    }
    return this.#starting;
  }

  async _start({ timeout, signal }) {
    positiveInteger(timeout, "timeout");
    const deadline = Date.now() + timeout;
    const selected = selectedConfig(this.explicitProvider, this.explicitModel);
    this.provider = selected.provider;
    this.model = selected.model;
    if (signal?.aborted || this.stopped) throw runtimeError("cancelled");
    if (/(?:^|[,\s])child_process(?:$|[,\s])|\*/i.test(process.env.NODE_DEBUG || "")) {
      throw runtimeError("configuration", "Disable child_process NODE_DEBUG logging before using provider authentication.");
    }
    const spec = PROVIDERS[this.provider];
    if (this.provider === "copilot") this.#authHost = githubAuthHost();
    else {
      if (!LEGACY_AUTH_ENV[this.provider].some((name) => process.env[name]?.trim())) {
        throw runtimeError("authentication", spec.login);
      }
      this.authSource = "environment";
    }
    this.cliPath = findExecutable(spec.command, process.env[spec.pathEnv] || process.env.AI_CLI_PATH);
    if (!this.cliPath) {
      throw new Error(`${spec.label} is selected but not installed. See ${spec.installUrl}`);
    }
    this.command = resolveCliCommand(this.cliPath);
    const version = await this._runProcess(["--version"], null, { deadline, signal });
    this.version = version.stdout.trim().split(/\r?\n/)[0].slice(0, 200);
    if (!this.version) throw runtimeError("configuration");
    if (this.provider === "copilot") {
      const completion = await this._runProcess(["completion", "bash"], null, { deadline, signal });
      this.supportedModels = parseSupportedModels(completion.stdout);
    }
    if (signal?.aborted || this.stopped) throw runtimeError("cancelled");
    this._checkModel(this.model);
    if (this.provider === "copilot") await this._authenticateCopilot({ deadline, signal });
    if (signal?.aborted || this.stopped) throw runtimeError("cancelled");
    this.started = true;
    return this.model || `${spec.label} default`;
  }

  async _authenticateCopilot({ deadline, signal }) {
    if (this.#copilotCredential) return;
    for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
      if (process.env[name]?.trim()) {
        this.#copilotCredential = authenticationCredential(process.env[name]);
        this.authSource = "environment";
        return;
      }
    }
    let result;
    try {
      const executable = findExecutable("gh", process.env.GH_CLI_PATH);
      if (!executable) throw runtimeError("authentication");
      result = await this._runProcess(["auth", "token", "--hostname", this.#authHost], null, {
        command: resolveCliCommand(executable),
        credentialOutput: true,
        deadline: Math.min(deadline, Date.now() + 10000),
        signal,
      });
      if (signal?.aborted || this.stopped) throw runtimeError("cancelled");
      this.#copilotCredential = authenticationCredential(result.stdout);
      this.authSource = "github-cli";
    } catch (error) {
      if (["cancelled", "timeout"].includes(error.category)) throw error;
      throw runtimeError("authentication", LEGACY_GH_LOGIN);
    } finally {
      if (result) { result.stdout = ""; result.stderr = ""; }
    }
  }

  describe() {
    if (!this.provider) return "AI CLI";
    return `${PROVIDERS[this.provider].label}${this.model ? ` (${this.model})` : ""}`;
  }

  _checkModel(model) {
    if (model && this.provider === "copilot" && !this.supportedModels.length) {
      throw runtimeError("capability_unavailable");
    }
    if (model && this.supportedModels.length && !this.supportedModels.includes(model)) {
      throw runtimeError("model_unavailable");
    }
  }

  _workspace() {
    const directory = join(RUNTIME_ROOT, randomUUID());
    mkdirSync(join(directory, "home"), { recursive: true, mode: 0o700 });
    mkdirSync(join(directory, "cwd"), { recursive: true, mode: 0o700 });
    this.workspaces.add(directory);
    return directory;
  }

  _runProcess(args, stdin, { deadline, signal, inference = false, command = this.command, credentialOutput = false }) {
    if (this.stopped || signal?.aborted) return Promise.reject(runtimeError("cancelled"));
    if (Date.now() >= deadline) return Promise.reject(runtimeError("timeout"));
    const workspace = this._workspace();
    const credential = inference && this.provider === "copilot" ? this.#copilotCredential : null;
    const env = isolatedEnvironment(this.provider, workspace);
    if (this.provider === "copilot") {
      env.GH_HOST = env.COPILOT_GH_HOST = this.#authHost || "github.com";
      if (credential) env.COPILOT_GITHUB_TOKEN = credential;
    }
    const credentials = [
      credential, ...(LEGACY_AUTH_ENV[this.provider] || []).map((name) => env[name]),
    ].filter((value) => value?.trim());
    const outputLimit = credentialOutput ? 16384 : this.maxOutputBytes;
    return new Promise((resolve, reject) => {
      let child, settled = false, timer, closed = false, termination;
      let stdout = "", stderr = "", bytes = 0;
      let closeResolve;
      const closePromise = new Promise((resolve) => { closeResolve = resolve; });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error && termination) {
          termination.then(() => boundedWait(closePromise, 2500)).then(() => {
            if (!closed) {
              this.stopped = true;
              this.started = false;
              for (const queued of [...this.queue]) queued.cancel("cancelled");
            }
            reject(error);
          });
        } else error ? reject(error) : resolve(value);
        stdout = "";
        stderr = "";
      };
      const cleanup = () => {
        if (closed) return;
        closed = true;
        this.activeChildren.delete(child);
        this.jobs.delete(job);
        // Do not remove a workspace while a cancelled process tree may still use it.
        const remove = () => {
          try { rmSync(workspace, { recursive: true, force: true }); this.workspaces.delete(workspace); } catch { /* retried by stop */ }
        };
        if (termination) termination.finally(remove);
        else remove();
        closeResolve();
      };
      const cancel = (category) => {
        if (settled) return;
        termination = terminateTree(child).catch(() => {});
        job.termination = termination;
        this.terminations.add(termination);
        termination.finally(() => this.terminations.delete(termination));
        finish(runtimeError(category));
      };
      const abort = () => cancel("cancelled");
      const job = { cancel, closePromise, termination: null };
      try {
        if (inference) this.calls++;
        child = spawn(command.command, [...command.prefix, ...args], {
          cwd: join(workspace, "cwd"),
          env,
          shell: false,
          detached: process.platform !== "win32",
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
        for (const name of ["COPILOT_GITHUB_TOKEN", ...(LEGACY_AUTH_ENV[this.provider] || [])]) delete env[name];
        this.activeChildren.add(child);
        this.jobs.add(job);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        const receive = (chunk, isError) => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > outputLimit) { cancel("output_limit"); return; }
          if (isError) stderr += chunk;
          else stdout += chunk;
        };
        child.stdout.on("data", (chunk) => receive(chunk, false));
        child.stderr.on("data", (chunk) => receive(chunk, true));
        child.stdin.on("error", () => {});
        child.once("error", () => { finish(runtimeError("provider")); cleanup(); });
        child.once("close", (code) => {
          if (signal?.aborted || this.stopped) finish(runtimeError("cancelled"));
          else if (Date.now() >= deadline) finish(runtimeError("timeout"));
          else if (credentials.some((value) => stdout.includes(value) || stderr.includes(value))) finish(runtimeError("provider"));
          else if (credentialOutput) {
            if (code !== 0) finish(runtimeError("authentication", LEGACY_GH_LOGIN));
            else finish(null, { stdout, stderr: "" });
          }
          else if (code !== 0) finish(runtimeError(classifyError(stderr + "\n" + stdout)));
          else if (stderr && classifyError(stderr) !== "provider") finish(runtimeError(classifyError(stderr)));
          else finish(null, { stdout, stderr });
          cleanup();
        });
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => cancel("timeout"), Math.max(1, deadline - Date.now()));
        if (signal?.aborted || this.stopped) abort();
        else child.stdin.end(stdin || "");
      } catch {
        finish(runtimeError("provider"));
        if (child) {
          child.once("error", cleanup);
          child.once("close", cleanup);
          termination = terminateTree(child).catch(() => {});
          job.termination = termination;
        }
        else cleanup();
      }
    });
  }

  _drain() {
    while (!this.stopped && this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      if (job.settled) continue;
      job.dispose();
      this.running++;
      Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => { this.running--; this._drain(); });
    }
  }

  _schedule(run, deadline, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const dispose = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      const cancel = (category) => {
        if (job.settled) return;
        job.settled = true;
        dispose();
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        reject(runtimeError(category));
      };
      const abort = () => cancel("cancelled");
      const job = { run, resolve, reject, dispose, cancel, settled: false };
      if (signal?.aborted || this.stopped) { cancel("cancelled"); return; }
      if (Date.now() >= deadline) { cancel("timeout"); return; }
      this.queue.push(job);
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => cancel("timeout"), Math.max(1, deadline - Date.now()));
      this._drain();
    });
  }

  /** One inference attempt, never a retry. Failures return a safe, text-free envelope. */
  async askEnvelope(prompt, { timeout = 60000, model, signal, deadlineAt } = {}) {
    const began = Date.now();
    const envelope = {
      text: null, provider: this.provider, requestedModel: this.model,
      resolvedModel: null, modelResolution: "unresolved", cliVersion: this.version,
      durationMs: 0, attemptId: randomUUID(), usage: null,
    };
    try {
      if (!this.started || this.stopped) throw runtimeError("not_started");
      positiveInteger(timeout, "timeout");
      if (deadlineAt != null && (!Number.isFinite(deadlineAt) || deadlineAt < 0)) throw runtimeError("configuration");
      if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > MAX_OUTPUT_BYTES) throw runtimeError("configuration");
      const requestedModel = normalizeModel(model ?? this.model);
      envelope.requestedModel = requestedModel;
      this._checkModel(requestedModel);
      const deadline = Math.min(began + timeout, deadlineAt ?? Infinity);
      const { args, stdin } = buildInvocation(this.provider, prompt, requestedModel);
      const result = await this._schedule(
        () => this._runProcess(args, stdin, { deadline, signal, inference: true }), deadline, signal,
      );
      if (this.stopped || signal?.aborted) throw runtimeError("cancelled");
      if (Date.now() >= deadline) throw runtimeError("timeout");
      const parsed = parseProviderEnvelope(this.provider, result.stdout, { strictTransport: true });
      if (requestedModel && requestedModel !== "auto" && parsed.resolvedModel && parsed.resolvedModel !== requestedModel) {
        envelope.resolvedModel = parsed.resolvedModel;
        envelope.modelResolution = "mismatch";
        throw runtimeError("model_mismatch");
      }
      Object.assign(envelope, parsed);
    } catch (error) {
      envelope.errorCategory = error.category || "provider";
      envelope.error = ERROR_MESSAGES[envelope.errorCategory] || ERROR_MESSAGES.provider;
    }
    envelope.durationMs = Date.now() - began;
    return envelope;
  }

  async ask(prompt, { timeout = 300000, retries = 1, model, signal, deadlineAt } = {}) {
    if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw runtimeError("configuration");
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const envelope = await this.askEnvelope(prompt, { timeout, model, signal, deadlineAt });
      if (!envelope.errorCategory) return envelope.text;
      lastError = runtimeError(envelope.errorCategory);
      lastError.envelope = envelope;
      if (!["provider", "rate_limit", "timeout", "transport", "application_error"].includes(envelope.errorCategory)) break;
    }
    throw lastError;
  }

  async map(items, fn, { onProgress, signal } = {}) {
    const results = new Array(items.length);
    let next = 0, done = 0;
    const workerCount = Math.min(this.concurrency, items.length) || 1;
    const worker = async () => {
      while (true) {
        if (this.stopped || signal?.aborted) throw runtimeError("cancelled");
        const index = next++;
        if (index >= items.length) break;
        const result = await fn(items[index], index);
        if (this.stopped || signal?.aborted) throw runtimeError("cancelled");
        results[index] = result;
        done++;
        onProgress?.(done, items.length);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }

  async stop() {
    this.stopped = true;
    this.started = false;
    this.#copilotCredential = null;
    this.#authHost = null;
    this.authSource = null;
    for (const job of [...this.queue]) job.cancel("cancelled");
    const active = [...this.jobs];
    for (const job of active) job.cancel("cancelled");
    await Promise.all(active.map(async (job) => {
      await job.termination;
      await boundedWait(job.closePromise, 2500);
    }));
    await Promise.all([...this.terminations]);
    if (this.activeChildren.size) throw runtimeError("provider", "Some AI processes could not be confirmed stopped.");
    for (const workspace of this.workspaces) {
      try { rmSync(workspace, { recursive: true, force: true }); this.workspaces.delete(workspace); } catch { /* OS may still hold a handle */ }
    }
  }
}

/** Preferred H0 factory. Legacy AiEngine remains available for CLI callers. */
export function createSimulationEngine(config = {}) {
  const configured = config.provider && config.model ? null : getConfiguredProvider();
  const provider = normalizeProvider(config.provider || configured?.provider || "copilot");
  const model = normalizeModel(config.model ?? (configured?.provider === provider ? configured.model : null));
  return provider === "copilot"
    ? new CopilotHarness({ ...config, provider, model })
    : new AiEngine({ ...config, provider, model });
}

export async function preflightProvider({ provider = "copilot", transport = "sdk", ...options } = {}) {
  if (String(provider).toLowerCase() === "copilot" && transport !== "cli") return preflightCopilot(options);
  return preflightCliProvider({ provider, ...options });
}

export async function preflightCliProvider({ provider = "copilot", model, timeout = 60000, signal } = {}) {
  const began = Date.now();
  const status = {
    ready: false, provider: null, requestedModel: null, resolvedModel: null,
    modelResolution: "unresolved", cliVersion: null, authSource: null, checkedAt: new Date(began).toISOString(), durationMs: 0,
  };
  let engine;
  try {
    status.provider = normalizeProvider(provider);
    status.requestedModel = normalizeModel(model);
    if (!status.requestedModel || status.requestedModel === "auto") throw runtimeError("model_required");
    positiveInteger(timeout, "timeout");
    const deadline = began + timeout;
    engine = new AiEngine({ provider: status.provider, model: status.requestedModel, concurrency: 1 });
    await engine.start({ timeout: Math.min(timeout, 15000), signal });
    status.cliVersion = engine.version;
    status.authSource = engine.authSource;
    const envelope = await engine.askEnvelope('Reply with exactly this JSON object and nothing else: {"ready":true}', {
      timeout: Math.max(1, deadline - Date.now()), deadlineAt: deadline, signal, model: status.requestedModel,
    });
    status.resolvedModel = envelope.resolvedModel;
    status.modelResolution = envelope.modelResolution;
    if (envelope.errorCategory) throw runtimeError(envelope.errorCategory);
    let result;
    try { result = JSON.parse(envelope.text); } catch { throw runtimeError("schema"); }
    if (!result || result.ready !== true || Object.keys(result).length !== 1) throw runtimeError("schema");
    if (signal?.aborted) throw runtimeError("cancelled");
    status.ready = true;
  } catch (error) {
    status.error = { category: error.category || "configuration", message: ERROR_MESSAGES[error.category] || ERROR_MESSAGES.configuration };
    if (status.error.category === "authentication" && status.provider === "copilot") {
      status.error.message += " " + LEGACY_GH_LOGIN;
    } else if (status.error.category === "authentication" && PROVIDERS[status.provider]) {
      status.error.message += " " + PROVIDERS[status.provider].login;
    }
  } finally {
    if (engine) {
      status.cliVersion = engine.version;
      try { await engine.stop(); }
      catch { status.ready = false; status.error = { category: "provider", message: "Provider process termination could not be confirmed." }; }
    }
    if (signal?.aborted) {
      status.ready = false;
      status.error = { category: "cancelled", message: ERROR_MESSAGES.cancelled };
    }
    status.durationMs = Date.now() - began;
  }
  return status;
}

/** Pull a JSON object out of an LLM response, including fenced or lightly malformed JSON. */
export function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate = fence ? fence[1] : text;
  const start = candidate.indexOf("{");
  if (start >= 0) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const char = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) { candidate = candidate.slice(start, i + 1); break; }
      }
    }
  }
  const tryParse = (value) => { try { return JSON.parse(value); } catch { return null; } };
  const parsed = tryParse(candidate);
  if (parsed) return parsed;
  return tryParse(candidate
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"])\/\/[^\n\r]*/g, "$1")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'"));
}
