import { AiEngine } from "../src/aiEngine.mjs";

const engine = new AiEngine({ concurrency: 1 });
try {
  const model = await engine.start();
  const response = await engine.ask("Reply with exactly READY and nothing else.", { timeout: 120000, retries: 0 });
  if (!/\bREADY\b/i.test(response)) throw new Error(`Unexpected response: ${response.slice(0, 160)}`);
  console.log(`${engine.describe()} is ready (${model}).`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
