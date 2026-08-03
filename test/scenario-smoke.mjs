// No-LLM smoke: exercise scenario.aggregate + results schema without agent calls.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import scenario from "../src/scenarioMembership.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(OUT, { recursive: true });

const ctx = scenario.prepare();
const fakeCustomer = (def, i) => ({ ...def, parsed: {
  join_probability: 0.2 + (i % 4) * 0.12, annual_spend_delta_pct: 5 + i, visit_freq_delta_pct: 3,
  churn_delta_pct: -2 - i, confidence: 0.7, reasoning: `Fake reasoning for ${def.label}.`,
  concerns: ["fee may not pay off"], benefits: ["free shipping"] } });
const fakeInternal = (def, i) => ({ ...def, parsed: {
  recommendation: ["adopt", "adopt_with_changes", "reject"][i % 3], gross_margin_delta_pct: -2,
  confidence: 0.6, reasoning: `Fake view from ${def.label}.`, concerns: ["margin"], benefits: ["loyalty"] } });

const internal = scenario.internalAgentDefs(ctx).map(fakeInternal);
const customers = scenario.customerAgentDefs(ctx).map(fakeCustomer);
const agg = scenario.aggregate(ctx, internal, customers);

console.log("HEADLINE:", agg.headline);
console.log("KPIs:", agg.kpis.map(k => `${k.name}=${k.display}[${k.direction}]`).join(" | "));
console.log("PNL rows:", agg.economics.rows.map(r => `${r.label}: ${r.value}`).join("\n  "));
console.log("groups:", agg.groups.map(g => `${g.title}(${g.agents.length})`).join(", "));

const results = {
  meta: { generatedAt: new Date().toISOString(), engine: "SMOKE (no LLM)", model: "n/a", concurrency: 0,
    agentCalls: 0, elapsedSec: 0, scenarioTitle: scenario.title, datasetNote: scenario.datasetNote },
  proposal: scenario.DEFAULT_PROPOSAL, headline: agg.headline, kpis: agg.kpis,
  economics: agg.economics, groups: agg.groups,
  discrimination: { note: "smoke", rows: [{ name: "Net Year-1 profit", good: "$100K", bad: "-$500K" }], ok: true, verdict: "smoke verdict" },
  methodology: agg.methodology,
};
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log("\nWrote smoke results.json");
