# Start here

Install Node.js 20.19+ (20.x) or 22.12+ and authenticate GitHub Copilot CLI. Select an explicit model ID
available to your account, preferably MAI-Code; do not assume a display name is an ID.

```bash
npm ci
npm run setup -- --provider copilot --model YOUR_AVAILABLE_MODEL_ID
npm run serve
```

Open <http://localhost:5050> for the Copilot-style conversation and describe two options:

> Compare free shipping over $50 with free shipping over $75.
> Charge $7.95 below either threshold.

The app prepares and saves the comparison, filling missing costs and operational inputs
with labeled exploratory presets. There is no setup questionnaire. Select **Run
simulation** in the inline card, or **Expand** to explore it full-screen.

Hover, focus, or tap a person in the network to inspect their simulated choices.
Switch options and rounds, or follow the live updates. Open **Outcomes** for the
comparison and download a decision brief. The people view groups the sample panel by
role; it does not invent relationship links when the frozen model has no graph edges.

History survives a refresh. Replay uses saved actions without inference; Cancel stops
work explicitly. Results are simulated, unweighted panel outcomes over purchase
opportunities, not annual forecasts or observed customer behavior.

The conversation requests `mai-code-1.1-flash` through your existing Copilot login;
it does not silently substitute another model. This is a local Copilot-style prototype,
not an embedded or deployed M365 Copilot app. Its conversational parser supports
shipping thresholds and fees, not arbitrary business decisions.

The detailed setup, custom model configuration, policy revisions and editable brief
remain at <http://localhost:5050/advanced>. The older exploratory interface remains at
<http://localhost:5050/legacy>. Its heuristic
membership/retail outputs are separate from the shipping experiment workflow.

The official Copilot SDK uses your existing Copilot login. A separate personal GitHub
login can be used for repository access; no separate MAI API key is required.

See [README.md](README.md) for persistence, model setup, API, commands, and limitations.
