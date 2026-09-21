import { createHash } from "node:crypto";

export const ADAPTER_VERSION = "shipping-policy-h0.1";
export const PROMPT_VERSION = "shipping-choice-h0.2";
export const SUPPORTED_PROMPT_VERSIONS = Object.freeze(["shipping-choice-h0.1", PROMPT_VERSION]);
export const MAX_MONEY = 100_000_000;
export const CAPABILITIES = Object.freeze({
  customer: ["purchase", "add_item", "substitute", "defer", "abandon", "no_action"],
  employee: ["request_capacity", "request_replenishment", "escalate", "no_action"],
  supplier: ["fulfill_replenishment", "decline", "no_action"],
  reseller: ["place_order", "defer", "no_action"],
});

export function fail(message) { throw new Error(`Shipping domain: ${message}`); }
export function check(ok, message) { if (!ok) fail(message); }
export function object(value, label) {
  check(value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${label} must be an object`);
  return value;
}
export function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) check(allowed.includes(key), `${label}: unsupported field ${key}`);
}
export function integer(value, label, min = 0, max = MAX_MONEY) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, `${label} must be an integer in ${min}..${max}`);
  return value;
}
export function text(value, label, max = 4000, min = 0) {
  check(typeof value === "string" && value.length >= min && value.length <= max, `${label} must be text (${min}..${max} characters)`);
  return value;
}
export function array(value, label, max = 1000, min = 0) {
  check(Array.isArray(value) && value.length >= min && value.length <= max, `${label} must be an array (${min}..${max} entries)`);
  return value;
}
export function unique(values, label) { check(new Set(values).size === values.length, `${label} contains duplicate IDs`); }
export function clone(value) { return JSON.parse(JSON.stringify(value)); }
export function omit(value, ...excluded) { return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.includes(key))); }
export function canonical(value, depth = 0) {
  check(depth <= 40, "JSON nesting exceeds 40");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { check(Number.isFinite(value), "non-finite JSON number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  object(value, "JSON value");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
}
export function stableHash(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function bytesHash(value) { return createHash("sha256").update(value).digest("hex"); }
export function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
export function seededOrder(values, seed, identity = value => value.id) {
  return [...values].sort((a, b) => stableHash([seed, identity(a)]).localeCompare(stableHash([seed, identity(b)])));
}
export function cents(value, label, nullable = false) {
  if (nullable && (value === null || value === "" || value === "\\N" || value === "NULL")) return null;
  const normalized = String(value).trim().replace(/^\./, "0.");
  const match = normalized.match(/^(\d+)(?:\.(\d+))?$/);
  check(match, `${label} is not a nonnegative decimal`);
  const tail = `${match[2] || ""}000`;
  return integer(Number(match[1]) * 100 + Number(tail.slice(0, 2)) + (Number(tail[2]) >= 5 ? 1 : 0), label);
}
