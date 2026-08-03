// scenarioRetail.mjs — GENERAL retail decision simulation on real AdventureWorks data.
// Supports two granularities:
//   - "individuals": each agent is ONE real sampled customer (weighted to the full base)
//   - "segments":    each agent is one of 8 data-grounded segments
// Rounds: round 1 is independent; round >1 re-asks customers with a crowd-reaction summary.

import { loadCustomers, loadSales, buildSegments, buildIndividuals } from "./loadAdventureWorks.mjs";

export const title = "Retail Decision Simulation (real AdventureWorks data)";
export const datasetNote = "Grounded in 18,484 real AdventureWorks customers + 60,398 real order lines (DimCustomer + FactInternetSales).";

export const DEFAULT_PROPOSAL = {
  title: "Raise the free-shipping threshold to $75",
  text: "Raise the order value required to qualify for free shipping from $50 to $75. Orders below $75 pay standard shipping.",
};
export const BAD_PROPOSAL = {
  title: "Raise all prices 25% + $15 order surcharge",
  text: "Increase every product price by 25% and add a flat $15 surcharge to every order, with no added benefit to the customer.",
};

// ---------- helpers ----------
const money = (n) => { const a = Math.abs(n), s = n < 0 ? "-" : ""; if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`; if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`; return `${s}$${Math.round(a)}`; };
const sMoney = (n) => (n > 0 ? "+" : "") + money(n);
const sPct = (x) => (x >= 0 ? "+" : "") + x.toFixed(1) + "%";
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const wmean = (items, val, wt) => { let sw = 0, swv = 0; for (const it of items) { const w = wt(it), v = val(it); if (Number.isFinite(v) && Number.isFinite(w)) { sw += w; swv += w * v; } } return sw ? swv / sw : 0; };
const sentimentWord = (s) => s >= 0.8 ? "delighted" : s >= 0.3 ? "pleased" : s > 0.1 ? "mildly positive" : s >= -0.1 ? "neutral" : s > -0.3 ? "mildly negative" : s > -0.8 ? "unhappy" : "angry";

const isInd = (ctx) => ctx.granularity === "individuals";
const unitWeight = (ctx, u) => (isInd(ctx) ? u.weight : u.n);
const unitBase = (ctx, u) => (isInd(ctx) ? u.annualSpend : u.econ.avgAnnualRevenue);
const unitMargin = (ctx, u) => (isInd(ctx) ? u.marginPct : u.econ.grossMarginPct);
const unitStrat = (u) => u.strat || u.name;

// ---------- prepare ----------
export function prepare(proposal = DEFAULT_PROPOSAL, opts = {}) {
  const granularity = opts.granularity === "segments" ? "segments" : "individuals";
  const sampleSize = Math.max(4, Math.min(200, parseInt(opts.sampleSize || 16, 10)));
  const rounds = Math.max(1, Math.min(4, parseInt(opts.rounds || 1, 10)));
  const customers = loadCustomers(), sales = loadSales();

  let units, totalCustomers, weight = null;
  if (granularity === "individuals") {
    const r = buildIndividuals(customers, sales, sampleSize);
    units = r.individuals; totalCustomers = r.totalCustomers; weight = r.weight;
  } else {
    units = buildSegments(customers, sales, 8).segments;
    totalCustomers = units.reduce((s, x) => s + x.n, 0);
  }
  const ctx = { granularity, sampleSize, rounds, units, totalCustomers, weight, proposal };
  ctx.baselineRevenue = units.reduce((s, u) => s + unitBase(ctx, u) * unitWeight(ctx, u), 0);
  ctx.baselineGrossProfit = units.reduce((s, u) => s + unitBase(ctx, u) * (unitMargin(ctx, u) / 100) * unitWeight(ctx, u), 0);
  return ctx;
}

// ---------- agent definitions ----------
const HUMAN_NOTE_CUST = "Answer as a real human being, not a spreadsheet. Weigh the practical money side AND how this actually makes you feel — your habits, values, sense of fairness, convenience, trust, loyalty and mood. Blend the rational and the emotional; don't overindex on either.";

export function customerAgentDefs(ctx, extra = "") {
  if (isInd(ctx)) {
    return ctx.units.map((u) => ({
      kind: "customer", group: "Customers — real AdventureWorks individuals", entity: u,
      label: `Customer #${u.key}`, context: `${u.age || "adult"}yo · $${u.income.toLocaleString()} · ${u.occupation} · ${u.region}`,
      prompt: [
        "You ARE one specific real person who shops at AdventureWorks (online bikes & accessories). Stay fully in character.",
        `About you: ${u.age || "adult"} years old, household income ~$${u.income.toLocaleString()}, you work in ${u.occupation}, you live in ${u.region}, you ${u.homeOwner ? "own your home" : "rent"}${u.childrenAtHome > 0 ? `, ${u.childrenAtHome} kid(s) at home` : ""}.`,
        `Your history with the store: about $${u.annualSpend.toLocaleString()}/year across ~${u.ordersPerYear} orders (typical order $${u.avgOrderValue.toLocaleString()}).`,
        "",
        `The company is considering: "${ctx.proposal.text}"`,
        extra ? `\n${extra}\n` : "",
        HUMAN_NOTE_CUST,
        "Respond with ONLY a JSON object (no markdown, no comments, no trailing commas). Start with { and end with }. Keys:",
        '{"spend_delta_pct": <number: change in your yearly spend, + or ->,',
        ' "sentiment": <number from -2 (angry) to +2 (delighted)>,',
        ' "churn_delta_pct": <number: + = more likely to shop elsewhere, - = more loyal>,',
        ' "how_it_feels": <string: one honest sentence about the experience/emotion for you>,',
        ' "reasoning": <string: one first-person sentence covering the practical AND emotional why>,',
        ' "key_factor": <string: the single biggest thing driving your reaction>}',
      ].join("\n"),
    }));
  }
  return ctx.units.map((seg) => ({
    kind: "customer", group: "Customer segments — real AdventureWorks data", entity: seg,
    label: seg.name, context: `${seg.n.toLocaleString()} customers · $${seg.econ.avgAnnualRevenue}/yr · ${seg.topOccupation}`,
    prompt: [
      `You speak for the customer segment "${seg.name}" — REAL AdventureWorks customers. Represent how these people actually live and feel, not just their wallets.`, seg.profile, "",
      `The company is considering: "${ctx.proposal.text}"`,
      extra ? `\n${extra}\n` : "",
      HUMAN_NOTE_CUST,
      "Respond with ONLY a JSON object (no markdown, no comments, no trailing commas). Start with { and end with }. Keys:",
      '{"spend_delta_pct": <number>, "sentiment": <number -2..2>, "churn_delta_pct": <number>,',
      ' "how_it_feels": <string: one sentence on the felt experience>,',
      ' "reasoning": <string>, "concerns": <string[]>, "benefits": <string[]>}',
    ].join("\n"),
  }));
}

export function internalAgentDefs(ctx) {
  const annual = Math.round(ctx.baselineRevenue);
  const common = `AdventureWorks (online bikes/accessories) serves ~${ctx.totalCustomers.toLocaleString()} customers, ~$${(annual / 1e6).toFixed(1)}M/yr revenue at ~41% gross margin.`;
  const humanNote = "Think and feel like the real person in this job. Weigh the business numbers AND the human side: your team's workload, stress and morale, the risk of people being overworked or overwhelmed, the real effort to execute, and your own professional judgment and reputation. Balance both; don't overindex on either.";
  const schema = [
    "Respond with ONLY a JSON object (no markdown, no comments, no trailing commas). Start with { and end with }. Keys:",
    '{"margin_rate_delta_pts": <number: change to gross-margin RATE in points, e.g. -3 = 41% -> 38%>,',
    ' "recommendation": <one of "adopt", "adopt_with_changes", "reject">,',
    ' "human_impact": <string: one sentence on the effect on your team / workload / morale>,',
    ' "confidence": <number 0..1>,',
    ' "reasoning": <string>, "concerns": <string[]>, "benefits": <string[]>}',
  ].join("\n");
  const roles = [
    { role: "Finance Director", framing: "You are the Finance Director. You watch gross margin, discount/price effects and cash — and you also carry the stress of hitting targets and standing behind your forecasts." },
    { role: "E-commerce & Fulfillment Lead", framing: "You run fulfillment and shipping. You feel every extra order as real work for the warehouse team — pick/pack load, overtime, burnout risk — as well as shipping cost and reliability." },
    { role: "Loyalty / Marketing Lead", framing: "You own growth and brand. You care about demand and positioning, and about whether your small team can actually execute another push without dropping the ball." },
    ...["North America", "Europe", "Pacific"].map((region) => ({ role: `Regional Sales Manager — ${region}`, framing: `You manage the ${region} sales team. You care about regional revenue AND your reps — their quotas, morale, and whether this leaves them overworked or demoralized.` })),
  ];
  return roles.map((r) => ({
    kind: "internal", group: "Internal stakeholders", entity: { id: r.role }, label: r.role, context: "",
    prompt: [r.framing, "", common, "", `Decision under review: "${ctx.proposal.text}"`, "", humanNote, "Assess candidly — don't be a yes-man.", schema].join("\n"),
  }));
}

export function buildCrowdSummary(customerResults) {
  const cust = customerResults.filter(r => r.parsed);
  if (!cust.length) return "";
  const sent = cust.map(r => num(r.parsed.sentiment));
  const avg = sent.reduce((a, b) => a + b, 0) / sent.length;
  const pos = Math.round(100 * sent.filter(s => s > 0.25).length / sent.length);
  const neg = Math.round(100 * sent.filter(s => s < -0.25).length / sent.length);
  const mood = pos > neg + 15 ? "mostly positive" : neg > pos + 15 ? "mostly negative" : "mixed";
  const themes = [...new Set(cust.map(r => r.parsed.key_factor || (r.parsed.concerns && r.parsed.concerns[0])).filter(Boolean))].slice(0, 3);
  return `What other shoppers are saying so far: reactions are ${mood} (average mood ${avg.toFixed(1)} on a -2..+2 scale; ${pos}% positive, ${neg}% negative).` + (themes.length ? ` Common points: ${themes.join("; ")}.` : "") + " Given this, give your updated reaction (you may change your mind).";
}

// ---------- aggregation ----------
function serialize(r, stance) {
  const p = r.parsed || {};
  return {
    label: r.label, context: r.context, stance,
    metrics: Object.fromEntries(Object.entries(p).filter(([k, v]) => typeof v === "number")),
    extra: Object.fromEntries(Object.entries(p).filter(([k, v]) => typeof v === "string" && k !== "reasoning")),
    reasoning: p.reasoning || "(no reasoning returned)", concerns: p.concerns || [], benefits: p.benefits || [],
  };
}
const custStance = (p) => { const s = num(p.sentiment), d = num(p.spend_delta_pct); return (s >= 0.5 || d >= 3) ? "support" : (s <= -0.5 || d <= -3) ? "oppose" : "neutral"; };
const intStance = (p) => p.recommendation === "adopt" ? "support" : p.recommendation === "reject" ? "oppose" : "neutral";

export function aggregate(ctx, internal, customers) {
  const cust = customers.filter(r => r.parsed);
  let revImpact = 0, volumeGP = 0, sw = 0, swSent = 0, swChurn = 0, swSpend = 0;
  const rollup = new Map();
  for (const r of cust) {
    const u = r.entity, p = r.parsed;
    const w = unitWeight(ctx, u), base = unitBase(ctx, u), margin = unitMargin(ctx, u) / 100;
    const sd = num(p.spend_delta_pct) / 100, sent = num(p.sentiment);
    const ri = base * sd * w;
    revImpact += ri; volumeGP += ri * margin;
    sw += w; swSent += w * sent; swChurn += w * num(p.churn_delta_pct); swSpend += w * num(p.spend_delta_pct);
    const key = unitStrat(u);
    if (!rollup.has(key)) rollup.set(key, { segment: key, sampled: 0, base: 0, sdSum: 0, sentSum: 0, ri: 0 });
    const g = rollup.get(key); g.sampled++; g.base += base; g.sdSum += num(p.spend_delta_pct); g.sentSum += sent; g.ri += ri;
  }
  const sentiment = sw ? swSent / sw : 0, churnDelta = sw ? swChurn / sw : 0, spendDeltaPct = sw ? swSpend / sw : 0;
  const predictedRevenue = ctx.baselineRevenue + revImpact;
  const revDeltaPct = ctx.baselineRevenue ? 100 * revImpact / ctx.baselineRevenue : 0;
  const inP = internal.filter(r => r.parsed);
  const marginRateDelta = wmean(inP, r => num(r.parsed.margin_rate_delta_pts), () => 1);
  const marginRateImpact = predictedRevenue * (marginRateDelta / 100);
  const grossProfitImpact = volumeGP + marginRateImpact;
  const recVotes = {}; for (const r of inP) if (r.parsed.recommendation) recVotes[r.parsed.recommendation] = (recVotes[r.parsed.recommendation] || 0) + 1;
  const topRec = Object.entries(recVotes).sort((a, b) => b[1] - a[1])[0]?.[0] || "—";

  // verdict
  const gpThresh = Math.max(2000, 0.005 * ctx.baselineGrossProfit);
  const rejectMaj = (recVotes.reject || 0) > inP.length / 2;
  const verdict = (grossProfitImpact < -gpThresh || sentiment <= -0.6 || rejectMaj) ? "bad"
    : (grossProfitImpact > gpThresh && sentiment >= 0.1) ? "good" : "caution";
  const verdictLabel = verdict === "good" ? "Looks promising" : verdict === "bad" ? "Likely a poor trade-off" : "Mixed — proceed carefully";

  const dir = (good) => (good ? "improve" : "worsen");
  const near0 = (x, e = 0.25) => Math.abs(x) < e;
  const kpis = [
    { name: "Revenue impact / year", display: sMoney(revImpact), sub: `${sPct(revDeltaPct)} of ${money(ctx.baselineRevenue)} a year`, direction: near0(revDeltaPct) ? "neutral" : dir(revImpact > 0) },
    { name: "Profit impact / year", display: sMoney(grossProfitImpact), sub: "after margin, discount & shipping effects", direction: near0(grossProfitImpact, gpThresh / 2) ? "neutral" : dir(grossProfitImpact > 0) },
    { name: "How customers feel", display: `${sentiment >= 0 ? "+" : ""}${sentiment.toFixed(2)}`, sub: `${sentimentWord(sentiment)} (scale -2 to +2)`, direction: near0(sentiment, 0.1) ? "neutral" : dir(sentiment > 0) },
    { name: "Customer loyalty", display: `${churnDelta > 0 ? "+" : ""}${churnDelta.toFixed(1)} pts`, sub: churnDelta < -0.1 ? "more loyal" : churnDelta > 0.1 ? "more likely to leave" : "about the same", direction: near0(churnDelta) ? "neutral" : dir(churnDelta < 0) },
    { name: "Avg spending change", display: sPct(spendDeltaPct), sub: "per customer, on average", direction: "neutral" },
    { name: "Team recommendation", display: Object.entries(recVotes).map(([k, v]) => `${v}× ${k.replace(/_/g, " ")}`).join(", ") || "—", sub: `${inP.length} internal experts`, direction: rejectMaj ? "worsen" : "neutral" },
  ];

  const economics = {
    title: "Estimated yearly money impact (from real spend, margin & shipping)",
    rows: [
      { label: "Revenue today (per year)", value: money(ctx.baselineRevenue), kind: "info" },
      { label: "Revenue if you do this", value: money(predictedRevenue), kind: "info" },
      { label: "= Change in revenue", value: sMoney(revImpact), kind: revImpact >= 0 ? "pos" : "neg" },
      { label: "Profit from customers buying more/less", value: sMoney(volumeGP), kind: volumeGP >= 0 ? "pos" : "neg" },
      { label: `Profit from margin change (finance: ${marginRateDelta >= 0 ? "+" : ""}${marginRateDelta.toFixed(1)} pts)`, value: sMoney(marginRateImpact), kind: marginRateImpact >= 0 ? "pos" : "neg" },
      { label: "= Change in yearly profit", value: sMoney(grossProfitImpact), kind: "total" },
    ],
    note: "Revenue change = each customer's real spend × how much more/less they say they'd buy. Profit applies real ~41% margins; the margin line is the finance team's rate change applied to revenue.",
  };

  // per-segment / rollup table (works for both modes)
  const segmentTable = [...rollup.values()].map(g => ({
    segment: g.segment, n: g.sampled, baseSpend: Math.round(g.base / g.sampled),
    spendDeltaPct: +(g.sdSum / g.sampled).toFixed(1), revImpact: sMoney(g.ri), sentiment: +(g.sentSum / g.sampled).toFixed(1),
  })).sort((a, b) => a.sentiment - b.sentiment);

  const worst = segmentTable[0], best = segmentTable[segmentTable.length - 1];
  const verb = grossProfitImpact >= 0 ? "add roughly" : "cost roughly";
  const advice = verdict === "good" ? "Worth piloting." : verdict === "bad" ? "Reconsider or rework it." : "Test it in one region before a full rollout.";
  const summaryText =
    `In plain terms: this would ${verb} ${money(Math.abs(grossProfitImpact))} in profit per year, and customers feel ${sentimentWord(sentiment)} about it overall (mood ${sentiment >= 0 ? "+" : ""}${sentiment.toFixed(1)}). ` +
    (worst && best && worst.segment !== best.segment ? `${worst.segment} react worst; ${best.segment} react best. ` : "") +
    `Your internal team mostly says “${topRec.replace(/_/g, " ")}.” ${advice}`;

  const crowd = (() => {
    const s = cust.map(r => num(r.parsed.sentiment));
    const pos = s.filter(x => x > 0.25).length, neg = s.filter(x => x < -0.25).length;
    return { n: s.length, positivePct: Math.round(100 * pos / (s.length || 1)), negativePct: Math.round(100 * neg / (s.length || 1)), neutralPct: Math.round(100 * (s.length - pos - neg) / (s.length || 1)) };
  })();

  const groups = [
    { title: "Internal stakeholders", note: "viability & money view", agents: inP.map(r => serialize(r, intStance(r.parsed))) },
    { title: isInd(ctx) ? "Customers — real AdventureWorks individuals" : "Customer segments — real AdventureWorks data", note: isInd(ctx) ? "each tile is one real person" : "stance = sentiment / spend reaction", agents: cust.map(r => serialize(r, custStance(r.parsed))) },
  ];

  const methodology = [
    isInd(ctx)
      ? `We simulated ${cust.length} individual real customers, randomly sampled across regions and income levels, each weighted to represent ~${Math.round(ctx.weight)} similar customers — covering all ${ctx.totalCustomers.toLocaleString()}.`
      : `We simulated ${cust.length} data-grounded customer segments covering all ${ctx.totalCustomers.toLocaleString()} customers.`,
    `Plus ${inP.length} internal experts (finance, fulfillment, marketing, and one sales manager per region).`,
    ctx.rounds > 1 ? `${ctx.rounds} rounds: after round 1 each customer saw how the crowd reacted and could change their mind (word-of-mouth).` : `1 round — every agent answers once, independently.`,
    `Every dollar figure is grounded in real spend, margin and shipping from the dataset. These are directional estimates, not guarantees.`,
  ];

  const headline = `${verdictLabel}. Revenue ${sMoney(revImpact)} (${sPct(revDeltaPct)}), profit ${sMoney(grossProfitImpact)}/yr, customer mood ${sentiment >= 0 ? "+" : ""}${sentiment.toFixed(2)}.`;

  return {
    kpis, economics, groups, segmentTable, methodology, headline,
    verdict, verdictLabel, summaryText, crowd,
    summaryForCompare: { revenueDeltaPct: revDeltaPct, revenueDeltaAbs: revImpact, grossProfitImpact, churnDelta, sentiment },
  };
}

export default { title, datasetNote, DEFAULT_PROPOSAL, BAD_PROPOSAL, prepare, customerAgentDefs, internalAgentDefs, buildCrowdSummary, aggregate };
