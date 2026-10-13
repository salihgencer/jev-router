import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { askJev } from "./router.mjs";
import { detectOverride, trivialPrompt } from "./policy.mjs";
import { scrubPrompt } from "./scrub.mjs";
import { THRESHOLDS } from "./config.mjs";

export const AGY_SUBAGENT_HOOK_KEY = "jev-subagent-router";

export const AGY_SUBAGENT_MODELS = [
  { id: "flash_lite", tier: "haiku", description: "Very light, fast model for simple lookups, search and file reading" },
  { id: "flash", tier: "sonnet", description: "Balanced model for code generation and multi-step tasks" },
  { id: "pro", tier: "opus", description: "Deep reasoning, large refactors, multi-step planning" },
];

const TIER_TO_AGY_MODEL = {
  haiku: "flash_lite",
  sonnet: "flash",
  opus: "pro",
};

/**
 * Evaluates a single subagent specification to determine the best Model.
 * If Model was explicitly set to anything other than "inherit" (or empty), it is preserved.
 */
export async function routeSubagent(subagent, { ask = askJev } = {}) {
  const currentModel = subagent.Model;
  // If caller explicitly specified a model other than "inherit", don't touch it
  if (currentModel && currentModel !== "inherit") {
    return { model: currentModel, changed: false, reason: "explicit-model" };
  }

  const brief = [subagent.Role, subagent.Prompt].filter(Boolean).join("\n\n");
  if (!brief.trim()) {
    return { model: "flash_lite", changed: true, reason: "empty" };
  }

  // Check for explicit tier override in the brief
  const override = detectOverride(brief);
  if (override) {
    const model = TIER_TO_AGY_MODEL[override] ?? "flash";
    return { model, changed: true, reason: "override" };
  }

  // Check for trivial prompt / go-aheads
  const skip = trivialPrompt(brief);
  if (skip) {
    return { model: "flash_lite", changed: true, reason: `skip-${skip}` };
  }

  try {
    const jev = await ask({
      prompt: scrubPrompt(brief),
      current: "flash",
      contextTokens: 0,
      models: AGY_SUBAGENT_MODELS,
    });

    if (!jev || (jev.confidence ?? 1) < THRESHOLDS.minConfidence) {
      return { model: "flash", changed: true, reason: "low-confidence" };
    }

    const matched = AGY_SUBAGENT_MODELS.find(
      (m) => m.id === jev.choice || m.tier === jev.choice,
    );
    const chosen = matched?.id ?? "flash";
    return { model: chosen, changed: true, reason: "jev", confidence: jev.confidence };
  } catch {
    // Fail-open: default to flash
    return { model: "flash", changed: true, reason: "jev-failed" };
  }
}

/**
 * Handles Antigravity PreToolUse hook payload for `invoke_subagent`.
 */
export async function handleAgyPreToolUse(input, { ask = askJev } = {}) {
  if (input?.toolCall?.name !== "invoke_subagent") {
    return { decision: "allow" };
  }

  const subs = input?.toolCall?.args?.Subagents;
  if (!Array.isArray(subs) || !subs.length) {
    return { decision: "allow" };
  }

  let anyChanged = false;
  const updatedSubs = [];

  for (const sub of subs) {
    const decision = await routeSubagent(sub, { ask });
    if (decision.changed && decision.model !== sub.Model) {
      anyChanged = true;
      updatedSubs.push({ ...sub, Model: decision.model });
    } else {
      updatedSubs.push(sub);
    }
  }

  if (anyChanged) {
    return {
      decision: "allow",
      overwrite: {
        ...input.toolCall.args,
        Subagents: updatedSubs,
      },
    };
  }

  return { decision: "allow" };
}

export function defaultAgyHooksPath() {
  return join(homedir(), ".gemini", "antigravity-cli", "hooks.json");
}

export function withAgyHook(config, command) {
  const next = structuredClone(config ?? {});
  next[AGY_SUBAGENT_HOOK_KEY] = {
    PreToolUse: [
      {
        matcher: "invoke_subagent",
        hooks: [
          {
            type: "command",
            command,
            timeout: 10,
          },
        ],
      },
    ],
  };
  return { config: next, changed: true };
}

export function withoutAgyHook(config) {
  const next = structuredClone(config ?? {});
  if (!next[AGY_SUBAGENT_HOOK_KEY]) {
    return { config: next, changed: false };
  }
  delete next[AGY_SUBAGENT_HOOK_KEY];
  return { config: next, changed: true };
}
