# Decision Studio agent instructions

When Codex is asked to set up or run this project:

1. Check `node -v` and `codex --version`.
2. Run `npm run setup -- --provider codex`.
3. If authentication fails, run `codex login`, then rerun setup.
4. Start `npm run serve` and keep it running.
5. Tell the user to open `http://localhost:5050`.

For other automation, pass the matching provider explicitly:
`copilot`, `claude`, or `codex`.

Do not add API keys or use private Microsoft repositories, feeds, services, or internal data.
The installer downloads a pinned, SHA-256-verified public AdventureWorks sample from GitHub.
