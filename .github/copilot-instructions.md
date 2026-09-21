# Decision Studio setup for GitHub Copilot CLI

When asked to set up or run this project:

1. Check `node -v` and `copilot --version`; use Node.js 20.19+ (20.x) or 22.12+.
2. Run `npm ci`, then `npm run setup -- --provider copilot --model <available-model-id>`.
3. Use the existing Copilot login for SDK inference, independently of the GitHub account used for repository access. If authentication is required, help the user run `copilot login`, then rerun setup.
4. Start `npm run serve` and keep it running.
5. Tell the user to open `http://localhost:5050`.

Verify `http://localhost:5050/api/health` before reporting success.
