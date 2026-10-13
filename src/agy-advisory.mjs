import { readFileSync, existsSync } from "node:fs";
import { askJev } from "./router.mjs";
import { detectOverride, trivialPrompt } from "./policy.mjs";
import { scrubPrompt } from "./scrub.mjs";
import { STATIC_AGY_MODELS, tierForAgyModelId } from "./agy.mjs";
import { rankOf } from "./config.mjs";

export const AGY_ADVISORY_HOOK_KEY = "jev-advisory-router";

/**
 * Reads the latest user message from an Antigravity transcript file.
 */
export function readLatestUserPrompt(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const item = JSON.parse(line);
        if (item.type === "USER_INPUT" && item.content) {
          return item.content;
        }
      } catch {
        // Continue searching
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Handles Antigravity PreInvocation hook payload.
 * When the current model is significantly stronger than needed, injects an ephemeral advisory message.
 */
export async function handleAgyPreInvocation(input, { ask = askJev } = {}) {
  const currentModel = input?.modelName ?? "";
  const currentTier = tierForAgyModelId(currentModel);
  const prompt = readLatestUserPrompt(input?.transcriptPath);

  if (!prompt) {
    return { injectSteps: [] };
  }

  // Check for overrides or trivial skips
  if (detectOverride(prompt)) {
    return { injectSteps: [] };
  }
  const skip = trivialPrompt(prompt);
  if (skip) {
    return { injectSteps: [] };
  }

  let jev = null;
  try {
    jev = await ask({
      prompt: scrubPrompt(prompt),
      current: currentTier,
      contextTokens: 0,
      models: STATIC_AGY_MODELS,
    });
  } catch {
    return { injectSteps: [] };
  }

  if (!jev || !jev.choice) {
    return { injectSteps: [] };
  }

  const chosenModel = STATIC_AGY_MODELS.find((m) => m.id === jev.choice);
  const chosenTier = chosenModel?.tier ?? "haiku";

  // Advise only if current model is higher rank than needed (e.g. running on opus/pro for a haiku/flash task)
  if (rankOf(currentTier) > rankOf(chosenTier) && (jev.confidence ?? 0) >= 0.7) {
    const recommended = chosenTier === "haiku" ? "gemini-3.8-flash" : "claude-sonnet-5.5";
    return {
      injectSteps: [
        {
          ephemeralMessage: `[Jev] Bilgi: Bu istek için daha ekonomik bir model (${recommended}) yeterli olabilir (/model ile değiştirebilirsiniz).`,
        },
      ],
    };
  }

  return { injectSteps: [] };
}

export function withAgyAdvisoryHook(config, command) {
  const next = structuredClone(config ?? {});
  next[AGY_ADVISORY_HOOK_KEY] = {
    PreInvocation: [
      {
        type: "command",
        command,
        timeout: 10,
      },
    ],
  };
  return { config: next, changed: true };
}

export function withoutAgyAdvisoryHook(config) {
  const next = structuredClone(config ?? {});
  if (!next[AGY_ADVISORY_HOOK_KEY]) {
    return { config: next, changed: false };
  }
  delete next[AGY_ADVISORY_HOOK_KEY];
  return { config: next, changed: true };
}
