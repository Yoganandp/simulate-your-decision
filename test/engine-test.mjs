// Thin de-risking test: can a Copilot agent return clean structured JSON in-persona?
import { AiEngine, extractJson } from "../src/aiEngine.mjs";

const engine = new AiEngine({ concurrency: 2 });
const model = await engine.start();
console.log("Using model:", model);

const prompt = [
  "You are a warehouse associate at AdventureWorks Cycles. Tenure: 24 months. You are fast and experienced but skeptical of changes imposed from above.",
  "",
  "You are one agent in an operations simulation. Proposed workflow change:",
  '"Require two-person verification before every bicycle shipment leaves the warehouse."',
  "",
  "React strictly in character based on your warehouse experience.",
  "Output ONLY a JSON object (no prose, no markdown fence) with EXACTLY these keys:",
  "{",
  '  "prep_time_delta_pct": number,   // negative = faster drinks',
  '  "remake_rate_delta_pct": number, // negative = fewer remakes',
  '  "difficulty": "low"|"medium"|"high",',
  '  "confidence": number,            // 0..1',
  '  "reasoning": string,             // 2-3 sentences: WHY, from your bar experience',
  '  "concerns": string[],',
  '  "benefits": string[]',
  "}",
].join("\n");

const t0 = Date.now();
const raw = await engine.ask(prompt);
console.log(`\n--- RAW (${Date.now() - t0}ms) ---\n` + raw.slice(0, 1200));
const json = extractJson(raw);
console.log("\n--- PARSED ---\n" + JSON.stringify(json, null, 2));
console.log("\nPARSE_OK:", json && typeof json.prep_time_delta_pct === "number");

await engine.stop();
process.exit(0);
