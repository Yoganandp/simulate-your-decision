# Decision Studio setup

When asked to set up or run this project:

1. Check `node -v` and `copilot --version`.
2. Run `npm run setup -- --provider copilot`.
3. If authentication is required, help the user run `copilot` and `/login`, then rerun setup.
4. Start `npm run serve` and keep it running.
5. Tell the user to open `http://localhost:5050`.

Do not add API keys or use private Microsoft repositories, feeds, services, or internal data.
The installer downloads a pinned, SHA-256-verified public AdventureWorks sample from GitHub.
