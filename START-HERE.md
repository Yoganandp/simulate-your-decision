# Start here

## Give this folder to your AI assistant

Tell Copilot, Claude, or Codex:

> Set up Decision Studio with your own CLI and run it.

The repository instructions tell each assistant to select itself:

```bash
# GitHub Copilot CLI
npm run setup -- --provider copilot

# Claude Code
npm run setup -- --provider claude

# Codex CLI
npm run setup -- --provider codex
```

Then it should run:

```bash
npm run serve
```

Open <http://localhost:5050>.

## Run it yourself

```bash
npm run setup
npm run serve
```

Setup asks which installed AI CLI to use, verifies login, and downloads the SHA-256-verified
public AdventureWorks sample data. No private Microsoft dependency or project API key is
required.
