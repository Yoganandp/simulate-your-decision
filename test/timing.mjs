// Timing + parse check for internal agents (with reasoningEffort applied).
import { AiEngine, extractJson } from "../src/aiEngine.mjs";
import scenario from "../src/scenarioRetail.mjs";

const engine = new AiEngine({ concurrency: 6 });
const model = await engine.start();
console.log("model:", model, "| effort:", engine.reasoningEffort);
const ctx = scenario.prepare(scenario.DEFAULT_PROPOSAL, { granularity: "segments" });
const defs = scenario.internalAgentDefs(ctx);
const t0 = Date.now();
const results = await Promise.all(defs.map(async (d) => {
  const s = Date.now();
  try { const raw = await engine.ask(d.prompt); const p = extractJson(raw); return { label: d.label, ms: Date.now() - s, ok: !!p, human: p && p.human_impact ? p.human_impact.slice(0, 70) : null }; }
  catch (e) { return { label: d.label, ms: Date.now() - s, ok: false, err: String(e.message || e).slice(0, 60) }; }
}));
for (const r of results) console.log(`${r.ok ? "OK " : "FAIL"} ${String(r.ms).padStart(6)}ms  ${r.label}${r.human ? "  → " + r.human : ""}${r.err ? "  ERR " + r.err : ""}`);
console.log(`\nparsed ${results.filter(r => r.ok).length}/${results.length} | wall ${Date.now() - t0}ms`);
await engine.stop();
process.exit(0);
