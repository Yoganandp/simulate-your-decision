import * as domain from "./domain.mjs";
import { createStore, LIMITS, SimulationError, contentHash, publicError, redactDebug, safeId } from "./store.mjs";
import { RunManager, validateRunConfig } from "./runManager.mjs";

function objectBody(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new SimulationError("INVALID_BODY", "The request body contains unsupported fields.");
  }
  return value;
}

function body(req) {
  // A rejected request can still emit an incoming-stream error while its response closes.
  req.on("error", () => {});
  if (req.headers["content-type"] && !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"])) {
    req.resume();
    return Promise.reject(new SimulationError("CONTENT_TYPE", "Use an application/json request body.", 415));
  }
  const declared = req.headers["content-length"];
  if (declared != null && (!/^\d+$/.test(String(declared)) || Number(declared) > LIMITS.payloadBytes)) {
    req.resume();
    return Promise.reject(new SimulationError("PAYLOAD_LIMIT", "The request body exceeds the size limit.", 413));
  }
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("error", failed);
      req.removeListener("aborted", failed);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > LIMITS.payloadBytes) { fail(new SimulationError("PAYLOAD_LIMIT", "The request body exceeds the size limit.", 413)); return; }
      chunks.push(chunk);
    };
    const failed = () => fail(new SimulationError("REQUEST_ABORTED", "The request was interrupted.", 400));
    const end = () => {
      cleanup();
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
        resolve(value);
      } catch { reject(new SimulationError("INVALID_JSON", "The request must contain a JSON object.")); }
    };
    const timer = setTimeout(() => fail(new SimulationError("REQUEST_TIMEOUT", "The request body was not received in time.", 408)), 10000);
    timer.unref?.();
    req.on("data", data);
    req.once("end", end);
    req.once("error", failed);
    req.once("aborted", failed);
  });
}

function versionParam(value, optional = false) {
  if (optional && value == null) return undefined;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS.versions) throw new SimulationError("INVALID_VERSION", "Invalid experiment version.");
  return value;
}

function validateBundle(bundle) {
  const { definition, inputs } = objectBody(bundle, ["definition", "inputs"]);
  if (!definition || !inputs) throw new SimulationError("INVALID_EXPERIMENT", "An experiment definition and its reviewed inputs are required.");
  safeId(definition.experimentId, "experiment identifier");
  versionParam(definition.version);
  validateRunConfig(definition, inputs);
  try { domain.validateExperiment(definition, inputs); }
  catch { throw new SimulationError("INVALID_EXPERIMENT", "The experiment, evidence, policies or reviewed assumptions failed validation. Prepare and review a consistent draft."); }
  return { definition, inputs };
}

function validateDraftInput(input) {
  objectBody(input, ["decisionText", "title", "seed", "customerCount", "employeeCount", "supplierCount", "resellerCount", "cycles", "baseline", "options", "assumptions", "runConfig", "objective", "constraints"]);
  if (typeof input.decisionText !== "string" || !input.decisionText.trim() || input.decisionText.length > 10000
    || (input.title != null && (typeof input.title !== "string" || input.title.length > 180))) {
    throw new SimulationError("INVALID_DRAFT", "Provide a decision description within the allowed length.");
  }
  for (const key of ["customerCount", "employeeCount", "supplierCount", "resellerCount"]) {
    if (input[key] != null && (!Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > 48)) throw new SimulationError("INVALID_DRAFT", "Stakeholder counts must be bounded nonnegative integers.");
  }
  if (input.cycles != null && (!Number.isSafeInteger(input.cycles) || input.cycles < 1 || input.cycles > 6)) throw new SimulationError("INVALID_DRAFT", "The horizon must contain a supported number of shopping cycles.");
  if (input.options != null && (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > 2)) throw new SimulationError("INVALID_DRAFT", "Provide one or two shipping-policy alternatives.");
  return input;
}

function send(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(text);
}

export async function createSimulationApi({ root, engineFactory, preflight } = {}) {
  const store = await createStore({ root });
  let manager;
  try { manager = new RunManager({ store, engineFactory, preflight }); }
  catch (error) { store.close(); throw error; }
  const streams = new Set();
  const issuedDrafts = new Map();
  const draftLifetimeMs = 24 * 60 * 60 * 1000;
  let closed = false;
  let activeRequests = 0;

  function saveReviewed(bundle, serverRevision = false) {
    const validated = validateBundle(bundle);
    const key = `${validated.definition.experimentId}:${validated.definition.version}`;
    const bundleHash = contentHash(validated);
    const existing = store.experiments.get(validated.definition.experimentId)?.get(validated.definition.version);
    if (existing) {
      if (existing.bundleHash !== bundleHash) throw new SimulationError("IMMUTABLE_VERSION", "An existing experiment version cannot be changed.", 409);
      return store.saveExperiment(validated);
    }
    if (!serverRevision) {
      const issued = issuedDrafts.get(key);
      if (!issued || Date.now() - issued.createdAt > draftLifetimeMs) {
        throw new SimulationError("DRAFT_REQUIRED", "Prepare and review this draft again before saving. Unsaved drafts expire or are lost when the service restarts.", 409);
      }
      if (issued.bundleHash !== bundleHash) throw new SimulationError("DRAFT_CHANGED", "The submitted draft differs from the prepared draft. Prepare and review the changed inputs again.", 409);
    }
    if (validated.definition.version > 1) {
      const previous = store.getExperiment(validated.definition.experimentId, validated.definition.parentVersion);
      const fixedFields = definition => Object.fromEntries(Object.entries(definition).filter(([key]) =>
        !["version", "parentVersion", "parentExperimentId", "title", "decisionText", "scenarios", "definitionHash"].includes(key)));
      const oldBaseline = previous.definition.scenarios.find(scenario => scenario.isBaseline);
      const newBaseline = validated.definition.scenarios.find(scenario => scenario.isBaseline);
      if (contentHash(previous.inputs) !== contentHash(validated.inputs)
        || contentHash(fixedFields(previous.definition)) !== contentHash(fixedFields(validated.definition))
        || contentHash(oldBaseline) !== contentHash(newBaseline)) {
        throw new SimulationError("INVALID_REVISION", "A revision must retain the reviewed comparison inputs and baseline. Prepare a separate experiment for other changes.", 409);
      }
    }
    const saved = store.saveExperiment(validated);
    issuedDrafts.delete(key);
    return saved;
  }

  function eventStream(req, res, url, runId) {
    const raw = req.headers["last-event-id"] ?? url.searchParams.get("after") ?? "0";
    if (typeof raw !== "string" || !/^\d{1,10}$/.test(raw)) throw new SimulationError("INVALID_CURSOR", "Invalid event cursor.");
    const after = Number(raw), run = store.readRun(runId);
    if (!Number.isSafeInteger(after) || after > run.events.length) throw new SimulationError("INVALID_CURSOR", "The event cursor is outside the saved stream.");
    if (store.listenerCount() >= LIMITS.subscribers) throw new SimulationError("SUBSCRIBER_LIMIT", "Too many event stream subscribers.", 429);
    let unsubscribe = () => {}, timer, ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      unsubscribe();
      streams.delete(finish);
      res.removeListener("close", finish);
      res.removeListener("error", finish);
      req.removeListener("aborted", finish);
      if (!res.writableEnded) res.end();
    };
    streams.add(finish);
    res.once("close", finish);
    res.once("error", finish);
    req.once("aborted", finish);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders?.();
    unsubscribe = store.subscribe(runId, after, event => {
      if (ended || res.destroyed || res.writableLength > 1024 * 1024) { finish(); return; }
      res.write(`id: ${event.sequence}\nevent: simulation\ndata: ${JSON.stringify(event)}\n\n`);
    });
    if (ended) { unsubscribe(); return; }
    timer = setInterval(() => {
      if (res.destroyed || res.writableLength > 1024 * 1024) finish();
      else res.write(": heartbeat\n\n");
    }, 15000);
    timer.unref?.();
  }

  async function handle(req, res, suppliedUrl) {
    const url = suppliedUrl instanceof URL ? suppliedUrl : new URL(req.url, "http://localhost");
    if (!/^\/api\/(?:experiments(?:\/|$)|runs(?:\/|$)|evidence(?:\/|$)|provider\/status$)/.test(url.pathname)) return false;
    let admitted = false;
    try {
      if (closed) throw new SimulationError("API_CLOSED", "The simulation service is shutting down.", 503);
      if (activeRequests >= 16) throw new SimulationError("REQUEST_LIMIT", "Too many simultaneous simulation requests.", 429);
      activeRequests++;
      admitted = true;
      let parts;
      try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
      catch { throw new SimulationError("INVALID_PATH", "The API path is malformed."); }
      const method = req.method;
      if (method === "GET" && url.pathname === "/api/provider/status") {
        send(res, 200, await manager.providerStatus(url.searchParams.get("model")));
        return true;
      }
      if (parts[1] === "experiments") {
        if (parts.length === 3 && parts[2] === "draft" && method === "POST") {
          const input = validateDraftInput(await body(req));
          let draft;
          try { draft = await domain.prepareExperiment(input); }
          catch { throw new SimulationError("INVALID_DRAFT", "The shipping-policy draft could not be prepared. Check supported options, inputs and reviewed assumptions."); }
          validateRunConfig(draft.definition, draft.inputs);
          for (const [key, issued] of issuedDrafts) {
            if (Date.now() - issued.createdAt > draftLifetimeMs) issuedDrafts.delete(key);
          }
          if (issuedDrafts.size >= 64) issuedDrafts.delete(issuedDrafts.keys().next().value);
          issuedDrafts.set(`${draft.definition.experimentId}:${draft.definition.version}`, {
            bundleHash: contentHash({ definition: draft.definition, inputs: draft.inputs }), createdAt: Date.now(),
          });
          send(res, 200, draft);
          return true;
        }
        if (parts.length === 2 && method === "POST") {
          const saved = saveReviewed(await body(req));
          send(res, 201, { definition: saved.definition, inputs: saved.inputs });
          return true;
        }
        if (parts.length === 2 && method === "GET") {
          send(res, 200, { experiments: store.listExperiments() });
          return true;
        }
        if (parts.length >= 3) {
          const id = safeId(parts[2], "experiment identifier");
          if (parts.length === 3 && method === "GET") {
            const record = store.getExperiment(id, versionParam(url.searchParams.get("version"), true));
            send(res, 200, { definition: record.definition, inputs: record.inputs, versions: record.versions, runs: record.runs });
            return true;
          }
          if (parts.length === 4 && parts[3] === "runs" && method === "POST") {
            const request = objectBody(await body(req), ["version", "idempotencyKey"]);
            request.version = versionParam(request.version);
            send(res, 202, await manager.start(id, request));
            return true;
          }
          if (parts.length === 4 && parts[3] === "branches" && method === "POST") {
            const patch = objectBody(await body(req), ["version", "decisionText", "options"]);
            const prior = store.getExperiment(id, versionParam(patch.version));
            const changes = { ...(patch.decisionText == null ? {} : { decisionText: patch.decisionText }), ...(patch.options == null ? {} : { options: patch.options }) };
            if (changes.decisionText != null && (typeof changes.decisionText !== "string" || changes.decisionText.length > 10000)) throw new SimulationError("INVALID_DRAFT", "The revised decision text is too long.");
            let revised;
            try { revised = await domain.reviseExperiment(prior.definition, prior.inputs, changes); }
            catch { throw new SimulationError("INVALID_REVISION", "The proposed revision is unsupported or would change frozen comparison inputs."); }
            revised = structuredClone(revised);
            revised.definition.version = store.getExperiment(id).definition.version + 1;
            revised.definition.parentVersion = prior.definition.version;
            const { definitionHash: ignoredHash, ...hashable } = revised.definition;
            revised.definition.definitionHash = domain.stableHash(hashable);
            const saved = saveReviewed({ definition: revised.definition, inputs: revised.inputs }, true);
            send(res, 201, { definition: saved.definition, inputs: saved.inputs });
            return true;
          }
          if (parts.length === 4 && parts[3] === "timing" && method === "POST") {
            send(res, 200, store.recordTiming(id, objectBody(await body(req), ["stage", "durationMs"])));
            return true;
          }
        }
      }
      if (parts[1] === "runs" && parts.length >= 3) {
        const runId = safeId(parts[2], "run identifier");
        if (parts.length === 3 && method === "GET") {
          send(res, 200, manager.getRun(runId));
          return true;
        }
        if (parts.length === 4 && parts[3] === "events" && method === "GET") {
          eventStream(req, res, url, runId);
          return true;
        }
        if (parts.length === 4 && ["cancel", "replay", "brief"].includes(parts[3]) && method === "POST") {
          objectBody(await body(req), []);
          const result = await manager[parts[3]](runId);
          send(res, 200, result);
          return true;
        }
      }
      if (parts[1] === "evidence" && parts.length === 3 && method === "GET") {
        const id = parts[2];
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)) throw new SimulationError("INVALID_ID", "Invalid evidence identifier.");
        const experimentId = url.searchParams.get("experimentId"), version = versionParam(url.searchParams.get("version"), true);
        if (!experimentId && version) throw new SimulationError("INVALID_VERSION", "An experiment identifier is required with an evidence version.");
        const records = experimentId ? [store.getExperiment(experimentId, version)]
          : store.listExperiments().flatMap(item => [...store.experiments.get(item.experimentId).values()]);
        const matches = records.flatMap(record => record.inputs.evidence.filter(item => (item.evidenceId || item.id) === id));
        if (!matches.length) throw new SimulationError("NOT_FOUND", "Evidence not found.", 404);
        if (new Set(matches.map(contentHash)).size > 1) throw new SimulationError("AMBIGUOUS_EVIDENCE", "Specify the experiment and version for this evidence record.", 409);
        send(res, 200, matches[0]);
        return true;
      }
      throw new SimulationError("NOT_FOUND", "Simulation API route not found.", 404);
    } catch (error) {
      if (!(error instanceof SimulationError)) {
        console.error("Simulation request failed:", redactDebug(String(error?.stack || error?.message || "Unexpected failure")).slice(0, 8000));
      }
      if (res.headersSent) { if (!res.writableEnded) res.end(); }
      else {
        if (!req.complete || ["PAYLOAD_LIMIT", "REQUEST_TIMEOUT", "CONTENT_TYPE", "REQUEST_LIMIT"].includes(error?.code)) {
          res.shouldKeepAlive = false;
          res.setHeader("Connection", "close");
          req.on("error", () => {});
          req.resume();
        }
        send(res, error instanceof SimulationError ? error.status : 500, { error: publicError(error) });
      }
      return true;
    } finally {
      if (admitted) activeRequests--;
    }
  }

  return {
    handle, manager, store,
    async close() {
      if (closed) return;
      closed = true;
      issuedDrafts.clear();
      for (const finish of [...streams]) finish();
      await manager.close();
      store.close();
    },
  };
}
