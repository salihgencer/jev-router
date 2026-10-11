import { TIER_NAMES, THRESHOLDS, TIER_ALIASES, PRICES, rankOf } from "./config.mjs";
import { QUOTA, quotaCeiling, exhaustedTiers } from "./quota.mjs";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALIAS_TO_TIER = new Map(
  Object.entries(TIER_ALIASES).flatMap(([tier, names]) => names.map((name) => [name, tier])),
);
// Generic English words ("fast", "strong", "long", "sol"…) are too ambiguous in Turkish
// phrasing ("sol ile sağ"), so the Turkish forms accept only real model names.
const GENERIC = new Set(["fast", "balanced", "strong", "long", "sol"]);
const anyAlias = [...ALIAS_TO_TIER.keys()].map(escape).join("|");
const modelAlias = [...ALIAS_TO_TIER.keys()].filter((n) => !GENERIC.has(n)).map(escape).join("|");

// A tier name only counts when the clause ends there or continues with a connective, so
// "use strong typing", "use fast-glob" and "with long names" are not instructions.
const TAIL = String.raw`(?:\s+(?:model|tier))?(?=$|[,.:;!?)]|\s+(?:to|for|and|then|on|now|please|instead)\b)`;
const LEAD = String.raw`^(?:(?:please|pls|ok(?:ay)?|now|also|lütfen|şimdi|bunu|bu\s+işi|bu\s+sefer)\s+)*`;
const EN = new RegExp(
  String.raw`${LEAD}(?:use|switch\s+to|go\s+with|run\s+(?:this\s+)?(?:on|with)|with|on)\s+(?:the\s+)?(${anyAlias})${TAIL}`,
  "iu",
);
const TR = new RegExp(
  String.raw`${LEAD}(${modelAlias})(?:\s+model(?:i|ini|iyle|ine)?)?(?:\s+kullan|\s+ile|['’]?y?[ae]\s+geç|\s+geç)(?=$|[\s,.!?])`,
  "iu",
);
const CONDITIONAL = /^(?:if|when|whenever|unless|in\s+case|once|after|eğer|şayet)\b/iu;

/** Text a user wrote themselves, without quoted, pasted or fenced material. */
function ownText(prompt) {
  return prompt
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, " ")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/**
 * The tier the user named explicitly in the prompt, or null.
 *
 * Only a clause-leading instruction counts: quoted or pasted text, negations ("don't use
 * haiku"), conditionals ("if it runs long, switch to opus") and names that are part of a
 * longer phrase are ignored. When several clauses name a tier, the last one wins.
 */
export function detectOverride(prompt) {
  let found = null;
  for (const sentence of ownText(prompt ?? "").split(/[.!?;\n]+/)) {
    const trimmed = sentence.trim();
    if (!trimmed || CONDITIONAL.test(trimmed)) continue;
    for (const clause of trimmed.split(/,|\s+(?:and\s+)?then\s+/i)) {
      const text = clause.trim();
      const hit = EN.exec(text) ?? TR.exec(text);
      if (hit) found = ALIAS_TO_TIER.get(hit[1].toLowerCase()) ?? found;
    }
  }
  return found;
}

/**
 * Nearest tier the account can actually run. Prefers stepping up rather than down so we
 * never silently hand a hard task to a weaker model, but never steps up into `fable`
 * (which bills extra usage credits) unless that is what was asked for.
 */
function clampToAvailable(tier, available) {
  if (available.includes(tier)) return tier;
  const rank = rankOf(tier);
  const up = TIER_NAMES.filter(
    (t, i) => i > rank && available.includes(t) && (t !== "fable" || tier === "fable"),
  );
  if (up.length) return up[0];
  const down = TIER_NAMES.filter((t, i) => i < rank && available.includes(t));
  return down.length ? down[down.length - 1] : null;
}

/**
 * Whether switching from `from` to `to` costs less than staying, over the next few requests.
 *
 * Staying on a warm cache pays cache reads; switching pays a full cache write on the new
 * tier, then reads there, plus the expected rewrite if the conversation later climbs back.
 * A cold cache (idle past its TTL) has to be rewritten either way, so staying pays the write
 * too and the cheaper tier wins. Units are relative prices (`PRICES`), not money.
 */
export function switchPays({ from, to, contextTokens, cacheWarm = true }) {
  const n = THRESHOLDS.switchHorizonRequests;
  const out = THRESHOLDS.switchOutputTokens;
  const { cacheWrite, cacheRead, outputRatio } = PRICES;
  const price = (tier) => PRICES[tier] ?? PRICES.opus;
  const requests = (tier, firstWrite) =>
    contextTokens * price(tier) * ((firstWrite ? cacheWrite : cacheRead) + (n - 1) * cacheRead) +
    n * out * price(tier) * outputRatio;
  const stay = requests(from, !cacheWarm);
  const comeBack = rankOf(to) < rankOf(from) ? THRESHOLDS.returnProbability * contextTokens * price(from) * cacheWrite : 0;
  return requests(to, true) + comeBack < stay;
}

/**
 * Smallest available tier at or above `tier` whose context window holds the conversation,
 * or null if none does. Unknown windows are assumed to fit.
 */
function fitWindow(tier, available, windows, contextTokens) {
  const fits = (t) => !windows?.[t] || contextTokens <= windows[t];
  return TIER_NAMES.slice(rankOf(tier)).find((t) => available.includes(t) && fits(t)) ?? null;
}

/**
 * Turns a Jev answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.jev  null when Jev failed
 * @param {string} input.current       tier currently active in the session
 * @param {string[]} input.available   tier names the account can run
 * @param {number} input.contextTokens approximate size of the conversation so far
 * @param {boolean} [input.cacheWarm]  whether the current tier's prompt cache is still alive
 * @param {Object<string, number>} [input.windows] context window per tier, when known
 * @param {?object} [input.quota]      fresh subscription usage snapshot (see quota.mjs)
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, jev, current, available, contextTokens = 0, cacheWarm = true, windows, quota }) {
  const settle = (tier, reason) => {
    let final = clampToAvailable(tier, available) ?? current;
    let why = final === tier ? reason : `${reason}+unavailable`;
    // Never send a turn to a tier it does not fit, even one the user named.
    const fitted = fitWindow(final, available, windows, contextTokens);
    if (fitted !== final) {
      final = fitted ?? current;
      why = `${why}+window`;
    }
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev || !TIER_NAMES.includes(jev.choice)) return settle(current, "jev-unavailable");

  let target = jev.choice;
  let reason = "jev";

  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) {
      target = TIER_NAMES[ceiling];
      reason = "low-confidence-capped";
    }
  }

  // Subscription usage: a tier whose own window is nearly spent steps down, and rising
  // overall usage lowers the strongest tier Jev may pick. The user's explicit choice above
  // is never capped; they may knowingly spend the rest of a window.
  const exhausted = exhaustedTiers(quota);
  if (exhausted.includes(target)) {
    const lower = TIER_NAMES.slice(0, rankOf(target)).filter((t) => available.includes(t) && !exhausted.includes(t));
    if (lower.length) {
      target = lower[lower.length - 1];
      reason = "quota-tier-exhausted";
    }
  }
  const quotaCap = quotaCeiling(quota);
  if (quotaCap && rankOf(target) > rankOf(quotaCap)) {
    target = quotaCap;
    reason = "quota-capped";
  }
  // Near the hard limit, staying on an expensive tier is what runs the window out, so the
  // cache-rebuild guard yields; below that, a forced downgrade must still pay for itself.
  const emergency = quota?.overall >= QUOTA.fastAbove;

  if (rankOf(target) < rankOf(current) && !emergency && !switchPays({ from: current, to: target, contextTokens, cacheWarm })) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, reason);
}
