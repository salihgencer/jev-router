import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readLatestUserPrompt,
  handleAgyPreInvocation,
  withAgyAdvisoryHook,
  withoutAgyAdvisoryHook,
  AGY_ADVISORY_HOOK_KEY,
} from "../src/agy-advisory.mjs";

test("readLatestUserPrompt extracts latest USER_INPUT content (#15)", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-adv-test-"));
  const transcriptPath = join(dir, "transcript.jsonl");

  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: "USER_INPUT", content: "first question" }),
      JSON.stringify({ type: "MODEL", content: "answer" }),
      JSON.stringify({ type: "USER_INPUT", content: "latest question to solve" }),
    ].join("\n"),
  );

  assert.equal(readLatestUserPrompt(transcriptPath), "latest question to solve");
  assert.equal(readLatestUserPrompt("/nonexistent/path"), null);
});

test("handleAgyPreInvocation advises when running strong model for simple task", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-adv-test-"));
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    JSON.stringify({ type: "USER_INPUT", content: "rename this variable foo to bar" }),
  );

  const ask = async () => ({
    choice: "gemini-3.8-flash-low", // haiku
    confidence: 0.95,
  });

  const res = await handleAgyPreInvocation(
    {
      modelName: "claude-opus-5-5-high", // opus
      transcriptPath,
    },
    { ask },
  );

  assert.equal(res.injectSteps.length, 1);
  assert.match(res.injectSteps[0].ephemeralMessage, /gemini-3\.8-flash/);
  assert.match(res.injectSteps[0].ephemeralMessage, /Bilgi:/);
});

test("handleAgyPreInvocation remains silent when model matches complexity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-adv-test-"));
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(
    transcriptPath,
    JSON.stringify({ type: "USER_INPUT", content: "Architect a fault-tolerant system" }),
  );

  const ask = async () => ({
    choice: "claude-opus-5-5-high",
    confidence: 0.95,
  });

  const res = await handleAgyPreInvocation(
    {
      modelName: "claude-opus-5-5-high",
      transcriptPath,
    },
    { ask },
  );

  assert.equal(res.injectSteps.length, 0);
});

test("handleAgyPreInvocation remains silent for trivial go-aheads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-adv-test-"));
  const transcriptPath = join(dir, "transcript.jsonl");
  writeFileSync(transcriptPath, JSON.stringify({ type: "USER_INPUT", content: "devam" }));

  let asked = 0;
  const ask = async () => {
    asked++;
    return { choice: "gemini-3.8-flash-low", confidence: 0.9 };
  };

  const res = await handleAgyPreInvocation(
    {
      modelName: "claude-opus-5-5-high",
      transcriptPath,
    },
    { ask },
  );

  assert.equal(res.injectSteps.length, 0);
  assert.equal(asked, 0);
});

test("withAgyAdvisoryHook and withoutAgyAdvisoryHook manage config cleanly", () => {
  const base = { existing: true };
  const { config: installed, changed: c1 } = withAgyAdvisoryHook(base, "node adv.js");
  assert.equal(c1, true);
  assert.ok(installed[AGY_ADVISORY_HOOK_KEY]);

  const { config: uninstalled, changed: c2 } = withoutAgyAdvisoryHook(installed);
  assert.equal(c2, true);
  assert.equal(uninstalled[AGY_ADVISORY_HOOK_KEY], undefined);
  assert.equal(uninstalled.existing, true);
});
