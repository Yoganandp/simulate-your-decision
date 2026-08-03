// report.mjs — render the generic out/results.json into a self-contained out/demo.html.
// Works for any scenario that emits { meta, proposal, headline, kpis[], economics, groups[],
// discrimination, methodology[] }. Opens directly from file:// (Chrome/Edge).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "out");
const d = JSON.parse(readFileSync(join(OUT, "results.json"), "utf8"));

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function kpiCard(k) {
  const cls = k.direction === "improve" ? "good" : k.direction === "worsen" ? "bad" : "neutral";
  return `<div class="kpi ${cls}">
      <div class="kpi-name">${esc(k.name)}</div>
      <div class="kpi-delta">${esc(k.display)}</div>
      <div class="kpi-base">${esc(k.sub || "")}</div>
    </div>`;
}

function economicsPanel(e) {
  if (!e || !Array.isArray(e.rows)) return "";
  const rows = e.rows.map(r => {
    const cls = r.kind === "pos" ? "good" : r.kind === "neg" ? "bad" : r.kind === "total" ? "total" : "muted";
    return `<tr class="${r.kind === "total" ? "totalrow" : ""}"><td>${esc(r.label)}</td><td class="num ${cls}">${esc(r.value)}</td></tr>`;
  }).join("");
  return `<section>
      <h2>2 · The number that matters <span class="sub">— a real-data Year-1 P&amp;L</span></h2>
      <p class="lead">${esc(e.title)}</p>
      <table class="pnl"><tbody>${rows}</tbody></table>
      ${e.note ? `<p class="muted" style="margin-top:8px">${esc(e.note)}</p>` : ""}
    </section>`;
}

function agentCard(a) {
  const stance = a.stance || "neutral";
  const chips = [];
  for (const [k, v] of Object.entries(a.extra || {})) chips.push(`<span class="m hl"><i>${esc(k.replace(/_/g, " "))}</i> ${esc(v)}</span>`);
  for (const [k, v] of Object.entries(a.metrics || {})) chips.push(`<span class="m"><i>${esc(k.replace(/_/g, " "))}</i> ${esc(v)}</span>`);
  const concerns = (a.concerns || []).map(c => `<li>${esc(c)}</li>`).join("");
  const benefits = (a.benefits || []).map(b => `<li>${esc(b)}</li>`).join("");
  return `<div class="agent ${stance}" data-stance="${stance}">
      <div class="agent-head"><span class="aid">${esc(a.label)}</span>
        ${a.context ? `<span class="actx">${esc(a.context)}</span>` : ""}
        <span class="stance ${stance}">${stance}</span></div>
      <div class="metrics">${chips.join("")}</div>
      <div class="reason">${esc(a.reasoning)}</div>
      <div class="cb">
        ${concerns ? `<div class="col"><h5>Concerns</h5><ul>${concerns}</ul></div>` : ""}
        ${benefits ? `<div class="col"><h5>Benefits</h5><ul>${benefits}</ul></div>` : ""}
      </div></div>`;
}

function consensus(groups) {
  const all = groups.flatMap(g => g.agents);
  const c = { support: 0, neutral: 0, oppose: 0 };
  for (const a of all) c[a.stance || "neutral"]++;
  const total = all.length || 1;
  const w = (n) => `${(100 * n / total).toFixed(0)}%`;
  return `<div class="consensus"><div class="bar">
      <div class="seg support" style="width:${w(c.support)}"></div>
      <div class="seg neutral" style="width:${w(c.neutral)}"></div>
      <div class="seg oppose" style="width:${w(c.oppose)}"></div></div>
    <div class="legend"><span><i class="dot support"></i>${c.support} support/adopt</span>
      <span><i class="dot neutral"></i>${c.neutral} mixed</span>
      <span><i class="dot oppose"></i>${c.oppose} oppose/skip</span></div></div>`;
}

function groupBlock(g) {
  return `<div class="group-title">${esc(g.title)} · ${g.agents.length}${g.note ? ` <span class="sub">(${esc(g.note)})</span>` : ""}</div>
    <div class="agents">${g.agents.map(agentCard).join("")}</div>`;
}

function discriminationPanel(x, n) {
  if (!x) return "";
  const rows = x.rows.map(r => `<tr><td>${esc(r.name)}</td><td class="num">${esc(r.good)}</td><td class="num bad">${esc(r.bad)}</td></tr>`).join("");
  return `<section>
      <h2>${n} · Does it actually reason? <span class="sub">— vs. a deliberately bad control</span></h2>
      <p class="lead">${esc(x.note)} A simulator that rubber-stamps everything is useless.</p>
      <table class="pnl"><thead><tr><th>Metric</th><th class="num">Proposed</th><th class="num">Harmful control</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="verdict ${x.ok ? "ok" : "fail"}">${x.ok ? "✓ " : "⚠ "}${esc(x.verdict)}</p>
    </section>`;
}

const m = d.meta;
let n = 2; // section counter after KPIs(1)
const econN = d.economics ? ++n : null;
const reasonN = ++n;
const discN = d.discrimination ? ++n : null;
const methodN = ++n;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Decision Studio · Decision Simulation</title>
<style>
  :root{--bg:#0d1117;--card:#161b22;--card2:#1c232c;--bd:#2d333b;--tx:#e6edf3;--mut:#9aa7b4;
        --good:#2ea043;--good2:#0f3a1d;--bad:#f85149;--bad2:#3a1413;--neu:#8b949e;--acc:#58a6ff;--accbg:#0d2a4d;}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:32px 24px 80px}
  header{border-bottom:1px solid var(--bd);padding-bottom:20px}
  h1{font-size:26px;margin:0 0 4px} h1 .pill{font-size:12px;vertical-align:middle;background:var(--accbg);color:var(--acc);border:1px solid #1f6feb55;padding:3px 8px;border-radius:20px;margin-left:8px}
  .tag{color:var(--mut);font-size:13px} .badges{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
  .badge{background:var(--card);border:1px solid var(--bd);border-radius:6px;padding:5px 10px;font-size:12px;color:var(--mut)} .badge b{color:var(--tx)}
  section{margin-top:38px} h2{font-size:19px;border-left:3px solid var(--acc);padding-left:10px;margin:0 0 6px} h2 .sub{color:var(--mut);font-weight:400;font-size:14px}
  .lead{color:var(--mut);margin:4px 0 16px;max-width:820px}
  .proposal{background:var(--accbg);border:1px solid #1f6feb55;border-radius:10px;padding:16px 18px} .proposal .t{font-weight:600;margin-bottom:4px}
  .headline{margin-top:14px;font-size:15px;background:var(--card);border:1px solid var(--bd);border-left:4px solid var(--acc);border-radius:8px;padding:12px 14px}
  .kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-top:16px}
  .kpi{background:var(--card);border:1px solid var(--bd);border-left-width:4px;border-radius:10px;padding:14px}
  .kpi.good{border-left-color:var(--good)} .kpi.bad{border-left-color:var(--bad)} .kpi.neutral{border-left-color:var(--neu)}
  .kpi-name{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em} .kpi-delta{font-size:24px;font-weight:700;margin:4px 0}
  .kpi.good .kpi-delta{color:var(--good)} .kpi.bad .kpi-delta{color:var(--bad)} .kpi-base{font-size:12px;color:var(--mut)}
  table.pnl{width:100%;border-collapse:collapse;font-size:14px;max-width:640px} table.pnl td,table.pnl th{border:1px solid var(--bd);padding:9px 12px;text-align:left} table.pnl th{background:var(--card);color:var(--mut)}
  .num{text-align:right;font-variant-numeric:tabular-nums} .totalrow td{font-weight:700;background:var(--card)} .total{color:var(--tx)}
  .consensus{margin:14px 0} .bar{display:flex;height:12px;border-radius:7px;overflow:hidden;border:1px solid var(--bd)}
  .seg.support{background:var(--good)} .seg.neutral{background:#3b434c} .seg.oppose{background:var(--bad)}
  .legend{display:flex;gap:18px;margin-top:8px;font-size:13px;color:var(--mut)} .dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
  .dot.support{background:var(--good)} .dot.neutral{background:#3b434c} .dot.oppose{background:var(--bad)}
  .filters{display:flex;gap:8px;margin:14px 0} .filters button{background:var(--card);border:1px solid var(--bd);color:var(--mut);border-radius:20px;padding:5px 13px;cursor:pointer;font-size:13px} .filters button.active{background:var(--accbg);color:var(--acc);border-color:#1f6feb55}
  .group-title{margin:22px 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut)} .group-title .sub{text-transform:none;letter-spacing:0}
  .agents{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
  .agent{background:var(--card);border:1px solid var(--bd);border-left-width:4px;border-radius:10px;padding:14px}
  .agent.support{border-left-color:var(--good)} .agent.oppose{border-left-color:var(--bad)} .agent.neutral{border-left-color:var(--neu)}
  .agent-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap} .aid{font-weight:700} .actx{font-size:12px;color:var(--mut)}
  .stance{margin-left:auto;font-size:10px;text-transform:uppercase;letter-spacing:.06em;padding:2px 7px;border-radius:10px}
  .stance.support{background:var(--good2);color:#5dd87a} .stance.oppose{background:var(--bad2);color:#ff7b72} .stance.neutral{background:#21262d;color:var(--mut)}
  .metrics{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px} .m{font-size:11px;background:var(--card2);border:1px solid var(--bd);border-radius:5px;padding:2px 6px} .m i{color:var(--mut);font-style:normal} .m.hl{border-color:#1f6feb55;background:var(--accbg);color:var(--acc)}
  .reason{font-size:13.5px;background:var(--card2);border-radius:7px;padding:10px;border:1px solid var(--bd)}
  .cb{display:flex;gap:14px;margin-top:8px} .cb .col{flex:1} .cb h5{margin:0 0 4px;font-size:11px;color:var(--mut);text-transform:uppercase} .cb ul{margin:0;padding-left:16px;font-size:12.5px;color:var(--mut)} .cb li{margin:2px 0}
  .verdict{margin-top:12px;padding:12px 14px;border-radius:8px;font-size:14px} .verdict.ok{background:var(--good2);color:#7ee297;border:1px solid #2ea04355} .verdict.fail{background:var(--bad2);color:#ff9d96;border:1px solid #f8514955}
  .method{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px 18px;color:var(--mut);font-size:13px} .method li{margin:6px 0} .method code{background:var(--card2);padding:2px 6px;border-radius:4px;color:var(--acc)}
  .muted{color:var(--mut)} footer{margin-top:30px;color:var(--mut);font-size:12px;text-align:center}
</style></head>
<body><div class="wrap">
  <header>
    <h1>Decision Studio · Simulation Mode <span class="pill">live · public data</span></h1>
    <div class="tag">${esc(m.scenarioTitle || "")}. Describe a decision → a swarm of stakeholder agents reacts → predicted impact, <b>with every agent's reasoning shown</b>.</div>
    <div class="badges">
      <span class="badge">Engine: <b>${esc(m.engine)}</b></span>
      <span class="badge">Model: <b>${esc(m.model)}</b></span>
      <span class="badge"><b>${esc(String(m.agentCalls))}</b> live agent calls</span>
      <span class="badge">Ran in <b>${esc(String(m.elapsedSec))}s</b></span>
      <span class="badge">${esc(new Date(m.generatedAt).toLocaleString())}</span>
    </div>
    ${m.datasetNote ? `<div class="badges"><span class="badge" style="border-color:#1f6feb55">📊 <b>${esc(m.datasetNote)}</b></span></div>` : ""}
  </header>

  <section>
    <h2>1 · The decision under test</h2>
    <div class="proposal"><div class="t">${esc(d.proposal.title)}</div><div>${esc(d.proposal.text)}</div></div>
    ${d.headline ? `<div class="headline">${esc(d.headline)}</div>` : ""}
    <div class="kpis">${(d.kpis || []).map(kpiCard).join("")}</div>
  </section>

  ${economicsPanel(d.economics)}

  <section>
    <h2>${reasonN} · Why — every stakeholder's chain of thought <span class="sub">— the part the old demo was missing</span></h2>
    <p class="lead">Each number above is the aggregate of these individual, in-character reactions. Customer segments are real AdventureWorks cohorts; nothing here is hand-written.</p>
    ${consensus(d.groups || [])}
    <div class="filters">
      <button data-f="all" class="active">All</button>
      <button data-f="support">Support / adopt</button>
      <button data-f="oppose">Skeptics / skip</button>
      <button data-f="neutral">Mixed</button>
    </div>
    ${(d.groups || []).map(groupBlock).join("")}
  </section>

  ${discriminationPanel(d.discrimination, discN)}

  <section>
    <h2>${methodN} · How it works (transparency)</h2>
    <div class="method"><ul>${(d.methodology || []).map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
  </section>

  <footer>Live multi-agent simulation · ${esc(String(m.agentCalls))} local AI CLI calls · model ${esc(m.model)}.
  Directional outputs depend on persona assumptions; this POC demonstrates the mechanism, the real-data grounding, and the transparency — not a final forecast.</footer>
</div>
<script>
  const btns = document.querySelectorAll('.filters button');
  btns.forEach(b => b.addEventListener('click', () => {
    btns.forEach(x => x.classList.remove('active')); b.classList.add('active');
    const f = b.dataset.f;
    document.querySelectorAll('.agent').forEach(a => { a.style.display = (f === 'all' || a.dataset.stance === f) ? '' : 'none'; });
  }));
</script>
</body></html>`;

const file = join(OUT, "demo.html");
writeFileSync(file, html);
console.log(`Wrote ${file} (${(html.length / 1024).toFixed(1)} KB)`);
