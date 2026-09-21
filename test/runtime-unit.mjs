import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  AiEngine, buildInvocation, getConfiguredProvider, parseProviderEnvelope,
  parseProviderOutput, parseSupportedModels, preflightCliProvider as preflightProvider, resolveCliCommand,
} from "../src/aiEngine.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = join(root, "out", `runtime-fixtures-${randomUUID()}`);
mkdirSync(fixtureRoot, { recursive: true });
const cli = join(fixtureRoot, "fake-cli.mjs");
writeFileSync(cli, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const root = dirname(fileURLToPath(import.meta.url));
if (args.includes("--version")) {
  console.log("Fixture CLI 1.0.0");
} else if (args[0] === "completion") {
  console.log('--model)\\n COMPREPLY=($(compgen -W "fixture-model fixture-unresolved fixture-denied fixture-invalid-schema auto" -- "\${cur}"))\\n ;;');
} else {
  if (args.includes("--no-auto-login")) {
    console.error("No authentication information found.");
    process.exit(1);
  }
  let prompt;
  if (args.includes("-p")) prompt = args[args.indexOf("-p") + 1];
  else {
    prompt = "";
    for await (const chunk of process.stdin) prompt += chunk;
  }
  const model = args[args.indexOf("--model") + 1];
  appendFileSync(join(root, "attempts.jsonl"), JSON.stringify({prompt, model, pid:process.pid}) + "\\n");
  const send = (content, identity = model) => {
    console.log(JSON.stringify({type:"session.start", data:{model:"not-an-inference-identity"}}));
    console.log(JSON.stringify({type:"assistant.message_delta", data:{deltaContent:"not the final answer"}}));
    console.log(JSON.stringify({type:"assistant.message", data:{
      content: typeof content === "string" ? content : JSON.stringify(content),
      ...(identity === "fixture-unresolved" ? {} : {model:identity})
    }}));
    console.log(JSON.stringify({type:"result", subtype:"success", usage:{input_tokens:11, output_tokens:7}}));
  };
  if (model === "fixture-denied") {
    console.log(JSON.stringify({type:"error", message:"Requested model is not available for this account"}));
  } else if (prompt === "application-error") {
    send({error:"secret-looking fixture must not be accepted"});
  } else if (prompt === "auth-error") {
    console.error("Authentication failed; token=never-echo-this-fixture");
    process.exitCode = 1;
  } else if (prompt === "mismatch") {
    send({ready:true}, "other-model");
  } else if (prompt === "oversize" || prompt === "oversize-stderr") {
    (prompt === "oversize" ? process.stdout : process.stderr).write("x".repeat(8192));
    setInterval(() => {}, 1000);
  } else if (prompt === "descendant") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"});
    writeFileSync(join(root, "descendant.pid"), String(child.pid));
    setInterval(() => {}, 1000);
  } else if (prompt === "sleep" || prompt === "slow") {
    setTimeout(() => send({ready:true}), prompt === "sleep" ? 20000 : 200);
  } else if (prompt.startsWith("retry:")) {
    const counter = join(root, prompt.slice(6) + ".count");
    const attempt = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
    writeFileSync(counter, String(attempt));
    if (attempt === 1) {
      console.error("429 rate limit");
      process.exitCode = 1;
    } else send({ready:true});
  } else if (prompt === "inspect") {
    send({cwd:process.cwd(), home:process.env.COPILOT_HOME, args,
      custom:process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? null,
      routing:process.env.COPILOT_PROVIDER_BASE_URL ?? null,
      nodeOptions:process.env.NODE_OPTIONS ?? null,
      memory:process.env.COPILOT_MODEL ?? null,
      authenticated:!!process.env.COPILOT_GITHUB_TOKEN,
      alternateAuth:!!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
      authHost:process.env.GH_HOST});
  } else if (prompt === "echo-auth") {
    send({accidentalCredential:process.env.COPILOT_GITHUB_TOKEN});
  } else if (prompt.includes('{"ready":true}')) {
    send(model === "fixture-invalid-schema" ? "READY" : {ready:true});
  } else {
    send({prompt});
  }
}
`);

const ghCli = join(fixtureRoot, "fake-gh.mjs");
writeFileSync(ghCli, `
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
if (args[0] !== "auth" || args[1] !== "token" || args[2] !== "--hostname" || args.length !== 4) process.exit(1);
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "gh-calls.jsonl"), JSON.stringify({host:args[3]}) + "\\n");
console.log("fixture-gh-oauth");
`);
const legacyCli = join(fixtureRoot, "fake-legacy.mjs");
writeFileSync(legacyCli, `
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("Legacy Fixture 1.0.0");
} else {
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const codex = args[0] === "exec";
  const credential = codex ? process.env.CODEX_API_KEY
    : process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  const send = (value) => {
    const text = JSON.stringify(value);
    console.log(JSON.stringify(codex
      ? {type:"item.completed",item:{type:"agent_message",text}}
      : {type:"result",subtype:"success",result:text}));
    if (codex) console.log(JSON.stringify({type:"turn.completed"}));
  };
  if (prompt === "echo-auth") send({credential});
  else if (prompt === "echo-auth-stderr") {
    console.error(credential);
    send({ready:true});
  } else if (prompt === "inspect") send({
    cwd:process.cwd(),home:codex ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR,args,
    authenticated:!!credential,aliasUsed:credential === "fixture-openai-alias",
    otherAuth:codex ? !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN)
      : !!(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY),
    openaiAliasExposed:!!process.env.OPENAI_API_KEY
  });
  else send({ready:true});
}
`);
const legacyAuthNames = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"];
const isolatedVariables = [
  "COPILOT_CLI_PATH", "GH_CLI_PATH", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
  "GH_HOST", "COPILOT_GH_HOST", "AI_PROVIDER", "AI_MODEL",
  "NODE_DEBUG", "CLAUDE_CLI_PATH", "CODEX_CLI_PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME", ...legacyAuthNames,
];
const oldEnvironment = new Map(isolatedVariables.map((name) => [name, process.env[name]]));
for (const name of isolatedVariables) delete process.env[name];
process.env.COPILOT_CLI_PATH = cli;
process.env.GH_CLI_PATH = ghCli;
process.env.CLAUDE_CLI_PATH = process.env.CODEX_CLI_PATH = legacyCli;
after(() => {
  for (const [name, value] of oldEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});
const jsonl = (...records) => records.map((record) => JSON.stringify(record)).join("\n");
const result = (text) => ({ type: "result", subtype: "success", result: text });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function started(options = {}) {
  const engine = new AiEngine({ provider: "copilot", model: "fixture-model", ...options });
  await engine.start();
  return engine;
}
async function waitForChild(engine) {
  const deadline = Date.now() + 3000;
  while (!engine.activeChildren.size && Date.now() < deadline) await pause(5);
  assert.equal(engine.activeChildren.size, 1);
}
function ghCalls() {
  try { return readFileSync(join(fixtureRoot, "gh-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch { return []; }
}

test("isolated legacy adapters explicitly reject saved-login-only configuration before spawning", async () => {
  for (const provider of ["claude", "codex"]) {
    const engine = new AiEngine({ provider, model: "fixture-model" });
    await assert.rejects(engine.start(), (error) => error.category === "authentication" && /does not reuse/.test(error.message));
    assert.equal(engine.calls, 0);
    assert.equal(engine.activeChildren.size, 0);
    assert.equal(engine.workspaces.size, 0);
    await engine.stop();
    const status = await preflightProvider({ provider, model: "fixture-model" });
    assert.equal(status.ready, false);
    assert.equal(status.error.category, "authentication");
    assert.match(status.error.message, /does not reuse/);
    assert.match(status.error.message, provider === "claude" ? /ANTHROPIC_API_KEY/ : /CODEX_API_KEY/);
  }
});

test("legacy environment auth preserves isolated homes and supported Codex exec key mapping", async () => {
  for (const name of legacyAuthNames) {
    const provider = name.startsWith("CODEX") || name.startsWith("OPENAI") ? "codex" : "claude";
    process.env[name] = name === "OPENAI_API_KEY" ? "fixture-openai-alias" : `fixture-${name}`;
    const other = provider === "codex" ? "ANTHROPIC_API_KEY" : "CODEX_API_KEY";
    process.env[other] = "fixture-other-provider";
    process.env.CLAUDE_CONFIG_DIR = process.env.CODEX_HOME = join(fixtureRoot, "saved-login-must-not-load");
    const engine = new AiEngine({ provider, model: "fixture-model" });
    try {
      await engine.start();
      assert.equal(engine.authSource, "environment");
      const envelope = await engine.askEnvelope("inspect");
      assert.equal(envelope.errorCategory, undefined);
      const data = JSON.parse(envelope.text);
      assert.equal(data.authenticated, true);
      assert.equal(data.otherAuth, false);
      assert.equal(data.openaiAliasExposed, false);
      assert.equal(data.aliasUsed, name === "OPENAI_API_KEY");
      assert.notEqual(data.home, process.env.CLAUDE_CONFIG_DIR);
      assert.equal(dirname(data.home), dirname(data.cwd));
      assert.equal(data.cwd.startsWith(join(root, "out", "ai-runtime")), true);
      if (provider === "claude") {
        assert.equal(data.args[data.args.indexOf("--tools") + 1], "");
        assert.equal(data.args[data.args.indexOf("--setting-sources") + 1], "");
      } else assert.ok(data.args.includes("features.shell_tool=false"));
    } finally {
      await engine.stop();
      delete process.env[name];
      delete process.env[other];
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.CODEX_HOME;
    }
  }
  process.env.CODEX_API_KEY = "fixture-codex-primary";
  process.env.OPENAI_API_KEY = "fixture-openai-alias";
  const engine = new AiEngine({ provider: "codex", model: "fixture-model" });
  try {
    await engine.start();
    assert.equal(JSON.parse((await engine.askEnvelope("inspect")).text).aliasUsed, false);
  } finally {
    await engine.stop();
    delete process.env.CODEX_API_KEY;
    delete process.env.OPENAI_API_KEY;
  }
});

test("legacy environment credentials cannot leak through output or child-process debug logging", async () => {
  for (const [provider, name] of [["claude", "CLAUDE_CODE_OAUTH_TOKEN"], ["codex", "OPENAI_API_KEY"]]) {
    process.env[name] = `fixture-private-${provider}`;
    const engine = new AiEngine({ provider, model: "fixture-model" });
    try {
      await engine.start();
      for (const prompt of ["echo-auth", "echo-auth-stderr"]) {
        const envelope = await engine.askEnvelope(prompt);
        assert.equal(envelope.text, null);
        assert.equal(envelope.errorCategory, "provider");
        assert.ok(!JSON.stringify(envelope).includes(process.env[name]));
      }
      process.env.NODE_DEBUG = "child_process";
      const blocked = new AiEngine({ provider, model: "fixture-model" });
      await assert.rejects(blocked.start(), (error) => error.category === "configuration");
      assert.equal(blocked.workspaces.size, 0);
      await blocked.stop();
    } finally {
      delete process.env.NODE_DEBUG;
      delete process.env[name];
      await engine.stop();
    }
  }
});

test("transport is decoded before application JSON, without trusting application identity", () => {
  const application = '{"action":"buy","model":"not-provider-metadata","usage":{"input_tokens":999}}';
  assert.equal(parseProviderOutput("copilot", application), application);
  const parsed = parseProviderEnvelope("copilot", jsonl(
    { type: "session.start", data: { model: "requested-only" } },
    { type: "assistant.message_delta", data: { deltaContent: "partial" } },
    { type: "assistant.message", data: { content: application } },
    result(application),
  ), { strictTransport: true });
  assert.equal(parsed.text, application);
  assert.equal(parsed.resolvedModel, null);
  assert.equal(parsed.modelResolution, "unresolved");
  assert.equal(parsed.usage, null);
  assert.equal(parseProviderOutput("claude", jsonl({ type: "system", subtype: "init" }, result('{"ready":true}'))), '{"ready":true}');
  assert.equal(parseProviderOutput("codex", jsonl(
    { type: "thread.started", thread_id: "fixture" },
    { type: "item.completed", item: { type: "agent_message", text: '{"ready":true}' } },
    { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } },
  )), '{"ready":true}');
});

test("errors, incomplete transport, and tool calls never become successful actor JSON", () => {
  for (const application of ['{"error":"bad"}', '{"ok":false}', '{"success":false}', '{"status":"failed"}', '{"errors":["bad"]}', '```json\n{"error":"bad"}\n```']) {
    assert.throws(() => parseProviderOutput("copilot", jsonl(result(application))), (error) => error.category === "application_error");
  }
  assert.throws(() => parseProviderOutput("copilot", jsonl(
    { type: "session.error", data: { message: "authentication required" } }, result('{"ready":true}'),
  )), (error) => error.category === "authentication");
  assert.throws(() => parseProviderEnvelope("copilot", '{"ready":true}', { strictTransport: true }), /transport/);
  assert.throws(() => parseProviderEnvelope("copilot", jsonl({ type: "assistant.message_delta", data: { deltaContent: '{"ready":true}' } }), { strictTransport: true }), /transport/);
  assert.throws(() => parseProviderOutput("copilot", jsonl({ type: "tool.execution_start", data: {} }, result('{"ready":true}'))), /tool call/);
  assert.throws(() => parseProviderOutput("claude", jsonl({ type: "result", is_error: true, result: "model not available" })), (error) => error.category === "model_unavailable");
});

test("tool-less flags, documented model discovery, and shell-free shim resolution", () => {
  const invocation = buildInvocation("copilot", '"; & whoami | echo "%PATH%"', "fixture-model");
  for (const flag of ["--available-tools=", "--no-custom-instructions", "--disable-builtin-mcps", "--no-ask-user", "--no-auto-update", "--output-format"]) {
    assert.ok(invocation.args.includes(flag));
  }
  assert.ok(!invocation.args.includes("--no-auto-login"));
  assert.ok(!invocation.args.includes("--allow-all-tools"));
  assert.deepEqual(parseSupportedModels('--model)\n COMPREPLY=($(compgen -W "auto exact-model" -- "$cur"))\n ;;'), ["auto", "exact-model"]);
  const shim = join(fixtureRoot, "fake-cli.cmd");
  writeFileSync(shim, '@ECHO off\n"%_prog%" "%dp0%\\fake-cli.mjs" %*\n');
  assert.deepEqual(resolveCliCommand(shim), { command: process.execPath, prefix: [cli] });
  const unknownShim = join(fixtureRoot, "unknown.cmd");
  writeFileSync(unknownShim, "@echo off\narbitrary shell content %*\n");
  assert.throws(() => resolveCliCommand(unknownShim), /safely resolve/);
  assert.deepEqual(Object.keys(getConfiguredProvider()).sort(), ["model", "provider"]);
});

test("large Copilot prompts use stdin without -p, avoiding Windows command-line limits", async () => {
  for (const size of [8193, 36227, 38663, 256 * 1024]) {
    const prompt = "x".repeat(size);
    const invocation = buildInvocation("copilot", prompt, "fixture-model");
    assert.equal(invocation.stdin, prompt);
    assert.ok(!invocation.args.includes("-p"));
    assert.ok(!invocation.args.includes("--prompt"));
    assert.ok(invocation.args.join(" ").length < 1024);
    assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "fixture-model");
  }
  const engine = await started();
  try {
    for (const size of [39000, 256 * 1024]) {
      const prompt = 'Literal prompt with "quotes" & | %PATH%\\n' + "x".repeat(size);
      const envelope = await engine.askEnvelope(prompt);
      assert.equal(envelope.errorCategory, undefined);
      assert.equal(JSON.parse(envelope.text).prompt, prompt);
    }
    assert.equal(engine.calls, 2);
  } finally { await engine.stop(); }
});

test("fresh isolated processes return reproducibility metadata and preserve literal prompts", async () => {
  const engine = await started();
  try {
    const a = await engine.askEnvelope("inspect");
    const b = await engine.askEnvelope("inspect");
    assert.equal(a.errorCategory, undefined);
    assert.equal(a.cliVersion, "Fixture CLI 1.0.0");
    assert.equal(a.requestedModel, "fixture-model");
    assert.equal(a.resolvedModel, "fixture-model");
    assert.equal(a.modelResolution, "reported");
    assert.deepEqual(a.usage, { input_tokens: 11, output_tokens: 7 });
    assert.ok(a.durationMs >= 0);
    assert.notEqual(a.attemptId, b.attemptId);
    const first = JSON.parse(a.text), second = JSON.parse(b.text);
    assert.notEqual(first.cwd, second.cwd);
    assert.notEqual(first.home, second.home);
    assert.notEqual(first.cwd, root);
    for (const key of ["custom", "routing", "nodeOptions", "memory"]) assert.equal(first[key], null);
    assert.equal(first.authenticated, true);
    assert.equal(first.alternateAuth, false);
    assert.equal(first.authHost, "github.com");
    const prompt = 'quotes " & echo SHOULD_NOT_EXECUTE | more %PATH%\nsecond line';
    assert.equal(JSON.parse(await engine.ask(prompt, { retries: 0 })).prompt, prompt);
    assert.equal(engine.calls, 3);
    assert.equal(engine.activeChildren.size, 0);
  } finally { await engine.stop(); }
});

test("GitHub credential helper is cached only in private engine memory and never exposed", async () => {
  const before = ghCalls().length;
  const engine = await started();
  try {
    assert.equal(engine.authSource, "github-cli");
    assert.equal(ghCalls().length, before + 1);
    assert.equal(engine.calls, 0);
    await engine.askEnvelope("inspect");
    await engine.askEnvelope("inspect");
    assert.equal(ghCalls().length, before + 1);
    assert.ok(!JSON.stringify(engine).includes("fixture-gh-oauth"));
    const leaked = await engine.askEnvelope("echo-auth");
    assert.equal(leaked.text, null);
    assert.equal(leaked.errorCategory, "provider");
    assert.ok(!JSON.stringify(leaked).includes("fixture-gh-oauth"));
  } finally { await engine.stop(); }
  assert.equal(engine.authSource, null);
  const next = await started();
  try { assert.equal(ghCalls().length, before + 2); }
  finally { await next.stop(); }
});

test("explicit authentication takes precedence and is frozen for the engine lifetime", async () => {
  const before = ghCalls().length;
  process.env.GH_TOKEN = "fixture-explicit-auth";
  const engine = await started();
  try {
    delete process.env.GH_TOKEN;
    assert.equal(engine.authSource, "environment");
    assert.equal(ghCalls().length, before);
    const inspected = JSON.parse((await engine.askEnvelope("inspect")).text);
    assert.equal(inspected.authenticated, true);
    assert.equal(inspected.alternateAuth, false);
    assert.ok(!JSON.stringify(engine).includes("fixture-explicit-auth"));
    assert.equal((await engine.askEnvelope("echo-auth")).errorCategory, "provider");
  } finally {
    delete process.env.GH_TOKEN;
    await engine.stop();
  }
});

test("credential helper errors fail closed with safe gh login guidance", async () => {
  const failedGh = join(fixtureRoot, "failed-gh.mjs");
  writeFileSync(failedGh, 'console.log("fixture-secret-never-return"); console.error("fixture-secret-never-return"); process.exitCode=1;');
  process.env.GH_CLI_PATH = failedGh;
  try {
    const status = await preflightProvider({ model: "fixture-model" });
    assert.equal(status.ready, false);
    assert.equal(status.error.category, "authentication");
    assert.match(status.error.message, /gh auth login/);
    assert.ok(!JSON.stringify(status).includes("fixture-secret-never-return"));
  } finally { process.env.GH_CLI_PATH = ghCli; }
});

test("helper host is explicit and validated; no arbitrary command or URL is accepted", async () => {
  process.env.GH_HOST = "github.example.test";
  let engine;
  try {
    engine = await started();
    assert.equal(ghCalls().at(-1).host, "github.example.test");
    delete process.env.GH_HOST;
    assert.equal(JSON.parse((await engine.askEnvelope("inspect")).text).authHost, "github.example.test");
    await engine.stop();
    engine = null;
    for (const host of ["https://github.com", "github.com/path", "github.com:443", "github.com & whoami", "user@github.com", "127.0.0.1"]) {
      process.env.GH_HOST = host;
      const status = await preflightProvider({ model: "fixture-model" });
      assert.equal(status.ready, false);
      assert.equal(status.error.category, "configuration");
    }
  } finally {
    delete process.env.GH_HOST;
    await engine?.stop();
  }
});

test("credential helper is tracked and cancellation clears it without starting inference", async () => {
  const hangingGh = join(fixtureRoot, "hanging-gh.mjs");
  writeFileSync(hangingGh, "setInterval(() => {}, 1000);");
  process.env.GH_CLI_PATH = hangingGh;
  const engine = new AiEngine({ provider: "copilot", model: "fixture-model" });
  const controller = new AbortController();
  try {
    const starting = engine.start({ signal: controller.signal });
    const rejected = assert.rejects(starting, (error) => error.category === "cancelled");
    const deadline = Date.now() + 3000;
    while (![...engine.activeChildren].some((child) => child.spawnargs.includes(hangingGh)) && Date.now() < deadline) await pause(5);
    assert.ok([...engine.activeChildren].some((child) => child.spawnargs.includes(hangingGh)));
    controller.abort();
    await rejected;
    assert.equal(engine.activeChildren.size, 0);
    assert.equal(engine.calls, 0);
    assert.equal(engine.authSource, null);
  } finally {
    await engine.stop();
    process.env.GH_CLI_PATH = ghCli;
  }
});

test("credential-helper deadlines and output limits are bounded without exposing its output", async () => {
  const helper = join(fixtureRoot, "bounded-gh.mjs");
  process.env.GH_CLI_PATH = helper;
  const engine = new AiEngine({ provider: "copilot", model: "fixture-model" });
  try {
    writeFileSync(helper, "setInterval(() => {}, 1000);");
    await assert.rejects(engine.start({ timeout: 1200 }), (error) => error.category === "timeout");
    assert.equal(engine.calls, 0);
    assert.equal(engine.activeChildren.size, 0);
    await engine.stop();
    writeFileSync(helper, 'console.log("fixture-secret".repeat(3000));');
    const status = await preflightProvider({ model: "fixture-model" });
    assert.equal(status.ready, false);
    assert.equal(status.error.category, "authentication");
    assert.ok(!JSON.stringify(status).includes("fixture-secret"));
  } finally {
    await engine.stop();
    process.env.GH_CLI_PATH = ghCli;
  }
});

test("malformed provider configuration is surfaced rather than silently replaced", () => {
  const configPath = join(fixtureRoot, "provider-config.json");
  for (const invalid of ["{broken", "null", "[]", '{"provider":"unexpected-provider"}', '{"provider":"copilot","model":"invalid model"}']) {
    writeFileSync(configPath, invalid);
    assert.throws(() => getConfiguredProvider({ configPath }), (error) => error.category === "configuration");
  }
  writeFileSync(configPath, '{"provider":"copilot","model":"fixture-model","ignored":"not-returned"}');
  assert.deepEqual(getConfiguredProvider({ configPath }), { provider: "copilot", model: "fixture-model" });
});

test("credential-bearing subprocess debug logging is rejected before helper execution", async () => {
  const before = ghCalls().length;
  process.env.NODE_DEBUG = "child_process";
  try {
    const status = await preflightProvider({ model: "fixture-model" });
    assert.equal(status.ready, false);
    assert.equal(status.error.category, "configuration");
    assert.equal(ghCalls().length, before);
  } finally { delete process.env.NODE_DEBUG; }
});

test("askEnvelope invokes once; legacy retries count failed and transient attempts", async () => {
  const engine = await started();
  try {
    const single = await engine.askEnvelope("retry:single");
    assert.equal(single.errorCategory, "rate_limit");
    assert.equal(single.text, null);
    assert.equal(engine.calls, 1);
    assert.equal(JSON.parse(await engine.ask("retry:legacy", { retries: 1 })).ready, true);
    assert.equal(engine.calls, 3);
    await assert.rejects(engine.ask("application-error", { retries: 1 }), (error) => error.category === "application_error" && error.envelope.text === null);
    assert.equal(engine.calls, 5);
    await assert.rejects(engine.ask("auth-error", { retries: 5 }), (error) => error.category === "authentication" && !error.message.includes("never-echo"));
    assert.equal(engine.calls, 6);
  } finally { await engine.stop(); }
});

test("concurrency bounds actual inference children and spawn failures still count", async () => {
  const engine = await started({ concurrency: 2 });
  let maximum = 0;
  const monitor = setInterval(() => { maximum = Math.max(maximum, engine.activeChildren.size); }, 5);
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => engine.askEnvelope("slow")));
    assert.ok(results.every((result) => !result.errorCategory));
    assert.equal(maximum, 2);
    assert.equal(engine.calls, 5);
    engine.command = { command: join(fixtureRoot, "does-not-exist.exe"), prefix: [] };
    const failed = await engine.askEnvelope("never");
    assert.equal(failed.errorCategory, "provider");
    assert.equal(engine.calls, 6);
    assert.equal(engine.activeChildren.size, 0);
  } finally {
    clearInterval(monitor);
    await engine.stop();
  }
});

test("timeout kills actual work, counts failure, and cannot resolve with a late answer", async () => {
  const engine = await started();
  try {
    const envelope = await engine.askEnvelope("sleep", { timeout: 120 });
    assert.equal(envelope.errorCategory, "timeout");
    assert.equal(envelope.text, null);
    assert.equal(engine.calls, 1);
    assert.equal(engine.activeChildren.size, 0);
    await pause(50);
    assert.equal(envelope.text, null);
  } finally { await engine.stop(); }
});

test("abort cancels running and queued work; queued cancellation does not spend an attempt", async () => {
  const engine = await started({ concurrency: 1 });
  const active = new AbortController(), queued = new AbortController();
  try {
    const first = engine.askEnvelope("sleep", { signal: active.signal });
    await waitForChild(engine);
    const second = engine.askEnvelope("sleep", { signal: queued.signal });
    queued.abort();
    assert.equal((await second).errorCategory, "cancelled");
    active.abort();
    assert.equal((await first).errorCategory, "cancelled");
    assert.equal(engine.calls, 1);
    assert.equal(engine.activeChildren.size, 0);
    const already = new AbortController();
    already.abort();
    assert.equal((await engine.askEnvelope("never", { signal: already.signal })).errorCategory, "cancelled");
    assert.equal(engine.calls, 1);
  } finally { await engine.stop(); }
});

test("queue time is inside the deadline and stop cancels all scheduling", async () => {
  const engine = await started({ concurrency: 1 });
  const active = engine.askEnvelope("sleep");
  await waitForChild(engine);
  const timed = await engine.askEnvelope("never", { timeout: 20 });
  assert.equal(timed.errorCategory, "timeout");
  assert.equal(engine.calls, 1);
  const queued = engine.askEnvelope("never");
  await engine.stop();
  assert.equal((await active).errorCategory, "cancelled");
  assert.equal((await queued).errorCategory, "cancelled");
  assert.equal(engine.activeChildren.size, 0);
  assert.equal(engine.queue.length, 0);
  assert.equal((await engine.askEnvelope("never")).errorCategory, "not_started");
  assert.equal(engine.calls, 1);
  await engine.stop();
});

test("stdout and stderr bounds terminate the process instead of accepting partial data", async () => {
  const engine = await started({ maxOutputBytes: 4096 });
  try {
    for (const prompt of ["oversize", "oversize-stderr"]) {
      const envelope = await engine.askEnvelope(prompt);
      assert.equal(envelope.errorCategory, "output_limit");
      assert.equal(envelope.text, null);
      assert.equal(engine.activeChildren.size, 0);
    }
    assert.equal(engine.calls, 2);
  } finally { await engine.stop(); }
});

test("stop terminates a fixture process tree by PID, not just its parent", async () => {
  const engine = await started();
  let descendant;
  try {
    const response = engine.askEnvelope("descendant");
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { descendant = Number(readFileSync(join(fixtureRoot, "descendant.pid"), "utf8")); break; }
      catch { await pause(10); }
    }
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    await engine.stop();
    assert.equal((await response).errorCategory, "cancelled");
    assert.throws(() => process.kill(descendant, 0), (error) => error.code === "ESRCH");
  } finally {
    await engine.stop();
    if (descendant) { try { process.kill(descendant, "SIGKILL"); } catch { /* already terminated */ } }
  }
});

test("stop also cancels an in-progress startup capability probe", async () => {
  const hangingCli = join(fixtureRoot, "hanging-cli.mjs");
  writeFileSync(hangingCli, "setInterval(() => {}, 1000);");
  process.env.COPILOT_CLI_PATH = hangingCli;
  const engine = new AiEngine({ provider: "copilot", model: "fixture-model" });
  try {
    const starting = engine.start();
    const rejected = assert.rejects(starting, (error) => error.category === "cancelled");
    await waitForChild(engine);
    await engine.stop();
    await rejected;
    assert.equal(engine.calls, 0);
    assert.equal(engine.activeChildren.size, 0);
  } finally {
    process.env.COPILOT_CLI_PATH = cli;
    await engine.stop();
  }
});

test("missing model-discovery capabilities fail closed without making an inference", async () => {
  const noCapabilityCli = join(fixtureRoot, "no-capability-cli.mjs");
  writeFileSync(noCapabilityCli, 'console.log(process.argv.includes("--version") ? "Fixture CLI 0.0.1" : "No model choices");');
  process.env.COPILOT_CLI_PATH = noCapabilityCli;
  try {
    const status = await preflightProvider({ provider: "copilot", model: "fixture-model" });
    assert.equal(status.ready, false);
    assert.equal(status.error.category, "capability_unavailable");
    assert.equal(status.cliVersion, "Fixture CLI 0.0.1");
    assert.equal(status.resolvedModel, null);
  } finally { process.env.COPILOT_CLI_PATH = cli; }
});

test("script preflight --model support runs the same schema check against the fixture", async () => {
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts", "check-provider.mjs"), "--provider", "copilot", "--model=fixture-model", "--transport=cli", "--json"], {
      cwd: root, env: { ...process.env, COPILOT_CLI_PATH: cli }, shell: false, windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => {
      try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  assert.equal(status.ready, true);
  assert.equal(status.requestedModel, "fixture-model");
});

test("model mismatch is rejected; missing and unavailable explicit models are never ready", async () => {
  const engine = await started();
  try {
    const mismatch = await engine.askEnvelope("mismatch");
    assert.equal(mismatch.errorCategory, "model_mismatch");
    assert.equal(mismatch.text, null);
    assert.equal(mismatch.resolvedModel, "other-model");
    const unavailable = await engine.askEnvelope("never", { model: "not-advertised" });
    assert.equal(unavailable.errorCategory, "model_unavailable");
    assert.equal(engine.calls, 1);
  } finally { await engine.stop(); }
  for (const model of [undefined, "auto", "not-advertised", "fixture-denied"]) {
    const status = await preflightProvider({ model });
    assert.equal(status.ready, false);
    assert.ok(["model_required", "model_unavailable"].includes(status.error.category));
    assert.equal(status.resolvedModel, null);
  }
});

test("preflight tests a strict application schema and does not fabricate model identity", async () => {
  const known = await preflightProvider({ model: "fixture-model" });
  assert.equal(known.ready, true);
  assert.equal(known.provider, "copilot");
  assert.equal(known.cliVersion, "Fixture CLI 1.0.0");
  assert.equal(known.resolvedModel, "fixture-model");
  const unresolved = await preflightProvider({ model: "fixture-unresolved" });
  assert.equal(unresolved.ready, true);
  assert.equal(unresolved.requestedModel, "fixture-unresolved");
  assert.equal(unresolved.resolvedModel, null);
  assert.equal(unresolved.modelResolution, "unresolved");
  assert.ok(Number.isFinite(Date.parse(unresolved.checkedAt)));
  const controller = new AbortController();
  controller.abort();
  const cancelled = await preflightProvider({ model: "fixture-model", signal: controller.signal });
  assert.equal(cancelled.ready, false);
  assert.equal(cancelled.error.category, "cancelled");
  const invalid = await preflightProvider({ model: "fixture-invalid-schema" });
  assert.equal(invalid.ready, false);
  assert.equal(invalid.error.category, "schema");
  assert.ok(readFileSync(join(fixtureRoot, "attempts.jsonl"), "utf8").includes("fixture-model"));
});
