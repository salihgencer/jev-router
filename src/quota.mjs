/**
 * Subscription usage read from upstream response headers.
 *
 * Anthropic returns `anthropic-ratelimit-unified-<window>-utilization` (0..1) for subscription
 * traffic, with windows such as `5h` and `7d`, plus model-specific windows on some plans
 * (e.g. `7d_opus`). Codex's ChatGPT backend returns `x-codex-<primary|secondary>-used-percent`
 * (0..100). Header names are not a public contract: anything unrecognised is ignored, and
 * a response without them leaves the last reading in place.
 */

import { TIER_NAMES } from "./config.mjs";

export const QUOTA = {
  /** Above this overall utilization the strongest tier Jev can pick is `sonnet`. */
  balancedAbove: 0.8,
  /** Above this, only `haiku` unless the user names a tier. */
  fastAbove: 0.95,
  /** A tier whose own window is above this is not picked by Jev. */
  tierExhaustedAbove: 0.9,
  /** Readings older than this are ignored; windows roll over. */
  maxAgeMs: 30 * 60 * 1000,
};

const ANTHROPIC = /^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/i;
const CODEX = /^x-codex-([a-z0-9_]+)-used-percent$/i;

/** Usage snapshot from one response's headers, or null if it carries none. */
export function parseQuota(headers = {}, now = Date.now()) {
  const windows = {};
  for (const [name, raw] of Object.entries(headers)) {
    const value = Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isFinite(value)) continue;
    let m = ANTHROPIC.exec(name);
    if (m) windows[m[1].toLowerCase()] = value;
    else if ((m = CODEX.exec(name))) windows[m[1].toLowerCase()] = value / 100;
  }
  if (!Object.keys(windows).length) return null;

  const perTier = {};
  let overall = 0;
  for (const [window, value] of Object.entries(windows)) {
    const tier = TIER_NAMES.find((t) => window.includes(t));
    if (tier) perTier[tier] = Math.max(perTier[tier] ?? 0, value);
    else overall = Math.max(overall, value);
  }
  return { overall, perTier, windows, at: now };
}

/** A snapshot still worth acting on, or null. */
export const freshQuota = (quota, now = Date.now()) =>
  quota && now - quota.at <= QUOTA.maxAgeMs ? quota : null;

/** Strongest tier the account should spend on right now, or null for no limit. */
export function quotaCeiling(quota) {
  if (!quota) return null;
  if (quota.overall >= QUOTA.fastAbove) return "haiku";
  if (quota.overall >= QUOTA.balancedAbove) return "sonnet";
  return null;
}

/** Tiers whose own window is nearly used up. */
export const exhaustedTiers = (quota) =>
  Object.entries(quota?.perTier ?? {})
    .filter(([, value]) => value >= QUOTA.tierExhaustedAbove)
    .map(([tier]) => tier);

/** Short label for the status line, e.g. "5h 82%", or "" when usage is unremarkable. */
export function quotaLabel(quota, showAbove = 0.5) {
  if (!quota?.windows) return "";
  const [window, value] = Object.entries(quota.windows).sort((a, b) => b[1] - a[1])[0] ?? [];
  return window && value >= showAbove ? `${window} ${Math.round(value * 100)}%` : "";
}
