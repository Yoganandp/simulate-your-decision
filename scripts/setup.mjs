import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AiEngine, PROVIDERS, detectInstalledProviders } from "../src/aiEngine.mjs";
import { fetchData } from "./fetch-data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_DIR = join(ROOT, "config");
const CONFIG_FILE = join(CONFIG_DIR, "ai-provider.json");
const args = process.argv.slice(2);
const valueOf = (name) => {
  const exact = args.indexOf(name);
  if (exact >= 0) return args[exact + 1];
  const prefixed = args.find((arg) => arg.startsWith(name + "="));
  return prefixed ? prefixed.slice(name.length + 1) : null;
};
const has = (name) => args.includes(name);

async function chooseProvider() {
  const requested = valueOf("--provider") || process.env.AI_PROVIDER;
  if (requested) return requested.toLowerCase();
  const installed = detectInstalledProviders();
  if (!installed.length) {
    throw new Error("No supported AI CLI is installed. See README.md for install links.");
  }
  if (installed.length === 1) return installed[0].id;
  if (!stdin.isTTY) {
    throw new Error(`Choose a provider: npm run setup -- --provider ${installed.map((x) => x.id).join("|")}`);
  }
  console.log("\nChoose the AI CLI that will run the simulation:");
  installed.forEach((item, index) => console.log(`  ${index + 1}) ${item.label}`));
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`Selection [1-${installed.length}]: `);
  rl.close();
  const selected = installed[Number(answer) - 1];
  if (!selected) throw new Error("Invalid provider selection.");
  return selected.id;
}

async function configureProvider() {
  const provider = await chooseProvider();
  if (!PROVIDERS[provider]) throw new Error(`Unknown provider "${provider}". Use copilot, claude, or codex.`);
  const model = valueOf("--model") || process.env.AI_MODEL || null;
  const installed = detectInstalledProviders().find((item) => item.id === provider);
  if (!installed) {
    throw new Error(`${PROVIDERS[provider].label} is not installed. Install it from ${PROVIDERS[provider].installUrl}`);
  }

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ provider, model }, null, 2) + "\n");
  console.log(`\nSelected ${PROVIDERS[provider].label}${model ? ` (${model})` : ""}.`);

  if (!has("--skip-provider-check")) {
    const engine = new AiEngine({ provider, model, concurrency: 1 });
    try {
      await engine.start();
      const response = await engine.ask("Reply with exactly READY and nothing else.", { timeout: 120000, retries: 0 });
      if (!/\bREADY\b/i.test(response)) throw new Error(`Unexpected response: ${response.slice(0, 160)}`);
      console.log("AI login verified.");
    } catch (error) {
      console.error(`\n${error.message}`);
      console.error(PROVIDERS[provider].login);
      console.error("After signing in, rerun `npm run setup`.");
      process.exitCode = 1;
      return false;
    }
  }
  return true;
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) throw new Error(`Node.js 18+ is required; found ${process.version}.`);

  if (!has("--data-only")) {
    const configured = await configureProvider();
    if (!configured) return;
  }
  if (!has("--provider-only")) await fetchData();
  console.log("\nSetup complete. Run `npm run serve`, then open http://localhost:5050");
}

main().catch((error) => { console.error(`\nSetup failed: ${error.message}`); process.exit(1); });
