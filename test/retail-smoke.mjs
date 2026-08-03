// No-LLM validation of the retail aggregate + done payload (individuals mode).
import scenario from "../src/scenarioRetail.mjs";
const ctx = scenario.prepare(scenario.DEFAULT_PROPOSAL, { granularity: "individuals", sampleSize: 8, rounds: 1 });
const cust = scenario.customerAgentDefs(ctx).map((d, i) => ({ ...d, parsed: { spend_delta_pct: (i % 3 - 1) * 5, sentiment: (i % 3 - 1) * 0.8, churn_delta_pct: (i % 2 ? -1 : 2), reasoning: "fake reasoning", key_factor: "shipping cost" } }));
const intl = scenario.internalAgentDefs(ctx).map((d, i) => ({ ...d, parsed: { margin_rate_delta_pts: -1, recommendation: ["adopt", "adopt_with_changes", "reject"][i % 3], confidence: 0.6, reasoning: "fake", concerns: ["c"], benefits: ["b"] } }));
const agg = scenario.aggregate(ctx, intl, cust);
console.log("verdict:", agg.verdict, "|", agg.verdictLabel);
console.log("summary:", agg.summaryText);
console.log("kpis:", agg.kpis.map(k => `${k.name}=${k.display}[${k.direction}]`).join(" | "));
console.log("segTable rows:", agg.segmentTable.length, JSON.stringify(agg.segmentTable[0]));
console.log("crowd:", JSON.stringify(agg.crowd));
console.log("groups:", agg.groups.map(g => `${g.title}(${g.agents.length})`).join(", "));
console.log("econ rows:", agg.economics.rows.length, "| methodology:", agg.methodology.length);
