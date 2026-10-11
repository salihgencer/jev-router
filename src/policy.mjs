import { TIER_NAMES, THRESHOLDS, TIER_ALIASES, rankOf } from "./config.mjs";

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
 * Turns a Jev answer into the model we will actually run. Pure and total: any missing,
 * malformed, or unavailable input falls back to the model already in use.
 *
 * @param {object} input
 * @param {string} input.prompt        raw user prompt, for explicit-override detection
 * @param {?{choice: string, confidence: number}} input.jev  null when Jev failed
 * @param {string} input.current       tier currently active in the session
 * @param {string[]} input.available   tier names the account can run
 * @param {number} input.contextTokens approximate size of the conversation so far
 * @returns {{tier: string, reason: string, changed: boolean}}
 */
export function decide({ prompt, jev, current, available, contextTokens = 0 }) {
  const settle = (tier, reason) => {
    const final = clampToAvailable(tier, available) ?? current;
    const why = final === tier ? reason : `${reason}+unavailable`;
    return { tier: final, reason: final === current ? `${why}/no-change` : why, changed: final !== current };
  };

  const override = detectOverride(prompt);
  if (override) return settle(override, "override");

  if (!jev || !TIER_NAMES.includes(jev.choice)) return settle(current, "jev-unavailable");

  let target = jev.choice;

  if (jev.confidence < THRESHOLDS.minConfidence) {
    if (rankOf(target) < rankOf(current)) return settle(current, "low-confidence-no-downgrade");
    const ceiling = Math.max(rankOf(current), rankOf(THRESHOLDS.uncertainCeiling));
    if (rankOf(target) > ceiling) return settle(TIER_NAMES[ceiling], "low-confidence-capped");
  }

  if (rankOf(target) < rankOf(current) && contextTokens > THRESHOLDS.downgradeMaxContextTokens) {
    return settle(current, "downgrade-not-worth-cache-rebuild");
  }

  return settle(target, "jev");
}
