import {
  appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, statSync,
  truncateSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = Object.freeze({
  payloadBytes: 4 * 1024 * 1024, objectBytes: 8 * 1024 * 1024,
  eventBytes: 4 * 1024 * 1024, logBytes: 64 * 1024 * 1024,
  rootBytes: 512 * 1024 * 1024, debugBytes: 256 * 1024,
  experiments: 100, versions: 40, runs: 500, events: 8000,
  subscribers: 64, timingRecords: 500,
});
export const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
const ACTIVE = new Set(["queued", "preparing", "running", "aggregating", "paused"]);
const STATES = {
  run_queued: "queued", run_preparing: "preparing", run_started: "running",
  run_aggregating: "aggregating", run_completed: "completed", run_failed: "failed",
  run_cancelled: "cancelled", run_interrupted: "interrupted", run_paused: "paused",
};
const TRANSITIONS = {
  new: ["queued", "interrupted"], queued: ["preparing", "cancelled", "failed", "interrupted"],
  preparing: ["running", "cancelled", "failed", "paused", "interrupted"],
  running: ["aggregating", "cancelled", "failed", "paused", "interrupted"],
  aggregating: ["completed", "cancelled", "failed", "interrupted"],
  paused: ["cancelled", "interrupted"],
};

export class SimulationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "SimulationError";
    this.code = code;
    this.status = status;
  }
}

export function publicError(error) {
  return error instanceof SimulationError
    ? { code: error.code, message: error.message }
    : { code: "INTERNAL_ERROR", message: "The simulation operation could not be completed." };
}

export function safeId(value, label = "identifier") {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) {
    throw new SimulationError("INVALID_ID", `Invalid ${label}.`);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
export function contentHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
const copy = value => structuredClone(value);
const secretKey = /^(?:password|passwd|secret|clientSecret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|credentials)$/i;
const secretText = /(?:\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{20,})|\bBearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g;

export function redactDebug(value, depth = 0) {
  if (depth > 30) return "[depth limited]";
  if (typeof value === "string") {
    return value.replace(secretText, "[redacted]")
      .replace(/((?:api[_-]?key|password|client[_-]?secret|access[_-]?token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.map(item => redactDebug(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secretKey.test(key))
    .map(([key, item]) => [key, redactDebug(item, depth + 1)]));
  return value;
}

function assertNoSecrets(value, depth = 0) {
  if (depth > 40) throw new SimulationError("INVALID_DATA", "Data nesting exceeds the allowed limit.");
  if (typeof value === "string") {
    secretText.lastIndex = 0;
    if (secretText.test(value)) throw new SimulationError("SENSITIVE_DATA", "Credentials must not be stored in simulation data.");
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (secretKey.test(key)) throw new SimulationError("SENSITIVE_DATA", "Credentials must not be stored in simulation data.");
      assertNoSecrets(item, depth + 1);
    }
  }
}

function json(value, limit = LIMITS.objectBytes) {
  assertNoSecrets(value);
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text) > limit) {
    throw new SimulationError("SIZE_LIMIT", "Simulation data exceeds the size limit.", 413);
  }
  return text;
}

function directoryBytes(path) {
  let total = 0;
  for (const name of readdirSync(path)) {
    const full = join(path, name), info = lstatSync(full);
    if (info.isSymbolicLink()) throw new SimulationError("UNSAFE_STORAGE", "Symbolic links are not supported in simulation storage.", 500);
    total += info.isDirectory() ? directoryBytes(full) : info.size;
    if (total > LIMITS.rootBytes) throw new SimulationError("STORAGE_LIMIT", "Simulation storage has reached its limit.", 507);
  }
  return total;
}

export class SimulationStore {
  constructor({ root } = {}) {
    const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    this.root = resolve(root || process.env.SIMULATION_DATA_DIR || join(repository, ".simulation-data"));
    this.runs = new Map();
    this.experiments = new Map();
    this.idempotency = new Map();
    this.listeners = new Map();
    this.closed = false;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new SimulationError("UNSAFE_STORAGE", "Symbolic links are not supported in simulation storage.", 500);
    this.bytes = directoryBytes(this.root);
    this.lockPath = join(this.root, "store.lock");
    this.lockToken = randomUUID();
    this.acquireLock();
    try {
      for (const name of ["experiments", "runs", "idempotency"]) mkdirSync(join(this.root, name), { recursive: true, mode: 0o700 });
      this.load();
    } catch (error) {
      this.releaseLock();
      throw error;
    }
  }

  acquireLock() {
    if (existsSync(this.lockPath)) {
      let live = true;
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, "utf8"));
        if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error("Invalid lock");
        try { process.kill(lock.pid, 0); } catch (error) { if (error.code === "ESRCH") live = false; }
      } catch { /* An unreadable lock is not safe to steal. */ }
      if (live) throw new SimulationError("STORAGE_BUSY", "Simulation storage is already in use.", 503);
      unlinkSync(this.lockPath);
    }
    const fd = openSync(this.lockPath, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken }));
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }

  releaseLock() {
    try {
      if (JSON.parse(readFileSync(this.lockPath, "utf8")).token === this.lockToken) unlinkSync(this.lockPath);
    } catch { /* A failed startup must not remove another process's lock. */ }
  }

  ensureOpen() {
    if (this.closed) throw new SimulationError("STORE_CLOSED", "Simulation storage is closed.", 503);
  }

  reserve(bytes, emergency = false) {
    if (this.bytes + bytes > LIMITS.rootBytes - (emergency ? 0 : 1024 * 1024)) throw new SimulationError("STORAGE_LIMIT", "Simulation storage has reached its limit.", 507);
  }

  atomic(path, value, { immutable = false, limit, emergency = false } = {}) {
    this.ensureOpen();
    const text = json(value, limit), size = Buffer.byteLength(text);
    const priorSize = existsSync(path) ? statSync(path).size : 0;
    if (immutable && priorSize) throw new SimulationError("IMMUTABLE_RECORD", "The saved record is immutable.", 409);
    this.reserve(size - priorSize, emergency);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const staging = `${path}.${randomUUID()}.pending`;
    let fd;
    try {
      fd = openSync(staging, "wx", 0o600);
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      if (immutable && existsSync(path)) throw new SimulationError("IMMUTABLE_RECORD", "The saved record is immutable.", 409);
      renameSync(staging, path);
      this.bytes += size - priorSize;
    } finally {
      if (fd != null) closeSync(fd);
      if (existsSync(staging)) unlinkSync(staging);
    }
  }

  readObject(path, limit = LIMITS.objectBytes) {
    if (statSync(path).size > limit) throw new SimulationError("CORRUPT_STORAGE", "Saved simulation data exceeds its allowed size.", 500);
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new SimulationError("CORRUPT_STORAGE", "Saved simulation data could not be verified.", 500); }
  }

  load() {
    const experimentsPath = join(this.root, "experiments");
    for (const id of readdirSync(experimentsPath)) {
      safeId(id);
      if (this.experiments.size >= LIMITS.experiments) throw new SimulationError("STORAGE_LIMIT", "Too many saved experiments.", 507);
      const versions = new Map();
      const versionPath = join(experimentsPath, id, "versions");
      if (!existsSync(versionPath)) continue;
      for (const filename of readdirSync(versionPath)) {
        if (filename.endsWith(".pending")) continue;
        if (!/^[1-9][0-9]*\.json$/.test(filename) || versions.size >= LIMITS.versions) throw new SimulationError("CORRUPT_STORAGE", "Saved experiment version names are invalid.", 500);
        const record = this.readObject(join(versionPath, filename));
        if (record.definition.experimentId !== id || `${record.definition.version}.json` !== filename
          || record.bundleHash !== contentHash({ definition: record.definition, inputs: record.inputs })) {
          throw new SimulationError("CORRUPT_STORAGE", "Saved experiment integrity check failed.", 500);
        }
        versions.set(record.definition.version, record);
      }
      if (versions.size) this.experiments.set(id, versions);
    }
    for (const id of readdirSync(join(this.root, "runs"))) {
      safeId(id);
      const path = join(this.root, "runs", id, "manifest.json");
      if (!existsSync(path)) continue;
      if (this.runs.size >= LIMITS.runs) throw new SimulationError("STORAGE_LIMIT", "Too many saved runs.", 507);
      const stored = this.readObject(path);
      const { manifestHash, ...manifestSource } = stored.manifest;
      if (stored.hash !== contentHash(stored.manifest) || stored.manifest.runId !== id
        || manifestHash !== contentHash(manifestSource)
        || (stored.manifest.inputsHash && stored.manifest.inputsHash !== contentHash(stored.manifest.inputs))
        || (stored.manifest.definitionHash && stored.manifest.definitionHash !== contentHash(stored.manifest.definition))) {
        throw new SimulationError("CORRUPT_STORAGE", "Saved run manifest integrity check failed.", 500);
      }
      const run = { manifest: stored.manifest, events: [], status: "new", rounds: new Map(), logBytes: 0 };
      this.runs.set(id, run);
      this.loadLog(id, run);
      const mapping = {
        experimentId: run.manifest.experimentId, keyHash: run.manifest.idempotencyKeyHash,
        requestHash: run.manifest.requestHash, version: run.manifest.version, runId: id,
      };
      if (mapping.keyHash) {
        const path = join(this.root, "idempotency", `${mapping.keyHash}.json`);
        if (existsSync(path)) {
          if (contentHash(this.readObject(path)) !== contentHash(mapping)) throw new SimulationError("CORRUPT_STORAGE", "Saved request mapping is inconsistent.", 500);
        } else this.atomic(path, mapping, { immutable: true });
        if (this.idempotency.has(mapping.keyHash)) throw new SimulationError("CORRUPT_STORAGE", "Saved request mapping is duplicated.", 500);
        this.idempotency.set(mapping.keyHash, mapping);
      }
    }
    for (const [id, run] of this.runs) {
      if (ACTIVE.has(run.status) || run.status === "new") {
        this.append(id, "run_interrupted", { reason: "The application restarted before the run finished." });
      }
    }
    for (const filename of readdirSync(join(this.root, "idempotency"))) {
      if (filename.endsWith(".pending")) continue;
      const keyHash = filename.replace(/\.json$/, "");
      if (!/^[a-f0-9]{64}\.json$/.test(filename) || !this.idempotency.has(keyHash)) {
        throw new SimulationError("CORRUPT_STORAGE", "A saved request mapping has no matching immutable run.", 500);
      }
    }
  }

  loadLog(id, run) {
    const path = join(this.root, "runs", id, "events.jsonl");
    if (!existsSync(path)) return;
    if (statSync(path).size > LIMITS.logBytes) throw new SimulationError("CORRUPT_STORAGE", "Saved event log is too large.", 500);
    const buffer = readFileSync(path), lastNewline = buffer.lastIndexOf(10);
    const committedBytes = lastNewline + 1;
    const lines = buffer.subarray(0, committedBytes).toString("utf8").split("\n").slice(0, -1);
    for (const line of lines) {
      let event;
      try {
        if (Buffer.byteLength(line) > LIMITS.eventBytes) throw new Error("Size");
        event = JSON.parse(line);
      } catch { throw new SimulationError("CORRUPT_LOG", "Saved event log is corrupt before its incomplete tail.", 500); }
      this.verifyEvent(run, event);
      this.applyEvent(run, event);
    }
    // Only a non-newline-terminated tail can be an interrupted append.
    if (committedBytes !== buffer.length) {
      truncateSync(path, committedBytes);
      this.bytes -= buffer.length - committedBytes;
    }
    run.logBytes = committedBytes;
  }

  verifyEvent(run, event) {
    const { eventHash, ...unsigned } = event;
    const previous = run.events.at(-1)?.eventHash || run.manifest.manifestHash;
    if (event.sequence !== run.events.length + 1 || event.runId !== run.manifest.runId
      || event.schemaVersion !== 1 || event.eventId !== `${event.runId}-${event.sequence}`
      || event.previousEventHash !== previous || eventHash !== contentHash(unsigned)) {
      throw new SimulationError("CORRUPT_LOG", "Saved event sequence or source hash is invalid.", 500);
    }
    this.validateTransition(run, event.type, event.data, event.scenarioId);
  }

  validateTransition(run, type, data, scenarioId) {
    if (TERMINAL.has(run.status)) throw new SimulationError("TERMINAL_RUN", "The run is already terminal.", 409);
    const status = STATES[type];
    if (status && !TRANSITIONS[run.status]?.includes(status)) throw new SimulationError("INVALID_TRANSITION", "The requested run transition is not allowed.", 409);
    if (run.status === "paused" && !status) throw new SimulationError("INVALID_TRANSITION", "Paused runs cannot accept new work.", 409);
    if (type === "round_committed") {
      const previous = run.rounds.get(scenarioId)?.at(-1)?.data;
      if (run.status !== "running" || !safeId(scenarioId, "scenario identifier")
        || !run.manifest.definition.scenarios.some(scenario => scenario.scenarioId === scenarioId)
        || data.round !== (run.rounds.get(scenarioId)?.length || 0) + 1
        || !Array.isArray(data.actions) || !Array.isArray(data.events) || data.state == null
        || data.stateHash !== contentHash(data.state)
        || data.actionsHash !== contentHash(data.actions) || data.eventsHash !== contentHash(data.events)) {
        throw new SimulationError("INVALID_ROUND", "The round commit is incomplete or inconsistent.", 409);
      }
      if ((run.manifest.definition.horizon && data.round > run.manifest.definition.horizon.steps)
        || (previous && data.previousStateHash !== previous.stateHash)
        || (run.manifest.snapshotHash && data.snapshotHash !== run.manifest.snapshotHash)
        || (run.manifest.inputsHash && data.inputsHash !== run.manifest.inputsHash)) {
        throw new SimulationError("INVALID_ROUND", "The round does not match its frozen input or previous-state hashes.", 409);
      }
      const actors = run.manifest.inputs?.actors;
      if (Array.isArray(actors) && (data.actions.length !== actors.length
        || new Set(data.actions.map(action => action.actorId)).size !== actors.length
        || data.actions.some(action => !actors.some(actor => actor.id === action.actorId) || action.round !== data.round
          || action.scenarioId !== scenarioId || action.status !== "accepted"
          || action.actionHash !== contentHash(action.action) || action.observationHash !== contentHash(action.observation)))) {
        throw new SimulationError("INVALID_ROUND", "Every actor must provide a validated action before a round can commit.", 409);
      }
      const priorLedger = previous?.state?.ledgerEvents || run.manifest.inputs?.initialState?.ledgerEvents;
      if (Array.isArray(priorLedger) && Array.isArray(data.state.ledgerEvents)
        && contentHash([...priorLedger, ...data.events]) !== contentHash(data.state.ledgerEvents)) {
        throw new SimulationError("INVALID_ROUND", "Committed ledger events do not reconcile to the new state.", 409);
      }
    }
  }

  applyEvent(run, event) {
    run.events.push(event);
    if (STATES[event.type]) run.status = STATES[event.type];
    if (event.type === "round_committed") {
      const rounds = run.rounds.get(event.scenarioId) || [];
      rounds.push(event);
      run.rounds.set(event.scenarioId, rounds);
    }
  }

  append(runId, type, data = {}, scenarioId) {
    this.ensureOpen();
    if (this.writeFailed) throw new SimulationError("STORAGE_UNAVAILABLE", "Simulation event storage is unavailable.", 503);
    const run = this.getInternalRun(runId);
    this.validateTransition(run, type, data, scenarioId);
    const emergency = ["run_failed", "run_cancelled", "run_interrupted", "run_paused", "attempt_failed", "actor_failed"].includes(type);
    if (run.events.length >= LIMITS.events - (emergency ? 0 : 32)) throw new SimulationError("EVENT_LIMIT", "The run event limit was reached.", 409);
    const sequence = run.events.length + 1;
    const event = {
      eventId: `${runId}-${sequence}`, sequence, runId, ...(scenarioId ? { scenarioId } : {}),
      timestamp: new Date().toISOString(), type, schemaVersion: 1, data: copy(data),
      previousEventHash: run.events.at(-1)?.eventHash || run.manifest.manifestHash,
    };
    event.eventHash = contentHash(event);
    const line = json(event, LIMITS.eventBytes) + "\n", bytes = Buffer.byteLength(line);
    if (run.logBytes + bytes > LIMITS.logBytes - (emergency ? 0 : 128 * 1024)) throw new SimulationError("EVENT_LIMIT", "The run event log size limit was reached.", 409);
    this.reserve(bytes, emergency);
    const path = join(this.root, "runs", runId, "events.jsonl");
    const fd = openSync(path, "a", 0o600);
    try { appendFileSync(fd, line, "utf8"); fsyncSync(fd); }
    catch (error) {
      try { truncateSync(path, run.logBytes); }
      catch { this.writeFailed = true; }
      throw error;
    } finally { closeSync(fd); }
    this.bytes += bytes;
    run.logBytes += bytes;
    this.applyEvent(run, event);
    if (type === "round_committed" || STATES[type]) {
      try { this.writeSnapshot(runId); } catch { /* A durable event remains authoritative if the accelerator cannot be written. */ }
    }
    run.publishQueue ||= [];
    run.publishQueue.push(event);
    if (!run.publishing) {
      run.publishing = true;
      try {
        while (run.publishQueue.length) {
          const next = run.publishQueue.shift();
          for (const subscriber of [...(this.listeners.get(runId) || [])]) subscriber.push(next);
        }
      } finally { run.publishing = false; }
    }
    return copy(event);
  }

  writeSnapshot(runId) {
    const run = this.getInternalRun(runId);
    this.atomic(join(this.root, "runs", runId, "snapshot.json"), {
      sequence: run.events.length, sourceHash: run.events.at(-1)?.eventHash,
      manifestHash: run.manifest.manifestHash, status: run.status,
      rounds: Object.fromEntries([...run.rounds].map(([id, events]) => [id, events.map(event => ({
        round: event.data.round, stateHash: event.data.stateHash, eventHash: event.eventHash,
      }))])),
    });
  }

  getInternalRun(runId) {
    safeId(runId, "run identifier");
    const run = this.runs.get(runId);
    if (!run) throw new SimulationError("NOT_FOUND", "Run not found.", 404);
    return run;
  }

  readRun(runId) {
    const run = this.getInternalRun(runId);
    return copy({
      runId, status: run.status, manifest: run.manifest, events: run.events,
      rounds: Object.fromEntries([...run.rounds].map(([id, events]) => [id, events.map(event => event.data)])),
    });
  }

  findRequest(experimentId, idempotencyKey, requestHash, version) {
    safeId(experimentId, "experiment identifier");
    if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) throw new SimulationError("INVALID_KEY", "Use an idempotency key containing eight to one hundred twenty-eight letters, digits, hyphens or underscores.");
    const keyHash = contentHash({ experimentId, idempotencyKey });
    const existing = this.idempotency.get(keyHash);
    if (existing && (existing.requestHash !== requestHash || existing.version !== version)) {
      throw new SimulationError("IDEMPOTENCY_CONFLICT", "This request key was already used with different inputs.", 409);
    }
    return { keyHash, runId: existing?.runId || null };
  }

  createRun(manifest) {
    this.ensureOpen();
    const id = safeId(manifest.runId);
    if (this.runs.size >= LIMITS.runs) throw new SimulationError("STORAGE_LIMIT", "The saved run limit was reached.", 507);
    if (this.runs.has(id) || this.idempotency.has(manifest.idempotencyKeyHash)) throw new SimulationError("RUN_CONFLICT", "This run request already exists.", 409);
    const immutable = copy(manifest);
    immutable.manifestHash = contentHash(immutable);
    this.atomic(join(this.root, "runs", id, "manifest.json"), { manifest: immutable, hash: contentHash(immutable) }, { immutable: true });
    this.runs.set(id, { manifest: immutable, events: [], rounds: new Map(), status: "new", logBytes: 0 });
    const mapping = {
      experimentId: immutable.experimentId, keyHash: immutable.idempotencyKeyHash,
      requestHash: immutable.requestHash, version: immutable.version, runId: id,
    };
    this.idempotency.set(mapping.keyHash, mapping);
    try {
      this.append(id, "run_queued", { queuedAt: immutable.createdAt });
      this.atomic(join(this.root, "idempotency", `${mapping.keyHash}.json`), mapping, { immutable: true });
    } catch (error) {
      try { this.append(id, "run_interrupted", { reason: "Run creation was interrupted before execution." }); } catch { /* Recovered from the manifest and log on restart. */ }
      throw error;
    }
    return this.readRun(id);
  }

  saveExperiment({ definition, inputs }) {
    this.ensureOpen();
    const id = safeId(definition?.experimentId, "experiment identifier"), version = definition.version;
    if (!Number.isSafeInteger(version) || version < 1 || version > LIMITS.versions) throw new SimulationError("INVALID_VERSION", "Invalid experiment version.");
    const versions = this.experiments.get(id) || new Map(), bundleHash = contentHash({ definition, inputs });
    if (versions.has(version)) {
      if (versions.get(version).bundleHash !== bundleHash) throw new SimulationError("IMMUTABLE_VERSION", "An existing experiment version cannot be changed.", 409);
      return copy(versions.get(version));
    }
    if (!versions.size && this.experiments.size >= LIMITS.experiments) throw new SimulationError("STORAGE_LIMIT", "The saved experiment limit was reached.", 507);
    if (version !== Math.max(0, ...versions.keys()) + 1) throw new SimulationError("VERSION_CONFLICT", "Save the next sequential experiment version.", 409);
    const record = { definition: copy(definition), inputs: copy(inputs), createdAt: new Date().toISOString(), bundleHash };
    this.atomic(join(this.root, "experiments", id, "versions", `${version}.json`), record, { immutable: true });
    versions.set(version, record);
    this.experiments.set(id, versions);
    return copy(record);
  }

  getExperiment(id, version) {
    safeId(id, "experiment identifier");
    const versions = this.experiments.get(id);
    if (!versions) throw new SimulationError("NOT_FOUND", "Experiment not found.", 404);
    const selected = version ?? Math.max(...versions.keys());
    if (!Number.isSafeInteger(selected) || selected < 1) throw new SimulationError("INVALID_VERSION", "Invalid experiment version.");
    const record = versions.get(selected);
    if (!record) throw new SimulationError("NOT_FOUND", "Experiment version not found.", 404);
    return {
      ...copy(record), versions: [...versions.values()].map(item => ({ version: item.definition.version, createdAt: item.createdAt })),
      runs: this.listRuns(id),
    };
  }

  listRuns(experimentId) {
    return [...this.runs.values()].filter(run => run.manifest.experimentId === experimentId)
      .map(run => ({ runId: run.manifest.runId, status: run.status, version: run.manifest.version }));
  }

  listExperiments() {
    return [...this.experiments.keys()].map(id => {
      const record = this.getExperiment(id);
      return { experimentId: id, title: record.definition.title, version: record.definition.version, updatedAt: record.createdAt, runs: record.runs };
    });
  }

  subscribe(runId, after, listener) {
    const run = this.getInternalRun(runId);
    if (!Number.isSafeInteger(after) || after < 0 || after > run.events.length) throw new SimulationError("INVALID_CURSOR", "The event cursor is outside the saved stream.");
    if (this.listenerCount() >= LIMITS.subscribers) throw new SimulationError("SUBSCRIBER_LIMIT", "Too many event stream subscribers.", 429);
    const set = this.listeners.get(runId) || new Set();
    this.listeners.set(runId, set);
    let cursor = after, replaying = true, closed = false;
    const pending = [];
    const unsubscribe = () => {
      closed = true;
      set.delete(subscriber);
      if (!set.size) this.listeners.delete(runId);
    };
    const deliver = event => {
      if (closed || event.sequence <= cursor) return;
      cursor = event.sequence;
      try { listener(copy(event)); } catch { unsubscribe(); }
    };
    const subscriber = { push: event => replaying ? pending.push(event) : deliver(event) };
    set.add(subscriber);
    const history = run.events.slice(after);
    for (const event of history) deliver(event);
    // A callback may synchronously append during replay; drain before switching live.
    while (pending.length && !closed) deliver(pending.shift());
    replaying = false;
    return unsubscribe;
  }

  listenerCount(runId) {
    return runId ? this.listeners.get(runId)?.size || 0 : [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }

  writeDebug(runId, callId, value) {
    this.getInternalRun(runId);
    safeId(callId, "call identifier");
    let debug = redactDebug(value);
    if (Buffer.byteLength(JSON.stringify(debug)) > LIMITS.debugBytes) {
      debug = { callId, truncated: true, rawText: String(debug.rawText || "").slice(0, 16000), errorCategory: debug.errorCategory || null };
    }
    this.atomic(join(this.root, "runs", runId, "debug", `${callId}.json`), debug, { immutable: true, limit: LIMITS.debugBytes });
  }

  saveBrief(runId, brief) {
    const run = this.getInternalRun(runId);
    if (run.status !== "completed") throw new SimulationError("INCOMPLETE_RUN", "Only complete runs can have a decision brief.", 409);
    const path = join(this.root, "runs", runId, "brief.json");
    if (existsSync(path)) return this.readObject(path);
    const record = { ...copy(brief), sourceHash: run.events.at(-1).eventHash };
    this.atomic(path, record, { immutable: true });
    return copy(record);
  }

  recordTiming(experimentId, { stage, durationMs }) {
    this.getExperiment(experimentId);
    if (!["editing", "review", "export"].includes(stage) || (durationMs != null && (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 8 * 60 * 60 * 1000))) {
      throw new SimulationError("INVALID_TIMING", "Invalid workflow timing record.");
    }
    const records = this.getTiming(experimentId);
    if (records.length >= LIMITS.timingRecords) throw new SimulationError("TIMING_LIMIT", "The workflow timing record limit was reached.", 409);
    records.push({ stage, timestamp: new Date().toISOString(), ...(durationMs == null ? {} : { durationMs, basis: "user_reported_active_time" }) });
    this.atomic(join(this.root, "experiments", experimentId, "timing.json"), records);
    return { recorded: true };
  }

  getTiming(experimentId) {
    safeId(experimentId);
    const path = join(this.root, "experiments", experimentId, "timing.json");
    return existsSync(path) ? this.readObject(path) : [];
  }

  getRuntimeBlock() {
    const path = join(this.root, "runtime-block.json");
    return existsSync(path) ? this.readObject(path, 4096) : null;
  }

  blockRuntime() {
    if (!this.getRuntimeBlock()) {
      this.atomic(join(this.root, "runtime-block.json"), {
        code: "STOP_UNCONFIRMED", timestamp: new Date().toISOString(),
        reason: "Provider process termination could not be confirmed. Inspect and stop the local runtime before removing this block.",
      }, { immutable: true, emergency: true, limit: 4096 });
    }
  }

  close() {
    if (this.closed) return;
    this.listeners.clear();
    this.releaseLock();
    this.closed = true;
  }
}

export async function createStore(options) { return new SimulationStore(options); }
