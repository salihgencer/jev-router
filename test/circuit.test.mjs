import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { CircuitBreaker, askJev } from "../src/router.mjs";
import { decide } from "../src/policy.mjs";
import { startProxy } from "../src/proxy.mjs";
import { THRESHOLDS } from "../src/config.mjs";

const clock = (start = 1_000_000) => {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
};

test("the breaker opens on failure and closes after the cool-down (#11)", () => {
  const now = clock();
  const breaker = new CircuitBreaker({ cooldownMs: 30_000, now });
  assert.equal(breaker.isOpen(), false);
  breaker.failure();
  assert.equal(breaker.isOpen(), true);
  now.advance(29_999);
  assert.equal(breaker.isOpen(), true);
  now.advance(1);
  assert.equal(breaker.isOpen(), false);
});

test("a success closes the breaker at once", () => {
  const breaker = new CircuitBreaker({ now: clock() });
  breaker.failure();
  breaker.success();
  assert.equal(breaker.isOpen(), false);
});

test("the default cool-down is 30 seconds", () => {
  assert.equal(THRESHOLDS.jevCircuitCooldownMs, 30_000);
  assert.equal(new CircuitBreaker().cooldownMs, 30_000);
});

test("a failed Jev call opens the breaker, and an open breaker skips the call", async (t) => {
  const saved = { a: process.env.JEV_API_KEY, b: process.env.TYPESAFE_API_KEY };
  delete process.env.JEV_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => {
    if (saved.a !== undefined) process.env.JEV_API_KEY = saved.a;
    if (saved.b !== undefined) process.env.TYPESAFE_API_KEY = saved.b;
  });

  const now = clock();
  const circuit = new CircuitBreaker({ now });
  const models = [{ id: "claude-opus-5", tier: "opus" }];
  const ask = () => askJev({ prompt: "design it", current: "opus", contextTokens: 0, models, circuit });

  assert.equal(await ask(), null, "no key: the call fails and degrades to null");
  assert.equal(circuit.isOpen(), true);
  const opened = circuit.openUntil;
  assert.equal(await ask(), null);
  assert.equal(circuit.openUntil, opened, "the open breaker short-circuits without a new attempt");
});

test("an open breaker is reported as jev-circuit-open and keeps the tier", () => {
  const out = decide({ prompt: "design the sync protocol", jev: null, current: "sonnet", available: ["haiku", "sonnet", "opus"], skip: "circuit" });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /^jev-circuit-open/);
});

test("the proxy does not wait on Jev while the breaker is open", async (t) => {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end('{"usage":{"input_tokens":10}}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const circuit = new CircuitBreaker({ now: clock() });
  circuit.failure();
  let calls = 0;
  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => {
      calls++;
      return { choice: "claude-haiku-4-5", confidence: 0.95, ms: 1 };
    },
    circuit,
  });
  t.after(close);

  await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: `design the sync protocol ${process.pid}` }],
    }),
  }).then((r) => r.text());
  assert.equal(calls, 0);
});
