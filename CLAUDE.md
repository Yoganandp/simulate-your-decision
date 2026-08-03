# Decision Studio setup for Claude Code

When asked to set up or run this project:

1. Check `node -v` and `claude --version`.
2. Run `npm run setup -- --provider claude`.
3. If authentication fails, run `claude auth login` (or log out and back in), then rerun setup.
4. Start `npm run serve` and keep it running.
5. Tell the user to open `http://localhost:5050`.

Do not add API keys or use private Microsoft repositories, feeds, services, or internal data.
The installer downloads a pinned, SHA-256-verified public AdventureWorks sample from GitHub.
