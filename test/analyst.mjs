// Confirm the bigger analyst model produces clean metric JSON.
import { AiEngine, extractJson } from "../src/aiEngine.mjs";
import s from "../src/scenarioLive.mjs";

const engine = new AiEngine();
await engine.start();
const ctx = s.prepare(s.DEFAULT_PROPOSAL, { sampleSize: 4 });
const fake = [
  { group: "customers", kind: "customer", parsed: { sentiment: -1, reaction: "I buy less and bundle orders to dodge shipping", spend_delta_pct: -8 } },
  { group: "frontline", kind: "employee", parsed: { sentiment: -0.5, reaction: "more complaints at the counter", workload_change: 1 } },
  { group: "managers", kind: "employee", parsed: { sentiment: -0.3, reaction: "my team feels stretched", workload_change: 1 } },
  { group: "supply", kind: "supply", parsed: { sentiment: 0, reaction: "order volume roughly steady", workload_change: 0 } },
];
const t = Date.now();
const raw = await engine.ask(s.measurementPrompt(ctx, 1, fake, null), { model: s.ANALYST_MODEL });
const j = extractJson(raw);
console.log("analyst model:", s.ANALYST_MODEL, "| ms:", Date.now() - t, "| parsed:", !!j);
console.log(JSON.stringify(j));
await engine.stop();
process.exit(0);
