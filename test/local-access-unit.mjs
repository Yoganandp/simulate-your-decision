import assert from "node:assert/strict";
import { createLocalAccess, setLocalHeaders } from "../src/localAccess.mjs";

const access = createLocalAccess();
const request = (headers = {}, method = "GET") => ({
  method, headers: { host: "localhost:5050", ...headers }, socket: { localPort: 5050 },
});
assert.equal(access.authorize(request()), null);
assert.equal(access.authorize(request({ host: "127.0.0.1:5050" })), null);
assert.equal(access.authorize(request({ host: "[::1]:5050" })), null);
assert.match(access.authorize(request({ host: "attacker.example:5050" })), /loopback/);
assert.match(access.authorize(request({ host: "localhost:5051" })), /port/);
assert.match(access.authorize(request({ host: "localhost:5050@attacker.example" })), /Host/);
assert.match(access.authorize(request({ origin: "https://attacker.example" })), /Cross-origin/);
assert.match(access.authorize(request({ origin: "null" })), /Cross-origin/);
assert.match(access.authorize(request({ "sec-fetch-site": "cross-site" })), /Cross-site/);
assert.match(access.authorize(request({}, "POST")), /token/);
assert.match(access.authorize(request({ "x-simulation-token": "x".repeat(64) }, "POST")), /token/);
assert.match(access.authorize(request({ "x-simulation-token": access.token }, "POST")), /application\/json/);
assert.equal(access.authorize(request({
  "x-simulation-token": access.token,
  "content-type": "application/json; charset=utf-8",
  origin: "http://localhost:5050",
}, "POST")), null);
assert.notEqual(createLocalAccess().token, access.token);
const headers = new Map();
setLocalHeaders({ setHeader: (key, value) => headers.set(key, value) });
assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
assert.ok(!headers.get("Content-Security-Policy").includes("'unsafe-inline'"));
console.log("Local access tests passed.");
