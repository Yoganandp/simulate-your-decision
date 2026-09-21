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

The default is a bounded 63-stakeholder panel: 32 customers, 22 employees across
leadership/management/frontline, five suppliers and four resellers. It samples business
perspectives, not every source record. Two options and three rounds plan 378 actor calls,
limited to two concurrent requests. The UI discloses the attempt budget and 120-minute
hard stop (not an ETA). Preparation and exploration make no inference calls.
This full panel can take an hour or more. Use **Recent simulations** when exploring
saved work rather than starting another run.

The **Stakeholder network** brings back the original node-and-link view and side
inspector inside the Copilot canvas. Drag to pan, zoom, then hover, focus or tap a
person. Open **Find and filter people** to search or filter. Switch options and
rounds, or follow live updates; node positions stay stable.
**Results** leads with a summary and compact change cards. Expand the money,
operational trade-offs, round trends and stakeholder responses when needed.
Every saved value links to its evidence. Download a decision brief for the same
cross-business view. Dotted spokes show sample-business membership, not influence;
solid graph links show saved operational requests or declared model relationships.
No satisfaction, morale or churn scores are fabricated.

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
