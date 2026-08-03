# Decision Studio

Decision Studio lets you describe a business decision and watch simulated customers,
employees, suppliers, and resellers react over several rounds. It runs locally with
GitHub Copilot CLI, Claude Code, or Codex CLI and uses the public AdventureWorks sample
dataset.

## Easiest setup: hand it to your AI agent

1. Clone or download this repository.
2. Open a terminal in the project folder.
3. Start the AI CLI you already use: `copilot`, `claude`, or `codex`.
4. Paste this:

> Set up and run this project using your own CLI. Check the prerequisites, run the
> setup for your provider, start the server, verify it is healthy, and give me the
> local URL.

The repository includes provider-specific instructions, so the agent chooses the right
setup command automatically. When it finishes, open <http://localhost:5050>.

## Manual setup

Requirements: Node.js 18+ and one supported AI CLI installed and signed in.

```bash
npm run setup
npm run serve
```

Setup asks which installed AI CLI to use, verifies the sign-in, downloads the dataset,
and remembers the provider locally.

| Provider | Install | Sign in |
| --- | --- | --- |
| GitHub Copilot CLI | [Official setup](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) | Run `copilot`, then `/login` |
| Claude Code | [Official setup](https://code.claude.com/docs/en/setup) | `claude auth login` |
| Codex CLI | [Official setup](https://developers.openai.com/codex/cli) | `codex login` |

## What to type into Decision Studio

Write the change as a concrete decision, not as a general question. Include numbers and
who is affected when you know them.

**Template**

> Starting [when], change [policy, price, product, or process] from [current state] to
> [new state] for [affected group]. The goal is [goal]. Keep [important constraint].

**Examples**

- Starting next quarter, raise the free-shipping threshold from $50 to $75 for online
  orders. Keep standard shipping at $7.95 and try to improve margin without increasing
  customer churn.
- Launch a $49 annual membership that includes free shipping and 10% off purchases.
- Increase bike prices by 8% in every region, while leaving accessories and shipping
  unchanged.
- Open a flagship store in Seattle and fund it by reducing online discounts.

Paste the decision into the **Compose** box and press the arrow. You can also click a
preset to see the expected format.

## Dataset

Setup downloads selected AdventureWorks CSV files from
[`microsoft/sql-server-samples`](https://github.com/microsoft/sql-server-samples) at
commit `1ab31bc560415b570d57bb5ff9896f4698891321`.

The data includes 18,484 sample customers, 60,398 internet-sales lines, products,
employees, vendors, resellers, and territories. Downloads are SHA-256 verified by
`scripts/fetch-data.mjs`. See `THIRD_PARTY_NOTICES.md` for the upstream MIT license.

## Useful commands

```bash
npm test
npm run check:provider
npm run setup:data
npm run simulate
npm run report
```

Outputs are directional estimates for exploring decisions, not guaranteed forecasts.
