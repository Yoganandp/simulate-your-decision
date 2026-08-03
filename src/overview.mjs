// overview.mjs — compute a data-driven "what does this business do" overview for the UI,
// from the real AdventureWorks sample (customers + transactions + product categories).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCustomers, loadSales, buildSegments } from "./loadAdventureWorks.mjs";
import { orgStats } from "./loadOrg.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data", "adventureworks");
const lines = (file) => readFileSync(join(DATA, file), "utf8").replace(/\r/g, "").split("\n").filter(Boolean);

function productCategoryMap() {
  const cat = new Map(), sub = new Map(), prod = new Map();
  for (const l of lines("DimProductCategory.csv")) { const f = l.split("|"); cat.set(f[0], f[2]); }
  for (const l of lines("DimProductSubcategory.csv")) { const f = l.split("|"); sub.set(f[0], f[5]); }
  for (const l of lines("DimProduct.csv")) { const f = l.split("|"); prod.set(f[0], cat.get(sub.get(f[2])) || "Other / unclassified"); }
  return prod;
}

export function computeOverview() {
  const customers = loadCustomers();
  const custRegion = new Map(customers.map(c => [c.key, c.region]));
  const prodCat = productCategoryMap();

  const F = { ProductKey: 0, CustomerKey: 4, SalesOrderNumber: 8, TotalProductCost: 17, SalesAmount: 18, Freight: 20, OrderDate: 23 };
  let rev = 0, cost = 0, freight = 0, minT = Infinity, maxT = -Infinity;
  const orders = new Set(), byRegion = {}, byCat = {};
  for (const l of lines("FactInternetSales.csv")) {
    const f = l.split("|"); if (f.length < 24) continue;
    const amt = parseFloat(f[F.SalesAmount]) || 0;
    rev += amt; cost += parseFloat(f[F.TotalProductCost]) || 0; freight += parseFloat(f[F.Freight]) || 0;
    orders.add(f[F.SalesOrderNumber]);
    const t = Date.parse(f[F.OrderDate]); if (Number.isFinite(t)) { if (t < minT) minT = t; if (t > maxT) maxT = t; }
    byRegion[custRegion.get(f[F.CustomerKey]) || "Other"] = (byRegion[custRegion.get(f[F.CustomerKey]) || "Other"] || 0) + amt;
    byCat[prodCat.get(f[F.ProductKey]) || "Other"] = (byCat[prodCat.get(f[F.ProductKey]) || "Other"] || 0) + amt;
  }
  const spanYears = (maxT - minT) / (365.25 * 24 * 3600 * 1000);
  const ordersN = orders.size;
  const segs = buildSegments(customers, loadSales(), 8).segments;

  return {
    company: {
      name: "AdventureWorks Cycles",
      what: "A fictional multinational manufacturer and retailer of bicycles, components, cycling apparel and accessories. It sells direct-to-consumer online and through a reseller network across North America, Europe and the Pacific. This dataset models the direct online (B2C) business.",
      sells: ["Bikes", "Components", "Clothing", "Accessories"],
      channels: ["Online / direct-to-consumer (modeled here)", "Resellers (B2B)"],
      dataNote: "Microsoft AdventureWorks DW sample — realistic sample data, not real customers.",
    },
    stats: {
      customers: customers.length,
      orders: ordersN,
      totalRevenue: Math.round(rev),
      annualRevenue: Math.round(rev / spanYears),
      grossMarginPct: Math.round(100 * (rev - cost) / rev),
      avgOrderValue: Math.round(rev / ordersN),
      avgAnnualSpendPerCustomer: Math.round(rev / spanYears / customers.length),
      spanYears: +spanYears.toFixed(1),
      avgShippingPerOrder: +(freight / ordersN).toFixed(2),
    },
    revenueByRegion: Object.entries(byRegion).map(([region, v]) => ({ region, revenue: Math.round(v), pct: Math.round(100 * v / rev) })).sort((a, b) => b.revenue - a.revenue),
    revenueByCategory: Object.entries(byCat).map(([category, v]) => ({ category, revenue: Math.round(v), pct: Math.round(100 * v / rev) })).sort((a, b) => b.revenue - a.revenue),
    topSegments: segs.slice(0, 4).map(s => ({ name: s.name, n: s.n, avgAnnualRevenue: s.econ.avgAnnualRevenue, topOccupation: s.topOccupation })),
    org: orgStats(),
  };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("overview.mjs")) {
  const o = computeOverview();
  console.log(`${o.company.name}: ${o.stats.customers.toLocaleString()} customers · $${(o.stats.totalRevenue / 1e6).toFixed(1)}M total rev · $${(o.stats.annualRevenue / 1e6).toFixed(1)}M/yr · AOV $${o.stats.avgOrderValue} · margin ${o.stats.grossMarginPct}%`);
  console.log("By category:", o.revenueByCategory.map(c => `${c.category} ${c.pct}%`).join(", "));
  console.log("By region:", o.revenueByRegion.map(r => `${r.region} ${r.pct}%`).join(", "));
  writeFileSync(join(DATA, "overview.json"), JSON.stringify(o, null, 2));
  console.log(`Wrote ${join(DATA, "overview.json")}`);
}
