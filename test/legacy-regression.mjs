import assert from "node:assert/strict";
import { METRICS, aggregate, converged } from "../src/scenarioLive.mjs";

const ratings = Object.fromEntries(METRICS.map(([key, , kind]) => [key, kind === "index" ? 100 : 70]));
assert.equal(converged({}, {}).converged, false);
assert.equal(converged(ratings, {}).converged, false);
assert.equal(converged(ratings, { ...ratings, revenue_index: null }).converged, false);
assert.equal(converged(ratings, { ...ratings, revenue_index: "100" }).converged, false);
assert.equal(converged(ratings, ratings).converged, true);
assert.throws(() => aggregate({}, [], []), /Missing/);
assert.throws(() => aggregate({}, [{ parsed: { error: "unauthorized" } }], [ratings]), /Failed/);
const reaction = {
  kind: "customer", group: "customers", label: "Sample customer",
  entity: { region: "Synthetic region", annualSpend: 100, marginPct: 50 },
  parsed: { reaction: "Synthetic fixture", sentiment: 0, spend_delta_pct: 10 },
};
const base = aggregate({ weight: 1, baselineRevenue: 100 }, [reaction], [ratings]);
const changed = aggregate({ weight: 1, baselineRevenue: 100 }, [reaction], [{ ...ratings, gross_margin_index: 150 }]);
assert.deepEqual(base.economics, changed.economics);
assert.equal(changed.economics.rows[0].value, "Unavailable");
assert.equal(changed.verdict, "caution");
assert.ok(!changed.summaryText.includes("/yr"));
console.log("Legacy regression tests passed.");
