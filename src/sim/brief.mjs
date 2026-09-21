import { SimulationError } from "./store.mjs";
import { businessInsights } from "../../web/business-insights.js";

const clean = value => String(value ?? "").replace(/[\r\n]+/g, " ").replace(/[<>`[\]|]/g, "").slice(0, 180);
const reference = metric => `${metric.scenarioId}:${metric.metricId}`;
const display = metric => metric.value == null ? "unavailable" : `${metric.value} ${clean(metric.unit)}`;
const RESULT_METRICS = ["contribution", "purchases", "abandonmentRate", "stockouts"];

export function createBrief({ runId, status, manifest, results, comparison }) {
  if (status !== "completed" || !comparison || comparison.status === "incomplete" || !results.every(result => result.complete)
    || new Set(results.map(result => result.comparisonKey)).size !== 1) {
    throw new SimulationError("INCOMPLETE_RUN", "A brief requires complete comparable scenarios.", 409);
  }
  const { definition, inputs } = manifest, metricIds = [];
  const lines = [
    "# Simulation decision brief",
    "",
    "## Question and objective",
    `**User-provided decision (assumption, not a measured outcome):** ${clean(definition.decisionText)}`,
    `Objective: ${clean(definition.objective.direction)} calculated ${clean(definition.objective.metricId)}; unit: ${clean(definition.objective.unit)}; scope: ${clean(definition.objective.scope)}. Contribution is not net profit.`,
    "",
    "## Options and calculated outcomes",
    "The baseline and alternatives use the same frozen sample records, stakeholder panel, starting conditions and shopping-cycle horizon. Scenario policies and operational inputs are assumptions, not observed outcomes.",
    "",
  ];
  for (const scenario of definition.scenarios) {
    const result = results.find(item => item.scenarioId === scenario.scenarioId);
    if (!result) throw new SimulationError("INCOMPLETE_RUN", "Scenario results are missing.", 409);
    lines.push(`### ${clean(scenario.label)}${scenario.isBaseline ? " (baseline)" : ""}`);
    lines.push(`Policy input assumptions are recorded in scenario \`${scenario.scenarioId}\`; inspect the saved policy and its evidence before using these results.`);
    for (const metricId of new Set([definition.objective.metricId, ...RESULT_METRICS])) {
      const metric = result.metrics.find(item => item.metricId === metricId);
      if (!metric) continue;
      if (metric.value != null && !Number.isFinite(metric.value)) throw new SimulationError("INVALID_METRIC", "A stored metric is invalid.", 409);
      const id = reference(metric);
      metricIds.push(id);
      lines.push(`- ${clean(metricId)}: ${display(metric)} [metric: ${id}].${metric.value == null ? " Missing input coverage prevents a numerical conclusion." : ""}`);
    }
    lines.push("");
  }
  lines.push("## Interpretation and affected stakeholders");
  if (comparison.bestScenarioId && comparison.status === "complete") {
    const best = definition.scenarios.find(item => item.scenarioId === comparison.bestScenarioId);
    lines.push(`Best under the declared objective and constraints in this simulation: ${clean(best?.label || comparison.bestScenarioId)}. This is a simulated hypothesis, not a deployment recommendation.`);
  } else {
    lines.push("The comparison does not establish an unqualified preferred option. Review trade-offs, missing coverage and the declared constraints before deciding.");
  }
  lines.push("Customers select permitted purchase, deferral or abandonment actions. Operational actors can affect later cycles. Inspect committed actions and observations for individual impacts; generated explanations are not evidence of real people's thoughts.");
  const insights = businessInsights(manifest, results);
  lines.push("", "## Business perspectives (unweighted sample)");
  lines.push(insights.groups.map(group => `${group.count} ${group.label.toLowerCase()}`).join("; ") + ". These are sampled roles, not a whole-company forecast.");
  lines.push("Counts below are calculated from saved ledger events; inspect the named event types in each scenario.");
  lines.push("| Option | Customer orders | Work minutes scheduled | Capacity-blocked orders | Supply units scheduled / arrived | Reseller orders |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
  for (const scenario of insights.scenarios) {
    const value = id => scenario.values[id].value ?? "unknown";
    lines.push(`| ${clean(scenario.label)} | ${value("customerOrders")} | ${value("laborMinutes")} | ${value("capacityBlocked")} | ${value("unitsDispatched")} / ${value("unitsArrived")} | ${value("resellerOrders")} |`);
  }
  lines.push("Ledger basis: purchase (actor role), capacity_scheduled.laborMinutes, capacity_unavailable, replenishment_scheduled.quantity, replenishment_arrived.quantity. Satisfaction, morale and churn are not modeled.");
  lines.push("", "## Evidence, assumptions and limits");
  lines.push("AdventureWorks is sample business data. Synthetic preferences, operational costs and inferred relationships remain declared assumptions. Evidence identifiers, missing coverage, formulas and contributing ledger events are available in the saved experiment and metric records.");
  if (Array.isArray(inputs.assumptions) && inputs.assumptions.length) {
    lines.push(`Assumption references: ${inputs.assumptions.slice(0, 8).map(item => clean(item.assumptionId || item.id)).filter(Boolean).join(", ")}.`);
  }
  lines.push("Empirical validation is not established. Model variability has not been quantified by this run. Do not annualize shopping-cycle outcomes or interpret purchase abandonment as churn. Missing costs remain unknown.");
  if (definition.constraints.length) lines.push("Declared guardrails are reviewable decision assumptions, not observed business facts; their definitions and calculated pass/fail outcomes are preserved with the comparison.");
  lines.push("", "## Next step and live pilot");
  lines.push("Review the assumptions most relevant to the decision, revise a policy if needed, and rerun the baseline and alternatives. A controlled live pilot should measure fulfilled product and shipping revenue, actual goods, shipping and incremental labor costs, purchase abandonment, inventory constraints and repeat purchasing. Agree on guardrails before launch.");
  lines.push("", "## Provenance and workflow timing");
  lines.push(`Run: \`${runId}\`. Snapshot: \`${clean(definition.snapshotId)}\`. Source cutoff: \`${clean(definition.asOf)}\`.`);
  lines.push(`Provider: ${clean(manifest.provider)}. Requested model: \`${clean(manifest.requestedModel)}\`. Resolved identity: ${manifest.resolvedModel ? `\`${clean(manifest.resolvedModel)}\`` : "not exposed; unverified"}.`);
  lines.push("Saved accepted actions support deterministic replay; a fresh model rerun may differ. Workflow timestamps and explicitly reported active durations are recorded separately. These records do not establish time saved.");
  const markdown = lines.join("\n");
  if (markdown.split(/\s+/).length > 800) throw new SimulationError("BRIEF_LIMIT", "The deterministic brief exceeded its word limit.", 500);
  return { markdown, metricIds, generatedAt: new Date().toISOString() };
}
