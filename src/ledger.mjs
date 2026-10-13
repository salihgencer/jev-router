import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PRICES, DEFAULT_JEV_MODEL } from "./config.mjs";

export const DEFAULT_LEDGER_FILE = join(homedir(), ".jev-router", "ledger.jsonl");

export function ledgerPath(env = process.env) {
  return env.JEV_LEDGER_FILE || DEFAULT_LEDGER_FILE;
}

export function isShadowMode(env = process.env) {
  return env.JEV_MODE === "shadow";
}

/**
 * Calculates normalized relative cost units according to PRICES.
 */
export function calculateTierCost(tier, usage = {}) {
  const basePrice = PRICES[tier] ?? PRICES.sonnet;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const cost =
    input * basePrice +
    output * (basePrice * PRICES.outputRatio) +
    cacheWrite * (basePrice * PRICES.cacheWrite) +
    cacheRead * (basePrice * PRICES.cacheRead);

  // Return cost normalized per million tokens
  return cost / 1_000_000;
}

export function calculateCostComparisons(usage = {}) {
  return {
    haiku: calculateTierCost("haiku", usage),
    sonnet: calculateTierCost("sonnet", usage),
    opus: calculateTierCost("opus", usage),
  };
}

const PRIVATE = 0o600;

/**
 * Appends a decision record as a single JSONL line with mode 0600.
 */
export function recordDecision(entry, { file = ledgerPath() } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        jevModel: DEFAULT_JEV_MODEL,
        ...entry,
      }) + "\n";
    appendFileSync(file, line, { mode: PRIVATE });
    chmodSync(file, PRIVATE);
  } catch {
    // Non-fatal: logging failures must never disrupt routing
  }
}

/**
 * Reads all entries from the decision ledger.
 */
export function readLedger({ file = ledgerPath() } = {}) {
  if (!existsSync(file)) return [];
  try {
    const content = readFileSync(file, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Computes savings and usage analytics from ledger records.
 */
export function computeStats(records) {
  const byTier = { haiku: 0, sonnet: 0, opus: 0, other: 0 };
  const byMode = { shadow: 0, enforce: 0 };
  let totalDecisions = 0;
  let totalCostExecuted = 0;
  let baselineOpusCost = 0;
  let baselineSonnetCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalConfidence = 0;
  let confidenceCount = 0;

  for (const r of records) {
    totalDecisions++;
    const targetTier = r.targetTier ?? r.tier ?? "other";
    byTier[targetTier] = (byTier[targetTier] ?? 0) + 1;

    const mode = r.mode ?? "enforce";
    byMode[mode] = (byMode[mode] ?? 0) + 1;

    if (r.confidence != null && Number.isFinite(r.confidence)) {
      totalConfidence += r.confidence;
      confidenceCount++;
    }

    const usage = r.usage ?? {};
    totalInputTokens += usage.input_tokens ?? 0;
    totalOutputTokens += usage.output_tokens ?? 0;
    totalCacheReadTokens += usage.cache_read_input_tokens ?? 0;
    totalCacheWriteTokens += usage.cache_creation_input_tokens ?? 0;

    const executedTier = r.executedTier ?? (mode === "shadow" ? "sonnet" : targetTier);
    const executedCost = calculateTierCost(executedTier, usage);
    const opusCost = r.costs?.opus ?? calculateTierCost("opus", usage);
    const sonnetCost = r.costs?.sonnet ?? calculateTierCost("sonnet", usage);

    totalCostExecuted += executedCost;
    baselineOpusCost += opusCost;
    baselineSonnetCost += sonnetCost;
  }

  const savingsVsOpus = Math.max(0, baselineOpusCost - totalCostExecuted);
  const savingsPercentVsOpus = baselineOpusCost > 0 ? (savingsVsOpus / baselineOpusCost) * 100 : 0;
  const savingsVsSonnet = baselineSonnetCost - totalCostExecuted;
  const savingsPercentVsSonnet = baselineSonnetCost > 0 ? (savingsVsSonnet / baselineSonnetCost) * 100 : 0;

  return {
    totalDecisions,
    byTier,
    byMode,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    averageConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
    totalCostExecuted,
    baselineOpusCost,
    baselineSonnetCost,
    savingsVsOpus,
    savingsPercentVsOpus,
    savingsVsSonnet,
    savingsPercentVsSonnet,
  };
}

export function formatStats(stats) {
  const lines = [];
  lines.push("╔═════════════════════════════════════════════════════════════════╗");
  lines.push("║                 Jev Router Decision Ledger                      ║");
  lines.push("╚═════════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`Total Decisions:         ${stats.totalDecisions} (Enforce: ${stats.byMode.enforce}, Shadow: ${stats.byMode.shadow})`);
  lines.push(`Target Tiers Chosen:     Haiku: ${stats.byTier.haiku} | Sonnet: ${stats.byTier.sonnet} | Opus: ${stats.byTier.opus}`);
  lines.push(`Average Jev Confidence:  ${(stats.averageConfidence * 100).toFixed(1)}%`);
  lines.push("");
  lines.push("--- Token & Cache Breakdown ---");
  lines.push(`Input Tokens:            ${stats.totalInputTokens.toLocaleString()}`);
  lines.push(`Output Tokens:           ${stats.totalOutputTokens.toLocaleString()}`);
  lines.push(`Cache Read Tokens:       ${stats.totalCacheReadTokens.toLocaleString()}`);
  lines.push(`Cache Write Tokens:      ${stats.totalCacheWriteTokens.toLocaleString()}`);
  lines.push("");
  lines.push("--- Cost & Savings Analysis (Relative Units) ---");
  lines.push(`Executed Cost:           ${stats.totalCostExecuted.toFixed(4)}`);
  lines.push(`Baseline (All Opus):     ${stats.baselineOpusCost.toFixed(4)}`);
  lines.push(`Baseline (All Sonnet):   ${stats.baselineSonnetCost.toFixed(4)}`);
  lines.push(`Savings vs Opus:         ${stats.savingsVsOpus.toFixed(4)} (${stats.savingsPercentVsOpus.toFixed(1)}% saved)`);
  if (stats.savingsVsSonnet > 0) {
    lines.push(`Savings vs Sonnet:       ${stats.savingsVsSonnet.toFixed(4)} (${stats.savingsPercentVsSonnet.toFixed(1)}% saved)`);
  }
  lines.push("═════════════════════════════════════════════════════════════════");
  return lines.join("\n");
}
