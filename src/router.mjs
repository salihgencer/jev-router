import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  questionForModels,
  THRESHOLDS,
  jevModel,
} from "./config.mjs";
import { log } from "./log.mjs";
import { scrubPrompt } from "./scrub.mjs";

/**
 * Client settings. The SDK's defaults (10s per attempt, 2 retries, no total budget) are far
 * too slow for a per-prompt hot path, so the timeout, retry count and an outer deadline are
 * all pinned, and so is the Jev model version the thresholds were tuned on.
 */
export function clientConfig(env = process.env) {
  return {
    apiKey: env.JEV_API_KEY ?? env.TYPESAFE_API_KEY,
    defaultModel: jevModel(env),
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  };
}

// Built lazily because the constructor throws when no key is present, and a missing key
// should degrade to "no routing", not stop the session from starting.
let client;
function getClient() {
  client ??= new TypeSafeClient(clientConfig());
  return client;
}

/**
 * Stops calling Jev for a short while after a failure. Without it every prompt during an
 * outage would wait out the full deadline before falling back; with it only the first one
 * does, and the next calls are skipped until the cool-down has passed.
 */
export class CircuitBreaker {
  constructor({ cooldownMs = THRESHOLDS.jevCircuitCooldownMs, now = Date.now } = {}) {
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.openUntil = 0;
  }

  isOpen() {
    return this.now() < this.openUntil;
  }

  failure() {
    this.openUntil = this.now() + this.cooldownMs;
  }

  success() {
    this.openUntil = 0;
  }
}

/** Shared by both proxies, since they talk to the same Jev endpoint. */
export const jevCircuit = new CircuitBreaker();

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askJev({ prompt, current, contextTokens, models, circuit = jevCircuit }) {
  if (!models?.length || circuit.isOpen()) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  const request = {
    state: {
      request: scrubPrompt(prompt), // idempotent backstop for callers that skipped it
      session: { current_model: current, context_tokens: contextTokens },
      environment: { available_models: models.map((model) => model.id) },
    },
    questions: { ...QUESTIONS, model: questionForModels(models) },
  };
  try {
    const result = await getClient().systemOne(request, { signal: abort.signal });
    circuit.success();
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    return {
      ...answer,
      jevModel: result.model ?? jevModel(),
      request,
      response: result,
      metrics: {
        taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    circuit.failure();
    log(`routing failed, keeping ${current}; pausing Jev for ${circuit.cooldownMs / 1000}s: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
