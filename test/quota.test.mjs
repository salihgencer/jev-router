import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { parseQuota, freshQuota, quotaCeiling, exhaustedTiers, quotaLabel, QUOTA } from "../src/quota.mjs";
import { decide } from "../src/policy.mjs";
import { startProxy } from "../src/proxy.mjs";

const ALL = ["haiku", "sonnet", "opus"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const base = { prompt: "design the sync protocol", available: ALL, contextTokens: 1000, cacheWarm: false };
const q = (overall, perTier = {}) => ({ overall, perTier, windows: { "5h": overall }, at: Date.now() });

test("parses Anthropic unified utilization headers (#8)", () => {
  const quota = parseQuota({
    "anthropic-ratelimit-unified-5h-utilization": "0.82",
    "anthropic-ratelimit-unified-7d-utilization": "0.40",
    "anthropic-ratelimit-unified-7d_opus-utilization": "0.93",
    "anthropic-ratelimit-unified-status": "allowed",
    "content-type": "text/event-stream",
  });
  assert.equal(quota.overall, 0.82);
  assert.deepEqual(quota.perTier, { opus: 0.93 });
  assert.deepEqual(quota.windows, { "5h": 0.82, "7d": 0.4, "7d_opus": 0.93 });
});

test("parses Codex used-percent headers", () => {
  const quota = parseQuota({ "x-codex-primary-used-percent": "64", "x-codex-secondary-used-percent": "12.5" });
  assert.equal(quota.overall, 0.64);
});

test("a response without usage headers yields no snapshot", () => {
  assert.equal(parseQuota({ "content-type": "application/json" }), null);
  assert.equal(parseQuota({ "anthropic-ratelimit-unified-5h-utilization": "n/a" }), null);
});

test("old snapshots are ignored", () => {
  const now = Date.now();
  assert.equal(freshQuota({ at: now - QUOTA.maxAgeMs - 1 }, now), null);
  assert.ok(freshQuota({ at: now - 1000 }, now));
  assert.equal(freshQuota(null), null);
});

test("ceiling tightens as usage rises", () => {
  assert.equal(quotaCeiling(q(0.5)), null);
  assert.equal(quotaCeiling(q(0.85)), "sonnet");
  assert.equal(quotaCeiling(q(0.97)), "haiku");
  assert.equal(quotaCeiling(null), null);
  assert.deepEqual(exhaustedTiers(q(0.2, { opus: 0.95, sonnet: 0.3 })), ["opus"]);
});

test("plenty of quota leaves Jev's pick alone", () => {
  assert.equal(decide({ ...base, current: "sonnet", jev: sure("opus"), quota: q(0.3) }).tier, "opus");
});

test("high usage caps a Jev upgrade at sonnet", () => {
  const out = decide({ ...base, current: "sonnet", jev: sure("opus"), quota: q(0.85) });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /quota-capped/);
});

test("near the limit only haiku is used, even against the cache guard", () => {
  const out = decide({ ...base, current: "opus", jev: sure("opus"), contextTokens: 150000, cacheWarm: true, quota: q(0.97) });
  assert.equal(out.tier, "haiku");
});

test("below the emergency line a forced downgrade must still pay for itself", () => {
  const out = decide({ ...base, current: "opus", jev: sure("opus"), contextTokens: 150000, cacheWarm: true, quota: q(0.85) });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("a tier whose own window is spent steps down", () => {
  const out = decide({ ...base, current: "sonnet", jev: sure("opus"), quota: q(0.2, { opus: 0.95 }) });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /quota-tier-exhausted/);
});

test("the user's explicit choice is never capped by quota", () => {
  const out = decide({ ...base, prompt: "use opus", current: "sonnet", jev: sure("haiku"), quota: q(0.97) });
  assert.equal(out.tier, "opus");
});

test("status line label appears only once usage is notable", () => {
  assert.equal(quotaLabel(q(0.3)), "");
  assert.equal(quotaLabel({ windows: { "5h": 0.82, "7d": 0.4 } }), "5h 82%");
  assert.equal(quotaLabel(undefined), "");
});

test("the proxy learns usage from response headers and caps the next turn", async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(JSON.parse(Buffer.concat(chunks)).model);
      res.setHeader("content-type", "application/json");
      res.setHeader("anthropic-ratelimit-unified-5h-utilization", "0.88");
      res.end('{"usage":{"input_tokens":10}}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-opus-5", confidence: 0.95, ms: 1 }),
  });
  t.after(close);

  const send = (text) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jev-router",
        tools: [{ name: "Bash" }],
        messages: [{ role: "user", content: `${text} ${process.pid}` }],
      }),
    }).then((r) => r.text());

  await send("first conversation");
  await send("second conversation");
  assert.equal(seen[0], "claude-opus-5", "no usage known yet");
  assert.equal(seen[1], "claude-sonnet-5", "88% usage caps opus at sonnet");
});
