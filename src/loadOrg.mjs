// loadOrg.mjs — parse the REAL AdventureWorks organization: employees (DimEmployee),
// vendors/suppliers (OLTP Vendor + PurchaseOrderHeader), and resellers/wholesale
// partners (DimReseller). Turns them into real records + stratified samplers so the
// simulation's staff and supply chain are grounded in data, not invented.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadGeography } from "./loadAdventureWorks.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data", "adventureworks");
const REF_YEAR = 2013; // dataset era, for realistic tenure

function rows(file, delim) {
  const p = join(DATA, file);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").replace(/\r/g, "").split("\n").filter(Boolean).map((l) => l.split(delim));
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// ---- employees (DimEmployee, pipe-delimited) ----
const E = { key: 0, salesTerr: 4, first: 5, last: 6, title: 9, hire: 10, gender: 19, salaried: 18, rate: 21, dept: 26, current: 24, status: 29 };
export function empGroup(title, dept) {
  const t = (title || "").toLowerCase();
  if (dept === "Executive" || /chief|president|vice president|director/.test(t)) return "exec";
  if (/manager|supervisor|lead/.test(t)) return "managers";
  return "frontline";
}
export function loadEmployees() {
  const out = [];
  for (const f of rows("DimEmployee.csv", "|")) {
    if (f.length < 30 || f[E.status] !== "Current") continue;
    const hireYear = parseInt((f[E.hire] || "").slice(0, 4), 10);
    out.push({
      key: f[E.key], first: f[E.first], last: f[E.last], title: f[E.title], dept: f[E.dept],
      group: empGroup(f[E.title], f[E.dept]), gender: f[E.gender], salaried: f[E.salaried] === "1",
      rate: Math.round(parseFloat(f[E.rate]) || 0), hireYear: Number.isFinite(hireYear) ? hireYear : null,
      tenure: Number.isFinite(hireYear) ? Math.max(1, REF_YEAR - hireYear) : null,
    });
  }
  return out;
}
export function sampleEmployees(n = 22) {
  const all = loadEmployees();
  const exec = shuffle(all.filter((e) => e.group === "exec"));
  const mgrs = shuffle(all.filter((e) => e.group === "managers"));
  const front = shuffle(all.filter((e) => e.group === "frontline"));
  const picks = [];
  const nExec = Math.max(1, Math.round(n * 0.16));   // ~leadership
  const nMgr = Math.max(1, Math.round(n * 0.32));    // ~managers
  picks.push(...exec.slice(0, nExec));
  picks.push(...mgrs.slice(0, nMgr));
  picks.push(...front.slice(0, Math.max(0, n - picks.length))); // rest = frontline (Production-heavy, like the real org)
  if (picks.length < n) { const chosen = new Set(picks); const rest = shuffle(all.filter((e) => !chosen.has(e))); picks.push(...rest.slice(0, n - picks.length)); }
  return shuffle(picks).slice(0, n);
}

// ---- vendors / suppliers (OLTP Vendor + PurchaseOrderHeader, tab-delimited) ----
function vendorSpend() {
  const m = new Map();
  for (const f of rows("PurchaseOrderHeader.csv", "\t")) { const vid = f[4]; const due = parseFloat(f[11]) || 0; m.set(vid, (m.get(vid) || 0) + due); }
  return m;
}
export function loadVendors() {
  const spend = vendorSpend();
  return rows("Vendor.csv", "\t").filter((f) => f[5] === "1").map((f) => ({
    id: f[0], name: f[2], creditRating: parseInt(f[3], 10) || 3, preferred: f[4] === "1", totalSpend: Math.round(spend.get(f[0]) || 0),
  }));
}
export function sampleVendors(n = 5) {
  const v = loadVendors();
  const withSpend = v.filter((x) => x.totalSpend > 0).sort((a, b) => b.totalSpend - a.totalSpend);
  const rest = shuffle(v.filter((x) => x.totalSpend <= 0));
  return [...withSpend.slice(0, Math.ceil(n * 0.7)), ...rest].slice(0, n);
}

// ---- resellers / wholesale (DimReseller, pipe-delimited) ----
const R = { key: 0, geo: 1, businessType: 4, name: 5, numEmployees: 6, productLine: 11, annualSales: 14, yearOpened: 19 };
export function loadResellers() {
  const geo = loadGeography();
  return rows("DimReseller.csv", "|").filter((f) => f.length > 19).map((f) => ({
    name: f[R.name], businessType: f[R.businessType], numEmployees: parseInt(f[R.numEmployees], 10) || 0,
    productLine: f[R.productLine], annualSales: Math.round(parseFloat(f[R.annualSales]) || 0),
    yearOpened: parseInt(f[R.yearOpened], 10) || null, region: (geo.get(f[R.geo]) || {}).region || "Other",
  }));
}
export function sampleResellers(n = 4) {
  const r = loadResellers().filter((x) => x.name && x.annualSales > 0);
  return shuffle(r).sort((a, b) => b.annualSales - a.annualSales).slice(0, Math.max(1, n * 3)).sort(() => Math.random() - 0.5).slice(0, n);
}

// ---- overview stats ----
export function orgStats() {
  const emps = loadEmployees();
  const byDept = {}; for (const e of emps) byDept[e.dept] = (byDept[e.dept] || 0) + 1;
  return {
    employees: emps.length,
    departments: Object.entries(byDept).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    vendors: loadVendors().length,
    resellers: loadResellers().length,
    territories: rows("DimSalesTerritory.csv", "|").length,
  };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("loadOrg.mjs")) {
  const st = orgStats();
  console.log(`Employees: ${st.employees} across ${st.departments.length} departments · Vendors: ${st.vendors} · Resellers: ${st.resellers} · Territories: ${st.territories}`);
  console.log("\nSample employees:");
  for (const e of sampleEmployees(8)) console.log(`  ${e.first} ${e.last} — ${e.title} (${e.dept}, ${e.group}) · hired ${e.hireYear} (~${e.tenure}y) · $${e.rate}${e.salaried ? " salaried" : "/hr"}`);
  console.log("\nSample vendors:"); for (const v of sampleVendors(4)) console.log(`  ${v.name} · credit ${v.creditRating}/5${v.preferred ? " · preferred" : ""} · AW spends $${v.totalSpend.toLocaleString()}`);
  console.log("\nSample resellers:"); for (const r of sampleResellers(3)) console.log(`  ${r.name} · ${r.businessType} · ${r.productLine} line · ${r.numEmployees} staff · $${r.annualSales.toLocaleString()}/yr · ${r.region}`);
}
