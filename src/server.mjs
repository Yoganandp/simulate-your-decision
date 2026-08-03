// server.mjs — local web server for the interactive simulator + debugger.
// Endpoints:
//   GET /                      -> the web UI (web/app.html)
//   GET /api/overview          -> data-driven business overview (cached)
//   GET /api/simulate (SSE)    -> streams each agent as it responds, then the aggregate
// No npm dependencies; runs agents through the user's selected local AI CLI.

import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AiEngine, extractJson } from "./aiEngine.mjs";
import { computeOverview } from "./overview.mjs";
import live from "./scenarioLive.mjs";
import retail from "./scenarioRetail.mjs";
import membership from "./scenarioMembership.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = parseInt(process.env.PORT || "5050", 10);
const SCENARIOS = { live, retail, membership };

const money = (n) => { const a = Math.abs(n), s = n < 0 ? "-" : ""; if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`; if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`; return `${s}$${Math.round(a)}`; };

let overviewCache = null;
function getOverview() { if (!overviewCache) overviewCache = computeOverview(); return overviewCache; }

async function safeAsk(engine, prompt, model) {
  try { return await engine.ask(prompt, model ? { model } : undefined); } catch (e) { return JSON.stringify({ error: String((e && e.message) || e) }); }
}

async function poolRun(engine, defs, concurrency, onResult, cancelled) {
  const results = new Array(defs.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (!cancelled()) {
      const i = next++; if (i >= defs.length) break;
      const d = defs[i];
      let raw = "", parsed = null;
      for (let a = 0; a < 3 && !parsed; a++) { raw = await safeAsk(engine, d.prompt, d.model); parsed = extractJson(raw); }
      results[i] = { ...d, raw, parsed };
      const completed = ++done;
      onResult(results[i], i, completed, defs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, defs.length) }, worker));
  return results;
}

async function runLive(send, engine, scenario, params, isCancelled) {
  const sampleSize = parseInt(params.sampleSize || "32", 10);
  const concurrency = Math.max(1, Math.min(10, parseInt(params.concurrency || "8", 10)));
  const maxRounds = Math.max(2, Math.min(scenario.MAX_ROUNDS, parseInt(params.maxRounds || scenario.MAX_ROUNDS, 10)));
  const proposal = params.proposal ? { title: "Custom decision", text: params.proposal } : scenario.DEFAULT_PROPOSAL;
  const ctx = scenario.prepare(proposal, { sampleSize, employees: params.employees });
  const rosterArr = scenario.roster(ctx);
  const idIndex = {}; rosterArr.forEach((p, i) => { idIndex[p.id] = i; });
  const edgeSet = new Set(), edges = [];
  rosterArr.forEach((p, i) => (p.neighbors || []).forEach((nid) => { const j = idIndex[nid]; if (j == null || j === i) return; const a = Math.min(i, j), b = Math.max(i, j), k = a + "-" + b; if (!edgeSet.has(k)) { edgeSet.add(k); edges.push([a, b]); } }));
  send("plan", { live: true, maxRounds, sampleSize: ctx.sampleSize, proposal, edges,
    agents: rosterArr.map((p, i) => ({ i, label: p.label, group: p.group, kind: p.kind, context: p.context })) });

  let reactions = []; const metricsHistory = []; let usedRounds = 0, converged = false;
  for (let round = 1; round <= maxRounds && !isCancelled(); round++) {
    usedRounds = round;
    send("status", { phase: "round", round, live: true });
    const inboxes = round > 1 ? scenario.buildInboxes(rosterArr, reactions) : {};
    const defs = rosterArr.map((p, idx) => ({ i: idx, id: p.id, label: p.label, group: p.group, kind: p.kind, context: p.context, entity: p.entity, model: scenario.PERSONA_MODEL, prompt: scenario.personaPrompt(ctx, p, round, inboxes[p.id] || "") }));
    reactions = await poolRun(engine, defs, concurrency, (r, li) => send("agent", { i: li, round, label: r.label, group: r.group, kind: r.kind, context: r.context, prompt: r.prompt, raw: r.raw, parsed: r.parsed, ok: !!r.parsed, done: li + 1, total: defs.length }), isCancelled);
    if (isCancelled()) { await engine.stop(); return; }

    send("status", { phase: "measuring", round });
    let mRaw = ""; try { mRaw = await engine.ask(scenario.measurementPrompt(ctx, round, reactions, metricsHistory[metricsHistory.length - 1]), { model: scenario.ANALYST_MODEL }); } catch { /* ignore */ }
    const metrics = extractJson(mRaw) || metricsHistory[metricsHistory.length - 1] || {};
    metricsHistory.push(metrics);
    const conv = scenario.converged(metricsHistory[metricsHistory.length - 2], metrics);
    const isConv = round >= 2 && conv.converged;
    send("metrics", { round, metrics, delta: conv.delta, converged: isConv });
    if (isConv) { converged = true; break; }
  }

  const agg = scenario.aggregate(ctx, reactions, metricsHistory);

  let alternatives = [];
  if (scenario.alternativesPrompt) {
    send("status", { phase: "alternatives" });
    try { const a = extractJson(await engine.ask(scenario.alternativesPrompt(ctx, agg), { model: scenario.ANALYST_MODEL })); alternatives = (a && a.alternatives) || []; } catch { /* ignore */ }
  }

  const calls = engine.calls;
  await engine.stop();
  send("done", {
    meta: { generatedAt: new Date().toISOString(), engine: engine.describe(), provider: engine.provider, model: engine.model || "provider default", agentCalls: calls, scenarioTitle: scenario.title, datasetNote: scenario.datasetNote, rounds: usedRounds, converged, sampleSize: ctx.sampleSize },
    proposal, verdict: agg.verdict, verdictLabel: agg.verdictLabel, summaryText: agg.summaryText, headline: agg.summaryText, crowd: agg.crowd,
    kpis: agg.kpis, economics: agg.economics, groups: agg.groups, segmentTable: agg.segmentTable, methodology: agg.methodology, metrics: agg.metrics, metricsHistory: agg.metricsHistory, alternatives,
  });
}

async function streamSimulate(req, res, params) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive", "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(":\n\n"); }, 15000);
  let cancelled = false;
  req.on("close", () => { cancelled = true; });

  const scenario = SCENARIOS[params.scenario] || live;
  const concurrency = Math.max(1, Math.min(10, parseInt(params.concurrency || "6", 10)));
  const granularity = params.granularity === "segments" ? "segments" : "individuals";
  const sampleSize = parseInt(params.sampleSize || "16", 10);
  const rounds = Math.max(1, Math.min(4, parseInt(params.rounds || "1", 10)));
  const proposal = params.proposal ? { title: "Custom decision", text: params.proposal } : scenario.DEFAULT_PROPOSAL;
  let engine;
  try {
    send("status", { phase: "starting", scenario: scenario.title });
    engine = new AiEngine({ concurrency });
    const model = await engine.start();
    send("status", { phase: "engine", model, granularity, rounds });

    if (scenario.isLive) { await runLive(send, engine, scenario, params, () => cancelled); return; }

    const ctx = scenario.prepare(proposal, { granularity, sampleSize, rounds });
    const internalDefs = scenario.internalAgentDefs(ctx);
    const custDefs = scenario.customerAgentDefs(ctx);
    const planDefs = [...internalDefs, ...custDefs];
    const total = internalDefs.length + custDefs.length * ctx.rounds;
    send("plan", {
      total: planDefs.length, rounds: ctx.rounds, granularity, sampleSize: ctx.sampleSize, proposal,
      agents: planDefs.map((d, i) => ({ i, label: d.label, group: d.group, kind: d.kind, context: d.context })),
    });

    let gdone = 0;
    const emit = (base, round) => (r, li) => { gdone++; send("agent", { i: base + li, round, label: r.label, group: r.group, kind: r.kind, context: r.context, prompt: r.prompt, raw: r.raw, parsed: r.parsed, ok: !!r.parsed, done: gdone, total }); };

    const internalResults = await poolRun(engine, internalDefs, concurrency, emit(0, 1), () => cancelled);
    let custResults = await poolRun(engine, custDefs, concurrency, emit(internalDefs.length, 1), () => cancelled);
    for (let r = 2; r <= ctx.rounds && !cancelled; r++) {
      send("status", { phase: "round", round: r, of: ctx.rounds });
      const crowd = scenario.buildCrowdSummary(custResults);
      const reDefs = scenario.customerAgentDefs(ctx, crowd);
      custResults = await poolRun(engine, reDefs, concurrency, emit(internalDefs.length, r), () => cancelled);
    }
    if (cancelled) { clearInterval(heartbeat); await engine.stop(); return res.end(); }

    const agg = scenario.aggregate(ctx, internalResults, custResults);

    let discrimination = null;
    if (params.discrimination === "1" && scenario.BAD_PROPOSAL) {
      send("status", { phase: "discrimination", title: scenario.BAD_PROPOSAL.title });
      const badCtx = scenario.prepare(scenario.BAD_PROPOSAL, { granularity, sampleSize: Math.min(6, sampleSize), rounds: 1 });
      const badDefs = scenario.customerAgentDefs(badCtx).slice(0, 4);
      const badResults = await poolRun(engine, badDefs, concurrency, (r, li) => send("agent", { i: 2000 + li, round: 1, label: r.label, group: "Harmful control", kind: "control", context: r.context, prompt: r.prompt, raw: r.raw, parsed: r.parsed, ok: !!r.parsed, done: li + 1, total: badDefs.length }), () => cancelled);
      const badAgg = scenario.aggregate(badCtx, [], badResults.filter(Boolean));
      const g = agg.summaryForCompare, b = badAgg.summaryForCompare;
      const worse = b.grossProfitImpact < g.grossProfitImpact;
      discrimination = {
        note: `Harmful control: "${scenario.BAD_PROPOSAL.title}".`,
        rows: [
          { name: "Profit impact / year", good: money(g.grossProfitImpact), bad: money(b.grossProfitImpact) },
          { name: "Revenue impact / year", good: money(g.revenueDeltaAbs ?? 0), bad: money(b.revenueDeltaAbs ?? 0) },
          { name: "Customer mood", good: (g.sentiment ?? 0).toFixed(2), bad: (b.sentiment ?? 0).toFixed(2) },
        ],
        ok: worse,
        verdict: worse
          ? `Good sign — the simulator rated the obviously bad idea much worse on profit (${money(b.grossProfitImpact)} vs ${money(g.grossProfitImpact)}). It pushes back on bad ideas instead of agreeing with everything.`
          : `The simulator didn't clearly separate the bad control — worth a closer look.`,
      };
    }

    const calls = engine.calls;
    await engine.stop();
    send("done", {
      meta: { generatedAt: new Date().toISOString(), engine: engine.describe(), provider: engine.provider, model, agentCalls: calls, scenarioTitle: scenario.title, datasetNote: scenario.datasetNote, granularity, sampleSize: ctx.sampleSize, rounds: ctx.rounds },
      proposal, verdict: agg.verdict, verdictLabel: agg.verdictLabel, summaryText: agg.summaryText, headline: agg.headline, crowd: agg.crowd,
      kpis: agg.kpis, economics: agg.economics, groups: agg.groups, segmentTable: agg.segmentTable, methodology: agg.methodology, discrimination,
    });
  } catch (e) {
    send("error", { message: String((e && e.stack) || e) });
    try { await engine?.stop(); } catch { /* ignore */ }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = readFileSync(join(ROOT, "web", "app.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    if (url.pathname === "/api/health") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"ok":true}'); }
    if (url.pathname === "/api/overview") {
      const o = getOverview();
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(o));
    }
    if (url.pathname === "/api/simulate") {
      return streamSimulate(req, res, Object.fromEntries(url.searchParams));
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error: " + String((e && e.message) || e));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Decision Studio running:  http://localhost:${PORT}\n`);
  console.log("  Open it in Chrome/Edge, type a decision, and watch the agents reason live.\n");
});
