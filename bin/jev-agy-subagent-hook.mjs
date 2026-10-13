#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { askJev } from "../src/router.mjs";
import {
  handleAgyPreToolUse,
  withAgyHook,
  withoutAgyHook,
  defaultAgyHooksPath,
} from "../src/agy-subagent.mjs";

const HOOKS_FILE = process.env.AGY_HOOKS_FILE ?? defaultAgyHooksPath();
const SELF = fileURLToPath(import.meta.url);

function readHooksConfig() {
  if (!existsSync(HOOKS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(HOOKS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveHooksConfig(config) {
  mkdirSync(dirname(HOOKS_FILE), { recursive: true });
  if (existsSync(HOOKS_FILE)) {
    const backup = `${HOOKS_FILE}.jev-bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(HOOKS_FILE, backup);
    process.stdout.write(`backup: ${backup}\n`);
  }
  writeFileSync(HOOKS_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

const command = process.argv[2];
if (command === "install" || command === "uninstall") {
  const hookCommand = `"${process.execPath}" "${SELF}"`;
  const { config, changed } =
    command === "install"
      ? withAgyHook(readHooksConfig(), hookCommand)
      : withoutAgyHook(readHooksConfig());

  if (changed) saveHooksConfig(config);
  process.stdout.write(
    changed ? `${command}ed in ${HOOKS_FILE}\n` : `nothing to do in ${HOOKS_FILE}\n`,
  );
  process.exit(0);
}

// Load env files
for (const file of [
  join(process.cwd(), ".env"),
  join(homedir(), ".jev-router.env"),
  join(homedir(), ".jev-claude.env"),
]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Ignored
  }
}

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    process.stdout.write(JSON.stringify({ decision: "allow" }));
    process.exit(0);
  }
  const input = JSON.parse(raw);
  const result = await handleAgyPreToolUse(input, { ask: askJev });
  process.stdout.write(JSON.stringify(result));
} catch {
  // Fail-open: always allow execution
  process.stdout.write(JSON.stringify({ decision: "allow" }));
}

process.exit(0);
