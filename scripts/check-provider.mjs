import { getConfiguredProvider, preflightProvider } from "../src/aiEngine.mjs";

const args = process.argv.slice(2);
const valueOf = (name) => {
  const index = args.indexOf(name);
  if (index >= 0) {
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value.`);
    return args[index + 1];
  }
  return args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1);
};
try {
  const configured = getConfiguredProvider();
  const provider = valueOf("--provider") || configured.provider;
  const model = valueOf("--model") || (provider === configured.provider ? configured.model : null);
  const timeout = Number(valueOf("--timeout") || 60000);
  const status = await preflightProvider({ provider, model, timeout, transport: valueOf("--transport") || "sdk" });
  if (args.includes("--json")) console.log(JSON.stringify(status, null, 2));
  else if (status.ready) {
    console.log(`${status.provider} accepted the explicit model request "${status.requestedModel}" (${status.cliVersion}).`);
    console.log(status.resolvedModel
      ? `CLI-reported model: ${status.resolvedModel}.`
      : "Model identity is unresolved; it was not independently verified.");
  } else {
    console.error(status.error.message);
    if (provider === "copilot") console.error("Run with --provider copilot --model <exact-model-id>. The SDK uses the existing Copilot login; a model catalog can be incomplete, so the explicit schema preflight is authoritative.");
  }
  if (!status.ready) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
