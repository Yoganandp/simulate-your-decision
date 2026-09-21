import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/walkthrough.mjs", import.meta.url));
const stages = ["/api/provider/status", "/api/experiments/draft", "/api/experiments", "/api/experiments/fixture/runs"];
for (const stage of stages) {
  const preload = `
    const calls = [];
    const bundle = {
      definition: {experimentId:"fixture",version:1,scenarios:[],horizon:{steps:2}},
      inputs: {actors:[]}
    };
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === ${JSON.stringify(stage)}) process.emit("SIGINT");
      let body;
      if (path === "/api/session") body = {token:"fixture-token"};
      else if (path === "/api/provider/status") body = {ready:true};
      else if (path === "/api/experiments/draft" || path === "/api/experiments") body = bundle;
      else if (path === "/api/experiments/fixture/runs") body = {runId:"fixture-run"};
      else if (path === "/api/runs/fixture-run/cancel") body = {status:"cancelled"};
      else throw new Error("Unexpected request: " + path);
      return new Response(JSON.stringify(body), {status:200,headers:{"Content-Type":"application/json"}});
    };
    process.on("exit", () => console.log("REQUESTS=" + JSON.stringify(calls)));
  `;
  const child = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(preload)}`,
    script, "--model", "fixture-model", "--fulfillment-cost", "5.00", "--labor-rate", "24.00",
  ], { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 130, `${stage}: ${child.stderr}`);
  const calls = JSON.parse(child.stdout.match(/REQUESTS=(.*)/)[1]);
  const expected = ["/api/session", ...stages.slice(0, stages.indexOf(stage) + 1)];
  if (stage.endsWith("/runs")) expected.push("/api/runs/fixture-run/cancel");
  assert.deepEqual(calls, expected, "Cancellation must prevent later preparation and new inference.");
}
console.log("Walkthrough cancellation tests passed without network or inference.");
