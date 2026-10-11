import test from "node:test";
import assert from "node:assert/strict";
import { decide, detectOverride } from "../src/policy.mjs";
import { QUESTIONS, shouldUseExactModel } from "../src/config.mjs";

const ALL = ["haiku", "sonnet", "opus", "fable"];
const sure = (choice) => ({ choice, confidence: 0.95 });
const unsure = (choice) => ({ choice, confidence: 0.2 });
const base = { prompt: "refactor the parser", current: "sonnet", available: ALL, contextTokens: 0 };

test("score rubrics contain only API-valid descriptions", () => {
  for (const question of Object.values(QUESTIONS).filter((q) => q.type === "score")) {
    assert(question.criteria.every((description) => typeof description === "string"));
    assert(question.criteria.length <= 10);
  }
});

test("follows a confident Jev answer", () => {
  assert.deepEqual(decide({ ...base, jev: sure("opus") }), {
    tier: "opus",
    reason: "jev",
    changed: true,
  });
});

test("an explicit user override beats Jev", () => {
  const out = decide({ ...base, prompt: "use haiku to fix this typo", jev: sure("opus") });
  assert.equal(out.tier, "haiku");
  assert.equal(out.reason, "override");
});

test("detectOverride only fires on a real instruction", () => {
  assert.equal(detectOverride("switch to opus"), "opus");
  assert.equal(detectOverride("use luna"), "haiku");
  assert.equal(detectOverride("use strong"), "opus");
  assert.equal(detectOverride("the opus of his career"), null);
});

test("detectOverride ignores tier words inside longer phrases (#3)", () => {
  assert.equal(detectOverride("use strong typing in the parser"), null);
  assert.equal(detectOverride("use fast-glob instead of glob"), null);
  assert.equal(detectOverride("with long names the table overflows"), null);
  assert.equal(detectOverride("on long lines the formatter wraps"), null);
  assert.equal(detectOverride("refactor this and use sol-based coordinates"), null);
});

test("detectOverride accepts a clause-leading instruction with a connective tail", () => {
  assert.equal(detectOverride("use haiku to fix this typo"), "haiku");
  assert.equal(detectOverride("please use opus for this"), "opus");
  assert.equal(detectOverride("Fix the auth bug. Use opus."), "opus");
  assert.equal(detectOverride("look at the logs, then switch to sonnet"), "sonnet");
  assert.equal(detectOverride("go with the strong model"), "opus");
});

test("detectOverride ignores negations and conditionals", () => {
  assert.equal(detectOverride("don't use haiku"), null);
  assert.equal(detectOverride("do not use opus for this"), null);
  assert.equal(detectOverride("never use luna here"), null);
  assert.equal(detectOverride("if it runs long, switch to opus"), null);
  assert.equal(detectOverride("when tests fail, use opus"), null);
});

test("detectOverride ignores quoted, fenced and pasted text", () => {
  assert.equal(detectOverride('the docs say "use opus" for hard tasks'), null);
  assert.equal(detectOverride("run `use haiku` from the CLI"), null);
  assert.equal(detectOverride("fix this:\n```\nuse opus\n```"), null);
  assert.equal(detectOverride("> use opus\nwhat does that line mean?"), null);
});

test("detectOverride understands Turkish instructions", () => {
  assert.equal(detectOverride("opus kullan"), "opus");
  assert.equal(detectOverride("lütfen haiku ile düzelt"), "haiku");
  assert.equal(detectOverride("bunu sonnet ile yap"), "sonnet");
  assert.equal(detectOverride("opus'a geç"), "opus");
  assert.equal(detectOverride("sonnet modeline geç"), "sonnet");
  assert.equal(detectOverride("opus kullanma"), null);
  assert.equal(detectOverride("sol ile sağı karşılaştır"), null);
  assert.equal(detectOverride("opus'a bak, ne diyor"), null);
});

test("the last explicit instruction wins", () => {
  assert.equal(detectOverride("use opus. actually, use haiku"), "haiku");
});

test("an explicit name never re-enables a tier the config excluded", () => {
  const out = decide({ ...base, prompt: "use fable", available: ["haiku", "sonnet", "opus"], jev: null });
  assert.notEqual(out.tier, "fable");
});

test("keeps the current model when Jev is unreachable", () => {
  const out = decide({ ...base, jev: null });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.changed, false);
  assert.match(out.reason, /jev-unavailable/);
});

test("ignores a tier name Jev invented", () => {
  assert.equal(decide({ ...base, jev: sure("gpt-9") }).tier, "sonnet");
});

test("never downgrades on a low-confidence answer", () => {
  const out = decide({ ...base, jev: unsure("haiku") });
  assert.equal(out.tier, "sonnet");
  assert.match(out.reason, /low-confidence-no-downgrade/);
});

test("caps a low-confidence upgrade at the safe ceiling", () => {
  const out = decide({ ...base, current: "haiku", jev: unsure("fable") });
  assert.equal(out.tier, "sonnet");
  assert.equal(out.reason, "low-confidence-capped");
});

test("still allows a confident upgrade to fable", () => {
  assert.equal(decide({ ...base, jev: sure("fable") }).tier, "fable");
});

test("refuses a downgrade once the cache rebuild costs more than it saves", () => {
  const out = decide({ ...base, current: "opus", jev: sure("haiku"), contextTokens: 80000 });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /cache-rebuild/);
});

test("allows the same downgrade early in a conversation", () => {
  assert.equal(decide({ ...base, current: "opus", jev: sure("haiku") }).tier, "haiku");
});

test("substitutes upward when the chosen tier is unavailable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "opus"], jev: sure("sonnet") });
  assert.equal(out.tier, "opus");
  assert.match(out.reason, /unavailable/);
});

test("never substitutes upward into paid fable", () => {
  const out = decide({ ...base, current: "haiku", available: ["haiku", "fable"], jev: sure("opus") });
  assert.equal(out.tier, "haiku");
});

test("accepts exact model changes within the same tier", () => {
  assert.equal(shouldUseExactModel("jev/no-change", "opus", "opus"), true);
  assert.equal(shouldUseExactModel("low-confidence-no-downgrade/no-change", "opus", "opus"), false);
});
