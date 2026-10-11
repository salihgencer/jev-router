import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { frontmatterModel, agentPin, subagentDecision, hookOutput, withHook, withoutHook } from "../src/subagent.mjs";

const HOOK = fileURLToPath(new URL("../bin/jev-subagent-hook.mjs", import.meta.url));
const unpinned = () => ({ known: true, pinned: false });
const payload = (tool_input) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input, cwd: tmpdir() });
const brief = { description: "Find endpoints", prompt: "List every HTTP route in src/", subagent_type: "general-purpose" };
const answer = (choice, confidence = 0.9) => async () => ({ choice, confidence });

test("reads the model from agent front matter (#9)", () => {
  assert.equal(frontmatterModel("---\nname: x\nmodel: haiku\n---\nbody"), "haiku");
  assert.equal(frontmatterModel("---\r\nname: x\r\nmodel: \"opus\" # pinned\r\n---\r\n"), "opus");
  assert.equal(frontmatterModel("---\nname: x\n---\n"), "");
  assert.equal(frontmatterModel("no front matter"), null);
});

test("finds pins in project, user and plugin agent files", () => {
  const home = mkdtempSync(join(tmpdir(), "jev-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "jev-cwd-"));
  mkdirSync(join(cwd, ".claude", "agents"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\nmodel: opus\n---\n");
  writeFileSync(join(cwd, ".claude", "agents", "helper.md"), "---\nname: helper\nmodel: inherit\n---\n");
  const plugin = join(home, ".claude", "plugins", "cache", "acme", "agents");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "scout.md"), "---\nname: scout\ndescription: d\n---\n");

  assert.deepEqual(agentPin("reviewer", { cwd, home }), { known: true, pinned: true });
  assert.deepEqual(agentPin("helper", { cwd, home }), { known: true, pinned: false });
  assert.deepEqual(agentPin("acme:scout", { cwd, home }), { known: true, pinned: false });
  assert.deepEqual(agentPin("ghost", { cwd, home }), { known: false, pinned: false });
  assert.deepEqual(agentPin("Explore", { cwd, home }), { known: true, pinned: true });
  assert.deepEqual(agentPin(undefined, { cwd, home }), { known: true, pinned: false });
});

test("routes an unpinned sub-agent to Jev's tier", async () => {
  const out = await subagentDecision(payload(brief), { ask: answer("claude-haiku-4-5-20251001"), pin: unpinned, env: {} });
  assert.deepEqual(out, { tier: "haiku", confidence: 0.9 });
  const hook = hookOutput(payload(brief), out);
  assert.equal(hook.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.deepEqual(hook.hookSpecificOutput.updatedInput, { ...brief, model: "haiku" }, "keeps every original field");
});

test("leaves the call alone when a model is already chosen or pinned", async () => {
  let asked = 0;
  const ask = async () => (asked++, { choice: "claude-haiku-4-5-20251001", confidence: 0.9 });
  assert.equal(await subagentDecision(payload({ ...brief, model: "opus" }), { ask, pin: unpinned, env: {} }), null);
  assert.equal(await subagentDecision(payload(brief), { ask, pin: () => ({ known: true, pinned: true }), env: {} }), null);
  assert.equal(await subagentDecision(payload(brief), { ask, pin: () => ({ known: false, pinned: false }), env: {} }), null);
  assert.equal(asked, 0, "Jev is not asked");
});

test("fails open on Jev errors, unknown answers and low confidence", async () => {
  const env = {};
  const pin = unpinned;
  assert.equal(await subagentDecision(payload(brief), { ask: async () => null, pin, env }), null);
  assert.equal(await subagentDecision(payload(brief), { ask: async () => { throw new Error("boom"); }, pin, env }), null);
  assert.equal(await subagentDecision(payload(brief), { ask: answer("gpt-9"), pin, env }), null);
  assert.equal(await subagentDecision(payload(brief), { ask: answer("claude-opus-5", 0.1), pin, env }), null);
});

test("stands down inside jev-claude, where the proxy routes sub-agents", async () => {
  const out = await subagentDecision(payload(brief), { ask: answer("claude-opus-5"), pin: unpinned, env: { JEV_ROUTER_PROXY: "1" } });
  assert.equal(out, null);
});

test("ignores other tools", async () => {
  const out = await subagentDecision({ ...payload(brief), tool_name: "Bash" }, { ask: answer("claude-opus-5"), pin: unpinned, env: {} });
  assert.equal(out, null);
});

test("install is idempotent, keeps other hooks, uninstall removes only ours", () => {
  const theirs = { matcher: "Bash", hooks: [{ type: "command", command: "studio-hook" }] };
  const start = { model: "opus", hooks: { PreToolUse: [theirs], Stop: [{ hooks: [] }] } };
  const once = withHook(start, '"node" "/x/jev-subagent-hook.mjs"');
  assert.equal(once.changed, true);
  assert.equal(once.settings.hooks.PreToolUse.length, 2);
  assert.equal(once.settings.model, "opus");
  assert.equal(withHook(once.settings, "anything jev-subagent-hook").changed, false);
  const removed = withoutHook(once.settings);
  assert.deepEqual(removed.settings, start);
  assert.equal(withoutHook(start).changed, false);
  assert.deepEqual(start.hooks.PreToolUse, [theirs], "input is not mutated");
});

test("the CLI installs with a backup and the hook fails open on garbage input", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-settings-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ theme: "dark" }));
  const env = { ...process.env, CLAUDE_SETTINGS_FILE: file };
  execFileSync(process.execPath, [HOOK, "install"], { env });
  execFileSync(process.execPath, [HOOK, "install"], { env });
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.theme, "dark");
  assert.equal(saved.hooks.PreToolUse.length, 1);
  assert.equal(readdirSync(dir).filter((f) => f.includes("jev-bak")).length, 1, "one backup, second run was a no-op");

  const out = execFileSync(process.execPath, [HOOK], { input: "not json", env: { ...env, JEV_API_KEY: "" } });
  assert.equal(out.toString(), "");
});
