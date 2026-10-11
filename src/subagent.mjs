import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TIERS, THRESHOLDS } from "./config.mjs";
import { scrubPrompt } from "./scrub.mjs";

/**
 * Sub-agent routing for Claude Code (#9). A sub-agent starts with an empty context, so
 * choosing its model costs no prompt-cache rebuild; that makes it the cheapest place to save
 * subscription usage without touching the main session.
 */

/** Tiers the Agent tool's `model` alias accepts. Fable bills extra credits and is left out. */
export const SUBAGENT_TIERS = TIERS.filter((t) => t.name !== "fable");

/** Built-in agents that inherit the session model; every other built-in pins its own. */
const BUILTIN_INHERIT = new Set(["general-purpose", "Plan"]);
const BUILTIN_PINNED = new Set(["Explore", "statusline-setup", "claude-code-guide", "output-style-setup"]);

/** Marker used to recognise our own entry in settings.json. */
export const HOOK_MARKER = "jev-subagent-hook";

/** The `model:` value from an agent file's YAML front matter, "" when absent, null if no front matter. */
export function frontmatterModel(text) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text ?? "");
  if (!head) return null;
  const model = /^model:\s*["']?([^"'\s#]+)/m.exec(head[1]);
  return model ? model[1] : "";
}

const frontmatterName = (text) => /^name:\s*["']?([^"'\r\n#]+?)["']?\s*$/m.exec(text ?? "")?.[1] ?? null;

function* agentFiles(dir, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth < 6 && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      yield* agentFiles(path, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".md") && dir.endsWith("agents")) {
      yield path;
    }
  }
}

/**
 * Whether a sub-agent type runs on its own pinned model. Returns `{known, pinned}`: an agent
 * we cannot find is reported as unknown and left alone, because overriding a model an
 * agent's author chose on purpose is worse than missing a saving.
 */
export function agentPin(subagentType, { cwd = process.cwd(), home = homedir() } = {}) {
  const type = subagentType || "general-purpose";
  if (BUILTIN_INHERIT.has(type)) return { known: true, pinned: false };
  if (BUILTIN_PINNED.has(type)) return { known: true, pinned: true };
  const name = type.split(":").at(-1);
  const roots = [join(cwd, ".claude", "agents"), join(home, ".claude", "agents"), join(home, ".claude", "plugins")];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const file of agentFiles(root)) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const fileName = file.split(/[\\/]/).at(-1).replace(/\.md$/, "");
      if (frontmatterName(text) !== name && fileName !== name) continue;
      const model = frontmatterModel(text);
      return { known: true, pinned: Boolean(model) && model !== "inherit" };
    }
  }
  return { known: false, pinned: false };
}

/**
 * Decides a model for one Agent tool call, or null to leave the call untouched. Every
 * failure path returns null: the sub-agent then runs exactly as Claude Code intended.
 *
 * @param {object} input            PreToolUse hook payload
 * @param {object} deps
 * @param {Function} deps.ask       Jev call with askJev's signature
 * @param {Function} [deps.pin]     agent pin lookup (see `agentPin`)
 * @param {object} [deps.env]
 * @returns {Promise<?{tier: string, confidence: number}>}
 */
export async function subagentDecision(input, { ask, pin = agentPin, env = process.env }) {
  if (env.JEV_ROUTER_PROXY === "1") return null; // the jev-claude proxy already routes inheriting sub-agents
  if (!["Agent", "Task"].includes(input?.tool_name)) return null;
  const tool = input.tool_input;
  if (!tool || typeof tool !== "object" || tool.model) return null; // the caller chose a model
  const brief = [tool.description, tool.prompt].filter(Boolean).join("\n\n");
  if (!brief.trim()) return null;
  const { known, pinned } = pin(tool.subagent_type, { cwd: input.cwd || process.cwd() });
  if (!known || pinned) return null;

  const models = SUBAGENT_TIERS.map(({ id, name }) => ({ id, tier: name }));
  let jev;
  try {
    jev = await ask({ prompt: scrubPrompt(brief), current: "opus", contextTokens: 0, models });
  } catch {
    return null;
  }
  const tier = models.find((m) => m.id === jev?.choice)?.tier;
  if (!tier || !(jev.confidence >= THRESHOLDS.minConfidence)) return null;
  return { tier, confidence: jev.confidence };
}

/** The hook's stdout for a decision: the full tool input with `model` set. */
export function hookOutput(input, decision) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      // updatedInput only takes effect alongside a decision; deny and ask rules still apply.
      permissionDecision: "allow",
      permissionDecisionReason: `jev-router: ${decision.tier} (p=${decision.confidence.toFixed(2)})`,
      updatedInput: { ...input.tool_input, model: decision.tier },
    },
  };
}

const isOurs = (group) => group?.hooks?.some((h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER));

/** settings.json with our PreToolUse entry added once; every other hook is left as it was. */
export function withHook(settings, command) {
  const next = structuredClone(settings ?? {});
  next.hooks ??= {};
  next.hooks.PreToolUse ??= [];
  if (next.hooks.PreToolUse.some(isOurs)) return { settings: next, changed: false };
  next.hooks.PreToolUse.push({ matcher: "Agent|Task", hooks: [{ type: "command", command, timeout: 10 }] });
  return { settings: next, changed: true };
}

/** settings.json with our entry removed, and nothing else. */
export function withoutHook(settings) {
  const next = structuredClone(settings ?? {});
  const groups = next.hooks?.PreToolUse;
  if (!Array.isArray(groups) || !groups.some(isOurs)) return { settings: next, changed: false };
  next.hooks.PreToolUse = groups.filter((g) => !isOurs(g));
  if (!next.hooks.PreToolUse.length) delete next.hooks.PreToolUse;
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return { settings: next, changed: true };
}
