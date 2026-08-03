// loadAdventureWorks.mjs — parse the real Microsoft AdventureWorks DW sample
// (DimCustomer + DimGeography) and derive data-grounded customer segments.
//
// Build segments whose size and
// demographic stats (income, age, children, home-ownership, occupation, region) come
// straight from 18,484 real sample-customer rows.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data", "adventureworks");

// Dataset is vintage (~2011-2013); compute ages against a reference year so the
// working-age distribution stays realistic. Override with AW_REF_YEAR.
const REF_YEAR = parseInt(process.env.AW_REF_YEAR || "2013", 10);

// DimCustomer column order (AdventureWorksDW DimCustomer; pipe-delimited, no header).
const C = {
  CustomerKey: 0, GeographyKey: 1, AltKey: 2, Title: 3, FirstName: 4, MiddleName: 5,
  LastName: 6, NameStyle: 7, BirthDate: 8, MaritalStatus: 9, Suffix: 10, Gender: 11,
  Email: 12, YearlyIncome: 13, TotalChildren: 14, ChildrenAtHome: 15, Education: 16,
  EduES: 17, EduFR: 18, Occupation: 19, OccES: 20, OccFR: 21, HouseOwner: 22,
  CarsOwned: 23, Address1: 24, Address2: 25, Phone: 26, DateFirstPurchase: 27, Commute: 28,
};

// DimGeography column order.
const G = {
  GeographyKey: 0, City: 1, StateCode: 2, StateName: 3, CountryCode: 4, CountryName: 5,
};

const REGION_BY_COUNTRY = {
  "United States": "North America", "Canada": "North America",
  "United Kingdom": "Europe", "France": "Europe", "Germany": "Europe",
  "Australia": "Pacific",
};

function splitLines(text) {
  return text.replace(/\r/g, "").split("\n").filter(l => l.length > 0);
}

export function loadGeography() {
  const file = join(DATA, "DimGeography.csv");
  const map = new Map();
  for (const line of splitLines(readFileSync(file, "utf8"))) {
    const f = line.split("|");
    const country = f[G.CountryName];
    map.set(f[G.GeographyKey], {
      city: f[G.City], state: f[G.StateName], country,
      region: REGION_BY_COUNTRY[country] || "Other",
    });
  }
  return map;
}

export function loadCustomers() {
  const file = join(DATA, "DimCustomer.csv");
  if (!existsSync(file)) throw new Error(`Missing ${file}. Download it first (see data/README).`);
  const geo = loadGeography();
  const out = [];
  for (const line of splitLines(readFileSync(file, "utf8"))) {
    const f = line.split("|");
    if (f.length < 29) continue;
    const birthYear = parseInt((f[C.BirthDate] || "").slice(0, 4), 10);
    const g = geo.get(f[C.GeographyKey]) || {};
    out.push({
      key: f[C.CustomerKey],
      gender: f[C.Gender],
      maritalStatus: f[C.MaritalStatus],
      age: Number.isFinite(birthYear) ? REF_YEAR - birthYear : null,
      income: parseFloat(f[C.YearlyIncome]) || 0,
      totalChildren: parseInt(f[C.TotalChildren], 10) || 0,
      childrenAtHome: parseInt(f[C.ChildrenAtHome], 10) || 0,
      education: f[C.Education],
      occupation: f[C.Occupation],
      homeOwner: f[C.HouseOwner] === "1",
      carsOwned: parseInt(f[C.CarsOwned], 10) || 0,
      commute: f[C.Commute],
      region: g.region || "Other",
      country: g.country || "Unknown",
    });
  }
  return out;
}

// FactInternetSales column order (pipe-delimited, no header).
const F = { ProductKey: 0, OrderDateKey: 1, CustomerKey: 4, SalesOrderNumber: 8,
  TotalProductCost: 17, SalesAmount: 18, Freight: 20, OrderDate: 23 };

/** Load real transactions and roll up per-customer economics. */
export function loadSales() {
  const file = join(DATA, "FactInternetSales.csv");
  if (!existsSync(file)) return null;
  const byCustomer = new Map();
  let minT = Infinity, maxT = -Infinity;
  let totRev = 0, totCost = 0, totFreight = 0;
  for (const line of splitLines(readFileSync(file, "utf8"))) {
    const f = line.split("|");
    if (f.length < 24) continue;
    const ck = f[F.CustomerKey];
    const rev = parseFloat(f[F.SalesAmount]) || 0;
    const cost = parseFloat(f[F.TotalProductCost]) || 0;
    const freight = parseFloat(f[F.Freight]) || 0;
    const t = Date.parse(f[F.OrderDate]);
    if (Number.isFinite(t)) { if (t < minT) minT = t; if (t > maxT) maxT = t; }
    let rec = byCustomer.get(ck);
    if (!rec) { rec = { revenue: 0, cost: 0, freight: 0, orders: new Set() }; byCustomer.set(ck, rec); }
    rec.revenue += rev; rec.cost += cost; rec.freight += freight; rec.orders.add(f[F.SalesOrderNumber]);
    totRev += rev; totCost += cost; totFreight += freight;
  }
  const spanYears = (maxT - minT) / (365.25 * 24 * 3600 * 1000);
  return { byCustomer, spanYears, totals: { revenue: totRev, cost: totCost, freight: totFreight } };
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pct = (a, f) => (a.length ? (100 * a.filter(f).length) / a.length : 0);
function mode(a) {
  const m = {}; let best = null, bestN = -1;
  for (const x of a) { m[x] = (m[x] || 0) + 1; if (m[x] > bestN) { bestN = m[x]; best = x; } }
  return best;
}
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Build N data-grounded segments by Region x Income-tier, keeping the largest by
 * real customer count. Every stat below is computed from the real rows + transactions.
 */
export function buildSegments(customers, sales, limit = 8) {
  const incomes = customers.map(c => c.income).sort((a, b) => a - b);
  const t1 = quantile(incomes, 1 / 3), t2 = quantile(incomes, 2 / 3);
  const tier = (inc) => (inc <= t1 ? "Budget" : inc <= t2 ? "Mid-market" : "Premium");

  const buckets = new Map();
  for (const c of customers) {
    const key = `${c.region} · ${tier(c.income)}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }

  const spanYears = sales ? Math.max(sales.spanYears, 0.5) : 1;

  const segs = [...buckets.entries()]
    .filter(([k]) => !k.startsWith("Other"))
    .map(([name, rows], i) => {
      const ages = rows.map(r => r.age).filter(Number.isFinite);
      let sumRev = 0, sumCost = 0, sumFreight = 0, sumOrders = 0, withSales = 0;
      if (sales) {
        for (const r of rows) {
          const e = sales.byCustomer.get(r.key);
          if (!e) continue;
          withSales++; sumRev += e.revenue; sumCost += e.cost; sumFreight += e.freight; sumOrders += e.orders.size;
        }
      }
      const denom = withSales || rows.length;
      const econ = sales ? {
        customersWithSales: withSales,
        avgAnnualRevenue: Math.round(sumRev / spanYears / denom),
        avgOrderValue: sumOrders ? Math.round(sumRev / sumOrders) : 0,
        avgOrdersPerYear: +(sumOrders / spanYears / denom).toFixed(2),
        grossMarginPct: sumRev ? Math.round(100 * (sumRev - sumCost) / sumRev) : 0,
        avgAnnualShipping: Math.round(sumFreight / spanYears / denom),
      } : null;
      return {
        id: `AW-${String(i).padStart(2, "0")}`,
        name, n: rows.length,
        avgIncome: Math.round(mean(rows.map(r => r.income))),
        avgAge: Math.round(mean(ages)),
        pctHomeOwner: Math.round(pct(rows, r => r.homeOwner)),
        pctKidsAtHome: Math.round(pct(rows, r => r.childrenAtHome > 0)),
        pctMarried: Math.round(pct(rows, r => r.maritalStatus === "M")),
        avgCars: +mean(rows.map(r => r.carsOwned)).toFixed(1),
        topOccupation: mode(rows.map(r => r.occupation)),
        typicalCommute: mode(rows.map(r => r.commute)),
        region: rows[0].region, econ,
      };
    })
    .sort((a, b) => b.n - a.n)
    .slice(0, limit);

  for (const s of segs) {
    const e = s.econ;
    s.profile =
      `A real AdventureWorks customer segment: ${s.n.toLocaleString()} people in ${s.region}. ` +
      `Average income ~$${s.avgIncome.toLocaleString()}, average age ~${s.avgAge}, ` +
      `${s.pctHomeOwner}% home-owners, ${s.pctMarried}% married, ${s.pctKidsAtHome}% with kids at home. ` +
      `Predominant occupation: ${s.topOccupation}.` +
      (e ? ` Real buying behavior: ~$${e.avgAnnualRevenue.toLocaleString()}/yr spend across ~${e.avgOrdersPerYear} orders/yr ` +
        `(avg order $${e.avgOrderValue.toLocaleString()}), gross margin ~${e.grossMarginPct}%, ` +
        `AdventureWorks currently pays ~$${e.avgAnnualShipping.toLocaleString()}/yr shipping per customer.` : "");
  }
  return { segments: segs, incomeTiers: { budgetMax: Math.round(t1), midMax: Math.round(t2) }, total: customers.length, spanYears };
}

function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/**
 * Sample k individual REAL customers (stratified by region x income tier), each joined
 * to their real purchase history and given a population weight so the sample represents
 * the whole active base. Each sampled customer becomes one simulation agent.
 */
export function buildIndividuals(customers, sales, k = 16) {
  const spanYears = sales ? Math.max(sales.spanYears, 0.5) : 1;
  const incomes = customers.map(c => c.income).sort((a, b) => a - b);
  const t1 = quantile(incomes, 1 / 3), t2 = quantile(incomes, 2 / 3);
  const tier = (inc) => (inc <= t1 ? "Budget" : inc <= t2 ? "Mid-market" : "Premium");

  const active = [];
  for (const c of customers) {
    const e = sales && sales.byCustomer.get(c.key);
    if (!e || e.revenue <= 0) continue;
    const orders = e.orders.size;
    active.push({
      key: c.key, age: c.age, income: c.income, gender: c.gender, maritalStatus: c.maritalStatus,
      occupation: c.occupation, education: c.education, region: c.region, homeOwner: c.homeOwner,
      childrenAtHome: c.childrenAtHome, commute: c.commute,
      annualSpend: Math.round(e.revenue / spanYears),
      ordersPerYear: +(orders / spanYears).toFixed(2),
      avgOrderValue: Math.round(e.revenue / orders),
      marginPct: Math.round(100 * (e.revenue - e.cost) / e.revenue),
      annualShipping: Math.round(e.freight / spanYears),
      tier: tier(c.income), strat: `${c.region} · ${tier(c.income)}`,
    });
  }
  const byStrat = new Map();
  for (const a of active) { if (a.region === "Other") continue; if (!byStrat.has(a.strat)) byStrat.set(a.strat, []); byStrat.get(a.strat).push(a); }
  const pop = [...byStrat.values()].reduce((s, arr) => s + arr.length, 0) || active.length;

  const sample = [];
  for (const [, arr] of byStrat) {
    const want = Math.max(1, Math.round(k * arr.length / pop));
    for (const i of shuffle(arr.map((_, i) => i)).slice(0, Math.min(want, arr.length))) sample.push(arr[i]);
  }
  const sampled = shuffle(sample).slice(0, k);
  const weight = pop / (sampled.length || 1);
  for (const s of sampled) s.weight = weight;
  return { individuals: sampled, activeCount: pop, totalCustomers: customers.length, spanYears, weight };
}

// CLI: print a profile and write data/segments.json
if (import.meta.url === pathToFileURLSafe(process.argv[1])) {
  const customers = loadCustomers();
  const sales = loadSales();
  const { segments, incomeTiers, total, spanYears } = buildSegments(customers, sales, 8);
  console.log(`Loaded ${total.toLocaleString()} real AdventureWorks customers` + (sales ? ` + ${spanYears.toFixed(1)}yr of real transactions.` : "."));
  console.log(`Income tiers: Budget <= $${incomeTiers.budgetMax.toLocaleString()} < Mid-market <= $${incomeTiers.midMax.toLocaleString()} < Premium`);
  console.log(`\nTop data-grounded segments (demographics + real economics):`);
  for (const s of segments) {
    const e = s.econ || {};
    console.log(`\n  [${s.id}] ${s.name}  (n=${s.n.toLocaleString()})`);
    console.log(`    income ~$${s.avgIncome.toLocaleString()} · age ~${s.avgAge} · ${s.pctHomeOwner}% own home · ${s.topOccupation}`);
    if (s.econ) console.log(`    $${e.avgAnnualRevenue.toLocaleString()}/yr spend · ${e.avgOrdersPerYear} orders/yr · AOV $${e.avgOrderValue.toLocaleString()} · margin ${e.grossMarginPct}% · ships $${e.avgAnnualShipping.toLocaleString()}/yr`);
  }
  const outFile = join(DATA, "segments.json");
  writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), refYear: REF_YEAR, total, spanYears, incomeTiers, segments }, null, 2));
  console.log(`\nWrote ${outFile}`);
}

function pathToFileURLSafe(p) {
  try { return new URL("file://" + (p.startsWith("/") ? "" : "/") + p.replace(/\\/g, "/")).href; }
  catch { return ""; }
}
