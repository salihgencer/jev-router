import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAgyModels,
  loadAgyModels,
  extractPromptFromArgs,
  hasModelArg,
  pickBestModelForTier,
  routeAgyPrompt,
  STATIC_AGY_MODELS,
} from "../src/agy.mjs";

const SAMPLE_AGY_OUTPUT = `
Fetching available models...
gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
gemini-3.8-flash-low      Gemini 3.8 Flash (Low)
claude-opus-5-5-low       Claude Opus 5.5 (Low)
claude-opus-5-5-medium    Claude Opus 5.5 (Medium)
claude-opus-5-5-high      Claude Opus 5.5 (High)
claude-sonnet-5-5-low     Claude Sonnet 5.5 (Low)
claude-sonnet-5-5-medium  Claude Sonnet 5.5 (Medium)
claude-sonnet-5-5-high    Claude Sonnet 5.5 (High)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`;

test("parseAgyModels parses catalog and assigns correct tiers (#13)", () => {
  const models = parseAgyModels(SAMPLE_AGY_OUTPUT);
  assert.equal(models.length, 10);
  const flashLow = models.find((m) => m.id === "gemini-3.8-flash-low");
  assert.equal(flashLow.tier, "haiku");
  assert.equal(flashLow.description, "Gemini 3.8 Flash (Low)");

  const opusHigh = models.find((m) => m.id === "claude-opus-5-5-high");
  assert.equal(opusHigh.tier, "opus");

  const sonnetMed = models.find((m) => m.id === "claude-sonnet-5-5-medium");
  assert.equal(sonnetMed.tier, "sonnet");
});

test("loadAgyModels reads cache when fresh", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-agy-test-"));
  const cachePath = join(dir, "cache.json");
  const cachedData = {
    at: Date.now(),
    models: [{ id: "custom-flash", tier: "haiku", description: "Custom" }],
  };
  writeFileSync(cachePath, JSON.stringify(cachedData));

  let execCalled = false;
  const models = loadAgyModels({
    cachePath,
    exec: () => {
      execCalled = true;
      return "";
    },
  });

  assert.equal(execCalled, false);
  assert.deepEqual(models, cachedData.models);
});

test("loadAgyModels falls back to static models if exec fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-agy-test-"));
  const cachePath = join(dir, "nonexistent.json");

  const models = loadAgyModels({
    cachePath,
    exec: () => {
      throw new Error("command not found");
    },
  });

  assert.deepEqual(models, STATIC_AGY_MODELS);
});

test("extractPromptFromArgs handles -p, --print, -i, and --prompt-interactive forms", () => {
  assert.equal(extractPromptFromArgs(["-p", "hello world"]), "hello world");
  assert.equal(extractPromptFromArgs(["--print=foo bar"]), "foo bar");
  assert.equal(extractPromptFromArgs(["-i", "interactive task"]), "interactive task");
  assert.equal(extractPromptFromArgs(["--prompt-interactive=interactive task"]), "interactive task");
  assert.equal(extractPromptFromArgs(["--other-flag", "val"]), null);
  assert.equal(extractPromptFromArgs([]), null);
});

test("hasModelArg detects explicit model specifications", () => {
  assert.equal(hasModelArg(["--model", "gemini-3.8-flash-low"]), true);
  assert.equal(hasModelArg(["-m", "opus"]), true);
  assert.equal(hasModelArg(["--model=claude-sonnet-5-5-medium"]), true);
  assert.equal(hasModelArg(["-m=opus"]), true);
  assert.equal(hasModelArg(["-p", "hello"]), false);
});

test("pickBestModelForTier selects appropriate effort level", () => {
  const models = parseAgyModels(SAMPLE_AGY_OUTPUT);
  assert.equal(pickBestModelForTier("opus", models), "claude-opus-5-5-high");
  assert.equal(pickBestModelForTier("haiku", models), "gemini-3.8-flash-low");
  assert.equal(pickBestModelForTier("sonnet", models), "claude-sonnet-5-5-medium");
});

test("routeAgyPrompt respects user overrides", async () => {
  let asked = 0;
  const ask = async () => {
    asked++;
    return { choice: "claude-opus-5-5-high", confidence: 0.9 };
  };

  const res1 = await routeAgyPrompt({ prompt: "use opus for this task", ask });
  assert.equal(res1.tier, "opus");
  assert.equal(res1.modelId, "claude-opus-5-5-high");
  assert.equal(res1.reason, "override");
  assert.equal(asked, 0, "override skips Jev call");

  const res2 = await routeAgyPrompt({ prompt: "haiku kullan", ask });
  assert.equal(res2.tier, "haiku");
  assert.equal(res2.modelId, "gemini-3.8-flash-low");
  assert.match(res2.reason, /^override/);
});

test("routeAgyPrompt skips trivial prompts and keeps fast default", async () => {
  let asked = 0;
  const ask = async () => {
    asked++;
    return { choice: "claude-opus-5-5-high", confidence: 0.9 };
  };

  const res = await routeAgyPrompt({ prompt: "tamam", ask });
  assert.equal(res.tier, "haiku");
  assert.match(res.reason, /^skip-go-ahead/);
  assert.equal(asked, 0);
});

test("routeAgyPrompt uses Jev decision for real prompts", async () => {
  const ask = async () => ({
    choice: "claude-opus-5-5-high",
    confidence: 0.95,
  });

  const res = await routeAgyPrompt({
    prompt: "Architect a fault-tolerant multi-region database replication system",
    ask,
  });

  assert.equal(res.tier, "opus");
  assert.equal(res.modelId, "claude-opus-5-5-high");
  assert.equal(res.reason, "jev");
  assert.equal(res.confidence, 0.95);
});

test("runAgy preserves user model when --model is given", async () => {
  const { runAgy } = await import("../src/agy.mjs");
  let spawnedArgs = null;
  const mockSpawn = (file, args) => {
    spawnedArgs = args;
    return { on: () => {} };
  };

  await runAgy({
    argv: ["--model", "custom-model", "-p", "fix bug"],
    env: { JEV_API_KEY: "key" },
    resolve: () => ({ file: "/fake/agy", shell: false }),
    load: () => {},
    spawnFn: mockSpawn,
  });

  assert.deepEqual(spawnedArgs, ["--model", "custom-model", "-p", "fix bug"]);
});

