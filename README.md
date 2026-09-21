# Copilot Simulations

Evaluate a shipping-policy decision with simulated stakeholders, inspect the evidence,
and export a decision brief. This is a local prototype, not an announced Microsoft
product or a validated forecast.

The H0 workflow extends Decision Studio without a framework rewrite: a small Node.js
service, browser interface, and the official GitHub Copilot SDK.

## Start

Requirements: Node.js 20.19+ (20.x) or 22.12+ and an installed, authenticated
[GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli).
The SDK uses the signed-in Copilot harness and selects an explicit session model.
GitHub CLI authentication for cloning/pushing is separate: the repository account
does not have to be the account used for Copilot inference.

```bash
npm ci
npm run setup -- --provider copilot --model YOUR_AVAILABLE_MODEL_ID
npm run serve
```

Open <http://localhost:5050>. Setup downloads the checksum-verified sample dataset.
Use the exact model ID available to your account; the application prefers an explicitly
configured MAI-Code model but does not invent an ID or silently substitute another model.
The SDK discovers available models at runtime; there is no separate MAI endpoint or API
key to provision. A catalog can be incomplete: an explicit schema-conforming request
and its reported model identity are the readiness check, not catalog membership alone.
The provider preflight makes a small structured request and reports requested identity,
CLI version, and whether resolved identity is actually exposed. An unavailable model or
authentication failure prevents a new experiment from running.

Local settings are stored in ignored `config/ai-provider.json`. The conversational
preview explicitly requests `mai-code-1.1-flash`; it does not silently substitute another
model. The detailed workbench at `/advanced` supports a different explicit model and
reviewing it before freezing an experiment. Never put tokens in a
proposal, source snapshot, config example, or git commit.

## Complete workflow

1. Start in the Copilot-style conversation and describe two shipping options naturally.
2. The app prepares and saves the paired comparison, automatically applying labeled
   missing-data presets. No assumption questionnaire or model configuration is required.
3. Select **Run simulation** in the inline card. Expand it into a full-screen workspace
   without navigating away from the conversation.
4. Follow the live people graph, hover/focus/tap a stakeholder, and select an option
   or round to inspect its saved choices. Only committed rounds contribute to outcomes;
   a response that is still being validated is not a completed decision.
5. Compare outcomes, inspect their supporting events, replay saved actions and download
   a decision brief. Recent simulations and refresh reopen saved work without inference.

The detailed workbench at `/advanced` retains editable preparation, objective/guardrail
controls, policy revisions, custom model selection, and the editable Markdown brief.

Example:

> Option A: free shipping over $50, otherwise $7.95.
> Option B: free shipping over $75, otherwise $3.95.

The inline card shows the two interpreted options before inference starts. These policy
values are **assumptions**, not historical AdventureWorks policy. Conversational
interpretation uses a bounded shipping-policy grammar, not a general-purpose chat model.
Unsupported policy types are rejected instead of silently converted to a shipping
simulation. The interface is a local Copilot-style prototype, not a deployed M365 app.

## What the results mean

The conversation uses a preset sample panel and three rounds; the actual people and
counts appear in the inline card. The advanced workbench defaults to 12 sample
customers, two operational employees, one supplier and one reseller, with configurable
counts subject to eligible source coverage.
Results are unweighted panel transactions, not full-company estimates.

A **shopping cycle** is one modeled purchase opportunity per eligible customer, not a
day, week, or year. The default is three cycles. There is no automatic annualization,
churn estimate, or claim of an individually validated digital twin.

Money is stored as integer USD cents. The ledger calculates:

```text
contribution = product revenue + shipping revenue
             - cost of goods sold - shipping cost - incremental labor cost
```

Contribution is not net profit. The conversational path fills missing fulfillment and
labor costs with clearly labeled exploratory presets ($5 per order and $24 per hour).
These are not observed business facts or user-reviewed values. The advanced workbench
and existing draft API still preserve unknown costs; unknown material costs block a
financial recommendation. Sentiment and narratives never alter the ledger. Operational
actions have role-specific limits, and replenishment cannot arrive before its lead time.

Options must match on snapshot, panel, starting state, graph, opportunity schedule,
domain/metric versions, horizon, and model configuration before comparison. Incomplete
options, unknown objectives, or violated guardrails cannot become an unqualified winner.
A baseline is freshly simulated for each revision; this prototype does not reuse an
unmatched baseline or promise deterministic live model responses.

## Data and provenance

The importer uses Microsoft's AdventureWorks **sample business data** from
[`microsoft/sql-server-samples`](https://github.com/microsoft/sql-server-samples) at
commit `1ab31bc560415b570d57bb5ff9896f4698891321`.
`scripts/fetch-data.mjs` verifies pinned SHA-256 hashes. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for attribution and upstream licensing.

Snapshots preserve bounded source context, row/field evidence, date coverage, hashes,
and explicit unknowns. Source-backed facts and synthetic assumptions are distinct.
Operational stock, panel capacity, future opportunities, and unavailable costs must not
be mistaken for observed business records. Customer-to-customer influence is off in the
shipping adapter. Actor prompts contain only that actor's permitted observations.

The new importer/domain boundary lives in `src/sim/domain.mjs`; a future read-only
connector must produce the same frozen, evidence-linked contract. Fabric, Dynamics,
Power BI, additional decision domains, and M365 Copilot deployment are **not delivered
connectors**.

## Persistence and runtime

Ignored `.simulation-data/` is the default local application-data root; set
`SIMULATION_DATA_DIR` to use another directory. Keep that directory to retain experiments,
immutable versions, snapshots, debug responses, event logs, runs, and briefs. It can
contain imported business information if you later extend the importer; protect it
accordingly. Do not commit it.

Events are persisted before publication. A round becomes visible only after its commit
event. The committed log, not an accelerator snapshot, is authoritative. After restart,
previously active work is marked interrupted; inference is not automatically resumed.

Refreshing a viewer reopens the run and replays SSE events; it does not start inference.
Run starts use idempotency keys. Closing a viewer does not cancel persistent work.
Cancellation prevents scheduling and late commits and requests runtime shutdown.
If termination cannot be confirmed, a persistent `runtime-block.json` in the application
data root blocks new inference. Do not remove it until the owned runtime processes have
been confirmed stopped. Failures and configured deadlines also stop a run.
Every attempted call, including a repair or retry, counts toward the attempt budget.
The default configuration has concurrency four, a 320-attempt ceiling, 60-second call
deadline, and 15-minute run deadline.

**Replay** re-reduces saved accepted actions and verifies their events/state without
calling a model. **Rerun** makes fresh model requests and may produce different behavior
even with the same seeded mechanical inputs. Usage and resolved model identity remain
unavailable when the CLI does not expose them; there is no fabricated invoice estimate.

The service binds to loopback only, checks Host and Origin, and requires a local session
token for JSON writes. It is not a multiuser service and should not be exposed through a
public tunnel. Stakeholder inference is tool-less; prompts can still be sent to the
configured cloud provider.

## API

The browser obtains a token from `GET /api/session` and sends `X-Simulation-Token` and
`Content-Type: application/json` on writes.

| Route | Purpose |
| --- | --- |
| `POST /api/experiments/conversation` | Interpret two shipping options from `{decisionText}` with labeled automatic presets |
| `POST /api/experiments/draft` | Prepare reviewable shipping inputs |
| `POST /api/experiments` | Save an immutable validated version |
| `GET /api/experiments` | History |
| `GET /api/experiments/:id` | Definition, versions, and run references |
| `POST /api/experiments/:id/runs` | Idempotent run start |
| `GET /api/runs/:id` | Status and committed results |
| `GET /api/runs/:id/events` | Reconnectable SSE; `Last-Event-ID` or `after` cursor |
| `POST /api/runs/:id/cancel` | Explicit cancellation |
| `POST /api/runs/:id/replay` | Exact accepted-action replay |
| `POST /api/experiments/:id/branches` | Reviewed policy revision |
| `POST /api/runs/:id/brief` | Persist a metric-linked Markdown brief |
| `GET /api/evidence/:id` | Source evidence |
| `GET /api/provider/status` | Safe explicit-model preflight status |
| `POST /api/experiments/:id/timing` | Workflow timing event |

## Commands and legacy boundary

```bash
npm test
npm run test:simulations
npm run check:provider -- --provider copilot --model YOUR_AVAILABLE_MODEL_ID
npm run setup:data
npm run walkthrough -- --run YOUR_COMPLETED_RUN_ID
```

For a small live walkthrough and one revision, pass an available model and explicitly
declared example costs:

```bash
npm run walkthrough -- --model YOUR_AVAILABLE_MODEL_ID --fulfillment-cost 5.00 --labor-rate 24.00 --revise
```

This uses five actors and two shopping cycles, not the default full panel. The $5/order
and $24/hour values above are illustrative assumptions, not observed costs. Omitting
them retains unknown costs. The script stores elapsed-time records, replay results and
available briefs under ignored `out/`; it makes no active-work or hours-saved claim.

The original exploratory interface is preserved at <http://localhost:5050/legacy>;
`npm run simulate`, `npm run report`, `npm run data`, and `npm run overview` remain
available. Legacy membership/retail commands are not migrated adapters and their
heuristic outputs cannot be compared with shipping-ledger results. The legacy live
scenario no longer converts an analyst gross-margin index into a margin-rate adjustment
or displays that as profit; missing responses cannot establish convergence.

New responsibilities are ordinary modules under `src/sim/`: domain mechanics,
persistence, run orchestration, local API, and deterministic brief rendering.
`src/aiEngine.mjs` remains the provider-neutral boundary. Other providers are retained
for legacy compatibility, not evidence of equivalent behavioral quality.
Legacy Claude/Codex calls isolate configuration and therefore require environment
credentials, not saved CLI logins. Claude accepts `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, or `ANTHROPIC_AUTH_TOKEN`; Codex accepts `CODEX_API_KEY`
or its `OPENAI_API_KEY` alias. This does not change H0's existing Copilot login flow.

## Evaluation boundaries

Mechanical fixtures exercise arithmetic, action validity, privacy, inventory, timing,
replay, comparison invariants, error handling, cancellation, and reconnect behavior.
Recorded or synthetic actions are **not behavioral ground truth**.

Workflow timestamps distinguish preparation/review/export from model waiting where
available. They do not by themselves measure hours saved. A productivity claim requires
a separately timed, comparable manual task; a builder-only walkthrough must be labeled
single-user. No historical intervention accuracy, causal effect, population prediction
interval, or measured productivity improvement is claimed.

The release checklist additionally requires a recorded live experiment with the chosen
model on the demo machine, a revision, replay, cancellation, evidence inspection, and
brief export. Any local walkthrough records belong under ignored `out/`, not in source.
