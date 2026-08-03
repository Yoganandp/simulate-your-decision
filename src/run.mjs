// run.mjs — scenario-agnostic runner. Loads a scenario module, runs its internal +
// customer agents live on the selected local AI CLI, aggregates, runs a discrimination control,
// and writes a generic out/results.json that report.mjs renders.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AiEngine, extractJson } from "./aiEngine.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "out");
const CONCURRENCY = parseInt(process.env.SIM_CONCURRENCY || "6", 10);
const SKIP_DISCRIM = process.env.SIM_SKIP_DISCRIMINATION === "1";

const scenarioPath = process.env.SIM_SCENARIO || "./scenarioMembership.mjs";
const scenario = (await import(new URL(scenarioPath, import.meta.url).href)).default;

const money = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${n < 0 ? "-" : ""}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${n < 0 ? "-" : ""}$${(a / 1e3).toFixed(0)}K`;
  return `${n < 0 ? "-" : ""}$${Math.round(a)}`;
};

async function safeAsk(engine, prompt) {
  try { return await engine.ask(prompt); }
  catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
}

// Ask and require parseable JSON; re-ask a couple times before giving up so a single
// malformed response doesn't silently drop a stakeholder from the simulation.
async function askJson(engine, prompt, tries = 3) {
  let raw = "";
  for (let i = 0; i < tries; i++) {
    raw = await safeAsk(engine, prompt);
    const parsed = extractJson(raw);
    if (parsed) return { raw, parsed };
  }
  return { raw, parsed: null };
}

async function runAgents(engine, defs, label) {
  console.log(`\n${label}: ${defs.length} agents`);
  const res = await engine.map(
    defs,
    async (d) => { const { raw, parsed } = await askJson(engine, d.prompt); return { ...d, raw, parsed }; },
    { onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total} responded   `) }
  );
  const failed = res.filter(r => !r.parsed).map(r => r.label);
  if (failed.length) console.log(`\n  ⚠ unparseable after retries: ${failed.join(", ")}`);
  return res;
}

async function main() {
  const t0 = Date.now();
  mkdirSync(OUT, { recursive: true });
  const proposal = process.env.SIM_PROPOSAL
    ? { title: "Custom proposal", text: process.env.SIM_PROPOSAL }
    : scenario.DEFAULT_PROPOSAL;

  console.log(`\n=== Decision Studio: ${scenario.title} ===`);
  console.log(`Proposal: ${proposal.title}`);

  const engine = new AiEngine({ concurrency: CONCURRENCY });
  const model = await engine.start();
  console.log(`Engine: ${engine.describe()} | model: ${model} | concurrency ${CONCURRENCY}`);

  const ctx = scenario.prepare(proposal);
  const defs = [...scenario.internalAgentDefs(ctx), ...scenario.customerAgentDefs(ctx)];
  const all = await runAgents(engine, defs, "MAIN — internal + customer agents");
  const internal = all.filter(r => r.kind === "internal");
  const customers = all.filter(r => r.kind === "customer");
  const agg = scenario.aggregate(ctx, internal, customers);

  let discrimination = null;
  if (!SKIP_DISCRIM && scenario.BAD_PROPOSAL) {
    const badCtx = scenario.prepare(scenario.BAD_PROPOSAL, { feeUsd: 0, discountPct: 15 });
    const badDefs = scenario.customerAgentDefs(badCtx).slice(0, 4);
    const badRes = await runAgents(engine, badDefs, "DISCRIMINATION — harmful control");
    const badAgg = scenario.aggregate(badCtx, [], badRes);
    const g = agg.summaryForCompare, b = badAgg.summaryForCompare;
    discrimination = {
      note: `Harmful control: "${scenario.BAD_PROPOSAL.title}" — give margin away with no fee.`,
      rows: [
        { name: "Net Year-1 profit", good: money(g.netProfit), bad: money(b.netProfit) },
        { name: "Profit per member/customer", good: money(g.profitPerMember), bad: money(b.profitPerMember) },
        { name: "Adoption", good: `${g.adoptionRate.toFixed(0)}%`, bad: `${b.adoptionRate.toFixed(0)}%` },
      ],
      ok: b.netProfit < g.netProfit,
      verdict: b.netProfit < g.netProfit
        ? `The engine rated the give-it-away control far worse on Year-1 profit (${money(b.netProfit)} vs ${money(g.netProfit)}). It is reasoning about unit economics, not rubber-stamping.`
        : `The engine did not clearly separate the harmful control — needs tuning.`,
    };
  }

  await engine.stop();
  const elapsedSec = Math.round((Date.now() - t0) / 1000);

  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      engine: engine.describe(), provider: engine.provider,
      model, concurrency: CONCURRENCY, agentCalls: engine.calls, elapsedSec,
      scenarioTitle: scenario.title, datasetNote: scenario.datasetNote,
    },
    proposal, headline: agg.headline, kpis: agg.kpis,
    economics: agg.economics, groups: agg.groups,
    discrimination, methodology: agg.methodology,
  };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));

  console.log(`\n\n✓ Done in ${elapsedSec}s, ${engine.calls} agent calls.`);
  console.log(agg.headline);
  if (discrimination) console.log(`Discrimination: ${discrimination.ok ? "PASS" : "FAIL"} — ${discrimination.rows.map(r => `${r.name} ${r.good} vs ${r.bad}`).join(" | ")}`);
  console.log(`Wrote ${join(OUT, "results.json")}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
