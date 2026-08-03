# Decision Studio setup for GitHub Copilot CLI

When asked to set up or run this project:

1. Check `node -v` and `copilot --version`; help install Node.js 18+ if needed.
2. Run `npm run setup -- --provider copilot`.
3. If authentication is required, help the user run `copilot` and `/login`, then rerun setup.
4. Start `npm run serve` and keep it running.
5. Tell the user to open `http://localhost:5050`.

Verify `http://localhost:5050/api/health` before reporting success.
