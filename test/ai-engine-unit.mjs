import assert from "node:assert/strict";
import { buildInvocation, extractJson, parseProviderOutput } from "../src/aiEngine.mjs";

assert.equal(extractJson('```json\n{"ok":true}\n```').ok, true);
assert.equal(extractJson('prefix {"ok":true,} suffix').ok, true);

const copilot = buildInvocation("copilot", "hello", null);
assert.equal(copilot.args[0], "-p");
assert.equal(copilot.args[1], "hello");
assert.equal(copilot.stdin, null);

const claude = buildInvocation("claude", "hello", "sonnet");
assert.equal(claude.stdin, "hello");
assert.ok(claude.args.includes("--output-format"));
assert.equal(parseProviderOutput("claude", JSON.stringify({ type: "result", subtype: "success", result: "READY" })), "READY");

const codex = buildInvocation("codex", "hello", null);
assert.equal(codex.stdin, "hello");
assert.equal(codex.args.at(-1), "-");

console.log("AI engine unit tests passed.");
