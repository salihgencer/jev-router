import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_FILE = join(homedir(), ".jev-claude.log");

// Debug lines and dumps can contain prompt text, so only the owner may read them.
const PRIVATE = 0o600;

// Claude Code owns the terminal in interactive mode and redraws over anything we print, so
// writing to stderr there corrupts its UI. Log to a file instead and leave stderr alone.
// In print mode (`-p`) there is no TUI to damage, so stderr stays convenient for piping.
const interactive = process.stdout.isTTY;
let tightened = false;

export function log(line) {
  const text = `[jev] ${line}\n`;
  if (!interactive) return void process.stderr.write(text);
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}`, { mode: PRIVATE });
    // `mode` only applies on creation; tighten a log written by an earlier version once.
    if (!tightened) {
      tightened = true;
      chmodSync(LOG_FILE, PRIVATE);
    }
  } catch {
    // A broken log file must never take down the session.
  }
}

export const debug = (line) => process.env.JEV_DEBUG && log(line);

/**
 * Writes a request body to `${JEV_DUMP}.<timestamp>.json` for diagnosing wire-format changes.
 * Bodies hold the whole conversation, so the files are owner-only. No-op unless JEV_DUMP is set.
 */
export function dumpBody(body, prefix = process.env.JEV_DUMP) {
  if (!prefix) return null;
  const file = `${prefix}.${Date.now()}.json`;
  try {
    writeFileSync(file, JSON.stringify(body, null, 2), { mode: PRIVATE });
    chmodSync(file, PRIVATE);
    return file;
  } catch {
    return null;
  }
}
