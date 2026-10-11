#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { askJev } from "../src/router.mjs";
import { subagentDecision, hookOutput, withHook, withoutHook } from "../src/subagent.mjs";

/**
 * Claude Code PreToolUse hook that picks a model for each sub-agent with Jev (#9).
 *
 *   jev-subagent-hook install     add the hook to ~/.claude/settings.json (backed up first)
 *   jev-subagent-hook uninstall   remove it again
 *   jev-subagent-hook             run as the hook itself (reads the payload on stdin)
 *
 * It never blocks a tool call: anything unexpected prints nothing and exits 0.
 */

const SETTINGS = process.env.CLAUDE_SETTINGS_FILE ?? join(homedir(), ".claude", "settings.json");
const SELF = fileURLToPath(import.meta.url);

function readSettings() {
  if (!existsSync(SETTINGS)) return {};
  return JSON.parse(readFileSync(SETTINGS, "utf8")); // a broken file stops the install untouched
}

function save(settings) {
  mkdirSync(dirname(SETTINGS), { recursive: true });
  if (existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.jev-bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(SETTINGS, backup);
    process.stdout.write(`backup: ${backup}\n`);
  }
  writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
}

const command = process.argv[2];
if (command === "install" || command === "uninstall") {
  const hook = `"${process.execPath}" "${SELF}"`;
  const { settings, changed } = command === "install" ? withHook(readSettings(), hook) : withoutHook(readSettings());
  if (changed) save(settings);
  process.stdout.write(changed ? `${command}ed in ${SETTINGS}\n` : `nothing to do in ${SETTINGS}\n`);
  process.exit(0);
}

for (const file of [join(homedir(), ".jev-router.env"), join(homedir(), ".jev-claude.env")]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing or unreadable; the key may still come from the real environment.
  }
}

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const decision = await subagentDecision(input, { ask: askJev });
  if (decision) process.stdout.write(JSON.stringify(hookOutput(input, decision)));
} catch {
  // Fail open: no output leaves the Agent call exactly as Claude Code built it.
}
process.exit(0);
