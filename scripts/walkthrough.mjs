import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${flag} requires a value.`);
  return args[i + 1];
};
const flags = new Set(["--help", "--revise"]);
const allowed = new Set(["--model", "--url", "--run", "--help", "--fulfillment-cost", "--labor-rate", "--revise"]);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  if (!flags.has(args[i])) i++;
}
if (args.includes("--help")) {
  console.log("Usage: npm run walkthrough -- --run RUN_ID [--url http://localhost:5050]");
  console.log("       npm run walkthrough -- --model EXPLICIT_MODEL_ID [--url http://localhost:5050]");
  console.log("With --run: replay and export an existing complete run, with no inference.");
  console.log("With --model: prepare a SMALL live 5-actor, 2-cycle experiment, then replay it.");
  console.log("Optional explicit assumptions: --fulfillment-cost 5.00 --labor-rate 24.00 (USD).");
  console.log("Optional --revise: also run a $75 threshold / $3.95 fee revision with the same frozen inputs.");
  console.log("Inspect the saved draft in the UI before running a business decision.");
  process.exit(0);
}
const base = value("--url", "http://localhost:5050").replace(/\/$/, "");
const target = new URL(base);
if (target.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
    target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
  throw new Error("--url must be the loopback HTTP application origin.");
}
const model = value("--model");
const existingRunId = value("--run");
if ((!model && !existingRunId) || (model && existingRunId)) {
  throw new Error("Choose exactly one of --model EXPLICIT_MODEL_ID or --run RUN_ID.");
}
if (existingRunId && (args.includes("--revise") || value("--fulfillment-cost") || value("--labor-rate"))) {
  throw new Error("--run is replay-only; assumptions and --revise require a new --model walkthrough.");
}
const cents = (input) => {
  if (input == null) return null;
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(input)) throw new Error("Cost assumptions must be nonnegative USD amounts with at most two decimals.");
  const [whole, fraction = ""] = input.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};
const assumptions = {
  fulfillmentCostPerOrderCents: cents(value("--fulfillment-cost")),
  incrementalLaborRateCentsPerHour: cents(value("--labor-rate")),
};
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let token;
let stopping = false;
class WalkthroughCancelled extends Error {}
const request = async (path, body) => {
  if (stopping && !path.endsWith("/cancel")) throw new WalkthroughCancelled("Walkthrough cancelled.");
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json", "X-Simulation-Token": token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${typeof result.error === "string" ? result.error : JSON.stringify(result.error || result)}`);
  return result;
};
token = (await request("/api/session")).token;
let runId = existingRunId;
process.once("SIGINT", async () => {
  stopping = true;
  if (!existingRunId && runId) {
    try { await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {}); }
    catch (error) { console.error("Cancellation failed:", error.message); }
  }
  process.exitCode = 130;
});
async function main() {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let preparedAt;
  let draft;
  let saved;
  if (model) {
    const provider = await request(`/api/provider/status?model=${encodeURIComponent(model)}`);
    if (!provider.ready) throw new Error(`Provider not ready: ${JSON.stringify(provider.error || provider)}`);
    draft = await request("/api/experiments/draft", {
      decisionText: "Raise the free-shipping threshold from $50 to $75. Keep the shipping fee at $7.95.",
      title: "Small live walkthrough (not behavioral validation)",
      customerCount: 2, employeeCount: 1, supplierCount: 1, resellerCount: 1, cycles: 2,
      assumptions,
      runConfig: { provider: "copilot", model, concurrency: 4 },
    });
    saved = await request("/api/experiments", { definition: draft.definition, inputs: draft.inputs });
    preparedAt = new Date().toISOString();
    console.log("Explicit illustrative cost assumptions (USD cents, null = unknown):", JSON.stringify(assumptions));
    const run = await request(`/api/experiments/${encodeURIComponent(saved.definition.experimentId)}/runs`, {
      version: saved.definition.version, idempotencyKey: `walkthrough-${randomUUID()}`,
    });
    runId = run.runId;
    if (stopping) await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {});
    console.log(`Live inference: ${draft.inputs.actors.length} actors, ${draft.definition.scenarios.length} options, ${draft.definition.horizon.steps} shopping cycles.`);
    console.log(`Run ${runId}; open ${base} to inspect history and assumptions.`);
  }
  async function waitForRun() {
    let current;
    let lastStatus;
    while (!stopping) {
      current = await request(`/api/runs/${encodeURIComponent(runId)}`);
      if (current.status !== lastStatus) {
        console.log(`Run status: ${current.status}`);
        lastStatus = current.status;
      }
      if (["completed", "failed", "cancelled", "interrupted", "paused"].includes(current.status)) return current;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return current;
  }
  async function exportRun(run, parentRunId = null) {
    const runFinishedAt = new Date().toISOString();
    if (run.status !== "completed") throw new Error(`Walkthrough incomplete: ${JSON.stringify(run.error || run.status)}`);
    const replay = await request(`/api/runs/${encodeURIComponent(runId)}/replay`, {});
    let brief = null;
    const hasCompleteComparison = run.comparison && ["complete", "trade_off"].includes(run.comparison.status);
    if (hasCompleteComparison) brief = await request(`/api/runs/${encodeURIComponent(runId)}/brief`, {});
    const record = {
      label: existingRunId ? "Saved-action replay; no new inference" : "Single-machine live walkthrough; not a productivity trial",
      runId, experimentId: run.manifest.experimentId, version: run.manifest.version,
      startedAt, preparedAt, runFinishedAt, finishedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - start),
      activeWorkMs: null, manualComparisonMs: null, savingsClaim: null,
      actorCount: draft?.inputs.actors.length ?? null,
      horizon: draft?.definition.horizon ?? null,
      parentRunId,
      declaredCostAssumptions: existingRunId ? null : assumptions,
      manifest: run.manifest, comparison: run.comparison,
      replayVerified: replay.verified,
      briefExported: Boolean(brief),
      limitations: [
        "Automated elapsed time includes inference and is not measured human active work.",
        "No manual comparison task, historical intervention, or predictive accuracy evaluation.",
        ...(hasCompleteComparison ? [] : ["Missing material inputs prevent a financial comparison and brief. Review costs in the UI."]),
      ],
    };
    const output = join(root, "out");
    await mkdir(output, { recursive: true });
    const safeId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
    await writeFile(join(output, `walkthrough-${safeId}.json`), JSON.stringify(record, null, 2) + "\n");
    if (brief) await writeFile(join(output, `brief-${safeId}.md`), brief.markdown);
    console.log(`Replay verified: ${replay.verified}. Record saved under out\\walkthrough-${safeId}.json.`);
    if (!brief) console.log("Financial comparison/brief unavailable until missing inputs are reviewed; no costs were invented.");
  }
  const run = await waitForRun();
  if (!stopping) await exportRun(run);
  if (!stopping && args.includes("--revise")) {
    const originalRunId = runId;
    const branch = await request(`/api/experiments/${encodeURIComponent(saved.definition.experimentId)}/branches`, {
      version: saved.definition.version,
      decisionText: "Use a $75 free-shipping threshold, with a $3.95 fee below it.",
      options: [{ label: "$75 threshold / $3.95 fee", thresholdCents: 7500, shippingFeeCents: 395 }],
    });
    const revision = await request(`/api/experiments/${encodeURIComponent(branch.definition.experimentId)}/runs`, {
      version: branch.definition.version, idempotencyKey: `walkthrough-revision-${randomUUID()}`,
    });
    runId = revision.runId;
    if (stopping) await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {});
    console.log(`Fresh live revision: ${runId}. Frozen panel/conditions preserved; baseline is rerun.`);
    const revisedRun = await waitForRun();
    if (!stopping) await exportRun(revisedRun, originalRunId);
  }
  if (stopping) console.error("Walkthrough cancelled.");
}

try {
  await main();
} catch (error) {
  if (!(error instanceof WalkthroughCancelled)) throw error;
  console.error(error.message);
  process.exitCode = 130;
}
