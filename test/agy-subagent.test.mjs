import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  routeSubagent,
  handleAgyPreToolUse,
  withAgyHook,
  withoutAgyHook,
  AGY_SUBAGENT_HOOK_KEY,
} from "../src/agy-subagent.mjs";

const HOOK_BIN = fileURLToPath(new URL("../bin/jev-agy-subagent-hook.mjs", import.meta.url));

test("routeSubagent preserves explicit non-inherit model (#14)", async () => {
  let asked = 0;
  const ask = async () => {
    asked++;
    return { choice: "flash_lite", confidence: 0.9 };
  };

  const res1 = await routeSubagent({ Role: "Dev", Prompt: "do work", Model: "pro" }, { ask });
  assert.equal(res1.model, "pro");
  assert.equal(res1.changed, false);
  assert.equal(res1.reason, "explicit-model");
  assert.equal(asked, 0);

  const res2 = await routeSubagent({ Role: "Dev", Prompt: "do work", Model: "flash" }, { ask });
  assert.equal(res2.model, "flash");
  assert.equal(res2.changed, false);
});

test("routeSubagent respects overrides in brief", async () => {
  let asked = 0;
  const ask = async () => {
    asked++;
    return { choice: "flash", confidence: 0.9 };
  };

  const res = await routeSubagent(
    { Role: "Dev", Prompt: "use opus to redesign data pipeline", Model: "inherit" },
    { ask },
  );
  assert.equal(res.model, "pro");
  assert.equal(res.changed, true);
  assert.equal(res.reason, "override");
  assert.equal(asked, 0);
});

test("routeSubagent skips trivial go-ahead prompts to flash_lite", async () => {
  let asked = 0;
  const ask = async () => {
    asked++;
    return { choice: "pro", confidence: 0.9 };
  };

  const res = await routeSubagent(
    { Role: "Dev", Prompt: "devam", Model: "inherit" },
    { ask },
  );
  assert.equal(res.model, "flash_lite");
  assert.equal(res.changed, true);
  assert.match(res.reason, /^skip-(short|go-ahead)/);
  assert.equal(asked, 0);
});

test("routeSubagent routes complex prompt with Jev", async () => {
  const ask = async () => ({ choice: "pro", confidence: 0.92 });
  const res = await routeSubagent(
    { Role: "Architect", Prompt: "Architect distributed consensus mechanism", Model: "inherit" },
    { ask },
  );
  assert.equal(res.model, "pro");
  assert.equal(res.changed, true);
  assert.equal(res.reason, "jev");
});

test("routeSubagent fails open to flash on error", async () => {
  const ask = async () => {
    throw new Error("Jev timeout");
  };
  const res = await routeSubagent(
    { Role: "Dev", Prompt: "implement caching", Model: "inherit" },
    { ask },
  );
  assert.equal(res.model, "flash");
  assert.equal(res.changed, true);
  assert.equal(res.reason, "jev-failed");
});

test("handleAgyPreToolUse ignores other tools", async () => {
  const res = await handleAgyPreToolUse({
    toolCall: { name: "run_command", args: { CommandLine: "ls" } },
  });
  assert.deepEqual(res, { decision: "allow" });
});

test("handleAgyPreToolUse rewrites Subagents when Model changes", async () => {
  const ask = async () => ({ choice: "flash_lite", confidence: 0.9 });
  const input = {
    toolCall: {
      name: "invoke_subagent",
      args: {
        toolAction: "Researching",
        Subagents: [
          { TypeName: "research", Role: "Reader", Prompt: "Read README.txt", Model: "inherit" },
          { TypeName: "worker", Role: "Fixer", Prompt: "fix bug", Model: "pro" }, // explicit
        ],
      },
    },
  };

  const res = await handleAgyPreToolUse(input, { ask });
  assert.equal(res.decision, "allow");
  assert.ok(res.overwrite);
  assert.equal(res.overwrite.toolAction, "Researching");
  assert.equal(res.overwrite.Subagents[0].Model, "flash_lite");
  assert.equal(res.overwrite.Subagents[1].Model, "pro");
});

test("withAgyHook and withoutAgyHook preserve existing hooks", () => {
  const existingConfig = {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ command: "studio-hook" }] }],
    },
  };

  const { config: installed, changed: installedChanged } = withAgyHook(
    existingConfig,
    '"node" "/path/to/hook.mjs"',
  );
  assert.equal(installedChanged, true);
  assert.ok(installed[AGY_SUBAGENT_HOOK_KEY]);
  assert.deepEqual(installed.hooks, existingConfig.hooks, "studio-hook is preserved");

  const { config: uninstalled, changed: uninstalledChanged } = withoutAgyHook(installed);
  assert.equal(uninstalledChanged, true);
  assert.equal(uninstalled[AGY_SUBAGENT_HOOK_KEY], undefined);
  assert.deepEqual(uninstalled, existingConfig);
});

test("CLI install and hook execution via stdin", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-agy-hook-test-"));
  const hooksFile = join(dir, "hooks.json");
  writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [] } }));

  const env = { ...process.env, AGY_HOOKS_FILE: hooksFile, JEV_API_KEY: "" };

  // Run install
  execFileSync(process.execPath, [HOOK_BIN, "install"], { env });
  const saved = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.ok(saved[AGY_SUBAGENT_HOOK_KEY]);

  // Hook execution on stdin (fail-open returns decision: allow)
  const payload = JSON.stringify({
    toolCall: {
      name: "invoke_subagent",
      args: { Subagents: [{ Prompt: "tamam", Model: "inherit" }] },
    },
  });
  const stdout = execFileSync(process.execPath, [HOOK_BIN], { input: payload, env });
  const parsedOut = JSON.parse(stdout.toString("utf8"));
  assert.equal(parsedOut.decision, "allow");
  assert.equal(parsedOut.overwrite?.Subagents?.[0]?.Model, "flash_lite");

  // Run uninstall
  execFileSync(process.execPath, [HOOK_BIN, "uninstall"], { env });
  const uninstalled = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal(uninstalled[AGY_SUBAGENT_HOOK_KEY], undefined);
});
