import { spawn, execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { askJev } from "./router.mjs";
import { decide, trivialPrompt, detectOverride } from "./policy.mjs";
import { TIER_NAMES } from "./config.mjs";

export const STATIC_AGY_MODELS = [
  { id: "gemini-3.8-flash-low", tier: "haiku", description: "Gemini 3.8 Flash (Low)" },
  { id: "gemini-3.8-flash-medium", tier: "haiku", description: "Gemini 3.8 Flash (Medium)" },
  { id: "claude-sonnet-5-5-medium", tier: "sonnet", description: "Claude Sonnet 5.5 (Medium)" },
  { id: "claude-opus-5-5-high", tier: "opus", description: "Claude Opus 5.5 (High)" },
];

export const DEFAULT_AGY_MODEL_CACHE = join(tmpdir(), "jev-agy-models.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function tierForAgyModelId(id) {
  const lower = id.toLowerCase();
  if (lower.includes("flash") || lower.includes("haiku") || lower.includes("lite")) return "haiku";
  if (lower.includes("opus")) return "opus";
  return "sonnet";
}

/**
 * Parses raw text from `agy models` into a structured list of model candidates.
 */
export function parseAgyModels(text) {
  if (!text || typeof text !== "string") return [];
  const models = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    // Strip ansi escape codes and spinner characters
    const clean = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
    // Look for lines like "gemini-3.8-flash-low     Gemini 3.8 Flash (Low)"
    const match = /^(gemini|claude|gpt|o\d)-([a-z0-9.-]+)\s+(.+)$/i.exec(clean);
    if (match) {
      const id = `${match[1]}-${match[2]}`.toLowerCase();
      const description = match[3].trim();
      const tier = tierForAgyModelId(id);
      models.push({ id, tier, description });
    }
  }
  return models;
}

/**
 * Loads available Antigravity models, checking disk cache first then running `agy models`.
 * Falls back to `STATIC_AGY_MODELS` if command fails or returns no models.
 */
export function loadAgyModels({
  cachePath = DEFAULT_AGY_MODEL_CACHE,
  exec = execFileSync,
  now = Date.now,
} = {}) {
  try {
    const raw = readFileSync(cachePath, "utf8");
    const cached = JSON.parse(raw);
    if (cached?.at && now() - cached.at < CACHE_TTL_MS && Array.isArray(cached.models) && cached.models.length) {
      return cached.models;
    }
  } catch {
    // Cache miss or unreadable
  }

  try {
    const stdout = exec("agy", ["models"], { encoding: "utf8", timeout: 8000 });
    const parsed = parseAgyModels(stdout);
    if (parsed.length) {
      try {
        mkdirSync(dirname(cachePath), { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ at: now(), models: parsed }));
      } catch {
        // Cache write failed, non-fatal
      }
      return parsed;
    }
  } catch {
    // Execution failed, fall back
  }

  return STATIC_AGY_MODELS;
}

export function extractPromptFromArgs(args) {
  if (!Array.isArray(args)) return null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-p" || arg === "--print" || arg === "--prompt" || arg === "-i" || arg === "--prompt-interactive") {
      return args[i + 1] ?? null;
    }
    for (const prefix of ["-p=", "--print=", "--prompt=", "-i=", "--prompt-interactive="]) {
      if (arg.startsWith(prefix)) {
        return arg.slice(prefix.length);
      }
    }
  }
  return null;
}

export function hasModelArg(args) {
  if (!Array.isArray(args)) return false;
  return args.some(
    (arg) => arg === "--model" || arg === "-m" || arg.startsWith("--model=") || arg.startsWith("-m="),
  );
}

export function pickBestModelForTier(tier, models = STATIC_AGY_MODELS) {
  const matches = models.filter((m) => m.tier === tier);
  if (!matches.length) return models[0]?.id ?? "gemini-3.8-flash-low";
  // For opus prefer high effort/confidence, for haiku prefer low/medium
  if (tier === "opus") {
    const high = matches.find((m) => m.id.includes("high"));
    return (high ?? matches[0]).id;
  }
  if (tier === "haiku") {
    const low = matches.find((m) => m.id.includes("low"));
    return (low ?? matches[0]).id;
  }
  // For sonnet prefer medium
  const med = matches.find((m) => m.id.includes("medium"));
  return (med ?? matches[0]).id;
}

/**
 * Decides an Antigravity model for an initial prompt using Jev and policy.
 */
export async function routeAgyPrompt({
  prompt,
  models = STATIC_AGY_MODELS,
  ask = askJev,
  quota = null,
} = {}) {
  const override = detectOverride(prompt);
  const skip = override ? null : trivialPrompt(prompt);
  // Pick representative candidates for Jev (one per tier)
  const candidateTiers = ["haiku", "sonnet", "opus"];
  const candidateModels = candidateTiers
    .map((tier) => models.find((m) => m.tier === tier) || STATIC_AGY_MODELS.find((m) => m.tier === tier))
    .filter(Boolean);

  let jev = null;
  if (!override && !skip) {
    try {
      jev = await ask({
        prompt,
        current: "gemini-3.8-flash-medium",
        contextTokens: 0,
        models: candidateModels,
      });
    } catch {
      jev = null;
    }
  }

  const chosenCandidate = candidateModels.find((m) => m.id === jev?.choice);
  const tierAnswer = jev && { ...jev, choice: chosenCandidate?.tier ?? jev.choice };

  const decision = decide({
    prompt,
    jev: tierAnswer,
    current: "haiku",
    available: candidateTiers,
    contextTokens: 0,
    cacheWarm: false,
    quota,
    skip,
  });

  const chosenModelId = pickBestModelForTier(decision.tier, models);
  return {
    tier: decision.tier,
    modelId: chosenModelId,
    reason: decision.reason,
    confidence: jev?.confidence ?? null,
  };
}

export function resolveAgy() {
  const win = process.platform === "win32";
  const exts = win ? [".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `agy${ext}`);
      try {
        accessSync(file, constants.X_OK);
        return { file, shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Keep looking
      }
    }
  }
  return null;
}

export function loadEnv() {
  for (const file of [
    join(process.cwd(), ".env"),
    join(homedir(), ".jev-router.env"),
    join(homedir(), ".jev-claude.env"),
  ]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Ignored
    }
  }
}

export async function runAgy({
  argv = process.argv.slice(2),
  env = process.env,
  resolve = resolveAgy,
  load = loadEnv,
  spawnFn = spawn,
} = {}) {
  load();
  const agy = resolve();
  if (!agy) {
    process.stderr.write(
      "[jev] Google Antigravity is not installed, or `agy` is not on your PATH.\n" +
        "[jev] jev-agy runs the real agy CLI; install it first:\n" +
        "[jev]   https://antigravity.google/docs\n",
    );
    process.exitCode = 1;
    return;
  }

  let childArgs = [...argv];
  const hasModel = hasModelArg(argv);
  const prompt = extractPromptFromArgs(argv);

  const hasApiKey = Boolean(env.JEV_API_KEY || env.TYPESAFE_API_KEY);

  if (!hasModel && prompt && hasApiKey) {
    try {
      const models = loadAgyModels();
      const decision = await routeAgyPrompt({ prompt, models });
      if (decision?.modelId) {
        childArgs.unshift("--model", decision.modelId);
        if (process.stdout.isTTY || env.JEV_DEBUG) {
          process.stderr.write(
            `[jev] routed to ${decision.modelId} (${decision.reason}${decision.confidence ? ` p=${decision.confidence.toFixed(2)}` : ""})\n`,
          );
        }
      }
    } catch (err) {
      // Fail open: launch agy with default model
      process.stderr.write(`[jev] routing failed, continuing with default model: ${err.message}\n`);
    }
  }

  const child = spawnFn(
    agy.file,
    agy.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: agy.shell, env },
  );

  child.on("error", (err) => {
    process.stderr.write(`[jev] could not start agy: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
