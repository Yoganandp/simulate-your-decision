# Start here

Install Node.js 20.19+ (20.x) or 22.12+ and authenticate GitHub Copilot CLI. Select an explicit model ID
available to your account, preferably MAI-Code; do not assume a display name is an ID.

```bash
npm ci
npm run setup -- --provider copilot --model YOUR_AVAILABLE_MODEL_ID
npm run serve
```

Open <http://localhost:5050> and describe a shipping-policy change:

> Raise the free-shipping threshold from $50 to $75. Keep shipping at $7.95.
> Compare contribution over three shopping cycles.

Prepare the draft, review the baseline/options and every material assumption, then save
and run. Missing costs remain unknown; supply reviewed values before expecting a
contribution comparison. Inspect the underlying events and sample-record evidence,
revise an option, and export a decision brief.

History survives a refresh. Replay uses saved actions without inference; Cancel stops
work explicitly. Results are simulated, unweighted panel outcomes over purchase
opportunities, not annual forecasts or observed customer behavior.

The older exploratory interface remains at <http://localhost:5050/legacy>. Its heuristic
membership/retail outputs are separate from the shipping experiment workflow.

The official Copilot SDK uses your existing Copilot login. A separate personal GitHub
login can be used for repository access; no separate MAI API key is required.

See [README.md](README.md) for persistence, model setup, API, commands, and limitations.
