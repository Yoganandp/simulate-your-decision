import * as domain from "./domain.mjs";
import { MAX_MONEY, freeze } from "./domain-common.mjs";
import { SimulationError } from "./store.mjs";

const DEFAULT_FEE = 795;
const QUICK_PREVIEW = /^quick preview\s*:/i;
const TOKEN = "@(\\d+)@";
const SHIPPING = "(?:free[- ]shipping|shipping)";
const UNSUPPORTED = /\b(?:discounts?|memberships?|subscriptions?|tax(?:es)?|salar(?:y|ies)|wages?|hiring|hire|layoffs?|staffing|warehouse|acquisition|prospects?|percent|pricing|product prices?|delivery times?|express|overnight|same[- ]day|international|coupons?|loyalty|new customers?|existing customers? only|flat[- ]rate|return polic(?:y|ies)|refunds?|marketing|advertising|remote work|hybrid work|open(?:ing)? (?:a |another |new )?(?:store|office))\b|%/i;
const PARSER_WARNINGS = [
  "Template parser supports shipping threshold and fee edits only.",
  "No unambiguous supported policy edit was parsed.",
  "Material non-shipping-policy text is unsupported",
];

function invalid(message, code = "INVALID_CONVERSATION") {
  throw new SimulationError(code, message);
}

function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

function tokenize(text) {
  const amounts = [];
  const normalized = text.replace(/(?:US\$|USD\s*\$)/gi, "$");
  const source = normalized.replace(/(?:\$\s*|USD\s+)?[+-]?\d+(?:,\d+)*(?:\.\d+)?(?:e[+-]?\d+)?(?:\s*(?:USD|dollars?)\b)?/gi, (raw, offset) => {
    const before = normalized.slice(0, offset);
    const after = normalized.slice(offset + raw.length);
    const decimal = raw.replace(/^(?:\$\s*|USD\s+)/i, "").replace(/\s*(?:USD|dollars?)$/i, "");
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(decimal)
      || /[-+\u2212\u2013\u2014]\s*$/.test(before) || /[\w.]$/.test(before)
      || /^\w|^\.\d|^[-\u2013\u2014]\s*\$?\d/.test(after)
      || /^\s*(?:hundred|thousand|million|billion|trillion|cents?)\b/i.test(after)) {
      invalid("Use nonnegative USD amounts with at most two decimal places, not ranges or abbreviated amounts.");
    }
    const [whole, fraction = ""] = decimal.replaceAll(",", "").split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    if (!Number.isSafeInteger(cents) || cents > MAX_MONEY) invalid("A shipping amount exceeds the supported USD limit.");
    const id = amounts.length;
    amounts.push({ id, cents, role: null });
    return `@${id}@`;
  });
  if (/\$|\bUSD\b|(?:\d|\.)\.\d|[-\u2212]\s*@/i.test(source)) {
    invalid("A USD amount is malformed. Use amounts such as $50 or $7.95.");
  }
  for (const match of source.matchAll(/@(\d+)@/g)) {
    Object.assign(amounts[Number(match[1])], { start: match.index, end: match.index + match[0].length });
  }
  return { source, amounts };
}

function mark(source, amounts, patterns, role) {
  for (const pattern of patterns) {
    for (const match of source.matchAll(new RegExp(pattern, "gi"))) {
      const amount = amounts[Number(match[1])];
      if (amount.role && amount.role !== role && !(role === "reference" && amount.role === "threshold")) {
        invalid("A dollar amount is ambiguous between a shipping fee and a free-shipping threshold.");
      }
      amount.role = role;
    }
  }
}

function optionLabels(source) {
  const labels = [...source.matchAll(/\b(?:option|scenario|choice)\s+([a-z]|@\d+@)\b\s*:?\s*/gi)];
  if (labels.some(match => !["a", "b"].includes(match[1].toLowerCase())) || labels.length > 2
    || labels.some((match, index) => match[1].toLowerCase() !== ["a", "b"][index])) {
    invalid("Describe at most two options, in Option A then Option B order.");
  }
  return labels.map(match => ({ start: match.index, end: match.index + match[0].length }));
}

function validateSupportedText(source) {
  const policyText = source
    .replace(/\b(?:i|we)\s+(?:don't|don’t|do not)\s+know\s+(?:(?:our|the)\s+)?(?:(?:fulfillment|labor|labour|operating)\s+(?:(?:and|or)\s+)?)+costs?(?:\s+yet)?\b/gi, "")
    .replace(/\b(?:(?:our|the)\s+)?(?:(?:fulfillment|labor|labour|operating)\s+)?costs?\s+(?:are\s+)?(?:unknown|unspecified|not known)(?:\s+yet)?\b/gi, "")
    .replace(/\b(?:no minimum|without (?:a )?minimum|not known|not specified|not provided)\b/gi, "");
  if (/\b(?:no|not|never|don't|don’t|doesn't|doesn’t|without|except|unless|avoid|stop|remove)\b/i.test(policyText)) {
    invalid("Negated or conditional policy instructions cannot be interpreted safely; they are not replaced with illustrative shipping presets.", "UNSUPPORTED_POLICY");
  }
  // Only recognized shipping prose and missing-data disclosures may reach preset filling.
  const grammar = new Set(("a an the i we we're are is be will have has our your it please would could can you me us like want to only "
    + "what if compare comparing compared consider considering test testing simulate show run change offer offering provide providing keep keeping unchanged "
    + "free shipping threshold thresholds fee fees delivery charge charges charging pay otherwise below under over above at least from starting "
    + "on for every any all order orders unconditional always minimum of and or versus vs with instead rather than against both either same "
    + "current currently existing today right now present option options scenario scenarios choice choices first second former latter "
    + "use apply automatic illustrative preset presets default defaults unknown unspecified missing specified provided values").split(" "));
  const words = policyText.replace(/@(\d+)@/g, "").replace(/\b(?:option|scenario|choice)\s+[ab]\b/gi, "").match(/\p{L}+(?:['’]\p{L}+)?/gu) ?? [];
  if (words.some(word => !grammar.has(word.toLowerCase().replace("’", "'")))) {
    invalid("An alternative contains unrecognized policy instructions. Only free-shipping thresholds, shipping fees, and explicit preset choices are supported; unsupported alternatives are not replaced with defaults.", "UNSUPPORTED_POLICY");
  }
  const alternatives = [
    ...policyText.split(/\b(?:with|versus|vs|against|instead of|rather than|compared to|and|or)\b/gi).slice(1),
    ...policyText.split(/\b(?:option|scenario|choice)\s+[ab]\b\s*:?\s*/gi).slice(1),
  ];
  for (const alternative of alternatives) {
    if (/\p{L}/u.test(alternative)
      && !/@\d+@|\b(?:free[- ]shipping|thresholds?|fees?|presets?|defaults?|unknown|unspecified|missing)\b/i.test(alternative)) {
      invalid("An alternative does not identify a supported shipping policy or a missing value. Unrecognized alternatives are not filled with presets.", "UNSUPPORTED_POLICY");
    }
  }
}

function feeClause(source, fee) {
  const separators = [".", ";", "\n", "?", "!"];
  const start = Math.max(...separators.map(separator => source.lastIndexOf(separator, fee.start))) + 1;
  const ends = separators.map(separator => source.indexOf(separator, fee.end)).filter(index => index !== -1);
  return source.slice(start, ends.length ? Math.min(...ends) : source.length);
}

function describePolicy(policy) {
  return policy.thresholdCents === 0 ? "free shipping on every order"
    : `free shipping at or above ${money(policy.thresholdCents)}, otherwise ${money(policy.shippingFeeCents)}`;
}

export function interpretConversation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => key !== "decisionText")) {
    invalid("The conversation request accepts only decisionText.", "INVALID_BODY");
  }
  if (typeof input.decisionText !== "string" || !input.decisionText.trim() || input.decisionText.length > 4000) {
    invalid("Describe the shipping options in 1–4000 characters.");
  }
  const decisionText = input.decisionText.trim();
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F@]/.test(decisionText)) invalid("The decision description contains unsupported characters.");
  if ([...decisionText.matchAll(/\p{Sc}/gu)].some(match => match[0] !== "$")
    || /\b(?:EUR|GBP|CAD|AUD|NZD|JPY|CNY|RMB|INR|CHF|MXN|BRL|ZAR|HKD|SGD|SEK|NOK|DKK|euros?|pounds?|rupees?|yen|Canadian|Australian)\b/i.test(decisionText)) {
    invalid("Only USD shipping policies are supported; currency conversion is not performed.", "UNSUPPORTED_CURRENCY");
  }
  if (!/\bshipping\b/i.test(decisionText) || UNSUPPORTED.test(decisionText)) {
    invalid("This simulation supports USD free-shipping thresholds and below-threshold shipping fees only; other policy types are not executed.", "UNSUPPORTED_POLICY");
  }
  if (/\b(?:negative|minus|NaN|Infinity)\b/i.test(decisionText)) invalid("Shipping amounts must be finite, nonnegative USD values.");
  const { source, amounts } = tokenize(decisionText.replace(QUICK_PREVIEW, "").trimStart());
  if (/\b(?:over|above|at least|threshold (?:of|at|to|from)|fee (?:of|at|to|is))\s+(?!@\d+@|unknown\b|unspecified\b|not known\b)[a-z\d$]/i.test(source)) {
    invalid("A threshold or fee value is not a supported USD amount. Use explicit dollar values, or leave it unspecified for an illustrative preset.");
  }
  const labels = optionLabels(source);
  mark(source, amounts, [
    `\\b(?:shipping\\s+)?fees?\\s*(?:(?:of|at|to|is|are|will be)\\s+)?${TOKEN}`,
    `\\b(?:otherwise|charge|charging|pay)\\s+(?:(?:a|an|only)\\s+)?${TOKEN}`,
    `${TOKEN}\\s+(?:(?:shipping|delivery)\\s+)?(?:fees?|charges?)\\b`,
    `${TOKEN}\\s+(?:otherwise|below|under)\\b`,
  ], "fee");
  mark(source, amounts, [
    `\\b(?:${SHIPPING}[- ]?)?thresholds?\\s*(?:(?:of|at|to|from|is|are)\\s+)?${TOKEN}`,
    `${TOKEN}\\s+(?:${SHIPPING}[- ]?)?thresholds?\\b`,
    `\\bfree[- ]shipping\\s+(?:(?:on|for)\\s+)?(?:orders?\\s+)?(?:over|above|at least|at|from|starting at)\\s+${TOKEN}`,
    `\\borders?\\s+(?:over|above|at least)\\s+${TOKEN}`,
  ], "threshold");
  mark(source, amounts, [`\\b(?:below|under)\\s+(?:the\\s+)?${TOKEN}`], "reference");
  // Explicit option scopes allow concise "$75" policies without treating fee dollars as thresholds.
  for (let index = 0; index < labels.length; index++) {
    const label = labels[index], end = labels[index + 1]?.start ?? source.length;
    const scoped = amounts.filter(amount => amount.start >= label.end && amount.start < end && !amount.role);
    if (scoped.length === 1 && /^\s*(?:(?:a|an|the|over|above|at|threshold(?: of| at)?)\s+)?$/.test(source.slice(label.end, scoped[0].start))) scoped[0].role = "threshold";
  }
  const connector = /^\s*[,;]?\s*(?:(?:and|or|versus|vs\.?|with|to|instead of|rather than|against|compared (?:to|with))\s+(?:(?:a|an|the)\s+)?|(?:and\s+)?(?:we(?: are|'re)\s+|are\s+)?(?:considering|comparing|consider|compare|test)\s+|,\s*)$/i;
  for (let pass = 0; pass < amounts.length; pass++) {
    let changed = false;
    for (let index = 0; index < amounts.length - 1; index++) {
      const left = amounts[index], right = amounts[index + 1];
      if (connector.test(source.slice(left.end, right.start)) && [left.role, right.role].includes("threshold")) {
        for (const amount of [left, right]) {
          if (!amount.role) { amount.role = "threshold"; changed = true; }
        }
      }
    }
    if (!changed) break;
  }
  if (amounts.some(amount => !amount.role)) {
    invalid("A dollar amount could not be assigned unambiguously. State each free-shipping threshold and its below-threshold fee; other numeric changes are unsupported.");
  }
  validateSupportedText(source);
  const fees = amounts.filter(amount => amount.role === "fee");
  const references = amounts.filter(amount => amount.role === "reference"), usedReferences = new Set();
  if (fees.some(fee => fee.cents > 100000)) invalid("A below-threshold shipping fee must be between $0 and $1,000.");
  let thresholds = amounts.filter(amount => amount.role === "threshold");
  for (const match of source.matchAll(/\b(?:free[- ]shipping\s+(?:(?:on|for)\s+(?:every|any|all)\s+orders?|(?:with\s+)?no minimum|without (?:a )?minimum)|(?:unconditional|always)\s+free[- ]shipping)\b/gi)) {
    thresholds.push({ cents: 0, start: match.index, end: match.index + match[0].length, role: "threshold" });
  }
  thresholds.sort((a, b) => a.start - b.start);
  if (!thresholds.length && !/\b(?:free[- ]shipping|shipping)[- ]thresholds?\b/i.test(source)) {
    invalid("Describe a free-shipping threshold policy; other shipping policy types are not supported.", "UNSUPPORTED_POLICY");
  }
  const allThresholds = [...thresholds];
  const current = thresholds.filter((threshold, index) => {
    const before = source.slice(thresholds[index - 1]?.end ?? 0, threshold.start);
    return /\b(?:current(?:ly)?|today|right now|existing|at present)\b/i.test(before)
      && !/\b(?:compare|comparing|consider|considering|option\s+[ab])\b/i.test(before.slice(before.search(/\b(?:current(?:ly)?|today|right now|existing|at present)\b/i)));
  });
  let omittedCurrent = null;
  if (current.length === 1 && current[0] === thresholds[0]
    && (thresholds.length === 3 || (labels.length === 2 && current[0].start < labels[0].start))) {
    omittedCurrent = current[0];
    thresholds = thresholds.filter(threshold => threshold !== omittedCurrent);
  }
  if (thresholds.length > 2) invalid("Describe exactly two compared shipping options, not three or more alternatives.");
  const explicitOptions = labels.length === 2 || thresholds.length === 2;
  if (labels.length) {
    const slots = [null, null];
    for (const threshold of thresholds) {
      const index = labels.findLastIndex(label => label.end <= threshold.start);
      if (index < 0 || slots[index]) invalid("Each labeled option must describe at most one unambiguous free-shipping policy.");
      slots[index] = threshold;
    }
    thresholds = slots;
  }
  const assumptions = [];
  if (!thresholds[0]) {
    thresholds[0] = { cents: 5000, start: -1, end: -1, preset: true };
    assumptions.push("No threshold was specified: Option A uses an illustrative $50.00 threshold, not a source fact.");
  }
  if (!thresholds[1]) {
    const cents = thresholds[0].cents === 7500 ? 10000 : 7500;
    thresholds[1] = { cents, start: source.length + 1, end: source.length + 1, preset: true };
    assumptions.push(`No second threshold was specified: Option B uses an illustrative ${money(cents)} threshold, not a source fact.`);
  }
  const assignedFees = [null, null];
  for (const fee of fees) {
    const clause = feeClause(source, fee);
    const prior = allThresholds.filter(threshold => threshold.end <= fee.start).at(-1);
    const sharedScope = /\b(?:both|either|same fee|same shipping fee)\b/i.test(clause);
    const globallyStated = sharedScope
      || (fees.length === 1 && (!prior || prior === allThresholds.at(-1))
        && !/\b(?:option|scenario|choice)\s+[ab]\b/i.test(clause)
        && /\b(?:keep(?:ing)? (?:the )?(?:shipping )?fee|fee unchanged)\b/i.test(clause));
    const optionSpecific = prior && /\botherwise\b|[([]/.test(source.slice(prior.end, fee.start));
    const reference = references.find(item => item.start > fee.end
      && /^\s+(?:(?:for|on)\s+orders?\s+)?(?:below|under)\s+(?:the\s+)?$/i.test(source.slice(fee.end, item.start)));
    const ordinalTargets = [...new Set([...clause.matchAll(/\b(former|latter|first|second)\b/gi)]
      .map(match => /^(?:former|first)$/i.test(match[1]) ? 0 : 1))];
    const declaredScopes = [...clause.matchAll(/\b(?:option|scenario|choice)\s+([ab])\b/gi)];
    if (ordinalTargets.length && (!explicitOptions || ordinalTargets.length !== 1 || sharedScope)) {
      invalid("A fee's option reference must identify exactly one explicitly described option, without conflicting shared-fee instructions.");
    }
    let targets;
    if (reference) {
      usedReferences.add(reference.id);
      targets = thresholds.flatMap((threshold, index) => threshold.cents === reference.cents ? [index] : []);
      if (!targets.length && omittedCurrent?.cents === reference.cents) continue;
      if (targets.length !== 1) invalid("A fee's named threshold must identify exactly one of the two compared options.");
      if (ordinalTargets.length && ordinalTargets[0] !== targets[0]) invalid("A fee's option reference conflicts with its named threshold.");
    } else if (ordinalTargets.length) {
      targets = ordinalTargets;
    } else if (globallyStated || (!labels.length && !optionSpecific && fees.length === 1 && (!prior || prior === allThresholds.at(-1)))) {
      targets = [0, 1];
    } else {
      const scoped = labels.findLastIndex(label => label.end <= fee.start);
      const selected = labels.length && scoped >= 0 ? scoped : thresholds.indexOf(prior);
      if (selected < 0) {
        if (prior === omittedCurrent) continue;
        invalid("A shipping fee has no clear option. Associate it with Option A, Option B, or both.");
      }
      targets = [selected];
    }
    if ((reference || ordinalTargets.length) && declaredScopes.length === 1
      && targets[0] !== (declaredScopes[0][1].toLowerCase() === "a" ? 0 : 1)) {
      invalid("A fee's reference conflicts with the option label in its clause.");
    }
    for (const target of targets) {
      if (assignedFees[target] !== null && assignedFees[target] !== fee.cents) invalid("An option has conflicting shipping fees.");
      assignedFees[target] = fee.cents;
    }
  }
  if (references.some(reference => !usedReferences.has(reference.id))) invalid("A below-threshold amount must be attached to an explicit shipping fee.");
  const policies = thresholds.map((threshold, index) => ({
    thresholdCents: threshold.cents, shippingFeeCents: assignedFees[index] ?? DEFAULT_FEE, existingCustomerThresholdCents: null,
  }));
  for (const [index, fee] of assignedFees.entries()) {
    if (fee === null) assumptions.push(`Option ${index ? "B" : "A"} uses the illustrative $7.95 below-threshold shipping fee preset; it is not a source fact${policies[index].thresholdCents === 0 ? " and is never charged with free shipping on every order" : ""}.`);
  }
  if (policies[0].thresholdCents === policies[1].thresholdCents && policies[0].shippingFeeCents === policies[1].shippingFeeCents) {
    invalid("The two shipping options are identical. Describe different thresholds or fees.");
  }
  const summary = `I'll compare Option A: ${describePolicy(policies[0])}, with Option B: ${describePolicy(policies[1])}. `
    + (omittedCurrent ? `Your mentioned current ${money(omittedCurrent.cents)} threshold is context only; the two requested options are compared, without a third scenario. ` : "")
    + "Option A is the comparison reference, not a claim about your current policy. This is an illustrative sample-data simulation, not a forecast.";
  return { decisionText, policies, conversation: { summary, assumptions } };
}

export async function prepareConversation(input) {
  const interpreted = interpretConversation(input);
  const quick = QUICK_PREVIEW.test(interpreted.decisionText);
  const panel = quick
    ? { customerCount: 3, employeeCount: 5, supplierCount: 1, resellerCount: 1, cycles: 2 }
    : { customerCount: 32, employeeCount: 22, supplierCount: 5, resellerCount: 4, cycles: 3 };
  const limits = quick
    ? { concurrency: 4, attemptCap: 81, deadlineMs: 600000 }
    : { concurrency: 2, attemptCap: 757, deadlineMs: 7200000 };
  let draft;
  try {
    draft = await domain.prepareExperiment({
      decisionText: interpreted.decisionText, title: quick ? "Quick preview · Shipping policies" : "Option A vs Option B · Shipping",
      ...panel,
      baseline: interpreted.policies[0], options: [{ label: "Option B", ...interpreted.policies[1] }],
      runConfig: { provider: "copilot", model: "mai-code-1.1-flash", ...limits, callTimeoutMs: 60000, repetitions: 1 },
    }, { preset: "conversational-shipping-v1" });
  } catch {
    throw new SimulationError("CONVERSATION_PREPARATION_FAILED", "The shipping comparison could not be prepared from validated sample evidence. Check the local sample-data setup; no replacement evidence or results were generated.", 503);
  }
  const conversation = interpreted.conversation;
  if (quick) conversation.summary = "Quick preview: 10 sample stakeholders across all six role groups, two rounds per option and 40 planned choices. This is a smaller exploratory sample, not the full business panel. " + conversation.summary;
  conversation.assumptions.push(
    "Unknown operating costs use illustrative presets: $5.00 fulfillment per completed order and $24.00/hour incremental labor. Neither is a measured source fact.",
    `${quick ? "Quick preview" : "Bounded business panel"}: ${draft.inputs.actors.length} sample stakeholders, selected across customers, leadership, management, frontline staff, suppliers and resellers. ${panel.cycles} shopping cycles, one repetition (${draft.estimate.plannedActions} planned actor actions across two options); no population weighting or annualization. Source and selected counts are shown separately.`,
    `Resource limits: at most ${limits.concurrency} concurrent model requests, ${limits.attemptCap} attempts including repairs and preflight, 60 seconds per call, and a ${limits.deadlineMs / 60000}-minute hard run deadline. This is a stop limit, not a completion-time estimate. Nothing starts until you select Run simulation.`,
    `Illustrative operating presets: 8 units per product; ${draft.inputs.initialState.baseCapacity} base order slots per cycle; customer budgets at 1.5× scheduled merchandise plus $20 per cycle; $300 total reseller budget.`,
    "Illustrative authority presets: up to 2 extra order slots per employee at 15 minutes each; 6 supplier units per response with a 1-cycle minimum lead time; up to 3 units per reseller order. Supply relationships are assumed; customer-to-customer influence is off.",
    "Pinned AdventureWorks sample records supply the frozen historical baskets, prices and available standard costs. They are sample business evidence, not your company data or current costs; genuinely missing product costs remain unknown.",
    "Shipping thresholds include orders exactly at the stated amount. Policy values are scenario inputs, not historical facts. The objective is panel contribution before tax, overhead and capital costs; no behavioral accuracy has been validated.",
    "Preset assumptions are applied automatically, not manually reviewed. Copilot mai-code-1.1-flash supplies live choices only when a run starts; preparation does not generate outcomes.",
    "Employee titles determine display groups, not additional powers. Leadership, managers and frontline staff share the declared shipping-adapter actions. Morale, satisfaction, churn and wider-company forecasts are not modeled.",
  );
  return { ...draft, questions: [],
    warnings: draft.warnings.filter(warning => !PARSER_WARNINGS.some(prefix => warning.startsWith(prefix))),
    conversation: freeze(conversation) };
}
