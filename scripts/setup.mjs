import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AiEngine, PROVIDERS, detectInstalledProviders, getConfiguredProvider, preflightProvider } from "../src/aiEngine.mjs";
import { fetchData } from "./fetch-data.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_DIR = join(ROOT, "config");
const CONFIG_FILE = join(CONFIG_DIR, "ai-provider.json");
const args = process.argv.slice(2);
const valueOf = (name) => {
  const exact = args.indexOf(name);
  if (exact >= 0) {
    if (!args[exact + 1] || args[exact + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
    return args[exact + 1];
  }
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
  const saved = getConfiguredProvider();
  const model = valueOf("--model") || process.env.AI_MODEL || (saved.provider === provider ? saved.model : null);
  const installed = detectInstalledProviders().find((item) => item.id === provider);
  if (!installed) {
    throw new Error(`${PROVIDERS[provider].label} is not installed. Install it from ${PROVIDERS[provider].installUrl}`);
  }
  if (provider !== "copilot") console.log(PROVIDERS[provider].login);

  if (!has("--skip-provider-check")) {
    let engine;
    try {
      if (model) {
        const status = await preflightProvider({ provider, model });
        if (!status.ready) {
          console.error(status.error.message);
          if (status.error.category === "authentication") console.error(PROVIDERS[provider].login);
          process.exitCode = 1;
          return false;
        }
        console.log(`Explicit model preflight succeeded (${status.cliVersion}).`);
        console.log(status.resolvedModel
          ? `CLI-reported model: ${status.resolvedModel}.`
          : "Model identity remains unresolved, not independently verified.");
      } else if (provider === "copilot") {
        console.log("Copilot selected without model verification. H0 requires an explicit --model and SDK preflight using the existing Copilot login.");
      } else {
        engine = new AiEngine({ provider, concurrency: 1 });
        await engine.start();
        const response = await engine.ask("Reply with exactly READY and nothing else.", { timeout: 60000, retries: 0 });
        if (response.trim() !== "READY") throw new Error("The provider did not return the expected readiness response.");
        console.log("Legacy provider request succeeded. H0 still requires an explicit --model and preflight.");
      }
    } catch (error) {
      console.error(`\n${error.message}`);
      if (error.category === "authentication") console.error(PROVIDERS[provider].login);
      console.error("Correct the provider configuration and rerun `npm run setup`.");
      process.exitCode = 1;
      return false;
    } finally {
      await engine?.stop();
    }
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify({ provider, model }, null, 2) + "\n");
  console.log(`\nSelected ${PROVIDERS[provider].label}${model ? ` (${model})` : ""}.`);
  if (has("--skip-provider-check")) console.log("Provider access and model identity have not been verified.");
  return true;
}

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22;
  if (!supported || process.versions.node.includes("-")) {
    throw new Error(`Node.js ^20.19.0 || >=22.12.0 is required by the Copilot SDK; found ${process.version}.`);
  }

  if (!has("--data-only")) {
    const configured = await configureProvider();
    if (!configured) return;
  }
  if (!has("--provider-only")) await fetchData();
  console.log("\nSetup complete. Run `npm run serve`, then open http://localhost:5050");
}

main().catch((error) => { console.error(`\nSetup failed: ${error.message}`); process.exit(1); });
