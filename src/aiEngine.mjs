// Provider-neutral wrapper for GitHub Copilot CLI, Claude Code, and Codex CLI.
// Every simulation call is a fresh, tool-less/read-only non-interactive CLI run.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PROVIDER_CONFIG = join(ROOT, "config", "ai-provider.json");
const NEUTRAL_CWD = join(tmpdir(), "decision-studio-ai-runtime");

export const PROVIDERS = {
  copilot: {
    label: "GitHub Copilot CLI",
    command: "copilot",
    pathEnv: "COPILOT_CLI_PATH",
    installUrl: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    login: "Run `copilot`, then use `/login`.",
  },
  claude: {
    label: "Claude Code",
    command: "claude",
    pathEnv: "CLAUDE_CLI_PATH",
    installUrl: "https://code.claude.com/docs/en/setup",
    login: "Run `claude auth login` (or log out and back in if the workspace credential is rejected).",
  },
  codex: {
    label: "Codex CLI",
    command: "codex",
    pathEnv: "CODEX_CLI_PATH",
    installUrl: "https://developers.openai.com/codex/cli",
    login: "Run `codex login`.",
  },
};

function normalizeProvider(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) return null;
  if (!PROVIDERS[id]) throw new Error(`Unknown AI provider "${value}". Use copilot, claude, or codex.`);
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
    if (existsSync(requested)) return requested;
    throw new Error(`AI CLI not found at ${requested}`);
  }
  for (const rawDir of (process.env.PATH || "").split(delimiter)) {
    const dir = rawDir.replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const candidate of executableCandidates(requested)) {
      const full = join(dir, candidate);
      if (existsSync(full)) return full;
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
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  return { provider: normalizeProvider(parsed.provider), model: parsed.model || null };
}

function selectedConfig(explicitProvider, explicitModel) {
  const saved = readProviderConfig();
  const provider = normalizeProvider(explicitProvider || process.env.AI_PROVIDER || saved?.provider);
  const model = explicitModel || process.env.AI_MODEL || saved?.model || null;
  if (provider) return { provider, model };

  const installed = detectInstalledProviders();
  if (installed.length === 1) return { provider: installed[0].id, model };
  if (!installed.length) {
    throw new Error("No supported AI CLI found. Install GitHub Copilot CLI, Claude Code, or Codex CLI, then run `npm run setup`.");
  }
  throw new Error("Multiple AI CLIs are installed. Run `npm run setup` to choose one, or set AI_PROVIDER=copilot|claude|codex.");
}

function needsShell(commandPath) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(commandPath);
}

function versionOf(commandPath) {
  const result = spawnSync(commandPath, ["--version"], {
    encoding: "utf8",
    shell: needsShell(commandPath),
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "Could not read CLI version").trim());
  return (result.stdout || result.stderr || "").trim().split(/\r?\n/)[0];
}

export function buildInvocation(provider, prompt, model) {
  switch (provider) {
    case "copilot": {
      const args = [
        "-p", prompt,
        "-s",
        "--available-tools=",
        "--no-custom-instructions",
        "--disable-builtin-mcps",
        "--no-auto-update",
        "--no-color",
      ];
      if (model) args.push("--model", model);
      return { args, stdin: null };
    }
    case "claude": {
      const args = [
        "-p",
        "--output-format", "json",
        "--no-session-persistence",
        "--tools", "",
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
      ];
      if (model) args.push("--model", model);
      args.push("-");
      return { args, stdin: prompt };
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

function parseJsonLine(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  try { return JSON.parse(String(text || "").trim()); } catch { return null; }
}

export function parseProviderOutput(provider, stdout) {
  if (provider !== "claude") return String(stdout || "").trim();
  const payload = parseJsonLine(stdout);
  if (!payload) throw new Error("Claude Code returned invalid JSON output.");
  if (payload.is_error || payload.subtype === "error") {
    throw new Error(payload.result || payload.error || "Claude Code request failed.");
  }
  if (payload.structured_output != null) return JSON.stringify(payload.structured_output);
  if (typeof payload.result === "string") return payload.result;
  throw new Error("Claude Code returned no result text.");
}

function runCli(commandPath, provider, prompt, model, timeout) {
  mkdirSync(NEUTRAL_CWD, { recursive: true });
  const { args, stdin } = buildInvocation(provider, prompt, model);
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath, args, {
      cwd: NEUTRAL_CWD,
      env: process.env,
      shell: needsShell(commandPath),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code) => {
      if (code === 0) {
        try { finish(resolve, parseProviderOutput(provider, stdout)); }
        catch (error) { finish(reject, error); }
        return;
      }
      let detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
      if (provider === "claude") {
        const payload = parseJsonLine(stdout);
        detail = payload?.result || payload?.error || detail;
      }
      finish(reject, new Error(`${PROVIDERS[provider].label} failed: ${detail}`));
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error(`${PROVIDERS[provider].label} timed out after ${Math.round(timeout / 1000)} seconds.`));
    }, timeout);
    child.stdin.end(stdin || "");
  });
}

export class AiEngine {
  constructor({ provider = null, model = null, concurrency = 4, reasoningEffort = "low" } = {}) {
    this.explicitProvider = provider;
    this.explicitModel = model;
    this.concurrency = concurrency;
    this.reasoningEffort = reasoningEffort;
    this.provider = null;
    this.model = null;
    this.cliPath = null;
    this.version = null;
    this.calls = 0;
  }

  async start() {
    const selected = selectedConfig(this.explicitProvider, this.explicitModel);
    this.provider = selected.provider;
    this.model = selected.model;
    const spec = PROVIDERS[this.provider];
    this.cliPath = findExecutable(spec.command, process.env[spec.pathEnv] || process.env.AI_CLI_PATH);
    if (!this.cliPath) {
      throw new Error(`${spec.label} is selected but not installed. See ${spec.installUrl}`);
    }
    this.version = versionOf(this.cliPath);
    return this.model || `${spec.label} default`;
  }

  describe() {
    if (!this.provider) return "AI CLI";
    return `${PROVIDERS[this.provider].label}${this.model ? ` (${this.model})` : ""}`;
  }

  async ask(prompt, { timeout = 300000, retries = 1, model } = {}) {
    if (!this.cliPath) throw new Error("AI engine has not been started.");
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const output = await runCli(this.cliPath, this.provider, prompt, model || this.model, timeout);
        this.calls++;
        return output;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async map(items, fn, { onProgress } = {}) {
    const results = new Array(items.length);
    let next = 0, done = 0;
    const workerCount = Math.min(this.concurrency, items.length) || 1;
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) break;
        results[index] = await fn(items[index], index);
        done++;
        onProgress?.(done, items.length);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
  }

  async stop() {}
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
