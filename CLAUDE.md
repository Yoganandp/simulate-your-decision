# Decision Studio setup for Claude Code

When asked to set up or run this project:

1. Check `node -v` and `claude --version`; use Node.js 20.19+ (20.x) or 22.12+.
2. Run `npm ci`, then `npm run setup -- --provider claude` for legacy scenarios. The shipping workflow uses the Copilot SDK and an explicit available Copilot model.
3. If authentication fails, run `claude auth login` (or log out and back in), then rerun setup.
4. Start `npm run serve` and keep it running.
5. Tell the user to open `http://localhost:5050`.

Verify `http://localhost:5050/api/health` before reporting success.
