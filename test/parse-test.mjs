// Quick live check that internal agents (esp. Finance Director) parse reliably.
import { AiEngine, extractJson } from "../src/aiEngine.mjs";
import scenario from "../src/scenarioRetail.mjs";

const engine = new AiEngine({ concurrency: 6 });
await engine.start();
const ctx = scenario.prepare(scenario.DEFAULT_PROPOSAL, { granularity: "segments" });
const defs = scenario.internalAgentDefs(ctx);
const results = await Promise.all(defs.map(async (d) => {
  const raw = await engine.ask(d.prompt);
  const p = extractJson(raw);
  return { label: d.label, ok: !!p, human: p && p.human_impact ? p.human_impact.slice(0, 80) : null, raw };
}));
for (const r of results) {
  console.log(`${r.ok ? "OK  " : "FAIL"} ${r.label}${r.human ? "  human_impact: " + r.human : ""}`);
  if (!r.ok) console.log("     raw:", r.raw.slice(0, 240).replace(/\n/g, " "));
}
console.log(`\nparsed ${results.filter(r => r.ok).length}/${results.length}`);
await engine.stop();
process.exit(0);
