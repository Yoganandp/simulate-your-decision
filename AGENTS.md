# Decision Studio agent instructions

When Codex is asked to set up or run this project:

1. Check `node -v` and `codex --version`; help install Node.js 18+ if needed.
2. Run `npm run setup -- --provider codex`.
3. If authentication fails, run `codex login`, then rerun setup.
4. Start `npm run serve` and keep it running.
5. Tell the user to open `http://localhost:5050`.

Verify `http://localhost:5050/api/health` before reporting success.
