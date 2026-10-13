import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  isShadowMode,
  calculateTierCost,
  calculateCostComparisons,
  recordDecision,
  readLedger,
  computeStats,
  formatStats,
} from "../src/ledger.mjs";
import { startProxy } from "../src/proxy.mjs";
import { PRICES } from "../src/config.mjs";

const STATS_BIN = fileURLToPath(new URL("../bin/jev-stats.mjs", import.meta.url));

test("isShadowMode detects JEV_MODE env (#16)", () => {
  assert.equal(isShadowMode({ JEV_MODE: "shadow" }), true);
  assert.equal(isShadowMode({ JEV_MODE: "enforce" }), false);
  assert.equal(isShadowMode({}), false);
});

test("calculateTierCost computes weighted cost based on PRICES", () => {
  const usage = {
    input_tokens: 1_000_000,
    output_tokens: 100_000,
    cache_creation_input_tokens: 200_000,
    cache_read_input_tokens: 500_000,
  };

  // Sonnet base price = 3
  const expectedSonnet =
    (1_000_000 * 3 +
      100_000 * (3 * PRICES.outputRatio) +
      200_000 * (3 * PRICES.cacheWrite) +
      500_000 * (3 * PRICES.cacheRead)) /
    1_000_000;

  assert.equal(calculateTierCost("sonnet", usage), expectedSonnet);
  assert.ok(calculateTierCost("opus", usage) > calculateTierCost("haiku", usage));
});

test("calculateCostComparisons provides haiku, sonnet, and opus estimates", () => {
  const comp = calculateCostComparisons({ input_tokens: 100_000 });
  assert.ok(comp.haiku < comp.sonnet);
  assert.ok(comp.sonnet < comp.opus);
});

test("recordDecision writes valid JSONL with file mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-ledger-test-"));
  const file = join(dir, "ledger.jsonl");

  recordDecision({ sessionKey: "s1", targetTier: "haiku" }, { file });
  recordDecision({ sessionKey: "s2", targetTier: "opus" }, { file });

  const records = readLedger({ file });
  assert.equal(records.length, 2);
  assert.equal(records[0].sessionKey, "s1");
  assert.equal(records[0].targetTier, "haiku");
  assert.equal(records[1].sessionKey, "s2");

  if (process.platform !== "win32") {
    const mode = statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test("computeStats calculates savings and aggregates correctly", () => {
  const records = [
    {
      targetTier: "haiku",
      executedTier: "haiku",
      mode: "enforce",
      confidence: 0.9,
      usage: { input_tokens: 100_000, output_tokens: 10_000 },
      costs: { haiku: 1, sonnet: 3, opus: 5 },
    },
    {
      targetTier: "opus",
      executedTier: "opus",
      mode: "enforce",
      confidence: 0.95,
      usage: { input_tokens: 100_000, output_tokens: 10_000 },
      costs: { haiku: 1, sonnet: 3, opus: 5 },
    },
  ];

  const stats = computeStats(records);
  assert.equal(stats.totalDecisions, 2);
  assert.equal(stats.byTier.haiku, 1);
  assert.equal(stats.byTier.opus, 1);
  assert.equal(stats.byMode.enforce, 2);
  assert.ok(stats.savingsVsOpus > 0);
  assert.ok(stats.savingsPercentVsOpus > 0);

  const formatted = formatStats(stats);
  assert.match(formatted, /Jev Router Decision Ledger/);
  assert.match(formatted, /Total Decisions:\s+2/);
  assert.match(formatted, /Savings vs Opus/);
});

test("jev-stats CLI prints formatted stats from ledger file", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-stats-cli-"));
  const file = join(dir, "ledger.jsonl");

  writeFileSync(
    file,
    JSON.stringify({
      targetTier: "haiku",
      executedTier: "haiku",
      mode: "enforce",
      confidence: 0.9,
      usage: { input_tokens: 50_000, output_tokens: 5_000 },
      costs: { haiku: 0.5, sonnet: 1.5, opus: 2.5 },
    }) + "\n",
  );

  const out = execFileSync(process.execPath, [STATS_BIN, file], { encoding: "utf8" });
  assert.match(out, /Jev Router Decision Ledger/);
  assert.match(out, /Total Decisions:\s+1/);
});

test("proxy records decision to ledger and honors JEV_MODE=shadow", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-proxy-ledger-"));
  const ledgerFile = join(dir, "test-ledger.jsonl");

  const originalLedger = process.env.JEV_LEDGER_FILE;
  const originalMode = process.env.JEV_MODE;
  process.env.JEV_LEDGER_FILE = ledgerFile;
  process.env.JEV_MODE = "shadow";

  t.after(() => {
    if (originalLedger !== undefined) process.env.JEV_LEDGER_FILE = originalLedger;
    else delete process.env.JEV_LEDGER_FILE;
    if (originalMode !== undefined) process.env.JEV_MODE = originalMode;
    else delete process.env.JEV_MODE;
  });

  const seenModels = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seenModels.push(JSON.parse(Buffer.concat(chunks)).model);
      res.setHeader("content-type", "application/json");
      res.end('{"model":"claude-sonnet-5","usage":{"input_tokens":5000,"output_tokens":200}}');
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());

  const { port, close } = await startProxy({
    upstreamURL: `http://127.0.0.1:${upstream.address().port}`,
    route: async () => ({ choice: "claude-haiku-4-5-20251001", confidence: 0.95, ms: 2 }),
  });
  t.after(close);

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-router",
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: `refactor code ${process.pid}` }],
    }),
  });
  await res.text();

  // In shadow mode, the proxy should NOT rewrite to haiku; it runs on baseline (sonnet)
  assert.equal(seenModels.length, 1);
  assert.equal(seenModels[0], "claude-sonnet-5");

  // Verify ledger entry
  const entries = readLedger({ file: ledgerFile });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].mode, "shadow");
  assert.equal(entries[0].targetTier, "haiku");
  assert.equal(entries[0].executedModel, "claude-sonnet-5");
  assert.equal(entries[0].confidence, 0.95);
  assert.ok(entries[0].costs);
});
