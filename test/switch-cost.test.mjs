import test from "node:test";
import assert from "node:assert/strict";
import { decide, switchPays } from "../src/policy.mjs";
import { cacheTtlFor, cacheWarmFor, windowsFrom } from "../src/proxy.mjs";
import { codexWindows } from "../src/codex-proxy.mjs";
import { THRESHOLDS } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const base = { prompt: "rename this variable", available: ALL };

test("a small warm conversation can still drop from opus to haiku (#5)", () => {
  assert.equal(switchPays({ from: "opus", to: "haiku", contextTokens: 10000, cacheWarm: true }), true);
});

test("a large warm conversation stays put: the rewrite costs more than it saves", () => {
  assert.equal(switchPays({ from: "opus", to: "haiku", contextTokens: 80000, cacheWarm: true }), false);
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 80000, cacheWarm: true });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("a cold cache makes the same downgrade free", () => {
  assert.equal(switchPays({ from: "opus", to: "haiku", contextTokens: 80000, cacheWarm: false }), true);
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 80000, cacheWarm: false });
  assert.equal(out.tier, "haiku");
});

test("the break-even point moves with the price gap", () => {
  // opus -> sonnet saves less per token than opus -> haiku, so it stops paying sooner.
  const breakEven = (to) => {
    let tokens = 1000;
    while (switchPays({ from: "opus", to, contextTokens: tokens, cacheWarm: true })) tokens += 1000;
    return tokens;
  };
  assert.ok(breakEven("sonnet") < breakEven("haiku"));
});

test("upgrades are never blocked by cache cost", () => {
  const out = decide({ ...base, current: "haiku", jev: sure("opus"), contextTokens: 150000, cacheWarm: true });
  assert.equal(out.tier, "opus");
});

test("never routes to a tier whose window the conversation does not fit", () => {
  const windows = { haiku: 100000, sonnet: 200000, opus: 1000000 };
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 150000, cacheWarm: false, windows });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /window/);
});

test("the window guard applies to explicit overrides too", () => {
  const windows = { haiku: 100000, sonnet: 200000, opus: 1000000 };
  const out = decide({ ...base, prompt: "use haiku", current: "opus", jev: null, contextTokens: 150000, windows });
  assert.notEqual(out.tier, "haiku");
});

test("unknown windows are assumed to fit", () => {
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 5000, cacheWarm: false, windows: {} });
  assert.equal(out.tier, "haiku");
});

test("cache TTL follows the request's cache_control", () => {
  assert.equal(cacheTtlFor({ system: [{ cache_control: { type: "ephemeral" } }] }), THRESHOLDS.cacheTtlMs);
  assert.equal(
    cacheTtlFor({ system: [{ cache_control: { type: "ephemeral", ttl: "1h" } }] }),
    THRESHOLDS.cacheTtlLongMs,
  );
});

test("a conversation's cache is warm only within its TTL", () => {
  const now = 1_000_000_000;
  assert.equal(cacheWarmFor({}, THRESHOLDS.cacheTtlMs, now), false, "nothing answered yet");
  assert.equal(cacheWarmFor({ lastResponseAt: now - 60_000 }, THRESHOLDS.cacheTtlMs, now), true);
  assert.equal(cacheWarmFor({ lastResponseAt: now - 6 * 60_000 }, THRESHOLDS.cacheTtlMs, now), false);
  assert.equal(cacheWarmFor({ lastResponseAt: now - 6 * 60_000 }, THRESHOLDS.cacheTtlLongMs, now), true);
});

test("windows come from the account catalogs", () => {
  assert.deepEqual(
    windowsFrom([
      { id: "claude-haiku-4-5", max_input_tokens: 200000 },
      { id: "claude-opus-5", max_input_tokens: 200000 },
      { id: "claude-opus-5[1m]", max_input_tokens: 1000000 },
      { id: "unrelated" },
    ]),
    { haiku: 200000, opus: 1000000 },
  );
  assert.deepEqual(
    codexWindows(new Map([["gpt-5.6-luna", { slug: "gpt-5.6-luna", context_window: 272000 }]])),
    { haiku: 272000 },
  );
});
