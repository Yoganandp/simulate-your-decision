# Decision Studio

Decision Studio simulates how a bike company’s customers, employees, suppliers, and
resellers may react to a business decision over several rounds. It runs locally using
the user’s choice of:

- GitHub Copilot CLI
- Claude Code
- Codex CLI

The business data is the public AdventureWorks sample from
[`microsoft/sql-server-samples`](https://github.com/microsoft/sql-server-samples).
No private Microsoft repositories, feeds, services, credentials, or internal APIs are used.

## Quick start

Requirements: Node.js 18+ and at least one supported AI CLI installed and signed in.

```bash
npm run setup
npm run serve
```

`npm run setup` asks which installed AI CLI to use, verifies its login with a tiny live
request, downloads the pinned public dataset, and saves the local choice in the ignored
file `config/ai-provider.json`.

Open <http://localhost:5050>.

There are no npm dependencies and no API keys stored by this project. Each CLI reuses its
own existing authentication.

## Non-interactive setup

An AI assistant or install script can choose the provider directly:

```bash
npm run setup -- --provider copilot
npm run setup -- --provider claude
npm run setup -- --provider codex
```

Optional flags:

```bash
npm run setup -- --provider claude --model sonnet
npm run setup -- --provider codex --provider-only
npm run setup -- --data-only
npm run setup -- --provider copilot --skip-provider-check
```

At runtime, `AI_PROVIDER` and `AI_MODEL` override the saved config. Provider-specific
executable overrides are `COPILOT_CLI_PATH`, `CLAUDE_CLI_PATH`, and `CODEX_CLI_PATH`.

## Install and sign in to an AI CLI

| Provider | Install | Sign in |
| --- | --- | --- |
| GitHub Copilot CLI | [Official setup](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli) | Run `copilot`, then `/login` |
| Claude Code | [Official setup](https://code.claude.com/docs/en/setup) | `claude auth login` |
| Codex CLI | [Official setup](https://developers.openai.com/codex/cli) | `codex login` |

If setup says a credential is rejected, sign out and back in with that CLI, then rerun
`npm run setup`.

## Exact public dataset

The installer downloads the same AdventureWorks records used by this project from public
commit:

`1ab31bc560415b570d57bb5ff9896f4698891321`

It uses the public data-warehouse and OLTP CSVs for:

- 18,484 customers and their demographics
- 60,398 internet-sales lines
- products and product categories
- employees and departments
- vendors and purchase orders
- resellers and sales territories

Every file is SHA-256 verified against `scripts/fetch-data.mjs`. The upstream sample is
MIT-licensed; see `THIRD_PARTY_NOTICES.md`. These are fictional sample records, not real
people.

## How it works

1. `loadAdventureWorks.mjs` and `loadOrg.mjs` turn the public CSVs into grounded customer,
   employee, vendor, and reseller personas.
2. `aiEngine.mjs` sends tool-less/read-only non-interactive prompts through the selected CLI.
3. Personas react in character and see neighboring reactions in later rounds.
4. A measurement pass converts reactions into business metrics and a grounded revenue/profit
   estimate.
5. The browser streams each response and displays the rationale, outcome, and alternatives.

## Useful commands

```bash
npm test                 # provider-independent unit and scenario smoke tests
npm run check:provider   # live login/provider check
npm run data             # rebuild customer segments
npm run overview         # rebuild business overview
npm run simulate         # terminal simulation
npm run report           # render out/demo.html
```

Outputs are directional estimates and vary by model. They are for exploring decisions, not
guaranteed forecasts.
