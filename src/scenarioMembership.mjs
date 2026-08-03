// scenarioMembership.mjs — "Launch a $49/yr loyalty membership (free shipping + 10% off)"
// grounded in REAL AdventureWorks customers + transactions.
//
// Customer-segment agents decide adoption / spend / retention; internal stakeholder
// agents (finance, fulfillment, marketing, regional sales) judge viability. The
// aggregate is a real-data Year-1 program P&L.

import { loadCustomers, loadSales, buildSegments } from "./loadAdventureWorks.mjs";

const TERMS = { feeUsd: 49, discountPct: 10 };

export const title = "Loyalty Membership Decision (real AdventureWorks data)";
export const datasetNote = "Grounded in 18,484 real AdventureWorks customers + 3.1 years of real transactions (DimCustomer + FactInternetSales).";

export const DEFAULT_PROPOSAL = {
  title: "Launch a $49/yr loyalty membership",
  text: "Launch a paid loyalty membership: customers pay $49/year and in return get FREE SHIPPING on every order plus 10% OFF every purchase. Goal: increase purchase frequency and retention without eroding overall profit.",
};

// Obvious-loser control for the discrimination test: give margin away with no fee.
export const BAD_PROPOSAL = {
  title: "Free shipping + 15% off for everyone, no fee",
  text: "Give ALL customers free shipping on every order and 15% off every purchase, with no membership and no fee of any kind. Goal: maximize customer goodwill.",
};

const money = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${n < 0 ? "-" : ""}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${n < 0 ? "-" : ""}$${(a / 1e3).toFixed(0)}K`;
  return `${n < 0 ? "-" : ""}$${Math.round(a)}`;
};
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const wmean = (items, val, wt) => {
  let sw = 0, swv = 0;
  for (const it of items) { const w = wt(it), v = val(it); if (Number.isFinite(v) && Number.isFinite(w)) { sw += w; swv += w * v; } }
  return sw ? swv / sw : 0;
};

export function prepare(proposal = DEFAULT_PROPOSAL, terms = TERMS) {
  const segments = buildSegments(loadCustomers(), loadSales(), 8).segments;
  const totalCustomers = segments.reduce((s, x) => s + x.n, 0);
  return { segments, totalCustomers, terms, proposal };
}

// ---- Agent definitions ----

export function customerAgentDefs(ctx) {
  const t = ctx.terms;
  return ctx.segments.map((seg) => ({
    kind: "customer", group: "Customer segments (real AdventureWorks data)", entity: seg,
    label: seg.name, context: `${seg.n.toLocaleString()} customers · $${seg.econ.avgAnnualRevenue}/yr · ${seg.topOccupation}`,
    prompt: [
      `You represent the customer segment "${seg.name}" — these are REAL AdventureWorks customers (online bikes & accessories retailer).`,
      seg.profile,
      "",
      `AdventureWorks is considering this offer: "${ctx.proposal.text}"`,
      t.feeUsd > 0
        ? `Membership terms: $${t.feeUsd}/year; members get free shipping on every order + ${t.discountPct}% off every purchase.`
        : `Offer terms: NO fee — every customer gets free shipping on every order + ${t.discountPct}% off every purchase.`,
      `Today this segment spends ~$${seg.econ.avgAnnualRevenue}/yr across ~${seg.econ.avgOrdersPerYear} orders (avg order $${seg.econ.avgOrderValue}) and pays ~$${seg.econ.avgAnnualShipping}/yr shipping.`,
      "",
      t.feeUsd > 0
        ? `Decide how THIS segment behaves over the next year. Be realistic about the math: a $${t.feeUsd} fee only pays off for customers who buy enough; infrequent buyers won't bother; bargain-seekers love ${t.discountPct}% off but may not buy more often.`
        : `Decide how THIS segment behaves over the next year. With no fee and a standing ${t.discountPct}% discount, expect broad uptake — but be honest about whether they actually buy MORE, or just pay less for the same baskets.`,
      "Output ONLY a JSON object (no prose, no fence). Keys:",
      "{",
      '  "join_probability": number,       // 0..1 share of this segment that buys the membership',
      '  "annual_spend_delta_pct": number, // if they join: change in annual spend (+ = buy more)',
      '  "visit_freq_delta_pct": number,   // change in purchase frequency',
      '  "churn_delta_pct": number,        // negative = better retention',
      '  "confidence": number,             // 0..1',
      '  "reasoning": string,              // 2-3 sentences grounded in this segment\'s economics',
      '  "concerns": string[],',
      '  "benefits": string[]',
      "}",
    ].join("\n"),
  }));
}

export function internalAgentDefs(ctx) {
  const t = ctx.terms;
  const blended = Math.round(ctx.segments.reduce((s, x) => s + x.econ.avgAnnualRevenue * x.n, 0) / ctx.totalCustomers);
  const common = `AdventureWorks has ~${ctx.totalCustomers.toLocaleString()} active customers spending ~$${blended} blended/yr at ~41% gross margin. Proposed: $${t.feeUsd}/yr membership, free shipping + ${t.discountPct}% off for members.`;
  const schema = [
    "Output ONLY a JSON object. Keys:",
    "{",
    '  "recommendation": "adopt"|"adopt_with_changes"|"reject",',
    "  <one role metric below>,",
    '  "confidence": number, "reasoning": string, "concerns": string[], "benefits": string[]',
    "}",
  ].join("\n");

  const roles = [
    { role: "Finance Director", metric: '"gross_margin_delta_pct": number  // estimated change to overall gross margin',
      framing: `You are the Finance Director. The ${t.discountPct}% discount erodes margin on every member order; the $${t.feeUsd} fee and any incremental volume must offset it. Worry about cannibalizing high-spenders who would have bought anyway.` },
    { role: "E-commerce & Fulfillment Lead", metric: '"incremental_shipping_cost_per_member_usd": number',
      framing: "You own fulfillment and shipping cost. Free shipping means AdventureWorks absorbs carrier costs on every member order; more orders means more pick/pack/ship load." },
    { role: "Loyalty / Marketing Lead", metric: '"expected_adoption_pct": number  // 0..100',
      framing: "You own loyalty and growth. You care about adoption, perceived value, competitive positioning, and whether the membership deepens engagement." },
    ...["North America", "Europe", "Pacific"].map((region) => {
      const segs = ctx.segments.filter(s => s.region === region);
      const note = segs.map(s => `${s.name.split("·")[1].trim()} ($${s.econ.avgAnnualRevenue}/yr, ${s.n.toLocaleString()})`).join(", ");
      return { role: `Regional Sales Manager — ${region}`, metric: '"regional_adoption_pct": number  // 0..100',
        framing: `You run sales in ${region}. Your segments: ${note}. Judge adoption and revenue impact for YOUR region specifically.` };
    }),
  ];

  return roles.map((r) => ({
    kind: "internal", group: "Internal stakeholders", entity: { id: r.role },
    label: r.role, context: "",
    prompt: [r.framing, "", common, "", "Assess candidly — do not be a yes-man.", schema.replace("<one role metric below>", r.metric)].join("\n"),
  }));
}

// ---- Aggregation: real-data Year-1 program P&L ----

function serialize(r, stance) {
  const p = r.parsed || {};
  return {
    label: r.label, context: r.context, stance,
    metrics: Object.fromEntries(Object.entries(p).filter(([k, v]) => typeof v === "number")),
    extra: Object.fromEntries(Object.entries(p).filter(([k, v]) => typeof v === "string" && k !== "reasoning")),
    reasoning: p.reasoning || "(no reasoning returned)",
    concerns: p.concerns || [], benefits: p.benefits || [],
  };
}

export function aggregate(ctx, internal, customers) {
  const fee = ctx.terms.feeUsd, disc = ctx.terms.discountPct / 100;
  const cust = customers.filter(r => r.parsed);

  let members = 0, feeRev = 0, incrMargin = 0, discountCost = 0, shipCost = 0, incrRevenue = 0;
  const perSeg = [];
  for (const r of cust) {
    const s = r.entity, p = r.parsed;
    const join = Math.max(0, Math.min(1, num(p.join_probability)));
    const segMembers = s.n * join;
    const spendDelta = num(p.annual_spend_delta_pct) / 100;
    const base = s.econ.avgAnnualRevenue;
    const newSpend = base * (1 + spendDelta);
    const marginFrac = (s.econ.grossMarginPct || 41) / 100;
    const segIncrRev = (newSpend - base) * segMembers;
    members += segMembers;
    feeRev += segMembers * fee;
    incrRevenue += segIncrRev;
    incrMargin += segIncrRev * marginFrac;
    discountCost += newSpend * disc * segMembers;
    shipCost += s.econ.avgAnnualShipping * (1 + spendDelta) * segMembers;
    perSeg.push({ seg: s, join, segMembers, spendDelta });
  }
  const netProfit = feeRev + incrMargin - discountCost - shipCost;
  const adoptionRate = ctx.totalCustomers ? (100 * members / ctx.totalCustomers) : 0;
  const churnDelta = wmean(cust, r => num(r.parsed.churn_delta_pct), r => r.entity.n);
  const profitPerMember = members ? netProfit / members : 0;

  const dir = (cond) => (cond ? "improve" : "worsen");
  const kpis = [
    { name: "Membership adoption", display: `${adoptionRate.toFixed(0)}%`, sub: `~${Math.round(members).toLocaleString()} of ${ctx.totalCustomers.toLocaleString()} customers join`, direction: "neutral" },
    { name: "Net Year-1 program profit", display: money(netProfit), sub: `${money(profitPerMember)} per member`, direction: dir(netProfit > 0) },
    { name: "Membership fee revenue", display: money(feeRev), sub: `${Math.round(members).toLocaleString()} × $${fee}`, direction: "neutral" },
    { name: `${ctx.terms.discountPct}% discount give-back`, display: money(-discountCost), sub: "margin lost to member discount", direction: "worsen" },
    { name: "Free shipping absorbed", display: money(-shipCost), sub: "carrier cost AdventureWorks eats", direction: "worsen" },
    { name: "Incremental gross margin", display: money(incrMargin), sub: `from ${money(incrRevenue)} extra spend`, direction: dir(incrMargin > 0) },
    { name: "Retention (churn)", display: `${churnDelta > 0 ? "+" : ""}${churnDelta.toFixed(1)} pts`, sub: "negative = more loyal", direction: dir(churnDelta < 0) },
  ];

  const economics = {
    title: "Year-1 program P&L (computed from real per-segment economics)",
    rows: [
      { label: "Members (modeled)", value: Math.round(members).toLocaleString(), kind: "info" },
      { label: "Membership fee revenue", value: money(feeRev), kind: "pos" },
      { label: "+ Incremental gross margin (extra volume)", value: money(incrMargin), kind: "pos" },
      { label: `− ${ctx.terms.discountPct}% discount on member spend`, value: money(-discountCost), kind: "neg" },
      { label: "− Free shipping absorbed", value: money(-shipCost), kind: "neg" },
      { label: "= Net Year-1 program profit", value: money(netProfit), kind: "total" },
      { label: "Profit per member", value: money(profitPerMember), kind: netProfit > 0 ? "pos" : "neg" },
    ],
    note: "10% discount and free-shipping costs use each segment's real spend, margin, and freight; incremental volume comes from the agents' predicted spend lift.",
  };

  // groups + stances
  const custStance = (p) => { const j = num(p.join_probability); return j >= 0.4 ? "support" : j <= 0.15 ? "oppose" : "neutral"; };
  const intStance = (p) => p.recommendation === "adopt" ? "support" : p.recommendation === "reject" ? "oppose" : "neutral";
  const groups = [
    { title: "Internal stakeholders", note: "viability & governance view", agents: internal.filter(r => r.parsed).map(r => serialize(r, intStance(r.parsed))) },
    { title: "Customer segments — real AdventureWorks data", note: "stance = likelihood to adopt", agents: cust.map(r => serialize(r, custStance(r.parsed))) },
  ];

  const recVotes = {};
  for (const r of internal) if (r.parsed?.recommendation) recVotes[r.parsed.recommendation] = (recVotes[r.parsed.recommendation] || 0) + 1;

  const headline = `Predicted ${adoptionRate.toFixed(0)}% adoption (~${Math.round(members).toLocaleString()} members). Net Year-1 program P&L: ${money(netProfit)} (${money(profitPerMember)}/member). Internal vote: ${JSON.stringify(recVotes)}.`;

  const methodology = [
    `Engine: each of ${cust.length} customer segments and ${internal.filter(r => r.parsed).length} internal stakeholders is a live agent on the locally selected AI CLI.`,
    `Grounding: segments, sizes, spend, margin and shipping are computed from 18,484 real AdventureWorks customers + 60,398 real order lines.`,
    `P&L: per segment, members = size × join_probability; discount cost = member spend × ${ctx.terms.discountPct}%; shipping = real per-customer freight × order lift; incremental margin = extra spend × real gross margin. Net = fees + incremental margin − discount − shipping.`,
    `Reproduce: npm run simulate && npm run report after selecting a local AI CLI with npm run setup.`,
  ];

  return { kpis, economics, groups, headline, methodology, recVotes,
    summaryForCompare: { adoptionRate, netProfit, profitPerMember, churnDelta } };
}

export default { title, datasetNote, DEFAULT_PROPOSAL, BAD_PROPOSAL, prepare, customerAgentDefs, internalAgentDefs, aggregate };
